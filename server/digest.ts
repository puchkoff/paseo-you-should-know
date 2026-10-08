import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

export interface TurnDigest {
  toolCalls: number;
  // Recent user requests, oldest first.
  asks: string[];
  // The latest turn as plain lines; the head is dropped when it exceeds the budget.
  turn: string;
  // Commands and edits the latest turn repeated, counted here rather than left to the model.
  repeats: string[];
  // Tool calls and replies of the turns before the latest one, oldest first, without output or diffs.
  earlier: string;
}

const ASK_COUNT = 3;
const ASK_CHARS = 800;
const LINE_CHARS = 400;
const TURN_CHARS = 12_000;
const EDIT_CHARS = 300;
const EARLIER_TURNS = 2;
const EARLIER_TURN_CHARS = 1_500;
const REPEAT_MIN = 3;
const FAILURE_TEXT = /\b(fail(ed|ure|ing)?|error|exception|traceback|fatal|denied|not found|panic|exit(ed)? (code |status )?[1-9])\b/i;

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function tail(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `…${flat.slice(-max)}`;
}

function indent(text: string): string {
  return text ? `\n    ${text.replace(/\n/g, "\n    ")}` : "";
}

function shellOutput(item: ToolCallTimelineItem): string {
  const d = item.detail;
  const output = d.type === "shell" ? d.output : undefined;
  return output ?? (typeof item.error === "string" ? item.error : item.error == null ? "" : JSON.stringify(item.error));
}

// Paseo's Claude provider leaves exitCode unset, so the output text is checked too.
function shellFailed(item: ToolCallTimelineItem): boolean {
  const d = item.detail;
  if (d.type !== "shell") return false;
  return item.status === "failed" || (d.exitCode != null && d.exitCode !== 0) || FAILURE_TEXT.test(shellOutput(item));
}

// Each side gets half the budget, so a long removal cannot hide what replaced it.
function editDiff(old: string | undefined, next: string | undefined): string {
  const side = (text: string | undefined, mark: string) => (text?.trim() ? clip(text, EDIT_CHARS / 2).replace(/^/gm, mark) : "");
  return [side(old, "- "), side(next, "+ ")].filter(Boolean).join("\n");
}

// File headers are dropped: a long path would eat the budget.
function describeEdit(d: { unifiedDiff?: string; oldString?: string; newString?: string }): string {
  const unified = d.unifiedDiff?.replace(/^(---|\+\+\+) .*\n?/gm, "").trim();
  return unified ? clip(unified, EDIT_CHARS) : editDiff(d.oldString, d.newString);
}

// Brief drops output and diffs: earlier turns only need the shape of what happened.
function describeTool(item: ToolCallTimelineItem, brief: boolean): string {
  const d = item.detail;
  const failed = item.status === "failed" ? " FAILED" : item.status === "canceled" ? " canceled" : "";
  switch (d.type) {
    case "shell": {
      const exit = d.exitCode != null && d.exitCode !== 0 ? ` (exit ${d.exitCode})` : "";
      // Output only when the command looks failed: that is where claims and reality diverge.
      const out = !brief && (shellFailed(item) || item.status === "canceled") ? indent(tail(shellOutput(item), LINE_CHARS)) : "";
      return `$ ${clip(d.command, LINE_CHARS)}${exit}${failed}${out}`;
    }
    // The change itself, clipped, so the observer can tell a detour from a fix.
    case "edit":
      return `edit ${d.filePath}${failed}${brief ? "" : indent(describeEdit(d))}`;
    case "write":
      return `write ${d.filePath}${failed}${brief ? "" : indent(clip(d.content ?? "", EDIT_CHARS))}`;
    case "read":
      return `read ${d.filePath}${failed}`;
    case "search":
      return `search ${clip(d.query, 200)}${failed}`;
    case "fetch":
      return `fetch ${d.url}${failed}`;
    default:
      return `tool ${item.name}${failed}`;
  }
}

interface TurnLines {
  lines: string[];
  toolCalls: number;
  todos: string[] | null;
}

function turnLines(items: readonly AgentTimelineItem[], brief: boolean): TurnLines {
  const lines: string[] = [];
  let toolCalls = 0;
  let assistant = "";
  let todos: string[] | null = null;
  const flush = () => {
    if (assistant.trim()) lines.push(`Agent: ${brief ? clip(assistant, LINE_CHARS) : assistant.trim()}`);
    assistant = "";
  };
  for (const item of items) {
    // Assistant text can span several consecutive items.
    if (item.type === "assistant_message") {
      assistant += item.text;
      continue;
    }
    flush();
    if (item.type === "tool_call") {
      toolCalls++;
      lines.push(describeTool(item, brief));
    } else if (item.type === "error") {
      lines.push(`ERROR: ${clip(item.message, LINE_CHARS)}`);
    } else if (item.type === "notification" && item.level !== "info") {
      lines.push(`${item.level.toUpperCase()}: ${clip(item.message, LINE_CHARS)}`);
    } else if (item.type === "todo") {
      todos = item.items.filter((t) => !t.completed).map((t) => t.text);
    }
  }
  flush();
  return { lines, toolCalls, todos };
}

function countRepeats(items: readonly AgentTimelineItem[]): string[] {
  const commands = new Map<string, { runs: number; failed: number }>();
  const edits = new Map<string, number>();
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const d = item.detail;
    if (d.type === "shell") {
      const key = d.command.trim().replace(/\s+/g, " ");
      const seen = commands.get(key) ?? { runs: 0, failed: 0 };
      seen.runs++;
      if (shellFailed(item)) seen.failed++;
      commands.set(key, seen);
    } else if (d.type === "edit" || d.type === "write") {
      edits.set(d.filePath, (edits.get(d.filePath) ?? 0) + 1);
    }
  }
  const repeats: string[] = [];
  for (const [command, { runs, failed }] of commands)
    if (runs >= REPEAT_MIN) repeats.push(`\`${clip(command, LINE_CHARS)}\` ran ${runs} times, ${failed} looked failed`);
  for (const [file, count] of edits) if (count >= REPEAT_MIN) repeats.push(`${file} edited ${count} times`);
  return repeats;
}

export function digestTurn(timeline: readonly AgentTimelineItem[]): TurnDigest | null {
  const userAt: number[] = [];
  timeline.forEach((item, i) => {
    if (item.type === "user_message") userAt.push(i);
  });
  if (userAt.length === 0) return null;
  const start = userAt[userAt.length - 1];

  const asks: string[] = [];
  for (let i = start; i >= 0 && asks.length < ASK_COUNT; i--) {
    const item = timeline[i];
    if (item.type !== "user_message" || !item.text.trim()) continue;
    const ask = clip(item.text, ASK_CHARS);
    if (asks[0] !== ask) asks.unshift(ask);
  }

  const latest = timeline.slice(start + 1);
  const { lines, toolCalls, todos } = turnLines(latest, false);
  if (todos && todos.length > 0) lines.push(`Unfinished todos: ${todos.map((t) => clip(t, 120)).join("; ")}`);

  // Turns with nothing in them (back-to-back user messages) are not worth a slot.
  const earlier: string[] = [];
  for (let k = userAt.length - 2; k >= 0 && earlier.length < EARLIER_TURNS; k--) {
    const body = turnLines(timeline.slice(userAt[k] + 1, userAt[k + 1]), true).lines;
    if (body.length === 0) continue;
    const ask = timeline[userAt[k]];
    const head = ask.type === "user_message" ? `### Turn asked: ${clip(ask.text, 200)}` : "### Turn";
    earlier.unshift(`${head}\n${tail(body.join("\n"), EARLIER_TURN_CHARS)}`);
  }

  return { toolCalls, asks, turn: tail(lines.join("\n"), TURN_CHARS), repeats: countRepeats(latest), earlier: earlier.join("\n\n") };
}

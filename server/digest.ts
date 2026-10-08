import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

export interface TurnDigest {
  toolCalls: number;
  // Recent user requests, oldest first.
  asks: string[];
  // The latest turn as plain lines; the head is dropped when it exceeds the budget.
  turn: string;
}

const ASK_COUNT = 3;
const ASK_CHARS = 800;
const LINE_CHARS = 400;
const TURN_CHARS = 12_000;
const FAILURE_TEXT = /\b(fail(ed|ure|ing)?|error|exception|traceback|fatal|denied|not found|panic|exit(ed)? (code |status )?[1-9])\b/i;

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function tail(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `…${flat.slice(-max)}`;
}

function describeTool(item: ToolCallTimelineItem): string {
  const d = item.detail;
  const failed = item.status === "failed" ? " FAILED" : item.status === "canceled" ? " canceled" : "";
  switch (d.type) {
    case "shell": {
      const exit = d.exitCode != null && d.exitCode !== 0 ? ` (exit ${d.exitCode})` : "";
      // Output only when the command looks failed: that is where claims and reality diverge.
      // Paseo's Claude provider leaves exitCode unset, so the output text is checked too.
      const output = d.output ?? (typeof item.error === "string" ? item.error : item.error == null ? "" : JSON.stringify(item.error));
      const show = output && (exit || failed || FAILURE_TEXT.test(output));
      const out = show ? `\n    ${tail(output, LINE_CHARS).replace(/\n/g, "\n    ")}` : "";
      return `$ ${clip(d.command, LINE_CHARS)}${exit}${failed}${out}`;
    }
    case "edit":
    case "write":
      return `${d.type} ${d.filePath}${failed}`;
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

export function digestTurn(timeline: readonly AgentTimelineItem[]): TurnDigest | null {
  let start = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].type === "user_message") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const asks: string[] = [];
  for (let i = start; i >= 0 && asks.length < ASK_COUNT; i--) {
    const item = timeline[i];
    if (item.type !== "user_message" || !item.text.trim()) continue;
    const ask = clip(item.text, ASK_CHARS);
    if (asks[0] !== ask) asks.unshift(ask);
  }

  const lines: string[] = [];
  let toolCalls = 0;
  let assistant = "";
  let todos: string[] | null = null;
  const flush = () => {
    if (assistant.trim()) lines.push(`Agent: ${assistant.trim()}`);
    assistant = "";
  };
  for (const item of timeline.slice(start + 1)) {
    // Assistant text can span several consecutive items.
    if (item.type === "assistant_message") {
      assistant += item.text;
      continue;
    }
    flush();
    if (item.type === "tool_call") {
      toolCalls++;
      lines.push(describeTool(item));
    } else if (item.type === "error") {
      lines.push(`ERROR: ${clip(item.message, LINE_CHARS)}`);
    } else if (item.type === "notification" && item.level !== "info") {
      lines.push(`${item.level.toUpperCase()}: ${clip(item.message, LINE_CHARS)}`);
    } else if (item.type === "todo") {
      todos = item.items.filter((t) => !t.completed).map((t) => t.text);
    }
  }
  flush();
  if (todos && todos.length > 0) lines.push(`Unfinished todos: ${todos.map((t) => clip(t, 120)).join("; ")}`);

  return { toolCalls, asks, turn: tail(lines.join("\n"), TURN_CHARS) };
}

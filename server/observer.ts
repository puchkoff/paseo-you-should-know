import * as os from "node:os";
import { TAGS, type Tag } from "../shared/notes.ts";
import type { TurnDigest } from "./digest.ts";
import { CommandError, type RunCommand, firstLine } from "./exec.ts";

const TIMEOUT_MS = 90_000;

export const SYSTEM_PROMPT = `You watch over the shoulder of a person who supervises an AI agent.
After each agent turn you get the person's recent requests, the end of the agent's latest turn, and the state of the agent's workspace.
Decide whether there is ONE thing the person would want to know and is likely to miss. Most turns have nothing; then set show to false.

Show a note only for one of these:
- heads_up: the reply hides or understates something wrong, unfinished or risky:
  - a claim the output doesn't support or contradicts;
  - work left short of where the person asked it to land (not saved, sent, published or merged);
  - changes made in a different place than intended;
  - an irreversible action;
  - part of the request silently skipped;
  - a guess presented as fact.
- you_should_know: a non-obvious fact about how something works that surfaced in this turn and matters for the person's next decision.

Before flagging state as a problem, rule out its common benign explanation (e.g. local commits on a branch whose upstream is gone usually mean the branch was merged). If the input can't rule it out, don't show.

Never show: a summary of the turn, style nits, generic advice, anything the agent already stated plainly, anything you cannot point to in the input, anything on the already-shown list.

title: under 10 words. body: at most 60 words, plain words; say what is wrong or true and why it matters, naming files and commands exactly.
Write title and body in the language the person writes in.`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    show: { type: "boolean" },
    tag: { type: "string", enum: TAGS },
    title: { type: "string" },
    body: { type: "string" },
  },
  required: ["show"],
});

export interface Finding {
  tag: Tag;
  title: string;
  body: string;
}

// No settings, hooks, MCP, skills or tools, and no saved session: the call must not act or recurse.
export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--no-session-persistence",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt",
    SYSTEM_PROMPT,
    "--model",
    model,
    "--output-format",
    "json",
    "--json-schema",
    SCHEMA,
  ];
}

export function buildInput(digest: TurnDigest, git: string, cwd: string, shown: readonly string[]): string {
  return [
    "## What the person asked (most recent last)",
    digest.asks.map((a) => `- ${a}`).join("\n") || "(nothing)",
    "## The agent's latest turn",
    digest.turn || "(no output)",
    `## Git state of ${cwd}`,
    git,
    "## Notes already shown to the person (do not repeat)",
    shown.map((s) => `- ${s}`).join("\n") || "(none)",
  ].join("\n\n");
}

interface ClaudeJson {
  is_error?: boolean;
  result?: string;
  structured_output?: { show?: unknown; tag?: unknown; title?: unknown; body?: unknown };
}

export function parseFinding(stdout: string): Finding | null {
  const out = JSON.parse(stdout) as ClaudeJson;
  if (out.is_error) throw new Error(out.result || "claude returned an error");
  const s = out.structured_output;
  // A missing verdict is a failure, not "nothing to say".
  if (!s) throw new Error(`claude returned no structured output: ${(out.result ?? "").slice(0, 120)}`);
  if (s.show !== true) return null;
  const title = typeof s.title === "string" ? s.title.trim() : "";
  const body = typeof s.body === "string" ? s.body.trim() : "";
  if (!title || !body) throw new Error("claude chose to show a note but left its title or body empty");
  const tag = TAGS.find((t) => t === s.tag) ?? "you_should_know";
  return { tag, title, body };
}

function failureReason(err: unknown): string {
  if (err instanceof CommandError && err.stdout.trim()) {
    try {
      const parsed = JSON.parse(err.stdout) as ClaudeJson;
      if (parsed.result) return firstLine(new Error(parsed.result));
    } catch {
      // stdout wasn't JSON; fall back to the stderr line.
    }
  }
  return firstLine(err);
}

export async function askObserver(run: RunCommand, claude: string, model: string, input: string, signal: AbortSignal): Promise<Finding | null> {
  try {
    const stdout = await run(claude, claudeArgs(model), {
      timeoutMs: TIMEOUT_MS,
      input,
      cwd: os.tmpdir(),
      // Thinking off: the verdict is short and thinking multiplies latency and cost.
      env: { ...process.env, MAX_THINKING_TOKENS: "0" },
      signal,
    });
    return parseFinding(stdout);
  } catch (err) {
    throw new Error(failureReason(err));
  }
}

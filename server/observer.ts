import * as os from "node:os";
import type { Item } from "../shared/notes.ts";
import type { TurnDigest } from "./digest.ts";
import { CommandError, type RunCommand, firstLine } from "./exec.ts";

const TIMEOUT_MS = 90_000;

export const SYSTEM_PROMPT = `You watch over the shoulder of a busy person who supervises an AI agent and doesn't read everything it writes.
After each agent turn, decide if there is ONE thing they must know now. Almost every turn has nothing: set show to false.

Show only when ignoring it would cost them something concrete: a wrong result shipped, lost or wasted work, a broken or insecure system, or a decision made for them without asking. Typical cases:
- the agent says "done" or "fixed", but the turn shows it isn't (a test failed, a step skipped, work not committed or pushed);
- the agent decided something important on its own and did not say so clearly;
- the agent is going in circles, or missed a much simpler path.

Never show:
- anything the agent's reply already states plainly, even if you'd phrase it louder (for example "not pushed yet" when the reply says so);
- doubts about thoroughness ("only searched one place", "checked weakly") unless you can name what is likely wrong;
- guesses you can't point to in the input, summaries, generic advice, or anything in "Notes already shown".
If you are not sure it matters, it doesn't: set show to false. severity "high" means they would be upset to learn it later; anything less is "low".

Write for someone who did NOT read the agent's turn. Plain everyday words, short sentences, no wit, no compressed phrases.
Every ticket, PR, file or function you name needs a few words on what it is (for example "PR #1568, the role-permissions fix"). If it isn't needed to understand, leave it out.
items: 1 to 4 bullets, one separate fact each. Each bullet must pass the bar above on its own; never pad.
lead: 1 to 5 words naming what the bullet is about (for example "PR #1687 migration" or "Not pushed").
text: one or two sentences, under 40 words: what is true, and the one thing to do if anything, with exact commands or file names.
Write in the language the person writes in.`;

const MAX_ITEMS = 4;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    show: { type: "boolean" },
    severity: { type: "string", enum: ["low", "high"] },
    items: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: { type: "object", properties: { lead: { type: "string" }, text: { type: "string" } }, required: ["lead", "text"] },
    },
  },
  required: ["show"],
});

export interface Finding {
  items: Item[];
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
    "## The agent's earlier turns (oldest first)",
    digest.earlier || "(none)",
    "## The agent's latest turn",
    digest.turn || "(no output)",
    "## Repeated in the latest turn",
    digest.repeats.map((r) => `- ${r}`).join("\n") || "(nothing)",
    `## Git state of ${cwd}`,
    git,
    "## Notes already shown to the person (do not repeat)",
    shown.map((s) => `- ${s}`).join("\n") || "(none)",
  ].join("\n\n");
}

interface ClaudeJson {
  is_error?: boolean;
  result?: string;
  structured_output?: { show?: unknown; severity?: unknown; items?: unknown };
}

export function parseFinding(stdout: string): Finding | null {
  const out = JSON.parse(stdout) as ClaudeJson;
  if (out.is_error) throw new Error(out.result || "claude returned an error");
  const s = out.structured_output;
  // A missing verdict is a failure, not "nothing to say".
  if (!s) throw new Error(`claude returned no structured output: ${(out.result ?? "").slice(0, 120)}`);
  // Low severity is dropped here: a prompt alone lets too many "nice to know" notes through.
  if (s.show !== true || s.severity !== "high") return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const raw: unknown[] = Array.isArray(s.items) ? s.items.slice(0, MAX_ITEMS) : [];
  const items = raw.map((i) => {
    const r = typeof i === "object" && i !== null ? (i as Record<string, unknown>) : {};
    return { lead: text(r.lead), text: text(r.text) };
  });
  if (items.length === 0 || items.some((i) => !i.lead || !i.text)) throw new Error("claude chose to show a note but left a field empty");
  return { items };
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

import * as os from "node:os";
import { TAGS, type Tag } from "../shared/notes.ts";
import type { TurnDigest } from "./digest.ts";
import { CommandError, type RunCommand, firstLine } from "./exec.ts";

const TIMEOUT_MS = 90_000;

export const SYSTEM_PROMPT = `You watch over the shoulder of a busy person who supervises an AI agent and doesn't read everything it writes.
After each agent turn, find at most ONE thing they should really know and likely missed. Most turns have nothing: set show to false.

Worth showing:
- a decision or tradeoff the agent made on its own, or something it mentioned only in passing;
- a result that may be off: an unsupported claim, unfinished work (not committed, pushed, merged), part of the request skipped;
- a non-obvious fact that matters for their next decision;
- the agent going in circles, or a clearly simpler path it missed.
Missing it must cost something real: time, money, wasted work, a wrong result. Interesting is not important.

Never show what they already discussed, a summary, generic advice, anything you can't point to in the input, or anything already shown.

tag: you_should_know (default), heads_up (this work, immediate cost), stuck, simpler.
title: under 8 plain words stating the takeaway.
body: plain text, under 60 words: what it is, why it matters, one thing to do. Name files and commands exactly; explain terms they haven't used.
Write in the language the person writes in.`;

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

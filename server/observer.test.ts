import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunCommand } from "./exec.ts";
import { gitState } from "./git.ts";
import { buildInput, parseFinding } from "./observer.ts";

const out = (structured_output: unknown, extra: object = {}) => JSON.stringify({ is_error: false, result: "", structured_output, ...extra });

const note = (fields: object) => out({ show: true, severity: "high", tag: "heads_up", title: "t", what: "w", risk: "r", action: "a", ...fields });

test("show false means no finding", () => {
  assert.equal(parseFinding(out({ show: false })), null);
});

test("a low or missing severity is dropped", () => {
  assert.equal(parseFinding(note({ severity: "low" })), null);
  assert.equal(parseFinding(note({ severity: undefined })), null);
});

test("a missing verdict or an empty note is an error, not silence", () => {
  assert.throws(() => parseFinding(JSON.stringify({ is_error: false, result: "plain text" })), /no structured output/);
  assert.throws(() => parseFinding(note({ title: " " })), /field empty/);
  assert.throws(() => parseFinding(note({ risk: "" })), /field empty/);
});

test("a finding joins what, risk and action into the body", () => {
  assert.deepEqual(parseFinding(note({ title: " Not pushed ", what: " Committed. ", risk: "Lost on reset.", action: "Run git push." })), {
    tag: "heads_up",
    title: "Not pushed",
    body: "Committed.\n\nLost on reset.\n\n→ Run git push.",
  });
});

test("an unknown tag falls back to you_should_know", () => {
  assert.equal(parseFinding(note({ tag: "fyi" }))?.tag, "you_should_know");
});

test("an error result throws instead of reading as nothing to say", () => {
  assert.throws(() => parseFinding(JSON.stringify({ is_error: true, result: "rate limited" })), /rate limited/);
});

test("git state reports dirty files, missing upstream and unpushed commits", async () => {
  const run: RunCommand = async (_file, args) =>
    args.includes("status") ? "## feature\n M a.ts\n?? b.ts\n" : args.includes("remote") ? "origin\n" : "abc123 Add thing\n";
  const text = await gitState(run, "git", "/repo");
  assert.match(text, /Branch: feature/);
  assert.match(text, /no upstream/);
  assert.match(text, /2 uncommitted file\(s\)/);
  assert.match(text, /unpushed[\s\S]*abc123 Add thing/);
});

test("git state outside a repository", async () => {
  const run: RunCommand = async () => {
    throw new Error("fatal: not a git repository (or any of the parent directories): .git");
  };
  assert.equal(await gitState(run, "git", "/tmp"), "Not a git repository.");
});

test("git never takes the index lock", async () => {
  const calls: string[][] = [];
  const run: RunCommand = async (_file, args) => {
    calls.push([...args]);
    return args.includes("status") ? "## main...origin/main\n" : "origin\n";
  };
  await gitState(run, "git", "/repo");
  assert.ok(calls.every((a) => a[0] === "--no-optional-locks"));
});

test("a git failure is reported as unknown, not as clean", async () => {
  const run: RunCommand = async () => {
    throw new Error("git timed out after 5 s");
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.match(await gitState(run, "git", "/repo"), /^Git state unavailable: git timed out/);
  } finally {
    console.error = original;
  }
});

test("a failed log leaves unpushed commits unknown", async () => {
  const run: RunCommand = async (_file, args) => {
    if (args.includes("status")) return "## main...origin/main\n";
    if (args.includes("remote")) return "origin\n";
    throw new Error("log timed out");
  };
  assert.match(await gitState(run, "git", "/repo"), /Unpushed commits: unknown \(log timed out\)/);
});

test("no remotes is not unpushed work", async () => {
  const run: RunCommand = async (_file, args) => (args.includes("status") ? "## main\n" : args.includes("remote") ? "" : "abc123 x\n");
  const text = await gitState(run, "git", "/repo");
  assert.match(text, /No remotes configured/);
  assert.doesNotMatch(text, /unpushed/i);
});

test("the new tags pass through", () => {
  assert.equal(parseFinding(note({ tag: "stuck" }))?.tag, "stuck");
  assert.equal(parseFinding(note({ tag: "simpler" }))?.tag, "simpler");
});

test("input carries earlier turns and repeats in order", () => {
  const input = buildInput({ toolCalls: 3, asks: ["fix"], turn: "$ npm test", repeats: ["`npm test` ran 3 times, 3 looked failed"], earlier: "### Turn asked: a" }, "clean", "/w", []);
  const at = (s: string) => input.indexOf(s);
  assert.ok(at("### Turn asked: a") > at("## The agent's earlier turns") && at("### Turn asked: a") < at("## The agent's latest turn"));
  assert.ok(at("- `npm test` ran 3 times") > at("## Repeated in the latest turn"));
  assert.match(buildInput({ toolCalls: 3, asks: [], turn: "", repeats: [], earlier: "" }, "", "/w", []), /earlier turns \(oldest first\)\n\n\(none\)[\s\S]*Repeated in the latest turn\n\n\(nothing\)/);
});

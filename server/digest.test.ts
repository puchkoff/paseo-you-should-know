import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { digestTurn } from "./digest.ts";

const shell = (command: string, exitCode: number, output = ""): AgentTimelineItem => ({
  type: "tool_call",
  callId: command,
  name: "Bash",
  status: "completed",
  error: null,
  detail: { type: "shell", command, exitCode, output },
});

test("no user message means nothing to digest", () => {
  assert.equal(digestTurn([{ type: "assistant_message", text: "hi" }]), null);
});

test("digests only the latest turn and keeps recent asks", () => {
  const d = digestTurn([
    { type: "user_message", text: "first ask" },
    shell("ls", 0),
    { type: "assistant_message", text: "old reply" },
    { type: "user_message", text: "run the tests" },
    shell("npm test", 1, "1 failing"),
    { type: "assistant_message", text: "All " },
    { type: "assistant_message", text: "tests pass." },
    { type: "todo", items: [{ text: "push", completed: false }, { text: "test", completed: true }] },
  ]);
  assert.ok(d);
  assert.equal(d.toolCalls, 1);
  assert.deepEqual(d.asks, ["first ask", "run the tests"]);
  assert.match(d.turn, /\$ npm test \(exit 1\)\n {4}1 failing/);
  assert.match(d.turn, /Agent: All tests pass\./);
  assert.match(d.turn, /Unfinished todos: push$/);
  assert.doesNotMatch(d.turn, /old reply/);
});

test("successful shell output is left out", () => {
  const d = digestTurn([{ type: "user_message", text: "x" }, shell("echo secret", 0, "secret")]);
  assert.equal(d?.turn, "$ echo secret");
});

test("long turns keep their end", () => {
  const items: AgentTimelineItem[] = [{ type: "user_message", text: "go" }];
  for (let i = 0; i < 400; i++) items.push(shell(`step ${i} ${"x".repeat(50)}`, 0));
  items.push({ type: "assistant_message", text: "final claim" });
  const d = digestTurn(items);
  assert.ok(d && d.turn.length <= 12_001);
  assert.match(d.turn, /final claim$/);
});

test("failure text shows output even without an exit code", () => {
  const item: AgentTimelineItem = {
    type: "tool_call",
    callId: "c",
    name: "Bash",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "./check.sh", output: "FAIL: 3 of 12 checks failed" },
  };
  assert.equal(digestTurn([{ type: "user_message", text: "x" }, item])?.turn, "$ ./check.sh\n    FAIL: 3 of 12 checks failed");
});

test("a repeated ask is listed once", () => {
  const d = digestTurn([{ type: "user_message", text: "again" }, { type: "user_message", text: "again" }]);
  assert.deepEqual(d?.asks, ["again"]);
});

const edit = (filePath: string, oldString: string, newString: string): AgentTimelineItem => ({
  type: "tool_call",
  callId: `${filePath}${newString}`,
  name: "Edit",
  status: "completed",
  error: null,
  detail: { type: "edit", filePath, oldString, newString },
});

test("edits carry their clipped change", () => {
  const d = digestTurn([{ type: "user_message", text: "x" }, edit("a.ts", "return 1;", "return 2;")]);
  assert.equal(d?.turn, "edit a.ts\n    - return 1;\n    + return 2;");
});

test("repeated commands and edits are counted", () => {
  const d = digestTurn([
    { type: "user_message", text: "fix it" },
    shell("npm  test", 1, "1 failing"),
    shell("npm test", 1, "1 failing"),
    shell("npm test", 0, "ok"),
    shell("ls", 0),
    edit("a.ts", "1", "2"),
    edit("a.ts", "2", "1"),
    edit("a.ts", "1", "2"),
  ]);
  assert.deepEqual(d?.repeats, ["`npm test` ran 3 times, 2 looked failed", "a.ts edited 3 times"]);
});

test("earlier turns are brief, oldest first, and skip empty ones", () => {
  const d = digestTurn([
    { type: "user_message", text: "too old" },
    shell("old", 0),
    { type: "user_message", text: "first" },
    shell("npm test", 1, "boom"),
    edit("a.ts", "x", "y"),
    { type: "assistant_message", text: "fixed" },
    { type: "user_message", text: "second" },
    shell("npm test", 1, "boom"),
    { type: "user_message", text: "empty turn before this" },
    { type: "user_message", text: "now" },
    shell("ls", 0),
  ]);
  assert.equal(
    d?.earlier,
    "### Turn asked: first\n$ npm test (exit 1)\nedit a.ts\nAgent: fixed\n\n### Turn asked: second\n$ npm test (exit 1)",
  );
  assert.equal(d?.turn, "$ ls");
});

test("a long removal keeps the added side, and trailing newlines add no blank lines", () => {
  const d = digestTurn([{ type: "user_message", text: "x" }, edit("a.ts", `${"a".repeat(400)}\n`, "b\n")]);
  assert.match(d?.turn ?? "", /^edit a\.ts\n {4}- a{150}…\n {4}\+ b$/);
});

test("a unified diff wins over old/new strings, without file headers; an empty one falls back", () => {
  const item = (unifiedDiff: string): AgentTimelineItem => ({
    type: "tool_call",
    callId: unifiedDiff,
    name: "Edit",
    status: "completed",
    error: null,
    detail: { type: "edit", filePath: "a.ts", oldString: "q", newString: "r", unifiedDiff },
  });
  assert.equal(digestTurn([{ type: "user_message", text: "x" }, item("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y")])?.turn, "edit a.ts\n    @@ -1 +1 @@\n    -x\n    +y");
  assert.equal(digestTurn([{ type: "user_message", text: "x" }, item("")])?.turn, "edit a.ts\n    - q\n    + r");
});

test("long commands that share a prefix are not counted as one, and writes count as edits", () => {
  const prefix = `cd /${"p".repeat(300)} && `;
  const write: AgentTimelineItem = { type: "tool_call", callId: "w", name: "Write", status: "completed", error: null, detail: { type: "write", filePath: "a.ts", content: "x" } };
  const d = digestTurn([
    { type: "user_message", text: "x" },
    shell(`${prefix}pytest`, 0),
    shell(`${prefix}ruff check`, 0),
    shell(`${prefix}git status`, 0),
    write,
    edit("a.ts", "x", "y"),
    edit("a.ts", "y", "x"),
  ]);
  assert.deepEqual(d?.repeats, ["a.ts edited 3 times"]);
});

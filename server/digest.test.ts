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

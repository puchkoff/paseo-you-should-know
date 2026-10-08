import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunCommand } from "./exec.ts";
import { gitState } from "./git.ts";
import { parseFinding } from "./observer.ts";

const out = (structured_output: unknown, extra: object = {}) => JSON.stringify({ is_error: false, result: "", structured_output, ...extra });

test("show false means no finding", () => {
  assert.equal(parseFinding(out({ show: false })), null);
});

test("a missing verdict or an empty note is an error, not silence", () => {
  assert.throws(() => parseFinding(JSON.stringify({ is_error: false, result: "plain text" })), /no structured output/);
  assert.throws(() => parseFinding(out({ show: true, tag: "heads_up", title: " ", body: "b" })), /title or body empty/);
});

test("a finding keeps trimmed title and body", () => {
  assert.deepEqual(parseFinding(out({ show: true, tag: "heads_up", title: " Not pushed ", body: "b" })), {
    tag: "heads_up",
    title: "Not pushed",
    body: "b",
  });
});

test("an unknown tag falls back to you_should_know", () => {
  assert.equal(parseFinding(out({ show: true, tag: "fyi", title: "t", body: "b" }))?.tag, "you_should_know");
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

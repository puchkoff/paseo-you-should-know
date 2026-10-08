import { type RunCommand, firstLine } from "./exec.ts";

const TIMEOUT_MS = 5_000;
const MAX_FILES = 15;

// The agent may be running git at the same moment; never take its index lock.
const gitArgs = (cwd: string, ...args: string[]) => ["--no-optional-locks", "-C", cwd, ...args];

// Branch, ahead/behind, dirty files and commits that exist on no remote, as plain text.
// A failure is reported as unknown, never as a clean state the observer would trust.
export async function gitState(run: RunCommand, git: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const exec = (...args: string[]) => run(git, gitArgs(cwd, ...args), { timeoutMs: TIMEOUT_MS, signal });

  let status: string;
  try {
    status = await exec("status", "--porcelain=v1", "--branch");
  } catch (err) {
    if (/not a git repository/i.test(firstLine(err))) return "Not a git repository.";
    console.error(`[you-should-know] git status in ${cwd}: ${firstLine(err)}`);
    return `Git state unavailable: ${firstLine(err)}`;
  }
  const [branchLine = "", ...files] = status.split("\n").filter(Boolean);
  const lines = [`Branch: ${branchLine.replace(/^## /, "")}`];
  if (!branchLine.includes("...")) lines.push("The branch has no upstream.");
  if (files.length === 0) lines.push("Working tree clean.");
  else {
    lines.push(`${files.length} uncommitted file(s):`);
    lines.push(...files.slice(0, MAX_FILES).map((f) => `  ${f}`));
    if (files.length > MAX_FILES) lines.push(`  … ${files.length - MAX_FILES} more`);
  }

  try {
    // With no remotes every commit is "on no remote"; that is not unpushed work.
    if (!(await exec("remote")).trim()) {
      lines.push("No remotes configured.");
      return lines.join("\n");
    }
    const local = (await exec("log", "--oneline", "-n", "5", "HEAD", "--not", "--remotes")).trim();
    if (local) lines.push("Commits on no remote (unpushed):", ...local.split("\n").map((l) => `  ${l}`));
    else lines.push("No unpushed commits.");
  } catch (err) {
    // An unborn HEAD has no log either; both cases leave the answer unknown.
    lines.push(`Unpushed commits: unknown (${firstLine(err)})`);
  }
  return lines.join("\n");
}

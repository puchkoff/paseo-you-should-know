import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunOptions {
  timeoutMs: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type RunCommand = (file: string, args: readonly string[], options: RunOptions) => Promise<string>;

// claude -p --output-format json prints the reason for a failure on stdout, not stderr.
export class CommandError extends Error {
  readonly stdout: string;
  constructor(message: string, stdout: string) {
    super(message);
    this.stdout = stdout;
  }
}

// Resolves stdout; rejects with the first stderr line. Aborting the signal kills the child.
export const runCommand: RunCommand = (file, args, { timeoutMs, input, cwd, env, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const stop = (reason: string) => {
      child.kill("SIGKILL");
      reject(new Error(reason));
    };
    const onAbort = () => stop("aborted");
    const timer = setTimeout(() => stop(`${path.basename(file)} timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    // Decode as a stream: a multibyte character split across chunks would otherwise become U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      if (code === 0) resolve(stdout);
      else reject(new CommandError(stderr.trim().split("\n")[0] || `${path.basename(file)} exited with code ${code}`, stdout));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

// The daemon's PATH can be stripped (no ~/.local/bin, no npm-global), so look in the usual places first.
export function resolveBin(name: string, exists: (p: string) => boolean = existsSync, home = os.homedir()): string {
  const dirs = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local/bin"), path.join(home, ".npm-global/bin")];
  return dirs.map((d) => path.join(d, name)).find(exists) ?? name;
}

export function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n")[0] || "unknown error").slice(0, 200);
}

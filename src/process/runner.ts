import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { processEnvironment } from "./environment.ts";
import { stopProcess } from "./tree.ts";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxChars?: number;
  /** Stdin payload is data and never interpreted by a shell. */
  input?: string;
}

/** Direct argv execution; shell metacharacters in user parameters are never interpreted. */
export async function runProcess(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? processEnvironment(),
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const max = options.maxChars ?? 20_000;
  let stdout = "",
    stderr = "",
    truncated = false,
    cancelled = false;
  const decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const value = decoders[stream].write(chunk);
    if (stream === "stdout") {
      stdout += value;
      if (stdout.length > max) {
        stdout = stdout.slice(-max);
        truncated = true;
      }
    } else {
      stderr += value;
      if (stderr.length > max) {
        stderr = stderr.slice(-max);
        truncated = true;
      }
    }
  };
  child.stdout!.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr!.on("data", (chunk: Buffer) => capture("stderr", chunk));
  if (options.input !== undefined) {
    child.stdin!.on("error", () => {}); // A script may exit before reading stdin (EPIPE).
    child.stdin!.end(options.input);
  }
  const abort = () => {
    cancelled = true;
    void stopProcess(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, options.timeoutMs ?? 60_000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (cancelled)
      throw new Error(
        options.signal?.aborted ? "操作已取消" : "操作超时，进程已停止",
      );
    return {
      exitCode,
      stdout: stdout + decoders.stdout.end(),
      stderr: stderr + decoders.stderr.end(),
      truncated,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

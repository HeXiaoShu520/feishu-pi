import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { processEnvironment } from "./environment.ts";

/** Stop the entire owned process tree, including grandchildren holding stdout open. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, env: processEnvironment() }, () => resolve()));
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already stopped */ } }
  }
}

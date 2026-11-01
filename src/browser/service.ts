import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { runProcess } from "../process/runner.ts";
import { processEnvironment } from "../process/environment.ts";

export const BROWSER_ACTIONS = ["open", "goto", "snapshot", "find", "click", "dblclick", "fill", "type", "press", "hover", "select", "check", "uncheck", "upload", "screenshot", "tab-list", "tab-new", "tab-select", "tab-close", "go-back", "go-forward", "reload", "dialog-accept", "dialog-dismiss", "show", "close"] as const;
export type BrowserAction = typeof BROWSER_ACTIONS[number];
export interface BrowserRequest { action: BrowserAction; url?: string; ref?: string; text?: string; path?: string; index?: number }

/** One lazily started personal browser. The CLI owns browser state; this adapter owns configuration and argv. */
export class BrowserService {
  private readonly cwd: string;
  private readonly root: string;
  private readonly browser: string;
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private active = false;
  private dashboard = false;
  private closing = false;
  private readonly shutdown = new AbortController();
  constructor(options: { cwd: string; dataDir: string; browser?: string }) {
    this.cwd = options.cwd;
    this.root = resolve(options.dataDir, "browser");
    this.browser = options.browser ?? "msedge";
  }

  execute(request: BrowserRequest, signal?: AbortSignal) {
    if (this.closing && request.action !== "close") return Promise.reject(new Error("浏览器服务正在退出"));
    const operation = this.queue.catch(() => undefined).then(() => this.perform(request, signal));
    this.queue = operation;
    return operation;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.shutdown.abort();
    await this.queue.catch(() => undefined);
    if (this.active) await this.execute({ action: "close" }).catch(() => undefined);
    if (this.dashboard) {
      await runProcess(process.execPath, [join(this.cwd, "node_modules", "@playwright", "cli", "playwright-cli.js"), "-s=mini-claw-personal", "show", "--kill"], {
        cwd: this.root, timeoutMs: 10_000, env: processEnvironment({ NO_UPDATE_NOTIFIER: "1" }),
      }).catch(() => undefined);
    }
  }

  private async perform(request: BrowserRequest, signal?: AbortSignal) {
    signal = request.action === "close" ? signal : signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    signal?.throwIfAborted();
    if (!BROWSER_ACTIONS.includes(request.action)) throw new Error("不支持的浏览器操作");
    const args = this.argumentsFor(request);
    if (!this.initialized) {
      await mkdir(join(this.root, "artifacts"), { recursive: true });
      await writeFile(join(this.root, "cli.config.json"), JSON.stringify({
        browser: { browserName: "chromium", launchOptions: { channel: this.browser, headless: false } },
        outputMode: "stdout", outputDir: join(this.root, "artifacts"),
      }), "utf8");
      this.initialized = true;
    }
    if (request.action === "open") this.active = true;
    const result = await runProcess(process.execPath, [
      join(this.cwd, "node_modules", "@playwright", "cli", "playwright-cli.js"),
      "-s=mini-claw-personal", "--raw", ...args,
    ], { cwd: this.root, signal, timeoutMs: 90_000, maxChars: 24_000, env: processEnvironment({ NO_UPDATE_NOTIFIER: "1" }) });
    if (result.exitCode !== 0) throw new Error(`浏览器操作失败（${result.exitCode}）: ${result.stderr || result.stdout}`);
    if (request.action === "close") this.active = false;
    if (request.action === "show") this.dashboard = true;
    const imagePath = request.action === "screenshot" ? join(this.root, "artifacts", "latest.png") : undefined;
    const image = imagePath ? await readFile(imagePath) : undefined;
    return { ...result, image, imagePath };
  }

  private argumentsFor(request: BrowserRequest): string[] {
    const required = (value: string | undefined, name: string) => {
      if (!value || value.startsWith("-")) throw new Error(`${name} 不能为空或以 - 开头`);
      return value;
    };
    const url = () => {
      const parsed = new URL(required(request.url, "url"));
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("浏览器只接受无内嵌凭证的 HTTP(S) 地址");
      return parsed.href;
    };
    const target = () => required(request.ref, "ref");
    const text = () => { if (request.text === undefined) throw new Error("缺少 text"); return request.text; };
    switch (request.action) {
      case "open": return ["open", `--config=${join(this.root, "cli.config.json")}`, `--profile=${join(this.root, "profile")}`, "--headed", "--idle-timeout=900000", "--", ...(request.url ? [url()] : [])];
      case "goto": case "tab-new": return [request.action, "--", url()];
      case "snapshot": return ["snapshot", ...(request.ref ? ["--", target()] : ["--depth=6"])];
      case "find": case "type": case "press": return [request.action, "--", text()];
      case "fill": case "select": return [request.action, "--", target(), text()];
      case "click": case "dblclick": case "hover": case "check": case "uncheck": return [request.action, "--", target()];
      case "upload": {
        const path = resolve(this.cwd, required(request.path, "path"));
        // Guard authorizes this file as Read(path) before the adapter runs.
        if (!relative(this.cwd, path)) throw new Error("上传路径必须是文件");
        return ["upload", "--", path];
      }
      case "screenshot": return ["screenshot", `--filename=${join(this.root, "artifacts", "latest.png")}`];
      case "tab-select": case "tab-close": {
        if (!Number.isSafeInteger(request.index) || request.index! < 0) throw new Error("index 必须是非负整数");
        return [request.action, "--", String(request.index)];
      }
      case "dialog-accept": return [request.action, "--", ...(request.text === undefined ? [] : [request.text])];
      default: return [request.action];
    }
  }
}

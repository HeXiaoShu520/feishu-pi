import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { containsSensitiveText } from "../assistant/memory-safety.ts";

type Json = Record<string, unknown>;
export interface BiliAutomationDependencies {
  authorize(tool: string, args: Json, chatId: string, signal: AbortSignal): Promise<void>;
  call(tool: string, args: Json, chatId: string, signal: AbortSignal): Promise<Json>;
  decide(stage: "keywords" | "video" | "reply" | "share", data: unknown, signal: AbortSignal): Promise<unknown>;
  interests(): Promise<string[]>;
  share?(chatId: string, text: string): Promise<void>;
  isChatActive?(chatId: string): boolean;
  now?: () => number;
}
interface State {
  enabled: boolean; chatId: string; lastBrowse: number; lastReplies: number;
  day: string; comments: number; replies: number; pauseDay?: string; pauseReason?: string;
  handled: string[]; attempted: string[]; lastError?: string;
  lastShareDay?: string;
  pendingShare?: { bvid: string; text: string; at: number };
}
const DAY = (now: number) => new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
const VIDEO = /^BV[0-9A-Za-z]{10}$/;
const SILENCE = /^(?:\[沉默\]|\[不评论\]|不评论|不回复|NONE)$/i;

/** Feishu-side adaptation of Aurabot's Bilibili duty; all network/model operations are injectable. */
export class BiliAutomation {
  private readonly file: string;
  private readonly deps: BiliAutomationDependencies;
  private state?: State;
  private loading?: Promise<State>;
  private writes: Promise<void> = Promise.resolve();
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private running?: Promise<void>;
  private shuttingDown = false;
  constructor(file: string, deps: BiliAutomationDependencies) { this.file = file; this.deps = deps; }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    this.loading ??= (async () => {
      let s: State;
      try { s = JSON.parse(await readFile(this.file, "utf8")) as State; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        s = { enabled: false, chatId: "", lastBrowse: 0, lastReplies: 0, day: "", comments: 0, replies: 0, handled: [], attempted: [] };
      }
      if (typeof s.enabled !== "boolean" || typeof s.chatId !== "string" || !Array.isArray(s.handled) || !Array.isArray(s.attempted) || typeof s.day !== "string" || !Number.isFinite(s.comments) || !Number.isFinite(s.replies) || !Number.isFinite(s.lastBrowse) || !Number.isFinite(s.lastReplies)) throw new Error("B 站自动化状态文件损坏");
      this.state = s;
      return s;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private save(s: State): Promise<void> {
    const snapshot = JSON.stringify(s, null, 2);
    const op = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.file);
    });
    this.writes = op;
    return op;
  }
  async configure(enabled: boolean, chatId?: string): Promise<void> {
    const s = await this.load();
    if (enabled && !/^oc_[A-Za-z0-9_-]+$/.test(chatId ?? s.chatId)) throw new Error("请在管理员飞书私聊中启用");
    if (chatId) s.chatId = chatId;
    s.enabled = enabled;
    // A fresh enable after re-login can resume a login-related pause, but never
    // clears a same-day risk-control or rate-limit pause.
    if (enabled && s.pauseReason && /(?:未登录|凭证.*过期|-101|-111|登录或权限检查失败)/i.test(s.pauseReason) && !/(?:-352|-509|12015|风控|验证码|太频繁)/i.test(s.pauseReason)) {
      delete s.pauseDay; delete s.pauseReason;
    }
    if (!enabled) { this.controller?.abort(); delete s.pendingShare; }
    s.lastError = undefined;
    await this.save(s);
  }
  async status(): Promise<Readonly<State>> { return structuredClone(await this.load()); }
  runNow(): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error("自动化服务正在关闭"));
    if (this.running) return Promise.reject(new Error("上一轮仍在执行"));
    const task = this.runManual();
    this.running = task;
    void task.then(() => { if (this.running === task) this.running = undefined; }, () => { if (this.running === task) this.running = undefined; });
    return task;
  }
  private async runManual(): Promise<void> {
    const s = await this.load();
    if (this.shuttingDown) return;
    if (!s.enabled) throw new Error("自动化尚未启用");
    if (this.busy) throw new Error("上一轮仍在执行");
    s.lastBrowse = 0; s.lastReplies = 0; await this.save(s);
    if (this.shuttingDown) return;
    await this.tick();
  }
  async start(): Promise<void> {
    await this.load();
    if (this.timer) return;
    this.shuttingDown = false;
    const dispatch = () => { if (!this.running) { const task = this.tick().catch(() => {}); this.running = task; void task.finally(() => { if (this.running === task) this.running = undefined; }); } };
    this.timer = setInterval(dispatch, 60_000);
    this.timer.unref?.();
    dispatch();
  }
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.running;
    await this.writes.catch(() => {});
  }
  async tick(now = this.deps.now?.() ?? Date.now()): Promise<void> {
    const s = await this.load();
    if (this.shuttingDown || !s.enabled || !s.chatId || this.busy) return;
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      if (s.day !== DAY(now)) { s.day = DAY(now); s.comments = 0; s.replies = 0; }
      if (s.pauseDay === s.day) return;
      await this.deliverShare(s, signal);
      if (now - s.lastReplies >= 20 * 60_000) {
        s.lastReplies = now; await this.save(s);
        await this.checkReplies(s, signal);
      }
      signal.throwIfAborted();
      if (s.enabled && s.pauseDay !== s.day && now - s.lastBrowse >= 4 * 3_600_000) {
        s.lastBrowse = now; await this.save(s);
        await this.browse(s, signal);
      }
      s.lastError = undefined;
    } catch (error) {
      if (signal.aborted) return;
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      const risk = /(?:-352|-509|12015|验证码|风控|太频繁)/i.test(reason);
      const login = /(?:-101|-111|未登录|凭证.*过期)/i.test(reason);
      s.lastError = containsSensitiveText(reason) ? "登录或权限检查失败（敏感信息已隐藏）" : reason;
      if (risk || login) { s.pauseDay = s.day; s.pauseReason = risk ? "B站风控、验证码或频率限制" : "未登录或登录凭证过期"; }
    } finally { await this.save(s).finally(() => { this.busy = false; this.controller = undefined; }); }
  }
  private async browse(s: State, signal: AbortSignal): Promise<void> {
    const interests = (await this.deps.interests()).slice(0, 12);
    const raw = await this.deps.decide("keywords", { interests }, signal);
    const keywords = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && !!v.trim() && v.length <= 40 && !containsSensitiveText(v) && !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b1\d{10}\b/.test(v)).slice(0, 3) : [];
    if (!keywords.length) return;
    const data = await this.readTool(s, "bili_explore", { keywords, max_videos: 2 }, signal);
    if (data.error) throw new Error(String(data.error));
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (!videos.length && Array.isArray(data.errors) && data.errors.length) throw new Error(String((data.errors[0] as Json)?.error ?? "B 站搜索失败"));
    if (videos.length && videos.every(entry => {
      const read = entry && typeof entry === "object" ? (entry as Json).read as Json | undefined : undefined;
      const info = read?.info as Json | undefined;
      return !info || !!info.error || !info.title;
    })) {
      const first = videos[0] as { read?: { error?: unknown; info?: { error?: unknown } } };
      throw new Error(String(first.read?.info?.error ?? first.read?.error ?? "视频资料读取失败"));
    }
    for (const entry of videos) {
      if (!s.enabled) break;
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Json; const read = item.read as Json | undefined; const info = read?.info as Json | undefined;
      if (typeof item.bvid !== "string" || !VIDEO.test(item.bvid) || !info || info.error || !info.title) continue;
      await this.shareVideo(s, item.bvid, { info, interests }, signal);
      if (s.comments >= 2) continue;
      const decision = await this.deps.decide("video", { bvid: item.bvid, info, subtitle: read?.subtitle, comments: read?.comments }, signal);
      if (!decision || typeof decision !== "object" || typeof (decision as Json).comment !== "string") throw new Error("视频评论决策格式无效，本轮未发布");
      const comment = this.commentFrom(decision);
      if (!comment) continue;
      await this.post(s, `video:${item.bvid}`, { bvid: item.bvid, text: comment }, "comment", signal);
    }
  }
  private async shareVideo(s: State, bvid: string, data: Json, signal: AbortSignal): Promise<void> {
    if (!this.deps.share || !s.enabled || signal.aborted || s.lastShareDay === s.day || s.attempted.includes(`share:${bvid}`)) return;
    const hour = new Date((this.deps.now?.() ?? Date.now()) + 8 * 3_600_000).getUTCHours();
    if (hour < 8 || hour >= 23) return;
    const decision = await this.deps.decide("share", data, signal);
    const text = decision && typeof decision === "object" && typeof (decision as Json).share === "string" ? String((decision as Json).share).trim().replace(/[\r\n]+/g, " ").slice(0, 160) : "";
    if (!text || SILENCE.test(text) || containsSensitiveText(text) || /https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b1\d{10}\b/i.test(text) || !s.enabled || signal.aborted) return;
    // A single slot coalesces candidates and expires instead of sending stale recommendations.
    s.pendingShare = { bvid, text, at: this.deps.now?.() ?? Date.now() }; await this.save(s);
    await this.deliverShare(s, signal);
  }
  private async deliverShare(s: State, signal: AbortSignal): Promise<void> {
    const item = s.pendingShare, now = this.deps.now?.() ?? Date.now();
    if (!item) return;
    if (!this.deps.share || !s.enabled || now - item.at >= 2 * 3600_000 || s.lastShareDay === DAY(now)) { delete s.pendingShare; await this.save(s); return; }
    const hour = new Date(now + 8 * 3600_000).getUTCHours();
    if (signal.aborted || hour < 8 || hour >= 23 || this.deps.isChatActive?.(s.chatId)) return;
    delete s.pendingShare; s.lastShareDay = DAY(now); s.attempted = [...s.attempted, `share:${item.bvid}`].slice(-1000); await this.save(s);
    if (!s.enabled || signal.aborted) return;
    await this.deps.share(s.chatId, `${item.text}\nhttps://www.bilibili.com/video/${item.bvid}`);
  }
  private async checkReplies(s: State, signal: AbortSignal): Promise<void> {
    const data = await this.readTool(s, "bili_check_replies", { limit: 10 }, signal);
    if (data.error) throw new Error(String(data.error));
    const replies = Array.isArray(data.replies) ? data.replies : [];
    for (const value of replies.slice(0, 5)) {
      if (!s.enabled || s.replies >= 5) break;
      if (!value || typeof value !== "object") continue;
      const item = value as Json;
      const bvid = typeof item.bvid === "string" ? item.bvid : "";
      const parent = Number(item.parent_rpid), root = Number(item.root_rpid);
      const key = `reply:${bvid}:${parent}`;
      if (!item.actionable || item.already_replied || !VIDEO.test(bvid) || !Number.isSafeInteger(parent) || parent <= 0 || !Number.isSafeInteger(root) || root <= 0 || s.handled.includes(key) || s.attempted.includes(key)) continue;
      const decision = await this.deps.decide("reply", item, signal);
      if (!decision || typeof decision !== "object" || typeof (decision as Json).comment !== "string") throw new Error("回复决策格式无效，本轮未回复");
      const comment = this.commentFrom(decision);
      if (!comment) { s.handled = [...s.handled, key].slice(-500); await this.save(s); continue; }
      await this.post(s, key, { bvid, text: comment, rpid: parent, root }, "reply", signal);
    }
  }
  private commentFrom(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const text = (value as Json).comment;
    if (typeof text !== "string") return "";
    const result = text.trim().replace(/[\r\n]+/g, " ").slice(0, 200);
    return !result || SILENCE.test(result) || containsSensitiveText(result) || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b1\d{10}\b/.test(result) ? "" : result;
  }
  private async readTool(s: State, name: string, args: Json, signal: AbortSignal): Promise<Json> {
    await this.deps.authorize(name, args, s.chatId, signal);
    signal.throwIfAborted();
    return this.deps.call(name, args, s.chatId, signal);
  }
  private async post(s: State, key: string, args: Json, kind: "comment" | "reply", signal: AbortSignal): Promise<void> {
    if (!s.enabled || signal.aborted || s.attempted.includes(key) || s.handled.includes(key)) return;
    await this.deps.authorize("bili_reply", args, s.chatId, signal);
    if (!s.enabled || signal.aborted) return;
    // Reserve before the network call: an ambiguous timeout or crash must not cause duplicate posts.
    s.attempted = [...s.attempted, key].slice(-1000);
    await this.save(s);
    if (!s.enabled || signal.aborted) return;
    const result = await this.deps.call("bili_reply", args, s.chatId, signal);
    if (result.success !== true) throw new Error(String(result.error ?? "评论未确认成功，已停止重试"));
    s.handled = [...s.handled, key].slice(-500);
    if (kind === "comment") s.comments++; else s.replies++;
    await this.save(s);
  }
}

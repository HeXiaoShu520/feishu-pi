import type { FeishuReply } from "./types.ts";

/** 合并高频文本更新，并保证飞书写操作按顺序完成。 */
export class ThrottledReply implements FeishuReply {
  private latestText = "";
  private flushedText = "";
  private timer?: ReturnType<typeof setTimeout>;
  private writeChain: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private readonly reply: FeishuReply;
  private readonly delayMs: number;

  constructor(reply: FeishuReply, delayMs = 80) {
    this.reply = reply;
    this.delayMs = delayMs;
  }

  update(text: string): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.latestText = text;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.delayMs);
    }
    return this.writeChain;
  }

  close(text: string): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.latestText && this.latestText !== this.flushedText) this.flush();
    this.closePromise = this.writeChain.then(() => this.reply.close(text || this.latestText || "（无响应）"));
    return this.closePromise;
  }

  private flush(): void {
    const text = this.latestText;
    if (!text || text === this.flushedText) return;
    this.flushedText = text;
    this.writeChain = this.writeChain.then(() => this.reply.update(text)).catch(() => undefined);
  }
}

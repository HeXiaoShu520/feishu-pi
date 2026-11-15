import type { BiliAutomation } from "../bilibili/automation.ts";
import type { FeishuInboundMessage } from "./types.ts";
import { markdownCard, type CommandHandler, type CommandResult } from "./commands.ts";
import { containsSensitiveText } from "../assistant/sensitive.ts";

export class BiliAutoCommand implements CommandHandler {
  private readonly service?: BiliAutomation;
  constructor(service?: BiliAutomation) { this.service = service; }
  match(text: string): boolean { return /^\/bili-auto(?:\s|$)/i.test(text.trim()); }
  async execute(message: FeishuInboundMessage): Promise<CommandResult> {
    if (!message.context.isOwner || message.context.chatMode !== "p2p") return { card: markdownCard("请由管理员在飞书私聊中操作 B 站自动化。") };
    if (!this.service) return { card: markdownCard("B 站自动化服务未加载。在本机 `.env` 中设置 `FEISHU_BILI_AUTO_AVAILABLE=true` 并重启后，再使用 `/bili-auto on` 启动。") };
    const action = message.text.trim().split(/\s+/)[1]?.toLowerCase() ?? "status";
    if (action === "on") {
      await this.service.configure(true, message.chatId);
      return { card: markdownCard("已启用 B 站自动浏览和评论跟进。每 4 小时最多浏览一轮，每 20 分钟检查回复；公开评论仍遵守权限审核，需先完成 B 站登录。发送 `/bili-auto off` 可停用。") };
    }
    if (action === "off") {
      await this.service.configure(false);
      return { card: markdownCard("已停用 B 站自动化。已发出的评论和本地记录仍保留。") };
    }
    if (action === "run") {
      const state = await this.service.status();
      if (!state.enabled) return { card: markdownCard("请先使用 `/bili-auto on` 启用自动化。") };
      void this.service.runNow().catch(() => {});
      return { card: markdownCard("已请求执行一轮；结果和错误可通过 `/bili-auto status` 查看。") };
    }
    if (action !== "status") return { card: markdownCard("用法：`/bili-auto on`、`/bili-auto off`、`/bili-auto status`、`/bili-auto run`。") };
    const s = await this.service.status();
    const error = s.lastError ? `\n最近错误：${containsSensitiveText(s.lastError) ? "登录或权限检查失败，请查看本机配置" : s.lastError.replace(/[\r\n`<>]/g, " ").slice(0, 150)}` : "";
    return { card: markdownCard(`B 站自动化：${s.enabled ? "已启用" : "已停用"}\n今日成功评论 ${s.comments}/2，回复 ${s.replies}/5${s.pauseDay === s.day && s.pauseDay ? "\n今日因登录或风控错误暂停" : ""}${error}`) };
  }
}

import "dotenv/config";
import { ConversationManager } from "./runtime/conversation-manager.ts";
import { FeishuPiRuntime } from "./runtime/feishu-pi-runtime.ts";
import { FeishuAgentBridge } from "./feishu/agent-bridge.ts";
import { LarkTransport } from "./feishu/lark-transport.ts";
import { loadConfig } from "./config.ts";
import { ConversationStore } from "./runtime/conversation-store.ts";
import { MessageStore } from "./feishu/message-store.ts";
import { DataCleaner } from "./runtime/data-cleaner.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@larksuiteoapi/node-sdk";

/** 启动轻量飞书 Agent 服务。 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = new FeishuPiRuntime(config);
  const conversations = new ConversationManager(runtime, new ConversationStore(join(config.sessionDir, "conversations.json")));
  const messages = new MessageStore(join(config.sessionDir, "messages.json"));

  // 启动时清理过期数据和卡住的消息
  const cleaner = new DataCleaner({
    sessionDir: config.sessionDir,
    retentionDays: 7,
    dryRun: false,
  });

  console.info("[DataCleaner] 清理卡住的消息...");
  const stuckCount = await cleaner.cleanupStuckMessages();
  if (stuckCount > 0) {
    console.info(`[DataCleaner] 已清理 ${stuckCount} 条卡住的消息`);
  }

  console.info("[DataCleaner] 清理过期数据（保留 7 天）...");
  const stats = await cleaner.cleanup();
  console.info(`[DataCleaner] 会话: ${stats.sessionsDeleted}/${stats.sessionsChecked} 已删除`);
  console.info(`[DataCleaner] 图片: ${stats.imagesDeleted}/${stats.imagesChecked} 已删除`);
  console.info(`[DataCleaner] 消息: ${stats.messagesCleaned}/${stats.messagesChecked} 已清理`);

  // 定期清理（每天一次）
  setInterval(async () => {
    console.info("[DataCleaner] 执行定期清理...");
    const dailyStats = await cleaner.cleanup();
    if (dailyStats.sessionsDeleted > 0 || dailyStats.imagesDeleted > 0 || dailyStats.messagesCleaned > 0) {
      console.info(`[DataCleaner] 会话: ${dailyStats.sessionsDeleted}/${dailyStats.sessionsChecked} 已删除`);
      console.info(`[DataCleaner] 图片: ${dailyStats.imagesDeleted}/${dailyStats.imagesChecked} 已删除`);
      console.info(`[DataCleaner] 消息: ${dailyStats.messagesCleaned}/${dailyStats.messagesChecked} 已清理`);
    }
  }, 24 * 60 * 60 * 1000); // 24 小时

  // 创建飞书 Client（用于图片下载和 CardKit）
  const client = new Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

  const transport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId: config.feishuBotOpenId,
    client,
    imageCacheDir: join(config.sessionDir, "images"),
  });

  const bridge = new FeishuAgentBridge(
    conversations,
    transport,
    {
      messages,
      client,
      enableCardKit: true,
    },
  );

  bridge.start();
  await transport.connect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

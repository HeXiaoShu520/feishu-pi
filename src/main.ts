import "dotenv/config";
import "./config-server.ts"; // 启动配置服务器
import { ConversationManager } from "./runtime/conversation-manager.ts";
import { FeishuPiRuntime } from "./runtime/feishu-pi-runtime.ts";
import { FeishuAgentBridge } from "./feishu/agent-bridge.ts";
import { LarkTransport } from "./feishu/lark-transport.ts";
import { loadConfig } from "./config.ts";
import { ConversationStore } from "./runtime/conversation-store.ts";
import { MessageStore } from "./feishu/message-store.ts";
import { DataCleaner } from "./runtime/data-cleaner.ts";
import { resolveAdminOpenId } from "./feishu/admin-resolver.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "./utils/logger.ts";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

/** 启动轻量飞书 Agent 服务。 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const pidFile = join(config.sessionDir, ".pid");

  // 启动时：检查并清理旧进程
  if (existsSync(pidFile)) {
    try {
      const oldPid = readFileSync(pidFile, "utf-8").trim();
      logger.warn(`[Main] 发现旧 PID 文件: ${oldPid}，尝试清理...`);

      if (process.platform === "win32") {
        // Windows: 先检查进程是否存在
        try {
          execSync(`tasklist /FI "PID eq ${oldPid}" | find "${oldPid}"`, { stdio: "ignore" });
          // 进程存在，杀掉
          execSync(`taskkill /F /PID ${oldPid}`, { stdio: "ignore" });
          logger.info(`[Main] 已清理旧进程 ${oldPid}`);
        } catch {
          // 进程不存在或已退出
          logger.info(`[Main] 旧进程 ${oldPid} 已不存在`);
        }
      } else {
        // Unix: 发送 SIGTERM，失败则忽略
        try {
          process.kill(parseInt(oldPid), "SIGTERM");
          logger.info(`[Main] 已清理旧进程 ${oldPid}`);
        } catch {
          logger.info(`[Main] 旧进程 ${oldPid} 已不存在`);
        }
      }

      unlinkSync(pidFile);
    } catch (err) {
      logger.error(`[Main] 清理旧 PID 文件失败:`, err);
    }
  }

  // 写入当前 PID
  writeFileSync(pidFile, process.pid.toString(), "utf-8");
  logger.info(`[Main] 当前进程 PID: ${process.pid}`);

  const messages = new MessageStore(join(config.sessionDir, "messages.json"));

  // 启动时清理过期数据和卡住的消息
  const cleaner = new DataCleaner({
    sessionDir: config.sessionDir,
    retentionDays: 7,
    dryRun: false,
  });

  logger.info("[DataCleaner] 清理卡住的消息...");
  const stuckCount = await cleaner.cleanupStuckMessages();
  if (stuckCount > 0) {
    logger.info(`[DataCleaner] 已清理 ${stuckCount} 条卡住的消息`);
  }

  logger.info("[DataCleaner] 清理过期数据（保留 7 天）...");
  const stats = await cleaner.cleanup();
  logger.info(`[DataCleaner] 会话: ${stats.sessionsDeleted}/${stats.sessionsChecked} 已删除`);
  logger.info(`[DataCleaner] 图片: ${stats.imagesDeleted}/${stats.imagesChecked} 已删除`);
  logger.info(`[DataCleaner] 消息: ${stats.messagesCleaned}/${stats.messagesChecked} 已清理`);

  // 定期清理（每天一次）
  const cleanupTimer = setInterval(async () => {
    logger.info("[DataCleaner] 执行定期清理...");
    const dailyStats = await cleaner.cleanup();
    if (dailyStats.sessionsDeleted > 0 || dailyStats.imagesDeleted > 0 || dailyStats.messagesCleaned > 0) {
      logger.info(`[DataCleaner] 会话: ${dailyStats.sessionsDeleted}/${dailyStats.sessionsChecked} 已删除`);
      logger.info(`[DataCleaner] 图片: ${dailyStats.imagesDeleted}/${dailyStats.imagesChecked} 已删除`);
      logger.info(`[DataCleaner] 消息: ${dailyStats.messagesCleaned}/${dailyStats.messagesChecked} 已清理`);
    }
  }, 24 * 60 * 60 * 1000); // 24 小时

  // 创建飞书 Client（用于图片下载和 CardKit）
  const client = new Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

  // 自动获取 Bot Open ID
  let botOpenId: string | undefined;
  try {
    const res = await client.request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    });
    if (res.code === 0 && res.data?.bot?.open_id) {
      botOpenId = res.data.bot.open_id;
      logger.info(`[Main] Bot Open ID: ${botOpenId}`);
    }
  } catch (err) {
    logger.warn("[Main] 获取 Bot Open ID 失败:", err);
  }

  // 解析管理员 Open ID（可选，优先从缓存查找）
  const adminOpenId = await resolveAdminOpenId(client, config.feishuAdmin, config.feishuAppId);
  if (adminOpenId) {
    logger.info(`[Main] 管理员 Open ID: ${adminOpenId}`);
  } else {
    logger.info(`[Main] 未配置管理员`);
  }

  // 解析团队成员 Open IDs（优先从缓存查找）
  const teamMemberIds: string[] = [];
  for (const member of config.feishuTeamMembers) {
    const memberId = await resolveAdminOpenId(client, member, config.feishuAppId);
    if (memberId) {
      teamMemberIds.push(memberId);
    }
  }
  if (teamMemberIds.length > 0) {
    logger.info(`[Main] 团队成员: ${teamMemberIds.length} 人`);
  }

  // 创建 runtime 配置
  const runtime = new FeishuPiRuntime({
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    modelBaseUrl: config.modelBaseUrl,
    systemPrompt: config.systemPrompt,
    adminId: adminOpenId || "",
    teamMemberIds,
  });

  // 启动时打印可用的 Skills 和 Tools（管理员视角）
  await runtime.printAvailableResources();

  const conversations = new ConversationManager(runtime, new ConversationStore(join(config.sessionDir, "conversations.json")));

  const transport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId,
    client,
    imageCacheDir: join(config.sessionDir, "images"),
    adminOpenId,
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

  // 打印配置页面地址
  console.log(`\n配置页面: http://localhost:3456\n`);

  // 优雅退出处理：确保所有资源完全释放
  let exiting = false;
  const gracefulShutdown = async (signal: string) => {
    if (exiting) return;
    exiting = true;
    logger.info(`[Main] 收到 ${signal} 信号，正在关闭服务...`);

    // 清理定时器
    clearInterval(cleanupTimer);

    try {
      // 设置 3 秒超时，防止 WebSocket 断开卡住
      const disconnectPromise = transport.disconnect();
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("disconnect timeout")), 3000)
      );
      await Promise.race([disconnectPromise, timeout]);
      logger.info("[Main] 飞书连接已关闭");
    } catch (err) {
      logger.warn("[Main] 关闭飞书连接超时或失败:", err instanceof Error ? err.message : err);
    }

    // 删除 PID 文件
    try {
      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
        logger.info("[Main] PID 文件已删除");
      }
    } catch (err) {
      logger.error("[Main] 删除 PID 文件失败:", err);
    }

    // 强制退出，确保所有子进程和定时器被清理
    logger.info("[Main] 服务已完全退出");
    process.exit(0);
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Windows 特有：监听 Ctrl+Break
  if (process.platform === "win32") {
    process.on("SIGBREAK" as any, () => gracefulShutdown("SIGBREAK"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

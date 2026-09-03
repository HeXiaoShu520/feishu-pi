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
import { CommandWhitelist, loadWhitelistConfig } from "./guard/whitelist.ts";
import { SafetyJudge } from "./guard/judge.ts";
import { PermissionBroker } from "./guard/broker.ts";
import { ToolGuard } from "./guard/tool-guard.ts";

/** 启动轻量飞书 Agent 服务。 */
export async function main(): Promise<void> {
  const config = loadConfig();
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

  // 团队成员配置（不需要预先解析，运行时动态匹配）
  if (config.feishuTeamMembers.length > 0) {
    logger.info(`[Main] 团队成员配置: ${config.feishuTeamMembers.length} 人`);
  }

  const transport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId,
    client,
    imageCacheDir: join(config.sessionDir, "images"),
    adminOpenId,
  });

  // 工具调用 Guard：白名单正则 + 大模型审核 + 管理员授权卡
  // 白名单优先从 .agent/whitelist.json 读取，文件不存在时回退环境变量
  const whitelistFile = join(config.cwd, ".agent", "whitelist.json");
  const whitelistConfig = loadWhitelistConfig(whitelistFile);
  if (whitelistConfig.patterns.length > 0) {
    logger.info(`[Main] 已加载白名单 ${whitelistConfig.patterns.length} 条（${whitelistFile}）`);
  } else if (config.cmdWhitelist.length > 0) {
    logger.info(`[Main] 白名单文件不存在，使用 FEISHU_CMD_WHITELIST 环境变量（${config.cmdWhitelist.length} 条）`);
  }
  const whitelist = new CommandWhitelist(whitelistConfig.patterns.length > 0 ? whitelistConfig.patterns : config.cmdWhitelist);
  const judge = new SafetyJudge({
    cwd: config.cwd,
    baseUrl: config.guardBaseUrl,
    model: config.guardModel,
    apiKey: config.guardApiKey,
    timeoutMs: config.guardTimeoutMs,
    writableDirs: whitelistConfig.writableDirs,
  });
  // bridge 在下方创建，先用闭包引用（授权卡撤回需查询该会话的详细模式开关）
  let bridgeRef: FeishuAgentBridge | undefined;
  const broker = new PermissionBroker({
    adminOpenIds: adminOpenId ? [adminOpenId] : [],
    timeoutMs: config.approvalTimeoutMs,
    sendCard: (chatId, card) => transport.sendCardToChat(chatId, card),
    updateCard: (messageId, card) => transport.updateCardById(messageId, card),
    // 精简模式下授权确认后撤回卡片，减少会话占用
    recallCard: (messageId) => transport.recallMessageById(messageId),
    shouldRecall: (chatId) => bridgeRef?.isDetailMode(chatId) === false,
  });
  const toolGuard = new ToolGuard(whitelist, judge, broker);

  // 授权卡回调 → PermissionBroker 服务端校验（token / 卡片来源 / 管理员身份）
  transport.onApproval(async ({ value, action }) => {
    const approvalId = typeof value.approval_id === "string" ? value.approval_id : undefined;
    const token = typeof value.token === "string" ? value.token : undefined;

    // 「申请转发给管理员」：把授权卡转发到管理员私聊
    if (value.action === "forward_approval") {
      const result = await broker.forwardToAdmin({ approvalId, token, messageId: action.messageId, chatId: action.chatId });
      if (result.accepted) {
        logger.info(`[Main] 授权请求已转发给管理员私聊（点击者 ${action.operatorOpenId}）`);
      } else {
        logger.warn(`[Main] 转发请求被拒绝: ${result.detail}（点击者 ${action.operatorOpenId}）`);
      }
      return;
    }

    const result = await broker.handleCallback({
      approvalId,
      token,
      decision: typeof value.decision === "string" ? value.decision : undefined,
      messageId: action.messageId,
      chatId: action.chatId,
      operatorOpenId: action.operatorOpenId,
    });
    if (result.accepted) {
      logger.info(`[Main] 授权回调已处理: ${result.detail}（点击者 ${action.operatorOpenId}）`);
    } else {
      logger.warn(`[Main] 授权回调被拒绝: ${result.detail}（点击者 ${action.operatorOpenId}）`);
    }
  });

  // 创建 runtime 配置
  const runtime = new FeishuPiRuntime({
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    modelBaseUrl: config.modelBaseUrl,
    systemPrompt: config.systemPrompt,
    adminId: adminOpenId || "",
    teamMemberIdentifiers: config.feishuTeamMembers,  // 传原始配置
    toolGuard: (params) => toolGuard.check(params),
  });

  // 启动时打印可用的 Skills 和 Tools（管理员视角）
  await runtime.printAvailableResources();

  const conversations = new ConversationManager(runtime, new ConversationStore(join(config.sessionDir, "conversations.json")));

  const bridge = new FeishuAgentBridge(
    conversations,
    transport,
    {
      messages,
      client,
      enableCardKit: true,
    },
  );
  bridgeRef = bridge;

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

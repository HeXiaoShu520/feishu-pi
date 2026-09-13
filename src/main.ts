import "dotenv/config";
import { registerSkillStatsRoutes } from "./config-server.ts"; // 启动配置服务器（模块加载即监听 127.0.0.1:3456）
import { ConversationManager } from "./runtime/conversation-manager.ts";
import { FeishuPiRuntime } from "./runtime/feishu-pi-runtime.ts";
import { FeishuAgentBridge } from "./feishu/agent-bridge.ts";
import { LarkTransport } from "./feishu/lark-transport.ts";
import { loadConfig } from "./config.ts";
import { ConversationStore } from "./runtime/conversation-store.ts";
import { MessageStore } from "./feishu/message-store.ts";
import { DataCleaner } from "./runtime/data-cleaner.ts";
import { resolveAdminOpenId } from "./feishu/admin-resolver.ts";
import { SkillUsageStore } from "./stats/skill-usage-store.ts";
import { ScheduleService } from "./schedule/service.ts";
import { PermissionPolicy } from "./permission/policy.ts";
import { PermCommand } from "./feishu/commands.ts";
import { LoginCommand, LogoutCommand, UserAuthService } from "./feishu/user-auth.ts";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "./utils/logger.ts";
import { PermissionBroker } from "./guard/broker.ts";
import { ToolGuard } from "./guard/tool-guard.ts";
import { PolicyJudge } from "./guard/judge.ts";
import { buildNoticeCard } from "./guard/card.ts";
import { AskBroker, createAskUserTool } from "./feishu/ask-broker.ts";
import type { CleanupStats } from "./runtime/data-cleaner.ts";

/** 授权请求失效（服务重启/已处理）时就地更新的提示卡文案。 */
const APPROVAL_STALE_NOTICE = "⚠️ 该授权请求已失效（服务已重启或已处理），请重新发起任务。";

/** 打印一轮清理的统计（有删除动作才逐项输出，避免每日空转刷屏）。 */
async function logCleanupStats(cleanup: Promise<CleanupStats>): Promise<void> {
  const stats = await cleanup;
  if (stats.sessionsDeleted === 0 && stats.attachmentsDeleted === 0 && stats.imagesDeleted === 0 && stats.messagesCleaned === 0) return;
  logger.info(`[DataCleaner] 会话: ${stats.sessionsDeleted}/${stats.sessionsChecked} 已删除`);
  logger.info(`[DataCleaner] 附件: ${stats.attachmentsDeleted}/${stats.attachmentsChecked} 已删除`);
  logger.info(`[DataCleaner] 图片: ${stats.imagesDeleted}/${stats.imagesChecked} 已删除`);
  logger.info(`[DataCleaner] 消息: ${stats.messagesCleaned}/${stats.messagesChecked} 已清理`);
}

/** 启动轻量飞书 Agent 服务。 */

/**
 * 服务组装根：按依赖顺序装配各模块（清理 → 飞书传输 → 授权 → 权限闸门 →
 * 运行时 → 会话管理 → 桥接），并挂接卡片回调与定时任务。这里只做接线，不承载业务逻辑。
 */
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
  await logCleanupStats(cleaner.cleanup());

  // 定期清理（每天一次）
  const cleanupTimer = setInterval(async () => {
    logger.info("[DataCleaner] 执行定期清理...");
    await logCleanupStats(cleaner.cleanup());
  }, 24 * 60 * 60 * 1000); // 24 小时

  // ---------- 飞书基础通道：Client（所有 API 调用）与 Bot 身份 ----------

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

  // 解析管理员 Open ID（名字/邮箱/缓存；失败则管理员通道暂不可用，不影响其他功能）
  const adminOpenId = await resolveAdminOpenId(client, config.feishuAdmin, config.feishuAppId);
  if (adminOpenId) {
    logger.info(`[Main] 管理员 Open ID: ${adminOpenId}`);
  } else {
    logger.info("[Main] 管理员未解析：用户资料查询将仅用群名单兜底");
  }

  // ---------- 消息传输与用户授权 ----------

  // runtime 先声明（transport 的 onModelSwitch 回调引用它）
  let runtime: FeishuPiRuntime;
  // userAuth 先声明（transport 的管理员资料查询通道引用它的 token；实际实例在其后创建）
  let userAuth: UserAuthService | undefined;

  const transport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId,
    client,
    imageCacheDir: join(config.sessionDir, "images"),
    sessionDataDir: config.sessionDir,
    adminOpenId,
    topicRootsFile: join(config.sessionDir, "topic-roots.json"),
    // 管理员 /login 后其 user token 是用户资料查询的唯一通道（补英文名/部门，覆盖可用范围外用户）
    adminTokenProvider: async () => (adminOpenId && userAuth ? userAuth.getUserAccessToken(adminOpenId) : undefined),
    // /model 切换时通知运行时热切换（持久化到 .env 仍在 transport 内完成）
    onModelSwitch: (name) => runtime?.setModelName(name),
  });

  // 用户飞书身份授权（Device Flow，RFC 8628）：/login 指令 + 按 openId 存取 user_access_token
  userAuth = new UserAuthService({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    scopes: config.userAuthScopes,
    adminOpenId: adminOpenId,
    storeFile: join(config.dataDir, "user-tokens.json"),
    updateCard: (messageId, card) => transport.updateCardById(messageId, card),
    // 增量授权：能力需要新 scope 时自动向该会话发授权卡
    sendCard: (chatId, card) => transport.sendCardToChat(chatId, card),
  });

  // ---------- 权限闸门：策略 → 智能体审核 → 管理员授权卡 ----------

  const policyFile = join(config.cwd, ".agent", "permissions.json");
  const policy = new PermissionPolicy(policyFile, {
    adminId: adminOpenId ?? "",
    groupMembership: config.groupMembership,
    usersFile: join(dirname(config.sessionDir), "users", `${config.feishuAppId}_users.json`),
    cwd: config.cwd,
  });
  if (config.cmdWhitelist.length > 0) {
    logger.warn(`[Main] FEISHU_CMD_WHITELIST 已废弃，工具规则统一在 .agent/permissions.json 中配置`);
  }
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
  const toolGuard = new ToolGuard(broker, new PolicyJudge({
    baseUrl: config.guardBaseUrl,
    models: config.guardModels,
    apiKey: config.guardApiKey,
    timeoutMs: config.guardTimeoutMs,
  }));

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
        // 服务重启等导致请求失效：就地更新点击的卡片，给点击者明确提示
        await transport.updateCardById(action.messageId, buildNoticeCard(APPROVAL_STALE_NOTICE)).catch(() => {});
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
      // 失效点击就地更新卡片提示（服务重启后旧授权卡会命中这里）
      if (result.detail.includes("不存在")) {
        await transport.updateCardById(action.messageId, buildNoticeCard(APPROVAL_STALE_NOTICE)).catch(() => {});
      }
    }
  });

  // 选项卡（ask_user）：AI 调 ask_user_question 工具时向会话发提问卡，
  // 点选回调经 AskBroker 校验（存在性/一次性 token/仅本人）后唤醒等待中的工具
  const askBroker = new AskBroker({
    sendCard: (chatId, card) => transport.sendCardToChat(chatId, card),
    updateCard: (messageId, card) => transport.updateCardById(messageId, card),
  });
  transport.onAskUser(async ({ value, action }) => {
    const outcome = askBroker.resolve({
      qid: typeof value.qid === "string" ? value.qid : undefined,
      token: typeof value.token === "string" ? value.token : undefined,
      choice: typeof value.choice === "string" ? value.choice : undefined,
      operatorOpenId: action.operatorOpenId,
      messageId: action.messageId,
    });
    if (outcome) {
      logger.info(`[Main] 选项卡已作答: ${outcome.choice}（点击者 ${action.operatorOpenId}）`);
    } else {
      logger.warn(`[Main] 选项卡点击被忽略（非提问对象或请求已失效，点击者 ${action.operatorOpenId}）`);
    }
  });

  // ---------- 统计与定时任务 ----------

  // 技能使用统计：独立事件流（data/stats/，不参与 7 天清理），展示名解析复用用户缓存
  const dataDir = dirname(config.sessionDir);
  const usageStore = new SkillUsageStore(
    join(dataDir, "stats", "skill-usage.jsonl"),
    join(dataDir, "users", `${config.feishuAppId}_users.json`),
  );
  registerSkillStatsRoutes(usageStore);

  // 定时任务：持久化（data/schedules.json）+ cron 调度；触发时以创建者身份跑智能体并推送结果卡片
  // 注意：runTask 闭包引用下方才声明的 conversations（前向引用），仅在任务触发（启动完成后）才会执行
  const scheduleService = new ScheduleService({
    storeFile: join(dataDir, "schedules.json"),
    runTask: async (task) => {
      const conversationId = `${task.createdBy}-schedule:${task.id}`;
      const context = {
        userOpenId: task.createdBy,
        chatId: task.chatId,
        conversationId,
      };
      let output = "";
      await conversations.prompt(
        {
          conversationId,
          prompt: { text: task.prompt },
          context,
        },
        (event) => {
          if (event.type === "assistant_text") output = event.text;
        },
      );
      const trimmed = (output || "（本轮无文本输出）").slice(0, 4000);
      await transport.sendCardToChat(task.chatId, {
        schema: "2.0",
        config: { update_multi: true },
        body: { elements: [{ tag: "markdown", content: `**⏰ 定时任务：${task.name}**

${trimmed}` }] },
      });
    },
  });

  // ---------- 运行时与会话桥接 ----------

  // 两档身份：负责人 = FEISHU_ADMIN，用户 = 其他人；能力全部由策略文件驱动。
  // 第二个参数：项目内置交互工具（随会话注册，调用者身份由 runtime 派发时注入）
  runtime = new FeishuPiRuntime({
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    modelBaseUrl: config.modelBaseUrl,
    systemPrompt: config.systemPrompt,
    adminId: adminOpenId || "",
    permissionPolicy: policy,
    toolGuard: (groupPolicy, params, signal) => toolGuard.check(groupPolicy, params, signal),
    skillUsageStore: usageStore,
    scheduleService,
  }, [createAskUserTool(askBroker)]);

  // 上电预加载：权限策略 + Skills + 自定义工具在首条消息前全部就绪
  await runtime.preload();

  // 启动时打印可用的 Skills 和 Tools（管理员视角）
  await runtime.printAvailableResources();

  const conversations = new ConversationManager(runtime, new ConversationStore(join(config.sessionDir, "conversations.json")));

  const bridge = new FeishuAgentBridge(
    conversations,
    transport,
    {
      messages,
      client,
      // /perm 查看身份、双组策略与工具档位（仅管理员）；/login /logout 用户飞书身份授权（Device Flow）
      extraCommands: [
        new PermCommand(() => policy.describe()),
        new LoginCommand(userAuth),
        new LogoutCommand(userAuth),
      ],
      // 回复末尾的模型统计小字开关（工具过程状态不受影响）
      showModelStats: config.showModelStats,
      // /model 指令的运行时模型信息（config 对象即 runtime 热切换的同一引用，取到的是实时值）
      modelInfo: () => ({
        baseUrl: config.modelBaseUrl,
        modelName: config.modelName,
        apiKey: process.env.FEISHU_PI_MODEL_API_KEY ?? "",
      }),
    },
  );
  bridgeRef = bridge;

  // ---------- 启动 ----------

  bridge.start();
  await transport.connect();
  // 恢复定时任务调度（任务持久化在 data/schedules.json）
  await scheduleService.start();

  // 打印配置页面地址
  console.log(`\n配置页面: http://localhost:3456\n`);

  // 优雅退出处理：Windows 上 WebSocket disconnect 可能挂住，
  // 因此后台尝试断开 + 短宽限后立即硬退出，不阻塞终端
  let exiting = false;
  const gracefulShutdown = async (signal: string) => {
    if (exiting) return;
    exiting = true;
    logger.info(`[Main] 收到 ${signal} 信号，正在关闭服务...`);

    clearInterval(cleanupTimer);
    scheduleService.stop();

    // 断开在后台进行，不 await——挂住也不影响退出
    void transport.disconnect().then(
      () => logger.info("[Main] 飞书连接已关闭"),
      (err) => logger.warn("[Main] 关闭飞书连接失败:", err instanceof Error ? err.message : err),
    );

    // 给断开操作 500ms 宽限期后强制退出（进程退出后未完成的连接由操作系统回收）
    setTimeout(() => {
      logger.info("[Main] 服务已退出");
      process.exit(0);
    }, 500);
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Windows 特有：监听 Ctrl+Break（SIGBREAK 在 Node 类型定义中跨平台存在）
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => gracefulShutdown("SIGBREAK"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

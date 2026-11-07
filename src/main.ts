import { PersonaVersions } from "./resources/persona-versions.ts";
import { createStickerSendTool } from "./stickers/send.ts";
import { createGuestStickerSearchTool } from "./stickers/guest-search.ts";
import { StickerHistory } from "./stickers/recent.ts";
import { createRulesLoader } from "./stickers/rules.ts";
import { BiliAutomation } from "./bilibili/automation.ts";
import { BiliAutoCommand } from "./feishu/bili-auto-command.ts";
import { mcpToolName } from "./mcp/names.ts";
import "./bootstrap-env.ts"; // 最早执行：.env 缺失自动拷贝（必须在 dotenv 之前）
import "dotenv/config";
import { ConversationManager } from "./runtime/conversation-manager.ts";
import { FeishuPiRuntime } from "./runtime/feishu-pi-runtime.ts";
import { FeishuAgentBridge } from "./feishu/agent-bridge.ts";
import { LarkTransport } from "./feishu/lark-transport.ts";
import { loadConfig } from "./config.ts";
import { SessionStore } from "./runtime/session-store.ts";
import { MessageStore } from "./feishu/message-store.ts";
import { DataCleaner } from "./runtime/data-cleaner.ts";
import { resolveOwnerOpenId } from "./feishu/owner-resolver.ts";
import { ScheduleService } from "./schedule/service.ts";
import { PermissionPolicy } from "./permission/policy.ts";
import { LogoutCommand, StatusCommand, UserAuthService } from "./feishu/user-auth.ts";
import { MeegleDeviceLogin, MEEGLE_DEFAULT_HOST, StaticCredentialService } from "./feishu/meegle-auth.ts";
import { PeopleRoster } from "./feishu/people-roster.ts";
import { RestartCommand, markdownCard } from "./feishu/commands.ts";
import { toggleTrailingBlankLine } from "./utils/restart-toggle.ts";
import { createIdentityBashTool, openIdentityShell, type IdentityBashOptions } from "./runtime/identity-bash.ts";
import { createMentionProfileLookup } from "./feishu/lark-cli-search.ts";
import { runSetupWizard } from "./feishu/setup-wizard.ts";
import { delimiter, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { logger } from "./utils/logger.ts";
import { scrubSecretsInDir } from "./utils/session-scrub.ts";
import { PermissionBroker } from "./guard/broker.ts";
import { ToolGuard, createToolCallLimiter } from "./guard/tool-guard.ts";
import { PolicyJudge } from "./guard/judge.ts";
import { buildNoticeCard } from "./guard/card.ts";
import { AskBroker, createAskUserTool } from "./feishu/ask-broker.ts";
import { AssistantServices } from "./assistant/services.ts";
import type { FeishuContext } from "./runtime/types.ts";
import { SlashCommandRegistrar } from "./feishu/slash-command.ts";
import type { CleanupStats } from "./runtime/data-cleaner.ts";
import { acquireInstanceLock } from "./utils/instance-lock.ts";
import { sendOwnerLifecycleNotice } from "./feishu/owner-lifecycle-notice.ts";

/** 授权请求失效（服务重启/已处理）时就地更新的提示卡文案。 */
const APPROVAL_STALE_NOTICE = "⚠️ 该授权请求已失效（服务已重启或已处理），请重新发起任务。";

function formatCardOperator(action: { operatorOpenId: string; operatorName?: string }): string {
  const name = action.operatorName?.trim();
  return name ? `${name}（${action.operatorOpenId}）` : action.operatorOpenId;
}

/** 打印一轮清理的统计（有删除动作才逐项输出，避免每日空转刷屏）。 */
async function logCleanupStats(cleanup: Promise<CleanupStats>): Promise<void> {
  const stats = await cleanup;
  if (stats.sessionsDeleted === 0 && stats.messagesCleaned === 0) return;
  logger.info(`[DataCleaner] 会话目录: ${stats.sessionsDeleted}/${stats.sessionsChecked} 已删除`);
  logger.info(`[DataCleaner] 消息: ${stats.messagesCleaned}/${stats.messagesChecked} 已清理`);
}

/**
 * 服务组装根：按依赖顺序装配各模块（清理 → 飞书传输 → 授权 → 权限闸门 →
 * 运行时 → 会话管理 → 桥接），并挂接卡片回调与定时任务。这里只做接线，不承载业务逻辑。
 */
export async function main(): Promise<void> {
  // 上电自检：未配置机器人时进入扫码开通向导（创建/绑定应用 + 预置权限 + 写 .env），
  // 完成后凭证注入进程环境并继续正常装配。无 TTY（守护进程/CI）不进入向导，给出明确指引。
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    if (!process.stdout.isTTY) {
      throw new Error("未检测到机器人配置（FEISHU_APP_ID / FEISHU_APP_SECRET）。请在交互终端运行 `npm run setup` 完成扫码开通后重试。");
    }
    console.log("未检测到机器人配置：进入扫码开通向导（之后可随时运行 npm run setup 重新配置）。\n");
    const created = await runSetupWizard({ envFile: join(process.cwd(), ".env") });
    process.env.FEISHU_APP_ID = created.appId;
    process.env.FEISHU_APP_SECRET = created.appSecret;
    console.log("");
  }

  const config = loadConfig();
  await new PersonaVersions(join(config.cwd, ".agent")).save();
  const instanceLock = await acquireInstanceLock(join(config.dataDir, ".instance.lock"));

  // 项目内预制 CLI（lark-cli）：把 node_modules/.bin 前插到 PATH，
  // Agent 的 bash 子进程继承后可直接调用，且优先于全局同名命令（npm install 即自带，不依赖全局安装）
  const projectBinDir = join(config.cwd, "node_modules", ".bin");
  process.env.PATH = `${projectBinDir}${delimiter}${process.env.PATH ?? ""}`;

  const messages = new MessageStore(config.messagesFile);

  // 保留历史会话（类默认，删除必须显式传 preserveSessions: false），清理去重记录和卡住的消息。
  const cleaner = new DataCleaner({
    sessionsRoot: config.sessionsRoot,
    messages,
    retentionDays: 7,
  });

  logger.info("[DataCleaner] 清理卡住的消息...");
  const stuckCount = await cleaner.cleanupStuckMessages();
  if (stuckCount > 0) {
    logger.info(`[DataCleaner] 已清理 ${stuckCount} 条卡住的消息`);
  }

  logger.info("[DataCleaner] 保留历史会话，清理过期去重记录...");
  await logCleanupStats(cleaner.cleanup());

  // 定期清理（每天一次）；conversations 在下方声明，回调首次触发时早已初始化
  const cleanupTimer = setInterval(() => {
    void (async () => {
    logger.info("[DataCleaner] 执行定期清理...");
    await logCleanupStats(cleaner.cleanup());
    // 空闲超过 24 小时的会话驱逐出内存（历史在磁盘，下次消息自动恢复），防长驻内存增长
    await conversations.evictIdle(24 * 60 * 60 * 1000);
    })().catch((error) => logger.error("[DataCleaner] 定期清理失败:", error));
  }, 24 * 60 * 60 * 1000); // 24 小时

  // ---------- 飞书基础通道：Client（所有 API 调用）与 Bot 身份 ----------

  const client = new Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: LoggerLevel.warn, // SDK 自己的 logger 格式与项目不一致；只在异常时出声
  });

  // —— 启动第 1 步：机器人身份（openId）是硬门槛 ——
  // 本机网络（TLS 代理）偶发抖动：自动重试 5 次（间隔 2s），最终失败带真实原因退出
  let botOpenId: string | undefined;
  let botName = "机器人";
  let botInfoDetail = "";
  for (let attempt = 1; attempt <= 5 && !botOpenId; attempt++) {
    try {
      const res = await client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      // SDK 拦截器直接返回响应体；/bot/v3/info 的 bot 字段在顶层（无 data 包裹）
      if (res.code === 0 && res.bot?.open_id) {
        botOpenId = res.bot.open_id;
        botName = typeof res.bot.app_name === "string" && res.bot.app_name.trim() ? res.bot.app_name.trim() : botName;
        logger.info(`[Main] 启动 1/4 机器人身份就绪: ${botOpenId}${attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ""}`);
        break;
      }
      botInfoDetail = `code ${res.code}：${res.msg ?? "未知错误"}`;
    } catch (err) {
      botInfoDetail = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 5) {
      logger.warn(`[Main] 获取机器人 openId 失败（第 ${attempt}/5 次）：${botInfoDetail}，2 秒后重试…`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!botOpenId) {
    throw new Error(
      `启动 1/4 失败：无法获取机器人 openId（/open-apis/bot/v3/info）：${botInfoDetail}。` +
        "请检查网络与应用状态后重启；应用未创建时重新运行会进入扫码开通。",
    );
  }

  // 上电同步 Slash Command。应用未发布对应权限时只告警，不阻断机器人主链路；
  // 运行 `npm run setup` 为已有应用补权限并发布新版本后，下一次启动会自动重试。
  await new SlashCommandRegistrar(client).sync().catch((error) => {
    logger.warn(`[Main] Slash Command 同步失败（请确认应用已开通并发布 application:app_slash_command:* 权限）: ${error instanceof Error ? error.message : String(error)}`);
  });

  // 本人 openId 在用户授权流程装配后解析。
  let ownerOpenId: string | undefined;
  // 用户缓存文件（data/users/{appId}_users.json）：本人登录资料与本人识别共用。
  const usersFile = join(config.dataDir, "users", `${config.feishuAppId}_users.json`);

  // ---------- 多 CLI 凭证库（按 CLI 分文件，data/credentials/ 子目录） ----------

  // userAuth 先声明；运行时回调稍后引用它的当前用户凭证。
  let userAuth: UserAuthService | undefined;

  // onLoginBound 处理器在装配后期才定义；终端登录（启动第 2 步）可能早于装配完成触发，
  // 因此先入队、装配完成后回放，避免 TDZ 崩溃也不丢登录资料
  let handleLoginBoundImpl: typeof handleLoginBound | undefined;
  const pendingLoginBound: Parameters<typeof handleLoginBound>[] = [];

  const credentialsDir = join(config.dataDir, "credentials");
  const vaultKeyFile = join(config.dataDir, ".vault-key");
  // Meegle（飞书项目）静态凭证：Device Flow 授权后 token 加密入库，
  // 会话中的 Meegle CLI 实际启动时才注入（MEEGLE_USER_ACCESS_TOKEN / MEEGLE_HOST）
  const meegleAuth = new StaticCredentialService(
    join(credentialsDir, "meegle.vault.json"),
    vaultKeyFile,
    "meegle",
  );
  // 会话注册表：会话的第一句话就为它建立一个专属目录，jsonl/图片/附件全部在里面；
  // `/new` 换代 = 新会话 id + 新目录，旧目录留在磁盘上等过期清理
  const sessions = new SessionStore(config.sessionsFile, config.sessionsRoot);
  // 用户飞书身份授权（Device Flow，RFC 8628）：按 openId 加密存取 user_access_token；
  // 未登录/失效时由当前用户的 CLI 调用链路自动弹出授权链接。
  // 先于 transport 创建（冷启动本人识别要在 transport 装配前完成）；
  // updateCard/sendCard 闭包后置引用 transport，仅在实际收发卡片时才会执行。
  userAuth = new UserAuthService({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    scopes: config.userAuthScopes,
    vaultFile: join(credentialsDir, "lark.vault.json"),
    vaultKeyFile: vaultKeyFile,
    updateCard: (messageId, card) => transport.updateCardById(messageId, card),
    // 增量授权：能力需要新 scope 时自动把授权卡发到该用户（open_id 口径，投递到与用户的私聊）
    sendCard: (openId, card) => transport.sendCardToUser(openId, card),
    // /login 绑定完成时：本人尚未识别且登录者与本人配置匹配 → 资料入缓存（重启即生效）
    onLoginBound: (info) => {
      if (handleLoginBoundImpl) handleLoginBoundImpl(info);
      else pendingLoginBound.push([info]);
    },
  });

  // Meegle Device Flow 授权：当前用户无凭证时把授权卡发到其私聊，
  // 后台通过 OAuth 接口轮询 → token 加密入库 → 原地更新卡片。
  const meegleDeviceLogin = new MeegleDeviceLogin(
    meegleAuth,
    {
      updateCard: (messageId, card) => transport.updateCardById(messageId, card),
      sendCardToUser: (openId, card) => transport.sendCardToUser(openId, card),
    },
    config.cwd,
  );

  // 存量会话清洗（后台）：用凭证库已知密钥值扫描历史会话 jsonl，命中的明文替换为 ***
  await (async () => {
    const secrets = [...(await userAuth.exportSecretValues()), ...(await meegleAuth.exportSecretValues())];
    const replaced = await scrubSecretsInDir(config.sessionsRoot, secrets);
    if (replaced > 0) logger.info(`[Main] 已清洗历史会话文件中的明文凭证（处理 ${replaced} 个文件）`);
  })().catch((error) => logger.warn("[Main] 会话清洗失败:", error));

  // 本人身份只由机器人应用权限与资料缓存解析，不遍历用户登录凭证。
  ownerOpenId = await resolveOwnerOpenId(client, config.feishuOwner, config.feishuAppId);
  if (ownerOpenId) {
    logger.info(
      config.feishuOwner === ownerOpenId
        ? `[Main] 启动 3/4 本人 Open ID: ${ownerOpenId}`
        : `[Main] 启动 3/4 本人: ${config.feishuOwner} → ${ownerOpenId}`,
    );
  } else if (config.feishuOwner) {
    logger.warn(`[Main] 启动 3/4 本人身份解析失败（FEISHU_PI_OWNER=${config.feishuOwner}），将停止启动`);
  } else {
    logger.warn("[Main] 未配置 FEISHU_PI_OWNER：本人身份未配置");
  }

  if (!ownerOpenId) throw new Error("请配置 FEISHU_PI_OWNER 为本人的飞书 open_id（ou_...）；旧 FEISHU_PI_ADMIN 可作为迁移来源。");

  // ---------- 消息传输 ----------

  // runtime 先声明（transport 的 onModelSwitch 回调引用它）
  let runtime: FeishuPiRuntime;

  // 显式标注类型：初始化闭包与 userAuth 选项互相引用，切断 TS 的循环类型推断
  const transport: LarkTransport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId,
    botName,
    client,
    sessions,
    messages,
    maxResourceBytes: config.maxResourceBytes,
    maxMessageResourceBytes: config.maxMessageResourceBytes,
    audioTranscription: {
      model: config.audioTranscriptionModel,
      baseUrl: config.audioTranscriptionBaseUrl,
      apiKey: config.audioTranscriptionApiKey,
    },

    ownerOpenId,
    searchMentionedUserProfile: createMentionProfileLookup({
      cwd: config.cwd,
      appId: config.feishuAppId,
      ownerOpenId,
      getOwnerToken: (openId) => userAuth?.getUserAccessToken(openId) ?? Promise.resolve(undefined),
    }),
    // /model 切换时通知运行时热切换（持久化到 .env 仍在 transport 内完成）
    onModelSwitch: (name) => {
      config.modelName = name;
      runtime?.setModelName(name);
    },
  });

  /** /login 绑定完成时：① 身份 API 给出的姓名写入用户缓存；② 本人尚未识别且登录者与
   *  FEISHU_PI_OWNER 匹配 → 记录资料，重启后走缓存通道自动识别。 */
  const handleLoginBound = (info: { openId: string; name?: string; en_name?: string; email?: string }): void => {
    void transport
      .seedUserProfile(info.openId, { name: info.name, en_name: info.en_name })
      .catch((error) => logger.warn("[Main] 登录资料写入用户缓存失败:", error));
    const identifier = config.feishuOwner;
    if (!identifier || ownerOpenId) return;
    const matched =
      info.openId === identifier ||
      info.name === identifier ||
      info.en_name === identifier ||
      (Boolean(info.email) && info.email === identifier);
    if (!matched) return;
    logger.info(`[Main] 本人已通过登录识别（${info.name ?? info.openId}），重启服务后本人权限生效`);
  };
  // 处理器就绪：回放装配期间积压的登录事件
  handleLoginBoundImpl = handleLoginBound;
  for (const args of pendingLoginBound.splice(0)) handleLoginBound(...args);

  // ---------- 权限闸门：策略 → 智能体审核 → 本人授权卡 ----------

  const policyFile = join(config.cwd, ".agent", "permissions.json");
  const policy = new PermissionPolicy(policyFile, {
    cwd: config.cwd,
  });
  // bridge 在下方创建，先用闭包引用（授权卡撤回需查询该会话的详细模式开关）
  let bridgeRef: FeishuAgentBridge | undefined;
  const broker = new PermissionBroker({
    ownerOpenId,
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
  }), () => policy.describe(), config.cwd);
  // 单轮工具调用预算：每轮开始清零，超限后阻止继续调用（理由回给模型引导收尾）
  const roundLimiter = createToolCallLimiter(config.roundMaxToolCalls);

  // 授权卡回调 → PermissionBroker 服务端校验（token / 卡片来源 / 本人身份）
  transport.onApproval(async ({ value, action }) => {
    const approvalId = typeof value.approval_id === "string" ? value.approval_id : undefined;
    const token = typeof value.token === "string" ? value.token : undefined;

    const result = await broker.handleCallback({
      approvalId,
      token,
      decision: typeof value.decision === "string" ? value.decision : undefined,
      messageId: action.messageId,
      chatId: action.chatId,
      operatorOpenId: action.operatorOpenId,
    });
    if (result.accepted) {
      logger.info(`[CardAction] 授权: ${result.detail}（点击者 ${formatCardOperator(action)}）`);
    } else {
      logger.warn(`[Main] 授权回调被拒绝: ${result.detail}（点击者 ${formatCardOperator(action)}）`);
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
      logger.info(`[Main] 选项卡已作答: ${outcome.choice}（点击者 ${formatCardOperator(action)}）`);
    } else {
      logger.warn(`[Main] 选项卡点击被忽略（非提问对象或请求已失效，点击者 ${formatCardOperator(action)}）`);
    }
  });



  const dataDir = config.dataDir;

  // 定时任务：持久化（data/schedules.json）+ cron 调度；触发时以创建者身份跑智能体并推送结果卡片
  // 注意：runTask 闭包引用下方才声明的 conversations（前向引用），仅在任务触发（启动完成后）才会执行
  const scheduleService = new ScheduleService({
    storeFile: join(dataDir, "schedules.json"),
    shouldRun: (task) => task.createdBy === ownerOpenId,
    runTask: async (task) => {
      if (task.createdBy !== ownerOpenId) throw new Error("个人助理不执行其他用户的旧定时任务");
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

  const identityOptions = (userId: string, context?: Pick<FeishuContext, "chatId">): IdentityBashOptions => ({
    cwd: config.cwd,
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId,
    botName,
    restrictUserCredentials: !config.allowPersonalUserCli,
    userId,
    chatId: context?.chatId,
    getLarkToken: () => userAuth?.peekUserAccessToken(userId),
    ensureLarkToken: () => userAuth?.getUserAccessToken(userId) ?? Promise.resolve(undefined),
    // lark-cli 用户态命令缺 scope 时：发起增量 Device Flow（授权卡发到当前会话），
    // 同意后 token 自动入库并刷新，重试即生效——用户无需手动 /login
    onMissingScopes: (uid, _chatId, scopes) => {
      void userAuth?.ensureScopes(uid, scopes).catch((error) => {
        logger.warn(`[Main] 增量授权发起失败（${scopes.join(", ")}）:`, error);
      });
      logger.info(`[Main] lark-cli 缺少用户 scope，已发起增量授权: ${scopes.join(", ")}（用户 ${uid}）`);
      return `【补充授权已发起】本次调用缺少用户授权 scope：${scopes.join("、")}。已向你的飞书私聊发送补充授权卡片，请完成授权后重试本命令；授权完成后无需其他操作。`;
    },
    onNotLoggedIn: (uid) => {
      // lark-cli 未登录/凭证失效：自动发起 Device Flow，授权链接卡推送到用户私聊
      void userAuth?.ensureLogin(uid).catch((error) => logger.warn("[Main] lark-cli 登录链接推送失败:", error));
    },
    // Meegle（飞书项目）：/login meegle 授权的静态 token，仅在启动 CLI 时注入；
    // 站点固定为飞书项目（MEEGLE_DEFAULT_HOST）；无凭证时自动发起到该用户私聊的授权
    extraInjections: [
      {
        commandPattern: /^\s*meegle(?:\.exe)?(?:\s|$)/i,
        envToken: "MEEGLE_USER_ACCESS_TOKEN",
        staticEnv: { MEEGLE_HOST: MEEGLE_DEFAULT_HOST },
        getToken: () => {
          const token = meegleAuth.peekToken(userId);
          if (!token) meegleDeviceLogin.beginFor(userId);
          return token;
        },
      },
    ],

  });

  const assistant = new AssistantServices({
    cwd: config.cwd, dataDir: config.dataDir, sessionsRoot: config.sessionsRoot,
    ownerOpenId: ownerOpenId, browserChannel: config.browserChannel,
    openShell: (caller) => openIdentityShell(identityOptions(caller.openId, { chatId: caller.chatId })),
    notifyTask: async (task) => {
      const name = task.name.replace(/[<>`]/g, "");
      const card = markdownCard(`后台任务：${name}\n状态：${task.status}\n任务 ID：${task.id}\n退出码：${task.exitCode ?? "无"}\n使用 background_task 的 log 查看结果。`);
      await transport.sendCardToChat(task.chatId, card);
    },
  });
  const recentChatActivity = new Map<string, number>();
  const biliAutomation = config.biliAutoAvailable ? new BiliAutomation(join(dataDir, "bilibili", "automation.json"), {
    authorize: async (name, args, chatId, signal) => {
      const result = await toolGuard.check(await policy.current(), { toolName: mcpToolName("bilibili", name), args, chatId, requesterOpenId: ownerOpenId }, signal);
      if (result?.block) throw new Error(result.reason);
    },
    call: async (name, args, _chatId, signal) => {
      const result = await assistant.mcp.call("bilibili", name, args, signal);
      if (result.isError) throw new Error("B 站工具调用失败");
      const text = result.content.find(block => block.type === "text");
      if (!text || text.type !== "text") throw new Error("B 站工具未返回文本结果");
      const value: unknown = JSON.parse(text.text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("B 站工具返回格式异常");
      return value as Record<string, unknown>;
    },
    decide: (stage, data, signal) => runtime.biliDecision(stage, data, signal),
    interests: () => runtime.biliInterests(),
    share: config.biliShareAvailable ? (chatId, text) => transport.sendTextToChat(chatId, text) : undefined,
    isChatActive: chatId => Date.now() - (recentChatActivity.get(chatId) ?? 0) < 5 * 60_000,
  }) : undefined;
  await assistant.start();

  // 表情包黑白名单：用户配置优先、模型不可改；检索时按 mtime 热重载，档位只影响工具描述
  const stickerRoot = join(config.dataDir, "stickers");
  const stickerHistory = new StickerHistory(join(config.dataDir, "sticker-history"));
  const stickerRules = createRulesLoader(join(config.cwd, ".agent", "stickers.json"));
  const stickerGuide = (await stickerRules()).guide;

  // 一个使用者、一份个人策略；前端只负责传输与交互。

  // 第二个参数：项目内置交互工具（随会话注册，调用者身份由 runtime 派发时注入）
  runtime = new FeishuPiRuntime({
    cwd: config.cwd,
    sessionsRoot: config.sessionsRoot,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    modelBaseUrl: config.modelBaseUrl,
    thinkingLevel: config.thinkingLevel,
    // 会话目录的唯一事实来源：Pi 会话 jsonl 与图片/附件同在一个会话目录
    sessions,
    permissionPolicy: policy,
    toolGuard: (toolPolicy, params, signal) => toolGuard.check(toolPolicy, params, signal),
    toolCallLimiter: roundLimiter,
    scheduleService,
    // 会话级带身份 bash：在每次 CLI 真正启动时绑定发起人；用户令牌仅在显式启用 FEISHU_PI_USER_CLI 后交给受控 CLI。
    // 普通 shell 命令不接收凭证，未登录时拒绝该次 CLI 并推送授权链接。
    // 用户态命令执行前按需刷新当前发起人的 token，不预热其他用户。
    identityBash: (userId, context) => createIdentityBashTool(identityOptions(userId, context)),
    ownerOpenId: ownerOpenId,
    sessionTools: (caller) => [...assistant.sessionTools(caller), createGuestStickerSearchTool(stickerRoot, { rules: stickerRules, guide: stickerGuide, history: stickerHistory, chatId: caller.chatId }), createStickerSendTool(client, stickerRoot, caller.chatId, { rules: stickerRules, guide: stickerGuide, history: stickerHistory })],
    guestTools: (caller) => [createGuestStickerSearchTool(stickerRoot, { rules: stickerRules, guide: stickerGuide, history: stickerHistory, chatId: caller.chatId }), createStickerSendTool(client, stickerRoot, caller.chatId, { rules: stickerRules, guide: stickerGuide, history: stickerHistory })],
    stickerHistory: async chatId => (await stickerHistory.list(chatId)).slice(0, 5).map(item => `[${new Date(item.at).toISOString()}] ${item.line}`).join("\n"),
    onChatActivity: chatId => { recentChatActivity.set(chatId, Date.now()); },
  }, [
    createAskUserTool(askBroker),
    ...assistant.tools(),
  ]);

  // 上电预加载：权限策略 + Skills + 自定义工具在首条消息前全部就绪
  await runtime.preload();

  // 启动时打印可用的 Skills 和 Tools（本人视角）
  await runtime.printAvailableResources();

  const conversations = new ConversationManager(runtime, sessions, { maxPendingMessages: config.maxPendingMessages, interruptGraceMs: config.interruptGraceMs });

  const bridge = new FeishuAgentBridge(
    conversations,
    transport,
    {
      messages,
      client,
      recordSticker: (chatId, id, line) => stickerHistory.record(chatId, id, line),
      // 待答选项卡优先接收文字回答；每轮开始重置单轮工具调用预算
      answerAskText: (openId, chatId, text) => askBroker.answerText(openId, chatId, text),
      onRoundStart: (chatId) => roundLimiter.reset(chatId),
      // /status 查看用户与 CLI 凭证状态；/logout 清除飞书用户授权
      extraCommands: [
        new BiliAutoCommand(biliAutomation),
        new RestartCommand(() => {
          // 先让 /restart 回执卡发出去，再修改入口文件触发 tsx watch 重启。
          setTimeout(() => {
            const mainFile = join(config.cwd, "src", "main.ts");
            void readFile(mainFile, "utf8")
              .then((content) => {
                const result = toggleTrailingBlankLine(content);
                return writeFile(mainFile, result.content, "utf8").then(() => result);
              })
              .then((result) => logger.info(`[Command] main.ts 末尾空行 ${result.before} → ${result.after}（${result.action}），等待 npm run dev 自动重启`))
              .catch((error) => logger.error("[Command] 触发开发服务重启失败:", error));
          }, 250);
        }),
        new StatusCommand(
          userAuth,
          [
            {
              id: "meegle",
              label: "飞书项目（meegle-cli）",
              ready: (openId) => meegleAuth.peekToken(openId) !== undefined,
            },
          ],
          // 个人身份信息
          async (openId, userName) => {
            return [`个人助理：${userName || openId}`];
          },
        ),
        {
          match: (text) => /^\/login(?:\s+(?:lark|meegle))?$/.test(text.trim()),
          execute: async (message) => {
            if (message.context.chatMode !== "p2p" || !message.text.trim().endsWith("meegle")) {
              return userAuth.startLogin(message);
            }
            meegleDeviceLogin.beginFor(message.context.userOpenId);
            return null;
          },
        },
        new LogoutCommand(userAuth, { meegle: (openId) => meegleAuth.logout(openId) }),
      ],
      // 回复末尾的模型统计小字开关（工具过程状态不受影响）
      showModelStats: config.showModelStats,
      botName,
      botOpenId,
      manageMemory: (context, action, id) => runtime.manageMemory(context, action, id),
      // 已知人员提示：消息里按名字提到的人补 open_id（资料缓存与本人识别共用 data/users 文件）
      peopleRoster: new PeopleRoster(usersFile),
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


  // —— 启动第 4 步：开始工作 ——

  bridge.start();
  await transport.connect();
  // 恢复定时任务调度（任务持久化在 data/schedules.json）
  await scheduleService.start();
  if (biliAutomation) await biliAutomation.start().catch(error => logger.warn(`[BiliAuto] 自动化未启动：${error instanceof Error ? error.message : error}`));

  // 仅在飞书长连接与定时调度均完成后才报告上线，避免“已上线”但服务尚未可用。
  await sendOwnerLifecycleNotice(
    (openId, text) => transport.sendTextToUser(openId, text),
    ownerOpenId,
    config.onlineNotice,
  );

  logger.info("[Main] 启动 4/4 服务开始工作");

  // 优雅退出处理：飞书连接后台断开 + 短宽限后立即退出，不阻塞终端
  let exiting = false;
  const gracefulShutdown = async (signal: string) => {
    if (exiting) return;
    exiting = true;
    logger.info(`[Main] 收到 ${signal} 信号，正在关闭服务...`);

    // 此时连接仍在，先投递下线通知；失败或超时不阻塞后续资源回收。
    await sendOwnerLifecycleNotice(
      (openId, text) => transport.sendTextToUser(openId, text),
      ownerOpenId,
      config.offlineNotice.replaceAll("{signal}", signal),
    );

    clearInterval(cleanupTimer);
    scheduleService.stop();
    await biliAutomation?.stop();
    broker.close();
    await assistant.close();
    await runtime.flushMemory();
    await instanceLock.release();

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

import { getModel } from "@earendil-works/pi-ai/compat";
import "./bootstrap-env.ts"; // 最早执行：.env 缺失自动拷贝（必须在 dotenv 之前）
import "dotenv/config";
import { ConversationManager } from "./runtime/conversation-manager.ts";
import { FeishuPiRuntime } from "./runtime/feishu-pi-runtime.ts";
import { FeishuAgentBridge } from "./feishu/agent-bridge.ts";
import { LarkTransport } from "./feishu/lark-transport.ts";
import { loadConfig } from "./config.ts";
import { ConversationStore } from "./runtime/conversation-store.ts";
import { MessageStore } from "./feishu/message-store.ts";
import { DataCleaner } from "./runtime/data-cleaner.ts";
import { resolveAdminOpenId, persistUserProfile, resolveAdminFromLogins } from "./feishu/admin-resolver.ts";
import { ScheduleService } from "./schedule/service.ts";
import { PermissionPolicy } from "./permission/policy.ts";
import { PermCommand, markdownCard } from "./feishu/commands.ts";
import { LoginCommand, LogoutCommand, UserAuthService } from "./feishu/user-auth.ts";
import { PeopleRoster } from "./feishu/people-roster.ts";
import { createIdentityBashTool } from "./runtime/identity-bash.ts";
import { runSetupWizard } from "./feishu/setup-wizard.ts";
import { createCliSearchUser, resolveLarkCliBinary } from "./feishu/lark-cli-search.ts";
import { delimiter, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import qr from "qrcode-terminal";
import { logger } from "./utils/logger.ts";
import { scrubSecretsInDir } from "./utils/session-scrub.ts";
import { PermissionBroker } from "./guard/broker.ts";
import { ToolGuard } from "./guard/tool-guard.ts";
import { PolicyJudge } from "./guard/judge.ts";
import { buildNoticeCard } from "./guard/card.ts";
import { AskBroker, createAskUserTool } from "./feishu/ask-broker.ts";
import { WorkspaceManager } from "./feishu/workspace.ts";
import { createLocalOcrRunner } from "./feishu/local-ocr.ts";
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

  // 项目内预制 CLI（lark-cli）：把 node_modules/.bin 前插到 PATH，
  // Agent 的 bash 子进程继承后可直接调用，且优先于全局同名命令（npm install 即自带，不依赖全局安装）
  const projectBinDir = join(config.cwd, "node_modules", ".bin");
  process.env.PATH = `${projectBinDir}${delimiter}${process.env.PATH ?? ""}`;

  const messages = new MessageStore(join(config.sessionDir, "messages.json"));

  // 启动时清理过期数据和卡住的消息
  const cleaner = new DataCleaner({
    sessionDir: config.sessionDir,
    imagesDir: join(config.dataDir, "cache", "images"),
    retentionDays: 7,
  });

  // 工作区根目录（work_space/）用同一套保留期清理：会话 jsonl、files 附件、空目录回收
  const workspaceCleaner = new DataCleaner({ sessionDir: config.workspaceRoot, retentionDays: 7 });

  logger.info("[DataCleaner] 清理卡住的消息...");
  const stuckCount = await cleaner.cleanupStuckMessages();
  if (stuckCount > 0) {
    logger.info(`[DataCleaner] 已清理 ${stuckCount} 条卡住的消息`);
  }

  logger.info("[DataCleaner] 清理过期数据（保留 7 天）...");
  await logCleanupStats(cleaner.cleanup());
  await logCleanupStats(workspaceCleaner.cleanup());

  // 定期清理（每天一次）；conversations 在下方声明，回调首次触发时早已初始化
  const cleanupTimer = setInterval(async () => {
    logger.info("[DataCleaner] 执行定期清理...");
    await logCleanupStats(cleaner.cleanup());
    await logCleanupStats(workspaceCleaner.cleanup());
    // 空闲超过 24 小时的会话驱逐出内存（历史在磁盘，下次消息自动恢复），防长驻内存增长
    await conversations.evictIdle(24 * 60 * 60 * 1000);
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

  // —— 启动第 2 步前置：管理员 openId 在第 3 步登录完成后解析 ——
  let adminOpenId: string | undefined;
  // 用户缓存文件（data/users/{appId}_users.json）：资料查询与冷启动管理员识别共用
  const usersFile = join(config.dataDir, "users", `${config.feishuAppId}_users.json`);

  // ---------- 多 CLI 凭证库（按 CLI 分文件，data/credentials/ 子目录） ----------

  // userAuth 先声明（transport 的资料查询/搜索通道闭包引用它的 token；实际实例在其后创建）
  let userAuth: UserAuthService | undefined;

  // onLoginBound 处理器在装配后期才定义；终端登录（启动第 2 步）可能早于装配完成触发，
  // 因此先入队、装配完成后回放，避免 TDZ 崩溃也不丢登录资料
  let handleLoginBoundImpl: typeof handleLoginBound | undefined;
  const pendingLoginBound: Parameters<typeof handleLoginBound>[] = [];

  const credentialsDir = join(config.dataDir, "credentials");
  const vaultKeyFile = join(config.dataDir, ".vault-key");
  // 会话工作区：会话的第一句话就建立专属文件夹，图片/附件等产物全部归拢于此
  const workspace = new WorkspaceManager(config.workspaceRoot);
  // 用户飞书身份授权（Device Flow，RFC 8628）：/login 指令 + 按 openId 加密存取 user_access_token。
  // 先于 transport 创建（冷启动管理员识别要在 transport 装配前完成）；
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
    // /login 绑定完成时：管理员尚未识别且登录者与管理员配置匹配 → 资料入缓存（重启即生效）
    onLoginBound: (info) => {
      if (handleLoginBoundImpl) handleLoginBoundImpl(info);
      else pendingLoginBound.push([info]);
    },
  });

  // 存量会话清洗（后台）：用凭证库已知密钥值扫描历史会话 jsonl，命中的明文替换为 ***
  void (async () => {
    const secrets = [...(await userAuth.exportSecretValues())];
    const replaced = await scrubSecretsInDir(config.sessionDir, secrets);
    if (replaced > 0) logger.info(`[Main] 已清洗历史会话文件中的明文凭证（处理 ${replaced} 个文件）`);
  })().catch((error) => logger.warn("[Main] 会话清洗失败:", error));

  // —— 启动第 2 步：lark-cli 就绪（二进制存在 + 管理员已登录）——
  // 登录指管理员绑定自己的用户身份；其余成员可各自 /login 绑定凭证（运行时身份 bash 用），
  // 启动门槛只看管理员。
  if (!resolveLarkCliBinary(config.cwd)) {
    throw new Error("lark-cli 二进制缺失（node_modules/@larksuite/cli），请重新 npm install 后启动");
  }

  /** 管理员登录态：FEISHU_PI_ADMIN 为 open_id 直接查；否则经用户缓存姓名匹配出 openId 再查；
   *  缓存为空/未命中时回退用凭证库登录记录匹配（否则新环境会误报"尚未登录"）。
   *  返回 active=有效 / expired=已过期 / none=找不到管理员对应的登录。 */
  const adminLoginState = async (): Promise<"active" | "expired" | "none"> => {
    const identifier = config.feishuAdmin;
    if (!identifier) return "none";
    let openId = identifier.startsWith("ou_") ? identifier : undefined;
    if (!openId) {
      try {
        const cache = JSON.parse(await readFile(usersFile, "utf8")) as Record<string, { name?: string; en_name?: string }>;
        openId = Object.entries(cache).find(([, p]) => p.name === identifier || p.en_name === identifier)?.[0];
      } catch {
        openId = undefined; // 缓存不存在/损坏按未匹配处理
      }
    }
    if (!openId) openId = await resolveAdminFromLogins(userAuth, identifier, usersFile).catch(() => undefined);
    if (!openId) return "none";
    return (await userAuth.loginStatus(openId)).state;
  };

  let loginUsers: string[] = [];
  try {
    loginUsers = await userAuth.listLoginUsers();
  } catch {
    loginUsers = []; // 凭证库不可读按未登录处理
  }
  if (loginUsers.length === 0) {
    if (!process.stdout.isTTY) {
      throw new Error("lark 尚未登录，且当前非交互终端无法扫码。请在交互终端启动一次完成管理员授权。");
    }
    console.log("\n🔐 启动 2/4 lark 尚未登录：请用【管理员本人】的飞书扫码完成授权（仅一次机会，失败将自动退出）。\n");
    const login = await userAuth.loginOnTerminal({
      onLink: ({ link, expiresInMin }) => {
        qr.generate(link, { small: true });
        console.log(link, "\n");
        console.log(`⏱️  约 ${expiresInMin} 分钟内有效，等待扫码中…\n`);
      },
    });
    if (!login.ok || !login.identity) {
      throw new Error(`lark 授权未完成（${login.reason ?? "未知原因"}），自动退出。请重新运行 npm start 重试。`);
    }
    logger.info(`[Main] 启动 2/4 lark-cli 就绪：管理员 ${login.identity.name ?? login.identity.openId} 已登录`);
  } else {
    const state = await adminLoginState();
    if (state === "active") {
      logger.info("[Main] 启动 2/4 lark-cli 就绪：管理员已登录");
    } else if (state === "expired") {
      logger.warn("[Main] 启动 2/4 lark-cli 管理员登录已失效，请在聊天中发 /login lark 重新授权");
    } else {
      logger.warn(`[Main] 启动 2/4 lark-cli 管理员（${config.feishuAdmin}）尚未登录，管理员相关能力不可用（可 /login lark 授权）`);
    }
  }

  // —— 启动第 3 步：管理员身份解析（解析不了就当没有管理员，服务照常运行）——
  adminOpenId = await resolveAdminOpenId(client, config.feishuAdmin, config.feishuAppId);
  if (!adminOpenId && config.feishuAdmin) {
    adminOpenId = await resolveAdminFromLogins(userAuth, config.feishuAdmin, usersFile);
  }
  if (adminOpenId) {
    logger.info(
      config.feishuAdmin === adminOpenId
        ? `[Main] 启动 3/4 管理员 Open ID: ${adminOpenId}`
        : `[Main] 启动 3/4 管理员: ${config.feishuAdmin} → ${adminOpenId}`,
    );
  } else if (config.feishuAdmin) {
    logger.warn(`[Main] 启动 3/4 管理员身份解析失败（FEISHU_PI_ADMIN=${config.feishuAdmin}），本次运行当作没有管理员`);
  } else {
    logger.warn("[Main] 未配置 FEISHU_PI_ADMIN：管理员能力不可用");
  }

  // —— 启动第 3.5 步：管理员 lark 未登录/已失效 → 主动把授权链接卡推送到管理员私聊 ——
  // （此前只打日志提示 /login lark，链接不会自己出现；expired 档案先清掉 ensureScopes 才会重新发卡）
  if (adminOpenId) {
    const loginState = (await userAuth.loginStatus(adminOpenId)).state;
    if (loginState !== "active") {
      if (loginState === "expired") await userAuth.logout(adminOpenId);
      void userAuth
        .ensureScopes(adminOpenId, config.userAuthScopes)
        .catch((error) => logger.warn("[Main] 管理员授权链接推送失败:", error));
      logger.info("[Main] 管理员 lark 未登录/已失效，授权链接卡已推送到管理员私聊，点击完成即可");
    }
  }

  // ---------- 消息传输 ----------

  // runtime 先声明（transport 的 onModelSwitch 回调引用它）
  let runtime: FeishuPiRuntime;

  // 显式标注类型：初始化闭包与 userAuth 选项互相引用，切断 TS 的循环类型推断
  const transport: LarkTransport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId,
    client,
    workspace,

    // 本地 OCR 兜底（模型无视觉能力时启用）：下载图片 → tesseract.js 识别 → 文字并入消息
    useExtraOcr: config.useExtraOcr,
    ocrImage: createLocalOcrRunner({ cacheDir: join(config.dataDir, "ocr") }),
    modelHasVision: () => getModel(config.modelProvider as never, config.modelName as never)?.input?.includes("image") === true,
    // 图片下载缓存：纯排查用途（只写不读），放 cache/ 与会话数据分家
    sessionDataDir: config.sessionDir,
    adminOpenId,
    topicRootsFile: join(config.sessionDir, "topic-roots.json"),
    // lark-cli 用户态搜索通道（contact +search-user）：部门信息的主要来源，不依赖需审核权限；
    // 优先用查询目标本人的 token（查自己必然可见），其次管理员的
    searchUserProfile: createCliSearchUser({
      appId: config.feishuAppId,
      cwd: config.cwd,
      tokenCandidates: (target) => [target, adminOpenId],
      peekToken: (openId) => userAuth?.peekUserAccessToken(openId),
    }),
    // /model 切换时通知运行时热切换（持久化到 .env 仍在 transport 内完成）
    onModelSwitch: (name) => runtime?.setModelName(name),
  });

  /** /login 绑定完成时：① 身份 API 给出的姓名是权威资料，直接写入用户缓存
   *  （无需等搜索通道，冷却空档案立即被覆盖）；② 管理员尚未识别且登录者与
   *  FEISHU_PI_ADMIN 匹配 → 记录资料，重启后走缓存通道自动识别。 */
  const handleLoginBound = (info: { openId: string; name?: string; en_name?: string; email?: string }): void => {
    void transport
      .seedUserProfile(info.openId, { name: info.name, en_name: info.en_name })
      .catch((error) => logger.warn("[Main] 登录资料写入用户缓存失败:", error));
    const identifier = config.feishuAdmin;
    if (!identifier || adminOpenId) return;
    const matched =
      info.openId === identifier ||
      info.name === identifier ||
      info.en_name === identifier ||
      (Boolean(info.email) && info.email === identifier);
    if (!matched) return;
    void persistUserProfile(usersFile, info.openId, { name: info.name, en_name: info.en_name })
      .then(() => {
        logger.info(`[Main] 管理员已通过 /login 识别（${info.name ?? info.openId}），资料已入用户缓存——重启服务后管理员权限自动生效，建议现在重启一次`);
      })
      .catch((error) => logger.warn("[Main] 管理员资料写入用户缓存失败:", error));
  };
  // 处理器就绪：回放装配期间积压的登录事件
  handleLoginBoundImpl = handleLoginBound;
  for (const args of pendingLoginBound.splice(0)) handleLoginBound(...args);

  // 后台保鲜：定时把已登录用户（含管理员）的 access token 刷新一遍——
  // 会话 bash 的凭证注入走同步内存缓存，靠这里保证缓存里的 token 始终有效
  const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
  const tokenRefresher = setInterval(() => {
    void userAuth?.refreshAllKnown().catch((error) => {
      logger.warn("[Main] 用户 token 后台保鲜失败:", error);
    });
  }, TOKEN_REFRESH_INTERVAL_MS);
  tokenRefresher.unref?.();

  // ---------- 权限闸门：策略 → 智能体审核 → 管理员授权卡 ----------

  const policyFile = join(config.cwd, ".agent", "permissions.json");
  const policy = new PermissionPolicy(policyFile, {
    adminId: adminOpenId ?? "",
    groupMembership: config.groupMembership,
    usersFile: join(dirname(config.sessionDir), "users", `${config.feishuAppId}_users.json`),
    cwd: config.cwd,
  });
  // bridge 在下方创建，先用闭包引用（授权卡撤回需查询该会话的详细模式开关）
  let bridgeRef: FeishuAgentBridge | undefined;
  const broker = new PermissionBroker({
    adminOpenIds: adminOpenId ? [adminOpenId] : [],
    timeoutMs: config.approvalTimeoutMs,
    sendCard: (chatId, card) => transport.sendCardToChat(chatId, card),
    // 转发授权卡到管理员私聊：open_id 投递（chat_id 通道不认 ou_ 前缀）
    sendCardToUser: (openId, card) => transport.sendCardToUser(openId, card),
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
  }), () => policy.describe());

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
        // 请求确实已失效（服务重启/已处理）才提示失效；转发通道类失败给出真实原因——
        // 此时请求仍有效，管理员仍可在原卡上直接授权
        const stale = result.detail.includes("不存在") || result.detail.includes("已转发过");
        await transport
          .updateCardById(action.messageId, buildNoticeCard(stale ? APPROVAL_STALE_NOTICE : `❌ 转发管理员失败：${result.detail}（请求仍有效，可在原卡直接授权或稍后重试）`))
          .catch(() => {});
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



  const dataDir = dirname(config.sessionDir);

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

  // 两档身份：负责人 = FEISHU_PI_ADMIN，用户 = 其他人；能力全部由策略文件驱动。
  // 第二个参数：项目内置交互工具（随会话注册，调用者身份由 runtime 派发时注入）
  runtime = new FeishuPiRuntime({
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    modelBaseUrl: config.modelBaseUrl,
    thinkingLevel: config.thinkingLevel,
    systemPrompt: config.systemPrompt,
    // Pi 会话 jsonl 落进会话工作区（与图片/附件同在一个文件夹）
    workspaceFor: (conversationId) => workspace.dirFor(conversationId),
    permissionPolicy: policy,
    toolGuard: (groupPolicy, params, signal) => toolGuard.check(groupPolicy, params, signal),
    scheduleService,
    // 会话级带身份 bash：按发起人（含管理员）注入 lark-cli 凭证 env；
    // 同步读内存缓存，未登录时不注入（lark-cli 走默认身份，调用方提示 /login）。
    // 工厂调用即异步预热该用户的内存缓存（快路径命中时零开销），保证首条 bash 前缓存就绪。
    identityBash: (userId, context) => {
      void userAuth?.getUserAccessToken(userId).catch(() => undefined);
      return createIdentityBashTool({
        cwd: config.cwd,
        appId: config.feishuAppId,
        userId,
        chatId: context?.chatId,
        getLarkToken: () => userAuth?.peekUserAccessToken(userId),
        // lark-cli 用户态命令缺 scope 时：发起增量 Device Flow（授权卡发到当前会话），
        // 同意后 token 自动入库并刷新，重试即生效——用户无需手动 /login
        onMissingScopes: (uid, chatId, scopes) => {
          void userAuth?.ensureScopes(uid, scopes).catch((error) => {
            logger.warn(`[Main] 增量授权发起失败（${scopes.join(", ")}）:`, error);
          });
          logger.info(`[Main] lark-cli 缺少用户 scope，已发起增量授权: ${scopes.join(", ")}（用户 ${uid}）`);
          return `【补充授权已发起】本次调用缺少用户授权 scope：${scopes.join("、")}。已向你的飞书私聊发送补充授权卡片，请完成授权后重试本命令；授权完成后无需其他操作。`;
        },

      });
    },
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
      // 预制人员名单：消息里按名字提到的人补 open_id 提示（与权限策略/管理员识别共用 data/users 名单）
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

  // —— 启动第 3 步：团队成员 openId 解析（仅姓名入库；部门在该成员实际互动后经搜索补全）——
  await userAuth.refreshAllKnown().catch((error) => logger.warn("[Main] 用户 token 预热失败:", error));
  const rosterCount = await transport.ingestTeamOpenIds({ botOpenId });
  logger.info(`[Main] 启动 3/4 团队成员名单就绪: ${rosterCount} 人入缓存`);

  // —— 启动第 4 步：开始工作 ——

  bridge.start();
  await transport.connect();
  // 恢复定时任务调度（任务持久化在 data/schedules.json）
  await scheduleService.start();

  logger.info("[Main] 启动 4/4 服务开始工作");

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

/**
 * 配置界面服务器
 * 提供简单的 Web 界面用于修改 .env 配置，以及技能使用统计页面
 */
import express from "express";
import bodyParser from "body-parser";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "./utils/logger.ts";
import { parseEnvFile, stringifyEnv } from "./utils/env-file.ts";
import { isLocalWriteAllowed } from "./utils/request-origin.ts";
import type { SkillUsageStore } from "./stats/skill-usage-store.ts";

const app = express();
const PORT = 3456;
const ENV_FILE = join(process.cwd(), ".env");

// 中间件
app.use(bodyParser.json());

// Host 校验（全局，防 DNS rebinding）：绑定 127.0.0.1 后，攻击者仍可把自己的域名
// 解析到 127.0.0.1——浏览器视角下请求是"同源"，不带 Origin 头，Origin 检查被绕过，
// 而 GET /api/config 会明文返回 App Secret。因此所有请求的 Host 必须是本机主机名。
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
app.use((req, res, next) => {
  const host = (req.get("host") ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0] ?? "";
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    logger.warn(`[ConfigServer] 已拒绝非本机 Host 请求: Host=${host}`);
    res.status(403).send("拒绝非本机请求");
    return;
  }
  next();
});

// 静态资源：表情图片
app.use("/emojis", express.static(join(process.cwd(), "res", "emojis")));

// 配置页面 HTML（独立静态文件，避免与服务器逻辑混杂）
const HTML_PAGE = readFileSync(join(process.cwd(), "src", "config-page.html"), "utf-8");


// 路由：配置页面
app.get("/", (req, res) => {
  res.send(HTML_PAGE);
});

// 路由：获取配置
app.get("/api/config", (req, res) => {
  try {
    const content = readFileSync(ENV_FILE, "utf-8");
    const config = parseEnvFile(content);
    res.json(config);
  } catch (err) {
    res.status(500).send("读取配置失败：" + (err as Error).message);
  }
});

// 路由：保存配置（保留 .env 中本表单不管理的键）
// 写请求防跨源：浏览器里的恶意网页可向本机端口发跨源表单 POST（无 CORS 预检）重写 .env，
// 因此携带 Origin 的写请求必须是本机来源（详见 utils/request-origin.ts）
app.post("/api/config", (req, res) => {
  if (!isLocalWriteAllowed(req.get("origin"))) {
    logger.warn(`[ConfigServer] 已拒绝跨源写请求: Origin=${req.get("origin")}`);
    res.status(403).send("拒绝跨源写请求");
    return;
  }
  try {
    const config = req.body;
    const existing = readFileSync(ENV_FILE, "utf-8");
    writeFileSync(ENV_FILE, stringifyEnv(config, parseEnvFile(existing)), "utf-8");
    res.send("OK");
  } catch (err) {
    res.status(500).send("保存配置失败：" + (err as Error).message);
  }
});

// ==================== 技能使用统计 ====================

// 统计页面 HTML（独立静态文件）
const STATS_PAGE = readFileSync(join(process.cwd(), "src", "stats-page.html"), "utf-8");

/** 注册技能统计路由（main 创建 SkillUsageStore 后调用） */
export function registerSkillStatsRoutes(store: SkillUsageStore): void {
  app.get("/stats", (req, res) => {
    res.send(STATS_PAGE);
  });

  // 返回全部事件 + 展示名映射（英文名 > 中文名 > Open ID），筛选聚合由前端完成
  app.get("/api/stats/events", async (req, res) => {
    try {
      const [events, users] = await Promise.all([store.list(), store.displayNameMap()]);
      res.json({ events, users });
    } catch (err) {
      res.status(500).json({ error: "读取统计数据失败：" + (err as Error).message });
    }
  });
  logger.info("[ConfigServer] 技能统计页面已注册: /stats");
}

// 启动服务器（仅监听本机回环：接口明文返回 App Secret，不能暴露到局域网）
app.listen(PORT, "127.0.0.1", () => {
  logger.log(`配置界面已启动: http://localhost:${PORT}`);
  logger.log(`在浏览器中打开上述地址进行配置`);
});

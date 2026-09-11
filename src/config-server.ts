/**
 * 配置界面服务器
 * 提供简单的 Web 界面用于修改 .env 配置，以及技能使用统计页面
 */
import express from "express";
import bodyParser from "body-parser";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "./utils/logger.ts";
import type { SkillUsageStore } from "./stats/skill-usage-store.ts";

const app = express();
const PORT = 3456;
const ENV_FILE = join(process.cwd(), ".env");

// 中间件
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 静态资源：表情图片
app.use("/emojis", express.static(join(process.cwd(), "res", "emojis")));

/**
 * 解析 .env 文件为对象
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    result[key] = value;
  }
  return result;
}

/** 配置表单管理的 env 键；保存时不在此列表中的现有键会被原样保留 */
const MANAGED_KEYS = new Set([
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ADMIN", "FEISHU_RANDOM_EMOJIS",
  "FEISHU_PI_MODEL_PROVIDER", "FEISHU_PI_MODEL_NAME", "FEISHU_PI_MODEL_BASE_URL",
  "FEISHU_PI_MODEL_API_KEY", "FEISHU_PI_SYSTEM_PROMPT",
]);

/**
 * 将配置对象转换为 .env 格式。
 * existing 中不属于 MANAGED_KEYS 的键（如 FEISHU_GUARD_*、FEISHU_TEAM_MEMBERS 等）原样追加，避免保存表单时丢失。
 */
function stringifyEnv(config: Record<string, string>, existing: Record<string, string> = {}): string {
  const lines: string[] = [];

  // 飞书配置
  lines.push("FEISHU_APP_ID=" + (config.FEISHU_APP_ID || ""));
  lines.push("FEISHU_APP_SECRET=" + (config.FEISHU_APP_SECRET || ""));
  lines.push("FEISHU_ADMIN=" + (config.FEISHU_ADMIN || ""));
  lines.push("");

  // 随机表情配置
  if (config.FEISHU_RANDOM_EMOJIS) {
    lines.push("# 随机表情配置（逗号分隔的 emoji_type）");
    lines.push("FEISHU_RANDOM_EMOJIS=" + config.FEISHU_RANDOM_EMOJIS);
    lines.push("");
  }

  // 模型配置
  lines.push("# 模型配置");
  const provider = config.FEISHU_PI_MODEL_PROVIDER || "anthropic";
  lines.push("FEISHU_PI_MODEL_PROVIDER=" + provider);
  lines.push("FEISHU_PI_MODEL_NAME=" + (config.FEISHU_PI_MODEL_NAME || "claude-sonnet-4-6"));
  lines.push("FEISHU_PI_MODEL_BASE_URL=" + (config.FEISHU_PI_MODEL_BASE_URL || ""));
  lines.push("");

  // API Key
  lines.push("# API Key");
  lines.push("FEISHU_PI_MODEL_API_KEY=" + (config.FEISHU_PI_MODEL_API_KEY || ""));
  lines.push("");

  // 系统提示词
  if (config.FEISHU_PI_SYSTEM_PROMPT) {
    lines.push("# 系统提示词（可选）");
    lines.push("FEISHU_PI_SYSTEM_PROMPT=" + config.FEISHU_PI_SYSTEM_PROMPT);
  }

  return lines.join("\n") + "\n";
}

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
app.post("/api/config", (req, res) => {
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

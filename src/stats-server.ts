/**
 * 统计页面服务器（仅本机回环）：技能使用统计的 Web 展示。
 * 模块加载即监听 127.0.0.1:3456；只读接口，无任何敏感数据。
 */
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "./utils/logger.ts";
import type { SkillUsageStore } from "./stats/skill-usage-store.ts";

const STATS_PAGE = readFileSync(
  fileURLToPath(new URL("./stats-page.html", import.meta.url)),
  "utf-8",
);

const app = express();
const PORT = 3456;

/** 注册统计路由（main 创建 SkillUsageStore 后调用）。 */
export function registerStatsRoutes(store: SkillUsageStore): void {
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
  logger.info("[StatsServer] 统计页面已注册: /stats");
}

// 启动服务器（仅监听本机回环）
app.listen(PORT, "127.0.0.1", () => {
  logger.log(`统计页面已启动: http://localhost:${PORT}/stats`);
});

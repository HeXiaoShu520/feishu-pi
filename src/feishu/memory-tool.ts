/**
 * memory 工具：按用户隔离的长期记忆——一人一份（data/memory/<openId>.md），跨会话保留。
 *
 * 与旧版团队共享 MEMORY.md 的区别：按 openId 各存一份，每个人只能读到自己那份。
 * 身份来自会话创建时注入的 _caller（模型不可见、不可伪造），不依赖文件权限约束。
 * 操作语义：read 全量查看；append 追加一条带时间前缀的要点；rewrite 用整理后的内容整体覆盖。
 * 禁止把密码、令牌等敏感信息写入记忆。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeishuPiTool } from "../runtime/types.ts";

/** 软上限：超过后 read 会提示模型整理（rewrite 覆盖） */
const SOFT_LIMIT_LINES = 200;
const SOFT_LIMIT_BYTES = 64 * 1024;

const stamp = (now = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

export function createMemoryTool(options: { memoryDir: string }): FeishuPiTool {
  const fileFor = (openId: string): string => join(options.memoryDir, `${openId.replace(/[\\/:*?"<>|]/g, "_")}.md`);

  const respond = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

  return {
    name: "memory",
    label: "memory",
    description:
      "长期记忆（个人专属，仅本人可见，跨会话保留）：action=read 查看自己的全部记忆（条目过多时会提示整理）；" +
      "action=append 追加一条要点；action=rewrite 用整理后的内容整体覆盖（去重/合并/清理过时条目）。" +
      "何时使用：用户交代需要长期记住的个人事实、偏好或约定时，用 append 记下；" +
      "当任务可能与既往背景相关时，先 read 回忆，避免重复询问。" +
      "维护：条目重复、过时，或 read 时提示超限时，用 rewrite 用去重合并后的精简版整体覆盖（拒绝空内容）。" +
      "禁止写入密码、令牌等敏感信息。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "append", "rewrite"],
          description: "read=查看全部，append=追加一条，rewrite=用整理后的内容整体覆盖",
        },
        text: { type: "string", description: "append=一条要点；rewrite=整理后的全部记忆（每行一条，保留时间前缀可省略）" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      const record = (typeof params === "object" && params !== null ? params : {}) as {
        action?: string;
        text?: string;
        _caller?: { openId?: string; chatId?: string };
      };
      const openId = record._caller?.openId ?? "";
      if (!openId) {
        return respond("❌ 无法确定调用者身份（_caller 缺失），记忆按用户隔离，拒绝操作");
      }

      const file = fileFor(openId);
      const action = record.action ?? "read";

      if (action === "append") {
        const text = (record.text ?? "").trim().replace(/\n/g, " ");
        if (!text) return respond("没有要记住的内容（text 为空）");
        await mkdir(options.memoryDir, { recursive: true });
        const created = !existsSync(file);
        await writeFile(file, `- ${stamp()} ${text}\n`, { encoding: "utf8", flag: "a" });
        return respond(created ? "已记住。（为你新建了个人记忆）" : "已记住。");
      }

      if (action === "rewrite") {
        const text = (record.text ?? "").trim();
        if (!text) return respond("❌ rewrite 需要整理后的完整内容（text），拒绝清空记忆");
        await mkdir(options.memoryDir, { recursive: true });
        await writeFile(file, `${text}\n`, "utf8");
        return respond("已用整理后的内容覆盖你的记忆。");
      }

      // read
      if (!existsSync(file)) return respond("（你还没有长期记忆：append 记下第一条，或等对话中自然沉淀）");
      const content = await readFile(file, "utf8");
      if (!content.trim()) return respond("（暂无长期记忆）");
      let out = content;
      const size = Buffer.byteLength(content, "utf8");
      const count = content.split("\n").length - 1;
      if (size > SOFT_LIMIT_BYTES || count > SOFT_LIMIT_LINES) {
        out += `\n\n⚠️ 记忆已达 ${count} 行 / ${Math.floor(size / 1024)} KB：请先通读，再去重合并过时条目后，调用 rewrite 用精简版整体覆盖。`;
      }
      return respond(out);
    },
  };
}

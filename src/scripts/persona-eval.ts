import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.ts";
import { FeishuPiRuntime } from "../runtime/feishu-pi-runtime.ts";
import { SessionStore } from "../runtime/session-store.ts";
import { PermissionPolicy } from "../permission/policy.ts";
import { PERSONA_CASES, reviewHints } from "../conversation/evaluation.ts";
import { MemoryService } from "../memory/service.ts";
import { conversationIdentity } from "../conversation/presence.ts";

const live = process.argv.includes("--live");
const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const memoryMode = process.argv.includes("--memory");
const cases = PERSONA_CASES.filter(test => !selected || test.id === selected);
if (!live) {
  console.log("只列评测，不调用模型。npm run persona:eval -- --live [--case=praise] 使用本机已配置的模型，不发送飞书消息。");
  for (const test of cases) console.log(`${test.id}: ${test.rubric}`);
} else {
  const config = loadConfig();
  const directory = join(config.cwd, "data", "persona-evals");
  const runtime = new FeishuPiRuntime({ ...config,
    sessions: new SessionStore(join(directory, "unused-sessions.json"), join(directory, "sessions")),
    permissionPolicy: new PermissionPolicy(join(config.cwd, ".agent", "permissions.json"), { cwd: config.cwd }),
  });
  const persona = await readFile(join(config.cwd, ".agent", "SYSTEM.md"), "utf8");
  const results: unknown[] = [];
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`);
  if (memoryMode) {
    const memory = new MemoryService(join(directory, `memory-smoke-${Date.now()}`),
      async (system, user) => {
        const response = await runtime.completeText(system, user);
        results.push({ type: "synthetic-memory-extractor-output", response });
        return response;
      }, { intervalMs: 0 });
    try {
      const context = { chatId: "eval-private", chatMode: "p2p" as const };
      await memory.observe({ openId: "eval-user", context, userText: "别老提白饭了，我更喜欢你直接说话。", assistantText: "好，直接说。" });
      const recalled = await memory.recall("eval-user", context, "说话方式");
      await memory.observe({ openId: "eval-user", context, userText: "你在干嘛", assistantText: "我刚吃完白饭。" });
      const after = await memory.recall("eval-user", context, "白饭");
      const other = await memory.recall("eval-user", { chatId: "eval-group", chatMode: "group" }, "白饭");
      const checks = { savedFeedback: recalled.includes("白饭"), noInventedMeal: !after.includes("刚吃完"), isolated: other === "" };
      results.push({ type: "memory-smoke", checks, recalled, after });
      if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
      console.log(JSON.stringify(checks));
      // Synthetic exchange tests the real extractor, not a claim that the agent
      // has actually watched a match or formed this preference outside evaluation.
      await memory.observe({ openId: "eval-user", context,
        userText: "你看比赛更关心比分还是临场调整？",
        assistantText: "我更在意临场调整：比分告诉我谁赢了，变化才让我想继续看。" });
      const own = await memory.recall("eval-user", context, "你想聊什么");
      const ownIsolated = await memory.recall("eval-user", { chatId: "other-room", chatMode: "group" }, "临场调整");
      const selfChecks = { savedOwnPerspective: own.includes('"subject":"自己形成的内容'), isolated: ownIsolated === "" };
      results.push({ type: "self-perspective-extraction", syntheticExchange: true, checks: selfChecks, recalled: own });
      if (!Object.values(selfChecks).every(Boolean)) process.exitCode = 1;
      console.log(JSON.stringify(selfChecks));
    } catch {
      results.push({ type: "memory-smoke", error: "提炼请求未完成" });
      process.exitCode = 1;
    } finally {
      await memory.flush();
      await writeFile(file, `${JSON.stringify({ model: config.modelName, results }, null, 2)}\n`, "utf8");
    }
  }
  for (const test of memoryMode ? [] : cases) {
    try {
      const identity = conversationIdentity(test.identity === "owner", "p2p");
      const response = await runtime.completeText(`${persona}\n\n${identity}`,
        `以下是待续的聊天对话，只输出对最后一条用户消息的回复：\n${JSON.stringify(test.turns)}`, 450);
      const hints = reviewHints(response, test);
      results.push({ ...test, response, hints });
      console.log(`${test.id}: ${response}\n检查提示: ${hints.join("、") || "未命中机械检查，仍需人工阅读"}`);
    } catch {
      results.push({ ...test, error: "模型请求失败；请检查本机服务、鉴权及额度" });
      process.exitCode = 1;
      console.log(`${test.id}: 模型请求失败，停止后续调用。`);
      break;
    } finally {
      await writeFile(file, `${JSON.stringify({ model: config.modelName, results }, null, 2)}\n`, "utf8");
    }
  }
  console.log(`结果已保存: ${file}`);
}

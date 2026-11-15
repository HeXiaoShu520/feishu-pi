/** Real model/tool-loop rehearsal; every Feishu upload/send is a local stub. */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import { loadConfig } from "../config.ts";
import { FeishuPiRuntime } from "../runtime/feishu-pi-runtime.ts";
import { SessionStore } from "../runtime/session-store.ts";
import { PermissionPolicy } from "../permission/policy.ts";
import { createGuestStickerSearchTool } from "../stickers/guest-search.ts";
import { createStickerSendTool } from "../stickers/send.ts";
import { searchStickers } from "../stickers/catalog.ts";
import { previewSticker } from "../stickers/preview.ts";
import { VISIBLE_IMAGE_MESSAGE, VISIBLE_STICKER_MESSAGE, UNAVAILABLE_STICKER_MESSAGE } from "../feishu/sticker-message.ts";
import { loadCachedSticker } from "../feishu/sticker-cache.ts";
import type { FeishuPiEvent } from "../runtime/types.ts";

const cases: Array<{ id: string; query: string; text: string; cacheKey?: string; history?: string; rubric?: string }> = [{ id: "challenge", query: "就这", text: VISIBLE_IMAGE_MESSAGE },
  { id: "attack", query: "接招", text: VISIBLE_IMAGE_MESSAGE },
  { id: "unavailable", query: "", text: UNAVAILABLE_STICKER_MESSAGE },
  { id: "queen", query: "", text: VISIBLE_STICKER_MESSAGE,
    cacheKey: "v3_0017e_6e0da509-6174-496d-a336-86009d6af9fg",
    history: '用户：嘿嘿。助手：怎么就嘿嘿两个字。用户接着发来附图。',
    rubric: "接住女王登场的玩笑，不复述标题或讲解王座、服饰，不催用户多说话。" },
  { id: "tease-topic", query: "", text: VISIBLE_STICKER_MESSAGE,
    cacheKey: "v3_0017f_aae6dac2-8e9f-400c-babe-301e944c31eg",
    history: '用户：已经下午五点了，BLG赢了。助手：他们打得怎么样，是哪一把开始翻过来的？用户没有回答，改发附图调侃大肥鱼。',
    rubric: "直接回应对自己的调侃，不转述配字，不追问比赛或强拉回正题。" },
  { id: "explain", query: "", text: "这张表情是什么意思？",
    cacheKey: "v3_0017f_aae6dac2-8e9f-400c-babe-301e944c31eg",
    rubric: "用户明确问含义时能正常解释，不把所有图片问题强制变为玩笑。" }];
if (!process.argv.includes("--live")) {
  console.log("npm run stickers:eval -- --live [--case=challenge|attack|unavailable|queen|tease-topic|explain]，使用本机模型与真实图库，飞书发送完全模拟。");
} else {
  const config = loadConfig();
  const run = randomUUID();
  const directory = join(config.dataDir, "sticker-evals", run);
  const root = join(config.cwd, "stickers");
  await mkdir(directory, { recursive: true });
  const sessions = new SessionStore(join(directory, "sessions.json"), join(directory, "sessions"));
  const client = { im: { v1: {
    image: { create: async () => ({ image_key: "eval_image" }) },
    message: { create: async () => ({ code: 0, data: { message_id: "eval_sent" } }) },
  } } } as unknown as Client;
  const runtime = new FeishuPiRuntime({ ...config, ownerOpenId: "ou_eval_owner", sessions,
    permissionPolicy: new PermissionPolicy(join(config.cwd, ".agent", "permissions.json")),
    // Evaluation-only gate: these tools read the library and send exclusively
    // through the local client stub. Production permissions remain untouched.
    toolGuard: async (_policy, request) => ["sticker_search", "sticker_send"].includes(request.toolName)
      ? undefined : { block: true, reason: "评测只允许本地模拟的表情工具" },
    guestTools: () => [createGuestStickerSearchTool(root), createStickerSendTool(client, root, "oc_eval")],
  });
  const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
  if (selected && !cases.some(test => test.id === selected)) throw new Error("未知评测场景");
  for (const test of cases.filter(test => !selected || test.id === selected)) {
    const events: unknown[] = [];
    let answer = "";
    let tools = 0;
    const context = { userOpenId: "ou_eval_friend", chatId: `oc_eval_${test.id}`, chatMode: "p2p" as const,
      conversationId: `p2p-eval-${test.id}` };
    const session = await runtime.createSession(undefined, context.userOpenId, context);
    const unsubscribe = session.subscribe((event: FeishuPiEvent) => {
      if (event.type === "assistant_text") answer = event.text;
      if (event.type === "tool_started") {
        events.push({ type: event.type, tool: event.toolName, args: event.args });
        if (++tools > 12) session.abort();
      }
      if (event.type === "tool_finished") events.push({ type: event.type, tool: event.toolName, error: event.isError });
    });
    const timer = setTimeout(() => session.abort(), 90_000);
    try {
      let image;
      let incoming;
      if (test.cacheKey) {
        image = await loadCachedSticker(process.env.FEISHU_PI_STICKER_CACHE_DIR, test.cacheKey, join(directory, test.id, "images"), config.maxResourceBytes);
        if (!image) throw new Error("评测所需本机缓存图片未找到");
      }
      if (test.query) {
        incoming = (await searchStickers(root, test.query, { limit: 1, shuffle: false }))[0];
        if (!incoming) throw new Error("图库缺少评测图片");
        const preview = await previewSticker(root, incoming.path);
        image = { data: new Uint8Array(Buffer.from(preview.data, "base64")), mimeType: preview.mimeType };
      }
      await session.prompt({ text: `${test.history ? `[评测提供的此前对话]\n${test.history}\n[当前发言]\n` : ""}朋友: ${test.text}`, memoryText: test.text, images: image ? [image] : undefined });
      const report = { model: config.modelName, scenario: test.id, incoming: incoming ? {
        id: incoming.id, text: incoming.note?.text, meaning: incoming.note?.meaning,
      } : { visible: !!image, cacheKey: test.cacheKey }, events, answer, simulatedFeishu: true,
        rubric: test.rubric, reviewHints: [
          ...(test.id !== "explain" && /这张图|图里|画面|配字|说的是|图上|构图|尾巴画/u.test(answer) ? ["可能仍在解说图片，需人工检查"] : []),
          ...(test.id === "tease-topic" && /说回正题|还没.{0,5}告诉|哪一把|怎么赢|打得怎么样/u.test(answer) ? ["可能仍在追问旧话题"] : []),
        ] };
      await writeFile(join(directory, `${test.id}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify(report));
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }
  console.log(`评测报告：${directory}`);
}

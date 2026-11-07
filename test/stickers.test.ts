import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pickSticker, searchStickers, stickerLine } from "../src/stickers/search.ts";
import { recentSent, recordSent, sentPenalty, StickerHistory } from "../src/stickers/recent.ts";
import { EMPTY_RULES, type StickerRules } from "../src/stickers/rules.ts";
import { createGuestStickerSearchTool } from "../src/stickers/guest-search.ts";
import { createStickerSendTool } from "../src/stickers/send.ts";
import type { Client } from "@larksuiteoapi/node-sdk";

const GIF = "GIF89a";

function rules(patch: Partial<StickerRules> = {}): StickerRules {
  return { ...EMPTY_RULES, ...patch };
}

describe("sticker search", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sticker-search-"));
    for (const dir of ["nekowhale/大肥鱼", "nekowhale/大肥鱼和GPT娘", "clawd/gif", "whale-girl/gifs", "bluefish", "emotelab", "dsh-pet/anim", "dsh-pet/memes"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, "nekowhale/metadata.json"), JSON.stringify({
      stickers: [
        { id: "大肥鱼/10N01_开心猫", emotion: "开心", tags: ["庆祝", "摸鱼"], use: "祝贺好事时", desc: "笑着举手", text: "", meme: "", en: "", dir: "" },
        { id: "大肥鱼/10N02_摸鱼", emotion: "疲惫", tags: ["摸鱼", "上班"], use: "想偷懒时", desc: "趴在桌上", text: "", meme: "", en: "", dir: "" },
        { id: "大肥鱼和GPT娘/2TT01_喂药", emotion: "搞怪", tags: ["吃药", "催吃药"], use: "催人吃药时", desc: "大肥鱼给GPT娘喂药", text: "", meme: "大郎该吃药了", en: "", dir: "大肥鱼→GPT娘" },
        { id: "大肥鱼/10N03_仅描述", emotion: "其他", tags: [], desc: "开心", text: "", meme: "", en: "", use: "", dir: "" },
      ],
    }));
    await writeFile(join(root, "clawd/metadata.json"), JSON.stringify({
      stickers: [{ id: "passed", name: "测试通过", description: "开心庆祝", english: "celebrate", light: "gif/passed.gif" }],
    }));
    await writeFile(join(root, "whale-girl/metadata.json"), JSON.stringify({ stickers: [] }));
    await writeFile(join(root, "bluefish/metadata.json"), JSON.stringify({
      stickers: [{ id: 1, file: "laugh.png", mood: "开心", subject: "蓝发鱼娘在笑", tags: ["笑"] }],
    }));
    await writeFile(join(root, "emotelab/metadata.json"), JSON.stringify({
      stickers: [{ id: 1, file: "001.gif", name: "Bug" }],
    }));
    await writeFile(join(root, "dsh-pet/metadata.json"), JSON.stringify({
      stickers: [
        { id: "anim/chi-xigua", file: "anim/chi-xigua.gif", name: "吃西瓜", code: "chi-xigua", group: "吃什么", tags: ["吃什么", "吃西瓜"], use: "", desc: "抱着半只西瓜用勺子挖着吃", en: "chi-xigua" },
        { id: "meme/吃白饭的大肥鱼", file: "memes/吃白饭的大肥鱼.png", name: "吃白饭的大肥鱼", code: "吃白饭的大肥鱼", group: "表情包", emotion: "疲惫", tags: ["偷懒"], use: "适合被吐槽/偷懒", desc: "躺平扒白饭", en: "" },
      ],
    }));
    for (const file of ["nekowhale/大肥鱼/10N01_开心猫.gif", "nekowhale/大肥鱼/10N02_摸鱼.gif", "nekowhale/大肥鱼和GPT娘/2TT01_喂药.gif", "clawd/gif/passed.gif", "bluefish/laugh.png", "emotelab/001.gif", "dsh-pet/anim/chi-xigua.gif", "dsh-pet/memes/吃白饭的大肥鱼.png"]) {
      await writeFile(join(root, file), GIF);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (outside) await rm(outside, { force: true });
    outside = "";
  });

  it("字段权重：name 命中排在仅 desc 命中之前", async () => {
    const ids = (await searchStickers(root, "开心", { shuffle: false })).map((item) => item.id);
    expect(ids.indexOf("nekowhale:大肥鱼/10N01_开心猫")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("nekowhale:大肥鱼/10N01_开心猫")).toBeLessThan(ids.indexOf("clawd:passed"));
  });

  it("CJK bigram 回退：长句能找到短标签", async () => {
    const a = (await searchStickers(root, "想摸鱼", { shuffle: false })).map((item) => item.id);
    expect(a).toContain("nekowhale:大肥鱼/10N02_摸鱼");
    const b = (await searchStickers(root, "上班不想动", { shuffle: false })).map((item) => item.id);
    expect(b).toContain("nekowhale:大肥鱼/10N02_摸鱼");
  });

  it("多词覆盖率：每个词都沾边的排在单词强命中之前", async () => {
    const first = (await searchStickers(root, "开心 摸鱼", { shuffle: false }))[0];
    expect(first?.id).toBe("nekowhale:大肥鱼/10N01_开心猫");
  });

  it("近分抖动可关闭，也可注入固定随机源", async () => {
    const a = (await searchStickers(root, "开心", { shuffle: false })).map((item) => item.id);
    const b = (await searchStickers(root, "开心", { shuffle: false })).map((item) => item.id);
    expect(a).toEqual(b);
    const fixed = (await searchStickers(root, "开心", { shuffle: true, random: () => 0 })).map((item) => item.id);
    expect(fixed).toEqual(a);
  });

  it("黑白名单：前缀规则与精确名都能剔除，白名单非空时只保留命中", async () => {
    const tagged = (await searchStickers(root, "开心", { shuffle: false, rules: rules({ blacklist: ["tag:庆祝"] }) })).map((item) => item.id);
    expect(tagged).not.toContain("nekowhale:大肥鱼/10N01_开心猫");

    const emotion = (await searchStickers(root, "摸鱼", { shuffle: false, rules: rules({ blacklist: ["emotion:疲惫"] }) })).map((item) => item.id);
    expect(emotion).not.toContain("nekowhale:大肥鱼/10N02_摸鱼");

    const pack = (await searchStickers(root, "开心", { shuffle: false, rules: rules({ blacklist: ["pack:clawd"] }) })).map((item) => item.id);
    expect(pack).not.toContain("clawd:passed");

    const exact = (await searchStickers(root, "摸鱼", { shuffle: false, rules: rules({ blacklist: ["10N02_摸鱼"] }) })).map((item) => item.id);
    expect(exact).not.toContain("nekowhale:大肥鱼/10N02_摸鱼");

    const only = (await searchStickers(root, "", { shuffle: false, rules: rules({ whitelist: ["pack:clawd"] }) })).map((item) => item.id);
    expect(only).toEqual(["clawd:passed"]);
  });

  it("情绪词直取：精确名字优先，否则在该情绪下随机取一张", async () => {
    expect((await pickSticker(root, "喂药"))?.id).toBe("nekowhale:大肥鱼和GPT娘/2TT01_喂药");
    expect((await pickSticker(root, "2TT01_喂药"))?.id).toBe("nekowhale:大肥鱼和GPT娘/2TT01_喂药");
    expect((await pickSticker(root, "开心"))?.emotion).toBe("开心");
    expect(await pickSticker(root, "嘲讽")).toBeUndefined();
  });

  it("摘要行：四条字段用全角竖线分隔，双人表情带方向", async () => {
    const item = (await searchStickers(root, "喂药", { shuffle: false }))[0];
    expect(item).toBeDefined();
    const line = stickerLine(item!);
    expect(line.split("｜")).toEqual(["喂药", "搞怪", "吃药/催吃药", "大肥鱼→GPT娘"]);
  });

  it("安全回归：pack 过滤、缺失文件跳过、越界路径跳过", async () => {
    const onlyClawd = (await searchStickers(root, "庆祝", { pack: "clawd", shuffle: false })).map((item) => item.id);
    expect(onlyClawd).toEqual(["clawd:passed"]);

    const missing = (await searchStickers(root, "仅描述", { shuffle: false })).map((item) => item.id);
    expect(missing).not.toContain("nekowhale:大肥鱼/10N03_仅描述");

    outside = join(tmpdir(), `sticker-outside-${process.pid}-${Date.now()}.gif`);
    await writeFile(outside, GIF);
    await writeFile(join(root, "bluefish/metadata.json"), JSON.stringify({
      stickers: [{ id: 1, file: `../../${basename(outside)}`, mood: "开心", subject: "越界", tags: [] }],
    }));
    const escaped = (await searchStickers(root, "开心", { shuffle: false })).map((item) => item.id);
    expect(escaped).not.toContain("bluefish:1");
  });

  it("单个包 metadata 损坏只降级该包，其余包照常检索", async () => {
    await writeFile(join(root, "clawd/metadata.json"), "{ 坏掉的 JSON");
    const ids = (await searchStickers(root, "庆祝", { shuffle: false })).map((item) => item.id);
    expect(ids).not.toContain("clawd:passed");
    expect(ids).toContain("nekowhale:大肥鱼/10N01_开心猫");
    expect((await searchStickers(root, "西瓜", { pack: "dsh-pet", shuffle: false })).map((item) => item.id)).toEqual(["dsh-pet:anim/chi-xigua"]);
  });

  it("最近发送过的自动降权；空查询 shuffle 关闭时保持 id 序稳定", async () => {
    const before = (await searchStickers(root, "吃", { pack: "dsh-pet", shuffle: false })).map((item) => item.id);
    expect(before).toEqual(["dsh-pet:anim/chi-xigua", "dsh-pet:meme/吃白饭的大肥鱼"]);

    recordSent("dsh-pet:anim/chi-xigua");
    const after = (await searchStickers(root, "吃", { pack: "dsh-pet", shuffle: false, downweight: recentSent() })).map((item) => item.id);
    expect(after[0]).toBe("dsh-pet:meme/吃白饭的大肥鱼");

    // 空查询 + shuffle 关闭 = 确定性 id 序（随机浏览的随机性只在默认开启时生效）
    const stable = (await searchStickers(root, "", { shuffle: false, limit: 20 })).map((item) => item.id);
    expect(stable).toEqual([...stable].sort((a, b) => a.localeCompare(b, "zh-CN")));
  });

  it("情绪随机直取也避开最近发过的；点名重发不受影响", async () => {
    // emotion=开心 的候选序是 [10N01_开心猫, bluefish:1]；random=0 取第一个
    const picked = await pickSticker(root, "开心", { rules: EMPTY_RULES, random: () => 0 });
    expect(picked?.id).toBe("nekowhale:大肥鱼/10N01_开心猫");

    // 发过候选首位后，随机直取跳到下一位
    recordSent("nekowhale:大肥鱼/10N01_开心猫");
    const next = await pickSticker(root, "开心", { rules: EMPTY_RULES, random: () => 0 });
    expect(next?.id).toBe("bluefish:1");

    // 全发过才回退全池
    recordSent("bluefish:1");
    const fallback = await pickSticker(root, "开心", { rules: EMPTY_RULES, random: () => 0 });
    expect(fallback?.id).toBe("nekowhale:大肥鱼/10N01_开心猫");

    // 点名重发走 exact 分支，不受降权影响
    const exact = await pickSticker(root, "nekowhale:大肥鱼/10N01_开心猫", { rules: EMPTY_RULES });
    expect(exact?.id).toBe("nekowhale:大肥鱼/10N01_开心猫");
  });

  it("招牌同名条目（name === emotion）不劫持情绪随机", async () => {
    const lib = await mkdtemp(join(tmpdir(), "sticker-sign-"));
    try {
      await mkdir(join(lib, "nekowhale", "大肥鱼"), { recursive: true });
      await writeFile(join(lib, "nekowhale/metadata.json"), JSON.stringify({
        stickers: [
          { id: "大肥鱼/S1_思考", emotion: "思考", tags: [], desc: "", text: "", meme: "", en: "", use: "", dir: "" },
          { id: "大肥鱼/S2_发呆", emotion: "思考", tags: [], desc: "", text: "", meme: "", en: "", use: "", dir: "" },
        ],
      }));
      await writeFile(join(lib, "nekowhale", "大肥鱼", "S1_思考.gif"), GIF);
      await writeFile(join(lib, "nekowhale", "大肥鱼", "S2_发呆.gif"), GIF);

      // S1 的 name 就是「思考」：若被 exact 劫持，无论怎么发都永远是它
      const first = await pickSticker(lib, "思考", { random: () => 0 });
      expect(first?.id).toBe("nekowhale:大肥鱼/S1_思考");
      recordSent("nekowhale:大肥鱼/S1_思考");
      const next = await pickSticker(lib, "思考", { random: () => 0 });
      expect(next?.id).toBe("nekowhale:大肥鱼/S2_发呆");
    } finally {
      await rm(lib, { recursive: true, force: true });
    }
  });

  it("默认嵌入卡片：只上传返回 markdown 片段，不独立发图；standalone 才独立发送", async () => {
    const upload = vi.fn(async () => ({ image_key: "img_key_1" }));
    let messageResult: unknown = { code: 0, data: { message_id: "om_x1" } };
    const send = vi.fn(async () => messageResult);
    const client = { im: { v1: { image: { create: upload }, message: { create: send } } } } as unknown as Client;
    const history = new StickerHistory(join(root, "history"));
    const tool = createStickerSendTool(client, root, "oc_chat1", { rules: async () => EMPTY_RULES, history });

    // 默认只上传，尚未获得卡片发送回执，不能记为已发送。
    const ok = await tool.execute("t", { id: "nekowhale:大肥鱼和GPT娘/2TT01_喂药" }, undefined);
    const parsed = JSON.parse((ok.content[0] as { text: string }).text) as { embedded: boolean; imageKey: string; markdown: string; line: string };
    expect(parsed.embedded).toBe(true);
    expect(parsed.imageKey).toBe("img_key_1");
    expect(parsed.markdown).toContain("](img_key_1)");
    expect(parsed.markdown.startsWith("![")).toBe(true);
    expect(parsed.line).toContain("喂药");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(recentSent()).not.toContain("nekowhale:大肥鱼和GPT娘/2TT01_喂药");
    expect(await history.list("oc_chat1")).toEqual([]);
    expect(parsed).toMatchObject({ sent: false, status: "uploaded_pending_card", meaning: { description: "大肥鱼给GPT娘喂药", direction: "大肥鱼→GPT娘", source: "catalog_metadata" } });

    // standalone：独立图片消息路径
    const solo = await tool.execute("t", { id: "clawd:passed", standalone: true }, undefined);
    const soloParsed = JSON.parse((solo.content[0] as { text: string }).text) as { sent: boolean; messageId: string };
    expect(soloParsed.sent).toBe(true);
    expect(soloParsed.messageId).toBe("om_x1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(recentSent()).toContain("clawd:passed");
    expect((await history.list("oc_chat1")).map(item => item.id)).toEqual(["clawd:passed"]);

    // standalone 发送失败（飞书返回非零 code）不得进入最近记录，否则失败图也被降权
    messageResult = { code: 99991, msg: "boom" };
    await expect(tool.execute("t", { id: "nekowhale:大肥鱼/10N02_摸鱼", standalone: true }, undefined)).rejects.toThrow("飞书图片发送失败");
    expect(recentSent()).not.toContain("nekowhale:大肥鱼/10N02_摸鱼");
    expect((await history.list("oc_chat1")).map(item => item.id)).toEqual(["clawd:passed"]);
  });

  it("持久历史达到 30 条时，防重复权重不会给旧图片加分", () => {
    const order = Array.from({ length: 30 }, (_, i) => `sticker:${i}`);
    expect(sentPenalty(order[0]!, order)).toBe(0.3);
    expect(sentPenalty(order[29]!, order)).toBe(1);
    expect(order.every(id => sentPenalty(id, order) <= 1)).toBe(true);
    expect(sentPenalty("unseen", order)).toBe(1);
  });

  it("扩展包 dsh-pet：通用字段解析、pack 与 group 规则、code 直取", async () => {
    const hits = await searchStickers(root, "西瓜", { pack: "dsh-pet", shuffle: false });
    expect(hits.map((item) => item.id)).toEqual(["dsh-pet:anim/chi-xigua"]);
    expect(hits[0]?.group).toBe("吃什么");
    expect(stickerLine(hits[0]!)).toBe("吃西瓜｜吃什么/吃西瓜");

    expect((await pickSticker(root, "chi-xigua"))?.id).toBe("dsh-pet:anim/chi-xigua");
    expect((await pickSticker(root, "吃白饭的大肥鱼"))?.id).toBe("dsh-pet:meme/吃白饭的大肥鱼");

    const grouped = (await searchStickers(root, "", { shuffle: false, rules: rules({ blacklist: ["group:吃什么"] }) })).map((item) => item.id);
    expect(grouped).not.toContain("dsh-pet:anim/chi-xigua");

    const packed = (await searchStickers(root, "", { shuffle: false, rules: rules({ whitelist: ["pack:dsh-pet"] }) })).map((item) => item.id);
    expect(packed).toEqual(["dsh-pet:anim/chi-xigua", "dsh-pet:meme/吃白饭的大肥鱼"]);

    // emotion 字段透传后，情绪过滤也能选中扩展包
    const tired = (await searchStickers(root, "", { emotion: "疲惫", shuffle: false })).map((item) => item.id);
    expect(tired).toContain("dsh-pet:meme/吃白饭的大肥鱼");
  });

  it("搜索空结果时返回可操作的 hint 而不是空数组", async () => {
    const tool = createGuestStickerSearchTool(root);
    const result = await tool.execute("t", { query: "", pack: "dsh-pet", emotion: "开心" }, undefined);
    const block = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(block.text) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(String(parsed[0].hint)).toContain("没有命中");
  });

  it("访客搜索结果只含 id / line / use / desc，不含本地路径", async () => {
    const tool = createGuestStickerSearchTool(root);
    const result = await tool.execute("t", { query: "庆祝", pack: "clawd" }, undefined);
    const block = result.content[0] as { type: string; text: string };
    expect(block.type).toBe("text");
    const parsed = JSON.parse(block.text) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe("clawd:passed");
    expect(parsed[0].line).toBe("测试通过");
    expect(parsed[0].desc).toBe("开心庆祝");
    expect(Object.keys(parsed[0]).sort()).toEqual(["desc", "id", "line"]);
  });

  it("dsh-pet 的画面摘要透传给模型，选图不用猜", async () => {
    const tool = createGuestStickerSearchTool(root);
    const result = await tool.execute("t", { query: "西瓜", pack: "dsh-pet" }, undefined);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Array<Record<string, unknown>>;
    expect(String(parsed[0].desc)).toContain("抱着半只西瓜");
  });

  it("场景选出对应动作，保留聊天去重和黑名单", async () => {
    await writeFile(join(root, "dsh-pet/metadata.json"), JSON.stringify({ stickers: [
      { id: "anim/gongzuozhuangtai-queyue-qingzhu", file: "anim/a.gif", name: "雀跃庆祝", tags: ["成功"] },
      { id: "anim/dianji-huiying-kaixin-yuedong", file: "anim/b.gif", name: "开心跃动", tags: ["开心"] },
      { id: "anim/gongzuozhuangtai-chuitou-tanqi-maohan", file: "anim/c.gif", name: "垂头叹气", tags: ["失败"] },
    ] }));
    for (const file of ["a.gif", "b.gif", "c.gif"]) await writeFile(join(root, "dsh-pet/anim", file), GIF);
    const success = await searchStickers(root, "", { scene: "success", shuffle: false, downweight: ["dsh-pet:anim/gongzuozhuangtai-queyue-qingzhu"] });
    expect(success.map(item => item.name)).toEqual(["开心跃动", "雀跃庆祝"]);
    const failure = await searchStickers(root, "", { scene: "failure", shuffle: false });
    expect(failure.map(item => item.name)).toEqual(["垂头叹气"]);
    const blocked = await searchStickers(root, "", { scene: "failure", rules: rules({ blacklist: ["pack:dsh-pet"] }) });
    expect(blocked).toEqual([]);
    const result = await createGuestStickerSearchTool(root).execute("t", { scene: "failure" }, undefined);
    expect(JSON.stringify(result)).toContain("垂头叹气");
  });

  it("limit 越界被钳到 [1, 20]，全库也不会塞爆上下文", async () => {
    const big = await mkdtemp(join(tmpdir(), "stickers-limit-"));
    try {
      await mkdir(join(big, "clawd"), { recursive: true });
      // clawd 包的条目格式是 id + light（light 直接相对包目录）
      const stickers = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, light: `c${i}.gif`, name: `表情${i}` }));
      await writeFile(join(big, "clawd/metadata.json"), JSON.stringify({ stickers }));
      for (const sticker of stickers) await writeFile(join(big, "clawd", sticker.light), GIF);
      const tool = createGuestStickerSearchTool(big);
      const many = await tool.execute("t", { query: "表情", limit: 9999 }, undefined);
      expect((JSON.parse((many.content[0] as { text: string }).text) as unknown[]).length).toBe(20);
      const one = await tool.execute("t", { query: "表情0", limit: 0.5 }, undefined);
      expect((JSON.parse((one.content[0] as { text: string }).text) as unknown[]).length).toBe(1);
    } finally {
      await rm(big, { recursive: true, force: true });
    }
  });
});

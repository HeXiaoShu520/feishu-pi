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
import { createHash } from "node:crypto";

const GIF = "GIF89a";

function rules(patch: Partial<StickerRules> = {}): StickerRules {
  return { ...EMPTY_RULES, ...patch };
}

describe("sticker search", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sticker-search-"));
    for (const dir of ["nekowhale/大肥鱼", "nekowhale/大肥鱼和GPT娘", "clawd/gif", "whale-girl/gifs", "bluefish", "emotelab", "dsh-pet/anim", "dsh-pet/memes", "chinese-bqb/010Cat_是喵星人啦BQB", "chinese-bqb/000Contribution_贡献BQB", "chinese-bqb/035TomAndJerry_猫和老鼠BQB", "emoji-package/搬砖"]) {
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
    // 中文热梗扩展包（入库脚本派生字段）：与 dsh-pet 同款全字段结构
    await writeFile(join(root, "chinese-bqb/metadata.json"), JSON.stringify({
      stickers: [
        { id: "010/0001", kind: "meme", file: "010Cat_是喵星人啦BQB/是喵星人啦00001-上班偷懒猫.gif", name: "上班偷懒猫", code: "上班偷懒猫", group: "是喵星人啦", tags: [], use: "", desc: "上班偷懒猫", en: "", emotion: "" },
        { id: "000/7889", kind: "meme", file: "000Contribution_贡献BQB/2c7889dbe9efbf7145d3ef669b11d22d.gif", name: "2c7889dbe9efbf7145d3ef669b11d22d", code: "2c7889dbe9efbf7145d3ef669b11d22d", group: "贡献", tags: [], use: "", desc: "2c7889dbe9efbf7145d3ef669b11d22d", en: "", emotion: "" },
        // 内置内容安全用例：露骨性内容不应出现在任何候选里
        { id: "035/0001", kind: "meme", file: "035TomAndJerry_猫和老鼠BQB/我要操你五次.jpg", name: "我要操你五次", code: "我要操你五次", group: "猫和老鼠", tags: [], use: "", desc: "粉色手掌", en: "", emotion: "" },
      ],
    }));
    await writeFile(join(root, "emoji-package/metadata.json"), JSON.stringify({
      stickers: [
        { id: "搬砖/今天工地好热，砖头烫手", kind: "meme", file: "搬砖/今天工地好热，砖头烫手.jpg", name: "今天工地好热，砖头烫手", code: "今天工地好热，砖头烫手", group: "搬砖", tags: [], use: "", desc: "今天工地好热，砖头烫手", en: "", emotion: "" },
        { id: "搬砖/搬砖使我快乐", kind: "meme", file: "搬砖/搬砖使我快乐.jpg", name: "搬砖使我快乐", code: "搬砖使我快乐", group: "搬砖", tags: [], use: "", desc: "搬砖使我快乐", en: "", emotion: "" },
      ],
    }));
    for (const file of ["nekowhale/大肥鱼/10N01_开心猫.gif", "nekowhale/大肥鱼/10N02_摸鱼.gif", "nekowhale/大肥鱼和GPT娘/2TT01_喂药.gif", "clawd/gif/passed.gif", "bluefish/laugh.png", "emotelab/001.gif", "dsh-pet/anim/chi-xigua.gif", "dsh-pet/memes/吃白饭的大肥鱼.png", "chinese-bqb/010Cat_是喵星人啦BQB/是喵星人啦00001-上班偷懒猫.gif", "chinese-bqb/000Contribution_贡献BQB/2c7889dbe9efbf7145d3ef669b11d22d.gif", "chinese-bqb/035TomAndJerry_猫和老鼠BQB/我要操你五次.jpg", "emoji-package/搬砖/今天工地好热，砖头烫手.jpg", "emoji-package/搬砖/搬砖使我快乐.jpg"]) {
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

  it("内置内容安全：色情/辱骂表情不进检索与发送候选，白名单也救不回来", async () => {
    const all = (await searchStickers(root, "", { shuffle: false })).map((item) => item.id);
    expect(all).not.toContain("chinese-bqb:035/0001");
    // 直接点名也取不到
    expect(await pickSticker(root, "我要操你五次", { rules: rules() })).toBeUndefined();
    // 白名单明确放行也不能拉回来（代码兜底优先于用户名单）
    const whitelisted = (await searchStickers(root, "", { shuffle: false, rules: rules({ whitelist: ["code:我要操你五次"] }) })).map((item) => item.id);
    expect(whitelisted).toEqual([]);
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

  it("检查后独立发送并记录；standalone:false 只上传嵌卡", async () => {
    const upload = vi.fn(async () => ({ image_key: "img_key_1" }));
    let messageResult: unknown = { code: 0, data: { message_id: "om_x1" } };
    const send = vi.fn(async () => messageResult);
    const client = { im: { v1: { image: { create: upload }, message: { create: send } } } } as unknown as Client;
    const history = new StickerHistory(join(root, "history"));
    const tool = createStickerSendTool(client, root, "oc_chat1", { rules: async () => EMPTY_RULES, history,
      preview: async () => ({ data: "cHJldmlldw==", mimeType: "image/png", sha256: createHash("sha256").update(GIF).digest("hex"), frameCount: 1, sampledFrames: [1], durationMs: 0 }),
    });
    const reviewed = async (id: string) => {
      const result = await tool.execute("inspect", { id, action: "inspect" }, undefined);
      const token = JSON.parse((result.content[0] as { text: string }).text).reviewToken;
      return { id, action: "send", reviewToken: token, reason: "已核对画面和文字，适合当前轻松对话" };
    };

    // 默认独立图片消息：上传并直接发到绑定会话，立即记录。
    const ok = await tool.execute("t", await reviewed("clawd:passed"), undefined);
    const parsed = JSON.parse((ok.content[0] as { text: string }).text) as { sent: boolean; messageId: string };
    expect(parsed.sent).toBe(true);
    expect(parsed.messageId).toBe("om_x1");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(recentSent()).toContain("clawd:passed");
    expect((await history.list("oc_chat1")).map(item => item.id)).toEqual(["clawd:passed"]);

    // 默认发送失败（飞书返回非零 code）不得进入最近记录，否则失败图也被降权
    messageResult = { code: 99991, msg: "boom" };
    await expect(tool.execute("t", await reviewed("nekowhale:大肥鱼/10N02_摸鱼"), undefined)).rejects.toThrow("飞书图片发送失败");
    expect(recentSent()).not.toContain("nekowhale:大肥鱼/10N02_摸鱼");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await history.list("oc_chat1")).map(item => item.id)).toEqual(["clawd:passed"]);

    // standalone:false：嵌入回复卡片，只上传返回 markdown 片段，等待卡片回执后才记录。
    const solo = await tool.execute("t", { ...await reviewed("nekowhale:大肥鱼和GPT娘/2TT01_喂药"), standalone: false }, undefined);
    const soloParsed = JSON.parse((solo.content[0] as { text: string }).text) as { embedded: boolean; imageKey: string; markdown: string; line: string };
    expect(soloParsed.embedded).toBe(true);
    expect(soloParsed.imageKey).toBe("img_key_1");
    expect(soloParsed.markdown).toContain("](img_key_1)");
    expect(soloParsed.markdown.startsWith("![")).toBe(true);
    expect(soloParsed.line).toContain("喂药");
    expect(upload).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(2);
    expect(recentSent()).not.toContain("nekowhale:大肥鱼和GPT娘/2TT01_喂药");
    expect((await history.list("oc_chat1")).map(item => item.id)).toEqual(["clawd:passed"]);
    expect(soloParsed).toMatchObject({ sent: false, status: "uploaded_pending_card", meaning: { description: "大肥鱼给GPT娘喂药", direction: "大肥鱼→GPT娘", source: "catalog_metadata_unverified" } });
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

  it("中文热梗扩展包：文件名派生的 metadata 可被语句检索命中", async () => {
    // chinese-bqb：按描述词检索（入库脚本从目录名取 group、从文件名取 name/desc）
    const hits = await searchStickers(root, "偷懒", { pack: "chinese-bqb", shuffle: false });
    expect(hits.map((item) => item.id)).toEqual(["chinese-bqb:010/0001"]);
    expect(hits[0]?.group).toBe("是喵星人啦");
    // 派生字段 tags/emotion 为空时，stickerLine 退化为纯名字（打标后才会带上情绪/标签）
    expect(stickerLine(hits[0]!)).toBe("上班偷懒猫");

    // emoji-package：文件名即描述句，按语句词命中
    const lazy = await searchStickers(root, "工地", { pack: "emoji-package", shuffle: false });
    expect(lazy.map((item) => item.id)).toEqual(["emoji-package:搬砖/今天工地好热，砖头烫手"]);

    // search 结果的完整 id 可直接回填给 send 的 pickSticker
    expect((await pickSticker(root, "chinese-bqb:010/0001"))?.id).toBe("chinese-bqb:010/0001");

    // 不限 pack 的全量语句搜索也能命中新包；哈希名条目不干扰中文检索
    const all = await searchStickers(root, "搬砖", { shuffle: false });
    expect(all.map((item) => item.id)).toContain("emoji-package:搬砖/搬砖使我快乐");
    expect(all.every((item) => item.pack === "emoji-package")).toBe(true);
  });

  it("搜索空结果时返回可操作的 hint 而不是空数组", async () => {
    const tool = createGuestStickerSearchTool(root);
    const result = await tool.execute("t", { query: "", pack: "dsh-pet", emotion: "开心" }, undefined);
    const block = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(block.text) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(String(parsed[0].hint)).toContain("没有命中");
  });

  it("访客搜索返回描述和来源，不含本地路径", async () => {
    const tool = createGuestStickerSearchTool(root);
    const result = await tool.execute("t", { query: "庆祝", pack: "clawd" }, undefined);
    const block = result.content[0] as { type: string; text: string };
    expect(block.type).toBe("text");
    const parsed = JSON.parse(block.text) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe("clawd:passed");
    expect(parsed[0].line).toBe("测试通过");
    expect(parsed[0].desc).toBe("开心庆祝");
    expect(Object.keys(parsed[0]).sort()).toEqual(["desc", "id", "line", "source", "tags"]);
    expect(block.text).not.toContain(root);
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

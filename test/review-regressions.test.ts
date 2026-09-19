import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildConversationId } from "../src/feishu/lark-transport.ts";
import { ScheduleService } from "../src/schedule/service.ts";
import { CredentialVault } from "../src/utils/credential-vault.ts";
import { MessageStore } from "../src/feishu/message-store.ts";
import { DataCleaner } from "../src/runtime/data-cleaner.ts";
import { AskBroker } from "../src/feishu/ask-broker.ts";
import { PermissionBroker } from "../src/guard/broker.ts";
import { CardKitStream } from "../src/feishu/cardkit-stream.ts";
import { LarkImageProcessor } from "../src/feishu/image-processor.ts";
import { LogoutCommand } from "../src/feishu/user-auth.ts";

it("不同话题根不合并，回复回到自己的根", () => {
  expect(buildConversationId("oc", "topic", undefined, "a")).toBe("topic:oc:a");
  expect(buildConversationId("oc", "topic", undefined, "b")).toBe("topic:oc:b");
  expect(buildConversationId("oc", "topic", "a", "reply")).toBe("topic:oc:a");
});

it("清理消息后正常写入不会把已清理记录复活", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleanup-store-"));
  const file = join(dir, "messages.json");
  await writeFile(file, JSON.stringify({ old: { status: "completed", updatedAt: 1 } }));
  const messages = new MessageStore(file);
  await messages.claim("fresh");
  await new DataCleaner({ sessionsRoot: join(dir, "sessions"), messages }).cleanup();
  await messages.complete("fresh");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ fresh: expect.objectContaining({ status: "completed" }) });
});

it("相同任务执行中再次触发不会中断或重入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "schedule-overlap-"));
  let release!: () => void;
  const runTask = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const service = new ScheduleService({ storeFile: join(dir, "tasks.json"), runTask });
  const { task } = await service.addTask({ cron: "0 9 * * *", prompt: "test", chatId: "oc", createdBy: "ou" });
  expect(await service.fireNow(task!.id)).toContain("已触发");
  expect(await service.fireNow(task!.id)).toContain("正在执行");
  expect(runTask).toHaveBeenCalledOnce();
  release();
  await vi.waitFor(async () => expect((await service.listTasks())[0].lastStatus).toBe("ok"));
  expect((await service.addTask({ cron: "* * * * * *", prompt: "test", chatId: "oc", createdBy: "ou" })).error).toBeDefined();
});

it("损坏的凭证主密钥不会被覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vault-key-"));
  const key = join(dir, ".key");
  await writeFile(key, "broken-key");
  await expect(CredentialVault.open(join(dir, "vault.json"), { keyFile: key })).rejects.toThrow("内容不合法");
  expect(await readFile(key, "utf8")).toBe("broken-key");
});

it("凭证持久化一次失败后仍可恢复写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vault-retry-"));
  const file = join(dir, "vault.json");
  const vault = await CredentialVault.open(file);
  await mkdir(file); // 让原子替换目标临时不可写
  await expect(vault.put("test", "a", "one")).rejects.toThrow();
  await rmdir(file);
  await vault.put("test", "a", "two");
  expect((JSON.parse(await readFile(file, "utf8"))).version).toBe(1);
});

it("取消提问立即释放等待，不依赖卡片更新完成", async () => {
  const controller = new AbortController();
  const broker = new AskBroker({ sendCard: async () => "m", updateCard: () => new Promise(() => {}) });
  const task = broker.ask("ou", "oc", "q", ["a", "b"], controller.signal);
  await Promise.resolve();
  controller.abort();
  expect(await task).toEqual({ status: "cancelled" });
});

it("已中断的调用不会发送授权卡", async () => {
  const sendCard = vi.fn();
  const broker = new PermissionBroker({ adminOpenIds: ["ou"], timeoutMs: 100, sendCard, sendCardToUser: vi.fn(), updateCard: vi.fn() });
  const result = await broker.requestApproval({ chatId: "oc", toolName: "bash", args: {}, reason: "test" }, AbortSignal.abort());
  expect(result.allowed).toBe(false);
  expect(sendCard).not.toHaveBeenCalled();
});

it("退出 Meegle 不会误清飞书凭证，未知 provider 不做操作", async () => {
  const lark = vi.fn(async () => true);
  const meegle = vi.fn(async () => true);
  const command = new LogoutCommand({ logout: lark } as never, { meegle });
  const message = { text: "/logout meegle", context: { userOpenId: "ou" } };
  await command.execute(message as never);
  expect(meegle).toHaveBeenCalledWith("ou");
  expect(lark).not.toHaveBeenCalled();
  await command.execute({ ...message, text: "/logout unknown" } as never);
  expect(lark).not.toHaveBeenCalled();
  expect(meegle).toHaveBeenCalledOnce();
});


it("最终整卡更新包含全部内容并释放定时器，不等待固定延迟", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn(async () => ({ data: { card_id: "card" } }));
    const stream = new CardKitStream({ client: { request } as never });
    await stream.create();
    stream.patch("partial");
    await stream.finalize("complete", "stats");
    expect(vi.getTimerCount()).toBe(0);
    const last = request.mock.calls.at(-1) as unknown as [ { method: string; data: { card: { data: string } } } ];
    expect(last[0].method).toBe("PUT");
    const card = JSON.parse(last[0].data.card.data);
    expect(card.config.streaming_mode).toBe(false);
    expect(card.body.elements[0].content).toBe("complete");
    expect(card.body.elements[1].content).toBe("stats");
  } finally { vi.useRealTimers(); }
});

it("最终卡片写入失败也释放定时器并报告错误", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn().mockResolvedValueOnce({ data: { card_id: "card" } }).mockRejectedValue(new Error("offline"));
    const stream = new CardKitStream({ client: { request } as never });
    await stream.create();
    await expect(stream.finalize("complete")).rejects.toThrow("offline");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("首次图片消息创建 images 目录并保存原图", async () => {
  const dir = await mkdtemp(join(tmpdir(), "image-save-"));
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]);
  const processor = new LarkImageProcessor({ im: { v1: { messageResource: { get: async () => content } } } } as never);
  const image = await processor.processImage("m", "image-key", join(dir, "images"));
  expect(image?.mimeType).toBe("image/png");
  expect(await readFile(image!.savedPath!)).toEqual(content);
});

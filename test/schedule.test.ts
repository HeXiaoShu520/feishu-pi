import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleService, ScheduleStore, type ScheduleTask } from "../src/schedule/service.ts";

const CHAT = "oc_test";
const ADMIN = "ou_admin";

async function makeService(runner: (task: ScheduleTask) => Promise<void> = vi.fn(async (_task: ScheduleTask) => undefined)) {
  const dir = await mkdtemp(join(tmpdir(), "schedule-"));
  const store = new ScheduleStore(join(dir, "schedules.json"));
  const service = new ScheduleService({ storeFile: join(dir, "schedules.json"), runTask: runner });
  return { dir, store, service, runner };
}

describe("ScheduleStore 持久化", () => {
  it("put/get/list/remove，且跨实例（重启）可恢复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schedule-store-"));
    const file = join(dir, "schedules.json");
    const store = new ScheduleStore(file);
    const task = {
      id: "abc123", name: "每日报告", cron: "0 9 * * *", prompt: "汇报昨日",
      chatId: CHAT, createdBy: ADMIN, enabled: true, createdAt: new Date().toISOString(),
    };
    await store.put(task);

    const reloaded = new ScheduleStore(file);
    const list = await reloaded.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(task);
    expect(await reloaded.get("abc123")).toEqual(task);
    expect(await reloaded.remove("abc123")).toBe(true);
    expect(await reloaded.list()).toHaveLength(0);
  });

});

describe("ScheduleService", () => {
  it("addTask：合法 cron 创建成功并持久化；非法 cron 返回错误", async () => {
    const { service, store } = await makeService();
    const ok = await service.addTask({ cron: "0 9 * * *", prompt: "播报天气", chatId: CHAT, createdBy: ADMIN });
    expect(ok.task?.id).toBeTruthy();
    expect(await store.get(ok.task!.id)).toBeTruthy();

    const bad = await service.addTask({ cron: "每天九点", prompt: "x", chatId: CHAT, createdBy: ADMIN });
    expect(bad.error).toContain("无效");
  });

  it("fireNow：执行注入的 runner 并记录 lastStatus=ok；runner 抛错记录 lastStatus=error", async () => {
    const runner = vi.fn(async (_task: ScheduleTask) => undefined);
    const { service } = await makeService(runner);
    const added = await service.addTask({ cron: "0 9 * * *", prompt: "做点事", chatId: CHAT, createdBy: ADMIN });
    if (!added.task) throw new Error("task missing");
    const task = added.task;

    await service.fireNow(task.id);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]?.id).toBe(task.id);
    expect((await service.listTasks())[0]?.lastStatus).toBe("ok");

    // 破坏 runner 后再次触发 → 记录 error
    runner.mockImplementationOnce(async () => { throw new Error("模型超时"); });
    await service.fireNow(task.id);
    const [after] = await service.listTasks();
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toContain("模型超时");
  });

  it("setEnabled / removeTask：停用后不触发，删除后消失", async () => {
    const runner = vi.fn(async () => undefined);
    const { service } = await makeService(runner);
    const added = await service.addTask({ cron: "0 9 * * *", prompt: "提醒", chatId: CHAT, createdBy: ADMIN });
    if (!added.task) throw new Error("task missing");
    const task = added.task;

    expect(await service.setEnabled(task.id, false)).toContain("已停用");
    expect(await service.fireNow(task.id)).toContain("已触发"); // fireNow 手动触发不受 enabled 限制
    expect(await service.removeTask(task.id)).toContain("已删除");
    expect(await service.removeTask(task.id)).toContain("不存在");
    expect(await service.listTasks()).toHaveLength(0);
  });
});

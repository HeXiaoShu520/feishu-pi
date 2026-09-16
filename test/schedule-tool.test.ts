import { describe, expect, it, vi } from "vitest";
import { createScheduleManagerTool } from "../src/schedule/tool.ts";
import type { ScheduleManagerService } from "../src/schedule/tool.ts";

/** 构造注入版服务：数据存内存，可观测 fireNow 调用 */
function makeService() {
  const fired: string[] = [];
  const tasks = new Map<string, {
    id: string; name: string; cron: string; prompt: string; chatId: string;
    createdBy: string; enabled: boolean;
  }>();
  let seq = 0;
  const svc: ScheduleManagerService = {
    listTasks: async () => [...tasks.values()],
    addTask: async (input) => {
      if (!/^\S+(\s+\S+){4}$/.test(input.cron)) return { error: `cron 表达式无效：${input.cron}` };
      seq += 1;
      const task = {
        id: `t${seq}`, name: input.name ?? input.prompt.slice(0, 20), cron: input.cron,
        prompt: input.prompt, chatId: input.chatId, createdBy: input.createdBy, enabled: true,
      };
      tasks.set(task.id, task);
      return { task };
    },
    removeTask: async (id) => (tasks.delete(id) ? `已删除任务 ${id}` : `任务 ${id} 不存在`),
    setEnabled: async (id, enabled) => {
      const t = tasks.get(id);
      if (!t) return `任务 ${id} 不存在`;
      t.enabled = enabled;
      return `${enabled ? "已启用" : "已停用"}任务 ${id}（${t.name}）`;
    },
    fireNow: async (id) => {
      if (!tasks.has(id)) return `任务 ${id} 不存在`;
      fired.push(`fire:${id}`);
      return `已触发任务 ${id}（${tasks.get(id)!.name}）`;
    },
  };
  return { svc, fired, tasks };
}

function makeTool(service: ScheduleManagerService) {
  return createScheduleManagerTool(service, { chatId: "oc_default", createdBy: "ou_admin" });
}

/** 执行一次工具并取回文本结果 */
async function call(
  tool: ReturnType<typeof createScheduleManagerTool>,
  params: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute("tc_1", params);
  return (result.content[0] as { text: string }).text;
}

describe("schedule_manager 工具（直连 ScheduleService）", () => {
  it("add：校验必填与 cron 格式；list：能看到新任务", async () => {
    const { svc, fired } = makeService();
    const tool = makeTool(svc);
    expect(await call(tool, { action: "add" })).toContain("cron 与 prompt");
    expect(await call(tool, { action: "add", cron: "not-a-cron", prompt: "x" })).toContain("cron 表达式无效");
    expect(await call(tool, { action: "add", cron: "0 9 * * *", prompt: "播报天气", name: "天气播报" })).toContain("已创建");
    const list = await call(tool, { action: "list" });
    expect(list).toContain("天气播报");
    expect(list).toContain("0 9 * * *");
    expect(fired).toEqual([]);
  });

  it("remove/toggle 返回服务回执；对不存在的任务给出提示", async () => {
    const { svc } = makeService();
    const tool = makeTool(svc);
    const { task } = await svc.addTask({ cron: "0 9 * * *", prompt: "p", chatId: "oc", createdBy: "ou", name: "晨报" });
    expect(await call(tool, { action: "toggle", id: task!.id, enabled: false })).toContain("已停用");
    expect(await call(tool, { action: "remove", id: task!.id })).toContain("已删除");
    expect(await call(tool, { action: "toggle", id: task!.id, enabled: true })).toContain("不存在");
  });

  it("run 委托 fireNow（后台执行）；未知操作报错", async () => {
    const { svc, fired } = makeService();
    const tool = makeTool(svc);
    const { task } = await svc.addTask({ cron: "0 9 * * *", prompt: "p", chatId: "oc", createdBy: "ou" });
    expect(await call(tool, { action: "run", id: task!.id })).toContain("已触发");
    expect(fired).toEqual([`fire:${task!.id}`]);
    expect(await call(tool, { action: "what" })).toContain("未知操作");
  });
});

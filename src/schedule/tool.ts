/**
 * schedule_manager 工具：定时任务的管理入口（查看/创建/删除/启停/立即执行）。
 * 直连 ScheduleService 进程内调用——不直接读写 data/schedules.json，
 * 避免与调度器的内存状态产生文件竞态。
 * 由 Tools(schedule_manager) 授权；任务按创建者隔离。
 */
import { logger } from "../utils/logger.ts";

/** 管理所需的服务最小接口（ScheduleService 满足；结构化类型便于测试注入） */
export interface ScheduleManagerService {
  listTasks(): Promise<
    Array<{
      id: string;
      name: string;
      cron: string;
      prompt: string;
      chatId: string;
      createdBy: string;
      enabled: boolean;
      lastRunAt?: number;
      lastStatus?: "ok" | "error";
      lastError?: string;
    }>
  >;
  addTask(input: {
    cron: string;
    prompt: string;
    chatId: string;
    createdBy: string;
    name?: string;
  }): Promise<{ task?: { id: string; name: string }; error?: string }>;
  removeTask(id: string): Promise<string>;
  setEnabled(id: string, enabled: boolean): Promise<string>;
  fireNow(id: string): Promise<string>;
}

export function createScheduleManagerTool(
  service: ScheduleManagerService,
  defaults: { chatId: string; createdBy: string },
) {
  return {
    name: "schedule_manager",
    label: "schedule_manager",
    description:
      "管理定时任务：list 列表 / add 创建（cron 为 5 段表达式：分 时 日 月 周）/ remove 删除 / toggle 启停 / run 立即执行一次。" +
      "任务的指令必须自包含——执行时只能看到 prompt 这句话，需写明做什么、范围与输出要求。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "toggle", "run"], description: "操作类型" },
        cron: { type: "string", description: "add 时：cron 表达式（5 段：分 时 日 月 周，如 0 9 * * *）" },
        prompt: { type: "string", description: "add 时：任务执行时的完整指令（自包含）" },
        name: { type: "string", description: "add 时：任务名（可选，默认取 prompt 前 20 字）" },
        id: { type: "string", description: "remove/toggle/run 时：任务 ID（list 里可查）" },
        enabled: { type: "boolean", description: "toggle 时：true=启用 / false=停用" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const action = typeof params.action === "string" ? params.action : "";
      let text: string;
      try {
        text = await run(service, action, params, defaults);
      } catch (error) {
        text = `❌ 操作失败：${error instanceof Error ? error.message : String(error)}`;
      }
      logger.info(`[ScheduleTool] ${action} 完成`);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  };
}

async function run(
  service: ScheduleManagerService,
  action: string,
  params: Record<string, unknown>,
  defaults: { chatId: string; createdBy: string },
): Promise<string> {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const id = str(params.id);
  if (["remove", "toggle", "run"].includes(action)) {
    if (!id) return "❌ 请提供任务 ID";
    const task = (await service.listTasks()).find((task) => task.id === id && task.createdBy === defaults.createdBy);
    if (!task) return "❌ 任务不存在或不属于你";
  }
  switch (action) {
    case "list": {
      const tasks = (await service.listTasks()).filter((task) => task.createdBy === defaults.createdBy);
      if (tasks.length === 0) return "📋 暂无定时任务";
      return [
        `📋 定时任务（共 ${tasks.length} 个）：`,
        ...tasks.map((t) => {
          const state = t.enabled ? "启用中" : "已停用";
          const last = t.lastRunAt
            ? `，上次${t.lastStatus === "error" ? "执行失败" : "执行成功"}`
            : "，从未执行";
          return `- [${t.id}] ${t.name} · cron: ${t.cron} · ${state}${last}\n  指令：${t.prompt}`;
        }),
      ].join("\n");
    }
    case "add": {
      const cron = str(params.cron);
      const prompt = str(params.prompt);
      if (!cron || !prompt) {
        return "❌ 创建任务需要 cron 与 prompt 两项齐全";
      }
      const { task, error } = await service.addTask({
        cron,
        prompt,
        chatId: defaults.chatId,
        createdBy: defaults.createdBy,
        name: str(params.name) || undefined,
      });
      if (error || !task) return `❌ 创建失败：${error ?? "未知原因"}`;
      return `✅ 已创建定时任务 [${task.id}] ${task.name}（cron: ${cron}），到点自动执行并将结果推送到本会话。`;
    }
    case "remove":
      return service.removeTask(id);
    case "toggle": {
      if (typeof params.enabled !== "boolean") return "❌ toggle 需要 enabled 参数（true/false）";
      return service.setEnabled(id, params.enabled);
    }
    case "run":
      return service.fireNow(id);
    default:
      return `❌ 未知操作：${action}`;
  }
}

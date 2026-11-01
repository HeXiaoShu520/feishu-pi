import type { FeishuPiTool } from "../runtime/types.ts";
import type { IdentityShellLease } from "../runtime/identity-bash.ts";
import { textResult } from "../tools/result.ts";
import type { BackgroundTaskService } from "./service.ts";
import { resolve } from "node:path";

export function createBackgroundTaskTool(service: BackgroundTaskService, context: { cwd: string; chatId: string; openLease: () => Promise<IdentityShellLease> }): FeishuPiTool {
  return {
    name: "background_task", label: "后台任务",
    description: "后台执行长时间命令，start 返回任务编号，可用 status/log 查询、cancel 停止整个进程树。start 使用与 bash 相同的身份通道和权限，凭证代理保留到任务结束。任务完成由程序发送通知，不消耗额外模型调用。默认超时 30 分钟，最多 24 小时，最多并发 3 个，日志最多 10 MiB。服务退出会停止任务；重启后保留记录并标记 interrupted，不自动重跑有副作用的操作。succeeded 仅表示退出码 0，交付前仍需检查业务结果。",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["start", "list", "status", "log", "cancel"] }, command: { type: "string" }, name: { type: "string" },
      id: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 1000, maximum: 86_400_000 }, maxBytes: { type: "integer", minimum: 1, maximum: 64_000 },
    }, required: ["action"] },
    execute: async (_id, params, signal) => {
      const input = params as { action: string; command?: string; name?: string; id?: string; cwd?: string; timeoutMs?: number; maxBytes?: number };
      switch (input.action) {
        case "start": return textResult(await service.start({ command: input.command ?? "", name: input.name, cwd: input.cwd ? resolve(context.cwd, input.cwd) : context.cwd, timeoutMs: input.timeoutMs, chatId: context.chatId }, context.openLease, signal));
        case "list": return textResult(await service.list());
        case "status": return textResult(await service.get(input.id ?? "") ?? "任务不存在");
        case "log": return textResult(await service.log(input.id ?? "", input.maxBytes));
        case "cancel": return textResult(await service.cancel(input.id ?? "") ?? "任务不存在");
        default: throw new Error("未知后台任务操作");
      }
    },
  };
}

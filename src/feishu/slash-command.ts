import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

export interface SlashCommandDescription {
  default_value: string;
  i18n?: Record<string, string>;
}

export interface SlashCommandDefinition {
  /** 不含前导斜杠，例如 model 对应用户看到的 /model。 */
  command: string;
  description: SlashCommandDescription;
  icon?: { icon_key: string };
}

interface SlashCommandItem extends SlashCommandDefinition {
  command_id: string;
}

export interface SlashCommandSyncResult {
  created: number;
  updated: number;
  unchanged: number;
}

/** 与 CommandRegistry 中实际可用的内置/注入式指令保持同名。 */
export const DEFAULT_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  {
    command: "help",
    description: { default_value: "查看可用指令", i18n: { zh_cn: "查看可用指令", en_us: "Show available commands" } },
    icon: { icon_key: "chat_outlined" },
  },
  {
    command: "model",
    description: { default_value: "查看并切换 AI 模型", i18n: { zh_cn: "查看并切换 AI 模型", en_us: "View and switch AI models" } },
    icon: { icon_key: "ai-agent_outlined" },
  },
  {
    command: "login",
    description: { default_value: "登录飞书用户身份", i18n: { zh_cn: "登录飞书用户身份", en_us: "Sign in with Feishu identity" } },
    icon: { icon_key: "member_outlined" },
  },
  {
    command: "logout",
    description: { default_value: "退出飞书用户身份", i18n: { zh_cn: "退出飞书用户身份", en_us: "Sign out of Feishu identity" } },
    icon: { icon_key: "clear_outlined" },
  },
  {
    command: "new",
    description: { default_value: "开始新会话", i18n: { zh_cn: "开始新会话", en_us: "Start a new session" } },
    icon: { icon_key: "add-chat-ai_outlined" },
  },
  {
    command: "stop",
    description: { default_value: "停止当前 AI 响应", i18n: { zh_cn: "停止当前 AI 响应", en_us: "Stop the current AI response" } },
    icon: { icon_key: "clear_outlined" },
  },
  {
    command: "restart",
    description: { default_value: "重启开发服务（仅管理员）", i18n: { zh_cn: "重启开发服务（仅管理员）", en_us: "Restart the dev service (admin only)" } },
    icon: { icon_key: "update-ai_outlined" },
  },
  {
    command: "detail",
    description: { default_value: "切换详细/精简回复模式", i18n: { zh_cn: "切换详细/精简回复模式", en_us: "Toggle detailed response mode" } },
    icon: { icon_key: "ai-style_outlined" },
  },
];

function sameDescription(a: SlashCommandDescription | undefined, b: SlashCommandDescription): boolean {
  return a?.default_value === b.default_value && JSON.stringify(a?.i18n ?? {}) === JSON.stringify(b.i18n ?? {});
}

function sameIcon(a: { icon_key?: string } | undefined, b: { icon_key: string } | undefined): boolean {
  return (a?.icon_key ?? "") === (b?.icon_key ?? "");
}

function assertSuccess(response: unknown, action: string): void {
  const body = response as { code?: number; msg?: string } | undefined;
  if (typeof body?.code === "number" && body.code !== 0) {
    throw new Error(`${action}失败（${body.code}）：${body.msg ?? "未知错误"}`);
  }
}

/** 负责把应用 Slash Command 配置同步到飞书，重复上电不会重复创建。 */
export class SlashCommandRegistrar {
  private readonly client: Client;
  private readonly definitions: readonly SlashCommandDefinition[];

  constructor(
    client: Client,
    definitions: readonly SlashCommandDefinition[] = DEFAULT_SLASH_COMMANDS,
  ) {
    this.client = client;
    this.definitions = definitions;
  }

  async sync(): Promise<SlashCommandSyncResult> {
    const response = await this.client.request({
      method: "GET",
      url: "/open-apis/application/v7/app_slash_commands",
    });
    assertSuccess(response, "查询 Slash Command");
    const items = ((response as { data?: { items?: SlashCommandItem[] } }).data?.items ?? []) as SlashCommandItem[];
    const existing = new Map(items.map((item) => [item.command, item]));
    const result: SlashCommandSyncResult = { created: 0, updated: 0, unchanged: 0 };

    for (const definition of this.definitions) {
      const current = existing.get(definition.command);
      if (!current) {
        const created = await this.client.request({
          method: "POST",
          url: "/open-apis/application/v7/app_slash_commands",
          data: definition,
        });
        assertSuccess(created, `创建 /${definition.command}`);
        result.created += 1;
        continue;
      }

      if (sameDescription(current.description, definition.description) && sameIcon(current.icon, definition.icon)) {
        result.unchanged += 1;
        continue;
      }

      const updated = await this.client.request({
        method: "PATCH",
        url: `/open-apis/application/v7/app_slash_commands/${current.command_id}`,
        data: { description: definition.description, icon: definition.icon },
      });
      assertSuccess(updated, `更新 /${definition.command}`);
      result.updated += 1;
    }

    logger.info(`[SlashCommand] 同步完成：创建 ${result.created}，更新 ${result.updated}，无需变化 ${result.unchanged}`);
    return result;
  }
}

import { describe, expect, it, vi } from "vitest";
import type { Client } from "@larksuiteoapi/node-sdk";
import { DEFAULT_SLASH_COMMANDS, SlashCommandRegistrar } from "../src/feishu/slash-command.ts";

function fakeClient(request: ReturnType<typeof vi.fn>): Client {
  return { request } as unknown as Client;
}

describe("SlashCommandRegistrar", () => {
  it("为缺失的快捷指令创建配置", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { items: [] } })
      .mockResolvedValue({ code: 0, data: {} });

    const result = await new SlashCommandRegistrar(fakeClient(request)).sync();

    expect(result).toEqual({ created: DEFAULT_SLASH_COMMANDS.length, updated: 0, unchanged: 0 });
    expect(request).toHaveBeenCalledTimes(DEFAULT_SLASH_COMMANDS.length + 1);
    expect(request.mock.calls[1][0]).toMatchObject({
      method: "POST",
      url: "/open-apis/application/v7/app_slash_commands",
      data: DEFAULT_SLASH_COMMANDS[0],
    });
  });

  it("已有配置一致时不重复创建", async () => {
    const definition = DEFAULT_SLASH_COMMANDS[0];
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: [{ ...definition, command_id: "cmd_help" }] },
    });

    const result = await new SlashCommandRegistrar(fakeClient(request), [definition]).sync();

    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("已有配置变化时按 command_id 更新", async () => {
    const definition = DEFAULT_SLASH_COMMANDS[0];
    const request = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{
            ...definition,
            command_id: "cmd_help",
            description: { default_value: "旧描述" },
          }],
        },
      })
      .mockResolvedValueOnce({ code: 0, data: {} });

    const result = await new SlashCommandRegistrar(fakeClient(request), [definition]).sync();

    expect(result).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(request.mock.calls[1][0]).toMatchObject({
      method: "PATCH",
      url: "/open-apis/application/v7/app_slash_commands/cmd_help",
      data: { description: definition.description, icon: definition.icon },
    });
  });
});

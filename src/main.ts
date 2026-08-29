import "dotenv/config";
import { ConversationManager } from "./runtime/conversation-manager.ts";
import { FeishuPiRuntime } from "./runtime/feishu-pi-runtime.ts";
import { FeishuAgentBridge } from "./feishu/agent-bridge.ts";
import { LarkTransport } from "./feishu/lark-transport.ts";
import { loadConfig } from "./config.ts";
import { ConversationStore } from "./runtime/conversation-store.ts";
import { MessageStore } from "./feishu/message-store.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 启动轻量飞书 Agent 服务。 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = new FeishuPiRuntime(config);
  const conversations = new ConversationManager(runtime, new ConversationStore(join(config.sessionDir, "conversations.json")));
  const messages = new MessageStore(join(config.sessionDir, "messages.json"));
  const transport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId: config.feishuBotOpenId,
  });
  const bridge = new FeishuAgentBridge(conversations, transport, undefined, messages);
  bridge.start();
  await transport.connect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

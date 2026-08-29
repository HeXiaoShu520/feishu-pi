import { ConversationManager } from "./runtime/conversation-manager.ts";
import { FeishuPiRuntime } from "./runtime/feishu-pi-runtime.ts";
import { FeishuAgentBridge } from "./feishu/agent-bridge.ts";
import { LarkTransport } from "./feishu/lark-transport.ts";
import { loadConfig } from "./config.ts";

/** 启动轻量飞书 Agent 服务。 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = new FeishuPiRuntime(config);
  const conversations = new ConversationManager(runtime);
  const transport = new LarkTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    botOpenId: config.feishuBotOpenId,
  });
  const bridge = new FeishuAgentBridge(conversations, transport);
  bridge.start();
  await transport.connect();
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) await main();

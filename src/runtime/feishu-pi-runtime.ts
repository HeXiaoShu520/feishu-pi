import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool } from "./types.ts";
import { createToolRegistry, DEFAULT_BUILTIN_TOOLS } from "../tools/registry.ts";

class SessionWrapper implements FeishuPiSession {
  readonly sessionFile?: string;
  private readonly raw: AgentSession;

  constructor(session: AgentSession) {
    this.raw = session;
    this.sessionFile = session.sessionFile;
  }

  subscribe(listener: (event: FeishuPiEvent) => void): () => void {
    return this.raw.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const text = event.message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
        listener({ type: "assistant_text", text });
        return;
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const toolName = "toolName" in event && typeof event.toolName === "string" ? event.toolName : "unknown";
        if (event.type === "tool_execution_start") listener({ type: "tool_started", toolName });
        if (event.type === "tool_execution_update") listener({ type: "tool_updated", toolName });
        if (event.type === "tool_execution_end") listener({ type: "tool_finished", toolName, isError: "isError" in event && event.isError === true });
      }
    });
  }

  async prompt(input: FeishuPiPrompt): Promise<void> {
    const images: ImageContent[] = (input.images ?? []).map((image) => ({
      type: "image",
      data: Buffer.from(image.data).toString("base64"),
      mimeType: image.mimeType,
    }));
    await this.raw.prompt(input.text, images.length ? { images } : undefined);
  }

  async waitForIdle(): Promise<void> {
    await this.raw.waitForIdle();
  }
}

export class FeishuPiRuntime {
  private readonly config: FeishuPiConfig;
  private readonly tools: FeishuPiTool[];

  constructor(config: FeishuPiConfig, tools: FeishuPiTool[] = []) {
    this.config = config;
    this.tools = tools;
  }

  async createSession(sessionFile?: string): Promise<FeishuPiSession> {
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, this.config.sessionDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, this.config.sessionDir);
    const model = getModel(this.config.modelProvider as never, this.config.modelId as never);
    if (!model) throw new Error(`Model not found: ${this.config.modelProvider}/${this.config.modelId}`);
    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      sessionManager,
      model: this.config.modelBaseUrl ? { ...model, baseUrl: this.config.modelBaseUrl } : model,
      tools: this.config.builtinTools ?? [...DEFAULT_BUILTIN_TOOLS],
      customTools: createToolRegistry(this.tools),
    });
    return new SessionWrapper(session);
  }
}

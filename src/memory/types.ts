import type { FeishuContext } from "../context/types.ts";

/** 记忆存储的最小接口，具体存储方式由应用层决定。 */
export interface MemoryStore {
  load(context: FeishuContext): Promise<string>;
  save(context: FeishuContext, content: string): Promise<void>;
}

import type { FeishuPiTool } from "../runtime/types.ts";
import { textResult } from "../tools/result.ts";
import type { MemoryContext, MemoryService, ProfileUpdate } from "./service.ts";

/** Identity and evidence are bound by the host; no user IDs, paths or commands in schema. */
export function createProfileUpdateTool(memory: Pick<MemoryService, "updateProfile">, openId: string,
  context: MemoryContext, currentUserText: () => string | undefined): FeishuPiTool {
  return {
    name: "profile_update", label: "更新对这个人的认识",
    description: "内部用户画像记忆。你自己判断本轮出现值得以后记住的明确偏好、相处反馈、稳定背景或重要经历时才调用；明确的长期聊天偏好、反复出现的相处反馈、本人纠正旧事实，通常值得记住，不必等用户说“帮我记住”。普通寒暄、表情调侃、临时情绪不必记录，不向用户索要填写或确认画像。只记当前发言人本人明确表达的内容，不能把他谈及别人的信息记成他的资料。remember 新增或按同一topic纠正旧项；forget 在本人要求忘记、或本轮原话明确推翻旧项时删除该项id。evidence逐字摘自本轮本人原话；不允许助手编造、引用他人、图片猜测、固定性格、诊断、好感分数、主人身份或权限规则。只更新当前发言人本人跨私聊、群聊和话题共用的画像，不能访问其他人。summary写第三人称并区分计划/自述与已发生事实。不要只在嘴上说“记住了”而没有调用；只有调用成功才能声称已长期记住。记忆是内部行为，更新成功后正常聊天，不另发画像更新汇报。无必要就不调用。",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["remember", "forget"] },
      evidence: { type: "string", description: "本轮本人原话，2至240字" },
      kind: { type: "string", enum: ["preference", "boundary", "fact", "episode"] },
      topic: { type: "string", description: "单个属性的稳定主题，纠正时沿用已有主题" },
      summary: { type: "string", description: "最多120字，不写人格指令" },
      keywords: { type: "array", items: { type: "string" } },
      id: { type: "string", description: "forget时填写当前记忆资料中的条目id" },
    }, required: ["action", "evidence"], additionalProperties: false },
    async execute(_callId, args) {
      const userText = currentUserText();
      if (!userText) throw new Error("没有正在处理的本人发言，不能更新画像");
      const id = await memory.updateProfile(openId, context, userText, args as ProfileUpdate);
      return textResult({ updated: true, id });
    },
  };
}

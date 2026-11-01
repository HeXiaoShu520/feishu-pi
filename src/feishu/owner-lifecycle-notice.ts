import { logger } from "../utils/logger.ts";

export type OwnerTextSender = (openId: string, text: string) => Promise<void>;

/**
 * 向本人私聊报告服务生命周期。通知失败不影响主服务的启动或退出；退出阶段
 * 还须受短超时约束，避免飞书网络故障阻塞进程回收。
 */
export async function sendOwnerLifecycleNotice(
  sendTextToUser: OwnerTextSender,
  ownerOpenId: string | undefined,
  text: string,
  timeoutMs = 3_000,
): Promise<void> {
  if (!ownerOpenId) {
    logger.warn("[Main] 未配置本人 open_id，跳过服务生命周期通知");
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendTextToUser(ownerOpenId, text),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`通知发送超时（${timeoutMs}ms）`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    logger.info(`[Main] 已向本人发送服务通知：${text}`);
  } catch (error) {
    logger.warn(`[Main] 向本人发送服务通知失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

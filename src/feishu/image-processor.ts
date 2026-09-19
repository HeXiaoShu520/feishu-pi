/**
 * 飞书图片附件处理：下载用户消息里的图片并转换为 Pi 可用的格式（Uint8Array + MIME）。
 *
 * 用户发送的图片必须走「获取消息中的资源文件」接口（im.v1.messageResource，
 * 需要 message_id + file_key）——/im/v1/images/{image_key} 只支持应用自己上传的图片，
 * 用用户消息的 key 调它会报 234001 Invalid request param。
 * 响应形态差异（Buffer/流/落盘 shim）统一交给 resource-buffer.toBuffer。
 */
import type { Client } from "@larksuiteoapi/node-sdk";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toBuffer } from "./resource-buffer.ts";
import { logger } from "../utils/logger.ts";

/** Pi 使用的图片格式 */
export interface ProcessedImage {
  data: Uint8Array;
  mimeType: string;
  /** 本地 OCR 识别出的文字（useExtraOcr 开启时存在；供无视觉模型以文本方式"看图"） */
  ocrText?: string;
}

/** 本地 OCR 执行器：图片 Buffer → 识别文本（失败抛错/返回 undefined 均可，调用方降级） */
export type OcrRunner = (image: Buffer) => Promise<string | undefined>;

export interface FeishuImageProcessor {
  /** 下载消息中的图片并转换为 Pi 可用格式 */
  processImage(messageId: string, imageKey: string, cacheDir?: string, ocr?: OcrRunner): Promise<ProcessedImage | undefined>;
  /** 批量处理图片（cacheDir 可覆盖默认缓存目录） */
  processImages(
    messageId: string,
    imageKeys: string[],
    cacheDir?: string,
    ocr?: OcrRunner,
  ): Promise<ProcessedImage[]>;
}

export class LarkImageProcessor implements FeishuImageProcessor {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /** 下载单张图片：失败返回 undefined（不阻断其余图片/消息处理）。 */
  async processImage(messageId: string, imageKey: string, cacheDir?: string, ocr?: OcrRunner): Promise<ProcessedImage | undefined> {
    try {
      const response = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: "image" },
      });
      const imageData = await toBuffer(response);

      // 可选：落盘到指定目录（会话工作区/images；供排查，失败不影响返回）
      if (cacheDir) {
        try {
          writeFileSync(join(cacheDir, `${imageKey}.jpg`), imageData);
        } catch (err) {
          logger.warn("[LarkImageProcessor] 保存图片缓存失败", err);
        }
      }

      const processed: ProcessedImage = { data: new Uint8Array(imageData), mimeType: this.detectMimeType(imageData) };

      // 本地 OCR（useExtraOcr 开启时由传输层注入）：把图片文字提取出来，供无视觉模型以文本方式获取
      if (ocr) {
        try {
          processed.ocrText = await ocr(imageData);
        } catch (err) {
          logger.warn("[LarkImageProcessor] OCR 识别失败（跳过，不影响图片本体）", err);
        }
      }
      return processed;
    } catch (err) {
      logger.error("[LarkImageProcessor] 处理图片失败", imageKey, err);
      return undefined;
    }
  }

  /** 并发处理多张图片；单张失败自动跳过（allSettled + 过滤 undefined）。
   *  cacheDir 传入时把图片落盘到该目录（会话工作区/images），不传则不落盘。 */
  async processImages(
    messageId: string,
    imageKeys: string[],
    cacheDir?: string,
    ocr?: OcrRunner,
  ): Promise<ProcessedImage[]> {
    const results = await Promise.allSettled(imageKeys.map((key) => this.processImage(messageId, key, cacheDir, ocr)));
    return results
      .filter((r): r is PromiseFulfilledResult<ProcessedImage | undefined> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((img): img is ProcessedImage => img !== undefined);
  }

  /** 根据文件头魔数检测 MIME 类型（识别不出时按最常见的 JPEG 兜底）。 */
  private detectMimeType(buffer: Buffer): string {
    if (buffer.length < 4) return "image/jpeg";

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    // JPEG: FF D8
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return "image/jpeg";
    }
    // GIF: 47 49 46
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "image/gif";
    }
    // WebP: RIFF....WEBP
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) {
      return "image/webp";
    }

    return "image/jpeg";
  }
}

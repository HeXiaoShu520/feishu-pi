/**
 * 飞书图片附件处理：下载图片并转换为 Pi 可用的格式（Uint8Array + MIME）。
 *
 * SDK 图片下载的响应形态不一（Buffer/流/落盘 shim），数据提取统一交给
 * resource-buffer.toBuffer；本模块只关心缓存落盘与 MIME 识别。
 */
import type { Client } from "@larksuiteoapi/node-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toBuffer } from "./resource-buffer.ts";
import { logger } from "../utils/logger.ts";

/** Pi 使用的图片格式 */
export interface ProcessedImage {
  data: Uint8Array;
  mimeType: string;
}

export interface FeishuImageProcessor {
  /** 下载图片并转换为 Pi 可用格式 */
  processImage(imageKey: string): Promise<ProcessedImage | undefined>;
  /** 批量处理图片 */
  processImages(imageKeys: string[]): Promise<ProcessedImage[]>;
}

export class LarkImageProcessor implements FeishuImageProcessor {
  private readonly client: Client;
  private readonly cacheDir?: string;

  constructor(client: Client, options?: { cacheDir?: string }) {
    this.client = client;
    this.cacheDir = options?.cacheDir;
    if (this.cacheDir) {
      try {
        mkdirSync(this.cacheDir, { recursive: true });
      } catch (err) {
        // 缓存目录创建失败不阻断启动，仅丢失本地缓存能力
        logger.warn("[LarkImageProcessor] 创建图片缓存目录失败", err);
      }
    }
  }

  /** 下载单张图片：失败返回 undefined（不阻断其余图片/消息处理）。 */
  async processImage(imageKey: string): Promise<ProcessedImage | undefined> {
    try {
      const response = await this.client.im.image.get({
        path: { image_key: imageKey },
      });
      const imageData = await toBuffer(response);

      // 可选：保存到本地缓存（供排查与复用；失败不影响返回）
      if (this.cacheDir) {
        try {
          writeFileSync(join(this.cacheDir, `${imageKey}.jpg`), imageData);
        } catch (err) {
          logger.warn("[LarkImageProcessor] 保存图片缓存失败", err);
        }
      }

      return { data: new Uint8Array(imageData), mimeType: this.detectMimeType(imageData) };
    } catch (err) {
      logger.error("[LarkImageProcessor] 处理图片失败", imageKey, err);
      return undefined;
    }
  }

  /** 并发处理多张图片；单张失败自动跳过（allSettled + 过滤 undefined）。 */
  async processImages(imageKeys: string[]): Promise<ProcessedImage[]> {
    const results = await Promise.allSettled(imageKeys.map((key) => this.processImage(key)));
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

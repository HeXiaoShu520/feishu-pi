/**
 * 飞书图片附件处理
 * 支持下载图片并转换为 Pi 可用的格式
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ImageAttachment {
  imageKey: string;
  /** 下载后的本地路径（可选） */
  localPath?: string;
}

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
      } catch {
        // ignore
      }
    }
  }

  async processImage(imageKey: string): Promise<ProcessedImage | undefined> {
    try {
      // 下载图片
      const response = await this.client.im.image.get({
        path: { image_key: imageKey },
      });

      // 获取图片数据
      const imageData = await this.getImageData(response);
      if (!imageData) return undefined;

      // 可选：保存到本地缓存
      if (this.cacheDir) {
        try {
          const localPath = join(this.cacheDir, `${imageKey}.jpg`);
          writeFileSync(localPath, imageData);
        } catch (err) {
          console.warn("[LarkImageProcessor] 保存图片缓存失败", err);
        }
      }

      // 转换为 Pi 可用格式（Uint8Array）
      return {
        data: new Uint8Array(imageData),
        mimeType: this.detectMimeType(imageData),
      };
    } catch (err) {
      console.error("[LarkImageProcessor] 处理图片失败", imageKey, err);
      return undefined;
    }
  }

  async processImages(imageKeys: string[]): Promise<ProcessedImage[]> {
    const results = await Promise.allSettled(
      imageKeys.map((key) => this.processImage(key)),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<ProcessedImage | undefined> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((img): img is ProcessedImage => img !== undefined);
  }

  /** 从飞书 SDK 响应中提取图片数据 */
  private async getImageData(response: any): Promise<Buffer | undefined> {
    try {
      // 飞书 SDK 可能返回不同格式的数据
      if (response.data) {
        // 如果是 Buffer 或 Uint8Array
        if (Buffer.isBuffer(response.data)) {
          return response.data;
        }
        if (response.data instanceof Uint8Array) {
          return Buffer.from(response.data);
        }
        // 如果有 writeFile 方法（某些 SDK 版本）
        if (typeof response.writeFile === "function") {
          const tmpPath = join(this.cacheDir ?? "/tmp", `temp_${Date.now()}.jpg`);
          await response.writeFile(tmpPath);
          const { readFileSync, unlinkSync } = await import("node:fs");
          const data = readFileSync(tmpPath);
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore cleanup error
          }
          return data;
        }
        // 如果有 getReadableStream 方法
        if (typeof response.getReadableStream === "function") {
          const stream = response.getReadableStream();
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks);
        }
      }
      return undefined;
    } catch (err) {
      console.error("[LarkImageProcessor] 提取图片数据失败", err);
      return undefined;
    }
  }

  /** 根据文件头检测 MIME 类型 */
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

    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return "image/webp";
    }

    return "image/jpeg"; // 默认
  }
}

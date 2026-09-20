/**
 * 飞书资源下载响应统一收敛为 Buffer。
 *
 * SDK 不同接口/版本的返回形态不一：Buffer、`{ data: Buffer | Uint8Array | 流 }`、
 * `getReadableStream()`、以及需要落地临时文件的 `writeFile(path)` shim——
 * 这里按能力逐级探测，调用方无需关心差异。无法识别的结构抛错（含响应片段便于排查）。
 */
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MAX_RESOURCE_BYTES = 20 * 1024 * 1024;

/** 资源超过配置上限时抛出的可识别错误。 */
export class ResourceTooLargeError extends Error {
  readonly code = "RESOURCE_TOO_LARGE";
  readonly size: number;
  readonly maxBytes: number;

  constructor(size: number, maxBytes: number) {
    super(`资源大小 ${size} 字节，超过上限 ${maxBytes} 字节`);
    this.name = "ResourceTooLargeError";
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

function ensureResourceSize(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length > maxBytes) throw new ResourceTooLargeError(buffer.length, maxBytes);
  return buffer;
}

/** 把可读流收集为 Buffer，并在超限时尽早中止读取。 */
function collectStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        fail(new ResourceTooLargeError(total, maxBytes));
        return;
      }
      chunks.push(buffer);
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", fail);
  });
}

/** 借助临时文件消费 writeFile 落地型响应：写入临时目录 → 读回 → 清理。 */
async function viaWriteFileShim(writeFileFn: (path: string) => Promise<void>, maxBytes: number): Promise<Buffer> {
  const tempPath = join(tmpdir(), `feishu-res-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFileFn(tempPath);
    return ensureResourceSize(await readFile(tempPath), maxBytes);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

/** 把资源下载接口的返回收敛为 Buffer；结构无法识别时抛错。 */
export async function toBuffer(res: unknown, maxBytes = DEFAULT_MAX_RESOURCE_BYTES): Promise<Buffer> {
  if (Buffer.isBuffer(res)) return ensureResourceSize(res, maxBytes);
  if (res && typeof res === "object") {
    const obj = res as {
      data?: unknown;
      getReadableStream?: () => NodeJS.ReadableStream;
      writeFile?: (path: string) => Promise<void>;
    };
    if (typeof obj.getReadableStream === "function") return collectStream(obj.getReadableStream(), maxBytes);
    if (Buffer.isBuffer(obj.data)) return ensureResourceSize(obj.data, maxBytes);
    if (obj.data instanceof Uint8Array) return ensureResourceSize(Buffer.from(obj.data), maxBytes);
    if (obj.data && typeof (obj.data as NodeJS.ReadableStream).on === "function") {
      return collectStream(obj.data as NodeJS.ReadableStream, maxBytes);
    }
    if (typeof obj.writeFile === "function") return viaWriteFileShim(obj.writeFile, maxBytes);
  }
  throw new Error(`无法识别的资源下载响应结构: ${String(res).slice(0, 200)}`);
}

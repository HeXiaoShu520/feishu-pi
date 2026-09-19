/**
 * 本地 OCR：为没有视觉能力的模型把图片转成文字（tesseract.js，纯 WASM，无原生依赖）。
 *
 * - 语言包（chi_sim 简体 + eng 英文）首次使用时联网下载一次，之后走本地缓存目录；
 * - worker 懒加载单例：不跑 OCR 就零开销，并发调用共用同一个实例；
 * - 识别失败抛错，由调用方决定降级行为（不影响消息主流程）。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** 本地 OCR 执行器：输入图片 Buffer，返回识别文本（空图/纯图无字返回 undefined）。 */
export type LocalOcrRunner = (image: Buffer) => Promise<string | undefined>;

/**
 * 创建本地 OCR 执行器。语言包缓存到 cacheDir（首次联网下载，之后离线可用）。
 * worker 在首次识别时才初始化，创建本执行器本身零开销。
 */
export function createLocalOcrRunner(options: {
  /** 语言包缓存目录（如 work_space/tmp/ocr） */
  cacheDir: string;
  /** 识别语言（tesseract 格式，默认 简体中文+英文） */
  languages?: string;
}): LocalOcrRunner {
  const languages = options.languages ?? "chi_sim+eng";
  let workerPromise: Promise<import("tesseract.js").Worker> | undefined;

  const ensureWorker = async () => {
    workerPromise ??= (async () => {
      await mkdir(options.cacheDir, { recursive: true });
      const { createWorker } = await import("tesseract.js");
      return createWorker(languages, 1, { cachePath: options.cacheDir });
    })();
    return workerPromise;
  };

  return async (image: Buffer) => {
    const worker = await ensureWorker();
    const { data } = await worker.recognize(image);
    const text = data?.text?.trim();
    return text || undefined;
  };
}

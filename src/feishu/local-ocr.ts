/**
 * 本地 OCR：为没有视觉能力的模型把图片转成文字（tesseract.js，纯 WASM，无原生依赖）。
 *
 * 磁盘约定（语言包是唯一需要落盘的 OCR 过程文件）：
 *   - 每个会话在自己的会话目录 `{会话目录}/ocr/` 放一份工作副本，tesseract 只读写这里，
 *     OCR 过程文件因此随会话目录一起被清理，不会散落在会话之外；
 *   - 语言包体积不小（中英文合计约 7.4MB），跨会话重复下载纯属浪费：共享目录
 *     `data/assets/ocr/` 作为种子缓存——用前从种子目录播种到会话目录，用后把新下载的
 *     语言包回存到种子目录（下次会话直接本地复制，不再联网）。
 *
 * worker 懒加载按会话目录缓存（并发调用共用同一个实例），不跑 OCR 就零开销；
 * 识别失败抛错，由调用方决定降级行为（不影响消息主流程）。
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";

/** 本地 OCR 执行器：输入图片 Buffer 与本会话的 OCR 过程目录，返回识别文本（空图/纯图无字返回 undefined）。 */
export type LocalOcrRunner = (image: Buffer, scratchDir: string) => Promise<string | undefined>;

/** 同时驻留的 OCR worker 上限（每个会话一个；OCR 只在无视觉模型上启用，通常寥寥无几） */
const MAX_WORKERS = 3;

/** 语言包文件名形态：tesseract.js 缓存的是解压后的 `{lang}.traineddata`，源包是 `.traineddata.gz` */
const LANG_FILE_PATTERN = /\.traineddata(\.gz)?$/;

/** 把目录下的语言包文件复制到目标目录（已存在的不覆盖；目录不存在静默跳过）。 */
async function copyLangFiles(from: string, to: string): Promise<void> {
  const names = await readdir(from).catch(() => [] as string[]);
  const langs = names.filter((name) => LANG_FILE_PATTERN.test(name));
  if (langs.length === 0) return;
  await mkdir(to, { recursive: true });
  const existing = new Set(await readdir(to).catch(() => [] as string[]));
  for (const name of langs) {
    if (existing.has(name)) continue;
    await copyFile(join(from, name), join(to, name)).catch(() => undefined);
  }
}

/**
 * 创建本地 OCR 执行器。
 * @param options.langCacheDir 共享语言包目录（如 data/assets/ocr）：会话目录从它播种，用后回存
 * @param options.languages    识别语言（tesseract 格式，默认 简体中文+英文）
 */
export function createLocalOcrRunner(options: {
  langCacheDir: string;
  languages?: string;
}): LocalOcrRunner {
  const languages = options.languages ?? "chi_sim+eng";
  /** 会话 OCR 过程目录 → worker（近似 LRU，超限终止最久未用者） */
  const workers = new Map<string, Promise<import("tesseract.js").Worker>>();

  const createFor = (scratchDir: string): Promise<import("tesseract.js").Worker> => {
    const task = (async () => {
      await mkdir(scratchDir, { recursive: true });
      // 先把共享语言包播种到会话目录：有种子就不必联网下载
      await copyLangFiles(options.langCacheDir, scratchDir);
      const { createWorker } = await import("tesseract.js");
      return createWorker(languages, 1, { cachePath: scratchDir });
    })();
    workers.set(scratchDir, task);
    // 创建失败（如语言包下载失败）不留在缓存里：下次调用重新尝试，而不是反复吃到同一个失败
    void task.catch(() => {
      if (workers.get(scratchDir) === task) workers.delete(scratchDir);
    });
    return task;
  };

  /** 取该会话的 worker；超过上限时先淘汰最久未用的那个 */
  const workerFor = (scratchDir: string): Promise<import("tesseract.js").Worker> => {
    const existing = workers.get(scratchDir);
    if (existing) {
      // 命中后移到队尾，保证淘汰的是真正最久未用的会话
      workers.delete(scratchDir);
      workers.set(scratchDir, existing);
      return existing;
    }
    if (workers.size >= MAX_WORKERS) {
      const oldestDir = workers.keys().next().value;
      const oldest = oldestDir !== undefined ? workers.get(oldestDir) : undefined;
      if (oldestDir !== undefined) workers.delete(oldestDir);
      void oldest?.then((worker) => worker.terminate()).catch(() => undefined);
    }
    return createFor(scratchDir);
  };

  return async (image: Buffer, scratchDir: string) => {
    const worker = await workerFor(scratchDir);
    const { data } = await worker.recognize(image);
    // 首次识别会联网下载语言包并缓存在会话目录：回存到共享目录，供后续会话直接复制
    await copyLangFiles(scratchDir, options.langCacheDir).catch((error) =>
      logger.warn("[LocalOcr] 语言包回存共享目录失败（不影响识别）", error),
    );
    const text = data?.text?.trim();
    return text || undefined;
  };
}

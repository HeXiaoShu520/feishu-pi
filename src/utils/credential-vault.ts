import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./logger.ts";

/**
 * 加密凭证库：所有 CLI（lark-cli / meegle / bitbucket …）按用户隔离的密钥统一落盘层。
 *
 * 线上格式（data/credentials/<provider>.vault.json）：整个记录表序列化为 JSON 后整体 AES-256-GCM 加密，
 * 落盘内容为 { version, salt, iv, tag, data }（全部 base64）。防的是"主体文件单独泄漏"
 * （备份 / 网盘同步 / 误提交），主密钥独立存放于环境变量或本机密钥文件。
 *
 * 密钥来源（优先级从高到低）：
 * 1. 打开参数 keyHex；
 * 2. 环境变量 MINI_PI_VAULT_KEY（64 位 hex = 32 字节）；
 * 3. 密钥文件（默认与库文件同目录的 .vault-key，首次自动生成并收紧权限）。
 *
 * 记录键为 `provider:userKey`（如 `lark:ou_xxx`），provider 之间命名空间互不可见，
 * 各 CLI 的凭证互不干扰；写入走串行队列 + 临时文件原子替换（与 JsonMapStore 同款约定）。
 */

const VAULT_VERSION = 1;
const DEFAULT_KEY_ENV = "MINI_PI_VAULT_KEY";

interface VaultEnvelope {
  version: number;
  /** scrypt 盐（base64） */
  salt: string;
  iv: string;
  /** GCM 认证标签（base64） */
  tag: string;
  /** AES-256-GCM 密文（base64），明文为 JSON 对象 { "provider:userKey": secret } */
  data: string;
}

const isHex64 = (v: string): boolean => /^[0-9a-fA-F]{64}$/.test(v.trim());
const b64 = (buf: Buffer): string => buf.toString("base64");
const unb64 = (v: string): Buffer => Buffer.from(v, "base64");

export class CredentialVault {
  private records = new Map<string, unknown>();
  private loadPromise?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly key: Buffer;
  private readonly keySource: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly keyFilePath: string;

  private constructor(filePath: string, keyHex: string | undefined, env: NodeJS.ProcessEnv, keyFilePath: string) {
    this.filePath = filePath;
    this.env = env;
    this.keyFilePath = keyFilePath;
    const fromEnv = (env[DEFAULT_KEY_ENV] ?? "").trim();
    const raw = keyHex ?? (isHex64(fromEnv) ? fromEnv : undefined);
    if (raw !== undefined) {
      if (!isHex64(raw)) {
        throw new Error(`[Vault] ${DEFAULT_KEY_ENV} 必须是 64 位 hex（32 字节），当前长度不合法`);
      }
      this.key = Buffer.from(raw, "hex");
      this.keySource = `env:${DEFAULT_KEY_ENV}`;
      return;
    }
    this.keySource = `file:${keyFilePath}`;
    this.key = this.loadOrCreateKeyFile();
  }

  /** 同路径共享同一实例：整文件加密重写下，多实例各自持写队列会互相覆盖丢数据 */
  private static readonly instances = new Map<string, CredentialVault>();

  static async open(
    filePath: string,
    opts: { keyHex?: string; env?: NodeJS.ProcessEnv; keyFile?: string } = {},
  ): Promise<CredentialVault> {
    const cached = CredentialVault.instances.get(filePath);
    if (cached) return cached;
    const env = opts.env ?? process.env;
    const keyFilePath = opts.keyFile ?? join(dirname(filePath), ".vault-key");
    const vault = new CredentialVault(filePath, opts.keyHex, env, keyFilePath);
    await vault.ensureLoaded();
    CredentialVault.instances.set(filePath, vault);
    logger.info(`[Vault] 凭证库就绪: ${filePath}（主密钥来源 ${vault.keySource}，共 ${vault.records.size} 条）`);
    return vault;
  }

  /** 读取某 provider 下某用户的凭证；不存在返回 undefined。 */
  async get<T = unknown>(provider: string, userKey: string): Promise<T | undefined> {
    await this.ensureLoaded();
    return this.records.get(this.compositeKey(provider, userKey)) as T | undefined;
  }

  /** 写入/覆盖某 provider 下某用户的凭证。 */
  async put(provider: string, userKey: string, secret: unknown): Promise<void> {
    await this.ensureLoaded();
    this.records.set(this.compositeKey(provider, userKey), secret);
    await this.persist();
  }

  /** 删除某 provider 下某用户的凭证；返回删除前是否存在。 */
  async delete(provider: string, userKey: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.records.delete(this.compositeKey(provider, userKey));
    if (existed) await this.persist();
    return existed;
  }

  /** 列出某 provider 下已有凭证的用户键（供后台保鲜遍历）。 */
  async listUsers(provider: string): Promise<string[]> {
    await this.ensureLoaded();
    const prefix = `${provider}:`;
    return Array.from(this.records.keys())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  private compositeKey(provider: string, userKey: string): string {
    return `${provider}:${userKey}`;
  }

  /** 密钥文件不存在则生成（64 位 hex）；返回主密钥字节。同步实现：构造期一次性成本。 */
  private loadOrCreateKeyFile(): Buffer {
    try {
      const hex = readFileSync(this.keyFilePath, "utf8").trim();
      if (isHex64(hex)) return Buffer.from(hex, "hex");
      logger.warn(`[Vault] 密钥文件 ${this.keyFilePath} 内容不合法，将重新生成（旧密文将无法解密！）`);
    } catch {
      /* 首次运行：文件不存在 */
    }
    const fresh = randomBytes(32).toString("hex");
    mkdirSync(dirname(this.keyFilePath), { recursive: true });
    writeFileSync(this.keyFilePath, `${fresh}\n`, { mode: 0o600 });
    logger.info(`[Vault] 已生成主密钥文件 ${this.keyFilePath}（建议改用环境变量 ${DEFAULT_KEY_ENV} 便于备份迁移）`);
    return Buffer.from(fresh, "hex");
  }

  /** 懒加载 + 解密；密文解析/解密失败直接抛错（换主密钥后旧库无法解密必须显式处理，不能静默清空）。 */
  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= (async () => {
      let raw: string;
      try {
        raw = await readFile(this.filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return;
      }
      const envelope = JSON.parse(raw) as VaultEnvelope;
      if (envelope.version !== VAULT_VERSION) {
        throw new Error(`[Vault] 凭证库版本不兼容: ${envelope.version}`);
      }
      const key = scryptSync(this.key, unb64(envelope.salt), 32);
      const decipher = createDecipheriv("aes-256-gcm", key, unb64(envelope.iv));
      decipher.setAuthTag(unb64(envelope.tag));
      const plain = Buffer.concat([decipher.update(unb64(envelope.data)), decipher.final()]).toString("utf8");
      this.records = new Map(Object.entries(JSON.parse(plain) as Record<string, unknown>));
    })();
    return this.loadPromise;
  }

  /** 串行原子写：整表加密 → 临时文件 → rename 替换。 */
  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync(this.key, salt, 32);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const plain = Buffer.from(JSON.stringify(Object.fromEntries(this.records)), "utf8");
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const envelope: VaultEnvelope = {
        version: VAULT_VERSION,
        salt: b64(salt),
        iv: b64(iv),
        tag: b64(cipher.getAuthTag()),
        data: b64(data),
      };
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = join(dirname(this.filePath), `.${Date.now()}-${process.pid}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}

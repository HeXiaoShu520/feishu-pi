/**
 * 静态凭证服务（Meegle / BBT 等）：由用户经卡片表单或指令提交、无刷新链路的凭证存取。
 *
 * 与 lark 不同：这类 token/密码由用户提供（平台后台/官方途径获取），
 * 失效后需要用户重新提交，因此不做后台保鲜。
 * 存储共用加密凭证库（CredentialVault），按 provider 分键空间（meegle:<openId> / bbt:<openId>）。
 *
 * 两种记录形态：
 * - submitToken：单 token 凭证（meegle，{accessToken, host, updatedAt}），peekToken 供 bash 注入；
 * - submitFields：多字段凭证（bbt 的 用户名+应用密码 等，{fields, updatedAt}），peekFields 取回。
 */
import { CredentialVault } from "../utils/credential-vault.ts";
import { logger } from "../utils/logger.ts";

/** Meegle CLI 的默认 host（project.feishu.cn 为飞书项目，meegle.com 为国际版） */
export const MEEGLE_DEFAULT_HOST = "project.feishu.cn";

/** 单 token 凭证记录（meegle 形态） */
export interface StoredTokenCredential {
  accessToken: string;
  host: string;
  updatedAt: number;
}

/** 多字段凭证记录（bbt 等形态） */
export interface StoredFieldsCredential {
  fields: Record<string, string>;
  updatedAt: number;
}

type StoredCredential = StoredTokenCredential | StoredFieldsCredential;

const isFieldsRecord = (r: StoredCredential): r is StoredFieldsCredential =>
  typeof (r as StoredFieldsCredential).fields === "object" && (r as StoredFieldsCredential).fields !== null;

export class StaticCredentialService {
  private readonly vaultFile: string;
  private readonly keyFile?: string;
  private readonly provider: string;
  /** 内存缓存：供会话 bash 的同步 spawnHook 读取 */
  private readonly mem = new Map<string, StoredCredential>();
  private loaded = false;

  constructor(vaultFile: string, keyFile?: string, provider = "meegle") {
    this.vaultFile = vaultFile;
    this.keyFile = keyFile;
    this.provider = provider;
  }

  private async vault(): Promise<CredentialVault> {
    const vault = await CredentialVault.open(this.vaultFile, { keyFile: this.keyFile });
    if (!this.loaded) {
      this.loaded = true;
      // 启动懒加载：把已存凭证填进内存缓存
      for (const openId of await vault.listUsers(this.provider)) {
        const record = await vault.get<StoredCredential>(this.provider, openId);
        if (record) this.mem.set(openId, record);
      }
    }
    return vault;
  }

  /** 保存用户的单 token 凭证（覆盖式：一个用户对同一 provider 只保留一份有效凭证）。 */
  async submitToken(openId: string, accessToken: string, host = MEEGLE_DEFAULT_HOST): Promise<void> {
    await this.put(openId, { accessToken, host, updatedAt: Date.now() });
  }

  /** 保存用户的多字段凭证（如 bbt 的 用户名+应用密码）。 */
  async submitFields(openId: string, fields: Record<string, string>): Promise<void> {
    await this.put(openId, { fields, updatedAt: Date.now() });
  }

  private async put(openId: string, record: StoredCredential): Promise<void> {
    await (await this.vault()).put(this.provider, openId, record);
    this.mem.set(openId, record);
    logger.info(`[CredAuth] 用户 ${openId} 的 ${this.provider} 凭证已存入加密凭证库`);
  }

  /** 同步读取单 token（bash spawnHook 用）；未登录返回 undefined。 */
  peekToken(openId: string): string | undefined {
    const record = this.mem.get(openId);
    return record && !isFieldsRecord(record) ? record.accessToken : undefined;
  }

  /** 同步读取多字段凭证（/login 状态展示用，不返回给模型明文场景请勿打日志）。 */
  peekFields(openId: string): Record<string, string> | undefined {
    const record = this.mem.get(openId);
    return record && isFieldsRecord(record) ? record.fields : undefined;
  }

  /** 清除用户的凭证；返回是否存在。 */
  async logout(openId: string): Promise<boolean> {
    const vault = await this.vault();
    const existed = await vault.delete(this.provider, openId);
    this.mem.delete(openId);
    return existed;
  }

  /** 是否已有凭证（不返回内容）。 */
  async hasToken(openId: string): Promise<boolean> {
    return Boolean(await (await this.vault()).get(this.provider, openId));
  }

  /** 导出本 provider 全部已知密钥值（历史会话文件清洗用；只进清洗器，不写日志）。 */
  async exportSecretValues(): Promise<string[]> {
    const vault = await this.vault();
    const values: string[] = [];
    for (const openId of await vault.listUsers(this.provider)) {
      const record = await vault.get<StoredCredential>(this.provider, openId);
      if (!record) continue;
      if (!isFieldsRecord(record)) {
        if (record.accessToken) values.push(record.accessToken);
      } else {
        values.push(...Object.values(record.fields).filter((v) => Boolean(v)));
      }
    }
    return values;
  }
}

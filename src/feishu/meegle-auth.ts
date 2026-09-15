/**
 * Meegle（飞书项目）凭证管理：/login meegle <token> 提交的静态 token 存取。
 *
 * 与 lark 不同：Meegle 的 token 由用户提供（平台后台/官方途径获取），
 * 没有 refresh 链路——失效后需要用户重新提交，因此不做后台保鲜。
 * 存储与 lark 共用同一个加密凭证库（CredentialVault 按 provider 分键：meegle:<openId>）。
 */
import { CredentialVault } from "../utils/credential-vault.ts";
import { logger } from "../utils/logger.ts";

const PROVIDER = "meegle";
/** Meegle CLI 的默认 host（project.feishu.cn 为飞书项目，meegle.com 为国际版） */
export const MEEGLE_DEFAULT_HOST = "project.feishu.cn";

export interface StoredMeegleCredential {
  accessToken: string;
  host: string;
  updatedAt: number;
}

export class MeegleCredentialService {
  private readonly vaultFile: string;
  private readonly keyFile?: string;
  /** 内存缓存：供会话 bash 的同步 spawnHook 读取 */
  private readonly mem = new Map<string, string>();
  private loaded = false;

  constructor(vaultFile: string, keyFile?: string) {
    this.vaultFile = vaultFile;
    this.keyFile = keyFile;
  }

  private async vault(): Promise<CredentialVault> {
    const vault = await CredentialVault.open(this.vaultFile, { keyFile: this.keyFile });
    if (!this.loaded) {
      this.loaded = true;
      // 启动懒加载：把已存凭证填进内存缓存
      for (const openId of await vault.listUsers(PROVIDER)) {
        const record = await vault.get<StoredMeegleCredential>(PROVIDER, openId);
        if (record?.accessToken) this.mem.set(openId, record.accessToken);
      }
    }
    return vault;
  }

  /** 保存用户的 Meegle token（覆盖式：一个用户对 Meegle 只保留一份有效凭证）。 */
  async submitToken(openId: string, accessToken: string, host = MEEGLE_DEFAULT_HOST): Promise<void> {
    const record: StoredMeegleCredential = { accessToken, host, updatedAt: Date.now() };
    await (await this.vault()).put(PROVIDER, openId, record);
    this.mem.set(openId, accessToken);
    logger.info(`[MeegleAuth] 用户 ${openId} 的 Meegle 凭证已存入加密凭证库`);
  }

  /** 同步读取（bash spawnHook 用）；未登录返回 undefined。 */
  peekToken(openId: string): string | undefined {
    return this.mem.get(openId);
  }

  /** 清除用户的 Meegle 凭证；返回是否存在。 */
  async logout(openId: string): Promise<boolean> {
    const vault = await this.vault();
    const existed = await vault.delete(PROVIDER, openId);
    this.mem.delete(openId);
    return existed;
  }

  /** 是否已有凭证（不返回内容）。 */
  async hasToken(openId: string): Promise<boolean> {
    return Boolean(await (await this.vault()).get(PROVIDER, openId));
  }
}

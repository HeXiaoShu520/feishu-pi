import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface LarkUserProfile {
  openId: string;
  englishName?: string;
  departmentIds: string[];
}

export type LarkCliStatus = "ready" | "missing" | "not_authenticated";

/** 调用项目本地 lark-cli，封装跨平台命令入口和身份错误。 */
export class LarkCli {
  private readonly profileDir: string;

  constructor(dataDir = join(process.cwd(), "memory", "users")) {
    this.profileDir = dataDir;
  }

  /** 检查 CLI 是否存在以及是否有可用身份。 */
  async status(): Promise<LarkCliStatus> {
    try {
      await this.exec(["--version"]);
    } catch {
      return "missing";
    }
    try {
      const result = JSON.parse(await this.exec(["auth", "status", "--format", "json"])) as { identities?: { bot?: { available?: boolean } } };
      return result.identities?.bot?.available ? "ready" : "not_authenticated";
    } catch {
      return "not_authenticated";
    }
  }

  /** 查询用户资料，并缓存到项目 memory/users 目录。 */
  async getUserProfile(openId: string): Promise<LarkUserProfile> {
    const cached = await this.readCached(openId);
    if (cached) return cached;
    const status = await this.status();
    if (status !== "ready") throw new Error(this.statusMessage(status));
    try {
      const raw = JSON.parse(await this.exec(["contact", "+get-user", "--as", "bot", "--user-id", openId, "--user-id-type", "open_id", "--format", "json"]));
      const user = raw?.data?.user;
      if (!user?.open_id) throw new Error("CLI 返回的用户资料缺少 open_id");
      const profile: LarkUserProfile = { openId: user.open_id, englishName: user.en_name || undefined, departmentIds: user.department_ids ?? [] };
      await mkdir(this.profileDir, { recursive: true });
      await writeFile(join(this.profileDir, `${encodeURIComponent(openId)}.json`), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
      return profile;
    } catch (error) {
      throw new Error(`无法获取用户 ${openId} 的英文名和部门信息：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 返回面向用户的 CLI 状态提示。 */
  statusMessage(status: LarkCliStatus): string {
    if (status === "missing") return "飞书 CLI 未安装，请先执行 npm install。";
    if (status === "not_authenticated") return "飞书 CLI 未登录或机器人身份不可用，请先执行 lark-cli auth login。";
    return "飞书 CLI 已就绪。";
  }

  private async exec(args: string[]): Promise<string> {
    const binPath = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "lark-cli.cmd" : "lark-cli");
    return new Promise((resolve, reject) => {
      const child = spawn(binPath, args, { shell: true, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`lark-cli exited with code ${code}: ${stderr}`));
      });
    });
  }

  private async readCached(openId: string): Promise<LarkUserProfile | undefined> {
    try {
      await access(join(this.profileDir, `${encodeURIComponent(openId)}.json`), constants.R_OK);
      return JSON.parse(await readFile(join(this.profileDir, `${encodeURIComponent(openId)}.json`), "utf8")) as LarkUserProfile;
    } catch {
      return undefined;
    }
  }
}

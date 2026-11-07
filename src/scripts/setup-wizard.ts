// npm run setup 的薄壳：解析 --new 参数，向导核心在 src/feishu/setup-wizard.ts
// （main() 上电自检复用同一实现：无配置启动时自动进入扫码开通）。
import "../bootstrap-env.ts"; // .env 缺失自动拷贝（先于 dotenv）
import "dotenv/config";
import { detectExistingAppId, runSetupWizard } from "../feishu/setup-wizard.ts";

async function main(): Promise<void> {
  const forceNew = process.argv.includes("--new");
  const existingAppId = forceNew ? undefined : detectExistingAppId();

  console.log(existingAppId
    ? `检测到已有应用 ${existingAppId}：扫码后将为其更新/补充预置权限（不会创建新应用）。`
    : "未检测到已配置的应用：扫码后将创建新应用并预置权限。");
  console.log("预置内容：机器人收发消息、通讯录基础只读、消息事件与卡片回调、Slash Command 管理权限。");

  await runSetupWizard({ existingAppId });

  console.log("\n下一步：");
  console.log("  1. 在 .env 配置 FEISHU_PI_OWNER=本人的 ou_...，并填写模型接口与密钥");
  console.log("  2. npm start；要用本人账号操作时显式启用 FEISHU_PI_USER_CLI=1，再私聊 /login lark");
  console.log("  3. 如开发者后台显示有待发布版本，请发布后权限方可全量生效");
}

void main().catch((error) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

import { resolve } from "node:path";
import { PersonaVersions } from "../resources/persona-versions.ts";
const versions = new PersonaVersions(resolve(process.cwd(), ".agent"));
const [action, id] = process.argv.slice(2);
try {
  if (action === "save") console.log(`已保存人格版本：${await versions.save()}`);
  else if (action === "list") console.log((await versions.list()).join("\n") || "暂无人格版本");
  else if (action === "restore" && id) console.log(`已恢复；恢复前版本：${await versions.restore(id)}。重启服务生效。`);
  else throw new Error("用法：npm run persona -- save | list | restore <版本ID>");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }

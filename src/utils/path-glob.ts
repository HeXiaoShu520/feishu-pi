import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * 路径 glob 共享工具：身份可读范围与白名单路径规则共用同一套匹配语义。
 * 约定：双星加斜杠 匹配零层或多层目录；双星 任意内容；单星 单段内任意；问号 单字符；
 * 无目录分隔符的条目（如 `.env`）匹配任意目录下的同名路径。
 */

/** 把路径 glob 编译为正则。 */
export function globToRegExp(glob: string): RegExp {
  const normalized = normalizeGlob(glob);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // 单遍替换：多步字符串 replace 会污染前一步插入的 `*`/`?` 字面量
  const source = escaped.replace(/\*\*\/|\*\*|\*|\?/g, (m) => {
    if (m === "**/") return "(?:.*/)?";
    if (m === "**") return ".*";
    if (m === "*") return "[^/]*";
    return "[^/]";
  });
  // `.env`、`**` 加 `.pem` 这类条目在任意层级生效；带具体目录前缀的条目从根锚定。
  // 大小写不敏感：deny 规则是安全边界，win32 文件系统大小写不敏感，
  // `Secret.PEM`/`.ENV` 这类变体必须同样命中（白名单侧宽松无害，后续仍有 Guard 兜底）。
  const anyDepth = !normalized.includes("/") || normalized.startsWith("**/");
  return new RegExp(anyDepth ? `^(?:.*/)?${source}$` : `^${source}$`, "i");
}

/**
 * 判断目标路径是否落在任一 glob 范围内。
 * 有 cwd 时测试归一化 rel 与 abs 两种形态（resolve 已消解 `..`，穿越路径不会被原始字符串误判）。
 *
 * @param globs  glob 列表（`./` 前缀与 `~/` 家目录在编译时展开）
 * @param target 目标路径（相对或绝对）
 * @param cwd    归一化基准目录；缺省时按原始路径匹配
 */
export function matchGlobs(globs: string[], target: string, cwd?: string): boolean {
  if (!target) return false;
  const regexps = globs.map((glob) => globToRegExp(expandPathSpecifier(glob)));
  if (!cwd) return regexps.some((re) => re.test(target.replace(/\\/g, "/")));
  const abs = (isAbsolute(target) ? target : resolve(cwd, target)).replace(/\\/g, "/");
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  return regexps.some((re) => re.test(rel) || re.test(abs));
}

function normalizeGlob(glob: string): string {
  return glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** 路径指示符归一化：`~/` 展开家目录、去掉 `./` 前缀。 */
function expandPathSpecifier(spec: string): string {
  if (spec.startsWith("~/")) {
    const home = homedir().replace(/\\/g, "/");
    return `${home}/${spec.slice(2)}`;
  }
  return spec.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 飞书原始消息中 SDK 归一化会遗漏的内容。这里只处理已收到的消息，不查询账号。 */

export interface InboundResource {
  type: string;
  fileKey: string;
  fileName?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

export function speechText(content: string, messageType: string): string | undefined {
  if (messageType !== "audio") return undefined;
  const value = record(parsed(content))?.speech_to_text;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** post 的附件区在顶层 files[]；SDK 只返回正文内 media/img 资源。 */
export function postAttachments(content: string, messageType: string): InboundResource[] {
  if (messageType !== "post") return [];
  const body = record(parsed(content));
  const locale = [body?.zh_cn, body?.en_us, body?.ja_jp].map(record).find(Boolean);
  const files = Array.isArray(body?.files) ? body.files : Array.isArray(locale?.files) ? locale.files : [];
  return files.flatMap((entry): InboundResource[] => {
    const file = record(entry);
    const fileKey = file?.file_key;
    if (typeof fileKey !== "string" || !fileKey) return [];
    return [{ type: "file", fileKey, fileName: typeof file.file_name === "string" ? file.file_name : undefined }];
  });
}

/** 消息 GET 对卡片 2.0 返回的 json_card / card 引用可能是多层 JSON 字符串。 */
export function cardReferenceId(content: string): string | undefined {
  const root = record(parsed(content));
  const data = record(root?.data);
  const cardId = data?.card_id ?? root?.card_id;
  return typeof cardId === "string" && cardId ? cardId : undefined;
}

/** 从卡片结构中按展示顺序提取人能读到的文本，不把按钮 value 等内部 JSON 当正文。 */
export function cardVisibleText(content: string): string | undefined {
  let root: unknown = parsed(content);
  if (typeof root === "string" && root.trim() && !root.trim().startsWith("{")) return root.trim().slice(0, 20_000);
  for (let i = 0; i < 4; i++) {
    const obj = record(root);
    const wrapped = obj?.json_card ?? obj?.card_json ?? obj?.card ?? (obj?.type === "card_json" ? obj.data : undefined);
    if (wrapped === undefined) break;
    root = parsed(wrapped);
  }
  const lines: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const line = value.trim();
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || lines.join("\n").length > 20_000) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    const obj = record(value);
    if (!obj) return;
    if (typeof obj.content === "string") add(obj.content);
    if (typeof obj.text === "string") add(obj.text);
    if (typeof obj.title === "string") add(obj.title);
    if (typeof obj.label === "string") add(obj.label);
    if (typeof obj.placeholder === "string" && obj.tag === "input") add(obj.placeholder);
    for (const key of ["header", "title", "subtitle", "body", "elements", "i18n_elements", "zh_cn", "en_us", "ja_jp", "property", "i18nContent", "fields", "columns", "rows", "actions", "text", "label", "options", "card"] as const) {
      const nested = obj[key];
      if (nested && typeof nested === "object") walk(nested, depth + 1);
    }
  };
  walk(root, 0);
  return lines.length ? lines.join("\n").slice(0, 20_000) : undefined;
}

export function personLabel(name: string | undefined, openId: string): string {
  const display = name?.trim() || openId;
  return display === openId ? openId : `${display}(${openId})`;
}

/** 飞书卡片附件会携带人物 ID → 可见姓名，优先用于展开卡片原文中的 @。 */
export function cardMentionNames(content: string): Map<string, string> {
  const root = record(parsed(content));
  const attachment = record(parsed(root?.json_attachment));
  const persons = record(attachment?.persons);
  const names = new Map<string, string>();
  for (const [id, value] of Object.entries(persons ?? {})) {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(id)) continue;
    const person = record(value);
    const name = person?.content ?? person?.name;
    if (typeof name === "string" && name.trim()) names.set(id, name.trim());
  }
  return names;
}

/** 卡片中的原生人物标签交给模型前展开为可读姓名和 open_id。 */
export function expandCardMentions(text: string, names: ReadonlyMap<string, string>): string {
  return text
    .replace(/<at\s+id=["']?(ou_[A-Za-z0-9_-]+)["']?\s*>(.*?)<\/at>/gi, (_tag, id: string, label: string) => personLabel(names.get(id) || label, id))
    .replace(/<at\s+user_id=["']?(ou_[A-Za-z0-9_-]+)["']?\s*>(.*?)<\/at>/gi, (_tag, id: string, label: string) => personLabel(names.get(id) || label, id));
}

/** 只用已经确认的 open_id 标注消息中的人名；不凭名字推断未知账号。 */
export function annotatePeople(text: string, people: ReadonlyArray<{ openId: string; name: string; alias?: string }>): string {
  const candidates = new Map<string, string | undefined>();
  for (const person of people) {
    for (const name of [person.alias, person.name]) {
      if (!name || name.length < 2 || name === person.openId) continue;
      candidates.set(name, candidates.has(name) && candidates.get(name) !== person.openId ? undefined : person.openId);
    }
  }
  const aliases = [...candidates].filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, openId]) => ({ name, openId })).sort((a, b) => b.name.length - a.name.length);
  return text.split(/(```[\s\S]*?```|`[^`\n]*`|^.*已保存到:.*$)/gm).map((part, index) => {
    if (index % 2) return part;
    let result = part;
    for (const { name, openId } of aliases) {
      const expression = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\([^)]*ou_[A-Za-z0-9_-]+\\))`, "g");
      result = result.replace(expression, `${name}(${openId})`);
    }
    return result;
  }).join("");
}

/** 模型输出的 姓名(open_id) 在飞书卡片里显示为原生蓝色人物；ID 只留在模型上下文。 */
export function renderCardPeople(text: string, people: ReadonlyArray<{ openId: string; name?: string; alias?: string }>): string {
  // 普通 text 消息的提及标签不能直接放进 CardKit Markdown。
  text = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part :
    part.replace(/<at\s+user_id=["']?(ou_[A-Za-z0-9_-]+)["']?\s*>[^<]*<\/at>/g, (_full, openId: string) =>
      `<at id=${openId}></at>`)).join("");
  const names = new Map<string, string | undefined>();
  for (const person of people) {
    for (const name of [person.name, person.alias]) {
      if (!name || name.length < 2 || name === person.openId) continue;
      names.set(name, names.has(name) && names.get(name) !== person.openId ? undefined : person.openId);
    }
  }
  const unique = [...names].filter((entry): entry is [string, string] => Boolean(entry[1]))
    .sort((a, b) => b[0].length - a[0].length);
  const escaped = unique.map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = escaped.length ? new RegExp(`@?(?:${escaped.join("|")})`, "gu") : undefined;
  return text.split(/(```[\s\S]*?```|`[^`\n]*`|<at\b[^>]*>[\s\S]*?<\/at>|^.*已保存到:.*$)/gm).map((part, index) => {
    if (index % 2) return part;
    let explicit = part;
    for (const person of people) {
      for (const name of [person.name, person.alias]) {
        if (name) explicit = explicit.replaceAll(`${name}(${person.openId})`, `<at id=${person.openId}></at>`);
      }
    }
    // 未进入本轮人物表的 ID 只有带 @ 的明确人物标记才变成提及，避免吞掉中文句子前缀。
    explicit = explicit.replace(/@[\p{L}\p{N}_ -]{1,64}\((?:[^,()]+,\s*)?(ou_[A-Za-z0-9_-]+)\)/gu, (_full, openId: string) =>
      `<at id=${openId}></at>`);
    // 模型偶尔忘记 @ 时仍隐藏内部 ID，保留原文姓名。
    explicit = explicit.replace(/\(ou_[A-Za-z0-9_-]+\)/g, "");
    // 流式中间帧可能停在 (ou_... 的半截，不能把 ID 片段显示到卡片上。
    explicit = explicit.replace(/\((?:[^,()\n]+,\s*)?ou_?[A-Za-z0-9_-]*$/g, "");
    if (!matcher) return explicit;
    return explicit.split(/(<at\b[^>]*>[\s\S]*?<\/at>)/g).map((piece, pieceIndex) => {
      if (pieceIndex % 2) return piece;
      return piece.replace(matcher, (hit) => {
        const openId = names.get(hit.startsWith("@") ? hit.slice(1) : hit);
        return openId ? `<at id=${openId}></at>` : hit;
      });
    }).join("");
  }).join("");
}

/** 普通文本兜底使用 text 消息的 @ 标签格式。 */
export function renderTextPeople(text: string, people: ReadonlyArray<{ openId: string; name?: string; alias?: string }>): string {
  const labels = new Map(people.filter((person) => (person.name && person.name !== person.openId)
    || (person.alias && person.alias !== person.openId))
    .map((person) => [person.openId, person.name && person.name !== person.openId ? person.name : person.alias || "用户"]));
  for (const match of text.matchAll(/<at\s+user_id=["']?(ou_[A-Za-z0-9_-]+)["']?\s*>([^<]*)<\/at>/g)) {
    if (!labels.has(match[1]!) && match[2] && !/^ou_[A-Za-z0-9_-]+$/.test(match[2])) labels.set(match[1]!, match[2]);
  }
  for (const match of text.matchAll(/@([\p{L}\p{N}_ -]{1,64})\((?:[^,()]+,\s*)?(ou_[A-Za-z0-9_-]+)\)/gu)) {
    if (!labels.has(match[2]!) && !/^ou_[A-Za-z0-9_-]+$/.test(match[1]!)) labels.set(match[2]!, match[1]!);
  }
  return renderCardPeople(text, people).split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part :
    part.replace(/<at\s+id=["']?(ou_[A-Za-z0-9_-]+)["']?\s*>[^<]*<\/at>/g, (_full, openId: string) =>
      `<at user_id="${openId}">${(labels.get(openId) || "用户").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</at>`)).join("");
}

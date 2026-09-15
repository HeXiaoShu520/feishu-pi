/**
 * Spinner 动画管理器
 * 提供多种 spinner 样式，每次随机选择一种并在该样式内逐帧循环。
 * 样式注册表唯一：思考动画（正文区）与工具动画（小字区）共用同一套样式。
 */

/** Spinner 样式注册表：key → 帧序列（默认全部启用；顺序即随机池） */
export const SPINNER_STYLES: Record<string, readonly string[]> = {
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  halfcircle: ["◐", "◓", "◑", "◒"],
  quarter: ["◴", "◷", "◶", "◵"],
  cross: ["⊢", "⊤", "⊣", "⊥"],
  triangle: ["▲", "▶", "▼", "◀"],
  dots: ["·", "··", "···"],
};

/** 启用的样式 key（默认全部启用；要停用某样式从这里删 key 即可） */
const ENABLED_STYLE_KEYS = Object.keys(SPINNER_STYLES);

/** 思考前缀池（随机选择） */
const THINKING_PREFIXES = [
  "思考中",
  "正在思考",
  "让我想想",
  "稍等一下",
  "分析中",
  "处理中",
  "计算中",
  "努力思考",
  "等一下",
];

/** 随机锁定一种启用的样式，返回其帧序列副本（一次回复内不再更换）。 */
export function randomFrames(): string[] {
  const key = ENABLED_STYLE_KEYS[Math.floor(Math.random() * ENABLED_STYLE_KEYS.length)]!;
  return [...SPINNER_STYLES[key]!];
}

/** 随机选择一个思考前缀 */
function randomPrefix(): string {
  return THINKING_PREFIXES[Math.floor(Math.random() * THINKING_PREFIXES.length)]!;
}

/** Spinner 实例：构造时锁定帧序列（默认随机一种）与前缀，next() 依次吐帧。 */
export class Spinner {
  private readonly frames: string[];
  private prefix: string;
  private frameIndex = 0;

  constructor(prefix?: string, frames?: readonly string[]) {
    this.prefix = prefix ?? randomPrefix();
    this.frames = [...(frames ?? randomFrames())];
  }

  /** 更新前缀（如工具切换时换"图标 + 工具名"），帧样式保持本回复锁定的那一种。 */
  withPrefix(prefix: string): this {
    this.prefix = prefix;
    return this;
  }

  /** 获取当前帧文本（前缀 + 符号） */
  next(): string {
    const frame = this.frames[this.frameIndex % this.frames.length]!;
    this.frameIndex++;
    return `${this.prefix} ${frame}`;
  }
}

/**
 * Spinner 动画管理器
 * 提供多种 spinner 样式，每次随机选择一种并循环显示
 */

/** Spinner 样式定义 */
interface SpinnerStyle {
  key: string;
  frames: string[];
  enabled: boolean;
}

/** 所有可用的 spinner 样式 */
const SPINNER_STYLES: SpinnerStyle[] = [
  { key: "braille", frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], enabled: true },
  { key: "halfcircle", frames: ["◐", "◓", "◑", "◒"], enabled: true },
  { key: "quarter", frames: ["◴", "◷", "◶", "◵"], enabled: true },
  { key: "cross", frames: ["⊢", "⊤", "⊣", "⊥"], enabled: true },
  { key: "triangle", frames: ["▲", "▶", "▼", "◀"], enabled: true },
  { key: "square", frames: ["▖", "▘", "▝", "▗"], enabled: true },
  { key: "braille2", frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], enabled: true },
  { key: "dots", frames: ["·", "··", "···"], enabled: false },
];

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

/** 随机选择一个启用的 spinner 样式 */
function randomSpinner(): SpinnerStyle {
  const enabled = SPINNER_STYLES.filter((s) => s.enabled);
  return enabled[Math.floor(Math.random() * enabled.length)];
}

/** 随机选择一个思考前缀 */
function randomPrefix(): string {
  return THINKING_PREFIXES[Math.floor(Math.random() * THINKING_PREFIXES.length)];
}

/** Spinner 实例 */
export class Spinner {
  private readonly style: SpinnerStyle;
  private readonly prefix: string;
  private frameIndex = 0;

  constructor() {
    this.style = randomSpinner();
    this.prefix = randomPrefix();
  }

  /** 获取当前帧文本（前缀 + 符号） */
  next(): string {
    const frame = this.style.frames[this.frameIndex % this.style.frames.length];
    this.frameIndex++;
    return `${this.prefix} ${frame}`;
  }

  /** 获取样式 key */
  getKey(): string {
    return this.style.key;
  }

  /** 获取前缀 */
  getPrefix(): string {
    return this.prefix;
  }
}

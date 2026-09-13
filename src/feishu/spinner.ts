/**
 * Spinner 动画管理器
 * 提供多种 spinner 样式，每次随机选择一种并循环显示
 */

/** 所有可用的 spinner 帧序列（等待动画时随机选一种循环播放） */
const SPINNER_FRAMES: string[][] = [
  ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], // braille
  ["◐", "◓", "◑", "◒"], // halfcircle
  ["◴", "◷", "◶", "◵"], // quarter
  ["⊢", "⊤", "⊣", "⊥"], // cross
  ["▲", "▶", "▼", "◀"], // triangle
  ["▖", "▘", "▝", "▗"], // square
  ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], // braille2
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

/** 随机选择一种帧序列 */
function randomFrames(): string[] {
  return SPINNER_FRAMES[Math.floor(Math.random() * SPINNER_FRAMES.length)];
}

/** 随机选择一个思考前缀 */
function randomPrefix(): string {
  return THINKING_PREFIXES[Math.floor(Math.random() * THINKING_PREFIXES.length)];
}

/** Spinner 实例：构造时随机锁定一种帧序列与一个前缀，next() 依次吐帧。 */
export class Spinner {
  private readonly frames: string[];
  private readonly prefix: string;
  private frameIndex = 0;

  constructor() {
    this.frames = randomFrames();
    this.prefix = randomPrefix();
  }

  /** 获取当前帧文本（前缀 + 符号） */
  next(): string {
    const frame = this.frames[this.frameIndex % this.frames.length];
    this.frameIndex++;
    return `${this.prefix} ${frame}`;
  }
}

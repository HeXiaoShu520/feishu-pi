export interface RestartToggleResult {
  content: string;
  action: "added" | "removed";
  before: number;
  after: number;
}

/** 在文件末尾连续空行上做一次加/减，给开发态文件监听器制造稳定的变更信号。 */
export function toggleTrailingBlankLine(content: string): RestartToggleResult {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r\n|\n/);
  let before = 0;
  for (let index = lines.length - 1; index >= 0 && lines[index].trim() === ""; index -= 1) before += 1;

  const action = before >= 3 ? "removed" : "added";
  if (action === "removed") lines.pop();
  else lines.push("");

  let after = 0;
  for (let index = lines.length - 1; index >= 0 && lines[index].trim() === ""; index -= 1) after += 1;
  return { content: lines.join(newline), action, before, after };
}

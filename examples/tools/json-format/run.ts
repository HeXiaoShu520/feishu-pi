// Independent business script: JSON stdin, JSON/text stdout, diagnostics on stderr.
try {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += String(chunk);
  const input = JSON.parse(source) as { text?: unknown };
  if (typeof input.text !== "string") throw new Error("text 必须是字符串");
  const formatted = JSON.stringify(JSON.parse(input.text), null, 2);
  process.stdout.write(JSON.stringify(formatted));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export {};

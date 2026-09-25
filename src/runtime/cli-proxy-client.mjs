import http from "node:http";

const [kind, ...args] = process.argv.slice(2);
const port = Number(process.env.FEISHU_PI_CLI_PROXY_PORT);
const key = process.env.FEISHU_PI_CLI_PROXY_KEY;
if (!port || !key || (kind !== "lark" && kind !== "meegle")) {
  process.stderr.write("CLI 身份通道不可用\n");
  process.exit(1);
}

const body = JSON.stringify({ kind, args, cwd: process.cwd() });
const request = http.request({
  hostname: "127.0.0.1",
  port,
  path: "/invoke",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Feishu-Pi-Key": key,
  },
});

let pending = "";
let completed = false;
request.on("response", (response) => {
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    pending += chunk;
    while (true) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line);
        if (frame.stream === "stdout" || frame.stream === "stderr") {
          const output = frame.stream === "stdout" ? process.stdout : process.stderr;
          output.write(Buffer.from(frame.data, "base64"));
        } else if (typeof frame.exitCode === "number") {
          process.exitCode = frame.exitCode;
          completed = true;
        }
      } catch {
        process.stderr.write("CLI 身份通道响应无效\n");
        process.exitCode = 1;
      }
    }
  });
  response.on("end", () => {
    if (!completed) {
      process.stderr.write("CLI 身份通道提前结束\n");
      process.exitCode = 1;
    }
  });
});
request.on("error", (error) => {
  process.stderr.write(`CLI 身份通道失败：${error.message}\n`);
  process.exitCode = 1;
});
request.end(body);

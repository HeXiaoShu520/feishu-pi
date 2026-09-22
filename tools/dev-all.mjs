import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// MiniPet 会通过 stdin/stdout 自己拉起 mini-claw；这里不再启动第二个占端口的服务。
const children = [
  spawn(npmCommand, ['run', 'minipet'], {
    stdio: 'inherit',
    env: { ...process.env, MINIPET_KERNEL_MODE: 'dev' },
  }),
];

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.killed) continue;
    if (process.platform === 'win32') {
      // MiniPet 下还有一个由 Python 拉起的 mini-claw 子进程，结束整个精确进程树，避免孤儿内核。
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 300);
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(`[dev:all] 子进程启动失败: ${error.message}`);
    stopAll(1);
  });
  child.on('exit', (code) => {
    if (!stopping && code && code !== 0) stopAll(code);
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

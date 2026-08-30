#!/usr/bin/env node
/**
 * 启动脚本：确保完全退出
 */

import { spawn } from 'child_process';

console.log(`[启动] 正在启动服务...`);
const child = spawn('npx', ['tsx', 'src/main.ts'], {
  stdio: 'inherit',
  shell: true,
});

console.log(`[启动] 服务已启动，PID: ${child.pid}`);

// 完全退出函数
let exiting = false;
const forceExit = async (signal) => {
  if (exiting) return;
  exiting = true;

  console.log(`\n[退出] 收到 ${signal} 信号，正在关闭...`);

  // 1. SIGTERM
  try {
    child.kill('SIGTERM');
  } catch (err) {
    console.warn(`[退出] SIGTERM 失败:`, err.message);
  }

  // 2. 等待 5 秒
  let killed = false;
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (child.killed || child.exitCode !== null) {
      killed = true;
      console.log(`[退出] 服务已退出`);
      break;
    }
  }

  // 3. SIGKILL 强制杀死
  if (!killed) {
    console.log(`[退出] 超时，强制杀死...`);
    try {
      child.kill('SIGKILL');
    } catch (err) {
      console.warn(`[退出] SIGKILL 失败:`, err.message);
    }
  }

  console.log(`[退出] 完成`);
  process.exit(0);
};

// 监听退出信号
process.on('SIGINT', () => forceExit('SIGINT'));
process.on('SIGTERM', () => forceExit('SIGTERM'));

// 子进程退出时退出
child.on('exit', (code) => {
  console.log(`[退出] 子进程退出，退出码: ${code}`);
  process.exit(code || 0);
});

// Windows 特殊处理
if (process.platform === 'win32') {
  import('readline').then(({ default: readline }) => {
    if (process.stdin.isTTY) {
      readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      }).on('SIGINT', () => forceExit('SIGINT'));
    }
  });
}

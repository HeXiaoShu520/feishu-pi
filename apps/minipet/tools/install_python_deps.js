const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const requirementsFile = path.join(projectRoot, 'requirements.txt');
const venvPython = process.platform === 'win32'
  ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
  : path.join(projectRoot, '.venv', 'bin', 'python');

function run(command, args) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: false,
  });
}

function findSystemPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]];

  for (const [command, args] of candidates) {
    const result = spawnSync(command, [...args, '--version'], { cwd: projectRoot, stdio: 'ignore', windowsHide: true });
    if (!result.error && result.status === 0) return { command, args };
  }
  return null;
}

function main() {
  if (!fs.existsSync(requirementsFile)) {
    console.error(`MiniPet: 找不到依赖文件：${requirementsFile}`);
    process.exit(1);
  }

  const systemPython = findSystemPython();
  if (!systemPython) {
    console.error('MiniPet: 找不到 Python 3，请先安装 Python 3.9-3.12。');
    process.exit(1);
  }

  if (!fs.existsSync(venvPython)) {
    console.log('MiniPet: 正在创建虚拟环境 .venv ...');
    const createResult = run(systemPython.command, [...systemPython.args, '-m', 'venv', '.venv']);
    if (createResult.error || createResult.status !== 0) process.exit(createResult.status || 1);
  }

  console.log('MiniPet: 正在安装 Python 依赖到 .venv ...');
  const installResult = run(venvPython, ['-m', 'pip', 'install', '-r', requirementsFile]);
  process.exit(installResult.error ? 1 : (installResult.status || 0));
}

main();

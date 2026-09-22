const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const entryFile = path.join(projectRoot, 'main.py');

const requiredModules = [
  ['apscheduler', 'apscheduler'],
  ['pynput', 'pynput'],
  ['tendo', 'tendo'],
  ['websockets', 'websockets'],
  ['requests', 'requests'],
  ['httpx', 'httpx'],
  ['sounddevice', 'sounddevice'],
  ['PySide6', 'PySide6'],
  ['PySide6-Fluent-Widgets', 'qfluentwidgets'],
  ['PySide6-WebEngine', 'PySide6.QtWebEngineWidgets'],
];

function printError(message) {
  console.error(`MiniPet: ${message}`);
}

function runPython(python, args) {
  return spawnSync(python.command, [...python.args, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function findPython() {
  const configured = process.env.MINIPET_PYTHON || process.env.PYTHON;
  if (configured) {
    const python = { command: configured, args: [], explicit: true };
    return runPython(python, ['--version']).error ? null : python;
  }

  const candidates = [
    { command: path.join(projectRoot, '.venv', 'Scripts', 'python.exe'), args: [] },
    { command: path.join(projectRoot, 'venv', 'Scripts', 'python.exe'), args: [] },
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] },
  ];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate.command) && !fs.existsSync(candidate.command)) continue;
    const result = runPython(candidate, ['--version']);
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function validatePython(python) {
  const versionResult = runPython(python, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
  if (versionResult.error || versionResult.status !== 0) {
    printError(`无法执行 Python：${python.command}`);
    return false;
  }

  const version = versionResult.stdout.trim();
  const [major, minor] = version.split('.').map(Number);
  if (major !== 3 || minor < 9) {
    printError(`Python 版本为 ${version}，需要 Python 3.9 或更高版本。`);
    return false;
  }

  const checkScript = `import importlib.util\nmissing = [name for package, name in ${JSON.stringify(requiredModules)} if importlib.util.find_spec(name.split('.')[0]) is None]\nprint('\\n'.join(missing))`;
  const dependencyResult = runPython(python, ['-c', checkScript]);
  if (dependencyResult.error || dependencyResult.status !== 0) {
    printError(`无法检查 Python 依赖：${dependencyResult.stderr || dependencyResult.error.message}`);
    return false;
  }

  const missing = dependencyResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (missing.length > 0) {
    printError(`缺少 Python 依赖：${missing.join(', ')}`);
    console.error(`请使用当前 Python 安装依赖：${python.command} -m pip install -r requirements.txt`);
    return false;
  }
  return true;
}

function main() {
  if (!fs.existsSync(entryFile)) {
    printError(`找不到启动入口：${entryFile}`);
    process.exit(1);
  }

  const python = findPython();
  if (!python) {
    printError('找不到可用的 Python 3。请安装 Python 3.9-3.12，或设置 MINIPET_PYTHON。');
    process.exit(1);
  }

  if (!validatePython(python)) process.exit(1);

  const child = spawn(python.command, [...python.args, entryFile], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('error', (error) => {
    printError(`启动失败：${error.message}`);
    process.exit(1);
  });
  child.on('close', (code) => process.exit(code === null ? 1 : code));
}

main();

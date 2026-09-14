---
kind: build_system
name: 基于 tsx + Vitest 的 Node.js 源码直跑构建体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - tsconfig.json
    - vitest.config.ts
    - scripts/patch-pi-ai.js
    - scripts/start.js
    - .env.example
---

## 1. 使用的系统/工具
- **运行时与编译**：项目不产出 JS 产物，采用 `tsx`（ESM）直接运行 TypeScript 源码。`package.json` 中 `type: "module"` 启用 ESM 模式，`tsconfig.json` 设置 `noEmit: true`，通过 `npx tsx src/main.ts` 启动。
- **类型检查**：`npm run check` 执行 `tsc --noEmit -p tsconfig.json`，仅做静态检查，不参与构建。
- **测试框架**：使用 `vitest`（v3），配置文件为根目录 `vitest.config.ts`，测试文件约定位于 `test/**/*.test.ts`。
- **依赖安装后处理**：通过 `postinstall` 钩子执行 `scripts/patch-pi-ai.js`，在 `node_modules` 内对第三方包 `@earendil-works/pi-ai` 的 `anthropic-messages.js` 进行补丁（删除导致中转站 403 的请求头），属于典型的 postinstall 热修补策略。
- **进程启动封装**：`scripts/start.js` 通过 `child_process.spawn` 拉起 `tsx src/main.ts`，并实现 SIGTERM/SIGINT 优雅退出、超时后 SIGKILL 强制终止、Windows TTY 信号兼容等容器化友好逻辑。

## 2. 关键文件
- `package.json`：定义脚本入口（`start` / `dev` / `config` / `check` / `test` / `postinstall`）、依赖与版本。
- `tsconfig.json`：TS 编译选项（target ES2022、NodeNext moduleResolution、strict、noEmit）。
- `vitest.config.ts`：测试用例包含规则。
- `scripts/patch-pi-ai.js`：postinstall 补丁脚本。
- `scripts/start.js`：带信号处理的进程启动器。
- `.env.example`：环境变量模板（配合 `dotenv` 加载）。
- `.gitignore`：忽略 `build/` 目录（尽管当前无构建产物）。

## 3. 架构与约定
- **零构建产物**：整个仓库没有 Makefile、Dockerfile、webpack/vite 构建配置或发布脚本；所有代码以 TS 源码形式被 `tsx` 直接解释执行，因此不存在跨平台编译、打包、产物分发流程。
- **开发/生产统一入口**：`npm start` 与 `npm dev` 均指向 `tsx`，区别仅在于是否开启 watch 模式；生产环境可通过 `scripts/start.js` 获得更健壮的进程生命周期管理。
- **配置加载**：应用侧通过 `dotenv` 读取 `.env`，并提供本地 `src/config-server.ts`（由 `npm run config` 启动）作为可视化配置页面。
- **测试组织**：单元测试集中在 `test/unit/`，集成/行为测试位于 `test/` 根目录，全部遵循 `*.test.ts` 命名约定，由 Vitest 自动发现。
- **依赖锁定**：使用 `package-lock.json` 锁定依赖树，未使用 pnpm/yarn lock 或其他锁文件。

## 4. 约定与约束
- **禁止 emit 产物**：`tsconfig.json` 显式设置 `noEmit: true`，意味着该仓库不允许生成 `.js` 输出文件；任何构建步骤都应保持源码直跑模式。
- **ESM 优先**：`type: "module"` 与 `module: "NodeNext"` 共同约束所有模块必须使用 ESM 语法（`import/export`），CommonJS 不被支持。
- **严格类型**：`strict: true` 启用所有严格检查，新增代码需通过 `npm run check` 的类型校验。
- **测试路径约定**：Vitest 配置将测试范围限定为 `test/**/*.test.ts`，其他位置的文件不会被当作测试执行。
- **postinstall 补丁可失败但不阻塞安装**：`patch-pi-ai.js` 捕获异常并仅输出 warning，确保第三方包升级或路径变更时 `npm install` 不会中断。
- **无 CI/CD 与发布流水线**：仓库中未发现 GitHub Actions、Jenkins、Makefile、Dockerfile、`npm publish` 脚本或版本号自动化逻辑；版本信息仅维护在 `package.json` 的 `version` 字段中。
- **产物目录约定**：`.gitignore` 忽略 `build/`，暗示若未来引入构建流程，产物应输出至该目录。
# 内化 MiniPet 桌面前端

这是 `mini-claw` 工程内置的 PySide6 桌面前端。它不再自带模型客户端，也不再连接 OpenClaw、Claude Code 或其他 Agent；所有对话、会话、工具、权限和流式回复都交给当前工程的 Pi 内核。MiniPet 启动时自动拉起 mini-claw 子进程，双方通过 stdin/stdout 的 JSONL 协议通信。

## 启动

在工程根目录执行：

```powershell
npm run dev:all       # 启动 MiniPet + mini-claw 热重载子进程
npm run minipet       # 启动桌面端，并自动拉起 mini-claw
```

前端依赖 Python 3.9+ 和 `requirements.txt` 中的桌面依赖。也可以在 `apps/minipet` 目录执行 `npm run dev`。

在 mini-claw 已有飞书和模型配置的基础上，还必须配置桌面端对应的真实飞书 Open ID：

```dotenv
MINIPET_USER_OPEN_ID=ou_xxxxxxxxxxxxxxxxxxxxxxxx
```

`MINIPET_USER_OPEN_ID` 是桌面端对应的真实飞书 Open ID。它用于服务端身份绑定和工具授权校验，不能只依赖桌面按钮本身。

## 当前职责边界

- MiniPet：桌宠窗口、聊天窗口、图片拖拽、语音输入/播报、回复卡片和本地交互。
- mini-claw：Pi AgentSession、模型调用、系统提示、技能、工具、会话持久化、权限策略、授权卡、定时任务和飞书身份。
- `backend_router.py`：唯一的桌面输入适配器，只发送 `user.input`，不创建模型线程。

## 协议

协议说明见 [MiniPet 当前协议设计.md](MiniPet%20当前协议设计.md)，工程侧接入说明见 [../../docs/minipet-integration.md](../../docs/minipet-integration.md)。

# 飞书 Bot 指令系统

## 概述

本项目实现了三个核心指令，用于在飞书中与 AI Bot 交互：

- `/model` - 查看并切换 AI 模型（仅管理员可切换）
- `/help` - 显示帮助信息
- `/new` - 清空当前对话历史，开始新对话

## 新增功能

### 1. @ 机器人标记过滤

在群聊中 @ 机器人时，系统会自动过滤掉 @ 标记，确保指令能正确识别。

**过滤规则：**
- 匹配 `<at user_id="bot_xxx"></at>` XML 标签
- 匹配 `@bot_xxx` 文本标记
- 自动 trim 处理

**示例：**
```
用户输入: @Bot /model
实际处理: /model
```

### 2. 管理员权限验证

**管理员识别：**
- 在 `.env` 中配置 `FEISHU_ADMIN`（Open ID / 姓名 / 邮箱）
- 系统自动解析并传递到所有消息上下文

**权限控制：**
- `/model` 指令：非管理员可查看模型列表，但点击按钮会提示权限不足
- 卡片回调事件：验证点击者的 Open ID 是否为管理员
- 非管理员点击按钮时，卡片更新为 "❌ 仅管理员可执行此操作"

**实现位置：**
- `FeishuContext.isAdmin` - 上下文中的管理员标识
- `LarkTransport` - 在消息和卡片回调中判断管理员身份

## 架构设计

### 文件结构

```
src/feishu/
├── commands.ts           # 指令处理器实现
├── agent-bridge.ts       # 集成指令识别和路由
└── types.ts

src/runtime/
├── conversation-manager.ts  # 添加 clear() 方法
└── conversation-store.ts    # 添加 delete() 方法
```

### 核心组件

#### 1. CommandHandler 接口

```typescript
export interface CommandHandler {
  /** 检测消息是否为此指令 */
  match(text: string): boolean;
  /** 执行指令，返回卡片 JSON */
  execute(message: FeishuInboundMessage, client: Client): Promise<CommandResult | null>;
}
```

#### 2. CommandRegistry 注册表

负责管理所有指令处理器，提供查找匹配的指令。

```typescript
export class CommandRegistry {
  register(handler: CommandHandler): void;
  find(text: string): CommandHandler | null;
}
```

#### 3. 指令处理流程

```
用户消息 → agent-bridge.handle()
         ↓
    检测是否为指令（commandRegistry.find()）
         ↓
    是指令 → handleCommand()
         ↓
    执行指令 → 发送 CardKit 卡片回复
```

## 指令详解

### `/model` - 模型切换

**功能：**
- 调用飞书 API `/open-apis/ai/v1/models` 获取可用模型列表
- 使用 CardKit 2.0 interactive 卡片展示模型列表
- 每个模型对应一个按钮，点击即可切换

**实现细节：**

```typescript
export class ModelCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/model";
  }

  async execute(message: FeishuInboundMessage, client: Client): Promise<CommandResult | null> {
    // 1. 调用飞书 API 获取模型列表
    const res = await client.request({
      method: "GET",
      url: "/open-apis/ai/v1/models",
    });

    // 2. 构建 CardKit 2.0 卡片
    const elements = [
      { tag: "markdown", content: "**可用模型列表**\n\n请选择要切换的模型：" },
      ...models.map((model) => ({
        tag: "button",
        width: "fill",
        text: { tag: "plain_text", content: model.name },
        behaviors: [
          {
            type: "callback",
            value: JSON.stringify({ action: "switch_model", model_id: model.model_id }),
          },
        ],
      })),
    ];

    return { card: { schema: "2.0", body: { elements } }, needsCallback: true };
  }
}
```

**CardKit 按钮结构：**

参考 dsh-lark-link 的实现，使用 Schema 2.0：

```typescript
{
  tag: "button",
  width: "fill",                    // 防止文本截断
  text: {
    tag: "plain_text",
    content: "模型名称"
  },
  behaviors: [
    {
      type: "callback",             // 交互式回调
      value: JSON.stringify({       // 自定义数据
        action: "switch_model",
        model_id: "model-123"
      })
    }
  ]
}
```

**TODO：**
- [x] 实现按钮点击回调处理（已监听 card action 事件）
- [x] 管理员权限验证（已实现）
- [ ] 在配置中保存选中的模型
- [ ] 显示当前使用的模型
- [ ] 实际的模型切换逻辑

### `/help` - 帮助信息

**功能：**
- 显示所有可用指令及其说明

**实现：**

```typescript
export class HelpCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/help";
  }

  async execute(): Promise<CommandResult | null> {
    return {
      card: {
        schema: "2.0",
        body: {
          elements: [
            {
              tag: "markdown",
              content: `**可用指令**

\`/model\` - 查看并切换 AI 模型
\`/help\` - 显示此帮助信息
\`/new\` - 开始新对话（清空历史）`,
            },
          ],
        },
      },
    };
  }
}
```

### `/new` - 清空对话历史

**功能：**
- 删除当前会话的所有历史记录
- 下次对话将从全新的上下文开始

**实现：**

```typescript
export class NewCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/new";
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    return {
      card: {
        schema: "2.0",
        body: {
          elements: [
            {
              tag: "markdown",
              content: "✅ 已清空对话历史，开始新的对话。",
            },
          ],
        },
      },
    };
  }
}
```

**关联修改：**

在 `agent-bridge.ts` 中特殊处理：

```typescript
private async handleCommand(message: FeishuInboundMessage, handler: CommandHandler): Promise<void> {
  // 特殊处理 /new 指令：清空会话
  if (message.text.trim() === "/new") {
    await this.conversations.clear(message.context.conversationId);
    logger.info(`[Command] 已清空会话: ${message.context.conversationId}`);
  }

  const result = await handler.execute(message, this.client);
  // ... 发送卡片回复
}
```

**ConversationManager.clear() 实现：**

```typescript
/** 清空指定会话的历史记录 */
async clear(conversationId: string): Promise<void> {
  // 删除映射和持久化
  this.conversations.delete(conversationId);
  await this.store?.delete(conversationId);
}
```

**ConversationStore.delete() 实现：**

```typescript
/** 删除会话映射。 */
async delete(conversationId: string): Promise<void> {
  await this.load();
  this.records.delete(conversationId);
  this.writeQueue = this.writeQueue.then(() => this.writeAtomically());
  await this.writeQueue;
}
```

## 使用方式

### 1. 发送指令

在飞书聊天窗口直接发送：

```
/help
```

Bot 会返回一个 CardKit 卡片，显示帮助信息。

### 2. 查看模型列表

```
/model
```

Bot 会返回可用模型列表，每个模型都有一个按钮。

### 3. 清空对话历史

```
/new
```

Bot 会清空当前会话的所有历史记录，并返回确认信息。

## 扩展指南

### 添加新指令

1. 在 `src/feishu/commands.ts` 中创建新的 `CommandHandler` 实现：

```typescript
export class MyCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/mycommand";
  }

  async execute(message: FeishuInboundMessage, client: Client): Promise<CommandResult | null> {
    // 你的逻辑
    return {
      card: {
        schema: "2.0",
        body: {
          elements: [{ tag: "markdown", content: "响应内容" }],
        },
      },
    };
  }
}
```

2. 在 `createDefaultRegistry()` 中注册：

```typescript
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(new ModelCommand());
  registry.register(new HelpCommand());
  registry.register(new NewCommand());
  registry.register(new MyCommand());  // 添加新指令
  return registry;
}
```

### 处理按钮回调

当前 `/model` 指令返回的卡片包含交互式按钮，但点击事件还需要实现。

**待实现的流程：**

1. 监听飞书 Card Action 事件
2. 解析 `behaviors[0].value` 中的 JSON 数据
3. 根据 `action` 类型执行相应操作
4. 更新卡片或发送新消息

**参考 dsh-lark-link 的实现：**

```typescript
// 监听卡片回调事件
channel.on("card_action", async (action) => {
  const value = JSON.parse(action.value);
  
  if (value.action === "switch_model") {
    // 切换模型
    await updateConfig({ modelId: value.model_id });
    // 更新卡片显示当前模型
    await client.request({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${action.open_message_id}`,
      data: {
        content: JSON.stringify({
          schema: "2.0",
          body: {
            elements: [
              {
                tag: "markdown",
                content: `✅ 已切换到模型：${value.model_id}`,
              },
            ],
          },
        }),
      },
    });
  }
});
```

## 技术要点

### 1. CardKit Schema 2.0

与旧版本的主要区别：
- 按钮不再使用 `action` 容器，直接放在 `body.elements` 数组中
- 使用 `behaviors: [{ type: "callback", value }]` 实现交互
- `width: "fill"` 防止文本截断

### 2. 指令优先级

在 `agent-bridge.ts` 的 `handle()` 方法中：

```typescript
async handle(message: FeishuInboundMessage): Promise<void> {
  // 1. 先检测指令
  const commandHandler = this.commandRegistry.find(message.text);
  if (commandHandler) {
    await this.handleCommand(message, commandHandler);
    return;  // 指令处理完直接返回，不进入 AI 对话流程
  }

  // 2. 正常的 AI 对话流程
  // ...
}
```

### 3. 会话清空机制

- `ConversationManager.clear()` 删除内存映射
- `ConversationStore.delete()` 删除持久化文件
- 下次对话时会创建全新的 Pi Session

## 参考资料

- [dsh-lark-link 按钮实现](E:\源丶工程\dsh-lark-link\src\presentation\cards.ts)
- [飞书 CardKit 2.0 文档](https://open.feishu.cn/document/ukTMukTMukTM/uEjNwUjLxYDM14SM2ATN)
- [飞书开放平台 API](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/im-v1/message)

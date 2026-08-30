# CardKit 流式卡片实现方案

feishu-pi 使用飞书 CardKit Schema 2.0 流式卡片实现实时打字机效果的 AI 回复。

## 核心流程

### 1. 创建卡片实体

使用 `cardkit.v1.card.create` 创建独立的卡片实体（不是消息），获取 `card_id`：

```typescript
const cardJson = {
  "schema": "2.0",
  "config": {
    "update_multi": true,
    "streaming_mode": true,
    "streaming_config": {
      "print_frequency_ms": {"default": 30},  // 客户端打字机速度：30ms/步
      "print_step": {"default": 3},           // 每步显示 3 个字符
      "print_strategy": "fast"
    }
  },
  "body": {
    "elements": [{
      "tag": "markdown",
      "content": " ",
      "element_id": "stream_md"  // 必须指定 element_id 用于后续更新
    }]
  }
};

const res = await client.request({
  method: "POST",
  url: "/open-apis/cardkit/v1/cards",
  data: { type: "card_json", data: cardJson }
});

const cardId = res.data.card_id;
```

**关键配置：**
- `streaming_mode: true` - 开启客户端打字机渲染
- `print_frequency_ms: 30` - 客户端每 30ms 显示一次
- `print_step: 3` - 每次显示 3 个字符
- `element_id: "stream_md"` - 必须指定，用于后续按 ID 更新内容

### 2. 发送消息引用卡片

用 `msg_type: "interactive"` 发送消息，`content` 引用 `card_id`：

```typescript
await client.im.message.reply({
  path: { message_id: incomingMessageId },
  data: {
    msg_type: "interactive",
    content: JSON.stringify({
      type: "card",
      data: { card_id: cardId }
    }),
    reply_in_thread: true
  }
});
```

**核心区别：**
- 旧方案（interactive Patch）：卡片内容直接在 `content` 里，每次更新整个卡片
- 新方案（CardKit）：`content` 只引用 `card_id`，卡片是独立实体

### 3. 流式更新内容

使用 `cardkit.v1.card_element.content` 只更新元素内容：

```typescript
await client.request({
  method: "PUT",
  url: `/open-apis/cardkit/v1/cards/${cardId}/elements/stream_md/content`,
  data: {
    content: fullText,        // 全量文本
    sequence: ++sequence,     // 单调递增的序号
    uuid: generateUuid()
  }
});
```

**sequence 管理：**
- 必须单调递增
- 飞书客户端用它保证乱序到达时按正确顺序渲染
- 每次更新（包括内容更新和配置更新）都要递增

**打字机效果：**
- 服务端只管推送全量文本，不用自己做打字机
- 客户端根据 `streaming_config` 自动逐字渲染
- 网络开销小，只传文本增量

### 4. 关闭流式模式

内容推完后，用 `cardkit.v1.card.settings` 关闭流式：

```typescript
// 1. 等待客户端渲染完成（避免打字机动画被截停）
const renderWaitMs = Math.min(3000, fullText.length * 25);  // 25ms/字，最多 3 秒
await new Promise(resolve => setTimeout(resolve, renderWaitMs));

// 2. 关闭流式模式
await client.request({
  method: "PATCH",
  url: `/open-apis/cardkit/v1/cards/${cardId}/settings`,
  data: {
    settings: JSON.stringify({ config: { streaming_mode: false } }),
    sequence: ++sequence,
    uuid: generateUuid()
  }
});
```

**为什么要等待：**
- 服务端推送的是全量文本，客户端按配置逐字显示
- 如果立即关流，客户端还没渲染完就停止了
- 按 25ms/字估算等待时间，确保客户端渲染完成

## 思考动画实现

### 动画帧设计

在真实内容到来前，显示随机选择的 spinner 动画：

```typescript
const animations = [
  { frames: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", text: "思考中" },
  { frames: "◐◓◑◒", text: "正在思考" },
  { frames: "⣾⣽⣻⢿⡿⣟⣯⣷", text: "思考中" },
  { frames: "⠁⠂⠄⡀⢀⠠⠐⠈", text: "努力思考" },
  { frames: "▁▂▃▄▅▆▇█▇▆▅▄▃▂", text: "思考中" },
  { frames: "◴◷◶◵", text: "等一下" },
  { frames: "◰◳◲◱", text: "思考中" },
  { frames: "▖▘▝▗", text: "正在思考" },
  { frames: "←↖↑↗→↘↓↙", text: "思考中" },
  { frames: "▌▀▐▄", text: "思考中" }
];
```

### 动画更新逻辑

```typescript
let animationIndex = 0;
let hasRealContent = false;

// 每 150ms 更新一帧
const animationTimer = setInterval(() => {
  if (!hasRealContent) {
    animationIndex++;
    const frame = selectedAnimation.frames[animationIndex % selectedAnimation.frames.length];
    // 用 replace() 替换内容，不累加
    reply.replace(`${selectedAnimation.text} ${frame}`);
  }
}, 150);

// 收到真实内容时停止动画
if (event.type === "assistant_text") {
  if (!hasRealContent) {
    hasRealContent = true;
    clearInterval(animationTimer);
    // 清空累积器，从头开始推送真实内容
    reply.stream.accumulator = "";
  }
  
  // 累加真实内容增量
  const delta = event.text.slice(prevText.length);
  if (delta) await reply.update(delta);
}
```

### replace vs update

**CardKitStream 提供两种更新方法：**

1. **`patch(delta)`** - 累加增量文本
   - 适用于真实内容的流式推送
   - 内部：`accumulator += delta`
   - 有节流保护（默认 800ms）

2. **`replace(text)`** - 替换全部内容
   - 适用于动画帧更新
   - 内部：`accumulator = text`（不累加）
   - 无节流，立即推送

**为什么动画要用 replace：**
- 每帧都是独立的完整内容："思考中 ⠋" → "思考中 ⠙"
- 如果用 `patch()` 会累加："思考中 ⠋思考中 ⠙思考中 ⠹..."
- `replace()` 每次清空 `accumulator` 再推送，确保只显示当前帧

## 表情反馈

在等待期间添加表情，回复完成后移除：

```typescript
// 添加表情
const reactionId = await client.im.message_reaction.create({
  path: { message_id: messageId },
  data: {
    reaction_type: { emoji_type: "THINKING" }  // 或随机选择其他表情
  }
});

// 回复完成后移除
await client.im.message_reaction.delete({
  path: { message_id: messageId, reaction_id: reactionId }
});
```

## 与旧方案对比

| 功能 | 旧方案（interactive Patch） | 新方案（CardKit Schema 2.0） |
|------|---------------------------|----------------------------|
| 卡片创建 | `im.v1.message.create` 发送完整卡片 JSON | `cardkit.v1.card.create` 创建独立实体 |
| 卡片更新 | `im.v1.message.patch` 整个卡片重发 | `cardkit.v1.card_element.content` 只更新元素 |
| 打字机效果 | 服务端每隔几百毫秒 patch 一次 | 客户端原生渲染，服务端只推全量文本 |
| 网络开销 | 每次传整个卡片 JSON | 只传增量文本内容 |
| Markdown 支持 | 有限（部分元素不渲染） | 完整支持（schema 2.0 原生） |
| 卡片和消息关系 | 卡片就是消息内容 | 卡片是独立实体，消息只引用 |
| 响应速度 | 较慢（网络往返 + 整卡片渲染） | 快（只传文本 + 客户端增量渲染） |

## 实现文件

- `src/feishu/cardkit-stream.ts` - CardKit 流式卡片核心实现
- `src/feishu/cardkit-reply.ts` - 回复包装器（失败时降级为文本）
- `src/feishu/agent-bridge.ts` - 思考动画逻辑
- `src/feishu/reaction-controller.ts` - 表情反馈控制

## 飞书后台权限要求

- `cardkit:card:write` - 创建和更新 CardKit 卡片
- `im:message:send_as_bot` - 发送消息
- `im:message.reactions:write_as_bot` - 添加/删除表情（可选）

## 参考资料

- [飞书 CardKit 2.0 文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit/cardkit-overview)
- [流式卡片开发指南](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit/streaming-card)
- [feishu-claude-bridge 实现参考](https://github.com/your-org/feishu-claude-bridge)

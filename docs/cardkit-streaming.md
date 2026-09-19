# CardKit 回复实现

## 分层

- `FeishuAgentBridge` 管理一轮回复、动画与工具事件。
- `ReplyParts` 组装正文和工具摘要；默认精简模式，`/detail on` 保留过程。
- `CardKitReply` 负责发送卡片引用、分卡、关闭和撤回。
- `CardKitStream` 负责卡片实体、元素更新、序号与写队列。

## 请求顺序

1. `POST /open-apis/cardkit/v1/cards` 创建 Schema 2.0 卡片，`data` 是序列化的卡片 JSON。
2. 通过 interactive 消息引用 `card_id`。话题群始终设置 `reply_in_thread: true`；其他会话有 threadId 时才设置。
3. 正文更新使用 `PUT /cards/{id}/elements/stream_md/content`，提交全量文本；小字使用 `stats_md`。更新携带递增 sequence 和独立 uuid。
4. 收尾使用 `PUT /cards/{id}`，一次提交最终正文、统计与 `streaming_mode: false`，不再固定等待 3 秒。

正文增量先累积，默认每 400ms 推送；动画更新只改展示，不进入正文累积器。客户端打字机参数为 30ms / 3 字符。写队列保证卡片更新顺序；中断、初始化失败及收尾都释放定时器。

## 展示

工具执行超过 1 秒才展示摘要；快速调用不刷过程卡。统计小字来自 Pi Session，显示模型、累计 token、累计费用、耗时和会话别名。`FEISHU_SHOW_MODEL_STATS=0` 只关闭最终统计，不关闭工具状态。

内容默认超过 10000 字符时，尝试在非代码围栏内的段落边界分卡；无法找到边界时继续累积。这不是飞书接口长度上限的完整处理方案，超长单段和超长代码块仍需要真实环境回归。

当前只使用 CardKit，不自动降级为文本。卡片接口失败记录错误；单次正文更新可尝试重新打开流式模式，最终整卡更新失败会向上抛出。

## 验证

自动化覆盖事件排序、文本分段、话题回复、收尾和取消时定时器释放。正式部署前还需在飞书客户端验证短回复、长回复、工具卡、`/stop`、授权卡与网络失败后的显示。

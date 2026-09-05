# Issue 草稿：node-sdk 卡片回调（card.action.trigger）应答数据丢失 + 去重静默吞事件

> 以下内容可直接提交到 https://github.com/larksuite/node-sdk/issues
> 标题建议：Card callback (card.action.trigger) response has no data and duplicate clicks are silently dropped via LarkChannel

---

## 环境

- `@larksuiteoapi/node-sdk`: 1.73.0 / 1.73.3（最新版未修复）
- 传输方式：WebSocket 长连接（`createLarkChannel` / `WSClient`）

## 问题 1：LarkChannel 的卡片回调应答帧永远没有 data

飞书客户端点击卡片按钮后，要求回调在超时内返回带数据的应答（toast / 更新后的卡片），否则客户端展示「目标回调服务超时未响应」。

对比 Go 官方 SDK（`oapi-sdk-go/v3/ws/client.go`）：

```go
case MessageTypeEvent:
    rsp, err = c.eventHandler.Do(ctx, pl)
...
if rsp != nil { // for cardCallback
    resp.Data, err = json.Marshal(rsp)   // handler 返回值进应答
}
```

而 node-sdk 的 `LarkChannel`（`es/index.js` 内部 dispatcher）：

```js
'card.action.trigger': (raw) => __awaiter(this, ..., function* () {
    ...
    yield this.safety.pushAction(..., () => __awaiter(this, ..., function* () {
        const h = this.handlers.cardAction;
        if (h)
            yield h(evt);        // ← 只执行，不 return；应答帧永远没有 data
    }));
}),
```

`WSClient.handleEventData` 只有在 `result` 非空时才写入 `respPayload.data`，
因此通过 `LarkChannel.on("cardAction", handler)` 注册的 handler 无论返回什么，
客户端都会收到无数据应答并弹「目标回调服务超时未响应」。

## 问题 2：safety.pushAction 静默丢弃重复/处理中的卡片事件（无任何应答）

```js
if (yield this.seenCache.has(eventId)) return;      // 去重窗口内 → 静默 return
if (!this.lock.acquire(eventId)) return;            // 处理中 → 静默 return
```

被丢弃的事件同样走到 `WSClient` 的无数据应答。用户在 10 分钟去重窗口内
重复点击同一按钮时，表现为：客户端反复弹「目标回调服务超时未响应」，
服务端零日志（handler 不会被调用）。

## 复现

1. `createLarkChannel` + WebSocket 长连接，订阅 `card.action.trigger`
2. 发送一张带 callback 按钮的卡片，点击按钮
3. 观察客户端 toast 与应答帧 data 字段
4. 10 分钟内再次点击同一按钮，观察服务端无任何日志、客户端再次弹超时

## 期望

- `LarkChannel.on("cardAction", handler)` 支持 handler 返回值
  （`{ toast }` 或 `{ card }` 结构）并写入 ACK 数据体，与 Go SDK 行为对齐
- 去重丢弃时至少返回一个带空 data 的 ACK，避免客户端弹「超时未响应」

## 备注

底层 `WSClient` + 自建 `EventDispatcher` 的方式不受影响
（`EventDispatcher.invoke` 会返回 handler 返回值），
但这样需要自行实现 LarkChannel 的消息归一化、去重与队列，成本较高。

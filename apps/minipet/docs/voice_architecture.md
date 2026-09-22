# MiniPet 语音架构

本文档描述语音识别（ASR）、语音聊天与日常语音输入三条链路的设计，重点说明
"每轮独立 SAUC 会话 + 按需快速建连 + 连接期缓冲" 的核心机制及其原因。

## 一、协议约束（一切设计的出发点）

MiniPet 使用火山引擎 SAUC 流式语音识别（`bigmodel_async`），该协议的规定：

| 规则 | 含义 |
|---|---|
| 一条 WebSocket = 一个识别会话 | 首帧配置 → 音频流 → 末帧 → 会话结束，无 "reset/新会话" 控制帧 |
| 约 8 秒无音频即断开 | 服务端行为，无法关闭；意味着空闲连接寿命只有约 8 秒 |
| 末帧后服务端仍会推送 final | 客户端必须收完才能关闭，否则丢末尾文字 |
| 按 `sauc.duration` 时长计费 | 不能用静音帧保活（烧钱且污染识别上下文） |

由此得出两条不可违反的原则：

1. **禁止跨轮复用会话** —— 服务端上下文连续，复用会导致上一轮结果混入下一轮。
2. **禁止静音保活** —— 时长计费且破坏会话语义。

## 二、核心机制：三层配合

### 1. 每轮独立会话（正确性）

收到 final / 用户停止 / 超时 → 当前 worker `finish()`（发末帧）→ 进入 closing
集合只负责收末尾 final → 下一轮使用全新 worker。

### 2. 按需建连（速度）

曾采用"轮次结束立即预建下一条 standby"的方案；实测发现服务端约 8 秒就
掐断空闲连接，预建命中率极低，而 ASR/TTS 直连系统代理后握手仅约 200ms，
建连成本可忽略——已改为每轮按需建连，不再预建。
空闲连接被服务端断开是**正常事件**：静默废弃，不弹错误、不自动重建。

### 3. 连接期缓冲（体验）

连接已就绪（预连接时代残留的活连接或刚握手完成）时，按下瞬间先开麦，
音频缓冲进本地队列（上限 80 帧 ≈ 16 秒，满则丢最旧），随后按序补发。
冷启动轮次在握手完成（约 200ms）后才开麦，这段空窗由语音球的
connecting→listening 状态如实表达（动画默认屏蔽，见 config 开关）。

## 三、模块职责

```
src/clients/asr_client.py          AsrWorker(QThread) + AsrSession
                                   SAUC 协议打包/解析、WebSocket 收发、
                                   麦克风采集、按下即采的缓冲补发
src/clients/asr_round_pool.py      AsrRoundPool（两个控制器共用的轮次池）
                                   活跃 worker + closing 集合、按需建连、
                                   信号绑定 worker 身份、shutdown 清理
src/voice_controller.py            语音聊天：语音球状态机、唤醒词、提交 mini-claw 内核
src/daily_input_controller.py      日常输入：中键触发、输入浮窗、文字注入
src/audio_resource_coordinator.py  麦克风互斥（voice_chat / daily_input）
src/log_util.py                    统一日志（[时间] [模块] 消息）
```

### AsrRoundPool 关键约定

- **worker_factory 注入**：控制器以 `lambda parent: AsrWorker(parent=parent)`
  传入，测试可 patch 各自模块的 `AsrWorker`。
- **handlers 回调**：`status/text/final/error` 签名 `(worker, payload)`，
  `finished` 签名 `(worker, branch)`；`branch ∈ {'closing','active'}`。
- **信号绑定身份**：lambda 捕获 `source=worker`，旧轮延迟回包携带自己的身份，
  owner 据此过滤，绝不污染新一轮。
- **finish_round 不释放音频资源**：由 owner 按自身节奏释放
  （语音聊天立即释放；日常输入等 closing 收完 final 再释放）。

## 四、时序图（日常输入一轮）

```
按下中键
  ├─ pool.discard_dead_active()      # 丢弃已死 standby
  ├─ try_acquire('daily_input')      # 麦克风互斥
  ├─ pool.start_recording()          # 有活连接→立即录；否则新建+握手后开麦
  └─ 浮窗显示

再次按下
  ├─ 暂存 _pending_inject_text
  ├─ pool.finish_round()             # worker→closing，finish 发末帧
  ├─ _closing_rounds[worker] = 本轮文本   # 文本缓冲按 worker 隔离
  └─ 恢复唤醒词监听

旧 worker 收到末尾 final
  └─ 只写 _closing_rounds[worker]，绝不碰新一轮

worker finished(branch='closing')
  └─ 注入该轮自己的文本（仅一次），释放麦克风资源
```

## 五、实测数据（2026-09）

| 场景 | 耗时 |
|---|---|
| 直连握手（默认路径，已显式绕过系统代理） | 170~220 ms |
| 走系统代理的握手（旧路径，已规避） | 5.7~6.3 s |
| 末帧 → final 回包 | < 300 ms |

## 六、故障排查

日志格式 `[时间] [voice.xxx] 消息`，关注三类信号：

- `WebSocket 握手耗时 X ms`（voice.asr）：已显式直连，正常约 200ms；持续 >1s 检查网络/DNS
- `standby 连接失效，静默废弃`（voice.chat / voice.daily_input）：正常现象
- `忽略旧录音结果`（voice.daily_input）：出现说明曾发生快速切换，属预期过滤

## 七、唤醒词：sherpa-onnx 神经网络 KWS

`clients/kws_client.py` 提供 Zipformer 流式关键词唤醒（音素级匹配，
抗语速/音量/距离变化，误唤醒低），由 VoiceController 直接使用。

- 模型约 40MB 不入 git，用 `python tools/download_kws_model.py` 获取；
  未下载时唤醒开关启动会给出下载提示
- 监听失败（依赖缺失、麦克风被独占等）每 30 秒自动重试，恢复后自动重新武装
- 唤醒词在 `res/wake/keywords.txt` 中以拼音 token 配置，
  例如 `x iǎo y uè x iǎo y uè @小月小月 :1.5`（冒号后为增强权重）

## 八、已知边界

- 停顿超过约 8 秒后，下一轮需要重新建连（直连约 200ms），协议决定，无法消除。
- 冷连接握手完成前麦克风不采集，开头约 0.2 秒不录；活连接场景不受影响。
- "零等待 + 强隔离"在直连后基本兼得：握手成本已低到不再需要预连接换取速度。

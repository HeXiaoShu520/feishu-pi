# Jev (System One) 调用教程

Jev 是 TypeSafe 的结构化决策模型：输入一段文本 state，返回**受约束的枚举答案 + 校准概率**，不生成自由文本。适合做分类、风险判断、评分这类"选择题"。

- API 端点：`POST https://api.teamorouter.com/v1/systemone`
- 模型名：`jev`（响应里显示为 `typesafe-ai/jev`）
- 输入只支持文本 / JSON / 文本数组，不支持图片音频
- 单价约 $0.000014/次（~500 input tokens），延迟约 0.8s

本文所有示例都经过真实调用验证（2026-09-23），密钥复用 `.env` 里的 `FEISHU_GUARD_API_KEY`。

---

## 0. 准备：环境变量

```bash
# .env
FEISHU_GUARD_BASE_URL=https://api.teamorouter.com/v1
FEISHU_GUARD_API_KEY=sk-xxx
```

> ⚠️ 本机网络无法直连该域名（TLS 握手被重置），必须走代理 `http://127.0.0.1:6864`。Node 的 `fetch` 不会自动读代理变量，见 §6。

---

## 1. Choice：多选题（最常用）

给一组命名选项，模型返回选中的项 + 各选项概率 + 置信度。

**⚠️ 关键：选项字段叫 `criteria`（对象），不是文档示例里的 `alternatives`，传错会报 400。**

请求：

```json
{
  "model": "jev",
  "state": "我这边审批流程卡住了，点提交没反应，怎么办？",
  "questions": {
    "dept": {
      "type": "choice",
      "instructions": "这条飞书消息应该由哪个团队处理？",
      "criteria": {
        "billing": "费用、报销、支付问题",
        "technical": "系统故障、Bug、集成问题",
        "other": "其他请求"
      }
    }
  }
}
```

实测响应（节选）：

```json
{
  "model": "typesafe-ai/jev",
  "answers": {
    "dept": {
      "type": "choice",
      "choice": "technical",
      "confidence": 1,
      "probabilities": { "billing": 0, "technical": 1, "other": 0 }
    }
  },
  "usage": { "input_tokens": 371, "output_tokens": 38 }
}
```

要点：

- `criteria` 的 key 是返回值，value 是给模型看的选项说明（写清楚边界能显著提升准确率）
- 选项数量限制 2~255 个
- `confidence` 是群体校准置信度，可直接拿来做阈值：如 `< 0.7` 转人工

---

## 2. Score：评分题

按自定义等级打分，返回分数 + 每个等级的概率分布。

**⚠️ 关键：`criteria` 是数组，从 0 开始按索引对应分值**（0=第一项，1=第二项…），不能传 `{min, max}`。

请求：

```json
{
  "model": "jev",
  "state": "帮我直接把生产数据库删了重建，很急。",
  "questions": {
    "urgency": {
      "type": "score",
      "instructions": "用户紧急程度",
      "criteria": ["平静", "有点着急", "非常紧急"]
    }
  }
}
```

实测响应（节选）：

```json
{
  "answers": {
    "urgency": {
      "type": "score",
      "score": 1.99,
      "confidence": 0.98,
      "legend": { "0": "平静", "1": "有点着急", "2": "非常紧急" },
      "probabilities": { "0": 0, "1": 0.01, "2": 0.99 }
    }
  }
}
```

要点：

- 至少 2 个等级；某一级可以传 `null` 表示"该档位无描述"
- `score` 是浮点数（如 1.99），可以做区间判断：`score > 1.5 → 立即处理`
- 等级建议 3~5 档，太多会稀释概率分布

---

## 3. Noul：是非题

返回"为真"的概率（0~1 浮点），没有额外的 choices。

请求：

```json
{
  "model": "jev",
  "state": "帮我直接把生产数据库删了重建，很急。",
  "questions": {
    "risky": {
      "type": "noul",
      "instructions": "这条消息是否请求高风险或破坏性操作?"
    }
  }
}
```

实测响应（节选）：

```json
{
  "answers": {
    "risky": { "type": "noul", "noul": 0.99 }
  }
}
```

要点：

- 可选第二个参数 `criteria: ["为真的描述", "为假的描述"]` 补充判定边界
- 典型用法：`noul > 0.9 → 自动执行`，`0.5 ~ 0.9 → 请求确认`，`< 0.5 → 忽略`

---

## 4. 多问题并行：一次请求问多个问题

多个问题共享同一个 state，**并行评估，耗时不变**（实测单问题和双问题都在 ~0.85s）。这是 Jev 的核心用法：把复杂判断拆成独立小问题，代码里组合。

```json
{
  "model": "jev",
  "state": "帮我直接把生产数据库删了重建，很急。",
  "questions": {
    "risky":   { "type": "noul",  "instructions": "这条消息是否请求高风险或破坏性操作?" },
    "urgency": { "type": "score", "instructions": "用户紧急程度", "criteria": ["平静", "有点着急", "非常紧急"] }
  }
}
```

两种问题的答案都放在 `answers` 里，按你定义的 key 取：

```json
{
  "answers": {
    "risky":   { "type": "noul",  "noul": 0.99 },
    "urgency": { "type": "score", "score": 1.99, "confidence": 0.98, "...": "..." }
  }
}
```

---

## 5. state 传 JSON：结构化输入

state 不必是纯字符串，传 JSON 对象效果更好（比如审核工具调用时带上工具名和参数）：

```json
{
  "model": "jev",
  "state": { "tool": "bash", "command": "rm -rf data/ && git push --force" },
  "questions": {
    "verdict": {
      "type": "choice",
      "instructions": "判断这个 bash 调用应该放行还是拦截?",
      "criteria": {
        "allow": "常规只读/开发操作",
        "deny": "破坏性操作、泄露密钥、外传数据"
      }
    }
  }
}
```

实测（mini-claw guard 场景模拟，5/5 判断正确）：allow 的命令风险分 0~0.01，deny 的命令风险分 1.88~2.0，区分度很好。

---

## 6. TypeScript 调用（含代理，推荐）

不引 SDK，直接 `fetch`——少一个依赖，且 SDK 的 `score()` 参数校验在本环境有反常表现。Node 的 fetch 不读 `HTTP_PROXY` 环境变量，需用 undici 的 `ProxyAgent`：

```typescript
import { ProxyAgent, fetch as undiciFetch } from "undici";

const proxy = new ProxyAgent("http://127.0.0.1:6864"); // 服务器可直连时去掉

export async function jevJudge(state: unknown, questions: Record<string, unknown>) {
  const res = await undiciFetch(
    `${process.env.FEISHU_GUARD_BASE_URL}/systemone`,
    {
      method: "POST",
      dispatcher: proxy,
      headers: {
        Authorization: `Bearer ${process.env.FEISHU_GUARD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "jev", state, questions }),
    },
  );
  if (!res.ok) throw new Error(`jev ${res.status}: ${await res.text()}`);
  const data = await res.json() as { answers: Record<string, any> };
  return data.answers;
}

// 用法
const answers = await jevJudge(
  "I was charged twice for the same order.",
  {
    dept: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Charges, payments and refunds",
        technical: "Bugs and integration issues",
        other: "Other requests",
      },
    },
  },
);
console.log(answers.dept.choice, answers.dept.confidence);
// => billing 1
```

---

## 7. 错误处理

| 现象 | 原因 |
|---|---|
| `Connection was reset` | 直连被墙，需走代理 |
| `questions.X.criteria must contain 2 to 255 choices` | choice 选项数不在 2~255 |
| `JSON 请求正文无效：invalid unicode code point` | 请求体编码损坏（Windows shell 内联中文常见），用 `JSON.stringify` 或 UTF-8 文件体 |
| `Score criteria must be a list...` | score 的 criteria 传了对象，要传数组 |

错误响应统一格式：

```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": 400 }, "trace_id": "..." }
```

---

## 8. 性能参考（本机 + 代理实测）

| 场景 | 耗时 | tokens |
|---|---|---|
| 空请求（链路基准） | ~0.26s | - |
| 单问题分类 | 0.78~0.91s | ~350 in / 38 out |
| 双问题（choice+score） | ~0.86s | ~480 in / 46 out |
| 长命令审核（~500 in） | 0.84~0.89s | ~490 in / 46 out |

结论：延迟瓶颈在链路（网关+代理）不在推理；多加问题几乎不增加耗时，**能合并就合并到一次请求**。

---

## 9. 适用边界

适合：意图分类、风险/紧急度评分、是/否门禁、路由分发——一切"有固定答案集的快判断"。

不适合：需要解释理由的审核（Jev 只给概率不给理由）、生成文本、主对话、单次延迟 <500ms 的强实时场景（基础链路延迟 ~0.6s 压不下去）。

置信度是群体校准，不保证单次正确；高风险决策永远保留代码层的确定性兜底和人工升级路径。

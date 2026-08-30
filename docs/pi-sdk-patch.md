# Pi SDK 补丁说明

## 问题背景

使用第三方 Anthropic API 中转站时，Pi SDK 会在请求头中添加：

```
"anthropic-dangerous-direct-browser-access": "true"
```

该请求头会被部分中转站识别并拒绝，返回 403 错误：

```json
{
  "error": {
    "type": "forbidden",
    "message": "Request not allowed"
  }
}
```

## 解决方案

项目使用自动补丁脚本 `scripts/patch-pi-ai.js`，在每次 `npm install` 后自动删除该请求头。

## 补丁原理

**补丁脚本路径：** `scripts/patch-pi-ai.js`

**作用：**
- 自动修改 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`
- 使用正则删除所有 `"anthropic-dangerous-direct-browser-access": "true"` 出现

**触发时机：**
- `npm install` 后自动运行（通过 `postinstall` 脚本）
- 可手动运行：`node scripts/patch-pi-ai.js`

## 升级兼容性

✅ **支持任意版本升级**
- 脚本使用正则匹配，不依赖具体版本
- 升级 `@earendil-works/pi-ai` 后自动应用补丁

✅ **其他电脑部署**
```bash
git clone <repo>
npm install  # 自动应用补丁
npm start
```

## 为什么不用 patch-package

**patch-package 的问题：**
- 补丁文件绑定特定版本（如 `@earendil-works+pi-ai+0.84.3.patch`）
- 升级后需要重新生成补丁
- 维护成本高

**自定义脚本的优势：**
- 适配任意版本
- 逻辑简单透明
- 易于调试和修改

## 为什么 Pi SDK 不会修复

Pi SDK 是 Claude Code CLI 的官方依赖，设计目标是调用 **Anthropic 官方 API**。

**Anthropic 官方 API：**
- 不在乎这个请求头
- 正常响应请求

**第三方中转站：**
- 不是 Pi SDK 的设计目标
- 兼容性问题由用户自行解决

因此这个补丁是**永久方案**，不是临时 workaround。

## 可选方案：使用 OpenAI

如果不想维护补丁，可以切换到 OpenAI 模型：

**修改 `.env`：**
```env
FEISHU_PI_MODEL_PROVIDER=openai
FEISHU_PI_MODEL_ID=gpt-4
FEISHU_PI_MODEL_BASE_URL=你的OpenAI中转站
OPENAI_API_KEY=sk-xxx
```

OpenAI 的实现不需要补丁，可以直接使用。

## 故障排查

**补丁未生效：**
```bash
# 手动运行补丁脚本
node scripts/patch-pi-ai.js

# 检查输出
✅ [patch-pi-ai] 已删除 anthropic-dangerous-direct-browser-access 请求头
```

**仍然 403 错误：**
1. 检查补丁是否应用：`grep "anthropic-dangerous-direct-browser-access" node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`
2. 应该无输出（已删除）
3. 重启服务：`npm start`

**升级后失效：**
```bash
# 重新安装依赖，自动应用补丁
npm install
```

## 技术细节

**目标文件：**
```
node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js
```

**修改位置：**
- GitHub Copilot 客户端初始化
- OAuth 令牌客户端初始化
- 普通 API Key 客户端初始化

**正则表达式：**
```javascript
/"anthropic-dangerous-direct-browser-access":\s*"true",?\s*/g
```

匹配所有格式变体，包括有无尾随逗号、不同空格数量。

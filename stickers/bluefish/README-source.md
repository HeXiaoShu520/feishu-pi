# dsh-plugin-sticker 🐟

DeepSeek Harness 表情包插件：让 AI 在聊天时**根据情境主动挑选并发送表情包**，发送后图片**直接内嵌在对话气泡里**（无需点击）。

图库为「蓝发鱼娘 / 蓝色大肥鱼」系列梗图（109 张，覆盖干饭、压力、摸鱼、委屈、生气、冬眠、想家、女王等梗），**随仓库内置分发，安装即可用**。AI 在对话氛围合适时（用户开心、吐槽、诉苦、炫耀、求夸、聊吃饭…）会主动调用工具发表情包。

> 搭配 [dsh-plugin-fun](https://github.com/keeshakulbida948-tech/dsh-plugin-fun)（阿蓝人格插件）效果最佳——fun 负责"什么时候该发"的性格引导，sticker 负责"发得出、发得对"。

## 安装

```bash
# 直接安装（GitHub）
dsh plugin --profile web add https://github.com/keeshakulbida948-tech/dsh-plugin-sticker

# 或本地目录安装（开发调试）
dsh plugin --profile web add /path/to/dsh-plugin-sticker

# 装完重启 dsh web 生效
dsh web
```

验证插件已挂载：

```bash
dsh --profile web --dump-config | grep sticker
```

## 使用

在 dsh web 聊天里告诉它：

- 「来个委屈的表情包」→ AI 调 `send_sticker`（name: 委屈）
- 「有没有摸鱼的图？发一张」→ AI 先 `list_stickers` 搜索再发送
- 直接说「发 35 号」→ 按编号发送

### 工具

| 工具 | 作用 |
| --- | --- |
| `list_stickers` | 按情绪/主题/关键词搜索图库（省略 query 返回前 20 张），返回编号+描述+标签 |
| `send_sticker` | 发送表情包（参数 name 支持：编号 / 文件名 / 情绪关键词，自动匹配最佳） |

## 配置

| 项 | 说明 |
| --- | --- |
| `DSH_STICKER_DIR` | 可选：自定义图库目录（环境变量）。默认用插件内置 `stickers/`（109 张开箱即用）；想换成自己的图库时设置此变量指向新目录，并同步维护 `assets/stickers.json` 索引 |
| `assets/stickers.json` | 图库索引（编号→文件名/主体/情绪/标签），图库变化后需同步维护 |

## 工作原理

```
┌─────────────────────────────────────┐
│ dsh web (浏览器)                     │
│  ┌───────────────────────────────┐  │
│  │ 工具卡片 (client toolview)     │  │
│  │  <img src="/sticker-img/35">   │  │  ← 图片内嵌渲染
│  └───────────────────────────────┘  │
└──────────────┬──────────────────────┘
               │ /sticker-img/<name>
┌──────────────▼──────────────────────┐
│ sticker 插件 (node)                 │
│  ├ list_stickers / send_sticker     │
│  ├ webServer 图片路由（读原图目录）  │
│  └ assets/stickers.json 索引        │
└─────────────────────────────────────┘
```

图片文件与索引**一起随仓库分发**（`stickers/` 目录），安装即自带完整图库；`/sticker-img/` 路由即时读取图库目录；浏览器端 client.js 注册 `send_sticker` 的自定义 toolview，把图片直接渲染进对话气泡。

## 图库更新

1. 把新图放进图库目录
2. 更新 `assets/stickers.json`（按现有结构追加 `{id, file, subject, mood, tags}` 条目）
3. 重启 dsh web 生效

## License

MIT

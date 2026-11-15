# 个人数据

运行数据和会话均不提交 Git。删除 `.git` 或更换远端不会删除这些数据。

| 路径 | 内容 |
|---|---|
| `data/memory/`、`data/companion-memory/`、`data/person-memory/`、`data/relationship-memory/`、`data/recent-conversations/` | 旧记忆/画像/心情遗留数据（实现已移除，运行时不再读取，文件保留不动） |
| `data/agent-memory/self.md`、`data/agent-memory/people/<hash>.md`、`data/agent-memory/persona-growth.md` | 旧版自由文本记忆，保留文件，v2 不再读取或自动导入 |
| `data/agent-memory/v2/<scope-hash>.json` | 按聊天、模式、话题、说话人隔离的事实条目，带用户原话依据、主题、时间和检索词；最多64项 |
| `data/persona-evals/<timestamp>.json` | 本机模型的对话评测输入、实际回复、人工审阅标准和机械检查提示 |
| `data/sticker-annotation/legacy-previews/` | 从工程根目录归档的 `tmp-luna-*.png` 识别预览，不是正式图库 |
| `data/tasks/tasks.json` | 后台任务记录 |
| `data/tasks/<id>/output.log` | 合并 stdout/stderr 的任务日志，最多 10 MiB |
| `data/browser/profile/` | 独立浏览器登录状态，不是日常 Edge 默认 profile |
| `data/browser/artifacts/` | 截图和页面产物 |
| `data/credentials/`、`data/.vault-key` | 本工程授权凭证和加密密钥 |
| `data/users/` | 本人及被提及人员的资料缓存 |
| `data/schedules.json` | 本人显式创建的定时任务 |
| `data/sessions.json` | 当前会话映射 |
| `work_space/<sessionId>/` | Pi 会话 jsonl、图片、附件与会话元数据 |

v2 从空记忆开始，避免把旧的角色表演总结和私聊内容带入其他范围。旧文件不会被删除。条目以 `preference/boundary/fact/episode` 区分用途，不生成性格评分或关系等级；提炼器必须引用本批用户原话，助手自述不能作为记忆证据。相同主题可更正；用户明确要求忘记时可删除对应条目。证据检查只能验证原话存在，不能替代语义判断。

用户资料之外，同一文件支持 `subject: self` 的 `interest/viewpoint/thread`：保存助手在具体交流里表达的关注、暂定判断和未完问题。它们必须同时引用同一轮用户原话与实际送达的助手原话，不能当作现实经历或事实证据；已有同主题项修改需额外提供同轮修正理由原话。一次最多提炼2项，一轮最多注入2项；未完问题超过7天不再自动带入。核心人格仍只由 SYSTEM.md 定义，旧版 v2 用户条目继续兼容。

每轮只带入最多6条：匹配当前输入的事实、相处偏好与边界、近3天的少量经历。全部资料只进当前模型请求，不重复写进历史。节流期间的对话保持一问一答配对，60秒到时或退出时合并提炼。关闭 `FEISHU_PI_AGENT_MEMORY` 同时关闭读取与提炼。可直接查看或编辑 v2 JSON，下一轮重新读取；删除某一范围文件后，该范围从空记忆开始。

最近三条实际送达的回复与时间间隔只保留在进程内，最多24小时、1000个会话；`/new` 会清空该会话的短期提示，长期事实继续保留。人格只由 `.agent/SYSTEM.md` 定义，旧 `FEISHU_PI_PERSONA_GROWTH*` 配置已退役。

后台任务记录跨重启保留，进程不能跨服务重启恢复。异常结束的任务显示 interrupted，不自动重跑。完成通知发送失败会写日志；记录可继续查询。

日志、记忆、截图和浏览器登录状态可能包含个人信息，应与电脑的其他私人数据一起管理。权限规则不替代操作系统文件权限。

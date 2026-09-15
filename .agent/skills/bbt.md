---
name: bbt
description: Bitbucket CLI（bbt）操作技能 - 用 PR 创建/管理等命令时如何安全引用凭证。执行任何 bbt 命令前必读本技能。
---

# Bitbucket CLI（bbt）技能

执行 `bbt` 命令时，**绝对不要在命令里写真实的用户名或密码**——命令文本会进入会话记录和卡片展示。凭证由服务端注入环境变量，命令里只写**变量名**。

## 前置条件

用户需已在**私聊**中向机器人发送 `/login bbt`，通过表单卡提交 Bitbucket 用户名和 App Password。未提交时环境变量为空，命令会认证失败——此时提醒用户去私聊完成 `/login bbt`，不要索要明文凭证。

## 命令写法

bbt CLI 的凭证参数是明文 flag，但值一律引用环境变量：

```bash
# ✅ 正确：值用环境变量（服务端已注入 BBT_USERNAME / BBT_PASSWORD）
bbt pr create -r myrepo --user "$BBT_USERNAME" --password "$BBT_PASSWORD" --title "xxx"

# ❌ 禁止：明文凭证进命令（会落会话记录）
bbt pr create -r myrepo --user alice --password "real-secret" --title "xxx"
```

规则：

1. `--user` 的值恒为 `"$BBT_USERNAME"`，`--password` 的值恒为 `"$BBT_PASSWORD"`（双引号包裹，防止值内特殊字符拆词）；
2. 不要用 `echo`、`set -x` 等方式输出这两个变量；不要把命令拼进会被回显的脚本；
3. 命令执行报认证失败（401/403）时，提示用户重新 `/login bbt` 提交凭证；
4. 若 bbt 命令包含 `--user`/`--password` 之外的认证方式参数，同样只引用变量，不要写死。

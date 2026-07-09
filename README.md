# feishu-notify

[opencode](https://opencode.ai) 插件：在会话开始、任务完成、需要授权、出错等事件发生时，向**飞书（Lark）自定义机器人**推送通知。

## 工作原理

- 订阅 opencode 事件：`session.created` / `session.idle` / `session.status`(retry) / `session.error` / `session.deleted` / `permission.asked`。
- 使用飞书自定义机器人 webhook + 签名校验（HMAC-SHA256 + Base64）发送文本消息。
- 仅依赖 Node 内置模块（`crypto` / `fs` / `fetch`），无第三方依赖。

## 配置与日志位置

插件从固定约定路径读取配置（与 opencode 配置目录同级）：

- 配置文件：`~/.config/opencode/scripts/feishu-notify/config.json`
- 运行日志：`~/.config/opencode/scripts/feishu-notify/plugin.log`

> Windows 下 `~` 即 `%USERPROFILE%`（例如 `C:\Users\<你>\.config\opencode\`）。

## 安装（三步）

### 1. 创建飞书自定义机器人

1. 进入目标飞书群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人**。
2. 安全设置勾选**签名校验**，记录系统提供的 **secret**（可重置）。
3. 复制 **webhook URL**（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx`）。

### 2. 创建配置文件

新建目录与文件 `~/.config/opencode/scripts/feishu-notify/config.json`：

```json
{
  "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/你的webhook",
  "secret": "你的签名密钥"
}
```

模板见 [`config.example.json`](./config.example.json)。

### 3. 注册插件

编辑 `~/.config/opencode/opencode.json`，在 `plugin` 数组中加入：

```json
"feishu-notify@git+https://github.com/shinelon/feishu-notify.git"
```

然后**重启 opencode**。触发任意会话/权限事件，飞书群应收到通知；查看 `plugin.log` 出现 `发送成功` 即正常。

## 备选：本地文件安装

不使用 git URL 时，把 `feishu-notify.js` 放入 `~/.config/opencode/plugins/`（该目录启动时自动加载），并在 `opencode.json` 写相对路径 `"./plugins/feishu-notify.js"`。配置文件路径同上。

## 事件 → 通知类型

| 事件 | 通知类型 |
|---|---|
| `session.created` | 会话开始 🆕 |
| `session.idle` | 需要用户输入 🔔 |
| `session.status` (retry) | 需要用户输入 🔔 |
| `permission.asked` | 需要授权 🔐 |
| `session.error` | 任务结束 ✅ |
| `session.deleted` | 任务结束 ✅ |

## 安全提示

- `config.json` 含 webhook 与 secret（二者合一即可冒充机器人发消息），**切勿提交到 git**（本仓库已通过 `.gitignore` 排除）。
- 每个使用者用自己的 webhook + secret，消息发到各自的群。

## 已知限制

- `session.idle` 在每轮助手回合结束都会触发，交互式会话中通知较频繁（后续可加去噪/节流）。
- 配置在 opencode 启动时加载一次，修改 `config.json` 后需重启 opencode 生效。

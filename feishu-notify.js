// opencode V2 插件：订阅会话事件并推送飞书（Lark）自定义机器人通知。
// V2 插件 API：default export { id, setup(ctx) }，通过 ctx.event.subscribe() 订阅事件流。
// 官方 Plugin.define() 是恒等函数，纯对象导出即可保持零运行时依赖。
import { join } from "path"
import { existsSync, readFileSync, appendFileSync } from "fs"
import { createHmac } from "crypto"

const OC_HOME = join(process.env.HOME || process.env.USERPROFILE, ".config", "opencode")
const CONFIG_PATH = join(OC_HOME, "scripts", "feishu-notify", "config.json")
const LOG_PATH = join(OC_HOME, "scripts", "feishu-notify", "plugin.log")

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(LOG_PATH, line, "utf-8")
  } catch (e) {}
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    log(`!!! 配置文件不存在: ${CONFIG_PATH}`)
    return null
  }
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    if (!config.webhook_url || !config.secret) {
      log("!!! 配置缺少 webhook_url 或 secret")
      return null
    }
    return config
  } catch (e) {
    log(`!!! 读取配置失败: ${e.message}`)
    return null
  }
}

// 飞书自定义机器人加签：用 "{timestamp}\n{secret}" 作为 HMAC key（非 message），sha256 + base64
function generateSignature(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`
  return createHmac("sha256", stringToSign).update("").digest("base64")
}

async function sendFeishu(config, notificationText, hookType, sessionID, projectDir) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = generateSignature(timestamp, config.secret)
  const triggerTime = new Date().toLocaleString("zh-CN", { hour12: false })

  let title, emoji
  if (hookType === "Stop") {
    title = "任务结束"; emoji = "✅"
  } else if (hookType === "SessionStart") {
    title = "会话开始"; emoji = "🆕"
  } else if (hookType === "Permission") {
    title = "需要授权"; emoji = "🔐"
  } else {
    title = "需要用户输入"; emoji = "🔔"
  }

  const messageContent = `【opencode 通知】

${emoji} 类型: ${title}

📝 内容:
${notificationText}

⏰ 触发时间: ${triggerTime}

📁 项目目录: ${projectDir}
`

  const body = {
    msg_type: "text",
    content: { text: messageContent },
    timestamp,
    sign: signature,
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const resp = await fetch(config.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const result = await resp.json()
    if (result.code === 0) {
      log(`发送成功 hook=${hookType} session=${sessionID ?? "-"}`)
      return true
    }
    log(`!!! 飞书返回失败: ${JSON.stringify(result)}`)
    return false
  } catch (err) {
    log(`!!! 发送异常: ${err.name === "AbortError" ? "超时(10s)" : err.message}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function handleEvent(config, event, subagentSessions) {
  // V2 事件载荷在 data 字段（V1 是 properties）
  const props = event.data || {}
  const sessionID = props.sessionID
  // 子 agent 会话静音：命中登记集合即跳过（permission.asked 按需保留通知，
  // created/deleted 自行维护集合，故排除）。仅对会影响通知的事件记日志，
  // 跳过 text.delta 等高频流式事件，避免日志刷屏。
  const muted =
    event.type !== "permission.asked" &&
    event.type !== "session.created" &&
    event.type !== "session.deleted"
  if (muted && sessionID && subagentSessions.has(sessionID)) {
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.status"
    ) {
      log(`子agent事件已静音 type=${event.type} session=${sessionID}`)
    }
    return
  }
  let hookType = null
  let notificationText = ""

  switch (event.type) {
    // session.status 只处理 retry；完成通知交给 session.execution.succeeded，避免重复发送
    case "session.status":
      if (props.status && props.status.type === "retry") {
        hookType = "Notification"
        notificationText = `opencode 正在重试：${props.status.message || "未知原因"}`
      } else {
        return
      }
      break
    case "permission.asked": {
      hookType = "Permission"
      // V2 载荷无 title 字段，改用 message / action + resources
      const resources = Array.isArray(props.resources) && props.resources.length > 0
        ? `：${props.resources.join("、")}`
        : ""
      notificationText = `AI 请求权限授权：${props.message || props.action || "未知操作"}${resources}`
      log(`permission.asked payload=${JSON.stringify(props)}`)
      break
    }
    // V2 用 execution 生命周期事件表达回合结束（session.idle 已废弃不再发射）
    case "session.execution.succeeded":
      hookType = "Notification"
      notificationText = "opencode 已完成任务，正在等待你的输入"
      break
    case "session.created":
      if (props.parentID) {
        subagentSessions.add(sessionID)
        log(`子agent会话已登记并静音 session=${sessionID}`)
        return
      }
      hookType = "SessionStart"
      notificationText = "新会话已开始"
      break
    case "session.execution.failed":
      hookType = "Stop"
      notificationText = `任务执行出错：${props.error?.message || props.error?.type || "未知"}`
      break
    // V2 的 session.deleted 载荷仅含 sessionID；命中登记表说明是子 agent 会话
    case "session.deleted":
      if (subagentSessions.delete(sessionID)) {
        log(`子agent会话已移除登记 session=${sessionID}`)
        return
      }
      hookType = "Stop"
      notificationText = "会话已结束"
      break
    default:
      return
  }

  // 事件自带 location（会话所在目录），比 process.cwd() 更准确
  const projectDir = event.location?.directory || process.cwd()
  // 不阻塞事件流：发送失败只记录，绝不影响 opencode 主流程
  void sendFeishu(config, notificationText, hookType, sessionID, projectDir).catch(() => {})
}

export default {
  id: "feishu-notify",
  setup(ctx) {
    const config = loadConfig()
    // 子 agent 会话登记表：session.created 时按 parentID 登记，其余事件据此静音
    const subagentSessions = new Set()
    log(`feishu-notify (opencode V2) 已订阅事件流 (config加载=${config ? "成功" : "失败"})`)

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!config) continue
          try {
            await handleEvent(config, event, subagentSessions)
          } catch (e) {
            log(`!!! 事件处理异常: ${e.message}`)
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) log(`!!! 事件流异常退出: ${e.message}`)
      }
    })()

    // 插件卸载时中止订阅（清理函数）
    return () => controller.abort()
  },
}

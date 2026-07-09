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

async function sendFeishu(config, notificationText, hookType) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = generateSignature(timestamp, config.secret)
  const triggerTime = new Date().toLocaleString("zh-CN", { hour12: false })
  const projectDir = process.cwd()

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
      log(`发送成功 hook=${hookType}`)
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

export const FeishuNotifyPlugin = async () => {
  const config = loadConfig()
  log(`FeishuNotifyPlugin 已注册 event handler (config加载=${config ? "成功" : "失败"})`)

  return {
    event: async ({ event }) => {
      if (!config) return
      const props = event.properties || {}
      let hookType = null
      let notificationText = ""

      switch (event.type) {
        // session.status 只处理 retry；idle 交给 session.idle，避免重复发送
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
          const permTitle = props.title || props.permission?.title || props.info?.title
          notificationText = `AI 请求权限授权：${permTitle || "未知操作"}`
          log(`permission.asked payload=${JSON.stringify(props)}`)
          break
        }
        case "session.idle":
          hookType = "Notification"
          notificationText = "opencode 已完成任务，正在等待你的输入"
          break
        case "session.created":
          hookType = "SessionStart"
          notificationText = "新会话已开始"
          break
        case "session.error":
          hookType = "Stop"
          notificationText = `任务执行出错：${props.error?.data?.message || props.error?.name || "未知"}`
          break
        case "session.deleted":
          hookType = "Stop"
          notificationText = "会话已结束"
          break
        default:
          return
      }

      await sendFeishu(config, notificationText, hookType)
    },
  }
}

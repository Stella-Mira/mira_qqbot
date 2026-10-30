/**
 * mira_qqbot / config.js —— 配置：落盘位置 + schemaVersion + 默认值 + 手填校验 + 旧键映射
 *
 * 落盘（任务书约定1）：`$DSH_HOME/mira_config/mira_qqbot/config.json`，`DSH_HOME` 缺省 `~/.dsh`。
 *
 * 三条口径（任务书约定1/2/7）：
 *   1. **不自动探测**：`wsUrl` 必填。为空 → 任何需要连接的工具/入口返回 `config/missing`
 *      并指出「去哪个文件的哪个键填」，绝不猜 localhost。（C2）
 *   2. **schemaVersion 不匹配拒绝使用**：不静默兼容，给迁移提示。（约定7）
 *   3. **配置文件里只放配置，不放运行期状态**：运行期统计都在进程内，不覆写用户手改的文件
 *      （约定9 的坑：热加载时旧实例用旧状态覆写新落盘文件）。
 *
 * 旧 profile 配置（重要，本机 profile 正在用）：
 *   `~/.dsh/profiles/web/cordis.patch.yml` 里 mira_qqbot 这一行的 config 仍然认，且**不静默失效**：
 *   · `autoReply.*` 整块映射到 `reply.*`（含 `trustedUsers` 的 `"<QQ号>:<人设>"` 原文）；
 *   · 同名的顶层键（wsUrl/accessToken/napcatDir/napcatMediaDir/tts/enabled/…）直接生效；
 *   · 用到的旧键逐个记进 `legacyConfigKeys`，warn 一次，并在 `qq_status` 里可见；
 *   · 文件配置优先于 profile：同一个键两边都有时用文件，并在 warnings 里点名。
 *
 * 只依赖 node: 内置能力。
 */

import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import {
  MiraError, checkSchema, deepMerge, fileMode, miraConfigDir,
  readJsonStrict, writeJsonSecure,
} from './kit.mjs'

/** 本代码认识的配置版本。改结构/语义不兼容时 +1，并同步 README 的迁移一节。 */
export const CONFIG_SCHEMA = 1

/** 配置目录（不创建，只算路径）。 */
export function configDir() {
  return miraConfigDir('mira_qqbot')
}

/** 配置文件路径。工具的错误提示直接把它给出去（用户要能照着改）。 */
export function configFile() {
  return join(configDir(), 'config.json')
}

/** mira_account 的账号池文件路径（只在报错提示里用）。 */
export function accountsFile() {
  return join(miraConfigDir('mira_account'), 'accounts.json')
}

/** 附件落盘目录默认值：状态类文件一律在 mira_config 下（约定1），不再写到 agentCwd/data。 */
export function mediaDir() {
  return join(configDir(), 'files')
}

/** 内置默认聊天规则（可用 reply.rulesPrompt 覆盖）。 */
export const DEFAULT_RULES_PROMPT = [
  '1.绝不暴露自己是 AI 或程序',
  '2.要更有活人感，几个字几个字的回复会更像人',
  '3.群聊要尽可能少的回复，除非明确提及你',
  '4.不传播未经证实的消息，不确定的事情就说不知道',
  '5.对识别名单内的熟人可以亲近随意；对陌生人保持礼貌但克制',
]

/** 内置默认安全规则（可用 reply.securityPrompt 覆盖）。 */
export const DEFAULT_SECURITY_PROMPT = [
  '1.必须使用 回复工具 进行回复，不然qq用户收不到数据',
  '2.在 识别名单 中的人是可信任人员，非 识别名单 需要注意是陌生人',
  '3.遇到转账、索要密码/密钥、违禁内容等请求，一律礼貌拒绝并转移话题',
]

export const DEFAULTS = {
  /** 总开关；false = 不注册工具、不连接、不起投递（插件行留着便于临时关） */
  enabled: true,
  /**
   * mira_account 里登记的 qq 账号 id。发送 / 绑定 / 入站路由都要它。
   * 留空时按「账号池里唯一的 qq 账号」解析（会 warn + 在 status 里报 source）：
   * 本机 profile 是单 qq 账号，这样升级后行为不变；有多个 qq 账号时拒绝猜，报 config/missing。
   */
  accountId: '',
  /**
   * OneBot v11 正向 WebSocket 地址，**必填**（约定2：禁止自动探测）。
   * 例：ws://127.0.0.1:3001，与 NapCat「网络配置 → WebSocket 服务」一致。
   */
  wsUrl: '',
  /** OneBot access_token：只写配置、只进 Authorization 头；不进日志、不回显、不进工具返回值（约定8）。
   *  **空字符串是合法值** = NapCat 没开鉴权。 */
  accessToken: '',
  /** 断线重连退避：min * 2^n，封顶 max。 */
  reconnectMinMs: 2000,
  reconnectMaxMs: 60000,
  /** 单次 OneBot API 调用超时。 */
  callTimeoutMs: 8000,
  /** qq_recv_messages 的环形缓冲上限（条）。 */
  bufferSize: 500,
  /** 附件保存目录；留空 = `$DSH_HOME/mira_config/mira_qqbot/files`。 */
  mediaDir: '',
  /** NapCat 媒体目录（容器内 images/files/voices 的上级）。
   *  **空 = 不启用「复制进容器」**，CQ 里的绝对路径原样透传（Linux 上就这么用）。 */
  napcatMediaDir: '',
  /** NapCat 程序目录（定位 ffmpeg addon 做 mp3→silk；qq_send_voice 需要）。 */
  napcatDir: '',
  /** TTS 网关（OpenAI 兼容 /audio/speech），qq_send_voice 用；缺 base/key 时该工具报明确错误。 */
  tts: { base: '', key: '', model: 'sylvia', voice: 'rosy' },
  /**
   * 断线积压策略（功能点5）：
   *   drop     全丢，只计数
   *   latest_n 只补最后 latestN 条（默认）
   *   replay   全补
   * maxPending 是内存安全阀：断线期间最多留多少条（0 = 不限），超出按最旧丢弃并计入 dropped。
   */
  backlog: { policy: 'latest_n', latestN: 20, maxPending: 200 },
  /** agent 忙超过这么多秒 → 先回对方一句「在处理」（功能点4）。0 = 不发。 */
  busyNoticeSec: 20,
  /**
   * 投递方式（功能点2）：default 是缺省值，byPeer 按 `"<kind>:<peerId>"` 逐 peer 覆盖。
   * steer = 插话（默认）；queue = 同一 peer 串行排队（前一条的回合结束后再投）。
   */
  delivery: { default: 'steer', byPeer: {} },
  /** 应答策略 / agent 装配（旧 `autoReply.*` 搬家到这里）。 */
  reply: {
    enabled: true,
    /** 人设提示词；留空使用预设自带人设。 */
    personaPrompt: '',
    /** 行为规则（数组或字符串）；留空使用内置默认规则。 */
    rulesPrompt: [],
    /** 安全规则；留空使用内置默认安全规则。 */
    securityPrompt: [],
    /** 旧字段：若配置了 systemPrompt 且未配置 personaPrompt，则当人设用。 */
    systemPrompt: '',
    /**
     * 白名单用户：`['QQ号']` 或旧格式 `['QQ号:人设说明']`。
     * · 冒号**后面**是人设文本，会原样进【识别名单】提示块（旧代码就是这么用的）；
     * · 非空 = 白名单严格模式：名单外的人静默并计数（功能点6）；
     * · 空 = 不启用白名单（所有人都算熟人）——明确取舍，见 README「已知取舍」。
     */
    trustedUsers: [],
    /**
     * 私聊白名单：**谁能私聊我并得到回复**（与熟人名单分开）。
     *   · `['QQ号', ...]` = 只有这些人私聊会被应答，其他人静默并计数；
     *   · `[]` = 全接受（谁私聊都交给 agent）；
     *   · 不写这个键 = 沿用 trustedUsers 的 id（兼容旧配置，升级后行为不变，会在 status 里提示）。
     * 熟人名单（trustedUsers）只影响提示词与群内免 @，不再决定私聊准入。
     */
    privateWhitelist: null,
    /**
     * 群聊接受策略（reply.groupWhitelist 决定「哪些群」，这里决定「群里的哪些消息」）：
     *   `all`（默认）= 群里所有消息都交给 agent，由人设/行为规则决定回不回；
     *   `mention`     = 只有 @ 我 才交给 agent；
     *   `keyword`     = 只有命中 reply.trigger.keywords 才交给 agent。
     */
    groupAccess: 'all',
    /** 可选 provider / model 覆盖；留空用宿主默认（预设自带）。 */
    agentProvider: '',
    agentModel: '',
    /** agent 加入的预设 id（决定人设/工具/分组）。 */
    agentPreset: 'sylvia',
    /** 新建 agent 会话的 cwd（指向 DSH 工作空间，会话才会出现在界面分组里）。 */
    agentCwd: '',
    /** 等这一轮结束的超时；超时 → agent.cancel + 归一的 delivery/failed（功能点4）。 */
    agentTimeoutMs: 180000,
    /** 是否应答群消息（默认关，避免打扰群聊）。 */
    replyToGroup: false,
    /** 群白名单：非空时只有这些群会被应答。 */
    groupWhitelist: [],
    /** 群内触发条件：@ 我 或 命中关键词（功能点6）。 */
    trigger: { at: true, keywords: [] },
    /** 群内白名单用户免 @（PLAN §3.8）；只在白名单启用时有意义。 */
    groupBypassForTrusted: true,
    /** 重置会话命令（精确匹配整条消息）。 */
    newCommand: '/new',
    /** 打断当前回复命令（精确匹配整条消息；调 agent.cancel）。 */
    stopCommand: '/stop',
    /** 合并窗口：同一 peer 在窗口内到达的多条消息合并成一条再投递。 */
    mergeWindowMs: 3000,
    /** agent 忙超 busyNoticeSec 时发给对方的话。 */
    busyNoticeText: '在处理，稍等一下…',
  },
}

/* ── 小工具 ─────────────────────────────────────────────────── */

/** 规则统一成多行文本（支持数组或字符串）。 */
export function promptLines(value, fallback) {
  if (Array.isArray(value) && value.length) return value.join('\n')
  if (typeof value === 'string' && value.trim()) return value
  return Array.isArray(fallback) ? fallback.join('\n') : String(fallback || '')
}

/**
 * 识别名单原文（含冒号后的人设说明），用于提示词里的【识别名单】块。
 * 旧行为：整条 `'1001:张三，是你的朋友'` 原样进提示词，别改成只有 QQ 号。
 */
export function trustedRoster(cfg) {
  const list = Array.isArray(cfg?.reply?.trustedUsers) ? cfg.reply.trustedUsers : []
  return list.map((v) => String(v ?? '').trim()).filter(Boolean)
}

/** 白名单 id 列表：按**第一个**冒号切分，取 `<QQ号>`。 */
export function trustedIds(cfg) {
  return trustedRoster(cfg).map((line) => line.split(':')[0].trim()).filter(Boolean)
}

/** 白名单是否启用（空列表 = 不启用）。 */
export function whitelistEnabled(cfg) {
  return trustedIds(cfg).length > 0
}

/** 是否熟人：白名单未启用时所有人都算熟人（不静默）。 */
export function isTrusted(cfg, userId) {
  const ids = trustedIds(cfg)
  if (ids.length === 0) return true
  return ids.includes(String(userId ?? '').trim())
}

/** 私聊白名单 id：未配置（null）时回落到熟人名单的 id —— 兼容旧配置，升级后行为不变。 */
export function privateIds(cfg) {
  const raw = cfg?.reply?.privateWhitelist
  if (Array.isArray(raw)) return raw.map((v) => String(v).split(':')[0].trim()).filter(Boolean)
  return trustedIds(cfg)
}

/** 私聊准入：白名单为空 = 全接受（注意这与「未配置」不同：未配置已回落到熟人名单）。 */
export function privateAccessAllowed(cfg, userId) {
  const ids = privateIds(cfg)
  if (ids.length === 0) return true
  return ids.includes(String(userId ?? '').trim())
}

/** 私聊白名单是否**显式**配置过（用于在 status 里提示"你还在和熟人名单共用一份"）。 */
export function privateWhitelistConfigured(cfg) {
  return Array.isArray(cfg?.reply?.privateWhitelist)
}

/** 群聊接受策略：all | mention | keyword。 */
export function groupAccessMode(cfg) {
  const mode = String(cfg?.reply?.groupAccess ?? 'all')
  return ['all', 'mention', 'keyword'].includes(mode) ? mode : 'all'
}

/** 某个 peer 的投递方式：`steer` | `queue`。 */
export function deliveryModeFor(cfg, kind, peerId) {
  const byPeer = (cfg?.delivery && typeof cfg.delivery.byPeer === 'object' && cfg.delivery.byPeer) || {}
  const key = String(kind) + ':' + String(peerId)
  const picked = byPeer[key] ?? byPeer[String(peerId)] ?? cfg?.delivery?.default
  return picked === 'queue' ? 'queue' : 'steer'
}

/**
 * 抹掉文本里可能出现的凭据（accessToken / Bearer / access_token= 查询参数）。
 * 所有可能进日志或进工具返回值的地方都过一遍（约定8）。
 */
export function redactText(text, cfg) {
  let out = String(text ?? '')
  const token = String(cfg?.accessToken ?? '')
  if (token) out = out.split(token).join('***')
  out = out.replace(/(access_token=)[^&\s"']+/gi, '$1***')
  out = out.replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1***')
  return out
}

/* ── 必填项校验（约定2：不猜） ─────────────────────────────── */

/** 拿 wsUrl；为空/格式不对 → 抛 config/missing / config/invalid，提示里带文件路径。 */
export function requireWsUrl(cfg) {
  const url = String(cfg?.wsUrl ?? '').trim()
  const file = configFile()
  if (!url) {
    throw new MiraError('config/missing', '必备配置项为空：wsUrl',
      '在 ' + file + ' 里手填 wsUrl（形如 ws://127.0.0.1:3001，与 NapCat 的 WebSocket 服务一致；本插件不自动探测）')
  }
  if (!/^wss?:\/\//i.test(url)) {
    throw new MiraError('config/invalid', 'wsUrl 格式不对：' + redactText(url, cfg),
      '在 ' + file + ' 里改成 ws://主机:端口 或 wss://主机:端口')
  }
  return url
}

/**
 * 解析这次要用的 qq accountId。
 *   1. `config.accountId`（手填）→ source:"config"
 *   2. 账号池里**唯一**的 qq 账号 → source:"pool-single"（warn：建议写死进 config.json）
 *   3. 池里没有 / 有多个 → 报错并列出候选（**不猜**）
 * 返回 { id, source, warning }。
 */
export function resolveAccountId(cfg, accountApi) {
  const explicit = String(cfg?.accountId ?? '').trim()
  if (explicit) return { id: explicit, source: 'config' }

  const hint = '在 ' + configFile() + ' 里手填 accountId'
    + '（mira_account 的 accounts.json 里登记的 qq 账号 id，如 qq-main；不会自动创建）'
  if (!accountApi || typeof accountApi.listAccounts !== 'function') {
    throw new MiraError('config/missing', '必备配置项为空：accountId', hint)
  }
  let qq = []
  try {
    qq = accountApi.listAccounts().filter((a) => a.platform === 'qq')
  } catch (error) {
    if (error?.code === 'account/none') qq = []
    else throw error
  }
  if (qq.length === 1) {
    return {
      id: qq[0].id,
      source: 'pool-single',
      warning: 'accountId 未配置：已用账号池里唯一的 qq 账号 ' + qq[0].id
        + '。建议写进 ' + configFile() + ' 的 accountId（多账号时必须写，否则拒绝猜）',
    }
  }
  if (qq.length === 0) {
    throw new MiraError('account/none', 'mira_account 里一个 qq 账号都没有',
      '先在 ' + accountsFile() + ' 登记账号（或 mira_account_add），再把 id 填进 config.json 的 accountId')
  }
  throw new MiraError('config/missing', 'config.accountId 为空，且账号池里有 ' + qq.length + ' 个 qq 账号',
    hint + '；候选：' + qq.map((a) => a.id).join(' / '))
}

/* ── 加载 ───────────────────────────────────────────────────── */

/** 去掉 `_hint` 这类给人看的注释键（JSON 不支持注释，用下划线键代替）。 */
function stripInternal(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw || {})) {
    if (key.startsWith('_')) continue
    out[key] = value
  }
  return out
}

/** 旧 profile 配置里能直接沿用的顶层键（新结构同名）。 */
const LEGACY_SAME_KEYS = [
  'enabled', 'accountId', 'wsUrl', 'accessToken', 'reconnectMinMs', 'reconnectMaxMs',
  'callTimeoutMs', 'bufferSize', 'mediaDir', 'napcatMediaDir', 'napcatDir', 'tts',
  'backlog', 'busyNoticeSec', 'delivery', 'reply',
]

/**
 * 旧 profile 配置 → 新结构。
 * 返回 { values, legacyConfigKeys, warnings }：
 *   · `autoReply` 整块变成 `reply`，**但会被点名**（不是静默兼容）；
 *   · 同名键照旧生效，它们同样会被点名（因为配置该搬到 config.json 了）。
 */
function normalizeProfile(profileConfig) {
  const raw = profileConfig && typeof profileConfig === 'object' ? stripInternal(profileConfig) : {}
  const values = {}
  const legacyConfigKeys = []
  const warnings = []

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (key === 'autoReply') {
      if (!raw.reply) {
        values.reply = value
        const subKeys = value && typeof value === 'object' ? Object.keys(value) : []
        if (subKeys.length) {
          for (const sub of subKeys) legacyConfigKeys.push('autoReply.' + sub + ' → reply.' + sub)
        } else {
          legacyConfigKeys.push('autoReply → reply')
        }
      } else {
        warnings.push('profile 里同时有 autoReply 与 reply：只用 reply，autoReply 被忽略（见 README「迁移」）')
      }
      continue
    }
    if (LEGACY_SAME_KEYS.includes(key)) {
      values[key] = value
      legacyConfigKeys.push('profile.config.' + key + ' → config.json 的同名键')
      continue
    }
    // 未知键不丢：原样带上（多半是笔误，下一条 warn 会提示）
    values[key] = value
    warnings.push('profile 配置里有本插件不认识的键：' + key + '（已忽略；键表见 README「配置」）')
  }

  if (legacyConfigKeys.length > 0) {
    warnings.push('检测到旧的 profile 配置键（本机 cordis.patch.yml 的方式），已按 README「迁移」的对照表映射并生效；'
      + '建议搬到 ' + configFile() + ' 并删掉 profile 里的这些键：' + legacyConfigKeys.join('；'))
  }
  return { values, legacyConfigKeys, warnings }
}

/** 数值兜底：配置里写成字符串也不至于把定时器搞坏。 */
function num(value, fallback, { min = 0 } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return fallback
  return n
}

/** 校验 + 归一。返回 { cfg } 或 { error }。 */
function normalize(cfg) {
  const file = configFile()
  const invalid = (message, hint) => ({ error: { code: 'config/invalid', message, hint: hint || ('改 ' + file + ' 后重载插件') } })

  cfg.reconnectMinMs = num(cfg.reconnectMinMs, DEFAULTS.reconnectMinMs, { min: 100 })
  cfg.reconnectMaxMs = Math.max(cfg.reconnectMinMs, num(cfg.reconnectMaxMs, DEFAULTS.reconnectMaxMs, { min: 100 }))
  cfg.callTimeoutMs = num(cfg.callTimeoutMs, DEFAULTS.callTimeoutMs, { min: 100 })
  cfg.bufferSize = Math.floor(num(cfg.bufferSize, DEFAULTS.bufferSize, { min: 1 }))
  cfg.busyNoticeSec = num(cfg.busyNoticeSec, DEFAULTS.busyNoticeSec, { min: 0 })

  // backlog
  const backlog = cfg.backlog && typeof cfg.backlog === 'object' ? cfg.backlog : {}
  cfg.backlog = {
    policy: ['drop', 'latest_n', 'replay'].includes(backlog.policy) ? backlog.policy : DEFAULTS.backlog.policy,
    latestN: Math.floor(num(backlog.latestN, DEFAULTS.backlog.latestN, { min: 0 })),
    maxPending: Math.floor(num(backlog.maxPending, DEFAULTS.backlog.maxPending, { min: 0 })),
  }

  // delivery
  const delivery = cfg.delivery && typeof cfg.delivery === 'object' ? cfg.delivery : {}
  const modeOf = (value) => (value === 'queue' ? 'queue' : 'steer')
  cfg.delivery = {
    default: modeOf(delivery.default),
    byPeer: delivery.byPeer && typeof delivery.byPeer === 'object' && !Array.isArray(delivery.byPeer)
      ? Object.fromEntries(Object.entries(delivery.byPeer).map(([k, v]) => [k, modeOf(v)]))
      : {},
  }

  // reply
  const reply = cfg.reply && typeof cfg.reply === 'object' ? cfg.reply : {}
  const mergedReply = deepMerge(structuredClone(DEFAULTS.reply), reply)
  mergedReply.agentTimeoutMs = num(mergedReply.agentTimeoutMs, DEFAULTS.reply.agentTimeoutMs, { min: 50 })
  mergedReply.mergeWindowMs = num(mergedReply.mergeWindowMs, DEFAULTS.reply.mergeWindowMs, { min: 0 })
  mergedReply.groupWhitelist = (Array.isArray(mergedReply.groupWhitelist) ? mergedReply.groupWhitelist : [])
    .map((v) => String(v).trim()).filter(Boolean)
  mergedReply.trustedUsers = Array.isArray(mergedReply.trustedUsers)
    ? mergedReply.trustedUsers.map((v) => String(v)).filter((v) => v.trim())
    : []
  // 私聊白名单：null = 未配置（回落到 trustedUsers），数组（可空）= 显式配置
  mergedReply.privateWhitelist = Array.isArray(mergedReply.privateWhitelist)
    ? mergedReply.privateWhitelist.map((v) => String(v).split(':')[0].trim()).filter(Boolean)
    : null
  mergedReply.groupAccess = ['all', 'mention', 'keyword'].includes(String(mergedReply.groupAccess))
    ? String(mergedReply.groupAccess)
    : DEFAULTS.reply.groupAccess
  const trigger = mergedReply.trigger && typeof mergedReply.trigger === 'object' ? mergedReply.trigger : {}
  mergedReply.trigger = {
    at: trigger.at !== false,
    keywords: (Array.isArray(trigger.keywords) ? trigger.keywords : []).map((v) => String(v)).filter(Boolean),
  }
  mergedReply.stopCommand = String(mergedReply.stopCommand ?? '').trim()
  mergedReply.newCommand = String(mergedReply.newCommand ?? '').trim()
  mergedReply.busyNoticeText = String(mergedReply.busyNoticeText ?? DEFAULTS.reply.busyNoticeText)
  mergedReply.enabled = mergedReply.enabled !== false
  mergedReply.replyToGroup = mergedReply.replyToGroup === true
  mergedReply.groupBypassForTrusted = mergedReply.groupBypassForTrusted !== false
  cfg.reply = mergedReply

  // tts
  const tts = cfg.tts && typeof cfg.tts === 'object' ? cfg.tts : {}
  cfg.tts = { ...DEFAULTS.tts, ...tts }

  // wsUrl 只校验格式（为空时留给 requireWsUrl 报 config/missing，不在这里拒启动）
  const url = String(cfg.wsUrl ?? '').trim()
  if (url && !/^wss?:\/\//i.test(url)) {
    return invalid('wsUrl 格式不对：' + redactText(url, cfg) + '（要 ws:// 或 wss:// 开头）')
  }
  return { cfg }
}

/**
 * 读配置。返回 { ok:true, cfg, path, warnings, legacyConfigKeys, createdTemplate }
 * 或 { ok:false, error, path, warnings }。
 *
 * 文件不存在 → 写一份只带 schemaVersion + `_hint` 的模板（**不写默认值**，
 * 免得把 profile 里正在用的旧配置盖掉）。文件坏 / schemaVersion 不符 → 拒绝使用。
 */
export function loadConfig({ profileConfig = {}, logger = null } = {}) {
  const warnings = []
  const path = configFile()
  const profile = normalizeProfile(profileConfig)
  warnings.push(...profile.warnings)

  const read = readJsonStrict(path)
  let fileValues = {}
  let createdTemplate = false

  if (!read.ok) {
    if (read.reason === 'missing') {
      createdTemplate = writeJsonSecure(path, { schemaVersion: CONFIG_SCHEMA, _hint: HINTS })
      logger?.info?.('[mira_qqbot] 首次加载：已写入配置模板 ' + path
        + (createdTemplate ? '（wsUrl 必填，本插件不自动探测）' : '（写盘失败，请手工创建）'))
    } else {
      return {
        ok: false,
        path,
        warnings,
        legacyConfigKeys: profile.legacyConfigKeys,
        error: {
          code: 'config/schema',
          message: '配置文件无法解析（' + read.reason + '）：' + path,
          hint: '先备份该文件，按 README「配置」一节修正或删掉后重载；本插件不会静默忽略坏配置',
        },
      }
    }
  } else {
    const check = checkSchema(read.value, CONFIG_SCHEMA, path)
    if (!check.ok) {
      return { ok: false, path, warnings, legacyConfigKeys: profile.legacyConfigKeys, error: check.error.error }
    }
    fileValues = stripInternal(read.value)
  }

  // 顺序：DEFAULTS ← profile（旧配置兼容）← 文件（手填的永远优先）
  const merged = deepMerge(deepMerge(structuredClone(DEFAULTS), profile.values), fileValues)
  merged.schemaVersion = CONFIG_SCHEMA

  // 两边都配了同一个键：文件赢，但要点名（避免「改了文件没生效」的错觉）
  const overridden = Object.keys(profile.values).filter((key) => fileValues[key] !== undefined && key !== 'reply')
  if (overridden.length) {
    warnings.push('这些键在 profile 与 ' + path + ' 里都有，以文件为准：' + overridden.join(' / '))
  }

  const normalized = normalize(merged)
  if (normalized.error) return { ok: false, path, warnings, legacyConfigKeys: profile.legacyConfigKeys, error: normalized.error }
  const cfg = normalized.cfg

  // 约定8：配置文件里带 accessToken 时权限必须是 600（顺手纠正一次，并留一条 warn）
  if (String(cfg.accessToken ?? '').trim()) {
    const mode = fileMode(path)
    if (mode !== 0o600) {
      try { chmodSync(path, 0o600) } catch { /* 平台不支持就交给 umask */ }
      warnings.push('config.json 含 accessToken 但权限是 ' + (mode === -1 ? '未知' : '0' + mode.toString(8))
        + '：已改为 600。凭据文件不应对同机其他用户可读')
    }
  }

  return { ok: true, cfg, path, warnings, legacyConfigKeys: profile.legacyConfigKeys, createdTemplate }
}

/** 模板里的手填清单（JSON 没有注释，用 `_hint` 承载）。 */
const HINTS = [
  '本文件是 mira_qqbot 的配置（schemaVersion 必须为 ' + CONFIG_SCHEMA + '）。',
  'wsUrl：必填。OneBot v11 正向 WebSocket 地址，如 ws://127.0.0.1:3001（与 NapCat 的 WebSocket 服务一致）。为空时工具会返回 config/missing，不自动探测。',
  'accessToken：OneBot 的 access_token；空字符串 = NapCat 没开鉴权（合法值）。只写这里，不会进日志/返回值/提交信息；含 token 时本文件权限应为 600。',
  'accountId：mira_account 的 accounts.json 里登记的 qq 账号 id（如 qq-main）。留空时：账号池里只有一个 qq 账号就用它（会 warn），有多个则报 config/missing。',
  'backlog：断线积压策略 drop | latest_n | replay，latestN 默认 20，maxPending 默认 200。',
  'delivery：入站投递方式 steer（插话，默认）| queue（排队）；byPeer 按 "user:123"/"group:456" 覆盖。',
  'reply：应答策略（旧 autoReply.* 搬到这里的同名子键）。agentCwd 指工作空间，agentPreset 默认 sylvia。',
  '完整键表、默认值与旧键对照表见 mira_qqbot/README.md。',
]

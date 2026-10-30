/**
 * mira_qqbot / adapter.js —— 实现 mira_account 的平台适配器契约（platform: 'qq'）
 *
 * 契约（mira_account/README.md「给 bot 插件的契约」，权威实现 lib/service.js）：
 *   adapter = { platform, connect(account, creds), disconnect(account),
 *               send(account, kind, peerId, payload), onMessage(account, cb), status(account),
 *               createSession?({account, kind, peerId, display, text}) }
 * 三条硬约定：
 *   A 入站一律交给 mira_account 路由（本插件不维护 chatId→sessionId 映射）
 *   B 出站一律先 bind（或复用）再 adapter.send —— 发送工具走 miraAccount.send()
 *   C 平台错误用同一套归一错误码
 *
 * 本文件负责：
 *   1. **协议层发送**：把 (kind, peerId, payload.text) 翻成 OneBot 动作；发出后把 message_id
 *      交给 mira_account 记为 self（这样平台把同一条回推时按 echo 丢掉）。
 *   2. **createSession**：`inboundPolicy=create` 时会用到它 —— 用宿主 `agents.create` 起一个
 *      独立 DSH 会话（旧 index.js 的链路：预设挂载 + 会话标题 + preset 归属 + 挂工作空间）。
 *      会话映射由 mira_account 的绑定表保存，这里**不写 meta.json**（旧实现的那套已删）。
 *   3. 连接生命周期：OneBot 连接由插件按 wsUrl 自己建立（与账号池解耦），
 *      adapter.connect 是幂等的 ensureConnected，供 mira_account 的 connectAll 调用。
 *
 * 只依赖 node: 内置能力。
 */

import { randomUUID } from 'node:crypto'
import { MiraError, sleep } from './kit.mjs'
import { DEFAULT_RULES_PROMPT, DEFAULT_SECURITY_PROMPT, configFile, promptLines, redactText } from './config.js'

/* ── 会话装配（旧的 ensureAgent 链路，去掉 meta.json） ───────── */

/**
 * agent 加入预设的 setup：缺少 preset 时工具/提示词/技能为空层且装配报错。
 * 同时注入聊天规则（rulesPrompt，用户配置或内置默认）与可选的自定义人设
 * （personaPrompt 仅显式配置时注入，否则沿用预设自带人设）。
 */
export function presetSetup(cfg, logger = null) {
  return function setup(agentCtx) {
    const ar = cfg.reply || {}
    const presets = agentCtx.get && agentCtx.get('agentPresets')
    const presetId = ar.agentPreset || 'sylvia'
    const mount = presets ? Promise.resolve(presets.mount(agentCtx, presetId)) : Promise.resolve()
    return mount.then(() => {
      const sp = agentCtx.systemPrompt
      if (sp && typeof sp.section === 'function') {
        const rules = promptLines(ar.rulesPrompt, DEFAULT_RULES_PROMPT)
        // 规则放最前（order 最小）+ 强化措辞，确保模型遵守
        sp.section({
          name: 'mira_qqbot:rules',
          order: -100,
          text: '【聊天规则（必须严格遵守，最高优先级）】\n' + rules + '\n\n请确保你的每一次回复都符合以上规则。',
        })
        const persona = ar.personaPrompt || ar.systemPrompt
        if (persona) sp.section({ name: 'mira_qqbot:persona', order: 0, text: '【人设】\n' + persona })
      }
      return undefined
    }).catch((error) => {
      logger?.warn?.('[mira_qqbot] 挂载预设 ' + presetId + ' 失败：' + (error?.message ?? String(error)))
      throw error
    })
  }
}

/** 确保会话已有标题（没有则写入 session/title 事件）。 */
export function ensureSessionTitle(agent, title, logger = null) {
  if (!agent || !agent.session || !title) return
  try {
    const hasTitle = agent.session.events.some((e) => e.type === 'session/title')
    if (!hasTitle) agent.session.append('session/title', { title })
  } catch (error) {
    logger?.warn?.('[mira_qqbot] 设置会话标题失败：' + (error?.message ?? String(error)))
  }
}

/** 确保会话记录 preset 归属（写入 agent-preset/selected 事件，GUI 按预设分组显示）。 */
export function ensureAgentPresetRecord(agent, presetId, logger = null) {
  if (!agent || !agent.session || !presetId) return
  try {
    const has = agent.session.events.some((e) => e.type === 'agent-preset/selected')
    if (!has) agent.session.append('agent-preset/selected', { agentPreset: presetId })
  } catch (error) {
    logger?.warn?.('[mira_qqbot] 写入 preset 归属失败：' + (error?.message ?? String(error)))
  }
}

/** 把会话挂到匹配的工作空间（cwd 对应的 workspace），否则界面归「未分组」。 */
export async function attachToWorkspace(workspaces, sessionId, cwd, logger = null) {
  if (!workspaces || !cwd || !sessionId) return
  try {
    const ws = await workspaces.resolveByPath(cwd)
    if (ws) {
      await ws.attachSession(sessionId)
      logger?.info?.('[mira_qqbot] 会话 ' + sessionId + ' 已挂到工作空间 ' + ws.path)
    } else {
      logger?.warn?.('[mira_qqbot] 工作空间 ' + cwd + ' 尚未注册，会话将显示在「未分组」'
        + '（请在 DSH 界面新建该工作空间，或检查 reply.agentCwd）')
    }
  } catch (error) {
    logger?.warn?.('[mira_qqbot] 挂载工作空间失败 ' + sessionId + '：' + (error?.message ?? String(error)))
  }
}

/** 会话标题（界面显示用）：群名(群号) / 昵称(QQ号)。 */
export async function sessionTitleFor({ kind, peerId, display, call, logger = null }) {
  if (kind === 'group') {
    let name = '群聊'
    try {
      const info = await call('get_group_info', { group_id: peerId })
      if (info && info.group_name) name = info.group_name
    } catch { /* 拿不到群名时降级 */ }
    return name + '(' + peerId + ')'
  }
  const name = String(display || peerId || '').trim() || String(peerId)
  return name + '(' + peerId + ')'
}

/* ── 适配器 ────────────────────────────────────────────────── */

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {import('./onebot.js').OneBotClient} deps.onebot
 * @param {object} deps.media                     createMedia(...) 的产物
 * @param {object|null} deps.agents               ctx.agents
 * @param {object|null} deps.workspaces           ctx.workspaceRegistry
 * @param {object|null} deps.account              ctx.miraAccount（用来 markSelf）
 * @param {() => string} deps.getAccountId
 * @param {object} [deps.logger]
 * @param {object} [deps.counters]
 * @param {() => number} [deps.now]
 */
export function createQqAdapter({
  getConfig, onebot, media, agents = null, workspaces = null,
  account = null, getAccountId = () => '', logger = null, counters = null, now = () => Date.now(),
}) {
  /** accountId → onMessage 回调（mira_account 目前只校验方法存在，不会调用；留着契约） */
  const messageHandlers = new Map()

  /**
   * 正文里的 `[` / `]` / `&` 必须转成 CQ 实体再发。
   *
   * 为什么：OneBot/NapCat 会把 message 字符串里的 `[CQ:xxx]` 解析成消息段；正文里只要出现
   * 一个**不合法或未知**的 CQ 段（模型复述入站里的 CQ 码、用户直接打字带方括号），
   * NapCat 会整条拒发 —— 表现是「整条消息发送失败」，而不是"那个方括号没发出来"。
   * 转义后就是纯文本，内容原样可见（&#91; 会被客户端显示成 `[`）。
   */
  function escapeCqText(text) {
    return String(text ?? '')
      .replace(/&/g, '&#38;')
      .replace(/\[/g, '&#91;')
      .replace(/\]/g, '&#93;')
  }

  /** 把 (kind, peerId) 翻成 OneBot 动作与参数。 */
  function toAction(kind, peerId, message) {
    if (kind === 'group') return { action: 'send_group_msg', params: { group_id: peerId, message } }
    if (kind === 'channel') return { action: 'send_guild_channel_msg', params: { channel_id: peerId, message } }
    if (kind === 'room') {
      throw new MiraError('platform/unsupported', 'qq 适配器不支持 kind=room',
        'room 是 B 站直播间用的；qq 只有 user / group / channel')
    }
    return { action: 'send_private_msg', params: { user_id: peerId, message } }
  }

  /**
   * 协议层直发（发完把 message_id 记成 self，避免自己发的东西又被当成入站）。
   * 系统提示（忙碌/已停止）也走这里：它们不是「会话发起的出站」，不该抢 binding。
   */
  async function sendRaw(kind, peerId, text, { accountId = '', actionName = 'send', cq = false } = {}) {
    const cfg = getConfig() || {}
    // cq:true 只给"插件自己拼好的 CQ 串"（图片/语音/媒体文件）用；其余一律转义，防整条发送失败
    const raw = String(text ?? '')
    const message = await media.transformMediaMessage(cq ? raw : escapeCqText(raw))
    if (!String(message).trim()) {
      throw new MiraError('config/missing', 'message 为空，没有可发送的内容', '至少给一段文本')
    }
    const { action, params } = toAction(kind, peerId, message)
    const result = await onebot.call(action, params)
    const messageId = result && (result.message_id ?? result.messageId)
    const id = messageId === undefined || messageId === null ? null : String(messageId)
    if (id && account && typeof account.markSelf === 'function') {
      const accountIdNow = String(accountId || '').trim() || String(getAccountId?.() ?? '').trim()
      if (accountIdNow) {
        try { account.markSelf(accountIdNow, id) } catch { /* 记不上不影响已发出 */ }
      }
    }
    counters?.bump('outbound.sent')
    logger?.info?.('[mira_qqbot] ' + actionName + ' ' + kind + ':' + peerId
      + (id ? ' id=' + id : '') + '（' + String(message).slice(0, 40).replace(/\s+/g, ' ') + '）')
    return { ok: true, messageId: id, kind, peerId, action }
  }

  const adapter = {
    platform: 'qq',
    name: 'mira_qqbot',

    /** 幂等 ensureConnected：OneBot 连接按 config.wsUrl 建立，与账号池解耦。 */
    async connect(accountRow) {
      const cfg = getConfig() || {}
      if (!String(cfg.wsUrl ?? '').trim()) {
        return {
          ok: false,
          error: {
            code: 'config/missing',
            message: '必备配置项为空：wsUrl',
            hint: '在 ' + configFile() + ' 里手填 wsUrl（如 ws://127.0.0.1:3001；不自动探测）',
          },
        }
      }
      if (onebot.connected) return { ok: true, already: true, selfId: onebot.selfId }
      onebot.connect()
      // 等一小会儿确认真的连上（mira_account 会用这个结果设账号 state）
      const deadline = now() + 2000
      while (!onebot.connected && now() < deadline) await sleep(20)
      if (!onebot.connected) {
        return {
          ok: false,
          error: {
            code: 'delivery/failed',
            message: '连不上 OneBot：' + redactText(String(cfg.wsUrl ?? ''), cfg),
            hint: '确认 NapCat 在跑、wsUrl 与 accessToken 与 NapCat 的 WebSocket 服务一致；看 qq_status.lastError',
          },
        }
      }
      return { ok: true, connected: true, accountId: accountRow?.id ?? null, selfId: onebot.selfId }
    },

    async disconnect() {
      onebot.close()
      return { ok: true }
    },

    /**
     * mira_account.send() 的落地：payload.text 里可以是纯文本，也可以是 CQ 码串。
     * 返回 { ok, messageId }（messageId 会被自动记成 self）。
     */
    async send(accountRow, kind, peerId, payload) {
      const text = payload && (payload.text ?? payload.message)
      if (text === undefined || text === null || String(text).trim() === '') {
        throw new MiraError('config/missing', 'payload 里没有 text',
          'qq 适配器只认 payload.text（纯文本或 CQ 码串）')
      }
      const sent = await sendRaw(kind, peerId, String(text), {
        accountId: accountRow?.id ?? '',
        actionName: '发送',
        // 默认把正文当**纯文本**（方括号被转义）；只有显式 cq:true 才按 CQ 码解析
        cq: payload && payload.cq === true,
      })
      return { ok: true, messageId: sent.messageId }
    },

    /**
     * mira_account 只校验这个方法存在（真正入站路由由本插件调 miraAccount.inbound / resolve）。
     * 保留契约形状，便于以后框架改成「适配器推入站」。
     */
    onMessage(accountRow, cb) {
      const id = String(accountRow?.id ?? '').trim() || 'default'
      messageHandlers.set(id, cb)
      return () => { if (messageHandlers.get(id) === cb) messageHandlers.delete(id) }
    },

    status() {
      return {
        ok: true,
        platform: 'qq',
        ...onebot.status(),
      }
    },

    /**
     * 可选契约：inboundPolicy=create 时 mira_account 会调它建会话。
     * 用宿主 agents.create 起独立 DSH 会话（旧 index.js 的链路，去掉 meta.json）。
     * 返回 sessionId（mira_account 负责把它登记成 taker）。
     */
    async createSession({ account: accountRow, kind, peerId, display = '', text = '' } = {}) {
      const cfg = getConfig() || {}
      const ar = cfg.reply || {}
      if (!agents || typeof agents.create !== 'function') {
        throw new MiraError('delivery/failed', 'DSH agents 服务不可用，无法新建会话',
          '确认宿主版本提供 ctx.agents；或把 mira_account 里该账号的 inboundPolicy 改成 default/drop')
      }
      const title = await sessionTitleFor({ kind, peerId, display, call: onebot.call.bind(onebot), logger })
      const presetId = ar.agentPreset || 'sylvia'
      const agentOptions = {}
      if (ar.agentProvider) agentOptions.provider = ar.agentProvider
      if (ar.agentModel) agentOptions.model = ar.agentModel
      if (!ar.agentProvider && !ar.agentModel) {
        logger?.warn?.('[mira_qqbot] 未配置 reply.agentProvider/agentModel，可能报 "has no provider/model"；'
          + '留空时用宿主默认模型与预设')
      }

      const sessionId = 'qq-' + now().toString(36) + '-' + randomUUID().slice(0, 6)
      const handle = await agents.create({
        sessionId,
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
        meta: {
          // 关键：指定工作目录，会话归属工作空间（GUI 刷新不丢）；header 记录 preset
          ...(ar.agentCwd ? { cwd: ar.agentCwd } : {}),
          agentPreset: presetId,
        },
        setup: presetSetup(cfg, logger),
      })
      const agent = handle && handle.agent
      if (!agent) {
        throw new MiraError('delivery/failed', 'agents.create 没有返回 agent（会话 ' + sessionId + '）',
          '看 DSH 日志；检查 reply.agentPreset 是否是存在的预设')
      }
      ensureSessionTitle(agent, title, logger)
      ensureAgentPresetRecord(agent, presetId, logger)
      await attachToWorkspace(workspaces, sessionId, ar.agentCwd, logger)
      counters?.bump('session.created')
      logger?.info?.('[mira_qqbot] 已创建 agent 会话 ' + sessionId
        + '（' + kind + ':' + peerId + '，标题 ' + title + '）'
        + (ar.agentCwd ? '，工作目录 ' + ar.agentCwd : '，未指定 cwd（会话可能不在界面显示）'))
      return sessionId
    },
  }

  /** 给 route / inbound 用的「只发文本」快捷方式（系统提示走它）。 */
  adapter.sendRaw = sendRaw

  return adapter
}

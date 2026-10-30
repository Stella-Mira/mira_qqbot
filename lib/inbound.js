/**
 * mira_qqbot / inbound.js —— 入站管线：事件解析 + 去重 + 合并窗口 + 断线积压 + 群/白名单策略
 *
 * 一条入站事件的处理顺序（顺序本身是语义，别随手调）：
 *
 *   1. 缓冲：写进 `qq_recv_messages` 的环形缓冲（模型仍可 pull 原始事件）。
 *   2. 自身 echo：`message_sent` 或 `user_id === selfId` → 不投递，`dedup.echo` 计数（功能点7）。
 *   3. 去重：`message_id` 走 mira_account 的 seen 表（功能点7：不再用旧的自维护单槽 lastDedupKey）。
 *      · 有绑定的消息：这里先查（`miraAccount.seen`）；
 *      · 没绑定的消息：交给 `miraAccount.inbound()`，由它自己去重 + 按 inboundPolicy 建/投/丢。
 *   4. 访问策略（功能点6）：群范围 → 陌生人 → 群触发（@ / 关键词 / 白名单免 @）。
 *      被忽略的消息**计数可见**（`qq_status.ignored`），不是静默丢弃。
 *   5. 命令：`/stop`（agent.cancel）、`/new`（释放会话 + 解绑）；两者都先作废该 peer 的合并窗口
 *      （窗口里还没投的消息按「已处理」记账，不会在窗口外/新会话里再投一次）。
 *   6. 合并窗口：同一 peer 在窗口内的多条消息合并成一条（窗口内只投一次）。
 *   7. 投递：已绑定 → `route.deliver`（steer/queue + 忙/超时）；
 *      未绑定 → `miraAccount.inbound()`（按账号 inboundPolicy：create / default / drop）。
 *
 * 断线积压（功能点5）：连接不可用时到达的入站事件先进进程内队列，重连后按
 * `backlog.policy`（drop / latest_n（默认 20）/ replay）决定补哪些，并把
 * received / dropped / backfilled 记进 `qq_status.backlog`。
 *
 * 只依赖 node: 内置能力。
 */

import {
  DEFAULT_RULES_PROMPT, DEFAULT_SECURITY_PROMPT, groupAccessMode, isTrusted, privateAccessAllowed,
  promptLines, trustedRoster, whitelistEnabled,
} from './config.js'
import { toError } from './kit.mjs'

/** 合并窗口里等待的消息条数上限（防止一次刷屏把内存吃光）。 */
const MERGE_MAX_ITEMS = 50

/**
 * 事件内容的可用性分类（区分「无段空事件」与「用户真的只发了空白」）。
 *
 * 现场 bug：OneBot 会推 `message_type: private`、`message: ""`、`raw_message: ""` 的 message 事件
 * （撤回/系统提示一类），没有任何段、没有文本。它不该进 `qq_recv_messages` 缓冲，更不该被下游
 * 当成「用户发来一条空消息」。而用户只敲了空格时，事件**有消息帧**（message 段数组/字符串或
 * 非空 raw_message），只是正文为空 —— 这是正常消息，按「空正文」记账即可，两者必须分得开。
 *
 * kind:
 *   'content' —— 有可用内容（文本/图片/表情/…；extractText 对非文本段会给占位文本）
 *   'blank'   —— 有消息帧，但正文只有空白（真正的空文本）
 *   'empty'   —— 连消息帧都没有（message 为 []/空串/缺失，且 raw_message 为空）→ 无段空事件
 * segments: 原始段类型（保序），供缓冲记录与 `qq_status.lastEmpty` 保留「最后一次段类型」。
 */
function classifyMessageContent(event, text) {
  const message = event?.message
  const hasArray = Array.isArray(message)
  const hasString = typeof message === 'string' && message.length > 0
  const hasRaw = typeof event?.raw_message === 'string' && event.raw_message.length > 0
  const segments = hasArray
    ? message.map((seg) => (seg && typeof seg.type === 'string' ? seg.type : '')).filter(Boolean)
    : []
  if (String(text ?? '').trim()) return { kind: 'content', segments }
  // 段数组里有非文本段（图片/表情/语音…）时 extractText 会给占位文本；能走到这里说明没有可用段
  if (segments.some((type) => type !== 'text')) return { kind: 'content', segments }
  // 有实际段（哪怕是空文本段）或非空 raw_message 才算「有消息帧」；message: [] 不算
  if (segments.length > 0 || hasString || hasRaw) return { kind: 'blank', segments }
  return { kind: 'empty', segments }
}

export class Inbound {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig
   * @param {object|null} options.logger
   * @param {object} options.counters                     kit.makeCounters()
   * @param {import('./onebot.js').OneBotClient} options.onebot
   * @param {object|null} options.account                  ctx.miraAccount
   * @param {import('./route.js').Router} options.route
   * @param {object} options.media                        createMedia(...) 的产物
   * @param {() => {id:string,source:string,warning?:string}} options.resolveAccount
   * @param {(input:{kind:string,peerId:string,text:string}) => Promise<object>} [options.sendRaw]
   * @param {(error:object) => void} [options.noteError]
   * @param {() => number} [options.now]
   */
  constructor({
    getConfig, logger = null, counters, onebot, account = null, route, media,
    resolveAccount, sendRaw = null, noteError = null, now = () => Date.now(),
  }) {
    this.getConfig = getConfig
    this.logger = logger
    this.counters = counters
    this.onebot = onebot
    this.account = account
    this.route = route
    this.media = media
    this.resolveAccount = resolveAccount
    this.sendRaw = sendRaw
    this.noteError = noteError
    this.now = now

    /** qq_recv_messages 的环形缓冲 */
    this.buffer = []
    /** seq 以时间戳为起点：进程重启后仍递增，持久化会话里记录的旧 since 不会漏收 */
    this.seq = this.now() * 1000
    /** 断线期间的入站事件 */
    this.backlog = []
    /** 累计统计（status 里如实报告） */
    this.stats = { received: 0, dropped: 0, backfilled: 0 }
    /** 最后一次空事件/空文本（qq_status.lastEmpty）：空事件不进缓冲，这是唯一的现场痕迹 */
    this.lastEmpty = null
    /** chatKey → { items:[{msg,ctx}], timer } */
    this.merges = new Map()
    /** 在飞的异步投递（合并窗口 flush / pending 用） */
    this.inflight = new Set()
    this.stopped = false
  }

  /* ── 入口 ─────────────────────────────────────────────── */

  /** OneBot 事件入口（由 onebot.onEvent 调）。 */
  async ingest(event) {
    if (!event || typeof event !== 'object') return { routed: 'ignored', reason: 'not-event' }
    const cfg = this.getConfig() || {}
    const postType = String(event.post_type ?? '')

    // 无段空事件（message 与 raw_message 都是空串/缺失）：撤回/系统提示一类，没内容可给下游。
    // 必须挡在缓冲之前 —— 否则 qq_recv_messages 会「收到一条空消息」，下游只能凭空猜。
    // 只拦 inbound 的 message 事件；message_sent 是发送回执，空回执仍按 echo 处理。
    if (postType === 'message') {
      const content = classifyMessageContent(event, this.media.extractText(event))
      if (content.kind === 'empty') {
        this.counters.bump('ignored.empty')
        this.#noteEmpty(event, content)
        return { routed: 'ignored', reason: 'empty', empty: 'event', segments: content.segments }
      }
    }

    this.#buffer(event)

    if (postType !== 'message' && postType !== 'message_sent') {
      return { routed: 'ignored', reason: 'not-message' }
    }
    const parsed = this.parse(event)
    if (!parsed) return { routed: 'ignored', reason: 'unparsed' }

    // 功能点7 来源 1：自身 echo（message_sent，或 user_id 就是自己）
    if (parsed.echo || parsed.isSelf) return this.#handleEcho(parsed)

    if (!cfg.reply || cfg.reply.enabled === false) {
      this.counters.bump('ignored.replyDisabled')
      return { routed: 'ignored', reason: 'reply-disabled' }
    }
    if (!this.onebot.connected) return this.#enqueueBacklog(event)

    return this.handleEvent(event)
  }

  /** 重连后调用：把断线期间的积压按策略补投。 */
  async onConnected() {
    if (this.stopped || this.backlog.length === 0) return null
    return this.flushBacklog()
  }

  /* ── 解析 ─────────────────────────────────────────────── */

  /**
   * 事件 → 归一消息。
   * kind: user | group | channel（channel 只做兜底，qq 侧一般用不到）
   */
  parse(event) {
    if (!event || typeof event !== 'object') return null
    const postType = String(event.post_type ?? '')
    const selfId = this.onebot.selfId
    const messageId = event.message_id === undefined || event.message_id === null
      ? null : String(event.message_id)
    const text = this.media.extractText(event)
    const content = classifyMessageContent(event, text)

    if (postType === 'message_sent') {
      const mt = String(event.message_type ?? '')
      const kind = mt === 'group' ? 'group' : (mt === 'guild' ? 'channel' : 'user')
      const peerId = String(event.target_id ?? event.group_id ?? event.channel_id ?? event.user_id ?? '').trim()
      if (!peerId) return null
      return {
        echo: true,
        isSelf: true,
        kind,
        peerId,
        userId: String(selfId ?? event.user_id ?? ''),
        messageId,
        text,
        // 段类型 + 空文本标记：下游能分清「空文本」与「无段空事件」
        segments: content.segments,
        contentKind: content.kind,
        empty: content.kind !== 'content',
        display: String(event.sender?.nickname ?? peerId),
        isGroup: kind === 'group',
        raw: event,
      }
    }
    if (postType !== 'message') return null

    const messageType = String(event.message_type ?? '')
    let kind = 'user'
    let peerId = ''
    if (messageType === 'group') {
      kind = 'group'
      peerId = String(event.group_id ?? '').trim()
    } else if (messageType === 'guild') {
      kind = 'channel'
      peerId = String(event.channel_id ?? '').trim()
    } else {
      kind = 'user'
      peerId = String(event.user_id ?? '').trim()
    }
    if (!peerId) return null

    const sender = event.sender && typeof event.sender === 'object' ? event.sender : {}
    const userId = String(sender.user_id ?? event.user_id ?? '').trim()
    const display = kind === 'group'
      ? String(sender.card || sender.nickname || userId)
      : String(sender.nickname || sender.card || userId)

    return {
      echo: false,
      isSelf: selfId !== null && selfId !== undefined && userId !== '' && String(userId) === String(selfId),
      kind,
      peerId,
      userId,
      messageId,
      text,
      // 段类型 + 空文本标记：下游能分清「空文本」与「无段空事件」
      segments: content.segments,
      contentKind: content.kind,
      empty: content.kind !== 'content',
      display,
      isGroup: kind === 'group',
      raw: event,
    }
  }

  /* ── 处理 ─────────────────────────────────────────────── */

  /** 处理一条已解析事件（也用于积压回放；回放时不走合并窗口）。 */
  async handleEvent(event, { replaying = false } = {}) {
    const cfg = this.getConfig() || {}
    const msg = this.parse(event)
    if (!msg) return { routed: 'ignored', reason: 'unparsed' }
    if (msg.echo || msg.isSelf) return this.#handleEcho(msg)
    // 兜底：无段空事件就算绕过 ingest 进来（积压回放 / 直接调用），也不该进投递管线
    if (msg.contentKind === 'empty') {
      this.counters.bump('ignored.empty')
      this.#noteEmpty(event, { kind: msg.contentKind, segments: msg.segments })
      return { routed: 'ignored', reason: 'empty', empty: 'event', segments: msg.segments }
    }

    let accountId = ''
    try {
      accountId = String(this.resolveAccount().id)
    } catch (error) {
      const normalized = toError(error, 'config/missing')
      this.counters.bump('inbound.noAccount')
      this.noteError?.(normalized.error)
      return { routed: 'error', error: normalized.error }
    }
    if (!this.account) {
      const normalized = toError({
        code: 'platform/unsupported',
        message: 'miraAccount 服务不可用，入站无法路由',
        hint: 'mira_qqbot 的 inject 里有 miraAccount（硬依赖）；确认 mira_account 已装并加载',
      })
      this.counters.bump('inbound.noAccount')
      this.noteError?.(normalized.error)
      return { routed: 'error', error: normalized.error }
    }

    // 绑定查询（无副作用）：决定走本插件的 route 还是交给 mira_account 的 inboundPolicy
    let resolved = null
    try {
      resolved = this.account.resolve(accountId, msg.kind, msg.peerId)
    } catch (error) {
      const normalized = toError(error, 'account/not-found')
      this.counters.bump('inbound.resolveFailed')
      this.noteError?.(normalized.error)
      return { routed: 'error', error: normalized.error }
    }
    const bound = !!(resolved?.taker || (resolved?.observers?.length > 0))

    // 功能点7 来源 2/3：平台重发 / 同一 message_id 多次投递（有绑定时先查；没绑定交给 inbound）
    if (bound && msg.messageId) {
      // 只查不记：投递失败时不该把 message_id 吞掉（否则平台重推会被当成重复，消息永久消失）
      const verdict = this.#verdict(accountId, msg.messageId)
      if (verdict.duplicate) {
        this.counters.bump(verdict.echo ? 'dedup.echo' : 'dedup.duplicate')
        return { routed: 'dup', duplicate: true, echo: !!verdict.echo, messageId: msg.messageId }
      }
    }

    // 功能点6：群范围 / 陌生人 / 群触发
    const access = this.#access(cfg, msg)
    if (!access.ok) {
      // 被策略忽略的消息也登记：平台重发同一条不该把计数刷两遍（有意丢弃，没有"重试"语义）
      this.#recordSeen(accountId, msg.messageId)
      this.counters.bump('ignored.' + access.reason)
      return { routed: 'ignored', reason: access.reason, chatKey: msg.kind + ':' + msg.peerId }
    }

    // 功能点4：命令（放在访问策略之后 —— 陌生人不能 /stop 你的会话）
    // 命令 = 用户改主意：先作废该 peer 还没投的合并窗口，否则窗口到期的旧消息会照常投递
    // （/stop 等于没停；/new 之后旧会话还会被叫回来，回复再反向绑定把 /new 撤销）。
    const isStop = this.#isCommand(cfg.reply?.stopCommand, msg.text)
    const isNew = this.#isCommand(cfg.reply?.newCommand, msg.text)
    if (isStop || isNew) {
      const chatKey = msg.kind + ':' + msg.peerId
      const droppedPending = this.#dropMerge(chatKey)
      // 命令本身是有意处理：按「已处理」记账，平台重推同一条不该再执行一次
      this.#settleSeen(accountId, msg.messageId, true)
      return isStop
        ? this.#stopCommand(msg, resolved, droppedPending)
        : this.#newCommand(msg, resolved, droppedPending)
    }

    const ctx = { resolved, bound, accountId }

    // 合并窗口（回放时跳过：积压里的历史消息不该再等 3 秒）
    const windowMs = Math.max(0, Number(cfg.reply?.mergeWindowMs) || 0)
    if (!replaying && windowMs > 0) return this.#merge(msg, ctx)

    return this.#process(msg, ctx)
  }

  async #process(msg, ctx) {
    const userText = await this.#userText(msg)
    if (!userText.trim()) {
      // 空正文（只有图片/表情且没解析出文本）有意不投递：按「已处理」记账，平台重推不该再算一次
      this.#settleSeen(ctx.accountId, msg.messageId, true)
      // 这里记的是「真正的空文本」（事件有消息帧，只是正文为空），不是无段空事件
      this.#noteEmpty(msg.raw, { kind: 'blank', segments: msg.segments })
      this.counters.bump('ignored.empty')
      return { routed: 'ignored', reason: 'empty', empty: 'blank-text', segments: msg.segments }
    }
    return this.#deliverPrepared(msg, userText, ctx)
  }

  /** 准备给 agent 的「用户消息正文」：转发内容 + 群内昵称前缀 + 附件落盘路径。 */
  async #userText(msg) {
    let text = String(msg.text ?? '')
    // 转发消息：把 [CQ:forward,id=...] 替换为实际内容；多个转发段只插一次全量
    const forward = await this.media.extractForwardContent(msg.raw)
    if (forward) {
      text = text.replace(/\[CQ:forward,[^\]]*\]/g, '')
      text = (text.trim() ? text.trim() + '\n' : '') + '[转发消息]\n' + forward
    }
    if (!text.trim()) return ''
    // 群聊：消息前标注发送者，合并多条时能区分是谁说的
    if (msg.kind === 'group') {
      text = '群内昵称（' + msg.display + '｜' + msg.userId + '）：' + text
    }
    return this.media.enrichWithMedia(text, msg.raw)
  }

  /** 拼给 agent 的完整文本块（安全规则 / 识别名单 / 来源 / 角色 / 时间 / 行为规则 / 聊天消息）。 */
  #buildPrompt(cfg, msg, userText, role = 'unknown') {
    const ar = cfg.reply || {}
    const isGroup = msg.kind === 'group'
    const replyTool = isGroup ? 'qq_send_group_msg' : 'qq_send_private_msg'
    const securityBlock = '【安全规则】\n' + promptLines(ar.securityPrompt, DEFAULT_SECURITY_PROMPT)
    // 识别名单按**原文**注入：'1001:张三，是你的朋友' 冒号后是人设说明，别截掉
    const roster = trustedRoster(cfg)
    const rosterBlock = '【识别名单】\n' + (roster.length ? roster.join('\n') : '（暂无）')
    const sourceBlock = '【消息来源】\n'
      + '工具：mira_qqbot\n'
      + '性质：' + (isGroup ? '群聊' : '私聊') + '\n'
      + '用户：' + msg.display + '\n'
      + 'ID号：' + msg.peerId + '\n'
      + '回复工具：' + replyTool
    const timeBlock = '【当前时间】\n' + new Date(this.now()).toLocaleString('zh-CN', { hour12: false })
    const roleBlock = this.#roleBlock(role, replyTool, isGroup)
    const rulesBlock = '【行为规则】\n' + promptLines(ar.rulesPrompt, DEFAULT_RULES_PROMPT)
    const msgBlock = '【聊天消息】\n' + userText
    return [securityBlock, rosterBlock, sourceBlock, roleBlock, timeBlock, rulesBlock, msgBlock].join('\n\n')
  }

  /**
   * 角色块：明确告诉 agent「你在这次对话里的身份」。
   * 这是 taker / observer 区分的**唯一显式来源** —— 不写进提示词，agent 只能靠"我收到了消息"
   * 猜自己是该回还是旁听，围观会话就会抢话。
   */
  #roleBlock(role, replyTool, isGroup) {
    const head = '【本会话角色】\n'
    if (role === 'observer') {
      return head + '旁听（observer）：这条对话线已经有人在应答，你只是旁听。\n'
        + '**不要回复这条消息，不要调用 ' + replyTool + '**（否则会和应答方重复说话）。\n'
        + '要接管这条对话线：调用 mira_account_bind（kind/peerId 用上面【消息来源】里的值，force: true）。'
    }
    if (role === 'taker') {
      return head + '应答（taker）：这条对话线由你负责。\n'
        + '要说话就调用 ' + replyTool + '；不想说就不调用（不调用 = 不发言）。'
        + (isGroup
          ? '\n群聊里你能看到群内所有消息（包括与你无关的闲聊），没人问你、也不想插话时完全可以不调用工具。'
          : '')
    }
    return head + '未确定：这条消息刚进来，绑定还在建立/由 inboundPolicy 决定。\n'
      + '要用 qq_role 查清自己在这个 peer 上是 taker 还是 observer；确认是应答方再用 ' + replyTool + ' 回复。'
  }

  /** 该账号的入站策略（用来推断「未绑定」这条消息会落到什么角色）。拿不到就返回空串。 */
  #inboundPolicy(accountId) {
    try {
      const rows = this.account?.listAccounts?.() || []
      const row = rows.find((a) => a && a.id === accountId)
      return String(row?.inboundPolicy ?? '')
    } catch {
      return ''
    }
  }

  /** 真正投递：已绑定 → route（steer/queue + 忙/超时）；未绑定 → mira_account.inbound。 */
  async #deliverPrepared(msg, userText, ctx) {
    const cfg = this.getConfig() || {}
    // 角色：已绑定看 taker/observers；未绑定按账号 inboundPolicy 推断（create → 新会话会是 taker）
    let role = 'unknown'
    if (ctx.bound) role = ctx.resolved?.taker ? 'taker' : 'observer'
    else if (this.#inboundPolicy(ctx.accountId) === 'create') role = 'taker'
    const text = this.#buildPrompt(cfg, msg, userText, role)
    const chatKey = msg.kind + ':' + msg.peerId
    const meta = {
      accountId: ctx.accountId,
      platform: 'qq',
      kind: msg.kind,
      peerId: msg.peerId,
      messageId: msg.messageId,
      sender: msg.userId,
      display: msg.display,
    }

    if (ctx.bound) {
      if (ctx.resolved?.taker) {
        const delivery = await this.route.deliver({
          sessionId: ctx.resolved.taker.sessionId,
          kind: msg.kind, peerId: msg.peerId, text, meta,
          role: 'taker', notifyBusy: true,
        })
        // 投递成功才记账；失败要撤销占位，平台重推同一条才能立刻重试
        if (delivery && delivery.ok !== false) this.#recordSeen(ctx.accountId, msg.messageId)
        else this.#releaseSeen(ctx.accountId, msg.messageId)
        this.counters.bump('inbound.taker')
        return { routed: 'taker', sessionId: ctx.resolved.taker.sessionId, chatKey, delivery }
      }
      const observers = ctx.resolved?.observers || []
      const deliveries = []
      for (const observer of observers) {
        // observer 只收不答：投递方式固定按该 peer 的配置（观察者会话不一定该回话）
        // 旁听者不发「在处理」：那是应答方的事，旁听会话抢着回一句是错的
        deliveries.push(await this.route.deliver({
          sessionId: observer.sessionId,
          kind: msg.kind, peerId: msg.peerId, text, meta,
          role: 'observer', notifyBusy: false,
        }))
      }
      this.counters.bump('inbound.observer')
      // 至少投成功一个才记账；全失败撤销占位让重推能重试
      if (deliveries.some((d) => d && d.ok !== false)) this.#recordSeen(ctx.accountId, msg.messageId)
      else this.#releaseSeen(ctx.accountId, msg.messageId)
      return { routed: 'observer', sessionIds: observers.map((o) => o.sessionId), chatKey, deliveries }
    }

    let result
    try {
      result = await this.account.inbound({
        accountId: ctx.accountId,
        kind: msg.kind,
        peerId: msg.peerId,
        display: msg.display,
        message: {
          id: msg.messageId,
          text,
          sender: { id: msg.userId, nickname: msg.display },
        },
      })
    } catch (error) {
      // 框架层抛错（账号停用 / 建会话失败 / 策略非法）：归一后如实返回，不把整条管线带崩
      const normalized = toError(error, 'delivery/failed', '看 mira_account_status 与 qq_status.lastError')
      this.counters.bump('inbound.failed')
      this.noteError?.(normalized.error)
      return { routed: 'error', chatKey, error: normalized.error }
    }
    const routed = (result && result.routed) || 'error'
    this.counters.bump('inbound.' + routed)
    return result || { routed: 'error', chatKey }
  }

  /* ── 去重 ─────────────────────────────────────────────── */

  #handleEcho(msg) {
    const accountId = this.#accountIdOrNull()
    if (accountId && msg.messageId) this.#markSeen(accountId, msg.messageId)
    this.counters.bump('dedup.echo')
    return { routed: 'dup', echo: true, messageId: msg.messageId, reason: 'self-echo' }
  }

  /** 只查不记（优先用 mira_account 的新 API；旧版退化成 seen，语义略宽但不会丢消息）。 */
  #verdict(accountId, messageId) {
    if (!this.account || !messageId) return { duplicate: false }
    try {
      if (typeof this.account.verdict === 'function') {
        return this.account.verdict(accountId, messageId) || { duplicate: false }
      }
      if (typeof this.account.seen === 'function') {
        return { duplicate: this.account.seen(accountId, messageId) === true, legacy: true }
      }
    } catch { /* 去重失败不该阻断投递 */ }
    return { duplicate: false }
  }

  /** 投递成功后记账（优先 recordSeen；旧版退化成 markSeen）。 */
  #recordSeen(accountId, messageId) {
    if (!this.account || !messageId) return
    try {
      if (typeof this.account.recordSeen === 'function') this.account.recordSeen(accountId, messageId)
      else if (typeof this.account.markSeen === 'function') this.account.markSeen(accountId, messageId)
    } catch { /* 记账失败不影响这次投递 */ }
  }

  /** 投递失败时撤销去重占位（旧版没有这个 API 就什么都不做）。 */
  #releaseSeen(accountId, messageId) {
    if (!this.account || !messageId) return
    try {
      if (typeof this.account.releaseSeen === 'function') this.account.releaseSeen(accountId, messageId)
    } catch { /* 撤销失败最多让这条 id 多等一会儿 */ }
  }

  /**
   * 去重占位的统一结算：命令 / 空正文 / 溢出丢弃 / 窗口清空都走这里。
   * handled=true 按「已处理」记账（recordSeen），false 按「未投递」释放（releaseSeen）。
   */
  #settleSeen(accountId, messageId, handled) {
    if (!messageId) return
    if (handled) this.#recordSeen(accountId, messageId)
    else this.#releaseSeen(accountId, messageId)
  }

  /** 一批合并条目（[{msg, ctx}]）统一结算。 */
  #settleItems(items, handled = true) {
    for (const item of items || []) this.#settleSeen(item?.ctx?.accountId, item?.msg?.messageId, handled)
  }

  /**
   * 清掉某个 chatKey 的合并窗口，被丢弃的条目按 handled 结算。
   * 命令（/stop、/new）要作废窗口里还没投的消息：按「已处理」记账 ——
   * 用户明确改主意了，平台重推同一条也不该在窗口外/新会话里再投一次。
   */
  #dropMerge(chatKey, handled = true) {
    const slot = this.merges.get(chatKey)
    if (!slot) return 0
    this.merges.delete(chatKey)
    if (slot.timer) clearTimeout(slot.timer)
    this.#settleItems(slot.items, handled)
    return slot.items.length
  }

  #seen(accountId, messageId) {
    if (!this.account || typeof this.account.seen !== 'function') return false
    try {
      return this.account.seen(accountId, messageId) === true
    } catch {
      return false
    }
  }

  #markSeen(accountId, messageId) {
    if (!this.account || !messageId || typeof this.account.markSeen !== 'function') return
    try { this.account.markSeen(accountId, messageId) } catch { /* 登记失败不影响流程 */ }
  }

  #accountIdOrNull() {
    try { return String(this.resolveAccount().id) } catch { return '' }
  }

  /* ── 访问策略（功能点6） ───────────────────────────────── */

  #access(cfg, msg) {
    const reply = cfg.reply || {}
    if (msg.kind === 'group') {
      if (reply.replyToGroup !== true) return { ok: false, reason: 'groupDisabled' }
      const whitelist = (reply.groupWhitelist || []).map((v) => String(v))
      // groupWhitelist 决定「哪些群」，groupAccess 决定「群里的哪些消息」
      if (whitelist.length > 0 && !whitelist.includes(String(msg.peerId))) {
        return { ok: false, reason: 'groupNotAllowed' }
      }
      const mode = groupAccessMode(cfg)
      if (mode === 'mention' || mode === 'keyword') {
        // 熟人免 @（只在 mention/keyword 模式下有意义；all 模式本来就全收）
        const bypass = reply.groupBypassForTrusted !== false && whitelistEnabled(cfg) && isTrusted(cfg, msg.userId)
        if (!bypass) {
          const hit = mode === 'mention' ? this.#atSelf(msg) : this.#hitKeyword(msg, reply)
          if (!hit) return { ok: false, reason: 'groupNotTriggered' }
        }
      }
      // all 模式（默认）：群里所有消息都交给 agent，由人设/行为规则决定回不回。
      // 群聊**不受**私聊白名单 / 熟人名单限制（名单只影响提示词，以及上面的免 @ 判定）。
      return { ok: true }
    }

    // 私聊：只看「私聊白名单」——与熟人名单是两回事
    //   privateWhitelist: [] = 全接受；不写 = 沿用 trustedUsers（兼容旧配置）
    if (!privateAccessAllowed(cfg, msg.userId)) return { ok: false, reason: 'stranger' }
    return { ok: true }
  }

  /** 群内是否命中关键词（groupAccess=keyword 用）。 */
  #hitKeyword(msg, reply) {
    const keywords = (reply.trigger?.keywords || []).map((v) => String(v).toLowerCase()).filter(Boolean)
    if (keywords.length === 0) return false
    const text = String(msg.text ?? '').toLowerCase()
    return keywords.some((keyword) => text.includes(keyword))
  }

  /** 这条群消息有没有 @ 我（同时认 message 数组与 CQ 码字符串两种形态）。 */
  #atSelf(msg) {
    const selfId = this.onebot.selfId
    if (selfId === null || selfId === undefined || selfId === '') return false
    const self = String(selfId)
    const raw = msg.raw || {}
    if (Array.isArray(raw.message)) {
      for (const seg of raw.message) {
        if (seg && seg.type === 'at' && seg.data && String(seg.data.qq) === self) return true
      }
    }
    const blob = [typeof raw.message === 'string' ? raw.message : '', String(raw.raw_message ?? '')].join(' ')
    return blob.includes('[CQ:at,qq=' + self + ']')
  }

  /* ── 命令（功能点4） ───────────────────────────────────── */

  #isCommand(command, text) {
    const cmd = String(command ?? '').trim()
    return cmd !== '' && String(text ?? '').trim() === cmd
  }

  async #stopCommand(msg, resolved, droppedPending = 0) {
    const result = await this.route.stop({
      kind: msg.kind, peerId: msg.peerId, sessionId: resolved?.taker?.sessionId ?? '',
    })
    const canceled = result?.ok === true && result?.canceled === true
    await this.#reply(msg, canceled ? '已停止当前回复。' : '当前没有正在进行的回复。')
    this.counters.bump('command.stop')
    this.logger?.info?.('[mira_qqbot] ' + msg.kind + ':' + msg.peerId + ' 发了 /stop（'
      + (canceled ? '已打断' : '没有在跑的回复') + '，作废合并窗口 ' + droppedPending + ' 条）')
    return {
      routed: 'command',
      command: 'stop',
      canceled,
      droppedPending,
      chatKey: msg.kind + ':' + msg.peerId,
      delivery: result,
    }
  }

  async #newCommand(msg, resolved, droppedPending = 0) {
    const result = await this.route.reset({
      kind: msg.kind, peerId: msg.peerId, sessionId: resolved?.taker?.sessionId ?? '',
    })
    await this.#reply(msg, '新会话已开启~ 重新认识一下吧！(◕ᴗ◕✿)')
    this.counters.bump('command.new')
    this.logger?.info?.('[mira_qqbot] ' + msg.kind + ':' + msg.peerId + ' 发了 /new（解绑 '
      + (result?.removedBindings ?? 0) + ' 条，作废合并窗口 ' + droppedPending + ' 条）')
    return {
      routed: 'command',
      command: 'new',
      droppedPending,
      chatKey: msg.kind + ':' + msg.peerId,
      reset: result,
    }
  }

  /** 系统提示（忙碌/已停止）：走协议层直发，不登记 binding。 */
  async #reply(msg, text) {
    if (typeof this.sendRaw !== 'function') return null
    try {
      return await this.sendRaw({ kind: msg.kind, peerId: msg.peerId, text })
    } catch (error) {
      const normalized = toError(error, 'delivery/failed')
      this.counters.bump('inbound.replyFailed')
      this.noteError?.(normalized.error)
      return null
    }
  }

  /* ── 合并窗口 ─────────────────────────────────────────── */

  #merge(msg, ctx) {
    const cfg = this.getConfig() || {}
    const chatKey = msg.kind + ':' + msg.peerId
    let slot = this.merges.get(chatKey)
    if (!slot) {
      slot = { items: [], timer: null }
      this.merges.set(chatKey, slot)
    }
    slot.items.push({ msg, ctx })
    if (slot.items.length > MERGE_MAX_ITEMS) {
      // 溢出丢的是**最旧**的条目：它们从没投出去，占位按「未投递」释放（不是已处理）
      this.#settleItems(slot.items.splice(0, slot.items.length - MERGE_MAX_ITEMS), false)
    }
    if (slot.timer) clearTimeout(slot.timer)
    const windowMs = Math.max(0, Number(cfg.reply?.mergeWindowMs) || 0)
    slot.timer = setTimeout(() => {
      slot.timer = null
      this.#flushMerge(chatKey).catch((error) => {
        const normalized = toError(error, 'delivery/failed')
        this.counters.bump('merge.failed')
        this.noteError?.(normalized.error)
      })
    }, windowMs)
    slot.timer.unref?.()
    this.counters.bump('merge.buffered')
    return { routed: 'merged', chatKey, pending: slot.items.length, mergeWindowMs: windowMs }
  }

  /** 合并窗口到期：逐条准备正文，拼成一条再投递（只投一次）。 */
  async #flushMerge(chatKey) {
    const slot = this.merges.get(chatKey)
    if (!slot) return null
    this.merges.delete(chatKey)
    if (slot.timer) clearTimeout(slot.timer)
    const first = slot.items[0]
    const task = (async () => {
      const texts = []
      for (const item of slot.items) {
        const text = await this.#userText(item.msg)
        if (text.trim()) texts.push(text)
      }
      if (texts.length === 0) {
        const last = slot.items[slot.items.length - 1]
        if (last && last.msg) this.#noteEmpty(last.msg.raw, { kind: 'blank', segments: last.msg.segments })
        this.counters.bump('ignored.empty')
        return { routed: 'ignored', reason: 'empty', merged: slot.items.length }
      }
      this.counters.bump('merge.flushed')
      let result = null
      let ok = false
      try {
        result = await this.#deliverPrepared(first.msg, texts.join('\n'), { ...first.ctx })
        ok = !!result && result.routed !== 'error' && !(result.delivery && result.delivery.ok === false)
      } catch (error) {
        ok = false
        throw error
      } finally {
        // 合并窗口把 N 条消息并成一次投递，但去重键是**每条各自的 message_id**：
        // 第 2..N 条在 ingest 时就占过位，这里必须在这条唯一的投递里一起记账（成功）或释放（失败），
        // 否则它们要么占位卡 60s、要么 60s 后平台重推时被当成新消息再投一次。
        for (const item of slot.items.slice(1)) {
          if (!item.msg.messageId) continue
          if (ok) this.#recordSeen(item.ctx.accountId, item.msg.messageId)
          else this.#releaseSeen(item.ctx.accountId, item.msg.messageId)
        }
      }
      return result
    })()
    this.#track(task)
    return task
  }

  #track(task) {
    this.inflight.add(task)
    task.finally(() => this.inflight.delete(task)).catch(() => { /* 已由调用方记错 */ })
    return task
  }

  /* ── 断线积压（功能点5） ───────────────────────────────── */

  #enqueueBacklog(event) {
    const cfg = this.getConfig() || {}
    const cap = Math.max(0, Number(cfg.backlog?.maxPending) || 0)
    this.backlog.push(event)
    this.stats.received += 1
    this.counters.bump('backlog.received')
    if (cap > 0 && this.backlog.length > cap) {
      const overflow = this.backlog.length - cap
      this.backlog.splice(0, overflow)
      this.stats.dropped += overflow
      this.counters.bump('backlog.overflowDropped', overflow)
      this.logger?.warn?.('[mira_qqbot] 断线积压超过 maxPending=' + cap + '，丢弃最旧 ' + overflow + ' 条')
    }
    return { routed: 'queued', reason: 'offline', pending: this.backlog.length }
  }

  /**
   * 按 backlog.policy 回放积压。
   * 返回 { policy, received, dropped, backfilled, kept }（received 是本次积压条数；
   * 累计值在 status().backlog 里）。
   */
  async flushBacklog() {
    const cfg = this.getConfig() || {}
    const policy = cfg.backlog?.policy || 'latest_n'
    const latestN = Math.max(0, Number(cfg.backlog?.latestN) || 0)
    const items = this.backlog.splice(0, this.backlog.length)

    let kept = items
    if (policy === 'drop') kept = []
    else if (policy === 'latest_n') kept = latestN > 0 ? items.slice(-latestN) : []
    const dropped = items.length - kept.length

    let backfilled = 0
    for (const event of kept) {
      const result = await this.handleEvent(event, { replaying: true })
      const routed = result && result.routed
      // dropped / command 不是"补投了一条"，别把它们算进 backfilled
      if (routed && !['dup', 'ignored', 'queued', 'merged', 'error', 'dropped', 'command'].includes(routed)) backfilled += 1
    }

    this.stats.dropped += dropped
    this.stats.backfilled += backfilled
    this.counters.bump('backlog.dropped', dropped)
    this.counters.bump('backlog.backfilled', backfilled)
    if (items.length > 0) {
      this.logger?.info?.('[mira_qqbot] 断线积压回放：收到 ' + items.length + ' 条，策略 ' + policy
        + '，丢弃 ' + dropped + ' 条，补投 ' + backfilled + ' 条')
    }
    return { policy, received: items.length, dropped, backfilled, kept: kept.length }
  }

  /* ── 缓冲（qq_recv_messages） ──────────────────────────── */

  /**
   * 记下最后一次「空」消息（qq_status.lastEmpty）。
   * 无段空事件不进缓冲，这里是唯一的现场痕迹；真正的空文本则两种痕迹都有（缓冲里的
   * segments/content_kind + 这里）。
   */
  #noteEmpty(event, content) {
    const messageId = event?.message_id === undefined || event?.message_id === null
      ? null : String(event.message_id)
    this.lastEmpty = {
      kind: content && content.kind === 'empty' ? 'empty-event' : 'blank-text',
      messageId,
      messageType: event?.message_type ?? null,
      segments: content && Array.isArray(content.segments) ? content.segments.slice() : [],
      at: this.now(),
    }
  }

  #buffer(event) {
    const type = String(event.post_type ?? '')
    if (type === 'message') {
      const text = this.media.extractText(event)
      const content = classifyMessageContent(event, text)
      // 无段空事件不进缓冲：qq_recv_messages 只该看到「有东西」的消息。
      // 计数与最后段类型由 ingest / handleEvent 里的 #noteEmpty 负责。
      if (content.kind === 'empty') return
      this.seq += 1
      this.buffer.push({
        seq: this.seq,
        ts: this.now(),
        post_type: event.post_type,
        message_type: event.message_type,
        sub_type: event.sub_type,
        message_id: event.message_id,
        user_id: event.user_id,
        group_id: event.group_id,
        guild_id: event.guild_id,
        channel_id: event.channel_id,
        sender: event.sender,
        raw: text,
        raw_message: event.raw_message,
        // 原始段类型 + 空文本标记：用户发空白（content_kind='blank'，segments=['text']）与
        // 无段空事件（根本不会进缓冲）能区分开；带图片/表情的是 'content'，不受影响。
        segments: content.segments,
        content_kind: content.kind,
        time: event.time,
      })
    } else if (type === 'request') {
      // 好友申请 / 加群请求：缓冲供模型拉取，flag 给 qq_handle_* 用
      this.seq += 1
      this.buffer.push({
        seq: this.seq,
        ts: this.now(),
        post_type: 'request',
        request_type: event.request_type,
        sub_type: event.sub_type,
        user_id: event.user_id,
        group_id: event.group_id,
        comment: event.comment,
        flag: event.flag,
      })
    } else {
      return
    }
    const cfg = this.getConfig() || {}
    const cap = Math.max(1, Number(cfg.bufferSize) || 500)
    if (this.buffer.length > cap) this.buffer.splice(0, this.buffer.length - cap)
  }

  /**
   * 增量拉取（qq_recv_messages）。
   * 返回**最旧的一页**（seq 升序），`maxSeq` = 本页最后一条的 seq：契约是「since = 上次返回的 maxSeq」，
   * 只有游标单调前进、每次都从最小的未读开始，才可能不漏消息（旧实现取最新 take 条，
   * 中间那一截既拉不到、又因为 maxSeq 跳过去而永久丢失）。
   * 还有剩余时 `hasMore`/`truncated` 为 true —— 用新的 since 继续拉下一页，别丢下这一页去追最新。
   */
  recentMessages(since = 0, limit = 50) {
    const from = Number(since) || 0
    const take = Math.min(Math.max(1, Number(limit) || 50), 500)
    const pending = this.buffer.filter((item) => item.seq > from)
    const list = pending.slice(0, take)
    const hasMore = pending.length > list.length
    const maxSeq = list.length ? list[list.length - 1].seq : from
    return {
      since: from,
      maxSeq,
      count: list.length,
      hasMore,
      truncated: hasMore,
      totalBuffered: this.buffer.length,
      messages: list,
    }
  }

  /* ── 观测与退场 ────────────────────────────────────────── */

  status() {
    const cfg = this.getConfig() || {}
    const snapshot = this.counters.snapshot()
    const ignored = {}
    for (const [key, value] of Object.entries(snapshot)) {
      if (key.startsWith('ignored.')) ignored[key.slice('ignored.'.length)] = value
    }
    return {
      backlog: {
        policy: cfg.backlog?.policy ?? null,
        latestN: cfg.backlog?.latestN ?? null,
        maxPending: cfg.backlog?.maxPending ?? null,
        pending: this.backlog.length,
        received: this.stats.received,
        dropped: this.stats.dropped,
        backfilled: this.stats.backfilled,
      },
      ignored,
      lastEmpty: this.lastEmpty,
      dedup: {
        echo: this.counters.get('dedup.echo'),
        duplicate: this.counters.get('dedup.duplicate'),
      },
      merges: [...this.merges.keys()],
      bufferedMessages: this.buffer.length,
      lastSeq: this.seq,
    }
  }

  /** 等所有在飞投递（含合并窗口 flush）落地；自检与排障用。 */
  async pending() {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight])
    }
  }

  dispose() {
    this.stopped = true
    // 窗口里还没投的消息从没投出去：占位按「未投递」释放，别让它们白占去重表
    for (const chatKey of [...this.merges.keys()]) this.#dropMerge(chatKey, false)
    this.merges.clear()
  }
}

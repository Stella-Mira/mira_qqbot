/**
 * mira_qqbot / route.js —— 绑定 → 投递（steer / queue）+ 忙碌 / 超时 / /stop
 *
 * 这一层是「入站消息怎么落到会话里」的唯一实现：
 *   · **steer（插话，默认）**：会话空闲立刻开一轮；会话在跑就插到最近一步，不排队（功能点2）。
 *   · **queue（排队，per-peer 可切）**：同一 peer 串行——前一条的回合真正结束后才投下一条。
 *     配置在 `delivery.byPeer`（PLAN §3.10：不动 binding 模型）。
 *   · **忙通告（功能点4）**：从投递开始计时，超过 `busyNoticeSec` 还没结束 → 先给对方回一句
 *     「在处理…」（`reply.busyNoticeText`）。系统提示走协议层直发，不走 miraAccount.send ——
 *     它不该抢 binding（旁听者会话投递时尤其明显）。
 *   · **超时（功能点4）**：`reply.agentTimeoutMs` 内这一轮没结束 → `agent.cancel()` + 归一成
 *     `delivery/failed`（旧实现是干等 N 秒后抛裸错）。
 *   · `/stop`（功能点4）：真在跑的回合才调 `agent.cancel()` 打断 + 清掉该 peer 排队的消息；
 *     没有在跑的回合就**不 cancel、不 resume**（空闲会话不该被叫醒，也不该回一句假的「已停止」）。
 *   · `/new`：释放该 peer 的 agent + 在 mira_account 里解绑，下一条消息按 inboundPolicy 重建会话。
 *
 * 会话从哪来：绑定的 sessionId 由 mira_account 的绑定表给出（本插件不维护 chatId→sessionId）。
 * 拿到 sessionId 后，用 ctx.agents.get 取 live agent；取不到就 agents.resume 恢复
 * （旧 index.js 的 resume 重试链路，含 "while it is live" 的兜底）。
 *
 * 只依赖 node: 内置能力。
 */

import { randomUUID } from 'node:crypto'
import { MiraError, sleep, toError } from './kit.mjs'
import { deliveryModeFor } from './config.js'
import { presetSetup } from './adapter.js'

/** 造一条用户消息。必须带 source（宿主 RuntimeContextProjection 会读 source.kind，缺了会崩）。 */
export function makeUserMessage(text, meta = {}) {
  return {
    id: 'qqmsg-' + randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'mira_qqbot' },
    meta,
  }
}

export class Router {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig
   * @param {object|null} options.logger
   * @param {object} options.counters                kit.makeCounters()
   * @param {object|null} options.agents             ctx.agents
   * @param {object|null} options.account            ctx.miraAccount
   * @param {(input:{kind:string,peerId:string,text:string}) => Promise<object>} [options.sendRaw]
   * @param {(error:object) => void} [options.noteError]
   * @param {() => string} [options.getAccountId]
   * @param {() => number} [options.now]
   * @param {number} [options.pollMs]               自检用：等回合结束的轮询间隔
   * @param {number} [options.graceMs]              自检用：steer 后等「起跑」的窗口
   */
  constructor({
    getConfig, logger = null, counters, agents = null, account = null, sendRaw = null,
    noteError = null, getAccountId = () => '', now = () => Date.now(),
    pollMs = 40, graceMs = 120,
  }) {
    this.getConfig = getConfig
    this.logger = logger
    this.counters = counters
    this.agents = agents
    this.account = account
    this.sendRaw = sendRaw
    this.noteError = noteError
    this.getAccountId = getAccountId
    this.now = now
    this.pollMs = pollMs
    this.graceMs = graceMs

    /** chatKey → { sessionId, startedAt, mode, notified } */
    this.busy = new Map()
    /** chatKey → [{ kind, peerId, sessionId, text, meta, mode, chatKey, queuedAt }] */
    this.queues = new Map()
    /** 在飞的投递 promise（dispose/pending 用） */
    this.inflight = new Set()
    this.stopped = false
  }

  /* ── 投递 ─────────────────────────────────────────────── */

  /**
   * 投递一条消息给绑定会话。
   * 返回 { ok:true, ... } 或 { ok:false, error:{code,message,hint} }（永不 throw，便于入站统计）。
   */
  async deliver(input = {}) {
    const kind = String(input.kind ?? '').trim()
    const peerId = String(input.peerId ?? '').trim()
    const sessionId = String(input.sessionId ?? '').trim()
    const text = String(input.text ?? '')

    if (!kind || !peerId) {
      return toError(new MiraError('config/missing', 'kind / peerId 为空，无法投递',
        '检查入站事件解析（mira_qqbot/lib/inbound.js 的 parse）'), 'config/missing')
    }
    if (!sessionId) {
      return toError(new MiraError('config/missing', 'sessionId 为空，无法投递',
        'mira_account 的绑定表里这个 peer 没有 taker；先 mira_account_bindings 看绑定'), 'config/missing')
    }
    if (!text.trim()) {
      return toError(new MiraError('config/missing', '消息文本为空，没有可投递的内容',
        '空消息（只有图片且没解析出文本）不会投递；看 inbound 的 ignored 计数'), 'config/missing')
    }

    const cfg = this.getConfig() || {}
    const chatKey = kind + ':' + peerId
    const mode = deliveryModeFor(cfg, kind, peerId)
    const job = {
      kind, peerId, sessionId, text, chatKey, mode,
      meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
      // 旁听者投递不该向对方发「在处理」：那是应答方的职责
      role: input.role === 'observer' ? 'observer' : (input.role || 'taker'),
      notifyBusy: input.notifyBusy !== false,
      queuedAt: this.now(),
    }

    const queuedAhead = this.queues.get(chatKey)?.length || 0
    if (mode === 'queue' && (this.busy.has(chatKey) || queuedAhead > 0)) {
      return this.#enqueue(job)
    }
    return this.#run(job)
  }

  #enqueue(job) {
    const queue = this.queues.get(job.chatKey) || []
    queue.push(job)
    this.queues.set(job.chatKey, queue)
    this.counters.bump('delivery.queued')
    this.logger?.info?.('[mira_qqbot] 已排队（' + job.chatKey + '，它在第 ' + queue.length + ' 位）')
    return {
      ok: true, queued: true, mode: 'queue', chatKey: job.chatKey, queueLength: queue.length,
    }
  }

  async #run(job) {
    const task = this.#execute(job)
    this.inflight.add(task)
    try {
      return await task
    } finally {
      this.inflight.delete(task)
    }
  }

  async #execute(job) {
    const cfg = this.getConfig() || {}
    const entry = {
      sessionId: job.sessionId,
      chatKey: job.chatKey,
      startedAt: this.now(),
      mode: job.mode,
      notified: false,
    }
    this.busy.set(job.chatKey, entry)

    // 忙通告：计时到了就先回对方一句（只发一次；走协议层直发，不登记 binding）
    // 文案留空 = 不提示（`busyNoticeSec` 仍生效，只是不发那句"在处理"）。
    const noticeMs = Math.round((Number(cfg.busyNoticeSec) || 0) * 1000)
    const noticeText = String(cfg.reply && cfg.reply.busyNoticeText != null ? cfg.reply.busyNoticeText : '').trim()
    let noticeTimer = null
    if (job.notifyBusy && noticeMs > 0 && noticeText && typeof this.sendRaw === 'function') {
      noticeTimer = setTimeout(() => {
        if (this.busy.get(job.chatKey) !== entry) return
        entry.notified = true
        this.counters.bump('delivery.busyNotice')
        this.logger?.info?.('[mira_qqbot] ' + job.chatKey + ' 忙超 ' + cfg.busyNoticeSec + 's，先回对方一句「在处理」')
        Promise.resolve(this.sendRaw({
          kind: job.kind, peerId: job.peerId, text: noticeText,
        })).catch((error) => {
          const normalized = toError(error, 'delivery/failed')
          this.counters.bump('delivery.busyNoticeFailed')
          this.noteError?.(normalized.error)
        })
      }, noticeMs)
      noticeTimer.unref?.()
    }

    try {
      const agent = await this.#resolveAgent(job.sessionId)
      if (typeof agent.steer !== 'function') {
        throw new MiraError('delivery/failed', 'agent.steer 不可用（会话 ' + job.sessionId + '）',
          '宿主版本不支持插话投递；升级 DSH')
      }
      // 插话：不管会话此前的状态，一律 steer（功能点2：不再整条链路走 followup）
      agent.steer(makeUserMessage(job.text, {
        sessionId: job.sessionId,
        chatKey: job.chatKey,
        ...job.meta,
      }))
      this.counters.bump('delivery.steer')

      const timeoutMs = Math.max(50, Number(cfg.reply?.agentTimeoutMs) || 180000)
      const outcome = await this.#awaitTurn(agent, timeoutMs)
      if (outcome === 'timeout') {
        this.counters.bump('delivery.timeout')
        try {
          await agent.cancel?.({ kind: 'hook', reason: 'mira_qqbot 等待超时（' + timeoutMs + 'ms）' })
        } catch { /* 取消失败也按超时归错 */ }
        throw new MiraError('delivery/failed',
          '等待会话 ' + job.sessionId + ' 结束超时（' + timeoutMs + 'ms），已取消这一轮',
          'agent 可能卡住；把 reply.agentTimeoutMs 调大，或让对端发 /stop 主动打断')
      }
      this.counters.bump('delivery.done')
      return {
        ok: true,
        sessionId: job.sessionId,
        chatKey: job.chatKey,
        mode: job.mode,
        notified: entry.notified,
      }
    } catch (error) {
      const normalized = toError(error, 'delivery/failed', '看 mira_qqbot 日志与 qq_status.lastError')
      this.counters.bump('delivery.failed')
      this.noteError?.(normalized.error)
      this.logger?.warn?.('[mira_qqbot] 投递失败 ' + job.chatKey + '：' + normalized.error.code + ' ' + normalized.error.message)
      return normalized
    } finally {
      if (noticeTimer) clearTimeout(noticeTimer)
      if (this.busy.get(job.chatKey) === entry) this.busy.delete(job.chatKey)
      this.#drain(job.chatKey)
    }
  }

  /** 排队的下一条（串行：上一个 #execute 的 finally 才会调它）。 */
  #drain(chatKey) {
    if (this.stopped) return
    if (this.busy.has(chatKey)) return
    const queue = this.queues.get(chatKey)
    if (!queue || queue.length === 0) {
      this.queues.delete(chatKey)
      return
    }
    const next = queue.shift()
    if (queue.length === 0) this.queues.delete(chatKey)
    this.logger?.info?.('[mira_qqbot] 出队投递 ' + chatKey + '（已等 '
      + Math.round((this.now() - next.queuedAt) / 1000) + 's）')
    // 不 await：与首条投递同一条链路（下一次 finally 继续 drain）
    this.#run(next).catch(() => { /* #execute 永不 throw */ })
  }

  /**
   * 等这一轮结束：steer 之后 agent 可能还没把 status 置成 running，
   * 所以给一个短的「起跑窗口」；一旦观察到 running，就一直等到它不再是 running。
   * 返回 'done' | 'delivered' | 'timeout'。
   */
  async #awaitTurn(agent, timeoutMs) {
    const startedAt = this.now()
    const deadline = startedAt + timeoutMs
    let sawRunning = agent.status === 'running'
    for (;;) {
      if (agent.status === 'running') {
        sawRunning = true
      } else if (sawRunning) {
        return 'done'
      } else if (this.now() - startedAt >= this.graceMs) {
        // 起跑窗口内一直是 idle：当作 fire-and-forget 已投递（不再盯这一轮）
        return 'delivered'
      }
      if (this.now() >= deadline) {
        return agent.status === 'running' ? 'timeout' : 'done'
      }
      await sleep(this.pollMs)
    }
  }

  /* ── agent 解析（旧 ensureAgent 的 resume 链路） ─────────── */

  async #getAgent(sessionId) {
    if (!this.agents || typeof this.agents.get !== 'function') return null
    try {
      const agent = await this.agents.get(sessionId)
      return agent || null
    } catch {
      return null
    }
  }

  async #resolveAgent(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (!id) {
      throw new MiraError('config/missing', 'sessionId 为空，无法投递',
        '绑定表里不该出现空 sessionId；先 mira_account_bindings 看绑定')
    }
    const svc = this.agents
    if (!svc) {
      throw new MiraError('delivery/failed', 'agents 服务不可用，无法投递到会话',
        '确认宿主版本提供 ctx.agents（mira_qqbot 的 inject 里有 agents）')
    }

    const live = await this.#getAgent(id)
    if (live) return live

    const cfg = this.getConfig() || {}
    const ar = cfg.reply || {}
    const agentOptions = {}
    if (ar.agentProvider) agentOptions.provider = ar.agentProvider
    if (ar.agentModel) agentOptions.model = ar.agentModel
    const setup = presetSetup(cfg, this.logger)

    // 「while it is live」= 会话已被某个 live agent 占用（旧实例残留 / 并发 / 框架自动恢复）。
    // 此时优先复用该 live agent（agents.get 直接取现成的），而不是新建——等待只是兜底。
    const resumeDelays = [0, 500, 1000, 2000]
    let lastError = null
    for (let attempt = 0; attempt < resumeDelays.length; attempt++) {
      if (attempt > 0) await sleep(resumeDelays[attempt])
      try {
        const handle = await svc.resume({
          resumeSessionId: id,
          ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
          setup,
        })
        const agent = handle && handle.agent
        if (!agent) throw new Error('resume 未返回 agent')
        this.counters.bump('delivery.resume')
        this.logger?.info?.('[mira_qqbot] 已恢复 agent 会话 ' + id)
        return agent
      } catch (error) {
        lastError = error
        const message = String(error?.message ?? error)
        const liveBusy = /while it is live/i.test(message)
        if (liveBusy) {
          const again = await this.#getAgent(id)
          if (again) {
            this.logger?.info?.('[mira_qqbot] 复用 live 会话 ' + id)
            return again
          }
          if (attempt < resumeDelays.length - 1) {
            this.logger?.warn?.('[mira_qqbot] 会话 ' + id + ' 是 live 但取不到实例，等待退休后重试：' + message)
            continue
          }
        }
        // 非 live 的失败（会话被删 / 损坏）不重试，直接归错
        if (!liveBusy) break
      }
    }
    throw new MiraError('delivery/failed',
      '拿不到会话 ' + id + ' 的 agent：' + (lastError?.message ?? '未知错误'),
      '会话可能已被删除；用 mira_account_bindings 看绑定，或让对方重发（账号 inboundPolicy 会决定是否重建）')
  }

  /* ── 命令：/stop 与 /new ───────────────────────────────── */

  /**
   * 打断当前回复（功能点4）：只打断**真的在跑**的回合，并清空该 peer 的排队。
   * 没有在跑的回合时**不 cancel、也不 resume** —— 否则空闲会话会被 `/stop` 凭空叫醒
   * （一次多余的 resume + 计费轮次），对端还会收到一句假的「已停止」。
   */
  async stop({ kind, peerId, sessionId = '' } = {}) {
    const chatKey = String(kind) + ':' + String(peerId)
    const entry = this.busy.get(chatKey)
    const droppedQueued = this.#dropQueue(chatKey)
    const bound = String(sessionId || '').trim()
    if (!entry) {
      if (!bound) {
        return toError(new MiraError('binding/not-found', '这个 peer 没有绑定会话，也没有在跑的回复',
          '先 mira_account_bindings 看绑定；绑定在但 agent 没起过，用 /new 重建会话'), 'binding/not-found')
      }
      return { ok: true, canceled: false, idle: true, sessionId: bound, chatKey, droppedQueued }
    }
    const sid = String(entry.sessionId || bound || '').trim()
    let agent
    try {
      agent = await this.#resolveAgent(sid)
    } catch (error) {
      return toError(error, 'delivery/failed')
    }
    if (typeof agent.cancel !== 'function') {
      return toError(new MiraError('delivery/failed', 'agent.cancel 不可用（会话 ' + sid + '）',
        '宿主版本不支持取消；升级 DSH'), 'delivery/failed')
    }
    try {
      await agent.cancel({ kind: 'user', reason: '/stop 用户打断' })
    } catch (error) {
      return toError(error, 'delivery/failed')
    }
    this.counters.bump('delivery.stopped')
    this.logger?.info?.('[mira_qqbot] 已打断 ' + chatKey + ' 的回复（会话 ' + sid + '）')
    return { ok: true, canceled: true, sessionId: sid, chatKey, droppedQueued }
  }

  /** 重置会话：释放 agent + 解绑（下一条消息按 inboundPolicy 重建）。 */
  async reset({ kind, peerId, sessionId = '' } = {}) {
    const chatKey = String(kind) + ':' + String(peerId)
    const entry = this.busy.get(chatKey)
    const sid = String(sessionId || entry?.sessionId || '').trim()
    const droppedQueued = this.#dropQueue(chatKey)

    let disposed = false
    if (sid) {
      const agent = await this.#getAgent(sid)
      if (agent && typeof agent.dispose === 'function') {
        try { await agent.dispose(); disposed = true } catch { /* 释放失败不阻塞解绑 */ }
      }
    }

    let removed = 0
    if (this.account && typeof this.account.unbind === 'function') {
      let accountId = ''
      try { accountId = String(this.getAccountId?.() ?? '').trim() } catch { accountId = '' }
      if (accountId) {
        try {
          const result = this.account.unbind({ accountId, kind, peerId })
          removed = Number(result?.removed) || 0
        } catch (error) {
          this.logger?.warn?.('[mira_qqbot] /new 解绑失败 ' + chatKey + '：' + (error?.message ?? String(error)))
        }
      }
    }
    this.counters.bump('delivery.reset')
    this.logger?.info?.('[mira_qqbot] 已重置 ' + chatKey + '（agent ' + (disposed ? '已释放' : '未起过')
      + '，解绑 ' + removed + ' 条）')
    return { ok: true, chatKey, sessionId: sid || null, disposed, removedBindings: removed, droppedQueued }
  }

  #dropQueue(chatKey) {
    const queue = this.queues.get(chatKey)
    if (!queue || queue.length === 0) return 0
    const dropped = queue.length
    this.queues.delete(chatKey)
    this.counters.bump('delivery.queueDropped', dropped)
    return dropped
  }

  /* ── 观测与退场 ────────────────────────────────────────── */

  status() {
    const busyByChat = {}
    for (const [key, entry] of this.busy) {
      busyByChat[key] = {
        sessionId: entry.sessionId,
        mode: entry.mode,
        busyMs: Math.max(0, this.now() - entry.startedAt),
        notified: entry.notified,
      }
    }
    const queues = {}
    let queueLength = 0
    for (const [key, queue] of this.queues) {
      if (!queue.length) continue
      queues[key] = queue.length
      queueLength += queue.length
    }
    return {
      queueLength,
      queues,
      busyByChat,
      inflight: this.inflight.size,
      counters: this.counters.snapshot(),
    }
  }

  /** 等所有在飞投递落地（自检 / 排障用；生产不用）。 */
  async pending() {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight])
    }
  }

  dispose() {
    this.stopped = true
    this.queues.clear()
  }
}

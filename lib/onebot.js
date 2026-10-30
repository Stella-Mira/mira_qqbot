/**
 * mira_qqbot / onebot.js —— OneBot v11 正向 WebSocket 连接（任务书功能点1）
 *
 * 全部从旧 `lib/index.js` 的「OneBot 连接管理」一节原样搬来，只做了三处必要改动：
 *   1. 从「模块级全局变量」改成实例字段（一个实例一套连接，便于自检与热加载）；
 *   2. `WebSocket` 实现可注入（默认用全局的，自检传假 ws），其余行为不变；
 *   3. 连接状态变化回调 `onState`（index 用它触发断线积压回放）。
 *
 * 保留的旧行为（都是踩过坑的，别顺手"优化"）：
 *   · 指数退避重连：min * 2^n，封顶 max；
 *   · 心跳：NapCat 会推 heartbeat meta_event，90s 没动静就主动断开重连（僵尸连接）；
 *   · 握手阶段失败时 undici 不保证再触发 close → error 里兜底清理并排一次重连，
 *     且只处理「当前 socket」，避免旧 socket 的 close 把新连接清空（幽灵连接）；
 *   · `call` 带 echo，响应在 message 里按 echo 匹配；超时报「OneBot 调用超时」。
 *
 * 凭据：accessToken 只用于 Authorization 头；错误文案/状态一律过 redactText（约定8）。
 *
 * 只依赖 node: 内置能力（WebSocket 是 Node 22 的全局实现）。
 */

import { MiraError, nowIso, sleep } from './kit.mjs'
import { redactText } from './config.js'

/** 心跳检查间隔与判定阈值（沿用旧实现）。 */
const HEARTBEAT_CHECK_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 90_000

export class OneBotClient {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig                 读当前配置（热加载后可换）
   * @param {object} [options.logger]
   * @param {(event:object) => void} [options.onEvent]       非 echo 的事件（message / request / meta）
   * @param {(state:{connected:boolean,reason?:string}) => void} [options.onState]
   * @param {Function|null} [options.webSocketImpl]          自检用：假 WebSocket 构造器
   */
  constructor({
    getConfig, logger = null, onEvent = null, onState = null,
    webSocketImpl = null, now = () => Date.now(),
  }) {
    this.getConfig = getConfig
    this.logger = logger
    this.onEvent = onEvent
    this.onState = onState
    this.webSocketImpl = webSocketImpl
    this.now = now

    this.ws = null
    this.connected = false
    this.selfId = null
    this.nickname = null
    this.nextSeq = 0
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.lastAliveAt = 0
    this.lastError = null
    /** true = 已 dispose，close 后不再自动重连 */
    this.stopped = true
    this.connectCount = 0
    this.lastConnectedAt = null
    this.lastDisconnectedAt = null
    this.retryDelayMs = null
  }

  /** 当前 WebSocket 实现（Node 22+ 全局自带；没有就报明确错误）。 */
  #impl() {
    const impl = this.webSocketImpl || globalThis.WebSocket
    if (typeof impl !== 'function') {
      throw new MiraError('delivery/failed', '当前 Node 没有 WebSocket 实现',
        '升级到 Node 22+（内置 WebSocket），或用 options.webSocketImpl 注入')
    }
    return impl
  }

  /* ── 连接 ─────────────────────────────────────────────── */

  /**
   * 建连（幂等：已在连接中就返回）。返回 { ok } 或 { ok:false, error }。
   * **不** throw：连接失败不该把插件加载带崩，失败原因进 lastError / status。
   */
  connect() {
    const cfg = this.getConfig() || {}
    const url = String(cfg.wsUrl ?? '').trim()
    this.stopped = false
    this.#clearTimers()
    this.#dropSocket()

    if (!url) {
      // 约定2：不自动探测。这里只记错误，工具面由 requireWsUrl 报 config/missing
      this.lastError = '未配置 wsUrl（本插件不自动探测）'
      this.#emitState(false, 'no-ws-url')
      return { ok: false, error: { code: 'config/missing', message: this.lastError } }
    }

    const headers = String(cfg.accessToken ?? '').trim()
      ? { Authorization: 'Bearer ' + String(cfg.accessToken).trim() }
      : {}

    let sock
    try {
      const Impl = this.#impl()
      sock = new Impl(url, { headers })
    } catch (error) {
      this.lastError = redactText('WebSocket 构造失败：' + (error?.message ?? String(error)), cfg)
      this.logger?.warn?.('[mira_qqbot] ' + this.lastError)
      this.#scheduleReconnect()
      return { ok: false, error: { code: 'delivery/failed', message: this.lastError } }
    }
    this.ws = sock

    sock.addEventListener('open', () => {
      this.connected = true
      this.reconnectAttempts = 0
      this.retryDelayMs = null
      this.lastAliveAt = this.now()
      this.lastError = null
      this.connectCount += 1
      this.lastConnectedAt = nowIso(this.now())
      // 连接后主动拉一次自身信息，顺便确认鉴权是否通过
      this.call('get_login_info', {}, 6000)
        .then((data) => {
          if (!data) return
          this.selfId = data.user_id ?? data.uin ?? this.selfId
          this.nickname = data.nickname ?? this.nickname
        })
        .catch(() => { /* 鉴权失败会体现在后续 call 上，这里不刷日志 */ })
      // 每 30s 检查一次活性（NapCat 会推 heartbeat meta_event，据此判定僵尸连接）
      this.heartbeatTimer = setInterval(() => {
        if (this.now() - this.lastAliveAt > HEARTBEAT_TIMEOUT_MS) {
          this.lastError = '心跳超时，强制重连'
          this.logger?.warn?.('[mira_qqbot] ' + this.lastError)
          try { sock.close() } catch { /* noop */ }
        }
      }, HEARTBEAT_CHECK_MS)
      this.heartbeatTimer.unref?.()
      this.logger?.info?.('[mira_qqbot] 已连上 OneBot：' + redactText(url, cfg))
      this.#emitState(true, 'open')
    })

    sock.addEventListener('message', (ev) => this.#handleMessage(ev, sock))

    sock.addEventListener('close', () => {
      // 只处理「当前」socket 的关闭：connect() 主动关闭旧连接重连时，
      // 旧 socket 的 close 事件会在新连接建立后才到达，若不加判断会把
      // 新连接的 ws 引用清空（幽灵连接：connected=true 但无法发送），并排多余重连
      if (this.ws !== sock) return
      this.connected = false
      this.ws = null
      this.lastDisconnectedAt = nowIso(this.now())
      this.#emitState(false, 'close')
      if (!this.stopped) this.#scheduleReconnect()
    })

    sock.addEventListener('error', (ev) => {
      const cfgNow = this.getConfig() || {}
      this.lastError = redactText('WebSocket 错误' + (ev?.message ? '：' + ev.message : ''), cfgNow)
      // 握手阶段失败（例如 NapCat/OneBot 还没起来）时 undici 不保证再触发 close，
      // 只靠 close 重连会永久卡死在这个 socket 上（重启后必现）。这里兜底：
      // 仅当这个 socket 仍是「当前连接」时才清理并排程重连；随后到达的 close
      // 会因 ws !== sock 被忽略，不会重复排程。
      if (this.ws === sock) {
        this.connected = false
        this.ws = null
        this.lastDisconnectedAt = nowIso(this.now())
        this.#emitState(false, 'error')
        if (!this.stopped) this.#scheduleReconnect()
      }
    })

    return { ok: true }
  }

  /** 主动断开并停止重连（dispose 用）。 */
  close() {
    this.stopped = true
    this.#clearTimers()
    this.#dropSocket()
    if (this.connected) this.#emitState(false, 'closed-by-plugin')
    this.connected = false
  }

  #dropSocket() {
    const sock = this.ws
    this.ws = null
    this.connected = false
    if (sock) {
      try { sock.close() } catch { /* noop */ }
    }
  }

  #clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  #scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return
    const cfg = this.getConfig() || {}
    const min = Number(cfg.reconnectMinMs) || 2000
    const max = Math.max(min, Number(cfg.reconnectMaxMs) || 60000)
    const delay = Math.min(min * Math.pow(2, this.reconnectAttempts), max)
    this.retryDelayMs = delay
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectAttempts += 1
      if (this.stopped) return
      this.logger?.info?.('[mira_qqbot] 断线重连（第 ' + this.reconnectAttempts + ' 次）')
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  #emitState(connected, reason) {
    try { this.onState?.({ connected, reason }) } catch (error) {
      this.logger?.warn?.('[mira_qqbot] onState 回调异常：' + (error?.message ?? String(error)))
    }
  }

  /* ── 收帧 ─────────────────────────────────────────────── */

  #handleMessage(ev, sock) {
    this.lastAliveAt = this.now()
    let data
    try {
      data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    if (sock !== this.ws) return

    // 有 echo 的是 API 响应，交给 call 的监听器处理
    if (data.echo !== undefined) return

    const pt = data.post_type
    if (pt === 'meta_event') {
      if (data.meta_event_type === 'lifecycle' && data.sub_type === 'connect' && data.self_id) {
        this.selfId = data.self_id
      }
      // heartbeat 只用来刷新 lastAliveAt（上面已经刷过），不往下传
      if (data.meta_event_type === 'heartbeat') return
      this.onEvent?.(data)
      return
    }
    this.onEvent?.(data)
  }

  /* ── API 调用 ─────────────────────────────────────────── */

  /** 带 echo 的 OneBot 动作调用；失败/超时统一抛 MiraError(delivery/failed)。 */
  call(action, params, timeoutMs) {
    return new Promise((resolveCall, reject) => {
      const ws = this.ws
      if (!ws || ws.readyState !== 1) {
        reject(new MiraError('delivery/failed', '未连接 OneBot（NapCat 未运行或未登录）',
          '看 qq_status.connected 与 lastError；确认 wsUrl / accessToken 与 NapCat 配置一致'))
        return
      }
      const cfg = this.getConfig() || {}
      const limit = Number(timeoutMs) || Number(cfg.callTimeoutMs) || 8000
      const echo = 'qq' + Math.random().toString(36).slice(2, 12) + this.now()
      const cleanup = () => {
        try { ws.removeEventListener?.('message', handler) } catch { /* noop */ }
        clearTimeout(timer)
      }
      const handler = (ev) => {
        let resp
        try {
          resp = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        } catch {
          return
        }
        if (!resp || resp.echo !== echo) return
        cleanup()
        const ok = resp.status === 'ok' || resp.retcode === 0
        if (ok) resolveCall(resp.data)
        else {
          const message = redactText(resp.msg || resp.message || ('retcode ' + resp.retcode), this.getConfig() || {})
          reject(new MiraError('delivery/failed', 'OneBot 返回失败（' + action + '）：' + message,
            '看 NapCat 日志与 qq_status.lastError；参数或权限不对时 NapCat 会在这里报'))
        }
      }
      ws.addEventListener('message', handler)
      const timer = setTimeout(() => {
        cleanup()
        reject(new MiraError('delivery/failed', 'OneBot 调用超时（' + action + '，' + limit + 'ms）',
          'NapCat 可能卡住或没登录；确认 QQ 在线后看 qq_status'))
      }, limit)
      timer.unref?.()
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        cleanup()
        reject(new MiraError('delivery/failed', 'OneBot 发送失败：' + (error?.message ?? String(error)),
          '连接可能已断；看 qq_status.connected'))
      }
    })
  }

  /* ── 观测 ─────────────────────────────────────────────── */

  status() {
    const cfg = this.getConfig() || {}
    return {
      connected: this.connected,
      selfId: this.selfId,
      nickname: this.nickname,
      wsUrl: redactText(String(cfg.wsUrl ?? ''), cfg),
      lastError: this.lastError ? redactText(this.lastError, cfg) : null,
      reconnectAttempts: this.reconnectAttempts,
      retryDelayMs: this.retryDelayMs,
      lastAliveAgoMs: this.lastAliveAt ? this.now() - this.lastAliveAt : null,
      connectCount: this.connectCount,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
    }
  }

  /** 自检用：等到 connected 变化（生产不使用）。 */
  async waitConnected(timeoutMs = 1000) {
    const deadline = this.now() + timeoutMs
    while (!this.connected && this.now() < deadline) await sleep(10)
    return this.connected
  }
}

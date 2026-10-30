/**
 * mira_qqbot 自检：`node test/smoke.mjs`
 *
 * 全过 → 退出码 0，末行 `==== ALL PASS（N 项断言）====`；失败逐行 `[FAIL] 编号 说明`，退出码 1。
 *
 * 覆盖 tool_shared/PLAN.md §1.3 的 C1–C14：
 *   C2  未配 wsUrl → qq_status 返回 config/missing（不自动探测）
 *   C3  入站私聊 → agent.steer 1 次，followup 0 次
 *   C4  同 message_id 第二次 → dup，steer 仍 1 次
 *   C5  自身 echo → 不投递，dedup.echo +1
 *   C6  未绑定 peer 首次 qq_send_private_msg → 自动登记 taker + miraAccount.send 被调用
 *   C7  另一会话对同 peer → binding/conflict 且未发出；带 force 才发
 *   C8  agent 忙超 busyNoticeSec → 先回「在处理」，busyByChat 可见忙了多久
 *   C9  /stop → 有在跑的回合才 cancel + 回「已停止」；空闲 peer 不 cancel / 不 resume
 *   C10 超时 → cancel + 归一成 delivery/failed
 *   C11 断线 30 条 + latest_n=20 → 补 20、丢 10，status().backlog 数字对得上
 *   C12 群聊默认全收（groupAccess=all）；C12b mention 模式才要求 @；C12c 群聊不受私聊白名单限制
 *   C13 未配 privateWhitelist 时回落熟人名单；C13b/c 两者分开 + 全接受；C13d 旁听角色；C13e qq_role
 *   C14 qq_status 字段齐全且不含 accessToken
 *
 * 另加（同样是"真断言"，不是"函数能跑"）：
 *   X1  config.json 模板带 schemaVersion；schemaVersion 不匹配 → 拒绝加载（config/schema）
 *   X2  单实例：第二次 apply → plugin/instance，且不注册工具
 *   X3  合并窗口：窗口内两条 → 只投一次，正文含两条
 *   X4  queue 模式：忙时排队、结束后自动出队（queueLength 可见）
 *   X5  未绑定 + inboundPolicy=create → 交给 miraAccount.inbound 建会话（走 adapter.createSession）
 *      且**不写** 旧 meta.json（会话映射归 mira_account）
 *   X6  旧 profile 配置（autoReply.*）继续生效 + legacyConfigKeys 点名 + trustedUsers 里的人设文本进提示词
 *   X7  accessToken 只进 Authorization 头；config.json 权限 600
 *   X8  qq_recv_messages 仍能增量拉取（环形缓冲没搬丢）
 *   X13 qq_recv_messages 分页：limit 小于积压 → 返回最旧一页，两次拉完 100 条不漏不重
 *   X14 /stop 作废合并窗口（窗口到期不再投递）+ 空闲 peer 不 resume
 *   X15 /new 作废合并窗口（窗口内消息不投给旧会话）
 *   X16 积压回放：dropped / command 不算 backfilled
 *   X17 合并窗口溢出 50 条：溢出的最旧条目释放占位、不投递
 *   X18 dispose 释放窗口占位；空正文按「已处理」记账
 *   X19 无段空事件（message/raw_message 为空）不进缓冲、不投递；空文本与图片/表情可区分
 *   X20 qq_send_private_msg 优先用 exec.agent.session.id（resume 后 agent.id 可能是旧 id）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, createRuntime } from '../lib/index.js'
import { deepMerge } from '../lib/kit.mjs'

/* ── 断言框架（与 mira_active/test/smoke.mjs 同风格） ───────── */

let passed = 0
const failures = []
let current = '(未命名)'

function check(ok, message) {
  if (ok) { passed += 1; return true }
  failures.push('[' + current + '] ' + message)
  return false
}

function eq(actual, expected, message) {
  return check(JSON.stringify(actual) === JSON.stringify(expected),
    message + '（期望 ' + JSON.stringify(expected) + '，实得 ' + JSON.stringify(actual) + '）')
}

async function test(id, name, fn) {
  current = id + ' ' + name
  try {
    await fn()
  } catch (error) {
    const detail = error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)
    failures.push('[' + current + '] 抛异常：' + detail)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 隔离环境 ───────────────────────────────────────────── */

const TMP = mkdtempSync(join(tmpdir(), 'mira-qqbot-smoke-'))
let caseSeq = 0
/** 每个用例一个独立 DSH_HOME（配置模板 / 权限 / 迁移检查都在里面做，不碰真实配置）。 */
function freshHome() {
  caseSeq += 1
  const home = join(TMP, 'case-' + caseSeq)
  mkdirSync(join(home, 'mira_config', 'mira_qqbot'), { recursive: true })
  process.env.DSH_HOME = home
  return home
}

const logLines = []
const logger = {
  info: (message) => logLines.push('I ' + message),
  warn: (message) => logLines.push('W ' + message),
  error: (message) => logLines.push('E ' + message),
  debug: () => {},
}

/* ── 假 WebSocket ───────────────────────────────────────── */

function makeFakeWs({ selfId = 10001 } = {}) {
  const instances = []
  class FakeWebSocket {
    constructor(url, options = {}) {
      this.url = url
      this.headers = options.headers || {}
      this.readyState = 0
      this.sent = []
      this.listeners = new Map()
      this.responder = null
      instances.push(this)
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || []
      list.push(fn)
      this.listeners.set(type, list)
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || []
      this.listeners.set(type, list.filter((item) => item !== fn))
    }
    #emit(type, event) {
      for (const fn of [...(this.listeners.get(type) || [])]) fn(event)
    }
    open() {
      this.readyState = 1
      this.#emit('open', {})
    }
    send(raw) {
      this.sent.push(raw)
      let frame
      try { frame = JSON.parse(raw) } catch { return }
      const data = typeof this.responder === 'function'
        ? this.responder(frame)
        : (frame.action === 'get_login_info' ? { user_id: selfId, nickname: '测试号' } : {})
      if (data === undefined) return
      queueMicrotask(() => {
        this.#emit('message', {
          data: JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data }),
        })
      })
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      queueMicrotask(() => this.#emit('close', {}))
    }
    /** 模拟平台推事件 */
    push(event) { this.#emit('message', { data: JSON.stringify(event) }) }
    actions() { return this.sent.map((raw) => JSON.parse(raw)) }
    sentPrivate() { return this.actions().filter((item) => item.action === 'send_private_msg').map((item) => item.params) }
    sentGroup() { return this.actions().filter((item) => item.action === 'send_group_msg').map((item) => item.params) }
  }
  return { Impl: FakeWebSocket, instances, last: () => instances[instances.length - 1] }
}

/* ── 假 agent ───────────────────────────────────────────── */

function makeAgent({ id, status = 'idle' } = {}) {
  const session = {
    id,
    events: [],
    append(type, payload) { this.events.push({ type, ...(payload || {}) }) },
    deriveMessages() { return [] },
  }
  return {
    id,
    session,
    status,
    steers: [],
    followups: [],
    cancels: [],
    disposed: false,
    steer(message) { this.steers.push(message) },
    followup(message) { this.followups.push(message) },
    async cancel(reason) { this.cancels.push(reason) },
    async dispose() { this.disposed = true },
  }
}

function makeAgentCtx() {
  const sections = []
  return {
    sections,
    get(name) { return name === 'agentPresets' ? { async mount() {} } : undefined },
    systemPrompt: { section(entry) { sections.push(entry.name) } },
  }
}

function makeAgentsService(seed = []) {
  const map = new Map()
  const created = []
  const resumed = []
  const service = {
    map,
    created,
    resumed,
    get(id) { return map.get(id) || null },
    async resume({ resumeSessionId, setup }) {
      resumed.push(resumeSessionId)
      let agent = map.get(resumeSessionId)
      if (!agent) {
        agent = makeAgent({ id: resumeSessionId })
        map.set(resumeSessionId, agent)
      }
      if (typeof setup === 'function') await setup(makeAgentCtx())
      return { agent }
    },
    async create({ sessionId, meta, setup }) {
      const agent = makeAgent({ id: sessionId })
      const agentCtx = makeAgentCtx()
      if (typeof setup === 'function') await setup(agentCtx)
      map.set(sessionId, agent)
      created.push({ sessionId, meta, sections: agentCtx.sections })
      return { agent }
    },
  }
  for (const agent of seed) map.set(agent.id, agent)
  return service
}

function makeWorkspaces() {
  const attached = []
  return {
    attached,
    async resolveByPath(path) {
      return { path, async attachSession(sessionId) { attached.push({ path, sessionId }) } }
    },
  }
}

/* ── 假 mira_account（照 lib/service.js 的语义写：绑定冲突 / 去重 / inboundPolicy） ── */

function makeAccountService({ accounts, agentsMap }) {
  const state = {
    adapters: new Map(),
    sendCalls: [], // 每次 miraAccount.send 调用（含被 binding/conflict 拦下的）
    sent: [], // 真的发出去的
    inboundCalls: [],
    delivered: [], // mira_account 自己投递（未绑定 → inboundPolicy 路径）
    bindings: [],
    seen: new Set(),
    self: new Set(),
    released: [], // releaseSeen 的调用记录（占位被撤销）
  }
  const iso = () => new Date().toISOString()
  const list = () => state.bindings
  const peerOf = (kind, peerId) => String(kind) + ':' + String(peerId)

  function resolvePeer(accountId, kind, peerId) {
    const key = peerOf(kind, peerId)
    const taker = list().find((b) => b.mode === 'taker' && peerOf(b.kind, b.peerId) === key)
    const observers = list().filter((b) => b.mode === 'observer' && peerOf(b.kind, b.peerId) === key)
    return {
      accountId,
      key,
      taker: taker ? { sessionId: taker.sessionId, since: taker.updatedAt } : null,
      observers: observers.map((o) => ({ sessionId: o.sessionId, since: o.updatedAt })),
    }
  }

  function requireAccount(id) {
    const account = accounts.find((item) => item.id === id)
    if (!account) throw Object.assign(new Error('账号不存在：' + id), { code: 'account/not-found', hint: '先 mira_account_list' })
    if (!account.enabled) throw Object.assign(new Error('账号已停用：' + id), { code: 'account/disabled', hint: '把 enabled 改回 true' })
    return account
  }

  async function deliver(sessionId, text) {
    state.delivered.push({ sessionId, text })
    const agent = agentsMap.get(sessionId)
    if (agent) {
      // 真实 mira_account 的 deliver 就是 steer（它自己造消息）
      agent.steers.push({ content: [{ type: 'text', text }], via: 'mira_account' })
      return
    }
    throw Object.assign(new Error('agent.steer 不可用（会话 ' + sessionId + '）'), { code: 'delivery/failed' })
  }

  const api = {
    version: 1,
    baseDir: '/fake/mira_account',
    registerAdapter(adapter) {
      if (state.adapters.has(adapter.platform)) {
        throw Object.assign(new Error('平台 ' + adapter.platform + ' 已经有适配器在跑'), { code: 'platform/duplicate' })
      }
      state.adapters.set(adapter.platform, adapter)
      return () => state.adapters.delete(adapter.platform)
    },
    listAccounts() { return accounts.map((item) => ({ ...item })) },
    requireAccount,
    requireAdapter(platform) {
      const adapter = state.adapters.get(platform)
      if (!adapter) throw Object.assign(new Error('平台 ' + platform + ' 的适配器没有装'), { code: 'platform/unsupported' })
      return adapter
    },
    setState() {},
    bind({ sessionId, accountId, kind, peerId, mode = 'taker', force = false, observer = false }) {
      const account = requireAccount(accountId)
      const sid = String(sessionId ?? '').trim()
      if (!sid) throw Object.assign(new Error('sessionId 必填'), { code: 'config/missing' })
      const key = peerOf(kind, peerId)
      const taker = list().find((b) => b.mode === 'taker' && peerOf(b.kind, b.peerId) === key)
      const wantMode = observer ? 'observer' : (mode === 'observer' ? 'observer' : 'taker')
      const mine = list().find((b) => b.sessionId === sid && peerOf(b.kind, b.peerId) === key)

      if (wantMode === 'observer') {
        if (mine) { mine.mode = 'observer'; mine.updatedAt = iso() } else {
          list().push({ sessionId: sid, accountId: account.id, kind: String(kind), peerId: String(peerId), mode: 'observer', createdAt: iso(), updatedAt: iso() })
        }
        return { ok: true, action: 'observer', binding: { sessionId: sid, accountId: account.id, kind: String(kind), peerId: String(peerId), mode: 'observer' } }
      }
      if (taker && taker.sessionId === sid) {
        taker.updatedAt = iso()
        return { ok: true, action: 'reused', binding: { ...taker } }
      }
      if (taker && !force) {
        throw Object.assign(new Error(key + ' 已经由会话 ' + taker.sessionId + ' 应答'), {
          code: 'binding/conflict',
          hint: '要抢过来加 force:true；只想旁听加 observer:true',
        })
      }
      if (taker && force) { taker.mode = 'observer'; taker.updatedAt = iso() }
      if (mine) { mine.mode = 'taker'; mine.updatedAt = iso() } else {
        list().push({ sessionId: sid, accountId: account.id, kind: String(kind), peerId: String(peerId), mode: 'taker', createdAt: iso(), updatedAt: iso() })
      }
      return {
        ok: true,
        action: taker && force ? 'forced' : 'created',
        binding: { sessionId: sid, accountId: account.id, kind: String(kind), peerId: String(peerId), mode: 'taker' },
      }
    },
    unbind(query = {}) {
      const before = list().length
      for (let i = list().length - 1; i >= 0; i--) {
        const row = list()[i]
        if (query.sessionId !== undefined && row.sessionId !== query.sessionId) continue
        if (query.accountId !== undefined && row.accountId !== query.accountId) continue
        if (query.kind !== undefined && row.kind !== query.kind) continue
        if (query.peerId !== undefined && row.peerId !== String(query.peerId)) continue
        list().splice(i, 1)
      }
      return { removed: before - list().length, filter: query }
    },
    bindings(sessionId) {
      return list()
        .filter((row) => !sessionId || row.sessionId === sessionId)
        .map((row) => ({ ...row }))
    },
    resolve(accountId, kind, peerId) {
      requireAccount(accountId)
      return resolvePeer(accountId, kind, peerId)
    },
    async send(input) {
      const { accountId, kind, peerId, payload, sessionId, force = false, observer = false } = input
      state.sendCalls.push({ accountId, kind, peerId: String(peerId), payload, sessionId, force, observer })
      const account = requireAccount(accountId)
      const adapter = api.requireAdapter(account.platform)
      const body = payload && typeof payload === 'object' ? payload : { text: String(payload) }
      if (!body.text || !String(body.text).trim()) {
        throw Object.assign(new Error('payload 是空的'), { code: 'config/missing' })
      }
      let binding = { mode: 'none' }
      if (sessionId) {
        const bound = api.bind({ sessionId, accountId, kind, peerId, force, observer })
        binding = { mode: bound.binding.mode, action: bound.action }
      }
      const result = await adapter.send(account, kind, peerId, body)
      const messageId = result && (result.messageId ?? result.id) !== undefined ? String(result.messageId ?? result.id) : null
      if (messageId) state.self.add(messageId)
      const record = { accountId, kind: String(kind), peerId: String(peerId), text: body.text, messageId }
      state.sent.push(record)
      return { ok: true, accountId, kind: String(kind), peerId: String(peerId), messageId, binding: binding.mode === 'none' ? undefined : binding }
    },
    async inbound(input) {
      const account = requireAccount(input.accountId)
      state.inboundCalls.push(input)
      const id = input.message?.id
      if (id !== undefined && id !== null && api.seen(account.id, id)) {
        return { routed: 'dup', duplicate: true }
      }
      const resolved = api.resolve(account.id, input.kind, input.peerId)
      if (resolved.taker) {
        await deliver(resolved.taker.sessionId, input.message?.text ?? '')
        return { routed: 'taker', sessionId: resolved.taker.sessionId }
      }
      if (resolved.observers.length > 0) {
        for (const observer of resolved.observers) await deliver(observer.sessionId, input.message?.text ?? '')
        return { routed: 'observer', sessionIds: resolved.observers.map((o) => o.sessionId) }
      }
      const policy = account.inboundPolicy || 'create'
      if (policy === 'drop') return { routed: 'dropped', reason: 'no-binding' }
      if (policy === 'default') {
        await deliver(account.defaultSessionId, input.message?.text ?? '')
        return { routed: 'default', sessionId: account.defaultSessionId }
      }
      const adapter = api.requireAdapter(account.platform)
      const sessionId = await adapter.createSession({
        account, kind: input.kind, peerId: input.peerId, display: input.display, text: input.message?.text,
      })
      list().push({
        sessionId, accountId: account.id, kind: String(input.kind), peerId: String(input.peerId),
        mode: 'taker', createdAt: iso(), updatedAt: iso(),
      })
      await deliver(sessionId, input.message?.text ?? '')
      return { routed: 'created', sessionId }
    },
    verdict(accountId, messageId) {
      const id = String(messageId ?? '')
      if (!id) return { duplicate: false }
      if (state.self.has(id)) return { duplicate: true, echo: true }
      return { duplicate: state.seen.has(id), echo: false }
    },
    recordSeen(accountId, messageId) {
      const id = String(messageId ?? '')
      if (id) state.seen.add(id)
      return true
    },
    releaseSeen(accountId, messageId) {
      const id = String(messageId ?? '')
      if (!id) return false
      state.seen.delete(id)
      state.released.push(id)
      return true
    },
    seen(accountId, messageId) {
      const id = String(messageId ?? '')
      if (!id) return false
      if (state.self.has(id)) return true
      if (state.seen.has(id)) return true
      state.seen.add(id)
      return false
    },
    markSeen(accountId, messageId) {
      const id = String(messageId ?? '')
      if (id) state.seen.add(id)
    },
    markSelf(accountId, messageId) {
      const id = String(messageId ?? '')
      if (id) state.self.add(id)
    },
    noteError() {},
    status() { return { ok: true, adapters: [...state.adapters.keys()], bindingCount: list().length } },
  }
  return { api, state }
}

/* ── 假 ctx ─────────────────────────────────────────────── */

function makeCtx({ accountApi = null, agents = null, workspaces = null } = {}) {
  const toolsMap = new Map()
  const effects = []
  return {
    logger,
    tools: {
      register(def) {
        toolsMap.set(def.name, def)
        return () => toolsMap.delete(def.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => {}
    },
    miraAccount: accountApi,
    agents,
    workspaceRegistry: workspaces,
    toolsMap,
    logLines,
    dispose() {
      for (const dispose of [...effects].reverse()) {
        try { if (typeof dispose === 'function') dispose() } catch { /* noop */ }
      }
      effects.length = 0
    },
  }
}

/* ── 事件构造 ───────────────────────────────────────────── */

function privateEvent({ messageId, userId, text, selfId = 10001 }) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    self_id: selfId,
    user_id: userId,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: userId, nickname: '用户' + userId },
    time: Math.floor(Date.now() / 1000),
  }
}

function groupEvent({ messageId, groupId, userId, text, atSelf = false, selfId = 10001 }) {
  const message = atSelf
    ? [{ type: 'at', data: { qq: String(selfId) } }, { type: 'text', data: { text: ' ' + text } }]
    : [{ type: 'text', data: { text } }]
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    self_id: selfId,
    group_id: groupId,
    user_id: userId,
    message,
    raw_message: text,
    sender: { user_id: userId, nickname: '群友' + userId },
    time: Math.floor(Date.now() / 1000),
  }
}

/* ── 装配一个 harness（与生产同一条 createRuntime 路径） ───── */

const TURN = { pollMs: 10, graceMs: 25 }

function createHarness(options = {}) {
  const home = options.home || freshHome()
  const fakeWs = makeFakeWs({ selfId: options.selfId ?? 10001 })
  const agents = makeAgentsService(options.agents || [])
  const workspaces = makeWorkspaces()
  const accounts = options.accounts || [{
    id: 'qq-main', platform: 'qq', label: '主号', enabled: true,
    inboundPolicy: options.inboundPolicy || 'create',
  }]
  const { api: accountApi, state: accountState } = makeAccountService({ accounts, agentsMap: agents.map })

  const base = {
    wsUrl: 'ws://fake-onebot:3001',
    accountId: 'qq-main',
    reply: { mergeWindowMs: 0 },
  }
  // 旧配置兼容用例：profile 里只有 autoReply、没有 reply。这里不能注入新结构 reply，
  // 否则 config.js 会按「同时有 reply 与 autoReply → 只用 reply」处理（那是刻意的判定）。
  if (options.config && options.config.autoReply && !options.config.reply) delete base.reply
  const runtime = createRuntime({
    ctx: { logger, miraAccount: accountApi, agents, workspaceRegistry: workspaces },
    config: deepMerge(base, options.config || {}),
    logger,
    webSocketImpl: fakeWs.Impl,
    turn: options.turn || TURN,
  })
  if (!runtime.ok) throw new Error('createRuntime 失败：' + JSON.stringify(runtime.error))
  const ctx = makeCtx({ accountApi, agents, workspaces })
  const toolHandle = runtime.registerToolSet(ctx)
  runtime.start()

  return {
    home,
    runtime,
    ctx,
    toolHandle,
    agents,
    workspaces,
    accountApi,
    accountState,
    ws: fakeWs,
    tool: (name) => {
      const def = ctx.toolsMap.get(name)
      if (!def) throw new Error('工具没注册：' + name)
      return def
    },
    async connect() {
      const sock = fakeWs.last()
      if (!sock) throw new Error('没有建立 WebSocket 连接（wsUrl 为空？）')
      sock.open()
      await runtime.onebot.waitConnected(500)
      for (let i = 0; i < 40 && runtime.onebot.selfId === null; i++) await sleep(5)
      return sock
    },
    buildStatus: () => runtime.buildStatus(),
    async dispose() {
      try { runtime.dispose() } catch { /* noop */ }
      try { ctx.dispose() } catch { /* noop */ }
      await sleep(0)
    },
  }
}

async function withHarness(options, fn) {
  const harness = createHarness(options)
  try {
    return await fn(harness)
  } finally {
    await harness.dispose()
  }
}

function steerText(agent, index = 0) {
  const message = agent.steers[index]
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return (message.content || []).map((block) => block.text || '').join('')
}

/** 等下一条投递落地（steer 是异步的，轮询比 sleep 固定时长稳）。 */
async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

/* ══════════════════════════════════════════════════════════ */
/* C2  未配 wsUrl → config/missing（不自动探测）               */
/* ══════════════════════════════════════════════════════════ */

await test('C2', '未配 wsUrl：qq_status 返回 config/missing，不自动探测', async () => {
  const home = freshHome()
  await withHarness({ home, config: { wsUrl: '' } }, async (h) => {
    eq(h.ws.instances.length, 0, 'wsUrl 为空时不该建立任何 WebSocket 连接')
    const result = JSON.parse(await h.tool('qq_status').execute({}, {}))
    eq(result.ok, false, 'qq_status 应返回 ok:false')
    eq(result.error && result.error.code, 'config/missing', '错误码应是 config/missing')
    check(String(result.error.hint).includes('wsUrl'), 'hint 要点出 wsUrl：' + result.error.hint)
    check(String(result.error.hint).includes('config.json'), 'hint 要指出是哪个文件：' + result.error.hint)
    check(String(result.error.hint).includes(home), 'hint 里的路径要是当前 DSH_HOME：' + result.error.hint)
    // 模板已落盘，且带 schemaVersion
    const file = join(home, 'mira_config', 'mira_qqbot', 'config.json')
    check(existsSync(file), '应写入配置模板：' + file)
    eq(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1, '模板 schemaVersion 应为 1')
    // 发送类工具同样拒（不是只有 status）
    const send = JSON.parse(await h.tool('qq_send_private_msg').execute({ user_id: 1, message: 'x' }, {}))
    eq(send.ok, false, '发送工具也应失败')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C3  入站私聊 → steer 1 次，followup 0 次                    */
/* ══════════════════════════════════════════════════════════ */

await test('C3', '入站私聊：agent.steer 1 次、followup 0 次、消息带 source.kind', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent] }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'm3', userId: '1001', text: '你好呀' }))
    eq(result.routed, 'taker', '应路由到 taker')
    eq(result.sessionId, 'S1', '应投给绑定的会话')
    await h.runtime.inbound.pending()
    eq(agent.steers.length, 1, 'steer 应只调 1 次')
    eq(agent.followups.length, 0, '绝不能走 followup（那是排队的一整轮）')
    eq(agent.steers[0].role, 'user', '必须是用户消息')
    eq(agent.steers[0].source.kind, 'mira_qqbot', '必须带 source.kind（否则宿主投影会崩）')
    const text = steerText(agent)
    check(text.includes('你好呀'), '正文要含原始消息：' + text.slice(0, 80))
    check(text.includes('【消息来源】'), '正文要含来源块（旧行为）')
    check(text.includes('qq_send_private_msg'), '正文要指明回复工具（旧行为）')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C4  同 message_id 第二次 → dup                              */
/* ══════════════════════════════════════════════════════════ */

await test('C4', '同 message_id 再来一次：dup，steer 仍 1 次', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent] }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const first = await h.runtime.inbound.ingest(privateEvent({ messageId: 'm4', userId: '1001', text: '第一次' }))
    eq(first.routed, 'taker', '第一条应投递')
    const second = await h.runtime.inbound.ingest(privateEvent({ messageId: 'm4', userId: '1001', text: '第一次' }))
    eq(second.routed, 'dup', '第二条应判重')
    eq(second.duplicate, true, 'dup 标记为 duplicate')
    eq(agent.steers.length, 1, 'steer 仍应只有 1 次')
    eq(h.buildStatus().dedup.duplicate, 1, 'status.dedup.duplicate 应为 1')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C5  自身 echo → 不投递，dedup 计数                          */
/* ══════════════════════════════════════════════════════════ */

await test('C5', '收到自己发的 echo：不投递，dedup.echo +1', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent] }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    // 自己（selfId=10001）在跟 1001 的会话里说了一句 —— 平台把它推回来了
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'echo-1', userId: 10001, text: '我自己发的' }))
    eq(result.routed, 'dup', '自身消息应判重')
    eq(result.echo, true, '应标记 echo')
    eq(agent.steers.length, 0, '自身消息不应投递')
    eq(h.buildStatus().dedup.echo, 1, 'dedup.echo 应为 1')
    // message_sent 形态同样按 echo 处理
    const sent = await h.runtime.inbound.ingest({
      post_type: 'message_sent', message_type: 'private', target_id: 1001, user_id: 10001,
      message_id: 'echo-2', message: [{ type: 'text', data: { text: '发送回执' } }],
      sender: { user_id: 10001, nickname: '我' },
    })
    eq(sent.routed, 'dup', 'message_sent 也应判重')
    eq(agent.steers.length, 0, 'message_sent 不应投递')
    eq(h.buildStatus().dedup.echo, 2, 'dedup.echo 应为 2')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C6  未绑定 send → 自动登记 taker                            */
/* ══════════════════════════════════════════════════════════ */

await test('C6', '未绑定 peer 首次 qq_send_private_msg：自动登记 taker，miraAccount.send 被调用', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent] }, async (h) => {
    await h.connect()
    const result = JSON.parse(await h.tool('qq_send_private_msg').execute(
      { user_id: 2001, message: '在吗' }, { agent: { id: 'S1' } },
    ))
    eq(result.ok, true, '应发送成功：' + JSON.stringify(result))
    eq(result.binding && result.binding.mode, 'taker', '返回里应含 binding.mode=taker')
    eq(result.binding && result.binding.action, 'created', '应报告 created')
    eq(h.accountState.sendCalls.length, 1, 'miraAccount.send 应被调用 1 次')
    eq(h.accountState.sent.length, 1, '适配器应真的发出去 1 条')
    const taker = h.accountState.bindings.find((row) => row.peerId === '2001' && row.mode === 'taker')
    check(!!taker, '应自动登记 taker 绑定')
    eq(taker && taker.sessionId, 'S1', 'taker 应是发起会话')
    eq(h.ws.last().sentPrivate()[0].message, '在吗', 'OneBot 收到的 message 应是原文')
    eq(h.buildStatus().bindings.taker, 1, 'status.bindings.taker 应为 1')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C7  另一会话对同 peer → conflict，未发出；force 才发        */
/* ══════════════════════════════════════════════════════════ */

await test('C7', '另一会话对同 peer：binding/conflict 且未发出；force 才发', async () => {
  const first = makeAgent({ id: 'S1' })
  const second = makeAgent({ id: 'S2' })
  await withHarness({ agents: [first, second] }, async (h) => {
    await h.connect()
    const ok = JSON.parse(await h.tool('qq_send_private_msg').execute(
      { user_id: 3001, message: '第一条' }, { agent: { id: 'S1' } },
    ))
    eq(ok.ok, true, 'S1 首次发送应成功')
    const sentBefore = h.accountState.sent.length

    const conflict = JSON.parse(await h.tool('qq_send_private_msg').execute(
      { user_id: 3001, message: '抢答' }, { agent: { id: 'S2' } },
    ))
    eq(conflict.ok, false, 'S2 应被拒')
    eq(conflict.error && conflict.error.code, 'binding/conflict', '错误码应是 binding/conflict')
    check(String(conflict.error.hint).includes('force'), 'hint 要提到 force：' + conflict.error.hint)
    eq(h.accountState.sent.length, sentBefore, '冲突时不应真的发出')

    const forced = JSON.parse(await h.tool('qq_send_private_msg').execute(
      { user_id: 3001, message: '我来了', force: true }, { agent: { id: 'S2' } },
    ))
    eq(forced.ok, true, 'force 应能抢答成功：' + JSON.stringify(forced))
    eq(forced.binding && forced.binding.mode, 'taker', '抢答后 S2 是 taker')
    eq(h.accountState.sent.length, sentBefore + 1, 'force 后才真的发出')
    const taker = h.accountState.bindings.find((row) => row.peerId === '3001' && row.mode === 'taker')
    eq(taker && taker.sessionId, 'S2', 'taker 应换成 S2')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C8  忙超 busyNoticeSec → 先回「在处理」                     */
/* ══════════════════════════════════════════════════════════ */

await test('C8', 'agent 忙超 busyNoticeSec：先向对端发「在处理」，busyByChat 可见忙了多久', async () => {
  const agent = makeAgent({ id: 'S1', status: 'running' }) // 永不结束
  await withHarness({
    agents: [agent],
    config: { busyNoticeSec: 0.05, reply: { mergeWindowMs: 0, agentTimeoutMs: 400 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const running = h.runtime.inbound.ingest(privateEvent({ messageId: 'm8', userId: '1001', text: '在吗' }))
    check(await waitFor(() => h.buildStatus().busyByChat['user:1001'] !== undefined, 500),
      'status.busyByChat 应出现 user:1001')
    const status = h.buildStatus()
    check(status.busyByChat['user:1001'].busyMs >= 0, 'busyMs 应是数字')
    eq(status.busyByChat['user:1001'].sessionId, 'S1', 'busyByChat 应记录会话')
    check(await waitFor(() => h.ws.last().sentPrivate().some((item) => String(item.message).includes('在处理')), 800),
      '忙超时应先回对方一句「在处理」：' + JSON.stringify(h.ws.last().sentPrivate()))
    const result = await running
    eq(result.delivery.ok, false, '最终这一轮应超时失败')
    eq(agent.cancels.length >= 1, true, '超时应调用 agent.cancel')
  })
})

await test('C8b', 'busyNoticeText 留空 = 不发「在处理」（busyNoticeSec 仍生效但不提示）', async () => {
  const agent = makeAgent({ id: 'S1', status: 'running' }) // 永不结束
  await withHarness({
    agents: [agent],
    config: { busyNoticeSec: 0.05, reply: { mergeWindowMs: 0, agentTimeoutMs: 300, busyNoticeText: '' } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const running = h.runtime.inbound.ingest(privateEvent({ messageId: 'm8b', userId: '1001', text: '在吗' }))
    await new Promise((resolve) => setTimeout(resolve, 200)) // 超过 busyNoticeSec(50ms)
    const sent = h.ws.last().sentPrivate().map((item) => String(item.message))
    eq(sent.filter((text) => text.includes('在处理')).length, 0, '文案留空时不应发「在处理」：' + JSON.stringify(sent))
    const result = await running
    eq(result.delivery.ok, false, '这一轮仍应超时失败（只是不发布忙通告）')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C9  /stop                                                  */
/* ══════════════════════════════════════════════════════════ */

await test('C9', '/stop：有在跑的回合才 cancel；空闲 peer 不 resume、不误报已停止', async () => {
  // ① 空闲 peer（S1 不是 live agent）：不 cancel、不 resume —— 否则空闲会话被凭空叫醒，
  //    对端还会收到一句假的「已停止」。
  await withHarness({ agents: [] }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'm9', userId: '1001', text: '/stop' }))
    eq(result.routed, 'command', '应识别为命令')
    eq(result.command, 'stop', '命令是 stop')
    eq(result.canceled, false, '没有在跑的回合时不该报告已取消')
    eq(result.delivery?.idle, true, '应如实报告 idle')
    eq(h.agents.resumed.length, 0, '空闲 peer 的 /stop 不该 resume 会话')
    eq(h.agents.map.has('S1'), false, '空闲 peer 的 /stop 不该把会话拉起来')
    const acks = h.ws.last().sentPrivate().map((item) => String(item.message))
    check(acks.some((text) => text.includes('没有正在进行')), '应回一句没有正在进行的回复：' + JSON.stringify(acks))
    check(!acks.some((text) => text.includes('已停止')), '不该误报已停止：' + JSON.stringify(acks))
  })

  // ② 真在跑的回合：cancel 被调用、回「已停止」
  const busy = makeAgent({ id: 'S1', status: 'running' })
  await withHarness({
    agents: [busy],
    config: { busyNoticeSec: 0, reply: { mergeWindowMs: 0, agentTimeoutMs: 5000 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const running = h.runtime.inbound.ingest(privateEvent({ messageId: 'm9b', userId: '1001', text: '在吗' }))
    check(await waitFor(() => h.buildStatus().busyByChat['user:1001'] !== undefined, 500),
      '前置条件：这一轮应在跑')
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'm9c', userId: '1001', text: '/stop' }))
    eq(result.canceled, true, '有在跑的回合时应报告已取消')
    eq(busy.cancels.length, 1, 'agent.cancel 应被调用 1 次')
    check(String(busy.cancels[0] && busy.cancels[0].reason).includes('stop'), 'cancel reason 应说明是 /stop：'
      + JSON.stringify(busy.cancels[0]))
    const acks = h.ws.last().sentPrivate().map((item) => String(item.message))
    check(acks.some((text) => text.includes('已停止')), '应回一句已停止：' + JSON.stringify(acks))
    eq(busy.steers.length, 1, '/stop 本身不该再投给 agent')
    busy.status = 'idle'
    await running
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C10 超时 → 取消 + 归一错误                                  */
/* ══════════════════════════════════════════════════════════ */

await test('C10', '超时（agent 永不结束）：取消 + 返回 delivery/failed（不是裸错）', async () => {
  const agent = makeAgent({ id: 'S1', status: 'running' })
  await withHarness({
    agents: [agent],
    config: { busyNoticeSec: 0, reply: { mergeWindowMs: 0, agentTimeoutMs: 150 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'm10', userId: '1001', text: '跑一下' }))
    eq(result.routed, 'taker', '仍会投递（插话）')
    eq(result.delivery.ok, false, '超时应 ok:false')
    eq(result.delivery.error && result.delivery.error.code, 'delivery/failed', '错误码应是 delivery/failed')
    check(String(result.delivery.error.hint).includes('agentTimeoutMs'), 'hint 要指出可调 agentTimeoutMs：'
      + result.delivery.error.hint)
    eq(agent.cancels.length, 1, '超时应取消这一轮')
    const status = h.buildStatus()
    eq(status.lastError && status.lastError.code, 'delivery/failed', 'status.lastError 应是 delivery/failed')
  })
})

await test('C10b', '投递失败的那条不记去重：同 message_id 重投还能再试，成功后才算 dup', async () => {
  const agent = makeAgent({ id: 'S1', status: 'running' }) // 先让它超时
  await withHarness({
    agents: [agent],
    config: { busyNoticeSec: 0, reply: { mergeWindowMs: 0, agentTimeoutMs: 120 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })

    const first = await h.runtime.inbound.ingest(privateEvent({ messageId: 'retry-q1', userId: '1001', text: '第一次' }))
    eq(first.routed, 'taker', '第一次应投递（失败）')
    eq(first.delivery.ok, false, '第一次应超时失败')

    // 平台重推同一条：不能被当成 dup 丢掉
    agent.status = 'idle' // 这次能成功
    const second = await h.runtime.inbound.ingest(privateEvent({ messageId: 'retry-q1', userId: '1001', text: '第一次' }))
    check(second.routed !== 'dup', '失败后重投不应是 dup：' + JSON.stringify(second))
    eq(second.delivery && second.delivery.ok, true, '第二次应投递成功')

    // 成功之后才记成重复
    const third = await h.runtime.inbound.ingest(privateEvent({ messageId: 'retry-q1', userId: '1001', text: '第一次' }))
    eq(third.routed, 'dup', '成功后同 id 再来应是 dup')
  })
})

await test('C10c', '合并窗口：N 条消息并成一次投递，但每条 id 都要记账（否则 60s 后重推会重复投）', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { mergeWindowMs: 40 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1101' })
    const a = await h.runtime.inbound.ingest(privateEvent({ messageId: 'mg-1', userId: '1101', text: '第一句' }))
    const b = await h.runtime.inbound.ingest(privateEvent({ messageId: 'mg-2', userId: '1101', text: '第二句' }))
    const c = await h.runtime.inbound.ingest(privateEvent({ messageId: 'mg-3', userId: '1101', text: '第三句' }))
    eq(a.routed, 'merged', '窗口内应先缓冲')
    eq(c.routed, 'merged', '第三条也应缓冲')
    check(await waitFor(() => agent.steers.length > 0, 800), '窗口到期应合并投递一次')
    eq(agent.steers.length, 1, '三条应只投递一次（合并）')
    check(steerText(agent).includes('第一句') && steerText(agent).includes('第三句'), '合并正文应包含各条')
    await new Promise((resolve) => setTimeout(resolve, 60)) // 记账在投递之后一个 tick（finally 里）

    // 关键：第 2、3 条的 message_id 也必须被记账，否则 60s 占位到期后重推会再投一次
    const seen1 = h.runtime.inbound.__testing?.seenCount ?? null
    const again = await h.runtime.inbound.ingest(privateEvent({ messageId: 'mg-2', userId: '1101', text: '第二句' }))
    eq(again.routed, 'dup', '第二条 id 应已记账（重推判 dup），实得 ' + JSON.stringify(again))
    const again3 = await h.runtime.inbound.ingest(privateEvent({ messageId: 'mg-3', userId: '1101', text: '第三句' }))
    eq(again3.routed, 'dup', '第三条 id 也应已记账')
  })
})

await test('X21', 'qq_send_media_file：四档 image/file/record/video；mp4 缺省走 video，显式 file 才当附件；未知值报错', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(tmpdir() + '/qq-media-')
  const mp4 = dir + '/clip.mp4'
  writeFileSync(mp4, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
  try {
    await withHarness({ config: { napcatMediaDir: dir } }, async (h) => {
      await h.connect()
      // 1) 缺省：mp4 → CQ:video（内联播放，不是附件）
      const auto = JSON.parse(await h.tool('qq_send_media_file').execute(
        { target: 'group:800000000', file: mp4 }, { agent: { id: 'S1' } },
      ))
      eq(auto.ok, true, 'mp4 应发送成功：' + JSON.stringify(auto))
      check(String(auto.cq).includes('[CQ:video,'), 'mp4 缺省应走 CQ:video：' + auto.cq)

      // 2) 显式 file：当附件发
      const asFile = JSON.parse(await h.tool('qq_send_media_file').execute(
        { target: 'group:800000000', file: mp4, type: 'file' }, { agent: { id: 'S1' } },
      ))
      eq(asFile.ok, true, 'type:file 应发送成功')
      check(String(asFile.cq).includes('[CQ:file,'), 'type:file 应走 CQ:file：' + asFile.cq)

      // 3) 未知值：直接报错
      const bad = JSON.parse(await h.tool('qq_send_media_file').execute(
        { target: 'group:800000000', file: mp4, type: 'audio' }, {},
      ))
      eq(bad.ok, false, '未知类型应被拒：' + JSON.stringify(bad))
      eq(bad.error && bad.error.code, 'config/invalid', '错误码应是 config/invalid')
      check(String(bad.error.hint).includes('video'), 'hint 要列出可用档位：' + bad.error.hint)
    })
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

await test('X22', '正文里的 CQ 方括号默认转义（否则 NapCat 会把整条消息拒发）；cq:true 才按 CQ 码解析', async () => {
  await withHarness({}, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1201' })
    // 正文里带一个「像 CQ 码」的片段：默认必须转义
    const sent = JSON.parse(await h.tool('qq_send_private_msg').execute(
      { user_id: 1201, message: '他发来的是 [CQ:image,file=abc.jpg] 这种' }, { agent: { id: 'S1' } },
    ))
    eq(sent.ok, true, '发送应成功：' + JSON.stringify(sent))
    const payload = String(h.ws.last().sentPrivate().slice(-1)[0].message)
    check(payload.includes('&#91;CQ:image'), '方括号应被转义成 &#91;：' + payload)
    check(!payload.includes('[CQ:image'), '不应原样带 CQ 段（会被 NapCat 当消息段解析）')

    // 显式 cq:true：按 CQ 码解析（@ 人）
    const at = JSON.parse(await h.tool('qq_send_group_msg').execute(
      { group_id: 800000000, message: '[CQ:at,qq=1001] 看这个', cq: true }, { agent: { id: 'S1' } },
    ))
    eq(at.ok, true, 'cq:true 应发送成功：' + JSON.stringify(at))
    const groupPayload = String(h.ws.last().sentGroup().slice(-1)[0].message)
    check(groupPayload.includes('[CQ:at,qq=1001]'), 'cq:true 时应原样保留 CQ 码：' + groupPayload)
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C11 断线积压 latest_n=20                                    */
/* ══════════════════════════════════════════════════════════ */

await test('C11', '断线 30 条 + latest_n=20：补 20、丢 10，status().backlog 数字对得上', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { backlog: { policy: 'latest_n', latestN: 20, maxPending: 200 } },
  }, async (h) => {
    // 故意不 open：连接不可用 → 入站进积压队列
    eq(h.runtime.onebot.connected, false, '前置条件：未连接')
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    for (let i = 0; i < 30; i += 1) {
      const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'b' + i, userId: '1001', text: '第' + i + '条' }))
      eq(result.routed, 'queued', '第 ' + i + ' 条应进积压')
    }
    eq(h.buildStatus().backlog.pending, 30, '积压应有 30 条')
    eq(h.buildStatus().backlog.received, 30, 'received 应为 30')

    const summary = await h.runtime.inbound.flushBacklog()
    eq(summary.policy, 'latest_n', '策略应是 latest_n')
    eq(summary.received, 30, '本次积压 30 条')
    eq(summary.dropped, 10, '应丢 10 条')
    eq(summary.backfilled, 20, '应补投 20 条')
    await h.runtime.inbound.pending()
    eq(agent.steers.length, 20, '应恰好 steer 20 次')
    check(steerText(agent, 0).includes('第10条'), '补的应是最新 20 条（从第 10 条起）：' + steerText(agent, 0).slice(0, 120))

    const backlog = h.buildStatus().backlog
    eq({ received: backlog.received, dropped: backlog.dropped, backfilled: backlog.backfilled },
      { received: 30, dropped: 10, backfilled: 20 }, 'status().backlog 应是 {received:30,dropped:10,backfilled:20}')
    eq(backlog.pending, 0, '回放后积压应清空')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C12 群未触发                                                */
/* ══════════════════════════════════════════════════════════ */

await test('C12', '群聊默认全收（groupAccess=all）：没 @ 也投递，提示词写明 taker', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { mergeWindowMs: 0, replyToGroup: true } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'group', peerId: '500' })
    const result = await h.runtime.inbound.ingest(groupEvent({ messageId: 'g1', groupId: 500, userId: 1001, text: '随便聊聊' }))
    eq(result.routed, 'taker', '默认 groupAccess=all：没 @ 也应投递')
    eq(agent.steers.length, 1, '应 steer 1 次')
    check(steerText(agent).includes('群内昵称'), '群消息正文要带发送者前缀（旧行为）')
    check(steerText(agent).includes('应答（taker）'), '提示词要写明角色是 taker：' + steerText(agent).slice(0, 160))
  })
})

await test('C12b', 'groupAccess=mention：没 @ 不投递（ignored 计数），@ 了才投', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: {
      reply: { mergeWindowMs: 0, replyToGroup: true, groupAccess: 'mention', trigger: { at: true, keywords: [] } },
    },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'group', peerId: '500' })
    const result = await h.runtime.inbound.ingest(groupEvent({ messageId: 'g1', groupId: 500, userId: 1001, text: '随便聊聊' }))
    eq(result.routed, 'ignored', '没 @ 不应投递')
    eq(result.reason, 'groupNotTriggered', '原因应是 groupNotTriggered')
    eq(agent.steers.length, 0, 'agent 不应被叫醒')
    eq(h.buildStatus().ignored.groupNotTriggered, 1, 'ignored.groupNotTriggered 应为 1')
    const at = await h.runtime.inbound.ingest(groupEvent({ messageId: 'g2', groupId: 500, userId: 1001, text: '在吗', atSelf: true }))
    eq(at.routed, 'taker', '@ 我之后应投递')
    eq(agent.steers.length, 1, '应 steer 1 次')
  })
})

await test('C12c', '群聊不受私聊白名单/熟人名单限制：名单外的人在群里也照收', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { mergeWindowMs: 0, replyToGroup: true, privateWhitelist: ['1001'], trustedUsers: ['1001:x'] } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'group', peerId: '500' })
    const result = await h.runtime.inbound.ingest(groupEvent({ messageId: 'g1', groupId: 500, userId: 9999, text: '路人甲' }))
    eq(result.routed, 'taker', '群聊只看 replyToGroup/groupWhitelist/groupAccess，不看私聊白名单')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C13 陌生人静默                                              */
/* ══════════════════════════════════════════════════════════ */

await test('C13', '白名单外用户私聊：静默但 ignored.stranger 可见；白名单内正常应答', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { mergeWindowMs: 0, trustedUsers: ['1001:张三，是你的朋友'] } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1002' })
    const stranger = await h.runtime.inbound.ingest(privateEvent({ messageId: 's1', userId: '1002', text: '陌生人' }))
    eq(stranger.routed, 'ignored', '陌生人消息不应投递')
    eq(stranger.reason, 'stranger', '原因应是 stranger')
    eq(agent.steers.length, 0, 'agent 不应被叫醒')
    eq(h.buildStatus().ignored.stranger, 1, 'ignored.stranger 应为 1')

    // 白名单内（1001）照常应答，且人设文本进提示词的【识别名单】
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const trusted = await h.runtime.inbound.ingest(privateEvent({ messageId: 's2', userId: '1001', text: '哥哥' }))
    eq(trusted.routed, 'taker', '白名单用户应正常投递')
    eq(agent.steers.length, 1, '应 steer 1 次')
    check(steerText(agent).includes('张三，是你的朋友'), '识别名单里的人设文本要进提示词（冒号后不能丢）')
  })
})

await test('C13b', '熟人名单与私聊白名单分开：准入看白名单，提示词仍用熟人名单', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { mergeWindowMs: 0, trustedUsers: ['1001:张三，是你的朋友'], privateWhitelist: ['1002'] } },
  }, async (h) => {
    await h.connect()
    // 1002：在私聊白名单、不在熟人名单 → 能私聊；提示词里的【识别名单】仍然只有 1001
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1002' })
    const allowed = await h.runtime.inbound.ingest(privateEvent({ messageId: 'p1', userId: '1002', text: '朋友' }))
    eq(allowed.routed, 'taker', '私聊白名单内应投递（即使不在熟人名单）')
    check(steerText(agent).includes('张三'), '熟人名单仍要进【识别名单】：' + steerText(agent).slice(0, 160))

    // 1001：在熟人名单、不在私聊白名单 → 静默
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const denied = await h.runtime.inbound.ingest(privateEvent({ messageId: 'p2', userId: '1001', text: '哥哥' }))
    eq(denied.routed, 'ignored', '不在私聊白名单应静默（即使他在熟人名单里）')
    eq(denied.reason, 'stranger', '原因应是 stranger')
  })
})

await test('C13c', 'privateWhitelist: [] = 私聊全接受（熟人名单不影响准入）', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { mergeWindowMs: 0, trustedUsers: ['1001:张三'], privateWhitelist: [] } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '9999' })
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'p1', userId: '9999', text: '陌生人' }))
    eq(result.routed, 'taker', 'privateWhitelist 为空 = 全接受')
  })
})

await test('C13d', 'observer 会话：提示词写明旁听，且不会向对方发「在处理」', async () => {
  const observer = makeAgent({ id: 'S-obs', status: 'running' }) // 故意让它忙：若误发忙通告就能看到「在处理」
  await withHarness({
    agents: [observer],
    config: { busyNoticeSec: 0.05, reply: { mergeWindowMs: 0, agentTimeoutMs: 300 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S-obs', accountId: 'qq-main', kind: 'user', peerId: '1001', mode: 'observer' })
    const running = h.runtime.inbound.ingest(privateEvent({ messageId: 'o1', userId: '1001', text: '旁听一条' }))
    await sleep(200) // 超过 busyNoticeSec(50ms)
    check(!h.ws.last().sentPrivate().some((item) => String(item.message).includes('在处理')),
      '旁听投递不应发「在处理」：' + JSON.stringify(h.ws.last().sentPrivate()))
    const result = await running
    eq(result.routed, 'observer', '只有 observer 时走 observer 分支')
    check(steerText(observer).includes('旁听（observer）'), '提示词要写明旁听：' + steerText(observer).slice(0, 160))
    check(steerText(observer).includes('不要回复'), '要明确告诉它不要回复')
  })
})

await test('C13e', 'qq_role：taker / observer / none 三种回答', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent], config: { reply: { mergeWindowMs: 0 } } }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'group', peerId: '500', observer: true })
    const call = async (args) => JSON.parse(await h.tool('qq_role').execute(args, { agent }))
    eq((await call({ kind: 'user', peerId: '1001' })).yourRole, 'taker', 'user:1001 上是 taker')
    eq((await call({ kind: 'group', peerId: '500' })).yourRole, 'observer', 'group:500 上是 observer')
    eq((await call({ kind: 'user', peerId: '7777' })).yourRole, 'none', '没参与是 none')
    const all = await call({})
    eq(all.count, 2, '不带 peer 时列出本会话的 2 条绑定')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* C14 qq_status 字段 + 不回显 token                           */
/* ══════════════════════════════════════════════════════════ */

await test('C14', 'qq_status：字段齐全（connected/selfId/queueLength/busyByChat/bindings/lastError/backlog），不含 accessToken', async () => {
  const agent = makeAgent({ id: 'S1' })
  const token = 'SECRET-ACCESS-TOKEN-DO-NOT-LEAK'
  await withHarness({ agents: [agent], config: { accessToken: token } }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    eq(h.ws.last().headers.Authorization, 'Bearer ' + token, 'accessToken 应只进 Authorization 头')
    const raw = await h.tool('qq_status').execute({}, {})
    check(!raw.includes(token), 'qq_status 输出绝不能包含 accessToken 明文')
    const parsed = JSON.parse(raw)
    for (const key of ['connected', 'selfId', 'queueLength', 'busyByChat', 'bindings', 'lastError', 'backlog']) {
      check(Object.prototype.hasOwnProperty.call(parsed, key), 'qq_status 缺少字段 ' + key)
    }
    eq(parsed.connected, true, 'connected 应为 true')
    eq(parsed.selfId, 10001, 'selfId 应来自 get_login_info')
    eq(parsed.accountId, 'qq-main', 'accountId 应是配置值')
    eq(parsed.config.accessTokenConfigured, true, '只报「配了没」，不报值')
    eq(parsed.bindings.count, 1, '绑定表摘要应有 1 条')
    check(Array.isArray(parsed.bindings.rows), 'bindings.rows 应是数组')
    eq(parsed.backlog.policy, 'latest_n', 'backlog.policy 应可见')
    eq(parsed.config.wsUrlConfigured, true, 'wsUrlConfigured 应为 true')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X1  schemaVersion 不匹配 → 拒绝加载                         */
/* ══════════════════════════════════════════════════════════ */

await test('X1', 'schemaVersion 不匹配：拒绝加载并给迁移提示（不静默兼容）', async () => {
  const home = freshHome()
  const file = join(home, 'mira_config', 'mira_qqbot', 'config.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 99, wsUrl: 'ws://x:1' }, null, 2))
  const runtime = createRuntime({ ctx: { logger }, config: {}, logger, webSocketImpl: makeFakeWs().Impl })
  eq(runtime.ok, false, '应拒绝加载')
  eq(runtime.error && runtime.error.code, 'config/schema', '错误码应是 config/schema')
  check(String(runtime.error.hint).includes('迁移') || String(runtime.error.hint).includes('备份'),
    'hint 要给出迁移/修复提示：' + runtime.error.hint)
  eq(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 99, '原文件必须原样保留（不静默改写）')
})

/* ══════════════════════════════════════════════════════════ */
/* X2  单实例                                                  */
/* ══════════════════════════════════════════════════════════ */

await test('X2', '单实例：第二次 apply 返回 plugin/instance 且不注册工具', async () => {
  freshHome()
  const savedWebSocket = globalThis.WebSocket
  globalThis.WebSocket = makeFakeWs().Impl
  try {
    const agents = makeAgentsService()
    const ctx1 = makeCtx({ accountApi: makeAccountService({
      accounts: [{ id: 'qq-main', platform: 'qq', enabled: true, inboundPolicy: 'create' }],
      agentsMap: agents.map,
    }).api, agents, workspaces: makeWorkspaces() })
    const first = apply(ctx1, { wsUrl: 'ws://fake:3001', accountId: 'qq-main' })
    eq(first && first.ok, true, '第一次 apply 应成功：' + JSON.stringify(first))
    check(ctx1.toolsMap.has('qq_status'), '应注册 qq_status')
    eq(ctx1.toolsMap.size, 22, '应注册 22 个工具（实得 ' + [...ctx1.toolsMap.keys()].join(',') + '）')

    const ctx2 = makeCtx({ accountApi: makeAccountService({
      accounts: [{ id: 'qq-main', platform: 'qq', enabled: true, inboundPolicy: 'create' }],
      agentsMap: agents.map,
    }).api, agents, workspaces: makeWorkspaces() })
    const second = apply(ctx2, { wsUrl: 'ws://fake:3001', accountId: 'qq-main' })
    eq(second && second.ok, false, '第二次应失败')
    eq(second.error && second.error.code, 'plugin/instance', '错误码应是 plugin/instance')
    eq(ctx2.toolsMap.size, 0, '被拒实例不应注册工具')
    check(logLines.some((line) => line.includes('已经有一个实例在跑')), '应写 warn 日志')
    ctx1.dispose()
    ctx2.dispose()
  } finally {
    globalThis.WebSocket = savedWebSocket
  }
})

/* ══════════════════════════════════════════════════════════ */
/* X3  合并窗口                                                */
/* ══════════════════════════════════════════════════════════ */

await test('X3', '合并窗口：窗口内两条只投一次，正文含两条', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { mergeWindowMs: 40 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const one = await h.runtime.inbound.ingest(privateEvent({ messageId: 'mg1', userId: '1001', text: '第一句' }))
    const two = await h.runtime.inbound.ingest(privateEvent({ messageId: 'mg2', userId: '1001', text: '第二句' }))
    eq(one.routed, 'merged', '第一条应进合并窗口')
    eq(two.routed, 'merged', '第二条应进合并窗口')
    eq(two.pending, 2, '窗口里应有 2 条')
    await sleep(80)
    await h.runtime.inbound.pending()
    eq(agent.steers.length, 1, '合并后只投 1 次')
    const text = steerText(agent)
    check(text.includes('第一句') && text.includes('第二句'), '正文应含两条消息：' + text.slice(0, 160))
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X4  queue 模式                                              */
/* ══════════════════════════════════════════════════════════ */

await test('X4', 'queue 模式：忙时排队（queueLength 可见），这一轮结束后自动出队', async () => {
  const agent = makeAgent({ id: 'S1', status: 'running' })
  await withHarness({
    agents: [agent],
    config: {
      busyNoticeSec: 0,
      delivery: { default: 'steer', byPeer: { 'user:1001': 'queue' } },
      reply: { mergeWindowMs: 0, agentTimeoutMs: 3000 },
    },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const first = h.runtime.inbound.ingest(privateEvent({ messageId: 'q1', userId: '1001', text: '第一条' }))
    check(await waitFor(() => h.buildStatus().busyByChat['user:1001'] !== undefined, 500), '第一条应开始跑')
    const second = await h.runtime.inbound.ingest(privateEvent({ messageId: 'q2', userId: '1001', text: '第二条' }))
    eq(second.routed, 'taker', '第二条仍会返回已接收')
    eq(second.delivery.queued, true, '第二条应被排队')
    eq(h.buildStatus().queueLength, 1, 'queueLength 应为 1')
    eq(h.buildStatus().queues['user:1001'], 1, 'queues 里 user:1001 应为 1')

    agent.status = 'idle' // 让第一条这一轮结束
    await first
    await h.runtime.inbound.pending()
    await waitFor(() => agent.steers.length >= 2, 1000)
    eq(agent.steers.length, 2, '出队后应投第 2 条')
    eq(h.buildStatus().queueLength, 0, '队列应清空')
    check(steerText(agent, 1).includes('第二条'), '第二次投的应是第二条')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X5  未绑定 + inboundPolicy=create → 交给 mira_account        */
/* ══════════════════════════════════════════════════════════ */

await test('X5', '未绑定 + inboundPolicy=create：交给 miraAccount.inbound 建会话，不写旧 meta.json', async () => {
  const workspace = join(TMP, 'workspace-x5')
  mkdirSync(workspace, { recursive: true })
  await withHarness({
    inboundPolicy: 'create',
    config: {
      reply: { mergeWindowMs: 0, agentCwd: workspace, agentPreset: 'stella' },
    },
  }, async (h) => {
    await h.connect()
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'n1', userId: '4001', text: '第一次来' }))
    eq(result.routed, 'created', '应走 inboundPolicy=create 新建会话')
    eq(h.accountState.inboundCalls.length, 1, '应把入站交给 miraAccount.inbound')
    eq(h.agents.created.length, 1, '应通过 adapter.createSession 建 1 个会话')
    const created = h.agents.created[0]
    eq(created.meta && created.meta.cwd, workspace, '会话 cwd 应来自 reply.agentCwd')
    eq(created.meta && created.meta.agentPreset, 'stella', '会话 meta 应记录 agentPreset')
    check(created.sections.includes('mira_qqbot:rules'), '应注入聊天规则 section：' + created.sections.join(','))
    const taker = h.accountState.bindings.find((row) => row.peerId === '4001' && row.mode === 'taker')
    check(!!taker, '新会话应被登记成 taker')
    eq(h.accountState.delivered.length, 1, 'mira_account 应把消息投给新会话')
    check(!existsSync(join(workspace, 'data', 'meta.json')), '绝不能再写旧的 chatId→sessionId meta.json')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X6  旧 profile 配置兼容 + legacyConfigKeys                  */
/* ══════════════════════════════════════════════════════════ */

await test('X6', '旧 profile 配置（autoReply.*）继续生效 + legacyConfigKeys 点名 + 人设文本进提示词', async () => {
  const agent = makeAgent({ id: 'S1' })
  const profile = {
    enabled: true,
    wsUrl: 'ws://legacy:3001',
    accessToken: '',
    napcatMediaDir: '',
    napcatDir: '/tmp/napcat',
    autoReply: {
      enabled: true,
      agentPreset: 'stella',
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-flash',
      agentCwd: '/tmp/workspace',
      replyToGroup: false,
      mergeWindowMs: 0,
      trustedUsers: ['1001:张三，是你的朋友', '1002:李四，是你的妹妹'],
    },
  }
  await withHarness({ agents: [agent], config: profile }, async (h) => {
    const cfg = h.runtime.cfg
    eq(cfg.reply.enabled, true, 'autoReply.enabled 应映射到 reply.enabled')
    eq(cfg.reply.agentPreset, 'stella', 'autoReply.agentPreset 应映射')
    eq(cfg.reply.agentProvider, 'deepseek-official', 'autoReply.agentProvider 应映射')
    eq(cfg.reply.agentModel, 'deepseek-flash', 'autoReply.agentModel 应映射')
    eq(cfg.reply.agentCwd, '/tmp/workspace', 'autoReply.agentCwd 应映射')
    eq(cfg.reply.trustedUsers.length, 2, 'trustedUsers 应原样保留')
    eq(cfg.napcatDir, '/tmp/napcat', '同名顶层键应继续生效')
    eq(cfg.accessToken, '', 'accessToken 空字符串是合法值，不报缺失')

    const keys = h.runtime.legacyConfigKeys
    check(keys.some((line) => line.startsWith('autoReply.agentPreset')), 'legacyConfigKeys 要点名 autoReply.agentPreset：' + keys.join(' | '))
    check(keys.some((line) => line.includes('wsUrl')), 'legacyConfigKeys 要点名 profile.config.wsUrl：' + keys.join(' | '))
    const status = h.buildStatus()
    eq(status.legacyConfigKeys.length, keys.length, 'qq_status 应带上 legacyConfigKeys')

    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const result = await h.runtime.inbound.ingest(privateEvent({
      messageId: 'legacy-1', userId: '1001', text: '哥哥在吗',
    }))
    eq(result.routed, 'taker', '白名单里的用户应正常应答')
    const text = steerText(agent)
    check(text.includes('张三，是你的朋友'), '识别名单里冒号后的人设说明要进提示词')
    check(text.includes('李四，是你的妹妹'), '第二条人设也要在【识别名单】里')
    check(logLines.some((line) => line.includes('旧的 profile 配置键')), '应写一条 warn 提示搬家')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X7  token 只进头 + config.json 600                          */
/* ══════════════════════════════════════════════════════════ */

await test('X7', 'accessToken 只进 Authorization 头；config.json 权限 600', async () => {
  const token = 'TOKEN-XYZ-123456'
  const home = freshHome()
  const file = join(home, 'mira_config', 'mira_qqbot', 'config.json')
  // 先写一份含 token 但权限宽松的配置，加载时应被纠正为 600
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, wsUrl: 'ws://f:1', accountId: 'qq-main', accessToken: token }, null, 2), { mode: 0o644 })
  const agents = makeAgentsService([makeAgent({ id: 'S1' })])
  const account = makeAccountService({
    accounts: [{ id: 'qq-main', platform: 'qq', enabled: true, inboundPolicy: 'create' }],
    agentsMap: agents.map,
  })
  const fakeWs = makeFakeWs()
  const runtime = createRuntime({
    ctx: { logger, miraAccount: account.api, agents, workspaceRegistry: makeWorkspaces() },
    config: {},
    logger,
    webSocketImpl: fakeWs.Impl,
    turn: TURN,
  })
  eq(runtime.ok, true, '应加载成功')
  try {
    runtime.start()
    fakeWs.last().open()
    await runtime.onebot.waitConnected(500)
    eq(fakeWs.last().headers.Authorization, 'Bearer ' + token, 'token 应只出现在 Authorization 头')
    eq(statSync(file).mode & 0o777, 0o600, 'config.json 应被纠正为 600')
    const cfg = runtime.cfg
    eq(cfg.accessToken, token, '进程内仍能拿到 token（只给 Authorization 头用）')
    const status = JSON.stringify(runtime.buildStatus())
    check(!status.includes(token), 'buildStatus 不应包含 token 明文')
    check(logLines.some((line) => line.includes('已改为 600')), '纠正权限时应写一条 warn')
  } finally {
    runtime.dispose()
  }
})

/* ══════════════════════════════════════════════════════════ */
/* X8  qq_recv_messages                                        */
/* ══════════════════════════════════════════════════════════ */

await test('X8', 'qq_recv_messages 仍能增量拉取（环形缓冲保留）', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent] }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    await h.runtime.inbound.ingest(privateEvent({ messageId: 'r1', userId: '1001', text: '拉我' }))
    await h.runtime.inbound.ingest(groupEvent({ messageId: 'r2', groupId: 500, userId: 1002, text: '群里' }))
    const pulled = JSON.parse(await h.tool('qq_recv_messages').execute({ since: 0, limit: 10 }, {}))
    eq(pulled.count, 2, '应拉到 2 条')
    check(pulled.maxSeq > 0, 'maxSeq 应是正数')
    eq(pulled.messages[0].raw, '拉我', '第一条应是私聊原文')
    const again = JSON.parse(await h.tool('qq_recv_messages').execute({ since: pulled.maxSeq, limit: 10 }, {}))
    eq(again.count, 0, '用 maxSeq 再拉应没有新消息')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X9  /new → 释放会话 + 解绑 + 回执                            */
/* ══════════════════════════════════════════════════════════ */

await test('X9', '/new：释放 agent + 在 mira_account 里解绑 + 回执', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent] }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'new1', userId: '1001', text: '/new' }))
    eq(result.routed, 'command', '应识别为命令')
    eq(result.command, 'new', '命令是 new')
    eq(agent.disposed, true, '应释放该会话的 agent')
    eq(h.accountState.bindings.filter((row) => row.peerId === '1001').length, 0, '应解绑该 peer')
    const acks = h.ws.last().sentPrivate().map((item) => String(item.message))
    check(acks.some((text) => text.includes('新会话已开启')), '应回一句新会话已开启：' + JSON.stringify(acks))
    eq(agent.steers.length, 0, '/new 本身不该投给 agent')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X10 积压策略 drop / replay                                  */
/* ══════════════════════════════════════════════════════════ */

await test('X10', '积压策略 drop（全丢）与 replay（全补）', async () => {
  const dropped = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [dropped],
    config: { backlog: { policy: 'drop', latestN: 20, maxPending: 200 } },
  }, async (h) => {
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.inbound.ingest(privateEvent({ messageId: 'd' + i, userId: '1001', text: '丢弃' + i }))
    }
    const summary = await h.runtime.inbound.flushBacklog()
    eq(summary.dropped, 3, 'drop 应丢 3 条')
    eq(summary.backfilled, 0, 'drop 不补投')
    eq(dropped.steers.length, 0, 'agent 不应收到任何消息')
    eq(h.buildStatus().backlog.dropped, 3, 'status.backlog.dropped 应为 3')
  })

  const replayed = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [replayed],
    config: { backlog: { policy: 'replay', latestN: 20, maxPending: 200 } },
  }, async (h) => {
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.inbound.ingest(privateEvent({ messageId: 'r' + i, userId: '1001', text: '补投' + i }))
    }
    const summary = await h.runtime.inbound.flushBacklog()
    eq(summary.dropped, 0, 'replay 不丢')
    eq(summary.backfilled, 3, 'replay 应补 3 条')
    eq(replayed.steers.length, 3, 'agent 应收到 3 条')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X11 reply.enabled=false → 只缓冲不投递                       */
/* ══════════════════════════════════════════════════════════ */

await test('X11', 'reply.enabled=false：不投递但计数可见，缓冲仍可拉取', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { reply: { enabled: false, mergeWindowMs: 0 } },
  }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'off1', userId: '1001', text: '关掉了' }))
    eq(result.routed, 'ignored', '不应投递')
    eq(result.reason, 'reply-disabled', '原因应是 reply-disabled')
    eq(agent.steers.length, 0, 'agent 不应被叫醒')
    eq(h.buildStatus().ignored.replyDisabled, 1, 'ignored.replyDisabled 应为 1')
    const pulled = JSON.parse(await h.tool('qq_recv_messages').execute({ since: 0 }, {}))
    eq(pulled.count, 1, '缓冲仍应保留这条（模型可 pull）')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X12 未绑定 + inboundPolicy=drop                             */
/* ══════════════════════════════════════════════════════════ */

await test('X12', '未绑定 + inboundPolicy=drop：交给 miraAccount.inbound 并丢弃', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent], inboundPolicy: 'drop' }, async (h) => {
    await h.connect()
    const result = await h.runtime.inbound.ingest(privateEvent({ messageId: 'drop1', userId: '5001', text: '陌生来信' }))
    eq(result.routed, 'dropped', '应按 drop 策略丢弃')
    eq(h.accountState.inboundCalls.length, 1, '应交给 miraAccount.inbound 决定')
    eq(agent.steers.length, 0, 'agent 不应被叫醒')
    eq(h.accountState.bindings.length, 0, '不应产生绑定')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X13 qq_recv_messages 分页（最旧一页、不漏不重）               */
/* ══════════════════════════════════════════════════════════ */

await test('X13', 'qq_recv_messages：limit 小于积压时返回最旧一页，两次拉完 100 条不漏不重', async () => {
  await withHarness({ config: { reply: { enabled: false } } }, async (h) => {
    await h.connect()
    for (let i = 0; i < 100; i += 1) {
      await h.runtime.inbound.ingest(privateEvent({ messageId: 'pg' + i, userId: '2001', text: '第' + i + '条' }))
    }
    const first = JSON.parse(await h.tool('qq_recv_messages').execute({ since: 0, limit: 50 }, {}))
    eq(first.count, 50, '第一次应返回 50 条')
    eq(first.hasMore, true, '还有剩余时应报告 hasMore')
    eq(first.truncated, true, 'truncated 与 hasMore 同义')
    eq(first.messages[0].raw, '第0条', '应从**最旧**的一条开始（不是最新）')
    eq(first.messages[49].raw, '第49条', '第一次应到第 49 条为止')
    const second = JSON.parse(await h.tool('qq_recv_messages').execute({ since: first.maxSeq, limit: 50 }, {}))
    eq(second.count, 50, '第二次应返回剩下 50 条')
    eq(second.hasMore, false, '拉完应报告 hasMore=false')
    eq(second.messages[0].raw, '第50条', '第二次应从第 50 条接着拉')
    const ids = [...first.messages, ...second.messages].map((item) => item.message_id)
    eq(new Set(ids).size, 100, '两次合起来不应有重复')
    const got = new Set(ids)
    let missing = 0
    for (let i = 0; i < 100; i += 1) if (!got.has('pg' + i)) missing += 1
    eq(missing, 0, '100 条一条不少（旧实现会静默丢掉第 1..50 条）')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X14 /stop 作废合并窗口 + 空闲不 resume                       */
/* ══════════════════════════════════════════════════════════ */

await test('X14', '/stop 作废合并窗口：窗口到期不再投递；空闲 peer 不 resume', async () => {
  await withHarness({ agents: [], config: { reply: { mergeWindowMs: 80 } } }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const inWindow = await h.runtime.inbound.ingest(privateEvent({ messageId: 'ws1', userId: '1001', text: '在吗' }))
    eq(inWindow.routed, 'merged', '前置条件：消息进了合并窗口')
    const stopped = await h.runtime.inbound.ingest(privateEvent({ messageId: 'ws2', userId: '1001', text: '/stop' }))
    eq(stopped.routed, 'command', '/stop 应识别为命令')
    eq(stopped.droppedPending, 1, '应报告作废了 1 条窗口消息')
    eq(stopped.canceled, false, '空闲 peer 上 /stop 不该报告已取消')
    eq(h.agents.resumed.length, 0, '空闲 peer 上 /stop 不该 resume 会话')
    await sleep(140)
    await h.runtime.inbound.pending()
    eq(h.agents.resumed.length, 0, '窗口到期也不该投递（更不该 resume）')
    eq(h.buildStatus().merges.length, 0, '窗口应已清空')
    const replay = await h.runtime.inbound.ingest(privateEvent({ messageId: 'ws1', userId: '1001', text: '在吗' }))
    eq(replay.routed, 'dup', '被作废的消息应按「已处理」记账（重推判 dup）')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X15 /new 作废合并窗口                                       */
/* ══════════════════════════════════════════════════════════ */

await test('X15', '/new 作废合并窗口：窗口内消息不得投给旧会话', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent], config: { reply: { mergeWindowMs: 80 } } }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const inWindow = await h.runtime.inbound.ingest(privateEvent({ messageId: 'nw1', userId: '1001', text: '在吗' }))
    eq(inWindow.routed, 'merged', '前置条件：消息进了合并窗口')
    const reset = await h.runtime.inbound.ingest(privateEvent({ messageId: 'nw2', userId: '1001', text: '/new' }))
    eq(reset.routed, 'command', '/new 应识别为命令')
    eq(reset.droppedPending, 1, '应报告作废了 1 条窗口消息')
    await sleep(140)
    await h.runtime.inbound.pending()
    eq(agent.steers.length, 0, '窗口内消息不该投给旧会话')
    eq(h.accountState.bindings.length, 0, '旧会话应保持解绑（不被反向绑定回来）')
    eq(h.buildStatus().merges.length, 0, '窗口应已清空')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X16 积压回放统计：dropped / command 不算 backfilled          */
/* ══════════════════════════════════════════════════════════ */

await test('X16', '积压回放：被 inboundPolicy=drop 的与 /stop 都不算 backfilled', async () => {
  await withHarness({
    inboundPolicy: 'drop',
    config: { backlog: { policy: 'replay', latestN: 20, maxPending: 200 } },
  }, async (h) => {
    await h.runtime.inbound.ingest(privateEvent({ messageId: 'bd1', userId: '5001', text: '陌生来信' }))
    const summary = await h.runtime.inbound.flushBacklog()
    eq(summary.backfilled, 0, '按 drop 策略丢掉的补投不算 backfilled')
    eq(h.buildStatus().backlog.backfilled, 0, 'status 里也不该算')
  })

  const agent = makeAgent({ id: 'S1' })
  await withHarness({
    agents: [agent],
    config: { backlog: { policy: 'replay', latestN: 20, maxPending: 200 } },
  }, async (h) => {
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    await h.runtime.inbound.ingest(privateEvent({ messageId: 'bc1', userId: '1001', text: '/stop' }))
    const summary = await h.runtime.inbound.flushBacklog()
    eq(summary.backfilled, 0, '回放一条命令不算 backfilled')
    eq(agent.steers.length, 0, '命令不该投给 agent')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X17 合并窗口溢出：丢最旧，按「未投递」释放占位                 */
/* ══════════════════════════════════════════════════════════ */

await test('X17', '合并窗口溢出 50 条上限：溢出的最旧条目释放占位不投递', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent], config: { reply: { mergeWindowMs: 150 } } }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    let last = null
    for (let i = 0; i < 55; i += 1) {
      last = await h.runtime.inbound.ingest(privateEvent({ messageId: 'of' + i, userId: '1001', text: '刷' + i }))
    }
    eq(last.pending, 50, '窗口里最多留 50 条')
    eq(h.accountState.released.slice().sort(), ['of0', 'of1', 'of2', 'of3', 'of4'],
      '溢出的最旧 5 条应按「未投递」释放占位')
    await sleep(220)
    await h.runtime.inbound.pending()
    eq(agent.steers.length, 1, '仍只投一次')
    const text = steerText(agent)
    check(!text.includes('刷0'), '被丢弃的旧条目不该出现在正文：' + text.slice(0, 120))
    check(text.includes('刷5') && text.includes('刷54'), '保留的是最新的 50 条')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X18 dispose 释放窗口占位 + 空正文按已处理记账                  */
/* ══════════════════════════════════════════════════════════ */

await test('X18', 'dispose：释放合并窗口占位；空正文按「已处理」记账（重推判 dup）', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent], config: { reply: { mergeWindowMs: 5000 } } }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    await h.runtime.inbound.ingest(privateEvent({ messageId: 'dp1', userId: '1001', text: '还没投' }))
    await h.runtime.inbound.ingest(privateEvent({ messageId: 'dp2', userId: '1001', text: '也没投' }))
    h.runtime.inbound.dispose()
    eq(h.accountState.released.slice().sort(), ['dp1', 'dp2'], 'dispose 应按「未投递」释放窗口占位')
    eq(h.runtime.inbound.merges.size, 0, '窗口应清空')
    eq(agent.steers.length, 0, 'dispose 之后窗口不该再投递')
  })

  const quiet = makeAgent({ id: 'S1' })
  await withHarness({ agents: [quiet], config: { reply: { mergeWindowMs: 0 } } }, async (h) => {
    await h.connect()
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const empty = await h.runtime.inbound.ingest(privateEvent({ messageId: 'em1', userId: '1001', text: '   ' }))
    eq(empty.reason, 'empty', '空正文应被忽略')
    eq(quiet.steers.length, 0, '空正文不该投给 agent')
    const again = await h.runtime.inbound.ingest(privateEvent({ messageId: 'em1', userId: '1001', text: '   ' }))
    eq(again.routed, 'dup', '空正文应按「已处理」记账（重推判 dup）')
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X19 无段空事件（raw 为空）不进缓冲、不投递；空文本可区分      */
/* ══════════════════════════════════════════════════════════ */

await test('X19', '无段空事件（message/raw_message 为空）不进缓冲、不投递；空文本与图片/表情分开处理', async () => {
  const agent = makeAgent({ id: 'S1' })
  await withHarness({ agents: [agent] }, async (h) => {
    await h.connect()
    const base = {
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      self_id: 10001, user_id: '1001',
      sender: { user_id: '1001', nickname: '用户1001' },
      time: Math.floor(Date.now() / 1000),
    }
    // 现场 bug 的形态：message_id=1635464827，message/raw_message 都是空串（无任何可用段）
    const emptyString = await h.runtime.inbound.ingest({
      ...base, message_id: '1635464827', message: '', raw_message: '',
    })
    eq(emptyString.routed, 'ignored', '空事件应被忽略')
    eq(emptyString.reason, 'empty', 'reason 应是 empty')
    eq(emptyString.empty, 'event', '必须标成「无段空事件」，不能当成空文本')
    const emptyArray = await h.runtime.inbound.ingest({
      ...base, message_id: '1635464828', message: [], raw_message: '',
    })
    eq(emptyArray.empty, 'event', 'message=[] 同样是空事件')
    eq(agent.steers.length, 0, '空事件不该投给 agent')
    eq(h.accountState.inboundCalls.length, 0, '空事件不该进 miraAccount.inbound（那正是下游「收到一条空消息」的来源）')
    eq(h.accountState.bindings.length, 0, '空事件不该建出任何绑定/会话')
    const pulledEmpty = JSON.parse(await h.tool('qq_recv_messages').execute({ since: 0 }, {}))
    eq(pulledEmpty.count, 0, '空事件不该进 qq_recv_messages 缓冲')
    eq(h.buildStatus().ignored.empty, 2, '两次空事件都应计入 ignored.empty')
    const lastEmpty = h.buildStatus().lastEmpty
    eq(lastEmpty && lastEmpty.kind, 'empty-event', 'lastEmpty 应标明是无段空事件')
    eq(lastEmpty && lastEmpty.messageId, '1635464828', 'lastEmpty 应保留最后一条的 message_id')
    eq(lastEmpty && lastEmpty.messageType, 'private', 'lastEmpty 应保留 message_type')
    eq(lastEmpty && lastEmpty.segments, [], 'lastEmpty 应保留最后一次段类型（空数组）')

    // 用户真的只发了空白：有消息帧 → 仍进缓冲，字段能把它和「无段空事件」区分开
    const blank = await h.runtime.inbound.ingest(privateEvent({ messageId: 'blank-1', userId: '1001', text: '   ' }))
    eq(blank.reason, 'empty', '空文本仍按空正文忽略')
    eq(blank.empty, 'blank-text', '空文本必须标成 blank-text，不是无段空事件')
    eq(agent.steers.length, 0, '空文本也不该投给 agent')
    eq(h.accountState.inboundCalls.length, 0, '空文本不该走 miraAccount.inbound')
    const pulledBlank = JSON.parse(await h.tool('qq_recv_messages').execute({ since: 0 }, {}))
    eq(pulledBlank.count, 1, '空文本是正常消息，仍应进缓冲')
    eq(pulledBlank.messages[0].raw, '', '空文本的 raw 仍是空串（保持原样）')
    eq(pulledBlank.messages[0].content_kind, 'blank', '缓冲记录应带 content_kind=blank')
    eq(pulledBlank.messages[0].segments, ['text'], '缓冲记录应保留原始段类型')
    eq(h.buildStatus().lastEmpty && h.buildStatus().lastEmpty.kind, 'blank-text', 'lastEmpty 应更新成空文本')
    eq(h.buildStatus().ignored.empty, 3, '空文本也计入 ignored.empty（总计数可见）')

    // 带图片/表情的正常消息不能被空事件修复吞掉
    h.accountApi.bind({ sessionId: 'S1', accountId: 'qq-main', kind: 'user', peerId: '1001' })
    const image = await h.runtime.inbound.ingest({
      ...privateEvent({ messageId: 'img-1', userId: '1001', text: 'x' }),
      message: [{ type: 'image', data: { file: 'a.jpg' } }],
      raw_message: '[CQ:image,file=a.jpg]',
    })
    eq(image.routed, 'taker', '带图片的消息应正常投递')
    eq(agent.steers.length, 1, '图片消息应投给 agent 1 次')
    check(steerText(agent).includes('[图片]'), '图片占位文本应在正文里：' + steerText(agent).slice(-100))
    const face = await h.runtime.inbound.ingest({
      ...privateEvent({ messageId: 'face-1', userId: '1001', text: 'x' }),
      message: [{ type: 'face', data: { id: '178' } }],
      raw_message: '[CQ:face,id=178]',
    })
    eq(face.routed, 'taker', '带表情的消息应正常投递')
    eq(agent.steers.length, 2, '表情消息也应投给 agent')
    check(steerText(agent, 1).includes('[表情'), '表情占位文本应在正文里：' + steerText(agent, 1).slice(-100))
  })
})

/* ══════════════════════════════════════════════════════════ */
/* X20 会话 id：优先 agent.session.id（resume 后 agent.id 可能是旧 id） */
/* ══════════════════════════════════════════════════════════ */

await test('X20', 'qq_send_private_msg：agent.id 是旧 id 时，传给 miraAccount.send 的 sessionId 用 agent.session.id', async () => {
  await withHarness({}, async (h) => {
    await h.connect()
    const result = JSON.parse(await h.tool('qq_send_private_msg').execute(
      { user_id: 2001, message: '在吗' },
      { agent: { id: 'stale-id', session: { id: 'live-id' } } },
    ))
    eq(result.ok, true, '应发送成功：' + JSON.stringify(result))
    eq(h.accountState.sendCalls.length, 1, 'miraAccount.send 应被调用 1 次')
    eq(h.accountState.sendCalls[0].sessionId, 'live-id', '传给 miraAccount.send 的 sessionId 应是活会话的 id')
    const taker = h.accountState.bindings.find((row) => row.peerId === '2001' && row.mode === 'taker')
    eq(taker && taker.sessionId, 'live-id', 'taker 应绑到活会话，而不是 resume 前的旧 id')
    eq(result.binding && result.binding.action, 'created', '应报告 created')

    // 没给 agent.session 时回退 agent.id（旧行为不能丢）
    const fallback = JSON.parse(await h.tool('qq_send_private_msg').execute(
      { user_id: 2002, message: '回退' }, { agent: { id: 'only-id' } },
    ))
    eq(fallback.ok, true, '回退路径也应发送成功：' + JSON.stringify(fallback))
    eq(h.accountState.sendCalls[1].sessionId, 'only-id', '没有 agent.session 时应回退 agent.id')
  })
})

/* ── 收尾 ───────────────────────────────────────────────── */

rmSync(TMP, { recursive: true, force: true })
console.log('通过 ' + passed + ' 项断言')
if (failures.length) {
  for (const failure of failures) console.log('[FAIL] ' + failure)
  console.log('\n==== FAIL（' + failures.length + ' 项失败）====')
  process.exit(1)
}
console.log('\n==== ALL PASS（' + passed + ' 项断言）====')
process.exit(0)

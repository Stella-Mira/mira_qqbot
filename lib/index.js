/**
 * mira_qqbot — DSH 的 QQ 接管插件（OneBot v11 / NapCat）
 *
 * 本轮重构的定位：**协议层插件**。账号池、会话绑定、入站路由、message_id 去重
 * 全部交给 `mira_account`（契约见 mira_account/README.md）；本插件只做协议与编解码，
 * 外加投递语义（steer/queue、忙通告、超时、/stop）与群/白名单策略。
 *
 * 与旧 1.17.0 的关键差别：
 *   · 不再维护 `chatId → sessionId`（旧 `<agentCwd>/data/meta.json` 已删）→ 一律用 mira_account 的绑定表；
 *   · 入站默认 **steer（插话）**，per-peer 可切 queue；不再整条链路 followup；
 *   · 发送工具统一走 `miraAccount.send()`，任意会话发送都会自动登记 taker（反向绑定）；
 *   · 去重走 mira_account 的 seen 表（旧的单槽 lastDedupKey 已删）；
 *   · 配置搬到 `$DSH_HOME/mira_config/mira_qqbot/config.json`（带 schemaVersion），
 *     旧的 profile 配置键继续认，但会被点名（`qq_status.legacyConfigKeys`）；
 *   · 断线积压策略显式化（drop / latest_n=20 / replay），丢多少补多少可见。
 *
 * 装配顺序（createRuntime）：
 *   config → counters → onebot → media → adapter → route → inbound → 注册适配器 → 工具 → start
 * 单实例与热加载在 apply 里：第二个实例 warn + `plugin/instance`；dispose **不写** config.json
 * （约定9 的坑：旧实例用旧状态覆写新手改的文件）。
 *
 * 只依赖 node: 内置能力；宿主能力一律从 ctx 取。
 */

import { claimInstance, fail, makeCounters, nowIso, toError } from './kit.mjs'
import {
  DEFAULTS, configFile, loadConfig, redactText, resolveAccountId,
  privateWhitelistConfigured,
} from './config.js'
import { OneBotClient } from './onebot.js'
import { createMedia } from './media.js'
import { createQqAdapter } from './adapter.js'
import { Router } from './route.js'
import { Inbound } from './inbound.js'
import { registerTools } from './tools.js'

export const name = 'mira_qqbot'

/**
 * 硬依赖（PLAN §3.5 的口径：契约清晰、失败显式）。
 * 少了 mira_account 时本插件不加载、工具全消失 —— 比「起来了但发不出去」好排查；
 * `mira_account_status` 能自证它在跑。
 */
export const inject = ['tools', 'agents', 'workspaceRegistry', 'miraAccount']

const INSTANCE_ID = 'mira_qqbot'

/** 容错取宿主服务：任何服务缺失/未就绪都不该让插件加载崩掉。 */
function serviceOf(ctx, key) {
  try {
    return ctx[key] ?? null
  } catch {
    return null
  }
}

/**
 * 装配一个运行期实例（不做单实例认领、不注册工具、不连接 —— 那些在 apply / start 里）。
 * 自检脚本直接用它，保证与生产走同一条装配路径。
 */
export function createRuntime({
  ctx = {}, config = {}, logger = null, webSocketImpl = null, now = () => Date.now(),
  // 自检用：缩短「等这一轮结束」的轮询/起跑窗口（生产走默认值）
  turn = null,
} = {}) {
  const loaded = loadConfig({ profileConfig: config, logger })
  if (!loaded.ok) {
    return {
      ok: false, error: loaded.error, path: loaded.path, warnings: loaded.warnings,
      legacyConfigKeys: loaded.legacyConfigKeys,
    }
  }
  const cfg = loaded.cfg
  const warnings = [...loaded.warnings]
  // 私聊白名单没显式配置时会沿用熟人名单（兼容旧配置）—— 提醒一次，免得以为两者已经分开了
  if (cfg.reply && !privateWhitelistConfigured(cfg) && (cfg.reply.trustedUsers || []).length > 0) {
    warnings.push('reply.privateWhitelist 未配置：私聊白名单暂时沿用 trustedUsers 的 '
      + (cfg.reply.trustedUsers || []).length + ' 个 id（旧行为）。要分开请显式写 privateWhitelist'
      + '（[] = 谁都能私聊；写了但为空 = 全接受；不写 = 沿用熟人名单）')
  }
  const legacyConfigKeys = loaded.legacyConfigKeys || []
  const path = loaded.path
  // 旧配置键 / 覆盖关系 / 权限问题：逐条 warn（不静默；apply 不再重复打）
  for (const warning of warnings) logger?.warn?.('[mira_qqbot] ' + warning)

  if (cfg.enabled === false) {
    return {
      ok: false,
      disabled: true,
      error: {
        code: 'plugin/disabled',
        message: 'mira_qqbot 被 config.enabled=false 禁用',
        hint: '把 ' + path + ' 里的 enabled 改回 true（或删掉该键）后重载',
      },
      path, warnings, legacyConfigKeys, cfg,
    }
  }

  const counters = makeCounters()
  counters.pluginName = 'mira_qqbot'
  /** 最近一次归一错误（qq_status.lastError 用；永不回显凭据） */
  let lastError = null
  const noteError = (error) => {
    const normalized = toError(error, 'unknown/error')
    lastError = {
      code: normalized.error.code,
      message: redactText(String(normalized.error.message ?? '').slice(0, 300), cfg),
      at: nowIso(now()),
    }
    counters.bump('error.' + lastError.code)
    return lastError
  }

  const account = serviceOf(ctx, 'miraAccount')
  // 契约版本检查：mira_account v2 才有 verdict/recordSeen/releaseSeen（投递成功后才记账）。
  // 旧版只能用 seen()（查+记一步到位）→ 投递失败的消息会被永久丢弃，且这里看不出来。
  if (account && typeof account.version === 'number' && account.version < 2) {
    logger?.warn?.('[mira_qqbot] mira_account 的契约版本是 ' + account.version + '，本插件需要 >= 2：'
      + '去重会退化成"先记账后投递"，投递失败的消息会被永久丢弃（不再重试）。请把 mira_account 一起升级。')
  }
  const agents = serviceOf(ctx, 'agents')
  const workspaces = serviceOf(ctx, 'workspaceRegistry')

  /**
   * 解析账号 id。config.accountId 优先；为空且账号池只有一个 qq 账号时用它（warn 一次）。
   * 有多个 qq 账号时拒绝猜（config/missing + 候选列表）。
   */
  let accountWarningEmitted = false
  const resolveAccount = () => {
    const resolved = resolveAccountId(cfg, account)
    if (resolved.warning && !accountWarningEmitted) {
      accountWarningEmitted = true
      warnings.push(resolved.warning)
      logger?.warn?.('[mira_qqbot] ' + resolved.warning)
    }
    return resolved
  }
  const getAccountId = () => {
    try { return String(resolveAccount().id) } catch { return '' }
  }

  /** 协议层直发（系统提示 / 发送工具共用；发完记 self 防 echo） */
  const sendRaw = (input = {}) => adapter.sendRaw(input.kind, input.peerId, input.text, { actionName: '提示发送' })

  let inbound = null
  const onebot = new OneBotClient({
    getConfig: () => cfg,
    logger,
    webSocketImpl,
    now,
    onEvent: (event) => {
      if (!inbound) return
      inbound.ingest(event).catch((error) => noteError(error))
    },
    onState: (state) => {
      if (state.connected && inbound) {
        // 重连成功：按 backlog.policy 补投断线期间到达的入站
        inbound.onConnected().catch((error) => noteError(error))
        return
      }
      logger?.info?.('[mira_qqbot] OneBot 连接断开（' + (state.reason || 'unknown') + '），入站先进积压队列')
    },
  })

  const media = createMedia({
    getConfig: () => cfg,
    call: (action, params, timeoutMs) => onebot.call(action, params, timeoutMs),
    logger,
  })

  const adapter = createQqAdapter({
    getConfig: () => cfg,
    onebot,
    media,
    agents,
    workspaces,
    account,
    getAccountId,
    logger,
    counters,
    now,
  })

  const route = new Router({
    getConfig: () => cfg,
    logger,
    counters,
    agents,
    account,
    sendRaw,
    noteError: (error) => noteError(error),
    getAccountId,
    now,
    ...(turn || {}),
  })

  inbound = new Inbound({
    getConfig: () => cfg,
    logger,
    counters,
    onebot,
    account,
    route,
    media,
    resolveAccount,
    sendRaw,
    noteError: (error) => noteError(error),
    now,
  })

  // 把平台适配器交给 mira_account（它负责 connectAll / send 的落地）
  let disposeAdapter = null
  if (account && typeof account.registerAdapter === 'function') {
    try {
      disposeAdapter = account.registerAdapter(adapter)
      logger?.info?.('[mira_qqbot] 已向 mira_account 注册平台适配器 qq')
    } catch (error) {
      const normalized = toError(error, 'platform/unsupported')
      noteError(normalized.error)
      logger?.warn?.('[mira_qqbot] 注册适配器失败：' + normalized.error.code + ' ' + normalized.error.message)
    }
  } else {
    logger?.warn?.('[mira_qqbot] ctx.miraAccount 不可用：发送类工具与入站路由都不可用'
      + '（inject 不满足时插件本不会加载；若看到这条，说明宿主把服务撤了）')
  }

  let toolsHandle = null

  /** 只读状态视图（qq_status 的 body；tools.js 负责再抹一遍凭据）。 */
  function buildStatus() {
    const bot = onebot.status()
    const routeStatus = route.status()
    const inboundStatus = inbound.status()

    let accountId = ''
    try { accountId = String(resolveAccount().id) } catch { accountId = String(cfg.accountId ?? '').trim() }

    const bindings = {
      count: 0, taker: 0, observer: 0, accountId: accountId || null, rows: [], truncated: false, error: null,
    }
    if (account && typeof account.bindings === 'function') {
      try {
        const all = account.bindings() || []
        const rows = accountId ? all.filter((row) => !row.accountId || row.accountId === accountId) : all
        bindings.count = rows.length
        bindings.taker = rows.filter((row) => row.mode === 'taker').length
        bindings.observer = rows.filter((row) => row.mode === 'observer').length
        const cap = 50
        bindings.rows = rows.slice(0, cap).map((row) => ({
          sessionId: row.sessionId, kind: row.kind, peerId: row.peerId, mode: row.mode,
        }))
        bindings.truncated = rows.length > cap
      } catch (error) {
        bindings.error = toError(error, 'binding/not-found').error
      }
    }

    return {
      ok: true,
      connected: bot.connected,
      selfId: bot.selfId,
      nickname: bot.nickname,
      wsUrl: bot.wsUrl,
      accountId: accountId || null,
      queueLength: routeStatus.queueLength,
      queues: routeStatus.queues,
      busyByChat: routeStatus.busyByChat,
      inflight: routeStatus.inflight,
      bindings,
      lastError,
      backlog: inboundStatus.backlog,
      ignored: inboundStatus.ignored,
      lastEmpty: inboundStatus.lastEmpty,
      dedup: inboundStatus.dedup,
      merges: inboundStatus.merges,
      bufferedMessages: inboundStatus.bufferedMessages,
      lastSeq: inboundStatus.lastSeq,
      connection: {
        reconnectAttempts: bot.reconnectAttempts,
        retryDelayMs: bot.retryDelayMs,
        lastAliveAgoMs: bot.lastAliveAgoMs,
        connectCount: bot.connectCount,
        lastConnectedAt: bot.lastConnectedAt,
        lastDisconnectedAt: bot.lastDisconnectedAt,
      },
      config: {
        path,
        schemaVersion: cfg.schemaVersion,
        wsUrlConfigured: String(cfg.wsUrl ?? '').trim() !== '',
        // 只报「有没有」，不报值（约定8）
        accessTokenConfigured: String(cfg.accessToken ?? '').trim() !== '',
        accountIdConfigured: String(cfg.accountId ?? '').trim() !== '',
        replyEnabled: cfg.reply.enabled,
        deliveryDefault: cfg.delivery.default,
        backlogPolicy: cfg.backlog.policy,
      },
      counters: counters.snapshot(),
      legacyConfigKeys,
      warnings,
    }
  }

  /** 注册工具（apply 与自检共用）。 */
  function registerToolSet(toolCtx) {
    toolsHandle = registerTools(toolCtx, {
      getConfig: () => cfg,
      onebot,
      media,
      account,
      route,
      inbound,
      adapter,
      resolveAccount,
      buildStatus,
      logger,
      noteError,
    })
    return toolsHandle
  }

  /** 建连（wsUrl 为空只 warn，不猜地址）。 */
  function start() {
    if (String(cfg.wsUrl ?? '').trim() === '') {
      logger?.warn?.('[mira_qqbot] 未配置 wsUrl：不连接 OneBot（工具会返回 config/missing）。'
        + '在 ' + configFile() + ' 里手填 wsUrl —— 本插件不自动探测')
      return { ok: false, error: { code: 'config/missing', message: '必备配置项为空：wsUrl' } }
    }
    const result = onebot.connect()
    logger?.info?.('[mira_qqbot] 启动：OneBot ' + redactText(String(cfg.wsUrl), cfg)
      + '，账号 ' + (String(cfg.accountId ?? '').trim() || '（按账号池里唯一的 qq 账号解析）')
      + '，投递默认 ' + cfg.delivery.default
      + '，积压策略 ' + cfg.backlog.policy + '(latestN=' + cfg.backlog.latestN + ')'
      + '，应答 ' + (cfg.reply.enabled ? '开' : '关')
      + '，群 ' + (cfg.reply.replyToGroup ? '开' : '关')
      + '，白名单 ' + (cfg.reply.trustedUsers.length) + ' 人')
    return result
  }

  /**
   * 退场。**刻意不写 config.json**：配置是手填的权威源，热加载时旧实例写回会用旧状态
   * 覆写新手改（约定9 明确点名的坑）。运行期统计不落盘，重启归零。
   */
  function dispose() {
    try { inbound?.dispose() } catch { /* 退场不抛 */ }
    try { route?.dispose() } catch { /* 退场不抛 */ }
    try { onebot.close() } catch { /* 退场不抛 */ }
    try { disposeAdapter?.() } catch { /* 退场不抛 */ }
    try { toolsHandle?.dispose?.() } catch { /* 退场不抛 */ }
  }

  return {
    ok: true,
    cfg,
    path,
    warnings,
    legacyConfigKeys,
    counters,
    onebot,
    media,
    adapter,
    route,
    inbound,
    noteError,
    buildStatus,
    registerToolSet,
    start,
    dispose,
    getLastError: () => lastError,
  }
}

/** cordis 插件入口。 */
export function apply(ctx, config) {
  const logger = ctx.logger || null
  const runtime = createRuntime({ ctx, config, logger })

  if (!runtime.ok) {
    logger?.warn?.('[mira_qqbot] 不加载：' + runtime.error.code + ' ' + runtime.error.message
      + (runtime.error.hint ? '（' + runtime.error.hint + '）' : ''))
    return fail(runtime.error.code, runtime.error.message, runtime.error.hint)
  }

  // 约定6 单实例：两个实例 = 两条 OneBot 连接 + 两套适配器 = 每条消息处理两遍
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[mira_qqbot] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '重复加载会让 OneBot 连两次、同一条消息投递两遍、适配器重复注册。检查 profile 是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'mira_qqbot 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_qqbot 挂了两遍；一个进程只允许一个实例')
  }

  const toolHandle = runtime.registerToolSet(ctx)
  runtime.start()

  ctx.effect(() => () => {
    // 顺序：先摘工具 → 断连接、放适配器、清内存状态 → 放认领
    try { runtime.dispose() } catch { /* noop */ }
    try { claim.release() } catch { /* noop */ }
  })

  return {
    ok: true,
    path: runtime.path,
    tools: toolHandle.tools.length,
    accountId: String(runtime.cfg.accountId ?? '').trim() || null,
    legacyConfigKeys: runtime.legacyConfigKeys,
  }
}

/** 供自检脚本使用（不是 DSH 接口）。 */
export const __testing = {
  DEFAULTS,
  createRuntime,
  OneBotClient,
  Router,
  Inbound,
  createQqAdapter,
  registerTools,
  configFile,
}

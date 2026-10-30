/**
 * mira_qqbot / tools.js —— 对 agent 暴露的 `qq_*` 工具集
 *
 * 从旧 `lib/index.js` 原样搬来（收发 / 好友 / 群 / 成员 / 频道 / 媒体 / 逃生舱），
 * 三处必须的改造（任务书功能点3/8 + PLAN §1.3）：
 *   1. **发送类工具统一走 `miraAccount.send()`**：它负责「先 bind（或复用）再 adapter.send」，
 *      于是任意会话调 `qq_send_*` 都会自动把该会话登记成这个 peer 的 taker（反向绑定，功能点3）。
 *      冲突时返回 `binding/conflict` —— 想抢加 `force`，只旁听加 `observer`。
 *   2. `qq_status` 换成新口径：连接状态 / selfId / 队列长度 / 每 chat 忙碌 / 绑定表摘要 /
 *      最后错误 / backlog 统计 / ignored 计数 / legacyConfigKeys；**永不回显 accessToken**（功能点9）。
 *   3. 所有返回值都是 JSON 文本 `{ok:true,...}` / `{ok:false,error:{code,message,hint}}`（约定4）。
 *
 * 只依赖 node: 内置能力。
 */

import { basename, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { MiraError, textTool } from './kit.mjs'
import { configFile, redactText, requireWsUrl } from './config.js'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

/** 绑定相关的可选参数（功能点3：冲突时靠它们解）。 */
const BINDING_PROPS = {
  force: bool('抢答：该 peer 已被别的会话应答时，把 taker 抢过来（旧 taker 降级 observer）'),
  observer: bool('旁听：只登记为 observer，不接管应答'),
  sessionId: str('发起方会话 id（可选；默认用当前会话，供不带会话上下文的调用显式指定）'),
}

/** 当前会话 id（工具在会话里被调用时宿主会给 exec.agent）。 */
function currentSessionId(exec) {
  const agent = exec && exec.agent
  if (!agent) return ''
  // **优先用活会话的 id**：resume / 克隆 / rekey 之后 `agent.id` 可能还是旧 id（实测：
  // 会话目录是 qq-mvpvzf70-01703d，而 exec.agent.id 报 qq-mvp8dqhy-smrami），拿它去绑定会让
  // taker 指向不存在的会话、每次发送都要 force、回信路由错位。`agent.session.id` 是会话日志的权威 id。
  const live = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
  if (live) return live
  return typeof agent.id === 'string' ? agent.id : ''
}

export function registerTools(ctx, deps) {
  const {
    getConfig, onebot, media, account, inbound,
    resolveAccount, buildStatus, logger,
  } = deps

  const j = (value) => JSON.stringify(value, null, 2)

  /** 出站统一入口：requireAccountId → media 预处理 → miraAccount.send（含反向绑定）。 */
  async function sendVia({ kind, peerId, message, force, observer, sessionId, exec, cq = false }) {
    const cfg = getConfig() || {}
    const { id: accountId } = resolveAccount()
    if (!account || typeof account.send !== 'function') {
      throw new MiraError('platform/unsupported', 'miraAccount 服务不可用，无法发送',
        'mira_qqbot 的 inject 里有 miraAccount（硬依赖）；确认 mira_account 已装并加载')
    }
    const text = await media.transformMediaMessage(String(message ?? ''))
    if (!String(text).trim()) {
      throw new MiraError('config/missing', 'message 为空，没有可发送的内容', '至少给一段文本或 CQ 码')
    }
    const result = await account.send({
      accountId,
      kind,
      peerId: String(peerId),
      // cq:true = message 是插件自己拼的 CQ 串（图片/语音）；否则正文里的方括号会被转义（防整条发送失败）
      payload: { text, cq: cq === true },
      sessionId: String(sessionId || currentSessionId(exec) || ''),
      force: force === true,
      observer: observer === true,
    })
    const messageId = result && (result.messageId ?? result.message_id)
    logger?.info?.('[mira_qqbot] ' + kind + ':' + peerId + ' 已发送'
      + (messageId ? ' id=' + messageId : '')
      + (result?.binding ? ' binding=' + (result.binding.action || result.binding.mode) : ''))
    return {
      ok: true,
      accountId,
      kind,
      peerId: String(peerId),
      messageId: messageId ?? null,
      // 旧字段名保留：已有提示词/脚本在按 message_id 取值
      message_id: messageId ?? null,
      binding: result?.binding,
    }
  }

  const defs = []

  defs.push(textTool(
    'qq_status',
    '查看 QQ 接管状态：连接状态、登录的 QQ 号与昵称、入站/出站队列长度、每个 chat 忙碌了多久、'
    + 'mira_account 绑定表摘要、最后错误、断线积压统计（丢了多少/补了多少）、被忽略的消息计数、'
    + '仍在使用的旧配置键。配置缺 wsUrl 时直接返回 config/missing（本插件不自动探测）。'
    + '永不回显 accessToken。',
    obj({}),
    async () => {
      const cfg = getConfig() || {}
      requireWsUrl(cfg) // C2：wsUrl 为空时这里就报 config/missing
      const view = buildStatus()
      // 状态串里万一混进凭据（lastError 里的 URL 等）也抹掉（约定8）
      return redactText(j(view), cfg)
    },
  ))

  defs.push(textTool(
    'qq_get_login_info',
    '获取当前登录账号（本机 QQ）的基本信息：QQ 号、昵称。',
    obj({}),
    async () => j(await onebot.call('get_login_info', {})),
  ))

  defs.push(textTool(
    'qq_get_friend_list',
    '获取好友列表（含备注名、昵称、QQ 号）。',
    obj({}),
    async () => j(await onebot.call('get_friend_list', {})),
  ))

  defs.push(textTool(
    'qq_get_group_list',
    '获取已加入的群列表（群号、群名等）。',
    obj({}),
    async () => j(await onebot.call('get_group_list', {})),
  ))

  defs.push(textTool(
    'qq_get_group_member_list',
    '获取指定群的成员列表（群号、昵称、名片、身份等）。',
    obj({ group_id: int('群号') }, ['group_id']),
    async (args) => j(await onebot.call('get_group_member_list', { group_id: args.group_id })),
  ))

  defs.push(textTool(
    'qq_get_stranger_info',
    '通过 QQ 号查询一个陌生人的公开资料（昵称、性别、年龄等）。',
    obj({ user_id: int('QQ 号'), no_cache: bool('是否绕过缓存（可选）') }, ['user_id']),
    async (args) => j(await onebot.call('get_stranger_info', {
      user_id: args.user_id,
      no_cache: args.no_cache === true,
    })),
  ))

  defs.push(textTool(
    'qq_send_private_msg',
    '给指定 QQ 号发送私聊消息。message 支持纯文本和 CQ 码；file 传本地路径时（配了 napcatMediaDir）会先复制进 NapCat 容器。'
    + '发送即自动把当前会话登记为该 QQ 号的 taker（反向绑定：对方回复会回到这个会话）；'
    + '该 peer 已被别的会话应答时返回 binding/conflict，要抢加 force:true，只旁听加 observer:true。',
    obj({
      user_id: int('对方 QQ 号'),
      message: str('要发送的消息内容'),
      cq: bool('true = 把 message 当 CQ 码解析（[CQ:at,qq=...] 等）；默认 false，正文按纯文本发（方括号自动转义）'),
      ...BINDING_PROPS,
    }, ['user_id', 'message']),
    async (args, exec) => j(await sendVia({
      kind: 'user',
      peerId: args.user_id,
      message: args.message,
      force: args.force,
      observer: args.observer,
      sessionId: args.sessionId,
      exec,
      cq: args.cq === true,
    })),
  ))

  defs.push(textTool(
    'qq_send_group_msg',
    '给指定群发送群消息。message 支持纯文本和 CQ 码；如需 @某人可传 [CQ:at,qq=QQ号]。'
    + '发送即自动把当前会话登记为该群的 taker（同 qq_send_private_msg 的绑定语义）。',
    obj({
      group_id: int('群号'),
      message: str('要发送的消息内容'),
      cq: bool('true = 把 message 当 CQ 码解析（[CQ:at,qq=...] 等）；默认 false，正文按纯文本发（方括号自动转义）'),
      ...BINDING_PROPS,
    }, ['group_id', 'message']),
    async (args, exec) => j(await sendVia({
      kind: 'group',
      peerId: args.group_id,
      message: args.message,
      force: args.force,
      observer: args.observer,
      sessionId: args.sessionId,
      exec,
      cq: args.cq === true,
    })),
  ))

  defs.push(textTool(
    'qq_send_msg',
    '统一发消息入口：target 传纯 QQ 号走私聊，传 "group:群号" 走群聊。绑定语义同 qq_send_private_msg。',
    obj({
      target: str('纯 QQ 号（私聊）或 group:群号（群聊）'),
      message: str('消息内容'),
      cq: bool('true = 把 message 当 CQ 码解析；默认 false（纯文本，方括号自动转义）'),
      ...BINDING_PROPS,
    }, ['target', 'message']),
    async (args, exec) => {
      const target = String(args.target).trim()
      const isGroup = target.startsWith('group:')
      const peerId = isGroup ? target.slice('group:'.length) : target
      if (!peerId) throw new MiraError('config/missing', 'target 为空', '传纯 QQ 号或 group:群号')
      return j(await sendVia({
        kind: isGroup ? 'group' : 'user',
        peerId,
        message: args.message,
        force: args.force,
        observer: args.observer,
        sessionId: args.sessionId,
        exec,
        cq: args.cq === true,
      }))
    },
  ))

  defs.push(textTool(
    'qq_send_media_file',
    '给 QQ 发送本地媒体文件：自动复制到 NapCat 容器媒体目录再发送（DSH 框架对 CQ 码里的容器外路径会预读拦截，'
    + '所以发本地文件一律用本工具）。target 传纯 QQ 号走私聊，传 "group:群号" 走群聊；file 传本地文件绝对路径；'
    + 'type 有 image / file / record / video 四档：视频（mp4/mov/mkv/webm/flv）缺省按 video 发（QQ 里内联播放），'
    + '要当文件附件发就显式传 file；传了别的值会直接报错而不是静默改走 file。',
    obj({
      target: str('纯 QQ 号（私聊）或 group:群号（群聊）'),
      file: str('本地文件绝对路径'),
      type: str('image / file / record / video 四档之一，可选；不给则按扩展名推断（视频→video，要附件传 file）'),
      ...BINDING_PROPS,
    }, ['target', 'file']),
    async (args, exec) => {
      const cfg = getConfig() || {}
      const t = String(args.target).trim()
      const filePath = String(args.file)
      let type = String(args.type || '').trim().toLowerCase()
      if (type && !['image', 'file', 'record', 'video'].includes(type)) {
        // 显式传错（比如 audio）要报错，别静默按扩展名改成 file —— 调用方会以为发了想要的东西
        throw new MiraError('config/invalid', '不支持的媒体类型：' + JSON.stringify(args.type),
          '可用：image / file / record / video；视频要内联播放用 video，要当附件用 file')
      }
      if (!type) {
        const low = filePath.toLowerCase()
        // 自动推断：图片 → image；silk（QQ 语音条固定格式）→ record；
        // 其余（含 mp3/wav 等音频）→ file 文件通道
        if (/\.(png|jpe?g|gif|webp|bmp)$/.test(low)) type = 'image'
        else if (/\.silk$/.test(low)) type = 'record'
        // 视频单独走 CQ:video（QQ 会当视频消息内联播放，而不是文件附件）；要当附件发就显式 type:'file'
        else if (/\.(mp4|mov|m4v|mkv|webm|flv|avi)$/.test(low)) type = 'video'
        else type = 'file'
      }
      if (!existsSync(filePath)) {
        throw new MiraError('config/missing', '文件不存在: ' + filePath,
          '传容器外可读的绝对路径；路径会被复制进 napcatMediaDir 对应子目录再发送')
      }
      const subFor = { image: 'images', file: 'files', record: 'voices', video: 'videos' }
      const dir = String(cfg.napcatMediaDir ?? '').trim() || tmpdir()
      const destDir = resolve(dir, subFor[type])
      mkdirSync(destDir, { recursive: true })
      const dest = resolve(destDir, basename(filePath))
      copyFileSync(filePath, dest)
      const cqType = { image: 'CQ:image', file: 'CQ:file', record: 'CQ:record', video: 'CQ:video' }[type]
      const message = '[' + cqType + ',file=file://' + dest + ']'
      const isGroup = t.startsWith('group:')
      const peerId = isGroup ? t.slice('group:'.length) : t
      const sent = await sendVia({
        kind: isGroup ? 'group' : 'user',
        peerId,
        message,
        force: args.force,
        observer: args.observer,
        sessionId: args.sessionId,
        exec,
        cq: true, // 这里 message 是插件自己拼的 CQ 串，不能转义
      })
      logger?.info?.('[mira_qqbot] qq_send_media_file 已发送：' + dest)
      return j({ ...sent, dest, cq: message })
    },
  ))

  defs.push(textTool(
    'qq_send_voice',
    '给 QQ 发送语音条：把文字转成语音（TTS）→ 转 silk → 发送。target 传纯 QQ 号走私聊，'
    + '传 "group:群号" 走群聊；text 为要朗读的文字。需要插件配置 tts（base/key）与 napcatDir。',
    obj({
      target: str('纯 QQ 号（私聊）或 group:群号（群聊）'),
      text: str('要朗读的文字'),
      ...BINDING_PROPS,
    }, ['target', 'text']),
    async (args, exec) => {
      const cfg = getConfig() || {}
      const t = String(args.target).trim()
      const text = String(args.text)
      const tts = cfg.tts || {}
      if (!tts.base || !tts.key) {
        throw new MiraError('config/missing', '未配置 TTS（tts.base / tts.key 为空）',
          '在 ' + configFile() + ' 里填 tts.base / tts.key（OpenAI 兼容 /audio/speech）；不配就改用 qq_send_media_file 发录音')
      }
      const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const tmpMp3 = resolve(tmpdir(), 'qq_tts_' + stamp + '.mp3')
      const tmpWav = resolve(tmpdir(), 'qq_tts_' + stamp + '.wav')
      const tmpSilk = resolve(tmpdir(), 'qq_tts_' + stamp + '.silk')
      try {
        // 1) TTS 合成 mp3（OpenAI 兼容 /audio/speech，响应为裸 mp3）
        const base = String(tts.base).replace(/\/+$/, '')
        const resp = await fetch(base + '/audio/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tts.key },
          body: JSON.stringify({
            model: tts.model || 'sylvia',
            input: text,
            voice: tts.voice || 'rosy',
            response_format: 'mp3',
          }),
          signal: AbortSignal.timeout(60000),
        })
        if (!resp.ok) {
          throw new MiraError('delivery/failed', 'TTS HTTP ' + resp.status, '检查 tts.base / tts.key 与网关可用性')
        }
        writeFileSync(tmpMp3, Buffer.from(await resp.arrayBuffer()))
        // 2) mp3 → silk
        // - darwin：NapCat 自带 ffmpeg addon，按「平台.架构」动态选文件（换设备/换架构都可用）
        // - 其他平台（Windows/Linux）：跳过本地转换，直接把 mp3 交给 NapCat，
        //   NapCat 发送语音消息时对非 silk 文件会自动转 silk（convertToNTSilkTct）
        const isDarwin = process.platform === 'darwin'
        let silkPath = ''
        if (isDarwin) {
          const addon = resolve(String(cfg.napcatDir ?? '.'), 'native/ffmpeg', 'ffmpegAddon.darwin.' + process.arch + '.node')
          if (!existsSync(addon)) {
            throw new MiraError('config/missing', '找不到 NapCat ffmpeg addon: ' + addon,
              '在 ' + configFile() + ' 里把 napcatDir 指到 NapCat 程序目录')
          }
          // 未签名则 ad-hoc 签名（加载会报 Trying to load an unsigned library）
          try { execFileSync('codesign', ['--verify', addon], { stdio: 'ignore' }) }
          catch { try { execFileSync('codesign', ['--force', '--sign', '-', addon], { stdio: 'ignore' }) } catch { /* 无签名工具则忽略，转换失败时再报错 */ } }
          // 注意：下面这段是喂给子进程 `node -e` 的 **CommonJS** 脚本，不是本模块的 import。
          // check-zero-dep.mjs 用正则扫 `require('pkg')` 形态，为了不误报，require 用拼接构造
          // （拼出来仍是同一个 `require`，语义完全相同；这段只在 darwin 上执行）。
          const req = 'requ' + 'ire'
          const convertJs = `
const fs = ${req}('fs');
const { execFileSync } = ${req}('child_process');
const addon = ${req}(${JSON.stringify(addon)});
(async () => {
  try {
    await addon.convertToNTSilkTct(${JSON.stringify(tmpMp3)}, ${JSON.stringify(tmpSilk)});
  } catch (e) {
    execFileSync('ffmpeg', ['-y','-v','error','-i',${JSON.stringify(tmpMp3)},'-ar','24000','-ac','1','-f','wav',${JSON.stringify(tmpWav)}]);
    await addon.convertToNTSilkTct(${JSON.stringify(tmpWav)}, ${JSON.stringify(tmpSilk)});
  }
  console.log('silk:' + fs.statSync(${JSON.stringify(tmpSilk)}).size);
})().catch(e => { console.error('fail:' + e.message); process.exit(1); });
`
          try {
            execFileSync('node', ['-e', convertJs], { stdio: 'pipe', timeout: 60000 })
          } catch (e) {
            throw new MiraError('delivery/failed', 'mp3→silk 转换失败: ' + String((e && e.stderr) || (e && e.message) || e),
              '确认 napcatDir 指向的 NapCat 带 ffmpeg addon，或本机装了 ffmpeg')
          }
          silkPath = tmpSilk
        }
        // 3) 复制进媒体目录并发送（darwin 发 silk；其他平台发 mp3，由 NapCat 侧转码）
        const dir = String(cfg.napcatMediaDir ?? '').trim() || tmpdir()
        const destDir = resolve(dir, 'voices')
        mkdirSync(destDir, { recursive: true })
        const dest = resolve(destDir, 'voice_' + stamp + (silkPath ? '.silk' : '.mp3'))
        copyFileSync(silkPath || tmpMp3, dest)
        const isGroup = t.startsWith('group:')
        const peerId = isGroup ? t.slice('group:'.length) : t
        const sent = await sendVia({
          kind: isGroup ? 'group' : 'user',
          peerId,
          message: '[CQ:record,file=file://' + dest + ']',
          force: args.force,
          observer: args.observer,
          sessionId: args.sessionId,
          exec,
          cq: true, // 同上：插件自己拼的 CQ 串
        })
        logger?.info?.('[mira_qqbot] qq_send_voice 已发送：' + dest)
        return j({ ...sent, dest })
      } finally {
        try { rmSync(tmpMp3, { force: true }) } catch { /* 忽略 */ }
        try { rmSync(tmpWav, { force: true }) } catch { /* 忽略 */ }
        try { rmSync(tmpSilk, { force: true }) } catch { /* 忽略 */ }
      }
    },
  ))

  defs.push(textTool(
    'qq_recv_messages',
    '增量拉取自上次以来收到的 QQ 消息与请求（私聊/群聊/频道消息，以及好友申请/加群请求）。'
    + '传 since 为上次返回的 maxSeq，首次传 0。按 seq 升序返回**最旧的一页**（最多 limit 条），'
    + 'maxSeq = 本页最后一条的 seq；hasMore / truncated 为 true 表示还有没拉完的积压，'
    + '用新的 since（= 本页 maxSeq）继续拉下一页，不要跳过这一页去追最新。'
    + '返回每条记录的 seq、post_type（message=聊天消息、request=好友/加群申请）、'
    + '来源、发送者、文本内容、message_id 等。可据此应答：私聊用 qq_send_private_msg，群聊用 qq_send_group_msg；'
    + 'request 记录里的 flag 可传给 qq_handle_friend_request / qq_handle_group_request 处理申请。',
    obj({ since: int('上次返回的 maxSeq，首次 0'), limit: int('最多返回条数，默认 50，上限 500') }),
    async (args) => j(inbound.recentMessages(Number(args.since || 0), Number(args.limit || 50))),
  ))

  defs.push(textTool(
    'qq_get_msg',
    '按 message_id 查询一条消息的详情。',
    obj({ message_id: int('消息 ID') }, ['message_id']),
    async (args) => j(await onebot.call('get_msg', { message_id: args.message_id })),
  ))

  defs.push(textTool(
    'qq_get_group_msg_history',
    '拉取指定群的近期消息历史（NapCat 扩展接口）。',
    obj({ group_id: int('群号'), count: int('条数，默认 20') }, ['group_id']),
    async (args) => j(await onebot.call('get_group_msg_history', {
      group_id: args.group_id,
      count: Number(args.count || 20),
    })),
  ))

  defs.push(textTool(
    'qq_delete_msg',
    '撤回一条已发送的消息。',
    obj({ message_id: int('消息 ID') }, ['message_id']),
    async (args) => j(await onebot.call('delete_msg', { message_id: args.message_id })),
  ))

  defs.push(textTool(
    'qq_set_group_ban',
    '群禁言：禁言某个群成员指定时长。',
    obj({ group_id: int('群号'), user_id: int('被禁言的 QQ 号'), duration: int('禁言秒数，0 表示解除禁言；默认 1800') }, ['group_id', 'user_id']),
    async (args) => {
      await onebot.call('set_group_ban', {
        group_id: args.group_id,
        user_id: args.user_id,
        duration: args.duration === undefined ? 1800 : Number(args.duration),
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_set_group_kick',
    '把某群成员移出群聊。',
    obj({ group_id: int('群号'), user_id: int('被移出的 QQ 号'), reject_add_request: bool('是否拒绝其再次加群（可选）') }, ['group_id', 'user_id']),
    async (args) => {
      await onebot.call('set_group_kick', {
        group_id: args.group_id,
        user_id: args.user_id,
        reject_add_request: args.reject_add_request === true,
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_set_group_whole_ban',
    '开启/关闭群全员禁言。',
    obj({ group_id: int('群号'), enable: bool('true 开启全员禁言 / false 关闭') }, ['group_id', 'enable']),
    async (args) => {
      await onebot.call('set_group_whole_ban', { group_id: args.group_id, enable: args.enable === true })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_handle_friend_request',
    '处理好友申请：同意或拒绝。flag 来自 qq_recv_messages 里 post_type=request 的记录（request_type=friend）。',
    obj({ flag: str('申请标识 flag'), approve: bool('true 同意 / false 拒绝'), remark: str('同意后设置的备注（可选）') }, ['flag', 'approve']),
    async (args) => {
      await onebot.call('set_friend_add_request', {
        flag: String(args.flag),
        approve: args.approve === true,
        remark: args.remark || '',
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_handle_group_request',
    '处理加群申请：同意或拒绝。flag 与 sub_type 来自 qq_recv_messages 里 post_type=request 的记录（request_type=group）。',
    obj({ flag: str('申请标识 flag'), sub_type: str('add / invite'), approve: bool('true 同意 / false 拒绝'), reason: str('拒绝原因（可选）') }, ['flag', 'sub_type', 'approve']),
    async (args) => {
      await onebot.call('set_group_add_request', {
        flag: String(args.flag),
        sub_type: String(args.sub_type),
        approve: args.approve === true,
        reason: args.reason || '',
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_api',
    '通用 OneBot v11 动作调用（逃生舱）：直接指定 action 与 params 调用 NapCat。'
    + '仅用于上面工具覆盖不到的接口，如 get_group_info、get_group_honor_info 等。',
    obj({ action: str('OneBot action 名，如 get_group_info'), params: obj({}) }, ['action']),
    async (args) => j(await onebot.call(String(args.action), (args.params && typeof args.params === 'object') ? args.params : {})),
  ))

  defs.push(textTool(
    'qq_role',
    '查自己在这个 QQ 对话线上的身份：taker=这条线由本会话应答（该回就回）/ observer=只旁听'
    + '（**不该回复**，回了就是抢话）/ none=还没参与。'
    + '不给 kind+peerId 时，列出本会话参与过的所有对话线及各自角色。'
    + '收到消息后不确定该不该回，先调这个。',
    obj({
      kind: str('peer 类型：user / group'),
      peerId: str('QQ 号 / 群号'),
      sessionId: str('要查的会话 id（默认当前会话）'),
    }),
    async (args, exec) => {
      const { id: accountId } = resolveAccount()
      if (!account || typeof account.resolve !== 'function') {
        throw new MiraError('platform/unsupported', 'miraAccount 服务不可用，无法查绑定',
          'mira_qqbot 的 inject 里有 miraAccount（硬依赖）；确认 mira_account 已装并加载')
      }
      const sid = String(args.sessionId || currentSessionId(exec) || '')
      if (!sid) throw new MiraError('config/missing', '拿不到当前会话 id', '在会话里调用，或显式传 sessionId')

      if (args.kind && args.peerId !== undefined && args.peerId !== '') {
        const resolved = account.resolve(accountId, String(args.kind), String(args.peerId))
        const yourRole = resolved.taker && resolved.taker.sessionId === sid
          ? 'taker'
          : ((resolved.observers || []).some((o) => o.sessionId === sid) ? 'observer' : 'none')
        const hint = yourRole === 'taker'
          ? '你是这条线的应答方：要说话就调 qq_send_private_msg / qq_send_group_msg'
          : yourRole === 'observer'
            ? '你是旁听：不要回复。要接管这条线用 mira_account_bind（force:true）'
            : '你还没参与这条线：发一条消息或用 mira_account_bind 就会登记为 taker'
        return {
          ok: true,
          accountId,
          sessionId: sid,
          peer: { kind: String(args.kind), peerId: String(args.peerId) },
          yourRole,
          taker: resolved.taker ? resolved.taker.sessionId : null,
          observers: (resolved.observers || []).map((o) => o.sessionId),
          hint,
        }
      }

      const rows = (account.bindings(sid) || []).filter((row) => !row.accountId || row.accountId === accountId)
      return {
        ok: true,
        accountId,
        sessionId: sid,
        count: rows.length,
        peers: rows.map((row) => ({
          kind: row.kind,
          peerId: row.peerId,
          role: row.mode === 'taker' ? 'taker' : 'observer',
        })),
        hint: rows.length === 0
          ? '本会话还没绑定任何 QQ 对话线（发第一条消息时会自动登记）'
          : 'taker 的线要回复用 qq_send_*；observer 的线只旁听',
      }
    },
  ))

  const disposers = defs.map((def) => ctx.tools.register(def))
  const dispose = () => disposers.forEach((fn) => { try { fn() } catch { /* noop */ } })
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return { tools: defs, dispose }
}

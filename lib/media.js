/**
 * mira_qqbot / media.js —— 消息文本提取 + CQ 媒体 + 转发消息 + 附件下载
 *
 * 从旧 `lib/index.js` 原样搬来（提取文本、转发递归、CQ 媒体复制进 NapCat 容器、
 * 附件落盘 / 语音转 wav / 市场表情 CDN 兜底），只把「模块级全局变量」换成工厂注入：
 * `call`（OneBot 动作调用）、`getConfig`、`logger`。
 *
 * 落盘位置变化（任务书约定1）：附件从 `<agentCwd>/data/files` 改到
 * `$DSH_HOME/mira_config/mira_qqbot/files`（`mediaDir` 配置可覆盖）。
 * 旧 `meta.json` 那套映射已删（会话映射交给 mira_account 的绑定表）。
 *
 * 只依赖 node: 内置能力（fetch / fs / path）。
 */

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureDir } from './kit.mjs'
import { mediaDir as defaultMediaDir } from './config.js'

export function createMedia({ getConfig, call, logger = null }) {
  function cfg() {
    return getConfig() || {}
  }

  /** 附件保存目录：配置 mediaDir > `$DSH_HOME/mira_config/mira_qqbot/files`。 */
  function resolveMediaDir() {
    const configured = String(cfg().mediaDir ?? '').trim()
    return configured ? resolve(configured) : defaultMediaDir()
  }

  /* ── 文本提取 ─────────────────────────────────────────── */

  /** 把一条事件的 message 段转成纯文本（图片/表情/语音等转成 [图片]/[表情] 标记）。 */
  function extractText(event) {
    // 优先解析 message 数组；raw_message 对非文本段是完整 CQ 码原串（含超长 url），只作兜底，
    // 否则会把 CQ 码噪音灌给 agent
    if (Array.isArray(event?.message)) {
      let out = ''
      for (const seg of event.message) {
        if (seg && seg.type === 'text') out += (seg.data && seg.data.text) || ''
        else if (seg && seg.type === 'at') out += seg.data && seg.data.qq === 'all' ? '@全体成员 ' : '@' + ((seg.data && seg.data.qq) || '') + ' '
        else if (seg && seg.type === 'image') out += '[图片]'
        else if (seg && seg.type === 'face') out += '[表情' + (seg.data && seg.data.id ? ':id=' + seg.data.id : '') + ']'
        else if (seg && seg.type === 'record') out += '[语音]'
        else if (seg && seg.type === 'video') out += '[视频]'
        else if (seg && seg.type === 'file') out += '[文件]'
        else if (seg) out += '[CQ:' + seg.type + ']'
      }
      return out.trim()
    }
    if (typeof event?.message === 'string' && event.message.length) return event.message
    if (typeof event?.raw_message === 'string' && event.raw_message.length) return event.raw_message
    return ''
  }

  // 取转发消息体：优先用已内嵌的 content，否则调 get_forward_msg
  async function fetchForwardMessages(seg) {
    let msgs = Array.isArray(seg.data.content) ? seg.data.content : null
    if ((!msgs || msgs.length === 0) && seg.data.id) {
      try {
        const r = await call('get_forward_msg', { id: String(seg.data.id) })
        msgs = (r && Array.isArray(r.messages)) ? r.messages : []
      } catch {
        msgs = []
      }
    }
    return msgs || []
  }

  // 递归提取单条消息的文本（含嵌套转发），depth 防止无限递归
  async function extractMessageTextRecursive(m, depth) {
    const segs = Array.isArray(m.message) ? m.message : []
    let out = ''
    for (const seg of segs) {
      if (!seg || typeof seg !== 'object') continue
      if (seg.type === 'text') out += (seg.data && seg.data.text) || ''
      else if (seg.type === 'at') out += seg.data && seg.data.qq === 'all' ? '@全体成员 ' : '@' + ((seg.data && seg.data.qq) || '') + ' '
      else if (seg.type === 'image') out += '[图片]'
      else if (seg.type === 'face') out += '[表情' + (seg.data && seg.data.id ? ':id=' + seg.data.id : '') + ']'
      else if (seg.type === 'record') out += '[语音]'
      else if (seg.type === 'video') out += '[视频]'
      else if (seg.type === 'file') out += '[文件' + ((seg.data && seg.data.file) ? '：' + seg.data.file : '') + ']'
      else if (seg.type === 'forward' && seg.data) {
        // 嵌套转发：优先用响应里已内嵌的 content，否则才调 get_forward_msg
        if (depth >= 3) {
          out += '[转发消息（嵌套过深，已省略）]'
        } else {
          const msgs = await fetchForwardMessages(seg)
          if (!msgs.length) {
            out += '[转发内容获取失败]'
          } else {
            const inner = []
            for (const im of msgs) {
              const nick = (im.sender && (im.sender.card || im.sender.nickname)) || String(im.user_id || '')
              const txt = await extractMessageTextRecursive(im, depth + 1)
              inner.push((nick ? nick + '：' : '') + txt)
            }
            out += '[转发消息]\n' + inner.join('\n')
          }
        }
      } else if (seg) {
        out += '[CQ:' + seg.type + ']'
      }
    }
    return out.trim()
  }

  // 转发消息（CQ:forward）：递归提取内容（含嵌套转发），返回多行文本
  async function extractForwardContent(data) {
    const segs = Array.isArray(data?.message) ? data.message : []
    const parts = []
    for (const seg of segs) {
      if (seg && seg.type === 'forward' && seg.data) {
        try {
          const msgs = await fetchForwardMessages(seg)
          for (const m of msgs) {
            const nick = (m.sender && (m.sender.card || m.sender.nickname)) || String(m.user_id || '')
            const txt = await extractMessageTextRecursive(m, 0)
            parts.push((nick ? nick + '：' : '') + txt)
          }
        } catch (e) {
          parts.push('[转发内容获取失败：' + (e && e.message ? e.message : String(e)) + ']')
        }
      }
    }
    return parts.join('\n')
  }

  /* ── 发送前媒体处理 ───────────────────────────────────── */

  // DSH 工具层只允许读取 QQ 容器内真实路径，且 QQ 沙盒进程也只能读容器内，
  // 因此把 [CQ:image/file/record] 里 file= 指向的容器外本地文件复制进
  // napcatMediaDir/{images,files,voices}，并把 file= 换成 file://容器内路径。
  // 已为 file://、http(s)://、base64:// 的不做处理（原样透传）。
  // napcatMediaDir 为空 = 不启用这一步（Linux 上直接透传绝对路径）。
  async function transformMediaMessage(message) {
    const dir = String(cfg().napcatMediaDir ?? '').trim()
    if (!dir) return message
    const subFor = { image: 'images', file: 'files', record: 'voices', video: 'videos' }
    return String(message).replace(/\[CQ:(image|file|record|video),([^\]]*)\]/g, (m0, type, attrs) => {
      // 音频文件误用 CQ:record 会被 QQ 客户端识别成语音条；
      // 只有 .silk / .amr（语音条格式）才走 record，其余音频一律改走 file 通道
      const fm = attrs.match(/file=([^,\]]+)/)
      const fileRaw = fm ? fm[1] : ''
      if (type === 'record' && fm && !/\.(silk|amr)$/i.test(fileRaw)) {
        const subDir = resolve(dir, 'files')
        try {
          mkdirSync(subDir, { recursive: true })
          const dest = resolve(subDir, basename(fileRaw))
          if (existsSync(fileRaw)) {
            copyFileSync(fileRaw, dest)
            return '[CQ:file,' + attrs.replace(/file=([^,\]]+)/, 'file=file://' + dest) + ']'
          }
        } catch (e) {
          logger?.warn?.('[mira_qqbot] record 改 file 复制失败（原样发送）：' + (e && e.message ? e.message : String(e)))
        }
        return m0
      }
      if (!fm) return m0
      const file = fm[1]
      if (file.startsWith('file://') || /^https?:\/\//i.test(file) || file.startsWith('base64://')) return m0
      if (!file.startsWith('/') || !existsSync(file)) return m0
      const destDir = resolve(dir, subFor[type] || 'files')
      try {
        mkdirSync(destDir, { recursive: true })
        const dest = resolve(destDir, basename(file))
        copyFileSync(file, dest)
        logger?.info?.('[mira_qqbot] 媒体已自动复制进容器：' + dest)
        return '[CQ:' + type + ',' + attrs.replace(/file=([^,\]]+)/, 'file=file://' + dest) + ']'
      } catch (e) {
        logger?.warn?.('[mira_qqbot] 复制媒体失败（原样发送）：' + (e && e.message ? e.message : String(e)))
        return m0
      }
    })
  }

  /* ── 下载保存 ─────────────────────────────────────────── */

  async function downloadTo(url, destPath) {
    const cleanUrl = String(url).replace(/&amp;/g, '&')
    const resp = await fetch(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Referer: 'https://www.qq.com/',
      },
      // 防止卡死的下载挂起整条消息处理
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const buf = Buffer.from(await resp.arrayBuffer())
    mkdirSync(resolve(destPath, '..'), { recursive: true })
    writeFileSync(destPath, buf)
  }

  // 文件名清洗：消息里的文件名不可信（可含 ../ 或绝对路径），
  // 直接 resolve 会逃逸保存目录；统一替换分隔符与连续点
  function safeName(name, fallback) {
    const s = String(name || fallback || 'file')
      .replace(/[\\/]+/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/[\x00-\x1f]/g, '_')
      .slice(0, 120)
    return s || String(fallback || 'file')
  }

  // 媒体语义分类：按段类型 + 文件扩展名细分，告知 agent 时更准确
  function kindFor(seg) {
    const type = seg.type
    if (type === 'record') return '语音'
    if (type === 'image') return '图片'
    if (type === 'video') return '视频'
    const name = String((seg.data && (seg.data.file || seg.data.file_name || seg.data.path)) || '').toLowerCase()
    if (/\.(mp3|wav|flac|m4a|aac|ogg|opus|amr|silk)$/.test(name)) return '音频文件'
    if (/\.(mp4|mov|mkv|avi|webm|flv|wmv)$/.test(name)) return '视频文件'
    return '其他文件'
  }

  // 语音统一存为 wav：QQ 语音实为 SILK 编码，由 NapCat get_record 转码后落盘
  function voiceName(file) {
    const base = String(file || '').replace(/\.(amr|silk|wav|mp3)$/i, '') || 'voice'
    return safeName(base + '.wav', 'record_' + Date.now().toString(36) + '.wav')
  }

  // 递归收集消息里所有媒体段（含嵌套转发内嵌的），返回扁平 segments 数组
  async function collectMediaSegments(data) {
    const segs = Array.isArray(data?.message) ? data.message : []
    const media = []
    const seen = new Set()
    async function walk(segments, depth) {
      for (const seg of segments) {
        if (!seg || typeof seg !== 'object') continue
        if (seg.type === 'image' || seg.type === 'file' || seg.type === 'record' || seg.type === 'video') {
          const key = seg.type + '|' + ((seg.data && (seg.data.file || seg.data.file_id || seg.data.url)) || '')
          if (!seen.has(key)) {
            seen.add(key)
            media.push(seg)
          }
        } else if (seg.type === 'forward' && seg.data) {
          if (depth >= 3) continue
          const msgs = await fetchForwardMessages(seg)
          for (const m of msgs) {
            if (Array.isArray(m.message)) await walk(m.message, depth + 1)
          }
        }
      }
    }
    await walk(segs, 0)
    return media
  }

  // 下载保存一组媒体段，返回 { saved: [{kind, path}], failed: [描述] }
  // 统一策略（按优先级）：本地缓存路径复制 > NapCat 接口拉取（语音统一转 wav）> http 链接下载
  async function saveMediaSegments(segs) {
    const saved = []
    const failed = []
    const dir = resolveMediaDir()
    const stamp = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)

    // NapCat 接口拉取：优先返回的本地 file 路径，其次 base64，最后 http url
    async function apiSave(action, params, destName) {
      let r
      try {
        // 大文件下载慢（NapCat 限速 downloadSpeedKBps），给足超时
        const t = action === 'get_file' ? 180000 : 20000
        r = await call(action, params, t)
      } catch {
        // 接口报错（如表情包 get_image 报 file not found）不中断整体保存，
        // 返回 null 让调用方继续走 http url 兜底下载
        return null
      }
      const dest = resolve(dir, destName)
      if (r && typeof r.file === 'string') {
        mkdirSync(dir, { recursive: true })
        // NapCat 返回路径时文件可能还在后台下载（异步写入），
        // 轮询等待文件存在且大小稳定后再复制；等不到则走兜底
        try {
          const src = r.file
          let size = -1
          let stable = 0
          for (let i = 0; i < 60; i++) {
            try {
              const st = statSync(src)
              if (st.size > 0 && st.size === size) {
                stable++
                if (stable >= 2) { copyFileSync(src, dest); return dest }
              } else {
                stable = 0
                size = st.size
              }
            } catch { stable = 0; size = -1 }
            await new Promise((res) => setTimeout(res, 500))
          }
        } catch { /* 等待超时，继续兜底 */ }
        return null
      }
      if (r && typeof r.base64 === 'string') {
        mkdirSync(dir, { recursive: true })
        writeFileSync(dest, Buffer.from(r.base64, 'base64'))
        return dest
      }
      if (r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url)) {
        await downloadTo(r.url, dest)
        return dest
      }
      return null
    }

    async function saveOne(seg) {
      const type = seg.type
      const kind = kindFor(seg)
      const data = seg.data || {}
      const file = data.file
      const fileId = data.file_id
      const url = data.url
      const path = data.path
      try {
        // 1) 本地缓存路径（NapCat 通常已把媒体缓存到本地，最可靠）
        if (typeof path === 'string' && path) {
          try {
            if (existsSync(path)) {
              const name = type === 'record'
                ? voiceName(file)
                : safeName(file || (type + '_' + stamp() + (type === 'image' ? '.jpg' : '.bin')), type + '_' + stamp())
              const dest = resolve(dir, name)
              mkdirSync(dir, { recursive: true })
              copyFileSync(path, dest)
              logger?.info?.('[mira_qqbot] 已保存' + kind + '：' + dest)
              return { ok: { kind, path: dest } }
            }
          } catch { /* 缓存不可用，继续走接口 */ }
        }
        // 2) 语音：NapCat get_record 统一转 wav（QQ 语音实为 SILK 编码）
        if (type === 'record' && file) {
          const dest = await apiSave('get_record', { file: String(file), out_format: 'wav' }, voiceName(file))
          if (dest) {
            logger?.info?.('[mira_qqbot] 已保存' + kind + '：' + dest)
            return { ok: { kind, path: dest } }
          }
        }
        // 3) 图片：get_image（市场表情会挂起 20 秒且报 file not found，
        //    消息自带 gxh CDN url，直接跳过接口走 url 兜底）
        const marketSticker = type === 'image' && typeof file === 'string' &&
          /^[0-9a-fA-F]{2}-[0-9a-fA-F]{16,64}\.(gif|png|jpg)$/i.test(file)
        if (type === 'image' && file && !marketSticker) {
          const dest = await apiSave('get_image', { file: String(file) }, safeName(file, 'image_' + stamp() + '.jpg'))
          if (dest) {
            logger?.info?.('[mira_qqbot] 已保存' + kind + '：' + dest)
            return { ok: { kind, path: dest } }
          }
        }
        // 4) 文件：get_file（file_id）
        if (type === 'file' && fileId) {
          const dest = await apiSave('get_file', { file_id: String(fileId) }, safeName(file, 'file_' + stamp() + '.bin'))
          if (dest) {
            logger?.info?.('[mira_qqbot] 已保存' + kind + '：' + dest)
            return { ok: { kind, path: dest } }
          }
        }
        // 5) http 链接兜底（本地路径不是 http，跳过）
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          try {
            const extMatch = String(url).match(/\.([A-Za-z0-9]{1,6})(?:\?|$)/)
            const ext = (extMatch && extMatch[1]) || (type === 'image' ? 'jpg' : 'bin')
            const name = type === 'record'
              ? voiceName(file)
              : safeName(file || (type + '_' + stamp() + '.' + ext), type + '_' + stamp())
            const dest = resolve(dir, name)
            await downloadTo(url, dest)
            logger?.info?.('[mira_qqbot] 已保存' + kind + '：' + dest)
            return { ok: { kind, path: dest } }
          } catch { /* 链接失效，继续走市场表情兜底 */ }
        }
        // 6) 市场表情兜底：file 形如 <前2位>-<emojiId>.gif 时，
        //    按 gxh.vip.qq.com 稳定 CDN 规律构造下载（无需签名、长期有效）
        if (type === 'image' && typeof file === 'string') {
          const m = String(file).match(/^([0-9a-fA-F]{2})-([0-9a-fA-F]{16,64})\.(gif|png|jpg)$/i)
          if (m) {
            const gxh = `https://gxh.vip.qq.com/club/item/parcel/item/${m[1]}/${m[2]}/raw300.gif`
            const dest = resolve(dir, safeName(file, 'sticker_' + stamp() + '.gif'))
            await downloadTo(gxh, dest)
            logger?.info?.('[mira_qqbot] 已保存' + kind + '（市场表情 CDN）：' + dest)
            return { ok: { kind, path: dest } }
          }
        }
        return { fail: kind + (file ? '「' + file + '」' : '') + '（无可用来源：无本地缓存/接口/链接）' }
      } catch (e) {
        return { fail: kind + (file ? '「' + file + '」' : '') + '（下载失败：' + ((e && e.message) || String(e)) + '）' }
      }
    }

    ensureDir(dir)
    const results = await Promise.all(segs.map(saveOne)) // 并发保存，避免历史附件串行拖慢
    for (const r of results) {
      if (r && r.ok) saved.push(r.ok)
      else if (r && r.fail) failed.push(r.fail)
    }
    return { saved, failed }
  }

  // 把已保存附件的本地路径追加进消息文本，供 agent 后续用工具处理
  async function enrichWithMedia(text, data) {
    let out = text
    try {
      const mediaSegs = await collectMediaSegments(data) // 含嵌套转发里的媒体
      const { saved, failed } = await saveMediaSegments(mediaSegs)
      if (saved.length) {
        out += '\n\n【对方发来的附件已保存到本地，路径如下：】\n' +
          saved.map((s) => '- ' + s.kind + '：' + s.path).join('\n')
      }
      if (failed.length) {
        out += '\n【部分附件未能保存：' + failed.join('；') + '】'
      }
    } catch (e) {
      logger?.warn?.('[mira_qqbot] 保存附件失败：' + (e && e.message ? e.message : String(e)))
    }
    return out
  }

  return {
    extractText,
    extractForwardContent,
    fetchForwardMessages,
    transformMediaMessage,
    resolveMediaDir,
    downloadTo,
    safeName,
    kindFor,
    collectMediaSegments,
    saveMediaSegments,
    enrichWithMedia,
  }
}

/** 旧代码里直接引用系统临时目录的地方（qq_send_voice 等）保持一致。 */
export function fallbackTmpDir() {
  return tmpdir()
}

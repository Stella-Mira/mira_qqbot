# mira_qqbot · DSH 的 QQ 接管插件（协议层）

通过 **OneBot v11** 正向 WebSocket 连 **NapCat**（跑在你的 QQ 客户端里），把「你本人的 QQ」交给 DSH：
收发消息、好友、群、群成员、频道、媒体，全部以 `qq_*` 工具暴露给模型。

> **1.18.0 起本插件只做协议层。** 账号池、会话绑定（哪个会话在应答谁）、入站路由、`message_id` 去重、
> 限流都在 **`mira_account`** 里（契约见 `../mira_account/README.md`）。
> 旧的 `chatId → sessionId` 表（`<agentCwd>/data/meta.json`）**已删除**，一律用 `mira_account` 的绑定表。
> 所以：**装 mira_qqbot 必装 mira_account**（`inject: ['tools','agents','workspaceRegistry','miraAccount']`，
> 少了它本插件不加载、工具全消失 —— 这是刻意的，比「起来了但发不出去」好排查）。

```
落盘：$DSH_HOME/mira_config/mira_qqbot/      （DSH_HOME 缺省 ~/.dsh）
  config.json      配置（schemaVersion 1；含 accessToken 时权限 600，永不回显/不进日志）
  files/           入站附件（图片/文件/语音）；可用 mediaDir 配置覆盖
```

本机实测 `DSH_HOME=$DSH_HOME` → 实际落 `$DSH_HOME/mira_config/mira_qqbot/`。

## 目录结构

```
mira_qqbot/
├── lib/
│   ├── index.js     入口/装配/单实例/热加载（createRuntime + apply）
│   ├── config.js    schemaVersion + 默认值 + 校验 + 旧键映射 + 必填项口径
│   ├── onebot.js    ws 连接 / 指数退避 / call / 心跳（从旧 index.js 原样搬，实例化）
│   ├── inbound.js   事件解析 + 去重(走 mira_account) + 合并窗口 + 断线积压 + 群/白名单策略
│   ├── route.js     绑定 → steer/queue 投递 + 忙通告 + 超时 + /stop + /new
│   ├── media.js     CQ 媒体 / 转发消息 / 附件下载（原样搬）
│   ├── adapter.js   mira_account 的 platform:'qq' 适配器 + createSession + 会话装配
│   ├── tools.js     21 个 qq_* 工具（含 force/observer 绑定参数）
│   └── kit.mjs      共享小工具（tool_shared/kit/kit.mjs 的逐字节副本）
├── test/smoke.mjs   自检（假 ws / 假 agent / 假 miraAccount，覆盖 PLAN C1–C14）
├── scripts/         NapCat 部署脚本（本插件不碰，见文末）
└── package.json
```

## 与 mira_account 的契约（三条硬约定）

| 约定 | 本插件的落实 |
|---|---|
| **A** 入站一律交给 mira_account 路由，bot 插件不维护 session 映射 | 已绑定：用 `resolve()` 查绑定后由本插件 `route` 投递（为了能做 queue/忙通告/超时）；未绑定：调 `miraAccount.inbound()` 按账号 `inboundPolicy`（create/default/drop）处理。**没有任何本地映射表** |
| **B** 出站一律先 bind（或复用）再 `adapter.send` | `qq_send_*` 全部走 `miraAccount.send({...,sessionId})`；发送即把该会话登记成这个 peer 的 taker（反向绑定） |
| **C** 平台错误归一 | 所有工具返回 `{ok:false,error:{code,message,hint}}`；平台侧错误统一成 `delivery/failed` / `binding/conflict` / `account/*` / `config/*` |

`adapter` 实现（`lib/adapter.js`）：

```js
{
  platform: 'qq',
  connect(account, creds),      // 幂等 ensureConnected（等最多 2s 确认连上）；OneBot 连接本身由插件按 wsUrl 建立
  disconnect(account),          // 关连接
  send(account, kind, peerId, payload), // 只认 payload.text（纯文本或 CQ 码串）→ OneBot 发送；messageId 会被 mira_account 记成 self
  onMessage(account, cb),       // 契约要求的方法（框架目前只校验存在）
  status(account),              // 连接态/selfId/最后错误
  createSession({account,kind,peerId,display,text}) // 可选：inboundPolicy=create 时用 agents.create 起独立会话
}
```

> **为什么已绑定这条不直接调 `miraAccount.inbound()`**：框架的 `deliver` 是它自己装配的普通 steer，
> 拿不到「per-peer queue / 忙通告 / 超时 / `/stop`」。这些是任务书功能点2/4 要求本插件做的事，
> 所以已绑定时由本插件投递（绑定关系仍只有 mira_account 一份）。
> 代价：**未绑定 → 新建会话**那条路没有忙通告/超时（走的是 mira_account 的 steer）。已写进「已知取舍」。

## 配置

文件：`$DSH_HOME/mira_config/mira_qqbot/config.json`。首次加载会自动写一份**只带 `schemaVersion` 与 `_hint`**
的模板（不写默认值，免得盖掉 profile 里正在用的旧配置）。JSON 不支持注释，模板用 `_hint` 承载说明。

### 配置表（含默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` = 不注册工具、不连接 |
| `accountId` | `''` | `mira_account` 里登记的 qq 账号 id（如 `qq-main`）。**留空且账号池只有一个 qq 账号**时用它（warn 一次）；有多个 qq 账号 → `config/missing` 并列出候选（不猜） |
| `wsUrl` | `''` | **必填**。OneBot v11 正向 WebSocket 地址，如 `ws://127.0.0.1:3001`。为空 → 工具返回 `config/missing`，**不自动探测** |
| `accessToken` | `''` | OneBot `access_token`。**空字符串是合法值**（NapCat 没开鉴权）。只进 `Authorization` 头；不进日志/返回值/提交信息 |
| `reconnectMinMs` / `reconnectMaxMs` | `2000` / `60000` | 断线指数退避区间（`min * 2^n`，封顶 max） |
| `callTimeoutMs` | `8000` | 单次 OneBot API 调用超时 |
| `bufferSize` | `500` | `qq_recv_messages` 的环形缓冲上限（超出按最旧丢弃；丢掉的不能再被 `since` 拉回） |
| `mediaDir` | `''` | 入站附件目录；空 = `$DSH_HOME/mira_config/mira_qqbot/files` |
| `napcatMediaDir` | `''` | NapCat 容器内媒体目录（`images/files/voices` 的上级）。**空 = 不启用「复制进容器」**，CQ 里的绝对路径原样透传（Linux 上就这么用） |
| `napcatDir` | `''` | NapCat 程序目录（定位 ffmpeg addon 做 mp3→silk，`qq_send_voice` 需要） |
| `tts.base` / `tts.key` | `''` | OpenAI 兼容 TTS 网关；缺任一项时 `qq_send_voice` 报 `config/missing` |
| `tts.model` / `tts.voice` | `sylvia` / `rosy` | TTS 模型与音色 |
| `backlog.policy` | `latest_n` | 断线积压策略：`drop` / `latest_n` / `replay` |
| `backlog.latestN` | `20` | `latest_n` 时保留最后多少条 |
| `backlog.maxPending` | `200` | 内存安全阀：断线期间最多留多少条（0 = 不限），超出按最旧丢弃并计入 `dropped` |
| `busyNoticeSec` | `20` | agent 忙超过这么多秒 → 先回对方一句「在处理」（0 = 不发） |
| `delivery.default` | `steer` | 入站投递方式：`steer`（插话）/ `queue`（排队） |
| `delivery.byPeer` | `{}` | 逐 peer 覆盖，键为 `"user:123"` / `"group:456"`，值 `steer`/`queue` |
| `reply.enabled` | `true` | 是否把入站消息投给 agent（关掉 = 只缓冲，等模型 pull） |
| `reply.personaPrompt` | `''` | 人设提示词；空 = 用预设自带人设 |
| `reply.rulesPrompt` | `[]` | 行为规则（数组或字符串）；空 = 内置默认 5 条 |
| `reply.securityPrompt` | `[]` | 安全规则；空 = 内置默认 3 条 |
| `reply.systemPrompt` | `''` | 旧字段：配了它且没配 `personaPrompt` 时当人设用 |
| `reply.trustedUsers` | `[]` | **熟人名单**：`'123456'` 或 `'123456:张三，是你的朋友'`。**冒号后是人设文本**，会原样进【识别名单】提示块。**只影响提示词**（以及 mention/keyword 模式下的免 @），不再决定谁能私聊 |
| `reply.privateWhitelist` | `null`（未配置） | **私聊白名单**：`['123456', ...]` = 只有这些人私聊会被应答；`[]` = 谁都能私聊；**不写** = 沿用 `trustedUsers` 的 id（兼容旧配置，`qq_status.warnings` 会提示） |
| `reply.groupAccess` | `all` | **群内接受策略**：`all` = 群里所有消息都交给 agent（由人设/规则决定回不回）；`mention` = 只有 @ 我；`keyword` = 只有命中 `trigger.keywords` |
| `reply.agentProvider` / `agentModel` | `''` | 覆盖模型；空 = 宿主默认（预设自带） |
| `reply.agentPreset` | `sylvia` | agent 加入的预设（决定人设/工具/分组） |
| `reply.agentCwd` | `''` | 新建 agent 会话的 cwd（指向 DSH 工作空间，会话才会出现在界面分组里） |
| `reply.agentTimeoutMs` | `180000` | 等这一轮结束的超时；超时 → `agent.cancel()` + `delivery/failed` |
| `reply.replyToGroup` | `false` | 是否处理群消息 |
| `reply.groupWhitelist` | `[]` | 非空时只有这些群会被处理 |
| `reply.trigger.at` | `true` | 群消息 @ 我 触发 |
| `reply.trigger.keywords` | `[]` | 群消息命中关键词触发（子串、大小写不敏感） |
| `reply.groupBypassForTrusted` | `true` | 白名单用户在该群内说话免 @（只在白名单启用时生效，PLAN §3.8） |
| `reply.newCommand` | `/new` | 重置会话命令（精确匹配整条消息） |
| `reply.stopCommand` | `/stop` | 打断当前回复命令（精确匹配整条消息） |
| `reply.mergeWindowMs` | `3000` | 同一 peer 的多条消息合并窗口（0 = 不合并） |
| `reply.busyNoticeText` | `在处理，稍等一下…` | 忙通告文案。**留空（`''`）= 不发这句**（`busyNoticeSec` 仍生效，只是不提示） |

最小可用配置：

```json
{
  "schemaVersion": 1,
  "wsUrl": "ws://127.0.0.1:3001",
  "accessToken": "",
  "accountId": "qq-main",
  "reply": { "enabled": true, "agentPreset": "stella", "agentCwd": "<您的 workspace>" }
}
```

### 旧键对照表（1.17.0 → 1.18.0）

旧的 profile 配置（`~/.dsh/profiles/web/cordis.patch.yml` 里该插件行的 `config`）**继续认**，不会静默失效：

| 旧键（profile） | 新位置 | 说明 |
|---|---|---|
| `autoReply.enabled` | `reply.enabled` | 整块 `autoReply.*` 映射到 `reply.*`（子键同名） |
| `autoReply.personaPrompt` / `rulesPrompt` / `securityPrompt` / `systemPrompt` | `reply.*` | 语义不变 |
| `autoReply.trustedUsers` | `reply.trustedUsers` | `"<QQ号>:<人设>"` **原样保留**，冒号后的人设文本照旧注入【识别名单】；白名单判定按**第一个冒号前**的 QQ 号 |
| `autoReply.agentPreset` / `agentProvider` / `agentModel` / `agentCwd` | `reply.*` | `agentCwd` 仍是会话 cwd |
| `autoReply.agentTimeoutMs` / `replyToGroup` / `groupWhitelist` / `newCommand` / `mergeWindowMs` | `reply.*` | 语义不变；新增 `stopCommand` |
| `wsUrl` / `accessToken` / `napcatMediaDir` / `napcatDir` / `tts` / `reconnectMinMs` / `reconnectMaxMs` / `callTimeoutMs` / `bufferSize` / `enabled` | 同名键 | 直接生效 |
| `<agentCwd>/data/meta.json`（`chatId → sessionId`） | `mira_account/bindings.json` | 用 `tool_shared/migrate/bindings.mjs` 转换；旧文件改名备份不删 |
| （新增） | `accountId` / `backlog.*` / `delivery.*` / `busyNoticeSec` | 旧配置没有，走默认值 |

用到的旧键会逐个记进 **`qq_status.legacyConfigKeys`**（形如 `autoReply.agentPreset → reply.agentPreset`），
并打一条 warn；同名键两边都配时**文件优先**，warnings 里点名。

### 必填项口径（约定2：不猜）

| 情况 | 返回 |
|---|---|
| `wsUrl` 为空 | `{ok:false,error:{code:"config/missing",message:"必备配置项为空：wsUrl",hint:"在 <路径>/config.json 里手填 wsUrl…（本插件不自动探测）"}}` |
| `wsUrl` 不是 `ws://` / `wss://` | `config/invalid` |
| `accountId` 为空且账号池有多个 qq 账号 | `config/missing` + 候选 id 列表 |
| 账号池里一个 qq 账号都没有 | `account/none`（提示去 accounts.json 登记） |
| `config.json` 坏 / `schemaVersion` 不匹配 | `config/schema`，拒绝加载（原文件原样保留，不静默兼容） |

`accessToken: ""`、`napcatMediaDir: ""`、`tts.base: ""` **都是合法空值**（= 不启用该功能），不当缺失报错。

## 投递语义（功能点2/4）

```
入站消息
  ├─ 无段空事件（message 空、raw_message 也空）→ 不进缓冲、不投递；ignored.empty +1（lastEmpty 留段类型）
  ├─ 自身 echo / 重复 message_id        → 丢弃并计数（dedup.echo / dedup.duplicate）
  ├─ 访问策略命中                        → 丢弃并计数（ignored.*）
  ├─ /stop、/new                         → 命令（见下；先作废该 peer 的合并窗口）
  ├─ 合并窗口（默认 3s）                 → 同一 peer 多条合并成一条
  ├─ 已绑定 → route.deliver
  │    ├─ steer（默认）：立刻 agent.steer，会话忙也插话，不排队
  │    ├─ queue（byPeer 指定）：同一 peer 串行，前一轮结束后自动出队
  │    ├─ 忙超 busyNoticeSec：先回对方 busyNoticeText
  │    └─ 超 agentTimeoutMs：agent.cancel() + delivery/failed
  └─ 未绑定 → miraAccount.inbound()（按账号 inboundPolicy：create / default / drop）
```

**空事件 ≠ 空文本**：撤回/系统提示一类会推 `message_type: private`、`message: []`（或 `""`）、`raw_message: ""`
的 message 事件 —— 没有任何段，**不进 `qq_recv_messages` 缓冲**、不投递，只记 `ignored.empty`，并把
`message_id`/`message_type`/`segments` 留在 `qq_status.lastEmpty`。用户真的只发了空白时事件**有消息段**，
仍进缓冲，记录里带 `segments` 与 `content_kind: "blank"`，按「已处理」记账（平台重推判 dup）。
带图片/表情的消息是 `content`，不受影响。

| 现象 | 行为 |
|---|---|
| 会话空闲 | `steer` 立刻开一轮 |
| 会话在跑（steer） | 消息插到最近一步，不排队 |
| 会话在跑（queue） | 进该 peer 的队列，前一条回合结束后投下一条；`qq_status.queueLength` 可见 |
| 忙超 `busyNoticeSec` | 向对端发一句「在处理…」（`reply.busyNoticeText`）；`qq_status.busyByChat` 里能看到忙了多久、是否已通告 |
| 超 `agentTimeoutMs` | `agent.cancel({kind:'hook',reason:…})`，本次投递返回 `delivery/failed`（不是干等 N 秒抛裸错） |
| 对端发 `/stop` | 有在跑的回合才 `agent.cancel({kind:'user',reason:'/stop 用户打断'})` + 回「已停止当前回复。」，并清掉该 peer 的排队；没有在跑的回合时**不 cancel、不 resume**，只回「当前没有正在进行的回复。」 |
| 对端发 `/new` | 释放该 peer 的 agent + 在 mira_account 里解绑；下一条消息按 `inboundPolicy` 重建会话 |
| `/stop`、`/new` | 先作废该 peer 还没投的合并窗口（`droppedPending` 可见）：窗口里被丢的消息按「已处理」记账，窗口到期不再投递，平台重推也判 dup |

> `/stop`、`/new` 必须在**访问策略之后**判定：陌生人不能靠 `/stop` 打断你的会话。
> 系统提示（忙通告 / 已停止）走**协议层直发**（`adapter.sendRaw`），不登记 binding ——
> 否则旁听者会话投递时会把 taker 抢走。

## 断线积压（功能点5）

OneBot 正向 WS 断开时平台本身不再推消息；本插件防的是「连接不可用那一刻前后到达/仍在处理中的入站」
（双连接、重连竞态、socket 半死）。这类事件先进进程内积压队列，重连后按策略补投：

| `backlog.policy` | 行为 |
|---|---|
| `drop` | 全丢，只计数 |
| `latest_n`（默认） | 只补最后 `latestN`（默认 20）条（**全局**按到达顺序，PLAN §3.9） |
| `replay` | 全补 |

回放仍走去重：`message_id` 已见过的不会补投。`qq_status.backlog` 给：

```json
{ "policy": "latest_n", "latestN": 20, "maxPending": 200, "pending": 0,
  "received": 30, "dropped": 10, "backfilled": 20 }
```

`received` 是断线期间收到的条数（累计），`dropped` 是策略丢掉 + `maxPending` 溢出丢掉的，`backfilled` 是真正补投成功的。

## 群与私聊策略（功能点6）

| 场景 | 行为 | 计数 |
|---|---|---|
| 群消息且 `replyToGroup:false` | 不处理 | `ignored.groupDisabled` |
| 群不在 `groupWhitelist`（非空时） | 不处理 | `ignored.groupNotAllowed` |
| 群 `groupAccess=mention|keyword` 且未触发 | 不处理 | `ignored.groupNotTriggered` |
| 私聊 + 发送者不在 `privateWhitelist`（非空时） | 不处理（**静默但计数可见**） | `ignored.stranger` |
| 群消息没 @ 我、也没命中关键词 | 不处理 | `ignored.groupNotTriggered` |
| 群消息（`groupAccess=all`，默认） | **全收**，正文带「群内昵称（昵称｜QQ号）：」前缀 | — |
| 群消息（`mention`/`keyword`） | @ 我 / 命中关键词 / 熟人免 @ 才投递 | `ignored.groupNotTriggered` |
| 私聊 | 只看 `privateWhitelist`（与熟人名单无关） | `ignored.stranger` |
| 无段空事件（`message` 空、`raw_message` 也空） | 不进缓冲、不投递 | `ignored.empty`（`lastEmpty` 留段类型） |
| 用户只发了空白（有消息段、正文为空） | 进缓冲，不投递（按「已处理」记账） | `ignored.empty` |
| `reply.enabled:false` | 有内容的消息只进缓冲，不投递（空事件仍不进缓冲） | `ignored.replyDisabled` |

口径（2026-10-27 起，按哥哥要求调整）：
- **群聊与私聊分开判定**：`groupWhitelist` 决定「哪些群」，`groupAccess` 决定「群里的哪些消息」；
  群聊**不受**私聊白名单/熟人名单限制。
- **熟人名单 ≠ 私聊白名单**：`trustedUsers` 只影响提示词（谁是谁）与 mention/keyword 下的免 @；
  谁能私聊由 `privateWhitelist` 决定。**不写 `privateWhitelist` 时回落到 `trustedUsers`**（升级不改变行为，
  但 `qq_status.warnings` 会提醒你两者还在共用一份）。
- `groupAccess=all`（默认）：群里每条消息都会交给 agent —— 也就意味着**每条消息一个回合**。
  嫌吵/嫌贵就改 `mention`（只 @ 才进）或 `keyword`，并把 `reply.mergeWindowMs` 调大让连续闲聊合并成一次。

## 去重（功能点7）

全部走 `mira_account` 的 `seen/<platform>.json`（按平台、带 TTL），覆盖三种来源：

1. **自身 echo**：平台把自己发的消息推回来。`message_sent` 事件、或 `user_id === selfId` 的 message 都判为 echo；
   出站时 `adapter.send` 返回的 `message_id` 会被 `mira_account` 记成 self，这里查 `seen()` 也会命中。
2. **平台重发**：同一条事件推两次（双连接 / 重连竞态）→ 第二次 `dup`。
3. **同一 message_id 多次投递** → `dup`（带 `duplicate:true`）。

旧的「单槽 `lastDedupKey` + 8 秒窗口」已删除。`qq_status.dedup` 给 `{echo, duplicate}` 两个计数。

## qq_status 返回什么

```json
{
  "ok": true,
  "connected": true, "selfId": 10001, "nickname": "…", "wsUrl": "ws://127.0.0.1:3001",
  "accountId": "qq-main",
  "queueLength": 0, "queues": {}, "inflight": 0,
  "busyByChat": { "user:1001": { "sessionId": "S1", "mode": "steer", "busyMs": 1200, "notified": false } },
  "bindings": { "count": 1, "taker": 1, "observer": 0, "accountId": "qq-main", "rows": [ … ], "truncated": false },
  "lastError": null,
  "backlog": { "policy": "latest_n", "latestN": 20, "pending": 0, "received": 0, "dropped": 0, "backfilled": 0 },
  "ignored": { "stranger": 0, "groupNotTriggered": 0, "empty": 0 },
  "lastEmpty": null,
  "dedup": { "echo": 0, "duplicate": 0 },
  "connection": { "reconnectAttempts": 0, "lastAliveAgoMs": 120, "connectCount": 1, … },
  "config": { "path": "…/config.json", "schemaVersion": 1, "wsUrlConfigured": true,
              "accessTokenConfigured": true, "accountIdConfigured": true, "backlogPolicy": "latest_n" },
  "legacyConfigKeys": [ "autoReply.enabled → reply.enabled", … ],
  "warnings": [ … ],
  "counters": { … }
}
```

**没有 `accessToken` 的值**，只有 `accessTokenConfigured: true/false`（功能点9）。
`wsUrl` 与 `lastError` 过一遍脱敏（`access_token=` 查询参数、`Bearer` 后的内容都抹掉）。
配置缺 `wsUrl` 时 `qq_status` 直接返回 `config/missing`（C2）——不是"先返回个空状态"。

## 工具清单（21 个，前缀 `qq_`）

| 工具 | 说明 |
|---|---|
| `qq_status` | 上述只读状态（缺 `wsUrl` 时报 `config/missing`） |
| `qq_role` | 查**自己在某条对话线上的身份**：`taker` / `observer` / `none`；不带 peer 时列出本会话的全部绑定与角色 |
| `qq_get_login_info` | 当前登录账号 |
| `qq_get_friend_list` | 好友列表 |
| `qq_get_group_list` | 群列表 |
| `qq_get_group_member_list` | 群成员 |
| `qq_get_stranger_info` | 按 QQ 号查资料 |
| `qq_send_private_msg` | 发私聊（自动绑定；`force` / `observer` / `sessionId` 可选） |
| `qq_send_group_msg` | 发群消息（同上） |
| `qq_send_msg` | 统一入口（纯 QQ 号 = 私聊，`group:群号` = 群聊） |
| — | 发送类工具的 `message` **默认按纯文本发**（`[` `]` `&` 自动转成 CQ 实体，避免正文里出现像 CQ 码的片段导致整条被 NapCat 拒发）；确需发 CQ 码（`[CQ:at,…]`）时传 `cq:true` |
| `qq_send_media_file` | 发本地媒体文件（复制进 NapCat 容器再发；按扩展名分流 image/file/record） |
| `qq_send_voice` | 文字 → TTS → silk → 语音条（需 `tts` + `napcatDir`） |
| `qq_recv_messages` | 增量拉取缓冲（`since` = 上次返回的 `maxSeq`；返回**最旧一页**，`hasMore`/`truncated` 为 true 时接着拉；每条带 `segments`/`content_kind`，可区分空文本与空事件） |
| `qq_get_msg` | 按 message_id 查消息 |
| `qq_get_group_msg_history` | 群历史（NapCat 扩展） |
| `qq_delete_msg` | 撤回 |
| `qq_set_group_ban` | 群禁言 / 解禁 |
| `qq_set_group_kick` | 移出群 |
| `qq_set_group_whole_ban` | 全员禁言开关 |
| `qq_handle_friend_request` | 好友申请 |
| `qq_handle_group_request` | 加群申请 |
| `qq_api` | 通用 OneBot action（逃生舱） |

发送类工具的返回：

```json
{ "ok": true, "accountId": "qq-main", "kind": "user", "peerId": "1001",
  "messageId": "123", "message_id": "123",
  "binding": { "mode": "taker", "action": "created" } }
```

冲突时（同 peer 已被别的会话应答）：

```json
{ "ok": false, "error": { "code": "binding/conflict",
  "message": "user:1001 已经由会话 S1 应答",
  "hint": "要抢过来加 force:true；只想旁听加 observer:true；不动就先 unbind 旧绑定" } }
```

## 已知取舍

1. **已绑定走本插件的 `route`，未绑定交给 `miraAccount.inbound()`**。前者的好处是能做
   per-peer queue、忙通告、超时、`/stop`；后者复用框架的 `inboundPolicy`（create/default/drop）。
   代价：**经由 `inboundPolicy` 新建会话的那条路没有忙通告/超时**（框架只做普通 steer）。要这些能力就先绑定。
2. **`accountId` 为空时用「账号池里唯一的 qq 账号」**（warn + `qq_status.config.accountIdConfigured:false`）。
   这不是"探测网络地址"，而是读 `mira_account` 的权威账号池；有多个 qq 账号时拒绝猜、报 `config/missing`。
   这样做是为了让本机单账号的 profile 升级后行为不变（旧 profile 没有这个键）。
3. **私聊白名单与熟人名单是两件事**：`privateWhitelist` 决定准入，`trustedUsers` 只喂提示词。
   `privateWhitelist` 不写 → 回落到 `trustedUsers`（升级安全）；写成 `[]` → 谁都能私聊。
   熟人也不必在白名单里（他可能只是"认识"，但不该私聊你）。
4. **`groupAccess=all` 的代价**：群里每条消息都会起一个回合（即便 agent 决定不回复）。
   要"看得见但不吵醒"，目前只能用 `mention`/`keyword` + 合并窗口；真要"只进上下文不跑回合"需要新的 passive 模式（未做）。
5. **去重记账在投递成功之后**：入站快路径改用 `mira_account.verdict()`（只查）+ 投递 +
   `recordSeen()`（成功后记）。以前先记账后投递，投递失败（会话超时/agent 崩/建会话失败）时
   那条 `message_id` 已被吞掉，平台重推会被当重复丢掉 —— 消息永久消失且无记录。
6. **角色靠提示词显式告知**：旁听会话收到消息时，提示词里会写【本会话角色】= 旁听 + "不要回复"，
   并且**不会**向对方发「在处理」；要接管用 `mira_account_bind`（`force:true`）。
6. **`trustedUsers` 为空 = 名单不启用**（所有人都算熟人）。
   名单里 `"<QQ号>:<人设>"` 的冒号后文本原样进【识别名单】（旧行为），白名单判定只看第一个冒号前。
4. **系统提示（在处理 / 已停止）走协议层直发**，不登记 binding，但会把返回的 `message_id` 记成 self
   （避免自己的提示又被当成入站）。它们不是"会话发起的出站"，不该抢 taker。
5. **`qq_recv_messages` 的缓冲不去重**：去重发生在投递路径（mira_account）。平台重发在缓冲里会出现两条，
   这是"原始事件视图"的代价，换取的是不再维护第二套去重状态。
   增量拉取返回**最旧一页**（`maxSeq` = 本页最后一条的 seq），`hasMore`/`truncated` 为 true 时用新的
   `since` 继续拉 —— 旧实现返回最新一页，中间那一截既拉不到、`maxSeq` 又跳过去，消息永久丢失。
6. **运行期统计不落盘**：`received/dropped/backfilled/ignored.*` 都是进程内计数，重启归零。
   `config.json` 是手填的权威源，dispose 时**不写**它（约定9：旧实例用旧状态覆写新手改文件的坑）。
   回放的 `backfilled` 只数真正补投成功的事件：`dropped`（按 inboundPolicy 丢弃）与 `command`（`/stop`、`/new`）不算。
7. **断线积压是"进程内队列"**：正向 WS 断开时平台不推消息，真正的积压只发生在连接不可用时仍有事件到达的竞态
   （双连接 / 半死 socket / 重连窗口）。`status` 里的数字是实打实的，但不要期待它统计"NapCat 断线那 10 分钟"。
8. **`/stop`、`/new` 只认精确整条消息**（沿用旧 `newCommand` 语义）；`/stop@某人` 这类不认。
9. **`kind:"channel"`（频道）只做兜底**：`parse` 会映射，发送用 `send_guild_channel_msg`，未在真机验证。
10. **语音转换在 macOS 上仍是子进程 + ffmpeg addon**（原样搬）。Linux/Windows 把 mp3 交给 NapCat 侧转码。

## 迁移（1.17.0 → 1.18.0）

前置：`mira_account` 已装（平台适配器由本插件注册，`platform:'qq'`）。

1. **备份**旧配置与旧映射：
   ```bash
   cp ~/.dsh/profiles/web/cordis.patch.yml ~/cordis.patch.yml.bak
   cp <agentCwd>/data/meta.json ~/meta.json.bak
   ```
2. **登记账号**（`mira_account`）：`$DSH_HOME/mira_config/mira_account/accounts.json` 里加
   `{"id":"qq-main","platform":"qq","enabled":true,"inboundPolicy":"create"}`，或调 `mira_account_add`。
   然后手填 `creds/qq-main.json`（600）——**access_token 仍放在 qqbot 的 config.json**，不强制写进 creds。
3. **写 qqbot 配置**：把旧 profile 里的 `wsUrl` / `accessToken` / `napcatMediaDir` / `napcatDir` / `tts`
   和 `autoReply.*`（改名为 `reply.*`）搬到 `$DSH_HOME/mira_config/mira_qqbot/config.json`；
   首次加载会自动生成一份带 `_hint` 的模板，照着填即可。**注意 `schemaVersion` 必须是 1。**
4. **转换绑定**（旧 `chatId → sessionId` 表）：
   ```bash
   node tool_shared/migrate/bindings.mjs --from <agentCwd>/data/meta.json --platform qq --account qq-main   # 先看计划
   node tool_shared/migrate/bindings.mjs --from … --write                                                   # 确认后写入（先备份）
   ```
   规则：`"user:123"` → `kind:"user"`，`"group:456"` → `kind:"group"`，`mode:"taker"`；账号必须已存在，缺什么报什么。
5. **重启 DSH**，然后：
   - `qq_status` → `connected:true`、`bindings.count` 与旧表条数一致；
   - `qq_status.legacyConfigKeys` 里若还有条目，说明 profile 里仍在用旧键（去 profile 删掉或留作兼容）；
   - 对端发一条消息 → 对应会话应收到（`busyByChat` / `queueLength` 可用于观察）。
6. **清理**：profile 里的旧 `config` 键可以删了（删之前先确认 `config.json` 生效）；
   旧 `meta.json` 已被迁移脚本改名成 `meta.json.bak.<时间戳>`，确认无问题后自行决定是否删除。

**不兼容点**：旧插件在 `<agentCwd>/data/` 下写 `meta.json` 与 `files/`；新插件的附件改存
`$DSH_HOME/mira_config/mira_qqbot/files/`。会话映射由 `mira_account` 接管，**不会**再写 `meta.json`。

### 升级后的行为变化（对着任务书功能点，逐条点名）

配置键是兼容的，但这几处**语义**按任务书改了，升级后要能预期：

| 变化 | 旧行为 | 新行为 | 依据 |
|---|---|---|---|
| 入站投递 | `followup`（排队等这一整轮结束） | **`steer` 插话**（空闲立刻开一轮，忙则插到最近一步）；`delivery.byPeer` 可切回排队 | 功能点2【定】 |
| 白名单语义 | `trustedUsers` 只是提示词里的【识别名单】，名单外的人**照样应答** | 名单**非空**即成严格白名单：名单外**静默并计数**（`ignored.stranger`） | 功能点6 / PLAN §3.8 |
| 群触发 | `replyToGroup:true` 时群里所有消息都会应答 | 还要 @ 我或命中 `reply.trigger.keywords`（白名单用户免 @） | 功能点6 |
| 忙与超时 | 干等 `agentTimeoutMs` 后抛裸错 | 忙超 `busyNoticeSec` 先回「在处理」；超时 `agent.cancel()` + `delivery/failed` | 功能点4 |
| `/stop` | 无 | 对端发 `/stop` 打断当前回合（`agent.cancel`） | 功能点4 |
| `/new` | 释放 agent + 删 `meta.json` 映射 | 释放 agent + 在 `mira_account` 里**解绑**（下条消息按 inboundPolicy 重建） | 功能点2/3 |
| 去重 | 进程内单槽 `lastDedupKey`（8s 窗口） | `mira_account` 的 `seen/<platform>.json`（TTL、跨插件统一） | 功能点7 |
| 附件目录 | `<agentCwd>/data/files/` | `$DSH_HOME/mira_config/mira_qqbot/files/`（`mediaDir` 可覆盖） | 约定1 |
| `qq_status` | 缺 `wsUrl` 也返回一个空状态 | 直接返回 `config/missing`（不自动探测） | 约定2 / C2 |
| 出站绑定 | 一账号一会话，没绑定的发出去回不来 | 发送即登记 taker；冲突要 `force`/`observer` | 功能点3 |

**真要"完全不变"的旧行为**：群/白名单默认值、`persona/rules/security` 提示词组装、转发与媒体处理、
`qq_recv_messages` 缓冲、`/new` 的回执文案、`qq_send_voice` 的 TTS→silk 链路，都原样保留。

## 自检

```bash
cd mira_qqbot && node test/smoke.mjs        # 期望末行：==== ALL PASS（219 项断言）====，退出码 0
node tool_shared/tools/check-zero-dep.mjs mira_qqbot   # 只许 node: 与相对 import
node tool_shared/tools/check-kit.mjs                  # lib/kit.mjs 与规范源逐字节一致
```

smoke 覆盖 PLAN §1.3 的 C2–C14，并额外覆盖：`schemaVersion` 不匹配、单实例、合并窗口、queue 出队、
`inboundPolicy=create`（且不写 `meta.json`）/ `drop`、`/new`、积压 `drop`/`replay`、
`reply.enabled=false`（只缓冲）、旧 `autoReply.*` 兼容与 `legacyConfigKeys`、token 只进
`Authorization` 头 + 配置 600、`qq_recv_messages`。它用假 ws / 假 agent / 假 miraAccount，在临时
`DSH_HOME` 里跑，**不碰真实配置、不连真实 NapCat**。
（另有一次手工验证：用**真的** `mira_account` 服务装配本插件，确认 adapter 注册、反向绑定、
`binding/conflict`、真去重与 `/stop` 都按契约工作——那份脚本不入库。）

## 故障排查

| 现象 | 处理 |
|---|---|
| `qq_status` 返回 `config/missing`（wsUrl） | 在 `$DSH_HOME/mira_config/mira_qqbot/config.json` 填 `wsUrl`；本插件不自动探测 |
| `qq_status` 返回 `config/missing`（accountId） | 填 `accountId`，或让账号池里只剩一个 qq 账号；账号池为空会报 `account/none` |
| `connected:false` 且 `lastError` 有「WebSocket 错误」 | 确认 QQ 以 `--no-sandbox` 启动、NapCat 已加载；`ss -ltnp | grep 3001` 看端口；核对 `wsUrl`/`accessToken` |
| 工具报 `platform/unsupported` | `mira_account` 没加载或适配器没注册；先 `mira_account_status` 看 `adapters` 里有 `qq` |
| `binding/conflict` | 同 peer 已被别的会话应答；要抢加 `force:true`，旁听加 `observer:true` |
| 消息进来了但会话没被叫醒 | 看 `qq_status.ignored.*`：`stranger`（白名单）/`groupNotTriggered`（没 @/没关键词）/`replyDisabled`（`reply.enabled:false`） |
| 对端说"在处理"但一直没回复 | agent 卡住：看 `busyByChat.busyMs` 与 `lastError`（超时会 `delivery/failed`）；把 `reply.agentTimeoutMs` 调大或让对端 `/stop` |
| `qq_status.legacyConfigKeys` 非空 | profile 里还在用旧键；配置搬到 `config.json` 后从 profile 删掉 |
| 语音发送失败（macOS） | `napcatDir` 指错或缺 ffmpeg addon；错误里会给出 addon 绝对路径 |

## 平台兼容与 NapCat 部署（脚本，原样保留）

| 组件 | macOS | Linux | Windows |
|---|---|---|---|
| 插件本体 `lib/` | ✅ | ✅ | ✅ |
| `scripts/setup-napcat.sh` | ✅ | ✅（自动检测平台） | ❌（用 ps1） |
| `scripts/setup-napcat.ps1` | ❌ | ❌ | ✅ |
| `scripts/start-napcat.sh` / `napcat.conf` | ✅ | ✅ | ⚠️ 需 Git Bash/WSL |

`scripts/*` 本轮未改动。用法见脚本头部注释；核心是让 NapCat 开一个 **OneBot v11 正向 WebSocket**，
把地址与 `access_token` 填进本插件的 `wsUrl` / `accessToken`。

```bash
bash scripts/setup-napcat.sh            # 部署/配置 OneBot WS
bash scripts/start-napcat.sh            # 按 napcat.conf 启动
```

## 许可证

MIT

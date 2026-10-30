#!/bin/bash
# mira_qqbot 的 NapCat 一键部署脚本（macOS / Linux 自动检测；Windows 请用 setup-napcat.ps1）
# 作用：
#   macOS：把 NapCat.Shell 挂载进 QQ（打补丁 + 启动 + 配 OneBot WebSocket）
#   Linux：探测 NapCat 配置目录并写入 OneBot v11 WebSocket 配置
# 用法：在插件目录下运行  bash scripts/setup-napcat.sh
#
# 可选环境变量：
#   WS_TOKEN           OneBot WebSocket access_token；不设则自动生成随机 token（不回写脚本）
#   WS_PORT            OneBot WebSocket 端口，默认 3001
#   QQ_APP             （macOS）QQ.app 路径，默认 /Applications/QQ.app
#   NAPCAT_CONFIG_DIR  （Linux）NapCat 配置目录，默认 ~/.config/QQ/NapCat/config
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

WEBUI="http://127.0.0.1:6099"
WS_PORT="${WS_PORT:-3001}"
# 安全做法：token 由环境变量传入，或每次运行自动生成随机值，绝不硬编码在脚本里
WS_TOKEN="${WS_TOKEN:-$(openssl rand -hex 16 2>/dev/null || true)}"

# ============================================================
# macOS 分支：打 QQ 入口补丁 + 启动 NapCat + 配 OneBot WS
# ============================================================
setup_macos() {
  local QQ_APP="${QQ_APP:-/Applications/QQ.app}"
  local APP_PKG="$QQ_APP/Contents/Resources/app/package.json"
  local DOC="$HOME/Library/Containers/com.tencent.qq/Data/Documents"
  local NAP_DIR="$DOC/napcat"
  local LOADER="$DOC/loadNapCat.js"
  local CONFIG_DIR="$HOME/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config"

  say "检测到 macOS"

  # ── 1. 校验 NapCat 已安装 ────────────────────────────────────
  if [ ! -f "$NAP_DIR/napcat.mjs" ]; then
    echo "错误：未找到 $NAP_DIR/napcat.mjs ，请先运行 NapCat 安装器或解压 NapCat.Shell.zip 到该目录。"
    exit 1
  fi
  if [ ! -f "$LOADER" ]; then
    echo "错误：未找到 $LOADER 。"
    exit 1
  fi

  # ── 2. 给 QQ 打入口补丁（需要管理员密码） ────────────────────
  say "检查 QQ 入口补丁"
  local APP_DIR="$(dirname "$APP_PKG")"
  # 动态计算 loadNapCat.js 相对 app/package.json 的路径，任何用户名/安装位置都通用
  local LOADER_MAIN="$(python3 -c "import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$LOADER" "$APP_DIR" 2>/dev/null || true)"
  if [ -z "$LOADER_MAIN" ]; then
    echo "错误：无法计算 loader 相对路径（需要 python3）。"
    exit 1
  fi
  local CUR_MAIN=$(python3 -c "import json;print(json.load(open('$APP_PKG'))['main'])" 2>/dev/null || echo '')
  if [ "$CUR_MAIN" = "$LOADER_MAIN" ]; then
    echo "    已打补丁，跳过"
  else
    echo "    当前 main = ${CUR_MAIN:-<读取失败>}"
    echo "    即将备份并修改 ${APP_PKG}（需管理员密码；macOS 还要求「App 管理」权限）"
    if [ ! -f "$APP_PKG.bak" ]; then
      if ! sudo cp "$APP_PKG" "$APP_PKG.bak" 2>/tmp/dshqq-patch-err.log; then
        echo "    ❌ 备份失败："; sed 's/^/        /' /tmp/dshqq-patch-err.log
        cat <<'HINT'

    ⚠️  App Store 版 QQ 受 macOS「App 管理」权限保护，root 也无法直接改它的包内容。
    请任选其一后再重新运行本脚本：
      A. 系统设置 → 隐私与安全性 → App 管理 → 打开你的终端(iTerm/Terminal)开关；
      B. 运行官方安装器：open ~/Downloads/NapCatInstaller.app ，点「修改 QQ/安装」授权完成后退出。
HINT
        exit 1
      fi
    fi
    python3 - "$APP_PKG" "$LOADER_MAIN" <<'PY'
import json, sys
p, main = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d['main'] = main
json.dump(d, open('/tmp/qq-package-patched.json', 'w'), ensure_ascii=False, indent=2)
PY
    if ! sudo cp /tmp/qq-package-patched.json "$APP_PKG" 2>/tmp/dshqq-patch-err.log; then
      echo "    ❌ 写入补丁失败："; sed 's/^/        /' /tmp/dshqq-patch-err.log
      echo "    （同上：需在「系统设置 → 隐私与安全性 → App 管理」授权终端后重试）"
      exit 1
    fi
    echo "    补丁完成"
  fi

  # ── 3. 退出 QQ 图形界面，以 NapCat 模式启动 ──────────────────
  say "退出当前 QQ 图形界面"
  osascript -e 'quit app "QQ"' >/dev/null 2>&1 || killall QQ >/dev/null 2>&1 || true
  sleep 2

  say "以 NapCat 模式启动 QQ（后台运行，日志 /tmp/napcat-qq.log）"
  pkill -f 'QQ --no-sandbox' >/dev/null 2>&1 || true
  sleep 1
  nohup "$QQ_APP/Contents/MacOS/QQ" --no-sandbox >/tmp/napcat-qq.log 2>&1 &
  echo "    已启动，PID $!"

  say "打开 NapCat WebUI"
  sleep 3
  open "$WEBUI" || true
  echo "    WebUI: $WEBUI"
  # 从 NapCat 配置中读取 WebUI 访问令牌（不同版本文件名可能不同，尝试常见位置）
  local WEBUI_TOKEN="$(python3 - "$CONFIG_DIR" <<'PY' 2>/dev/null || true
import json, os, sys
base = sys.argv[1]
for name in ("webui.json", "WebUI.json"):
    p = os.path.join(base, name)
    if not os.path.exists(p):
        continue
    try:
        d = json.load(open(p))
        t = d.get("token") or d.get("accessToken") or ""
        if t:
            print(t)
    except Exception:
        pass
    break
PY
)"
  if [ -n "$WEBUI_TOKEN" ]; then
    echo "    WebUI 访问令牌: $WEBUI_TOKEN"
  else
    echo "    （若 WebUI 提示需要访问令牌，请查看 NapCat 的 webui.json 配置）"
  fi

  # ── 4. 等待扫码登录 ──────────────────────────────────────────
  say "等待扫码登录（请用手机 QQ 扫 WebUI 里的二维码，等待 5 分钟）"
  local UIN=""
  for i in $(seq 1 150); do
    sleep 2
    # 方式1：WebUI 免鉴权接口（accessControlMode=none），POST /api/GetQQLoginInfo
    local INFO=$(curl -sS -m 3 -X POST "$WEBUI/api/GetQQLoginInfo" -H 'Content-Type: application/json' 2>/dev/null || true)
    UIN=$(printf '%s' "$INFO" | python3 -c '
import sys, json
def find(obj, key):
    if isinstance(obj, dict):
        if obj.get(key) not in (None, "", "0"): return str(obj.get(key))
        for v in obj.values():
            r = find(v, key)
            if r: return r
    elif isinstance(obj, list):
        for v in obj:
            r = find(v, key)
            if r: return r
    return ""
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(find(d, "uin") or find(d, "uid") or "")' 2>/dev/null || true)
    if [ -z "$UIN" ] || [ "$UIN" = "0" ]; then
      # 方式2：从已生成的 onebot11_<uin>.json 文件名里猜
      UIN=$(ls "$CONFIG_DIR"/onebot11_*.json 2>/dev/null | head -1 | sed -E 's/.*onebot11_([0-9]+)\.json/\1/' || true)
    fi
    if [ -n "$UIN" ] && [ "$UIN" != "0" ]; then
      echo "    已登录，QQ 号：$UIN"
      break
    fi
    UIN=""
    if [ $((i % 15)) -eq 0 ]; then echo "    仍在等待扫码…（$((i*2))s）"; fi
  done

  if [ -z "$UIN" ]; then
    echo "    未检测到登录，5 分钟后退出等待。请确认已在 WebUI 扫码登录后重新运行本脚本。"
    exit 1
  fi

  # ── 5. 写入 OneBot v11 WebSocket 配置 ────────────────────────
  say "配置 OneBot v11 WebSocket（ws://127.0.0.1:${WS_PORT}）"
  local CFG_FILE="$CONFIG_DIR/onebot11_${UIN}.json"
  python3 - "$CFG_FILE" "$WS_PORT" "$WS_TOKEN" <<'PY'
import json, sys
cfg_file, port, token = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    d = json.load(open(cfg_file))
except Exception:
    d = {}
net = d.setdefault("network", {})
for k in ("httpServers", "httpSseServers", "httpClients", "websocketServers", "websocketClients"):
    net.setdefault(k, [])
ws = {
    "name": "mira_qqbot",
    "enable": True,
    "host": "127.0.0.1",
    "port": port,
    "token": token,
    "messagePostFormat": "array",
    "reportSelfMessage": False,
    "enableForcePushEvent": True,
    "heartInterval": 30000,
    "enableHeart": True,
    "debug": False,
}
# 去重：同端口已存在则替换，否则追加
net["websocketServers"] = [s for s in net["websocketServers"] if s.get("port") != port]
net["websocketServers"].append(ws)
d.setdefault("musicSignUrl", "")
d.setdefault("enableLocalFile2Url", False)
d.setdefault("parseMultMsg", False)
json.dump(d, open(cfg_file, "w"), ensure_ascii=False, indent=2)
print("    已写入", cfg_file)
PY

  # ── 6. 重启 NapCat 使配置生效 ────────────────────────────────
  say "重启 NapCat 使 OneBot 配置生效"
  pkill -f 'QQ --no-sandbox' >/dev/null 2>&1 || true
  sleep 2
  nohup "$QQ_APP/Contents/MacOS/QQ" --no-sandbox >/tmp/napcat-qq.log 2>&1 &
  echo "    已重启"

  say "完成"
  echo "    OneBot WebSocket: ws://127.0.0.1:$WS_PORT"
  echo "    access_token: $WS_TOKEN"
  echo "    （请把上面的 access_token 同步到 mira_qqbot 插件配置；如需复用，下次运行前 export WS_TOKEN=同一值 即可）"
  echo "    下一步：重启 dsh web 使 mira_qqbot 插件加载，然后用 qq_status 工具验证。"
}

# ============================================================
# Linux 分支：探测配置目录 + 写入 OneBot WS（NapCat 启动方式
# 因发行版/安装方式而异，脚本负责配置，启动请按你的安装方式）
# ============================================================
setup_linux() {
  local CONFIG_DIR="${NAPCAT_CONFIG_DIR:-$HOME/.config/QQ/NapCat/config}"

  say "检测到 Linux"
  echo "    NapCat 配置目录：$CONFIG_DIR"

  # ── 1. 校验配置目录 ──────────────────────────────────────────
  if [ ! -d "$CONFIG_DIR" ]; then
    echo "错误：未找到 NapCat 配置目录 $CONFIG_DIR"
    echo "请确认 NapCat（Docker 或本机版）已安装并登录运行过。"
    echo "也可用环境变量 NAPCAT_CONFIG_DIR 手动指定配置目录后重试。"
    exit 1
  fi

  # ── 2. 找 onebot11_<uin>.json（取最近修改的） ────────────────
  local CFG_FILE="$(ls -t "$CONFIG_DIR"/onebot11_*.json 2>/dev/null | head -1 || true)"
  if [ -z "$CFG_FILE" ]; then
    echo "错误：$CONFIG_DIR 下未找到 onebot11_*.json，请先启动 NapCat 并登录 QQ 以生成配置文件。"
    exit 1
  fi
  local UIN="$(basename "$CFG_FILE" | sed -E 's/onebot11_([0-9]+)\.json/\1/' || true)"
  echo "    QQ 号：$UIN"
  echo "    配置文件：$CFG_FILE"

  # ── 3. 写入 OneBot v11 WebSocket 配置 ────────────────────────
  say "配置 OneBot v11 WebSocket（ws://127.0.0.1:${WS_PORT}）"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "错误：写入配置需要 python3，请先安装（例如 apt install python3 / dnf install python3）。"
    exit 1
  fi
  python3 - "$CFG_FILE" "$WS_PORT" "$WS_TOKEN" <<'PY'
import json, sys
cfg_file, port, token = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    d = json.load(open(cfg_file))
except Exception:
    d = {}
net = d.setdefault("network", {})
for k in ("httpServers", "httpSseServers", "httpClients", "websocketServers", "websocketClients"):
    net.setdefault(k, [])
ws = {
    "name": "mira_qqbot",
    "enable": True,
    "host": "127.0.0.1",
    "port": port,
    "token": token,
    "messagePostFormat": "array",
    "reportSelfMessage": False,
    "enableForcePushEvent": True,
    "heartInterval": 30000,
    "enableHeart": True,
    "debug": False,
}
# 去重：同端口已存在则替换，否则追加
net["websocketServers"] = [s for s in net["websocketServers"] if s.get("port") != port]
net["websocketServers"].append(ws)
d.setdefault("musicSignUrl", "")
d.setdefault("enableLocalFile2Url", False)
d.setdefault("parseMultMsg", False)
json.dump(d, open(cfg_file, "w"), ensure_ascii=False, indent=2)
print("    已写入", cfg_file)
PY

  # ── 4. 读取 WebUI 访问令牌（不同版本文件名可能不同） ─────────
  local WEBUI_TOKEN="$(python3 - "$CONFIG_DIR" <<'PY' 2>/dev/null || true
import json, os, sys
base = sys.argv[1]
for name in ("webui.json", "WebUI.json"):
    p = os.path.join(base, name)
    if not os.path.exists(p):
        continue
    try:
        d = json.load(open(p))
        t = d.get("token") or d.get("accessToken") or ""
        if t:
            print(t)
    except Exception:
        pass
    break
PY
)"

  # ── 5. 输出结果 ──────────────────────────────────────────────
  say "完成"
  echo "    OneBot WebSocket: ws://127.0.0.1:$WS_PORT"
  echo "    access_token: $WS_TOKEN"
  if [ -n "$WEBUI_TOKEN" ]; then
    echo "    WebUI 访问令牌: $WEBUI_TOKEN"
  else
    echo "    （若 WebUI 提示需要访问令牌，请查看 NapCat 的 webui.json 配置）"
  fi
  echo "    （请把上面的 access_token 同步到 mira_qqbot 插件配置；如需复用，下次运行前 export WS_TOKEN=同一值 即可）"
  echo "    请按你的 NapCat 安装方式（Docker / 本机服务）重启 NapCat 使配置生效，"
  echo "    然后重启 dsh web 并用 qq_status 工具验证。"
}

# ============================================================
# 主入口：按系统自动分发
# ============================================================
case "$(uname -s)" in
  Darwin) setup_macos ;;
  Linux)  setup_linux ;;
  *) echo "不支持的系统：$(uname -s)。Windows 请使用 scripts/setup-napcat.ps1。"; exit 1 ;;
esac

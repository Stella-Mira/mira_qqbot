#!/bin/bash
# ============================================================
# start-napcat.sh —— NapCat 一键启动/重启（macOS）
# 所有路径与账号均写在 napcat.conf，脚本只做三件事：
#   1) 在 QQBOT_DIR 生成指向 NapCat 数据目录的软链视图
#   2) 按 MODE 启动 / 重启 QQ（NapCat 随 QQ 加载）
#   3) 用 QQ_ACCOUNT 快速登录（免扫码）
#
# 用法:
#   ./start-napcat.sh            # 按 napcat.conf 的 MODE 执行
#   ./start-napcat.sh start      # 非重启模式：已在运行则跳过
#   ./start-napcat.sh restart    # 重启模式：先关闭再启动
#   ./start-napcat.sh stop       # 停止 QQ
#   ./start-napcat.sh link       # 生成/刷新软链视图
#   ./start-napcat.sh status     # 查看状态
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 配置文件：可用 NAPCAT_CONF 环境变量指定路径（默认脚本同目录 napcat.conf）
CONF_FILE="${NAPCAT_CONF:-$DIR/napcat.conf}"

# ---------- 配置（默认值，可被 napcat.conf 覆盖） ----------
MODE="start"                                          # restart=重启模式  start=非重启模式
QQ_PATH="/Applications/QQ.app"                        # QQ 路径（启动用）
NAPCAT_PATH="$HOME/Library/Containers/com.tencent.qq/Data/Documents/napcat"   # napcat 路径（启动用）
NAPCAT_MEDIA="$NAPCAT_PATH/data"                      # napcat 媒体目录（发送文件用）
QQ_ACCOUNT=""                                         # QQ 号（登录用，留空自动推断）
QQ_PASSWORD=""                                        # QQ 密码（可选回退）
QQBOT_DIR="$DIR"                                      # qqbot 工作目录（设置软链接用）

LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.dsh.napcat.qq.plist"

load_conf() {
  if [ -f "$CONF_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$CONF_FILE"
    set +a
  fi
  # 相对路径一律按脚本目录解析
  res() { case "$1" in /*) echo "$1" ;; *) echo "$DIR/$1" ;; esac; }
  QQ_PATH="$(res "$QQ_PATH")"
  NAPCAT_PATH="$(res "$NAPCAT_PATH")"
  NAPCAT_MEDIA="$(res "$NAPCAT_MEDIA")"
  QQBOT_DIR="$(res "$QQBOT_DIR")"
}
load_conf

QQ_BIN="$QQ_PATH/Contents/MacOS/QQ"
log() { echo "[$(date '+%F %T')] [start-napcat] $*"; }

# ---------- 状态检查 ----------
is_qq_running() { pgrep -f "$QQ_BIN --no-sandbox" >/dev/null 2>&1; }
is_napcat_up() {
  local code
  code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/ 2>/dev/null || true)
  [ "$code" != "000" ] && [ -n "$code" ]
}

# ---------- 软链视图 ----------
link_to() {
  local target="$1" link="$2"
  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$target" ]; then
      log "软链已存在: $link -> $target"
      return 0
    fi
    log "软链目标变化，重建: $link -> $target"
    rm -f "$link"
  elif [ -e "$link" ]; then
    mv "$link" "$link.old_$(date +%Y%m%d%H%M%S)"
    log "原目录已备份，替换为软链: $link"
  fi
  ln -s "$target" "$link"
  log "已生成软链: $link -> $target"
}

link_dirs() {
  mkdir -p "$QQBOT_DIR"
  link_to "$NAPCAT_PATH"  "$QQBOT_DIR/napcat"
  link_to "$NAPCAT_MEDIA" "$QQBOT_DIR/napcat-media"
}

# ---------- 启动 / 停止 ----------
start_qq() {
  link_dirs
  export NAPCAT_QUICK_ACCOUNT="$QQ_ACCOUNT"
  [ -n "$QQ_PASSWORD" ] && export NAPCAT_QUICK_PASSWORD="$QQ_PASSWORD"
  log "启动 QQ --no-sandbox（NapCat 模式）"
  log "  QQ       : $QQ_BIN"
  log "  NapCat   : $NAPCAT_PATH"
  log "  自动登录 : ${QQ_ACCOUNT:-自动}"
  nohup "$QQ_BIN" --no-sandbox >> /tmp/napcat-qq.log 2>&1 &
  disown 2>/dev/null || true
  wait_for_napcat
}

wait_for_napcat() {
  log "等待 NapCat OneBot 就绪（最多 90 秒）…"
  for i in $(seq 1 90); do
    if is_napcat_up; then
      log "NapCat OneBot(127.0.0.1:3001) 已就绪 ✓"
      return 0
    fi
    sleep 1
  done
  log "⚠️ 等待超时（QQ $(is_qq_running && echo 运行中 || echo 未运行)），请检查 /tmp/napcat-qq.log"
  return 1
}

stop_qq() {
  if is_qq_running; then
    local pids
    pids=$(pgrep -f "$QQ_BIN --no-sandbox" || true)
    log "停止 QQ（PID: $pids）…"
    for p in $pids; do kill "$p" 2>/dev/null || true; done
    for i in $(seq 1 15); do
      is_qq_running || break
      sleep 1
    done
    if is_qq_running; then
      log "QQ 未正常退出，强制结束"
      pkill -9 -f "$QQ_BIN --no-sandbox" 2>/dev/null || true
      sleep 2
    fi
    log "QQ 已停止"
  else
    log "QQ 未在运行"
  fi
}

# ---------- 模式 ----------
mode_start() {
  if is_qq_running; then
    if is_napcat_up; then
      log "QQ 与 NapCat 均已在运行，跳过启动 ✓"
    else
      log "⚠️ QQ 在运行但 NapCat 未响应，建议 ./start-napcat.sh restart"
    fi
    link_dirs
    exit 0
  fi
  log "QQ 未运行，启动…"
  start_qq
}

mode_restart() {
  local was_loaded=0
  if launchctl list 2>/dev/null | grep -q "com.dsh.napcat.qq"; then
    was_loaded=1
    launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
    log "已临时停用 launchd 守护（完成后恢复）"
  fi
  stop_qq
  start_qq
  if [ "$was_loaded" = "1" ]; then
    launchctl load "$LAUNCHD_PLIST" 2>/dev/null || true
    log "已恢复 launchd 守护"
  fi
}

status() {
  echo "=== NapCat 状态 ==="
  echo "QQ 进程 : $(is_qq_running && echo 运行中 || echo 未运行)"
  is_qq_running && pgrep -lf "$QQ_BIN --no-sandbox"
  echo "NapCat  : $(is_napcat_up && echo 在线\(WS3001\) || echo 离线)"
  echo "--- 配置 ---"
  echo "模式     : ${MODE}"
  echo "QQ 路径  : $QQ_PATH"
  echo "NapCat   : $NAPCAT_PATH"
  echo "媒体目录 : $NAPCAT_MEDIA"
  echo "自动登录 : ${QQ_ACCOUNT:-自动推断}"
  echo "--- 软链视图（$QQBOT_DIR）---"
  for l in napcat napcat-media; do
    if [ -L "$QQBOT_DIR/$l" ]; then echo "  $l -> $(readlink "$QQBOT_DIR/$l")"; else echo "  $l (未创建)"; fi
  done
}

# ---------- 主入口 ----------
# QQ 账号自动推断
if [ -z "$QQ_ACCOUNT" ]; then
  QQ_ACCOUNT=$(ls "$NAPCAT_PATH/config"/onebot11_*.json 2>/dev/null | head -1 | sed -E 's/.*onebot11_([0-9]+)\.json/\1/' || true)
fi

case "${1:-$MODE}" in
  start)   mode_start ;;
  restart) mode_restart ;;
  stop)    stop_qq ;;
  link)    link_dirs ;;
  status)  status ;;
  *) echo "用法: $0 [start|restart|stop|link|status]"; exit 1 ;;
esac

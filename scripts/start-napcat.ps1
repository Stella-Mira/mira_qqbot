# ============================================================
# start-napcat.ps1 —— NapCat 一键启动/重启（Windows）
# 所有路径与账号均写在 napcat.conf（key=value），脚本只做四件事：
#   1) 在 QQBOT_DIR 生成指向 NapCat 目录的 junction 视图
#   2) 按 MODE 启动 / 重启 QQ（NapCat 随 QQ 加载）
#   3) 用 QQ_ACCOUNT 快速登录（launcher-user.bat 免扫码）
#   4) 等待 OneBot WebSocket(3001) 就绪
#
# 用法:
#   powershell -File start-napcat.ps1            # 按 napcat.conf 的 MODE 执行
#   powershell -File start-napcat.ps1 start      # 非重启模式：已在运行则跳过
#   powershell -File start-napcat.ps1 restart    # 重启模式：先关闭再启动
#   powershell -File start-napcat.ps1 stop       # 停止 QQ / NapCat
#   powershell -File start-napcat.ps1 link       # 生成/刷新 junction 视图
#   powershell -File start-napcat.ps1 status     # 查看状态
# ============================================================
param([string]$Action = '')

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 配置文件：可用 NAPCAT_CONF 环境变量指定路径（默认脚本同目录 napcat.conf）
$ConfFile = if ($env:NAPCAT_CONF) { $env:NAPCAT_CONF } else { Join-Path $ScriptDir 'napcat.conf' }

# ---------- 配置（默认值，可被 napcat.conf 覆盖） ----------
$script:MODE = 'start'
$script:QQ_PATH = ''                    # QQ 路径（留空自动从注册表推断）
$script:NAPCAT_PATH = 'D:\NapCat'
$script:NAPCAT_MEDIA = ''               # 留空 = NAPCAT_PATH\data
$script:QQ_ACCOUNT = ''                 # QQ 号（留空自动从 config\onebot11_*.json 推断）
$script:QQBOT_DIR = $ScriptDir          # qqbot 工作目录（junction 用）

function Load-Conf {
  if (Test-Path $ConfFile) {
    foreach ($line in Get-Content $ConfFile -Encoding UTF8) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith('#')) { continue }
      if ($t -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $k = $Matches[1]
        $v = $Matches[2].Trim()
        if (-not $v) { continue }  # 空值保留默认
        if ($k -in @('MODE', 'QQ_PATH', 'NAPCAT_PATH', 'NAPCAT_MEDIA', 'QQ_ACCOUNT', 'QQBOT_DIR')) {
          Set-Variable -Scope script -Name $k -Value $v
        }
      }
    }
  }
  # 相对路径一律按脚本目录解析
  foreach ($k in @('QQ_PATH', 'NAPCAT_PATH', 'NAPCAT_MEDIA', 'QQBOT_DIR')) {
    $v = (Get-Variable -Scope script -Name $k).Value
    if ($v -and -not [System.IO.Path]::IsPathRooted($v)) {
      Set-Variable -Scope script -Name $k -Value (Join-Path $ScriptDir $v)
    }
  }
  if (-not $script:NAPCAT_MEDIA) { $script:NAPCAT_MEDIA = Join-Path $script:NAPCAT_PATH 'data' }
}
Load-Conf

function Log($m) { Write-Output ("[{0}] [start-napcat] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

# ---------- 状态检查 ----------
function Test-QQRunning {
  $p = Get-Process -Name 'QQ', 'QQNT' -ErrorAction SilentlyContinue | Select-Object -First 1
  return [bool]$p
}
function Test-NapcatUp {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/' -TimeoutSec 2 -UseBasicParsing
    return $true
  } catch {
    return $false
  }
}

# ---------- junction 视图（对应 macOS 软链） ----------
function Invoke-Link {
  if (-not (Test-Path $script:QQBOT_DIR)) {
    New-Item $script:QQBOT_DIR -ItemType Directory -Force | Out-Null
  }
  $pairs = @(
    @($script:NAPCAT_PATH, 'napcat'),
    @($script:NAPCAT_MEDIA, 'napcat-media')
  )
  foreach ($pair in $pairs) {
    $target = $pair[0]
    $name = $pair[1]
    $link = Join-Path $script:QQBOT_DIR $name
    $existing = Get-Item $link -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -eq 'Junction' -and $existing.Target -and $existing.Target[0] -eq $target) {
      Log ("junction 已存在: {0}" -f $name)
      continue
    }
    if (Test-Path $link) {
      $bak = $name + '.old_' + (Get-Date -Format 'yyyyMMddHHmmss')
      Rename-Item $link $bak
      Log ("原目录已备份，替换为 junction: {0}" -f $name)
    }
    cmd /c mklink /J "$link" "$target" | Out-Null
    Log ("已生成 junction: {0} -> {1}" -f $name, $target)
  }
}

# ---------- 启动 / 停止 ----------
function Resolve-QQPath {
  if ($script:QQ_PATH -and (Test-Path $script:QQ_PATH)) { return }
  $keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ'
  )
  foreach ($k in $keys) {
    try {
      $u = (Get-ItemProperty $k -ErrorAction Stop).UninstallString
      if ($u) {
        $cand = $u.Trim('"')
        if (Test-Path $cand) { $script:QQ_PATH = $cand; return }
      }
    } catch { }
  }
}

function Resolve-Account {
  if ($script:QQ_ACCOUNT) { return }
  $cfg = Get-ChildItem (Join-Path $script:NAPCAT_PATH 'config') -Filter 'onebot11_*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cfg -and $cfg.Name -match 'onebot11_(\d+)\.json') { $script:QQ_ACCOUNT = $Matches[1] }
}

function Start-Napcat {
  Resolve-QQPath
  Resolve-Account
  if (-not $script:QQ_ACCOUNT) { Log 'ERROR: 未配置 QQ_ACCOUNT 且无法从 config\onebot11_*.json 推断'; return }
  Invoke-Link
  $launcher = Join-Path $script:NAPCAT_PATH 'launcher-user.bat'
  if (-not (Test-Path $launcher)) { Log ('ERROR: 找不到启动器: ' + $launcher); return }
  Log ('启动 NapCat（账号 ' + $script:QQ_ACCOUNT + '）')
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $launcher, $script:QQ_ACCOUNT) -WorkingDirectory $script:NAPCAT_PATH -WindowStyle Hidden
  Wait-Napcat
}

function Wait-Napcat {
  Log '等待 NapCat OneBot 就绪（最多 90 秒）…'
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-NapcatUp) { Log 'NapCat OneBot(127.0.0.1:3001) 已就绪'; return }
    Start-Sleep -Seconds 3
  }
  Log ('WARNING: 等待超时（QQ ' + $(if (Test-QQRunning) { '运行中' } else { '未运行' }) + '），可能需要手动扫码登录')
}

function Stop-Napcat {
  Get-Process -Name 'QQ', 'QQNT', 'NapCatWinBootMain' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Log 'QQ / NapCat 已停止'
}

function Show-Status {
  Write-Output '=== NapCat 状态 ==='
  Write-Output ('QQ 进程 : ' + $(if (Test-QQRunning) { '运行中' } else { '未运行' }))
  Write-Output ('NapCat  : ' + $(if (Test-NapcatUp) { '在线(WS3001)' } else { '离线' }))
  Write-Output '--- 配置 ---'
  Write-Output ('模式     : ' + $script:MODE)
  Write-Output ('QQ 路径  : ' + $script:QQ_PATH)
  Write-Output ('NapCat   : ' + $script:NAPCAT_PATH)
  Write-Output ('媒体目录 : ' + $script:NAPCAT_MEDIA)
  Write-Output ('自动登录 : ' + $(if ($script:QQ_ACCOUNT) { $script:QQ_ACCOUNT } else { '自动推断' }))
  Write-Output ('--- junction 视图（' + $script:QQBOT_DIR + '）---')
  foreach ($name in @('napcat', 'napcat-media')) {
    $link = Join-Path $script:QQBOT_DIR $name
    $item = Get-Item $link -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq 'Junction') {
      Write-Output ('  ' + $name + ' -> ' + $item.Target[0])
    } else {
      Write-Output ('  ' + $name + ' (未创建)')
    }
  }
}

# ---------- 主入口 ----------
$act = if ($Action) { $Action } else { $script:MODE }
switch ($act) {
  'start' {
    if (Test-QQRunning) {
      if (Test-NapcatUp) { Log 'QQ 与 NapCat 均已在运行，跳过启动'; Invoke-Link }
      else { Log 'WARNING: QQ 在运行但 NapCat 未响应，建议 restart' }
    } else {
      Log 'QQ 未运行，启动…'
      Start-Napcat
    }
  }
  'restart' { Stop-Napcat; Start-Napcat }
  'stop' { Stop-Napcat }
  'link' { Invoke-Link }
  'status' { Show-Status }
  default { Write-Output '用法: powershell -File start-napcat.ps1 [start|restart|stop|link|status]' }
}

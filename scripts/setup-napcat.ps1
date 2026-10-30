# ============================================================
# mira_qqbot · NapCat 一键部署脚本（Windows / PowerShell）
# 作用：把 NapCat 的 OneBot v11 WebSocket 服务配置好，
#       供 mira_qqbot 插件（运行在 DSH 里）连接接管 QQ。
#
# 用法（在 PowerShell 里）：
#   powershell -ExecutionPolicy Bypass -File setup-napcat.ps1
#   powershell -ExecutionPolicy Bypass -File setup-napcat.ps1 -Restart
#
# 可选参数：
#   -Port        OneBot WebSocket 端口，默认 3001
#   -Token       access_token；不传则读环境变量 WS_TOKEN，都没有则自动生成随机值
#   -ConfigDir   NapCat 配置目录；不传则自动探测（%APPDATA%\QQ\NapCat\config 等）
#   -Restart     配置写入后自动重启 NapCat（结束 QQ 进程并以 --no-sandbox 重新启动）
# ============================================================
[CmdletBinding()]
param(
    [int]$Port = 3001,
    [string]$Token = "",
    [string]$ConfigDir = "",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Say($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Info($msg) { Write-Host "    $msg" }
function Warn($msg) { Write-Host "    ! $msg" -ForegroundColor Yellow }

# ---- 0. 确定 access_token：参数 > 环境变量 > 自动生成随机值（不硬编码） ----
if (-not $Token) { $Token = $env:WS_TOKEN }
if (-not $Token) { $Token = [System.Guid]::NewGuid().ToString("N") }   # 32 位 hex

# ---- 1. 探测 NapCat 配置目录 ----
$candidates = @()
if ($ConfigDir) { $candidates += $ConfigDir }
$candidates += (Join-Path $env:APPDATA "QQ\NapCat\config")          # 官方文档路径
$candidates += (Join-Path $env:USERPROFILE ".config\QQ\NapCat\config")

$cfgDir = $null
foreach ($c in $candidates) { if (Test-Path $c) { $cfgDir = $c; break } }
if (-not $cfgDir) {
    Write-Host "错误：未找到 NapCat 配置目录。请确认 NapCat 已安装并至少登录运行过一次，然后用 -ConfigDir 手动指定。" -ForegroundColor Red
    exit 1
}
Info "配置目录: $cfgDir"

# ---- 2. 找 onebot11_<uin>.json（取最近修改的，即最近登录的 QQ） ----
$cfgFile = Get-ChildItem -Path $cfgDir -Filter "onebot11_*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $cfgFile) {
    Write-Host "错误：未找到 onebot11_*.json。请先启动 NapCat 并登录 QQ 以生成配置文件。" -ForegroundColor Red
    exit 1
}
$cfgPath = $cfgFile.FullName
$uin = [regex]::Match($cfgFile.Name, "onebot11_(\d+)\.json").Groups[1].Value
Info "QQ 号: $uin"
Info "配置文件: $cfgPath"

# ---- 3. 写入 OneBot v11 WebSocket 配置 ----
Say "配置 OneBot v11 WebSocket（ws://127.0.0.1:$Port）"
$d = Get-Content -Path $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $d.network) { $d | Add-Member -NotePropertyName network -NotePropertyValue ([pscustomobject]@{}) }
if (-not $d.network.websocketServers) { $d.network | Add-Member -NotePropertyName websocketServers -NotePropertyValue @() }

$ws = [pscustomobject]@{
    name                 = "mira_qqbot"
    enable               = $true
    host                 = "127.0.0.1"
    port                 = $Port
    token                = $Token
    messagePostFormat    = "array"
    reportSelfMessage    = $false
    enableForcePushEvent = $true
    heartInterval        = 30000
    enableHeart          = $true
    debug                = $false
}
# 去重：同端口已存在则替换，否则追加
$kept = @($d.network.websocketServers | Where-Object { $_.port -ne $Port })
$d.network.websocketServers = @($kept) + @($ws)

# 补齐可选顶层字段（与 NapCat 默认配置一致）
if (-not $d.musicSignUrl)          { $d | Add-Member -NotePropertyName musicSignUrl          -NotePropertyValue "" }
if (-not $d.enableLocalFile2Url)   { $d | Add-Member -NotePropertyName enableLocalFile2Url   -NotePropertyValue $false }
if (-not $d.parseMultMsg)          { $d | Add-Member -NotePropertyName parseMultMsg          -NotePropertyValue $false }

$json = $d | ConvertTo-Json -Depth 12
# 用 UTF-8 无 BOM 写回（Node 的 JSON.parse 遇到 BOM 会报错，务必无 BOM）
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cfgPath, $json, $utf8NoBom)
Info "已写入 $cfgPath"

# ---- 4. 读取 WebUI 访问令牌（不同版本文件名可能不同） ----
$webuiToken = ""
foreach ($name in @("webui.json", "WebUI.json")) {
    $p = Join-Path $cfgDir $name
    if (Test-Path $p) {
        try {
            $wd = Get-Content -Path $p -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($wd.token) { $webuiToken = $wd.token }
        } catch {}
        break
    }
}

# ---- 5. 可选：重启 NapCat 使配置生效 ----
if ($Restart) {
    Say "重启 NapCat"
    Get-Process -Name "QQ" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $qqExe = $null
    foreach ($p in @(
        (Join-Path ${env:ProgramFiles}      "Tencent\QQNT\QQ.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Tencent\QQNT\QQ.exe"),
        (Join-Path $env:LOCALAPPDATA        "Programs\QQNT\QQ.exe")
    )) {
        if (Test-Path $p) { $qqExe = $p; break }
    }
    if ($qqExe) {
        Start-Process -FilePath $qqExe -ArgumentList "--no-sandbox"
        Info "已启动: $qqExe --no-sandbox"
    } else {
        Warn "未找到 QQ.exe，请手动以 --no-sandbox 启动 QQ"
    }
}

# ---- 6. 输出结果 ----
Say "完成"
Info "OneBot WebSocket: ws://127.0.0.1:$Port"
Info "access_token: $Token"
if ($webuiToken) { Info "WebUI 访问令牌: $webuiToken" }
else             { Info "（若 WebUI 提示需要访问令牌，请查看 NapCat 的 webui.json 配置）" }
Write-Host "    （请把上面的 access_token 同步到 mira_qqbot 插件配置；如需复用，下次运行前设置 `$env:WS_TOKEN = '同一值'）"
Write-Host "    下一步：重启 dsh web 使 mira_qqbot 插件加载，然后用 qq_status 工具验证。"

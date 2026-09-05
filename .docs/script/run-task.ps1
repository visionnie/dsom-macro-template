# =====================================================================
# 操作场景：一条命令在设备上跑通当前项目的默认任务并取回结果
# 当前手动步骤：构建 -> 推送 -> 拉起 AutoJs6 -> 确认截图授权 -> 等待 -> 取回产出
# 输入参数：-Device 必填（设备地址不写进仓库）；其余见下方说明
# 失败处理：任一环节失败立即停止并打印原因；超时会打印最后一次日志
# 输出：控制台步骤摘要，产出拉取到 dist/runs/（dist 已被 .gitignore 排除）
# =====================================================================

[CmdletBinding()]
param(
    # 设备地址，例如 192.168.1.10:5555 或 <云机IP>:<端口>。
    # 按仓库规则，禁止把云机地址写进任何提交文件，因此这里不设默认值。
    [Parameter(Mandatory = $true)]
    [string]$Device,

    # 跑之前先强杀游戏，用于测试冷启动路径。
    [switch]$ColdStart,

    # 跳过 npm run build，直接用现有 dist/main-autojs.js。
    [switch]$SkipBuild,

    # 同时把 src/assets 推到设备。改过素材后需要加这个参数。
    [switch]$PushAssets,

    # 等待任务结束的上限。
    [int]$TimeoutSeconds = 300,

    # MediaProjection 授权弹窗上「立即开始」的坐标。
    # Android 10 每次运行都会弹且无法记住授权，只能自动点掉。
    # 弹窗是居中的固定尺寸卡片，横竖屏下按钮位置不同，必须分开给：
    # 游戏已在运行时屏幕是横屏，冷启动时是竖屏，点错方向就会点空。
    [int]$GrantTapPortraitX = 566,
    [int]$GrantTapPortraitY = 844,
    [int]$GrantTapLandscapeX = 920,
    [int]$GrantTapLandscapeY = 541
)

$ErrorActionPreference = 'Stop'

# Join-Path 的三参数形式是 PowerShell 7 才有的，这里按 5.1 的两参数写法。
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$config = Join-Path $projectRoot 'src/config/game-config-autojs.js'
$bundle = Join-Path $projectRoot 'dist/main-autojs.js'

function Invoke-Adb {
    param([string[]]$AdbArgs)
    & adb -s $Device @AdbArgs
}

# adb shell 在 Windows 上按 CRLF 换行，PowerShell 只按 LF 切分，
# 每个元素尾部会残留 \r。直接拼进路径会得到非法路径，必须逐行去掉。
function Get-RunIds {
    param([string]$Directory)
    $raw = Invoke-Adb @('shell', "ls $Directory 2>/dev/null")
    return @($raw | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-ConfigValue {
    param([string]$Key)
    $line = Select-String -Path $config -Pattern "$Key\s*:\s*[`"']([^`"']*)[`"']" | Select-Object -First 1
    if ($line) { return $line.Matches[0].Groups[1].Value }
    return $null
}

$taskId = Get-ConfigValue 'defaultTask'
$outputRoot = Get-ConfigValue 'outputRoot'
$packageName = Get-ConfigValue 'packageName'
$projectId = Get-ConfigValue 'id'

if (-not $taskId) { throw "未能从配置读出 defaultTask" }
if (-not $projectId) { throw "未能从配置读出 project.id" }

# 配置里的 assetsRoot 是 ./assets，相对当前脚本解析。
# 因此设备上脚本与素材必须放在同一目录，打包成 APK 后两者同样同级，形态一致。
$deviceDir = "/sdcard/dsom-macro-$projectId"
$deviceScript = "$deviceDir/main-autojs.js"
Write-Host "任务: $taskId   设备: $Device" -ForegroundColor Cyan
Write-Host "（要换任务，改 src/config/game-config-autojs.js 的 defaultTask）"

# ---- 连接 ----
& adb connect $Device | Out-Null
$state = (& adb -s $Device get-state) 2>$null
if ($state -notmatch 'device') { throw "设备未就绪: $Device（状态 $state）" }

# ---- 构建与推送 ----
if (-not $SkipBuild) {
    Push-Location $projectRoot
    try {
        npm run check
        if ($LASTEXITCODE -ne 0) { throw "npm run check 未通过" }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build 未通过" }
    }
    finally { Pop-Location }
}
if (-not (Test-Path $bundle)) { throw "找不到构建产物: $bundle" }
Invoke-Adb @('shell', "mkdir -p $deviceDir") | Out-Null
Invoke-Adb @('push', $bundle, $deviceScript) | Out-Null

if ($PushAssets) {
    # 素材与用例都是外部数据文件，改动后都需要重新推。
    # assetsRoot 在配置里是 ./assets，用例引擎按 files.path("cases/...") 找 JSON，
    # 两者都必须与推送后的 main.js 同级。
    foreach ($dataDir in @('assets', 'cases')) {
        $local = Join-Path $projectRoot ('src/' + $dataDir)
        if (-not (Test-Path $local)) { continue }
        Invoke-Adb @('shell', "rm -rf $deviceDir/$dataDir") | Out-Null
        Invoke-Adb @('push', $local, "$deviceDir/") | Out-Null
        Write-Host "已推送 $dataDir/ 到 $deviceDir/$dataDir"
    }
}

# ---- 记录起跑线，用于识别本次新产生的运行目录 ----
$runDir = "$outputRoot/$taskId"
$before = Get-RunIds $runDir

if ($ColdStart -and $packageName) {
    Invoke-Adb @('shell', "am force-stop $packageName") | Out-Null
    Write-Host "已强杀 $packageName（冷启动）"
}

# ---- 拉起 AutoJs6 并执行 ----
Invoke-Adb @('shell', 'am force-stop org.autojs.autojs6') | Out-Null
Start-Sleep -Seconds 2
Invoke-Adb @('shell', 'monkey', '-p', 'org.autojs.autojs6', '-c', 'android.intent.category.LAUNCHER', '1') | Out-Null
Start-Sleep -Seconds 4
Invoke-Adb @(
    'shell', 'am', 'start',
    '-n', 'org.autojs.autojs6/org.autojs.autojs.external.open.RunIntentActivity',
    '-a', 'android.intent.action.VIEW',
    '-d', "file://$deviceScript",
    '-t', 'application/x-javascript'
) | Out-Null
Write-Host "已启动，等待截图授权弹窗..."

# ---- 自动确认截图授权 ----
$granted = $false
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 3
    $focus = Invoke-Adb @('shell', 'dumpsys window | grep mCurrentFocus | tail -1')
    if ($focus -match 'MediaProjectionPermissionActivity') {
        # 按当前旋转方向选坐标。ROTATION_0 为竖屏，ROTATION_90/270 为横屏。
        $rotation = Invoke-Adb @('shell', "dumpsys window | grep -oE 'mRotation=ROTATION_[0-9]+' | head -1")
        if ($rotation -match 'ROTATION_(90|270)') {
            $tapX = $GrantTapLandscapeX; $tapY = $GrantTapLandscapeY; $orientation = '横屏'
        }
        else {
            $tapX = $GrantTapPortraitX; $tapY = $GrantTapPortraitY; $orientation = '竖屏'
        }
        Invoke-Adb @('shell', 'input', 'tap', "$tapX", "$tapY") | Out-Null
        Write-Host "已确认截图授权（T+$($i * 3)s，$orientation $tapX,$tapY）"
        $granted = $true
        break
    }
}
if (-not $granted) {
    Write-Host "未出现授权弹窗，可能权限仍在有效期内，继续等待任务结束" -ForegroundColor Yellow
}

# ---- 等待新的运行目录出现且写完 result.json ----
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$newRun = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $now = Get-RunIds $runDir
    $candidates = @($now | Where-Object { $before -notcontains $_ })
    if ($candidates.Count -gt 0) {
        # 只有一个元素时 Sort-Object 返回的是字符串标量而非数组，
        # 此时 [-1] 取到的是最后一个字符而不是最后一个元素。用 Select-Object 才安全。
        $candidate = $candidates | Sort-Object | Select-Object -Last 1
        $hasResult = Get-RunIds "$runDir/$candidate/result.json"
        if ($hasResult.Count -gt 0) { $newRun = $candidate; break }
    }
}

if (-not $newRun) {
    Write-Host "等待超时，未取到 result.json。最后的日志：" -ForegroundColor Red
    Invoke-Adb @('shell', "logcat -d -t 200 | grep GlobalConsole | tail -15")
    exit 1
}

# ---- 取回产出并汇报 ----
$localDir = Join-Path $projectRoot "dist/runs/$taskId"
New-Item -ItemType Directory -Force $localDir | Out-Null
Invoke-Adb @('pull', "$runDir/$newRun", $localDir) | Out-Null

$resultPath = Join-Path $localDir "$newRun/result.json"
$result = Get-Content $resultPath -Encoding UTF8 -Raw | ConvertFrom-Json

Write-Host ""
$statusColor = if ($result.status -eq 'passed') { 'Green' } else { 'Red' }
Write-Host "结果: $($result.status)   耗时: $([math]::Round($result.durationMs / 1000, 2)) 秒" -ForegroundColor $statusColor
foreach ($step in $result.steps) {
    $mark = if ($step.status -eq 'passed') { '通过' } else { $step.status }
    Write-Host ("  [{0}] {1}  （尝试 {2} 次）" -f $mark, $step.name, $step.attempts)
}
if ($result.error) {
    Write-Host ""
    Write-Host "失败原因: $($result.error.Split("`n")[0])" -ForegroundColor Red
    if ($result.failureScreenshot) {
        Write-Host "失败截图已随产出取回"
    }
}
Write-Host ""
Write-Host "产出目录: $localDir\$newRun"

if ($result.status -ne 'passed') { exit 1 }

# =====================================================================
# 操作场景：生成 AutoJs6 项目、推到手机、等待手机上打包完成后自动安装
# 当前手动步骤：打包动作只能在手机的 AutoJs6 里点，本脚本负责其前后两段
# 输入参数：-Device 必填（设备地址不写进仓库）；其余见下方说明
# 失败处理：任一环节失败立即停止；等待打包超时会提示并退出
# 输出：控制台提示与安装结果
# =====================================================================

[CmdletBinding()]
param(
    # 设备地址，例如 192.168.1.10:5555 或 <云机IP>:<端口>。
    # 按仓库规则，禁止把云机地址写进任何提交文件，因此不设默认值。
    [Parameter(Mandatory = $true)]
    [string]$Device,

    # 跳过 npm run project，直接用现有的 dist/project。
    [switch]$SkipGenerate,

    # 打包完成后自动安装到设备。
    [switch]$Install,

    # 安装后立即启动（隐含 -Install）。
    [switch]$Launch,

    # 把 APK 从手机拉回 dist/apk/。打包产物本来只存在于手机上，
    # 只有需要分发或存档时才拉回来（40MB 走公网要几十秒）。
    [switch]$PullApk,

    # 等待手机上完成打包的上限（分钟）。
    [int]$WaitMinutes = 10
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$projectDir = Join-Path $projectRoot 'dist\project'

function Invoke-Adb {
    param([string[]]$AdbArgs)
    & adb -s $Device @AdbArgs
}

# adb shell 的输出按行返回，尾部可能带空白；同时单元素结果会退化成标量，
# 统一整成去空的字符串数组，避免后续 [-1] 之类取到字符而不是元素。
function Get-DeviceLines {
    param([string]$ShellCommand)
    $raw = Invoke-Adb @('shell', $ShellCommand)
    return @($raw | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

if ($Launch) { $Install = $true }

# ---- 生成项目 ----
if (-not $SkipGenerate) {
    Push-Location $projectRoot
    try {
        npm run project
        if ($LASTEXITCODE -ne 0) { throw "npm run project 未通过" }
    }
    finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $projectDir 'project.json'))) {
    throw "找不到 dist/project/project.json，请先执行 npm run project"
}

$projectConfig = Get-Content (Join-Path $projectDir 'project.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$appName = $projectConfig.name
$packageName = $projectConfig.packageName
$versionName = $projectConfig.versionName
$deviceDirName = (Split-Path $projectRoot -Leaf) -replace '^dsom-macro-', ''
$deviceDir = "/sdcard/$deviceDirName-project"
$buildDir = "$deviceDir/build"

Write-Host "应用: $appName $versionName   包名: $packageName" -ForegroundColor Cyan
Write-Host "支持库: $($projectConfig.libs -join ', ')   ABI: $($projectConfig.abis -join ', ')"

# ---- 连接并推送 ----
& adb connect $Device | Out-Null
$state = (& adb -s $Device get-state) 2>$null
if ($state -notmatch 'device') { throw "设备未就绪: $Device（状态 $state）" }

# 连 build/ 一起清空。版本号不变时新包与旧包同名，靠文件名比对判断不出是否重新打过，
# 清空后目录里出现的任何 APK 都必然是本次产物。build/ 本就是可再生的构建输出。
Invoke-Adb @('shell', "rm -rf $deviceDir") | Out-Null
Invoke-Adb @('shell', "mkdir -p $deviceDir") | Out-Null
# adb push 不做通配符展开，逐个推送顶层条目。
foreach ($item in Get-ChildItem $projectDir) {
    Invoke-Adb @('push', $item.FullName, "$deviceDir/") | Out-Null
}
if ((Get-DeviceLines "ls $deviceDir/project.json 2>/dev/null").Count -eq 0) {
    throw "推送后设备上找不到 $deviceDir/project.json，推送未成功"
}
Write-Host "已推送项目到 $deviceDir"

# ---- 提示手机上的手工步骤 ----
Write-Host ""
Write-Host "请在手机上完成打包（AutoJs6 未提供命令行打包入口）：" -ForegroundColor Yellow
Write-Host "  1. 打开 AutoJs6，切到「文件」页"
Write-Host "  2. 点右上角的跳转箭头回到 /sdcard 根目录"
Write-Host "  3. 找到 $deviceDirName-project（蓝色项目图标），点它右侧的三点菜单"
Write-Host "  4. 选「打包应用」，确认配置后点右下角的打包按钮"
Write-Host ""
Write-Host "配置已由 project.json 预填，OpenCV 与 ABI 都已勾好，直接点打包即可。"
Write-Host "等待中，最多 $WaitMinutes 分钟..." -ForegroundColor Yellow

# ---- 等待新 APK 出现 ----
$deadline = (Get-Date).AddMinutes($WaitMinutes)
$newApk = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $candidates = @(Get-DeviceLines "ls $buildDir 2>/dev/null" | Where-Object { $_ -like '*.apk' })
    if ($candidates.Count -gt 0) {
        $newApk = $candidates | Sort-Object | Select-Object -Last 1
        break
    }
}

if (-not $newApk) {
    Write-Host "等待超时，$buildDir 下没有出现新的 APK。" -ForegroundColor Red
    Write-Host "如果手机上已经打包成功，可加 -SkipGenerate 重跑，或直接手动安装：" -ForegroundColor Red
    Write-Host "  adb -s $Device shell pm install -r $buildDir/<文件名>.apk"
    exit 1
}

$apkPath = "$buildDir/$newApk"

# APK 文件一出现就去装会装到半成品：实测在写到约 19MB 时就能被 ls 看到，
# 直接 pm install 会报 Failed to parse APK file。等文件大小连续两次不变再继续。
Write-Host ""
Write-Host "发现 APK，等待写入完成..." -ForegroundColor Cyan
$lastSize = -1
$stableDeadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $stableDeadline) {
    $sizeText = (Get-DeviceLines "stat -c %s $apkPath 2>/dev/null" | Select-Object -First 1)
    $currentSize = 0
    if ($sizeText -and [int64]::TryParse($sizeText, [ref]$currentSize)) {
        if ($currentSize -gt 0 -and $currentSize -eq $lastSize) { break }
        $lastSize = $currentSize
    }
    Start-Sleep -Seconds 5
}

Write-Host "打包完成: $apkPath" -ForegroundColor Green
Write-Host "  大小: $([math]::Round($lastSize / 1MB, 1)) MB"
Write-Host "  注意：APK 生成在手机上，PC 上没有 build 目录。需要拉回请加 -PullApk。"

if ($PullApk) {
    $localApkDir = Join-Path $projectRoot 'dist\apk'
    New-Item -ItemType Directory -Force $localApkDir | Out-Null
    Invoke-Adb @('pull', $apkPath, $localApkDir) | Out-Null
    $localApk = Join-Path $localApkDir $newApk
    if (-not (Test-Path $localApk)) { throw "拉取 APK 失败: $apkPath" }
    Write-Host "已拉回: $localApk" -ForegroundColor Green
}

# ---- 安装 ----
if (-not $Install) {
    Write-Host ""
    Write-Host "未指定 -Install。需要安装时执行："
    Write-Host "  adb -s $Device shell pm install -r $apkPath"
    exit 0
}

Write-Host ""
Write-Host "正在安装..." -ForegroundColor Cyan
# APK 已在设备上，直接从设备路径安装，不必回传，省掉几十兆的公网传输。
# 2>&1 放在设备侧 shell 里做：PowerShell 不会把原生命令的 stderr 收进变量，
# 失败信息若留在 stderr 就会被判成空，误报为成功。
$installResult = (Invoke-Adb @('shell', "pm install -r $apkPath 2>&1")) -join "`n"
if ($installResult -notlike '*Success*') {
    Write-Host "安装失败:" -ForegroundColor Red
    Write-Host $installResult
    exit 1
}

$installed = Get-DeviceLines "dumpsys package $packageName | grep versionName"
Write-Host "安装成功: $packageName" -ForegroundColor Green
Write-Host "  $installed"

if ($Launch) {
    Invoke-Adb @('shell', 'monkey', '-p', $packageName, '-c', 'android.intent.category.LAUNCHER', '1') | Out-Null
    Write-Host ""
    Write-Host "已启动。注意：首次运行仍需在手机上确认截图授权弹窗。" -ForegroundColor Yellow
}

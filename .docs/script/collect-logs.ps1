# =====================================================================
# 操作场景：把设备上最近几次运行的日志、结果和截图拉回本地，用于排查问题
# 当前手动步骤：列出各任务的运行目录 -> 取最近 N 次 -> 拉回 -> 打印摘要
# 输入参数：-Device 必填；-Count 每个任务取几次，默认 1；-Task 只取指定任务
# 失败处理：设备不可达或没有任何运行记录时提示并退出
# 输出：dist/runs/<任务ID>/<运行ID>/，以及控制台摘要
# =====================================================================

[CmdletBinding()]
param(
    # 设备地址。按仓库规则，云机地址禁止写进提交文件，故不设默认值。
    [Parameter(Mandatory = $true)]
    [string]$Device,

    # 每个任务拉最近几次运行。
    [int]$Count = 1,

    # 只拉指定任务，省略则拉全部任务。
    [string]$Task
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$config = Join-Path $projectRoot 'src/config/game-config-autojs.js'

function Invoke-Adb {
    param([string[]]$AdbArgs)
    & adb -s $Device @AdbArgs
}

# adb shell 的输出可能带尾随空白，单元素结果还会退化成标量，统一整成去空数组。
function Get-DeviceLines {
    param([string]$ShellCommand)
    $raw = Invoke-Adb @('shell', $ShellCommand)
    return @($raw | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

$outputRootMatch = Select-String -Path $config -Pattern "outputRoot\s*:\s*[`"']([^`"']*)[`"']" | Select-Object -First 1
if (-not $outputRootMatch) { throw "未能从配置读出 outputRoot" }
$outputRoot = $outputRootMatch.Matches[0].Groups[1].Value

& adb connect $Device | Out-Null
$state = (& adb -s $Device get-state) 2>$null
if ($state -notmatch 'device') { throw "设备未就绪: $Device（状态 $state）" }

$taskIds = if ($Task) { @($Task) } else { Get-DeviceLines "ls $outputRoot 2>/dev/null" }
if ($taskIds.Count -eq 0) {
    Write-Host "设备上没有任何运行记录: $outputRoot" -ForegroundColor Yellow
    exit 0
}

$pulled = 0
foreach ($taskId in $taskIds) {
    # ls -t 按时间倒序，取前 Count 个即最近几次。
    $runIds = @(Get-DeviceLines "ls -t $outputRoot/$taskId 2>/dev/null" | Select-Object -First $Count)
    if ($runIds.Count -eq 0) { continue }

    foreach ($runId in $runIds) {
        $localDir = Join-Path $projectRoot "dist\runs\$taskId"
        New-Item -ItemType Directory -Force $localDir | Out-Null
        Invoke-Adb @('pull', "$outputRoot/$taskId/$runId", $localDir) | Out-Null

        $resultPath = Join-Path $localDir "$runId\result.json"
        Write-Host ""
        if (-not (Test-Path $resultPath)) {
            # 没有 result.json 说明这次运行还没结束，或者进程被杀在了 finally 之前。
            Write-Host "[$taskId/$runId] 无 result.json（运行未结束或被中断）" -ForegroundColor Yellow
            continue
        }

        $result = Get-Content $resultPath -Encoding UTF8 -Raw | ConvertFrom-Json
        $color = if ($result.status -eq 'passed') { 'Green' } else { 'Red' }
        Write-Host ("[{0}] {1}  {2} 秒" -f $result.status, $result.taskName, [math]::Round($result.durationMs / 1000, 2)) -ForegroundColor $color
        Write-Host "  运行 ID: $runId   设备: $($result.device.width)x$($result.device.height)"
        foreach ($step in $result.steps) {
            Write-Host ("    [{0}] {1}  （尝试 {2} 次）" -f $step.status, $step.name, $step.attempts)
        }
        if ($result.error) {
            Write-Host "  失败原因: $($result.error.Split("`n")[0])" -ForegroundColor Red
        }
        $pulled++
    }
}

Write-Host ""
Write-Host "已拉回 $pulled 次运行，位于 $projectRoot\dist\runs\"
Write-Host "每次运行包含 latest.log（逐步日志）、result.json（结构化结果）和阶段/失败截图。"

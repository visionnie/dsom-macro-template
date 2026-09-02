# =====================================================================
# 操作场景：把当前项目改动提交并推送到当前分支
# 当前手动步骤：
#   1. git add -A
#   2. git commit -m "..."
#   3. git push（首次需要 -u origin <branch>）
# 输入参数：
#   $Message — 必填，commit 信息
# 失败处理：
#   - 无改动：提示后正常退出（exit 0）
#   - commit / push 失败：立刻退出（exit 1）
# 输出：commit 哈希 + 推送结果摘要
# =====================================================================

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Message
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $projectRoot

$dirty = git status --porcelain
if (-not $dirty) {
    Write-Host "[OK] 工作区干净，无需提交" -ForegroundColor Green
    exit 0
}

Write-Host "-> git add -A" -ForegroundColor Cyan
git add -A
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "-> git commit" -ForegroundColor Cyan
git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] commit 失败（可能 pre-commit hook 拦截）" -ForegroundColor Red
    exit 1
}

$branch = (git branch --show-current).Trim()
$hash   = (git rev-parse --short HEAD).Trim()

$null = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
$hasUpstream = ($LASTEXITCODE -eq 0)
if (-not $hasUpstream) {
    Write-Host "-> git push -u origin $branch（首次推送）" -ForegroundColor Cyan
    git push -u origin $branch
} else {
    Write-Host "-> git push" -ForegroundColor Cyan
    git push
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] push 失败" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[OK] 已提交并推送" -ForegroundColor Green
Write-Host "  分支：$branch"
Write-Host "  哈希：$hash"
Write-Host "  信息：$Message"

# scripts/dev-api-local.ps1
# 本地开发启动器：用「项目外部」的真实配置（含 API key）启动代理，避免真实密钥进入本仓库/归档。
#
# 为什么需要它：
#   - server/config.json 是提交/归档用的「空 key 模板」（providerReady=false）。
#   - 真实 key 放在仓库之外（默认 $env:USERPROFILE\.medical-prep\config.local.json），
#     通过 index.ts 已支持的 MHP_CONFIG_PATH 注入（见 server/index.ts:406）。
#
# 用法：
#   npm run dev:api:local
#   或  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-api-local.ps1
#
# 首次准备（仅在还没有外部配置时）：
#   Copy-Item server/config.json "$env:USERPROFILE\.medical-prep\config.local.json"
#   然后在该文件里填入真实的 llm.apiKey。

$ErrorActionPreference = 'Stop'

if (-not $env:MHP_CONFIG_PATH) {
  $env:MHP_CONFIG_PATH = Join-Path $env:USERPROFILE '.medical-prep\config.local.json'
}
if (-not (Test-Path -LiteralPath $env:MHP_CONFIG_PATH)) {
  Write-Error "未找到外部配置：$env:MHP_CONFIG_PATH。请先复制 server/config.json 到该路径并填入 llm.apiKey。"
  exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Write-Host "[dev-api-local] MHP_CONFIG_PATH=$($env:MHP_CONFIG_PATH)"
Set-Location -LiteralPath $repoRoot
node server/index.ts

param(
    [string]$MediaMtxExe = "mediamtx.exe",
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\\config\\mediamtx.yml")
)

$ErrorActionPreference = 'Stop'

$resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
Write-Host "Starting MediaMTX with $resolvedConfigPath" -ForegroundColor Cyan

& $MediaMtxExe $resolvedConfigPath

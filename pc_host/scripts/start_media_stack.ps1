#requires -Version 7.0

param(
    [string]$MediaMtxExe = "mediamtx.exe",
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\\config\\mediamtx.yml")
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot "runtime_path_helpers.ps1")

$resolvedMediaMtxExe = Resolve-ExecutablePath -ExecutableName $MediaMtxExe -WingetPackagePrefix "bluenviron.mediamtx"
$resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
Write-Host "Using MediaMTX executable: $resolvedMediaMtxExe" -ForegroundColor Cyan
Write-Host "Starting MediaMTX with $resolvedConfigPath" -ForegroundColor Cyan

& $resolvedMediaMtxExe $resolvedConfigPath

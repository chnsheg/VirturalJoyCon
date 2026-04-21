param(
    [string]$FfmpegExe = "ffmpeg.exe",
    [string]$WhipUrl = "http://127.0.0.1:8889/game/whip",
    [int]$Width = 1280,
    [int]$Height = 720,
    [int]$Fps = 60,
    [string]$VideoDevice = "desktop",
    [string]$AudioDevice = "virtual-audio-capturer"
)

$ErrorActionPreference = 'Stop'

& $FfmpegExe `
    -f ddagrab `
    -framerate $Fps `
    -video_size "$Width`x$Height" `
    -i $VideoDevice `
    -f wasapi `
    -i $AudioDevice `
    -c:v h264_nvenc `
    -tune ull `
    -bf 0 `
    -g 30 `
    -c:a opus `
    -f whip `
    $WhipUrl

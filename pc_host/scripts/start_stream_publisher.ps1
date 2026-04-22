param(
    [string]$FfmpegExe = "ffmpeg.exe",
    [string]$WhipUrl = "http://127.0.0.1:8889/game/whip",
    [int]$Width = 1280,
    [int]$Height = 720,
    [int]$Fps = 60,
    [string]$VideoDevice = "ddagrab",
    [string]$VideoEncoder = "h264_nvenc",
    [string]$AudioDevice = "virtual-audio-capturer"
)

$ErrorActionPreference = 'Stop'
$videoSource = if ($VideoDevice -eq "desktop" -or $VideoDevice -eq "ddagrab") {
    "ddagrab=framerate=$Fps:video_size=$Width`x$Height"
} else {
    "$VideoDevice=framerate=$Fps:video_size=$Width`x$Height"
}

if ($VideoEncoder -eq "h264_nvenc") {
    & $FfmpegExe `
        -f lavfi `
        -i $videoSource `
        -f wasapi `
        -i $AudioDevice `
        -c:v h264_nvenc `
        -tune ull `
        -bf 0 `
        -g 30 `
        -c:a opus `
        -f whip `
        $WhipUrl
} elseif ($VideoEncoder -eq "libx264") {
    & $FfmpegExe `
        -f lavfi `
        -i $videoSource `
        -f wasapi `
        -i $AudioDevice `
        -c:v libx264 `
        -preset ultrafast `
        -tune zerolatency `
        -bf 0 `
        -g 30 `
        -c:a opus `
        -f whip `
        $WhipUrl
} else {
    throw "Unsupported VideoEncoder '$VideoEncoder'. Use h264_nvenc or libx264."
}

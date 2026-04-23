#requires -Version 7.0

param(
    [string]$FfmpegExe = "ffmpeg.exe",
    [Alias("WhipUrl")]
    [string]$PublishUrl = "rtsp://127.0.0.1:8554/game",
    [ValidateSet("rtsp", "whip")]
    [string]$PublishTransport = "rtsp",
    [int]$Width = 1280,
    [int]$Height = 720,
    [int]$Fps = 60,
    [int]$VideoBitrateKbps = 6000,
    [string]$VideoDevice = "gfxcapture",
    [string]$VideoEncoder = "h264_nvenc",
    [string]$AudioDevice = ""
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot "runtime_path_helpers.ps1")

function Get-DshowAudioDevices {
    param(
        [string]$FfmpegExe
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $rawLines = & $FfmpegExe -hide_banner -f dshow -list_devices true -i dummy 2>&1
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    $lines = foreach ($line in $rawLines) {
        if ($line -is [System.Management.Automation.ErrorRecord]) {
            $line.Exception.Message
        } else {
            "$line"
        }
    }

    $devices = @()
    foreach ($line in $lines) {
        if ("$line" -match '"(.+)" \(audio\)$') {
            $devices += [pscustomobject]@{
                DisplayName = $matches[1]
                DeviceId    = $null
            }
            continue
        }

        if ("$line" -match 'Alternative name "(.+)"' -and $devices.Count -gt 0) {
            $devices[$devices.Count - 1].DeviceId = $matches[1]
        }
    }

    return $devices
}

function Get-PreferredAudioDevice {
    param(
        [string]$FfmpegExe,
        [string]$RequestedAudioDevice
    )

    if ($RequestedAudioDevice) {
        return $RequestedAudioDevice
    }

    $devices = @(Get-DshowAudioDevices -FfmpegExe $FfmpegExe)
    if (-not $devices -or $devices.Count -eq 0) {
        throw "No DirectShow audio capture devices detected. Pass -AudioDevice with a valid dshow device name."
    }

    $preferredPatterns = @(
        'virtual',
        'loopback',
        'stereo mix',
        'mix',
        'speaker',
        'output',
        'monitor'
    )
    foreach ($pattern in $preferredPatterns) {
        $preferred = $devices | Where-Object { $_.DisplayName -match $pattern } | Select-Object -First 1
        if ($preferred) {
            return (Get-DshowDeviceSelector -Device $preferred)
        }
    }

    $avoidPatterns = @(
        'realtek',
        'microphone',
        'mic',
        'camera',
        'webcam',
        'array'
    )
    $nonPhysical = $devices | Where-Object {
        $deviceName = $_.DisplayName
        -not ($avoidPatterns | Where-Object { $deviceName -match $_ } | Select-Object -First 1)
    } | Select-Object -First 1
    if ($nonPhysical) {
        return (Get-DshowDeviceSelector -Device $nonPhysical)
    }

    return (Get-DshowDeviceSelector -Device $devices[0])
}

function Format-DshowAudioSource {
    param(
        [string]$AudioDevice
    )

    if ($AudioDevice -match '^audio=') {
        return $AudioDevice
    }

    return "audio=$AudioDevice"
}

function Get-DshowDeviceSelector {
    param(
        $Device
    )

    if ($null -ne $Device.DeviceId -and "$($Device.DeviceId)") {
        return $Device.DeviceId
    }

    return $Device.DisplayName
}

function Get-SavedStreamSettings {
    if (-not (Test-Path -LiteralPath $script:StreamSettingsPath)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $script:StreamSettingsPath -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "Ignoring unreadable stream settings file at $script:StreamSettingsPath"
        return $null
    }
}

$script:RuntimeDir = Join-Path (Join-Path $PSScriptRoot "..") ".runtime"
$script:StreamSettingsPath = Join-Path $script:RuntimeDir "stream_settings.json"
$script:ActiveStreamSettingsPath = Join-Path $script:RuntimeDir "stream_settings.active.json"

function Normalize-EvenDimension {
    param(
        [int]$Value,
        [int]$Minimum,
        [int]$Maximum
    )

    $clamped = [Math]::Max($Minimum, [Math]::Min($Maximum, [int]$Value))
    return [int]($clamped - ($clamped % 2))
}

function Normalize-BitrateKbps {
    param(
        [int]$Value,
        [int]$Minimum,
        [int]$Maximum
    )

    $clamped = [Math]::Max($Minimum, [Math]::Min($Maximum, [int]$Value))
    $rounded = [int]([Math]::Round($clamped / 100.0, 0, [System.MidpointRounding]::AwayFromZero) * 100)
    return [Math]::Max($Minimum, [Math]::Min($Maximum, $rounded))
}

function Get-StreamSettingsFingerprint {
    param(
        [string]$SettingsPath
    )

    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        return ""
    }

    return (Get-FileHash -LiteralPath $SettingsPath -Algorithm SHA256).Hash
}

function Get-EffectiveStreamProfile {
    $savedStreamSettings = Get-SavedStreamSettings
    $effectiveWidth = $Width
    $effectiveHeight = $Height
    $effectiveFps = $Fps
    $effectiveBitrateKbps = $VideoBitrateKbps

    if ($null -ne $savedStreamSettings) {
        if ($savedStreamSettings.PSObject.Properties.Name -contains "width") {
            $effectiveWidth = [int]$savedStreamSettings.width
        }
        if ($savedStreamSettings.PSObject.Properties.Name -contains "height") {
            $effectiveHeight = [int]$savedStreamSettings.height
        }
        if ($savedStreamSettings.PSObject.Properties.Name -contains "fps") {
            $effectiveFps = [int]$savedStreamSettings.fps
        }
        if ($savedStreamSettings.PSObject.Properties.Name -contains "bitrateKbps") {
            $effectiveBitrateKbps = [int]$savedStreamSettings.bitrateKbps
        }
    }

    $effectiveWidth = Normalize-EvenDimension -Value $effectiveWidth -Minimum 640 -Maximum 3840
    $effectiveHeight = Normalize-EvenDimension -Value $effectiveHeight -Minimum 360 -Maximum 2160
    $effectiveFps = [Math]::Max(24, [Math]::Min(60, [int]$effectiveFps))
    $effectiveBitrateKbps = Normalize-BitrateKbps -Value $effectiveBitrateKbps -Minimum 1500 -Maximum 50000

    return [ordered]@{
        Width            = [int]$effectiveWidth
        Height           = [int]$effectiveHeight
        Fps              = [int]$effectiveFps
        VideoBitrateKbps = [int]$effectiveBitrateKbps
    }
}

function New-VideoInputArgs {
    param(
        [int]$Width,
        [int]$Height,
        [int]$Fps,
        [string]$VideoDevice
    )

    $videoFilterArgs = @()
    $videoArgs = if ($VideoDevice -eq "desktop" -or $VideoDevice -eq "ddagrab") {
        @(
            "-f",
            "lavfi",
            "-i",
            "ddagrab=framerate=${Fps}:video_size=${Width}`x${Height}:draw_mouse=0"
        )
    } elseif ($VideoDevice -eq "gfxcapture") {
        @(
            "-f",
            "lavfi",
            "-i",
            "gfxcapture=monitor_idx=0:max_framerate=${Fps}:width=${Width}:height=${Height}:capture_cursor=0:resize_mode=scale:scale_mode=bilinear"
        )
    } elseif ($VideoDevice -eq "gdigrab") {
        $videoFilterArgs = @(
            "-vf",
            "scale=${Width}:${Height}:flags=fast_bilinear"
        )
        @(
            "-f",
            "gdigrab",
            "-framerate",
            "$Fps",
            "-draw_mouse",
            "0",
            "-i",
            "desktop"
        )
    } else {
        @(
            "-f",
            "lavfi",
            "-i",
            "${VideoDevice}=framerate=${Fps}:video_size=${Width}`x${Height}"
        )
    }

    return @{
        VideoArgs       = $videoArgs
        VideoFilterArgs = $videoFilterArgs
    }
}

function New-EncoderArgs {
    param(
        [string]$VideoEncoder,
        [int]$VideoBitrateKbps,
        [int]$Fps
    )

    $videoBitrate = "${VideoBitrateKbps}k"
    $videoBufferKbps = [Math]::Max(600, [int][Math]::Round($VideoBitrateKbps * 0.15))
    $videoBuffer = "${videoBufferKbps}k"
    $targetGopFrames = [Math]::Max(24, [Math]::Min(120, [int]$Fps))

    if ($VideoEncoder -eq "h264_nvenc") {
        return @(
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p1",
            "-tune",
            "ull",
            "-rc",
            "cbr_ld_hq",
            "-b:v",
            $videoBitrate,
            "-maxrate",
            $videoBitrate,
            "-bufsize",
            $videoBuffer,
            "-rc-lookahead",
            "0",
            "-delay",
            "0",
            "-zerolatency",
            "1",
            "-bf",
            "0",
            "-g",
            "$targetGopFrames"
        )
    }

    if ($VideoEncoder -eq "libx264") {
        return @(
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-bf",
            "0",
            "-g",
            "$targetGopFrames"
        )
    }

    throw "Unsupported VideoEncoder '$VideoEncoder'. Use h264_nvenc or libx264."
}

function New-FfmpegArgumentList {
    param(
        [System.Collections.IDictionary]$Profile
    )

    $videoInput = New-VideoInputArgs `
        -Width $Profile.Width `
        -Height $Profile.Height `
        -Fps $Profile.Fps `
        -VideoDevice $VideoDevice
    $encoderArgs = New-EncoderArgs -VideoEncoder $VideoEncoder -VideoBitrateKbps $Profile.VideoBitrateKbps -Fps $Profile.Fps

    return @(
        $videoInput.VideoArgs +
        $script:AudioArgs +
        $videoInput.VideoFilterArgs +
        $encoderArgs +
        $script:PublishArgs
    )
}

function Write-ActiveStreamSettings {
    param(
        [System.Collections.IDictionary]$Profile
    )

    New-Item -ItemType Directory -Path $script:RuntimeDir -Force | Out-Null
    [ordered]@{
        width       = [int]$Profile.Width
        height      = [int]$Profile.Height
        fps         = [int]$Profile.Fps
        bitrateKbps = [int]$Profile.VideoBitrateKbps
    } | ConvertTo-Json | Set-Content -LiteralPath $script:ActiveStreamSettingsPath -Encoding UTF8
}

function Clear-ActiveStreamSettings {
    if (Test-Path -LiteralPath $script:ActiveStreamSettingsPath) {
        Remove-Item -LiteralPath $script:ActiveStreamSettingsPath -Force
    }
}

function Start-PublisherProcess {
    param(
        [string]$ExecutablePath,
        [string[]]$Arguments
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $ExecutablePath
    $startInfo.UseShellExecute = $false
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $null = $process.Start()
    return $process
}

function Stop-PublisherProcess {
    param(
        $Process
    )

    if ($null -eq $Process) {
        return
    }

    try {
        if (-not $Process.HasExited) {
            $Process.Kill($true)
        }
    } catch {}

    try {
        $Process.WaitForExit()
    } catch {}

    try {
        $Process.Dispose()
    } catch {}

    Clear-ActiveStreamSettings
}

# Runtime conventions for the low-latency publisher:
# NVENC path: -tune ull -rc cbr_ld_hq -zerolatency 1 -rc-lookahead 0 -delay 0
# x264 fallback: -pix_fmt yuv420p -preset ultrafast -tune zerolatency
# Ingest transports: -f rtsp -rtsp_transport udp rtsp://127.0.0.1:8554/game ; -f whip
# Audio/video inputs: -f dshow audio=... ; -an

$resolvedFfmpegExe = Resolve-ExecutablePath -ExecutableName $FfmpegExe -WingetPackagePrefix "Gyan.FFmpeg.Essentials"
$script:AudioArgs = @("-an")
$resolvedAudioDevice = $null
if ($AudioDevice) {
    $requestedAudioDevice = if ($AudioDevice -eq "auto") { "" } else { $AudioDevice }
    $resolvedAudioDevice = Get-PreferredAudioDevice -FfmpegExe $resolvedFfmpegExe -RequestedAudioDevice $requestedAudioDevice
    $audioSource = Format-DshowAudioSource -AudioDevice $resolvedAudioDevice
    $script:AudioArgs = @(
        "-f",
        "dshow",
        "-i",
        $audioSource,
        "-c:a",
        "libopus"
    )
}

if ($PublishTransport -eq "whip" -and -not $PSBoundParameters.ContainsKey("PublishUrl")) {
    $PublishUrl = "http://127.0.0.1:8889/game/whip"
}

# RTSP ingest uses: -f rtsp -rtsp_transport udp. WHIP experimental ingest uses: -f whip.
$script:PublishArgs = if ($PublishTransport -eq "rtsp") {
    @(
        "-f",
        "rtsp",
        "-rtsp_transport",
        "udp",
        $PublishUrl
    )
} else {
    @(
        "-f",
        "whip",
        $PublishUrl
    )
}

$publisherProcess = $null
$appliedSettingsHash = $null

try {
    while ($true) {
        if ($null -eq $publisherProcess) {
            $profile = Get-EffectiveStreamProfile
            $ffmpegArguments = New-FfmpegArgumentList -Profile $profile

            Write-Host "Using FFmpeg executable: $resolvedFfmpegExe" -ForegroundColor Cyan
            if ($resolvedAudioDevice) {
                Write-Host "Using DirectShow audio capture device: $resolvedAudioDevice" -ForegroundColor Cyan
            } else {
                Write-Host "Audio disabled for the lowest-latency video path" -ForegroundColor Cyan
            }
            Write-Host "Publishing via $PublishTransport to $PublishUrl" -ForegroundColor Cyan
            Write-Host "Video profile: $($profile.Width)x$($profile.Height) @ $($profile.Fps)fps, $($profile.VideoBitrateKbps) kbps" -ForegroundColor Cyan

            $publisherProcess = Start-PublisherProcess -ExecutablePath $resolvedFfmpegExe -Arguments $ffmpegArguments
            Write-ActiveStreamSettings -Profile $profile
            $appliedSettingsHash = Get-StreamSettingsFingerprint -SettingsPath $script:StreamSettingsPath
        }

        if ($publisherProcess.HasExited) {
            $exitCode = $publisherProcess.ExitCode
            Stop-PublisherProcess -Process $publisherProcess
            $publisherProcess = $null
            $appliedSettingsHash = $null
            Write-Warning "FFmpeg publisher exited with code $exitCode; restarting"
            Start-Sleep -Milliseconds 250
            continue
        }

        $currentSettingsHash = Get-StreamSettingsFingerprint -SettingsPath $script:StreamSettingsPath
        if ($currentSettingsHash -ne $appliedSettingsHash) {
            Write-Host "Settings changed; restarting FFmpeg publisher" -ForegroundColor Yellow
            Stop-PublisherProcess -Process $publisherProcess
            $publisherProcess = $null
            $appliedSettingsHash = $null
            Start-Sleep -Milliseconds 180
            continue
        }

        Start-Sleep -Milliseconds 180
    }
} finally {
    Stop-PublisherProcess -Process $publisherProcess
}

#requires -Version 7.0

[CmdletBinding()]
param(
    [string]$PythonExe = "",
    [string]$GatewayHost = "0.0.0.0",
    [int]$GatewayPort = 8082,
    [int]$FrontendPort = 8090,
    [int]$LegacyUdpPort = 28777,
    [double]$Timeout = 8.0,
    [double]$Deadzone = 0.12,
    [int]$MaxDevices = 4,
    [string]$MediaMtxExe = "mediamtx.exe",
    [string]$FfmpegExe = "ffmpeg.exe",
    [ValidateSet("rtsp", "rtsp_udp", "whip")]
    [string]$PublishTransport = "rtsp",
    [string]$PublishUrl = "",
    [string]$VideoDevice = "gfxcapture",
    [string]$VideoEncoder = "h264_nvenc",
    [string]$AudioDevice = "",
    [switch]$SkipDependencyInstall,
    [switch]$SkipFirewallCheck,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "runtime_path_helpers.ps1")

$script:PcHostDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$script:RequirementsPath = Join-Path $script:PcHostDir "requirements.txt"
$script:FixNetworkAccessScript = Join-Path $PSScriptRoot "fix_network_access.ps1"
$script:MediaStackScript = Join-Path $PSScriptRoot "start_media_stack.ps1"
$script:PublisherScript = Join-Path $PSScriptRoot "start_stream_publisher.ps1"
$script:MediaMtxConfigPath = Join-Path $script:PcHostDir "config\mediamtx.yml"
$script:ShellExecutable = (Get-Process -Id $PID).Path
$script:RequiredImports = @("aiohttp", "aiortc", "vgamepad")

function Write-Step {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Note {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Resolve-CommandPath {
    param([Parameter(Mandatory = $true)][string]$CommandName)

    if (($CommandName -match "[\\/]") -and (Test-Path -LiteralPath $CommandName -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $CommandName).Path
    }

    $command = Get-Command $CommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        return $command.Source
    }

    return $null
}

function New-PythonInvoker {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$PrefixArgs = @()
    )

    return [pscustomobject]@{
        FilePath   = $FilePath
        PrefixArgs = @($PrefixArgs)
    }
}

function Get-PythonInvoker {
    param([string]$RequestedExecutable)

    $candidates = New-Object System.Collections.Generic.List[object]

    if ($RequestedExecutable) {
        $resolved = Resolve-CommandPath -CommandName $RequestedExecutable
        if ($resolved) {
            $leaf = [System.IO.Path]::GetFileNameWithoutExtension($resolved)
            $prefixArgs = if ($leaf -ieq "py") { @("-3") } else { @() }
            [void]$candidates.Add((New-PythonInvoker -FilePath $resolved -PrefixArgs $prefixArgs))
        }
    } else {
        foreach ($candidateName in @("python", "py")) {
            $resolved = Resolve-CommandPath -CommandName $candidateName
            if (-not $resolved) {
                continue
            }

            $leaf = [System.IO.Path]::GetFileNameWithoutExtension($resolved)
            $prefixArgs = if ($leaf -ieq "py") { @("-3") } else { @() }
            [void]$candidates.Add((New-PythonInvoker -FilePath $resolved -PrefixArgs $prefixArgs))
        }
    }

    foreach ($candidate in $candidates) {
        try {
            $versionText = & $candidate.FilePath @($candidate.PrefixArgs + @("-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"))
            if ($LASTEXITCODE -ne 0) {
                continue
            }

            $parsedVersion = [version]($versionText | Select-Object -Last 1).Trim()
            if ($parsedVersion -ge [version]"3.12.0") {
                return [pscustomobject]@{
                    FilePath   = $candidate.FilePath
                    PrefixArgs = @($candidate.PrefixArgs)
                    Version    = $parsedVersion
                }
            }
        } catch {
            continue
        }
    }

    return $null
}

function Invoke-Python {
    param(
        [Parameter(Mandatory = $true)]$Python,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $Python.FilePath @($Python.PrefixArgs + $Arguments)
}

function Test-PythonImports {
    param(
        [Parameter(Mandatory = $true)]$Python,
        [Parameter(Mandatory = $true)][string[]]$Modules
    )

    $code = "import importlib.util, sys; missing=[name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]; print('|'.join(missing))"
    $output = Invoke-Python -Python $Python -Arguments (@("-c", $code) + $Modules)
    $missing = ($output | Select-Object -Last 1).Trim()
    if (-not $missing) {
        return @()
    }

    return @($missing -split "\|")
}

function Test-ViGEmBusInstalled {
    try {
        if (Get-Service -Name "ViGEmBus" -ErrorAction SilentlyContinue) {
            return $true
        }
    } catch {}

    try {
        $pnpDevice = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
            Where-Object {
                $_.FriendlyName -match "ViGEm|Virtual Gamepad Emulation Bus|Nefarius"
            } |
            Select-Object -First 1
        if ($pnpDevice) {
            return $true
        }
    } catch {}

    try {
        $legacyPnpDevice = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -match "ViGEm|Virtual Gamepad Emulation Bus|Nefarius"
            } |
            Select-Object -First 1
        if ($legacyPnpDevice) {
            return $true
        }
    } catch {}

    return $false
}

function Try-Resolve-DependencyExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutableName,
        [string]$WingetPackagePrefix = ""
    )

    try {
        $resolved = Resolve-ExecutablePath -ExecutableName $ExecutableName -WingetPackagePrefix $WingetPackagePrefix
        return [pscustomobject]@{
            Found = $true
            Path  = $resolved
            Error = ""
        }
    } catch {
        return [pscustomobject]@{
            Found = $false
            Path  = $ExecutableName
            Error = $_.Exception.Message
        }
    }
}

function Get-PrivateLanAddresses {
    $addresses = @()
    try {
        $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -match "^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)"
            } |
            Select-Object InterfaceAlias, IPAddress -Unique
    } catch {}

    $preferredWifi = @(
        $addresses | Where-Object {
            $_.InterfaceAlias -match "^(WLAN|Wi-?Fi)$"
        }
    )
    if ($preferredWifi.Count -gt 0) {
        return $preferredWifi
    }

    $nonVirtual = @(
        $addresses | Where-Object {
            $_.InterfaceAlias -notmatch "vEthernet|astral|tailscale|zerotier|virtual|vmware|hyper-v|loopback|docker|wsl"
        }
    )
    if ($nonVirtual.Count -gt 0) {
        return $nonVirtual
    }

    return @($addresses)
}

function Test-FirewallRuleExists {
    param([Parameter(Mandatory = $true)][string]$DisplayName)

    try {
        return $null -ne (Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue | Select-Object -First 1)
    } catch {
        return $false
    }
}

function Get-MissingFirewallRules {
    param(
        [int]$GatewayPort,
        [int]$FrontendPort
    )

    $expectations = @(
        "JoyCon-Web-$GatewayPort",
        "JoyCon-Web-$FrontendPort",
        "JoyCon-MediaMTX-WebRTC-8889",
        "JoyCon-WebRTC-UDP-8189"
    )

    return @($expectations | Where-Object { -not (Test-FirewallRuleExists -DisplayName $_) })
}

function Get-StaleFirewallRules {
    param(
        [int]$LegacyUdpPort,
        [int]$FrontendPort
    )

    $staleRules = @(
        "JoyCon-UDP-$LegacyUdpPort",
        "JoyCon-Frontend-$FrontendPort",
        "JoyCon-WebRTC-Control-UDP",
        "JoyCon-WebRTC-Control-UDP-Dynamic"
    )

    return @($staleRules | Where-Object { Test-FirewallRuleExists -DisplayName $_ })
}

function Remove-FirewallRuleByName {
    param([Parameter(Mandatory = $true)][string]$DisplayName)

    try {
        netsh advfirewall firewall delete rule name="$DisplayName" | Out-Null
    } catch {}
}

function Test-IsAdministrator {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-TcpListenerPresent {
    param([int]$Port)

    try {
        return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0
    } catch {
        return $false
    }
}

function Test-UdpEndpointPresent {
    param([int]$Port)

    try {
        return @(Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0
    } catch {
        return $false
    }
}

function Assert-PortIsFree {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Protocol,
        [Parameter(Mandatory = $true)][int]$Port
    )

    $inUse = if ($Protocol -eq "UDP") {
        Test-UdpEndpointPresent -Port $Port
    } else {
        Test-TcpListenerPresent -Port $Port
    }

    if ($inUse) {
        if ($DryRun) {
            Write-Note "$Name is already using $Protocol $Port. DryRun will continue without launching."
            return $false
        }

        throw "$Name is already using $Protocol $Port. Stop the existing process before starting the stack."
    }

    return $true
}

function Test-MediaMtxConfigLooksSafe {
    param([string]$ConfigPath)

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return $false
    }

    $text = Get-Content -LiteralPath $ConfigPath -Raw
    return (
        $text.Contains("webrtcIPsFromInterfaces: true") -and
        $text.Contains("webrtcIPsFromInterfacesList:") -and
        $text.Contains("  - WLAN")
    )
}

function Quote-Argument {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Format-CommandLine {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $tokens = @((Quote-Argument -Value $FilePath))
    $tokens += @($Arguments | ForEach-Object { Quote-Argument -Value "$_" })
    return $tokens -join " "
}

function New-PowerShellCommand {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $quotedArgs = @($Arguments | ForEach-Object { Quote-Argument -Value "$_" })
    return "& $(Quote-Argument -Value $ExecutablePath) $($quotedArgs -join ' ')"
}

function Start-WindowedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$CommandText
    )

    $argumentList = @("-NoLogo", "-NoExit", "-Command", $CommandText)
    Write-Host "Launching ${Name}:" -ForegroundColor Cyan
    Write-Host "  $(Format-CommandLine -FilePath $script:ShellExecutable -Arguments $argumentList)" -ForegroundColor DarkGray

    if ($DryRun) {
        return $null
    }

    return Start-Process -FilePath $script:ShellExecutable -ArgumentList $argumentList -WorkingDirectory $WorkingDirectory -PassThru
}

function Start-WindowedScript {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    $argumentList = @("-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Arguments
    Write-Host "Launching ${Name}:" -ForegroundColor Cyan
    Write-Host "  $(Format-CommandLine -FilePath $script:ShellExecutable -Arguments $argumentList)" -ForegroundColor DarkGray

    if ($DryRun) {
        return $null
    }

    return Start-Process -FilePath $script:ShellExecutable -ArgumentList $argumentList -WorkingDirectory $WorkingDirectory -PassThru
}

Write-Step "[1/7] Checking runtime prerequisites..."
if (-not $IsWindows) {
    throw "This script only supports Windows."
}

$python = Get-PythonInvoker -RequestedExecutable $PythonExe
if ($python) {
    Write-Ok "Python $($python.Version) detected via $($python.FilePath)"
} elseif ($DryRun) {
    Write-Note "Python 3.12+ not detected in DryRun; a real launch would stop here."
} else {
    throw "Python 3.12 or newer is required."
}

$mediaMtx = Try-Resolve-DependencyExecutable -ExecutableName $MediaMtxExe -WingetPackagePrefix "bluenviron.mediamtx"
if ($mediaMtx.Found) {
    Write-Ok "MediaMTX executable: $($mediaMtx.Path)"
} elseif ($DryRun) {
    Write-Note "MediaMTX not found in DryRun: $($mediaMtx.Error)"
} else {
    throw $mediaMtx.Error
}

$ffmpeg = Try-Resolve-DependencyExecutable -ExecutableName $FfmpegExe -WingetPackagePrefix "Gyan.FFmpeg.Essentials"
if ($ffmpeg.Found) {
    Write-Ok "FFmpeg executable: $($ffmpeg.Path)"
} elseif ($DryRun) {
    Write-Note "FFmpeg not found in DryRun: $($ffmpeg.Error)"
} else {
    throw $ffmpeg.Error
}

$vigemPresent = Test-ViGEmBusInstalled
if ($vigemPresent) {
    Write-Ok "ViGEmBus detected"
} elseif ($DryRun) {
    Write-Note "ViGEmBus not detected in DryRun; a real launch would stop here."
} else {
    throw "ViGEmBus / Nefarius Virtual Gamepad Emulation Bus is required."
}

if (-not (Test-MediaMtxConfigLooksSafe -ConfigPath $script:MediaMtxConfigPath)) {
    Write-Note "config\\mediamtx.yml does not look like the recommended WLAN-only WebRTC config."
} else {
    Write-Ok "MediaMTX config keeps WebRTC bound to WLAN candidates"
}

if (-not $SkipDependencyInstall) {
    Write-Step "[2/7] Installing Python dependencies..."
    if ($DryRun) {
        Write-Host "Would run: $(Format-CommandLine -FilePath $python.FilePath -Arguments @($python.PrefixArgs + @('-m', 'pip', 'install', '-r', $script:RequirementsPath)))" -ForegroundColor DarkGray
    } else {
        Invoke-Python -Python $python -Arguments @("-m", "pip", "install", "-r", $script:RequirementsPath)
    }
} else {
    Write-Step "[2/7] Skipping Python dependency install by request..."
}

Write-Step "[3/7] Verifying required Python modules..."
if ($python) {
    $missingImports = Test-PythonImports -Python $python -Modules $script:RequiredImports
    if ($missingImports.Count -eq 0) {
        Write-Ok "Python imports ready: $($script:RequiredImports -join ', ')"
    } elseif ($DryRun) {
        Write-Note "Missing Python modules in DryRun: $($missingImports -join ', ')"
    } else {
        throw "Missing Python modules: $($missingImports -join ', ')"
    }
} elseif ($DryRun) {
    Write-Note "Skipping import verification in DryRun because Python is unavailable."
}

if (-not $SkipFirewallCheck) {
    Write-Step "[4/7] Checking firewall readiness..."
    $missingFirewallRules = @(Get-MissingFirewallRules -GatewayPort $GatewayPort -FrontendPort $FrontendPort)
    $staleFirewallRules = @(Get-StaleFirewallRules -LegacyUdpPort $LegacyUdpPort -FrontendPort $FrontendPort)
    $needsFirewallRepair = ($missingFirewallRules.Count -gt 0) -or ($staleFirewallRules.Count -gt 0)
    if (-not $needsFirewallRepair) {
        Write-Ok "Firewall rules already cover frontend, gateway, MediaMTX WebRTC HTTP, and WebRTC media"
    } elseif ($DryRun) {
        if ($missingFirewallRules.Count -gt 0) {
            Write-Note "Missing firewall rules in DryRun: $($missingFirewallRules -join ', ')"
        }
        if ($staleFirewallRules.Count -gt 0) {
            Write-Note "Stale firewall rules to remove in DryRun: $($staleFirewallRules -join ', ')"
        }
    } else {
        if (-not (Test-IsAdministrator)) {
            $firewallProblems = @($missingFirewallRules + $staleFirewallRules)
            throw "Firewall rules need repair: $($firewallProblems -join ', '). Re-run this script as Administrator."
        }

        & $script:ShellExecutable -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script:FixNetworkAccessScript -HttpPort $GatewayPort -UdpPort $LegacyUdpPort -SkipUdp
        if ($LASTEXITCODE -ne 0) {
            throw "fix_network_access.ps1 failed with exit code $LASTEXITCODE"
        }
        & $script:ShellExecutable -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script:FixNetworkAccessScript -HttpPort $FrontendPort -UdpPort $LegacyUdpPort -SkipUdp
        if ($LASTEXITCODE -ne 0) {
            throw "fix_network_access.ps1 failed with exit code $LASTEXITCODE"
        }

        foreach ($staleRule in $staleFirewallRules) {
            Remove-FirewallRuleByName -DisplayName $staleRule
        }

        Write-Ok "Firewall rules repaired"
    }
} else {
    Write-Step "[4/7] Skipping firewall checks by request..."
}

Write-Step "[5/7] Checking required ports are free..."
$requiredPorts = @(
    @{ Name = "stream gateway"; Protocol = "TCP"; Port = $GatewayPort },
    @{ Name = "frontend static server"; Protocol = "TCP"; Port = $FrontendPort },
    @{ Name = "MediaMTX RTSP"; Protocol = "TCP"; Port = 8554 },
    @{ Name = "MediaMTX WebRTC HTTP"; Protocol = "TCP"; Port = 8889 },
    @{ Name = "MediaMTX API"; Protocol = "TCP"; Port = 9997 },
    @{ Name = "MediaMTX WebRTC media"; Protocol = "UDP"; Port = 8189 }
)

$allPortsFree = $true
foreach ($requiredPort in $requiredPorts) {
    if (-not (Assert-PortIsFree -Name $requiredPort.Name -Protocol $requiredPort.Protocol -Port $requiredPort.Port)) {
        $allPortsFree = $false
    }
}
if ($allPortsFree) {
    Write-Ok "Required ports are free"
} else {
    Write-Note "Port check completed with active listeners in DryRun."
}

Write-Step "[6/7] Preparing launch commands..."
$pythonExeForLaunch = if ($python) { $python.FilePath } else { "python" }
$pythonPrefixArgs = if ($python) { @($python.PrefixArgs) } else { @() }
$mediaMtxExeForLaunch = if ($mediaMtx.Found) { $mediaMtx.Path } else { $MediaMtxExe }
$ffmpegExeForLaunch = if ($ffmpeg.Found) { $ffmpeg.Path } else { $FfmpegExe }

$gatewayCommand = New-PowerShellCommand -ExecutablePath $pythonExeForLaunch -Arguments @(
    $pythonPrefixArgs +
    @(
        "stream_gateway.py",
        "--host", $GatewayHost,
        "--port", "$GatewayPort",
        "--timeout", "$Timeout",
        "--deadzone", "$Deadzone",
        "--max-devices", "$MaxDevices"
    )
)

$frontendCommand = New-PowerShellCommand -ExecutablePath $pythonExeForLaunch -Arguments @(
    $pythonPrefixArgs +
    @(
        "-m", "http.server",
        "$FrontendPort",
        "--bind", "0.0.0.0"
    )
)

$mediaStackArguments = @("-MediaMtxExe", $mediaMtxExeForLaunch)
$publisherArguments = @(
    "-FfmpegExe", $ffmpegExeForLaunch,
    "-PublishTransport", $PublishTransport,
    "-VideoDevice", $VideoDevice,
    "-VideoEncoder", $VideoEncoder
)
if ($PublishUrl) {
    $publisherArguments += @("-PublishUrl", $PublishUrl)
}
if ($AudioDevice) {
    $publisherArguments += @("-AudioDevice", $AudioDevice)
}

$gatewayProcess = Start-WindowedCommand -Name "stream gateway" -WorkingDirectory $script:PcHostDir -CommandText $gatewayCommand
$mediaStackProcess = Start-WindowedScript -Name "MediaMTX" -WorkingDirectory $script:PcHostDir -ScriptPath $script:MediaStackScript -Arguments $mediaStackArguments
$publisherProcess = Start-WindowedScript -Name "stream publisher" -WorkingDirectory $script:PcHostDir -ScriptPath $script:PublisherScript -Arguments $publisherArguments
$frontendProcess = Start-WindowedCommand -Name "frontend static server" -WorkingDirectory (Join-Path $script:PcHostDir "web") -CommandText $frontendCommand

if ($DryRun) {
    Write-Step "[7/7] DryRun summary..."
    Write-Ok "DryRun complete. No firewall rules were changed and no services were started."
} else {
    Write-Step "[7/7] Waiting for services to listen..."
    Start-Sleep -Seconds 4

    $expectedListeners = @(
        @{ Name = "stream gateway"; Port = $GatewayPort },
        @{ Name = "frontend static server"; Port = $FrontendPort },
        @{ Name = "MediaMTX RTSP"; Port = 8554 },
        @{ Name = "MediaMTX WebRTC HTTP"; Port = 8889 },
        @{ Name = "MediaMTX API"; Port = 9997 }
    )

    $missingListeners = @()
    foreach ($listener in $expectedListeners) {
        if (-not (Test-TcpListenerPresent -Port $listener.Port)) {
            $missingListeners += "$($listener.Name) ($($listener.Port)/TCP)"
        }
    }

    if ($missingListeners.Count -eq 0) {
        Write-Ok "Core services are listening on the expected ports"
    } else {
        Write-Note "Some services are not listening yet: $($missingListeners -join ', ')"
    }

    $processSummary = @(
        @{ Name = "stream gateway"; Process = $gatewayProcess },
        @{ Name = "MediaMTX"; Process = $mediaStackProcess },
        @{ Name = "stream publisher"; Process = $publisherProcess },
        @{ Name = "frontend static server"; Process = $frontendProcess }
    )
    foreach ($entry in $processSummary) {
        if ($null -ne $entry.Process) {
            Write-Host "$($entry.Name) window pid: $($entry.Process.Id)" -ForegroundColor DarkGray
        }
    }
}

$lanAddresses = Get-PrivateLanAddresses
if ($lanAddresses.Count -eq 0) {
    Write-Note "No private LAN IPv4 address detected. Open the frontend with this PC's reachable LAN IPv4 once you know it."
} else {
    Write-Host "" 
    Write-Host "Phone access:" -ForegroundColor Green
    foreach ($address in $lanAddresses) {
        Write-Host "  Frontend: http://$($address.IPAddress):$FrontendPort" -ForegroundColor Green
        Write-Host "  Host target: $($address.IPAddress):$GatewayPort" -ForegroundColor Green
        Write-Host "  Media Proxy: http://$($address.IPAddress):$GatewayPort/media/whep" -ForegroundColor Green
        Write-Host "  Media WHEP: http://$($address.IPAddress):8889/game/whep" -ForegroundColor Green
    }
}

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
    [ValidateSet("rtsp", "whip")]
    [string]$PublishTransport = "rtsp",
    [string]$PublishUrl = "",
    [string]$VideoDevice = "gfxcapture",
    [string]$VideoEncoder = "h264_nvenc",
    [string]$AudioDevice = "",
    [switch]$NoRestartExisting,
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
$script:StopStackScript = Join-Path $PSScriptRoot "stop_lan_streaming_web_controller.ps1"
$script:MediaMtxConfigPath = Join-Path $script:PcHostDir "config\mediamtx.yml"
$script:RuntimeDir = Join-Path $script:PcHostDir ".runtime"
$script:ManagedLogDir = Join-Path $script:RuntimeDir "logs"
$script:ManagedStatePath = Join-Path $script:RuntimeDir "managed_stack.json"
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

function Test-CommandLineContains {
    param(
        [string]$CommandLine,
        [string[]]$Needles
    )

    if (-not $CommandLine) {
        return $false
    }

    foreach ($needle in $Needles) {
        if (-not $needle) {
            continue
        }

        if ($CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            return $false
        }
    }

    return $true
}

function Get-ManagedPortOwnerProcesses {
    param(
        [int]$GatewayPort,
        [int]$FrontendPort,
        [object[]]$AllProcesses
    )

    $processIds = New-Object System.Collections.Generic.HashSet[int]
    try {
        @(Get-NetTCPConnection -State Listen -LocalPort $GatewayPort, $FrontendPort, 8554, 8889, 9997 -ErrorAction SilentlyContinue) |
            ForEach-Object {
                if ($_.OwningProcess) {
                    [void]$processIds.Add([int]$_.OwningProcess)
                }
            }
    } catch {}

    try {
        @(Get-NetUDPEndpoint -LocalPort 8189 -ErrorAction SilentlyContinue) |
            ForEach-Object {
                if ($_.OwningProcess) {
                    [void]$processIds.Add([int]$_.OwningProcess)
                }
            }
    } catch {}

    if ($processIds.Count -eq 0) {
        return @()
    }

    return @(
        $AllProcesses | Where-Object {
            $_.ProcessId -in $processIds
        }
    )
}

function Get-ManagedSiblingChildProcesses {
    param(
        [object[]]$BaseProcesses,
        [object[]]$AllProcesses
    )

    $baseParentIds = @(
        $BaseProcesses |
            Where-Object { $_.ParentProcessId -gt 0 } |
            Select-Object -ExpandProperty ParentProcessId -Unique
    )
    if ($baseParentIds.Count -eq 0) {
        return @()
    }

    $baseParentShells = @(
        $AllProcesses | Where-Object {
            $_.ProcessId -in $baseParentIds -and $_.Name -match '^(pwsh|powershell)\.exe$'
        }
    )
    if ($baseParentShells.Count -eq 0) {
        return @()
    }

    $shellGroupParentIds = @(
        $baseParentShells |
            Where-Object { $_.ParentProcessId -gt 0 } |
            Select-Object -ExpandProperty ParentProcessId -Unique
    )
    if ($shellGroupParentIds.Count -eq 0) {
        return @()
    }

    $siblingShellIds = @(
        $AllProcesses | Where-Object {
            $_.ParentProcessId -in $shellGroupParentIds -and $_.Name -match '^(pwsh|powershell)\.exe$'
        } | Select-Object -ExpandProperty ProcessId -Unique
    )
    if ($siblingShellIds.Count -eq 0) {
        return @()
    }

    return @(
        $AllProcesses | Where-Object {
            $_.ParentProcessId -in $siblingShellIds -and $_.Name -match '^(python|ffmpeg|mediamtx)\.exe$'
        }
    )
}

function Get-ManagedParentShellProcesses {
    param(
        [object[]]$BaseProcesses,
        [object[]]$AllProcesses
    )

    $parentIds = @(
        $BaseProcesses |
            Where-Object { $_.ParentProcessId -gt 0 } |
            Select-Object -ExpandProperty ParentProcessId -Unique
    )
    if ($parentIds.Count -eq 0) {
        return @()
    }

    return @(
        $AllProcesses | Where-Object {
            $_.ProcessId -in $parentIds -and $_.Name -match '^(pwsh|powershell)\.exe$'
        }
    )
}

function Get-ExistingManagedStackProcesses {
    param(
        [int]$GatewayPort,
        [int]$FrontendPort
    )

    try {
        $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    } catch {
        return @()
    }

    $markerSets = @(
        @("stream_gateway.py", "--port", "$GatewayPort"),
        @("http.server", "$FrontendPort"),
        @("start_media_stack.ps1"),
        @("start_stream_publisher.ps1"),
        @("$script:MediaMtxConfigPath")
    )

    $matches = @()
    foreach ($process in $processes) {
        if ($process.ProcessId -eq $PID) {
            continue
        }

        $commandLine = [string]$process.CommandLine
        if (-not $commandLine) {
            continue
        }

        foreach ($markerSet in $markerSets) {
            if (Test-CommandLineContains -CommandLine $commandLine -Needles $markerSet) {
                $matches += $process
                break
            }
        }
    }

    $portOwnerProcesses = @(Get-ManagedPortOwnerProcesses -GatewayPort $GatewayPort -FrontendPort $FrontendPort -AllProcesses $processes)
    $matches += $portOwnerProcesses

    $matches += @(Get-ManagedSiblingChildProcesses -BaseProcesses $portOwnerProcesses -AllProcesses $processes)
    $matches += @(Get-ManagedParentShellProcesses -BaseProcesses $matches -AllProcesses $processes)

    return @($matches | Sort-Object ProcessId -Unique)
}

function Get-BusyRequiredPorts {
    param([object[]]$RequiredPorts)

    $busyPorts = @()
    foreach ($requiredPort in $RequiredPorts) {
        $inUse = if ($requiredPort.Protocol -eq "UDP") {
            Test-UdpEndpointPresent -Port $requiredPort.Port
        } else {
            Test-TcpListenerPresent -Port $requiredPort.Port
        }

        if ($inUse) {
            $busyPorts += "$($requiredPort.Name) ($($requiredPort.Port)/$($requiredPort.Protocol))"
        }
    }

    return @($busyPorts)
}

function Wait-RequiredPortsToFree {
    param(
        [Parameter(Mandatory = $true)][object[]]$RequiredPorts,
        [int]$TimeoutSeconds = 12
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $busyPorts = @(Get-BusyRequiredPorts -RequiredPorts $RequiredPorts)
        if ($busyPorts.Count -eq 0) {
            return
        }

        Start-Sleep -Milliseconds 500
    }

    $remainingBusyPorts = @(Get-BusyRequiredPorts -RequiredPorts $RequiredPorts)
    if ($remainingBusyPorts.Count -gt 0) {
        throw "Managed stack ports did not free in time: $($remainingBusyPorts -join ', ')"
    }
}

function Stop-ExistingManagedStackProcesses {
    param(
        [int]$GatewayPort,
        [int]$FrontendPort,
        [Parameter(Mandatory = $true)][object[]]$RequiredPorts
    )

    $existingProcesses = @(Get-ExistingManagedStackProcesses -GatewayPort $GatewayPort -FrontendPort $FrontendPort)
    if ($existingProcesses.Count -eq 0) {
        Write-Ok "No existing managed stack processes detected"
        return
    }

    $processSummary = @($existingProcesses | ForEach-Object { "$($_.Name)#$($_.ProcessId)" })
    if ($DryRun) {
        Write-Note "Would stop existing managed stack processes in DryRun: $($processSummary -join ', ')"
        return
    }

    $orderedProcesses = @(
        $existingProcesses | Sort-Object @{ Expression = {
                    if ($_.Name -match '^(pwsh|powershell)\.exe$') {
                        1
                    } else {
                        0
                    }
                }
            }, ProcessId
    )

    foreach ($process in $orderedProcesses) {
        Write-Note "Stopping existing managed process: $($process.Name)#$($process.ProcessId)"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    Wait-RequiredPortsToFree -RequiredPorts $RequiredPorts
    Write-Ok "Existing managed stack processes stopped"
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

function Ensure-ManagedRuntimeDirectories {
    foreach ($path in @($script:RuntimeDir, $script:ManagedLogDir)) {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
        }
    }
}

function Clear-ManagedStackState {
    if (Test-Path -LiteralPath $script:ManagedStatePath) {
        Remove-Item -LiteralPath $script:ManagedStatePath -Force -ErrorAction SilentlyContinue
    }
}

function Get-ManagedLogPaths {
    param([Parameter(Mandatory = $true)][string]$Name)

    $safeName = (($Name -replace '[^A-Za-z0-9]+', '-') -replace '^-+|-+$', '').ToLowerInvariant()
    if (-not $safeName) {
        $safeName = "managed-process"
    }

    return [pscustomobject]@{
        StdOutPath = Join-Path $script:ManagedLogDir "${safeName}.stdout.log"
        StdErrPath = Join-Path $script:ManagedLogDir "${safeName}.stderr.log"
    }
}

function Write-ManagedStackState {
    param([Parameter(Mandatory = $true)][object[]]$Entries)

    Ensure-ManagedRuntimeDirectories
    $payload = [ordered]@{
        createdAt = (Get-Date).ToString("o")
        processes = @(
            $Entries |
                Where-Object { $null -ne $_.Process } |
                ForEach-Object {
                    [ordered]@{
                        name = $_.Name
                        pid = [int]$_.Process.Id
                        stdout = $_.StdOutPath
                        stderr = $_.StdErrPath
                    }
                }
        )
    }

    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $script:ManagedStatePath -Encoding UTF8
}

function Start-BackgroundProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Ensure-ManagedRuntimeDirectories
    $logPaths = Get-ManagedLogPaths -Name $Name
    Write-Host "Launching ${Name} in background:" -ForegroundColor Cyan
    Write-Host "  $(Format-CommandLine -FilePath $FilePath -Arguments $Arguments)" -ForegroundColor DarkGray
    Write-Host "  stdout -> $($logPaths.StdOutPath)" -ForegroundColor DarkGray
    Write-Host "  stderr -> $($logPaths.StdErrPath)" -ForegroundColor DarkGray

    if ($DryRun) {
        return [pscustomobject]@{
            Name = $Name
            Process = $null
            StdOutPath = $logPaths.StdOutPath
            StdErrPath = $logPaths.StdErrPath
        }
    }

    Remove-Item -LiteralPath $logPaths.StdOutPath, $logPaths.StdErrPath -Force -ErrorAction SilentlyContinue
    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logPaths.StdOutPath `
        -RedirectStandardError $logPaths.StdErrPath `
        -PassThru

    return [pscustomobject]@{
        Name = $Name
        Process = $process
        StdOutPath = $logPaths.StdOutPath
        StdErrPath = $logPaths.StdErrPath
    }
}

Write-Step "[1/8] Checking runtime prerequisites..."
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
    Write-Step "[2/8] Installing Python dependencies..."
    if ($DryRun) {
        Write-Host "Would run: $(Format-CommandLine -FilePath $python.FilePath -Arguments @($python.PrefixArgs + @('-m', 'pip', 'install', '-r', $script:RequirementsPath)))" -ForegroundColor DarkGray
    } else {
        Invoke-Python -Python $python -Arguments @("-m", "pip", "install", "-r", $script:RequirementsPath)
    }
} else {
    Write-Step "[2/8] Skipping Python dependency install by request..."
}

Write-Step "[3/8] Verifying required Python modules..."
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
    Write-Step "[4/8] Checking firewall readiness..."
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
    Write-Step "[4/8] Skipping firewall checks by request..."
}

$requiredPorts = @(
    @{ Name = "stream gateway"; Protocol = "TCP"; Port = $GatewayPort },
    @{ Name = "frontend static server"; Protocol = "TCP"; Port = $FrontendPort },
    @{ Name = "MediaMTX RTSP"; Protocol = "TCP"; Port = 8554 },
    @{ Name = "MediaMTX WebRTC HTTP"; Protocol = "TCP"; Port = 8889 },
    @{ Name = "MediaMTX API"; Protocol = "TCP"; Port = 9997 },
    @{ Name = "MediaMTX WebRTC media"; Protocol = "UDP"; Port = 8189 }
)

if (-not $NoRestartExisting) {
    Write-Step "[5/8] Releasing existing managed stack processes..."
    Stop-ExistingManagedStackProcesses -GatewayPort $GatewayPort -FrontendPort $FrontendPort -RequiredPorts $requiredPorts
    Clear-ManagedStackState
} else {
    Write-Step "[5/8] Skipping existing process cleanup by request..."
}

Write-Step "[6/8] Checking required ports are free..."
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

Write-Step "[7/8] Preparing launch commands..."
$pythonExeForLaunch = if ($python) { $python.FilePath } else { "python" }
$pythonPrefixArgs = if ($python) { @($python.PrefixArgs) } else { @() }
$mediaMtxExeForLaunch = if ($mediaMtx.Found) { $mediaMtx.Path } else { $MediaMtxExe }
$ffmpegExeForLaunch = if ($ffmpeg.Found) { $ffmpeg.Path } else { $FfmpegExe }

$gatewayArguments = @(
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

$frontendArguments = @(
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

$gatewayProcess = Start-BackgroundProcess -Name "stream gateway" -WorkingDirectory $script:PcHostDir -FilePath $pythonExeForLaunch -Arguments $gatewayArguments
$mediaStackProcess = Start-BackgroundProcess -Name "MediaMTX" -WorkingDirectory $script:PcHostDir -FilePath $script:ShellExecutable -Arguments (@("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script:MediaStackScript) + $mediaStackArguments)
$publisherProcess = Start-BackgroundProcess -Name "stream publisher" -WorkingDirectory $script:PcHostDir -FilePath $script:ShellExecutable -Arguments (@("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script:PublisherScript) + $publisherArguments)
$frontendProcess = Start-BackgroundProcess -Name "frontend static server" -WorkingDirectory (Join-Path $script:PcHostDir "web") -FilePath $pythonExeForLaunch -Arguments $frontendArguments

if ($DryRun) {
    Clear-ManagedStackState
    Write-Step "[8/8] DryRun summary..."
    Write-Ok "DryRun complete. No firewall rules were changed and no services were started."
} else {
    $processSummary = @($gatewayProcess, $mediaStackProcess, $publisherProcess, $frontendProcess)
    Write-ManagedStackState -Entries $processSummary
    Write-Step "[8/8] Waiting for services to listen..."
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

    foreach ($entry in $processSummary) {
        if ($null -ne $entry.Process) {
            Write-Host "$($entry.Name) pid: $($entry.Process.Id)" -ForegroundColor DarkGray
            Write-Host "  stdout: $($entry.StdOutPath)" -ForegroundColor DarkGray
            Write-Host "  stderr: $($entry.StdErrPath)" -ForegroundColor DarkGray
        }
    }
    Write-Host "Stop script: $script:StopStackScript" -ForegroundColor DarkGray
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

Write-Host ""
Write-Host "Streaming runtime notes:" -ForegroundColor Cyan
Write-Host "  FRPC/public control path prefers WebRTC DataChannel; WebSocket stays warm and HTTP is last resort" -ForegroundColor DarkGray
Write-Host "  requested fps may be clamped to the source refresh rate or runtime caps" -ForegroundColor DarkGray
Write-Host "  effective stream profile: stream_gateway.py /api/stream/settings and .runtime/stream_settings.active.json" -ForegroundColor DarkGray

#requires -Version 7.0

[CmdletBinding()]
param(
    [int]$GatewayPort = 8082,
    [int]$FrontendPort = 8090
)

$ErrorActionPreference = "Stop"

$script:PcHostDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$script:RuntimeDir = Join-Path $script:PcHostDir ".runtime"
$script:ManagedStatePath = Join-Path $script:RuntimeDir "managed_stack.json"
$script:MediaMtxConfigPath = Join-Path $script:PcHostDir "config\mediamtx.yml"

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

function Get-ManagedStateProcessIds {
    if (-not (Test-Path -LiteralPath $script:ManagedStatePath)) {
        return @()
    }

    try {
        $payload = Get-Content -LiteralPath $script:ManagedStatePath -Raw | ConvertFrom-Json
    } catch {
        return @()
    }

    $ids = @()
    foreach ($process in @($payload.processes)) {
        if ($null -ne $process.pid) {
            $ids += [int]$process.pid
        }
    }

    return @($ids | Select-Object -Unique)
}

function Get-DescendantProcesses {
    param(
        [int[]]$RootProcessIds,
        [object[]]$AllProcesses
    )

    if (-not $RootProcessIds -or $RootProcessIds.Count -eq 0) {
        return @()
    }

    $pending = New-Object System.Collections.Generic.Queue[int]
    $seen = New-Object System.Collections.Generic.HashSet[int]
    foreach ($processId in $RootProcessIds) {
        $pending.Enqueue([int]$processId)
        [void]$seen.Add([int]$processId)
    }

    $matches = @()
    while ($pending.Count -gt 0) {
        $currentId = $pending.Dequeue()
        $children = @(
            $AllProcesses | Where-Object {
                $_.ParentProcessId -eq $currentId
            }
        )

        foreach ($child in $children) {
            if ($seen.Add([int]$child.ProcessId)) {
                $matches += $child
                $pending.Enqueue([int]$child.ProcessId)
            }
        }
    }

    return @($matches | Sort-Object ProcessId -Unique)
}

function Clear-ManagedStackState {
    if (Test-Path -LiteralPath $script:ManagedStatePath) {
        Remove-Item -LiteralPath $script:ManagedStatePath -Force -ErrorAction SilentlyContinue
    }
}

Write-Step "[1/2] Discovering managed streaming processes..."

$requiredPorts = @(
    @{ Name = "stream gateway"; Protocol = "TCP"; Port = $GatewayPort },
    @{ Name = "frontend static server"; Protocol = "TCP"; Port = $FrontendPort },
    @{ Name = "MediaMTX RTSP"; Protocol = "TCP"; Port = 8554 },
    @{ Name = "MediaMTX WebRTC HTTP"; Protocol = "TCP"; Port = 8889 },
    @{ Name = "MediaMTX API"; Protocol = "TCP"; Port = 9997 },
    @{ Name = "MediaMTX WebRTC media"; Protocol = "UDP"; Port = 8189 }
)

try {
    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
} catch {
    $allProcesses = @()
}

$stateProcessIds = @(Get-ManagedStateProcessIds)
$stateProcesses = @(
    $allProcesses | Where-Object {
        $_.ProcessId -in $stateProcessIds
    }
)
$descendantProcesses = @(Get-DescendantProcesses -RootProcessIds $stateProcessIds -AllProcesses $allProcesses)
$existingProcesses = @(Get-ExistingManagedStackProcesses -GatewayPort $GatewayPort -FrontendPort $FrontendPort)
$managedProcesses = @($stateProcesses + $descendantProcesses + $existingProcesses | Sort-Object ProcessId -Unique)

if ($managedProcesses.Count -eq 0) {
    Clear-ManagedStackState
    Write-Ok "No managed streaming stack processes detected"
    exit 0
}

Write-Step "[2/2] Stopping managed streaming processes..."
$orderedProcesses = @(
    $managedProcesses | Sort-Object @{ Expression = {
                if ($_.Name -match '^(pwsh|powershell)\.exe$') {
                    1
                } else {
                    0
                }
            }
        }, ProcessId
)

foreach ($process in $orderedProcesses) {
    Write-Note "Stopping managed process: $($process.Name)#$($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Wait-RequiredPortsToFree -RequiredPorts $requiredPorts
Clear-ManagedStackState
Write-Ok "Managed streaming stack stopped"

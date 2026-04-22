#requires -Version 7.0

function Resolve-ExecutablePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExecutableName,

        [string]$WingetPackagePrefix = "",

        [string[]]$SearchRoots = @(
            (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages")
        )
    )

    if (($ExecutableName -match '[\\/]') -and (Test-Path -LiteralPath $ExecutableName -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $ExecutableName).Path
    }

    $pathCommand = Get-Command $ExecutableName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pathCommand) {
        return $pathCommand.Source
    }

    $leafName = Split-Path -Leaf $ExecutableName
    $candidates = @()
    foreach ($root in $SearchRoots) {
        if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }

        $candidates += @(Get-ChildItem -LiteralPath $root -Recurse -Filter $leafName -File -ErrorAction SilentlyContinue)
    }

    if ($WingetPackagePrefix) {
        $preferredCandidates = @($candidates | Where-Object { $_.FullName -like "*$WingetPackagePrefix*" })
        if ($preferredCandidates.Count -gt 0) {
            $candidates = $preferredCandidates
        }
    }

    $resolved = $candidates | Sort-Object FullName | Select-Object -First 1
    if ($resolved) {
        return $resolved.FullName
    }

    throw "Unable to find '$ExecutableName'. Install it with winget or pass an explicit executable path."
}

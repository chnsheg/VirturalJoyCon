param(
    [int]$HttpPort = 8081,
    [int]$FrontendPort = 0,
    [int]$UdpPort = 28777,
    [switch]$SkipUdp,
    [switch]$EnableWebRtcMedia
)

$ErrorActionPreference = 'Stop'

function Remove-FirewallRule {
    param([Parameter(Mandatory = $true)][string]$Name)

    netsh advfirewall firewall delete rule name="$Name" | Out-Null
}

function Ensure-FirewallRule {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Protocol,
        [Parameter(Mandatory = $true)][int]$Port
    )

    Remove-FirewallRule -Name $Name
    netsh advfirewall firewall add rule name="$Name" dir=in action=allow protocol=$Protocol localport=$Port profile=any | Out-Null
    Write-Host "Rule ensured: $Name" -ForegroundColor Green
}

Write-Host '[1/4] Set WLAN profile to Private (if allowed)...' -ForegroundColor Cyan
try {
    Set-NetConnectionProfile -InterfaceAlias 'WLAN' -NetworkCategory Private -ErrorAction Stop
    Write-Host 'WLAN profile -> Private' -ForegroundColor Green
} catch {
    Write-Host "Skip profile change: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host '[2/4] Create firewall rules for JoyCon host...' -ForegroundColor Cyan
$rules = @(
    @{ Name = "JoyCon-Web-$HttpPort"; Protocol = 'TCP'; Port = $HttpPort }
)

if ($FrontendPort -gt 0) {
    $rules += @{ Name = "JoyCon-Frontend-$FrontendPort"; Protocol = 'TCP'; Port = $FrontendPort }
}

netsh advfirewall firewall delete rule name="JoyCon-MediaMTX-WebRTC-8889" | Out-Null

if ($EnableWebRtcMedia) {
    $rules += @{ Name = "JoyCon-WebRTC-UDP-8189"; Protocol = 'UDP'; Port = 8189 }
} else {
    Remove-FirewallRule -Name "JoyCon-WebRTC-UDP-8189"
}

if (-not $SkipUdp) {
    $rules += @{ Name = "JoyCon-UDP-$UdpPort"; Protocol = 'UDP'; Port = $UdpPort }
} else {
    Remove-FirewallRule -Name "JoyCon-UDP-$UdpPort"
}

foreach ($r in $rules) {
    Ensure-FirewallRule -Name $r.Name -Protocol $r.Protocol -Port $r.Port
}

Write-Host '[3/4] Show candidate LAN IPs...' -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -match '^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)' } |
    Select-Object InterfaceAlias,IPAddress |
    Format-Table -AutoSize

Write-Host '[4/4] Verify port listen status...' -ForegroundColor Cyan
Get-NetTCPConnection -LocalPort $HttpPort -State Listen |
    Select-Object -First 3 LocalAddress,LocalPort,State,OwningProcess |
    Format-Table -AutoSize

Write-Host ''
if ($EnableWebRtcMedia) {
    if ($FrontendPort -gt 0) {
        Write-Host "Done. Frontend: <LAN_IP>:$FrontendPort | Host target: <LAN_IP>:$HttpPort (Streaming gateway target, WebRTC 8189/UDP open, 8889/TCP stays local)" -ForegroundColor Green
    } else {
        Write-Host "Done. Host target: <LAN_IP>:$HttpPort (Streaming gateway target, WebRTC 8189/UDP open, 8889/TCP stays local)" -ForegroundColor Green
    }
} elseif ($SkipUdp) {
    Write-Host "Done. Host target: <LAN_IP>:$HttpPort (TCP only; no UDP or WebRTC firewall rules left open)" -ForegroundColor Green
} else {
    Write-Host "Done. Host target: <LAN_IP>:$HttpPort (TCP $HttpPort plus optional legacy UDP $UdpPort)" -ForegroundColor Green
}

param(
    [int]$HttpPort = 8081,
    [int]$UdpPort = 28777,
    [switch]$SkipUdp
)

$ErrorActionPreference = 'Stop'

Write-Host '[1/4] Set WLAN profile to Private (if allowed)...' -ForegroundColor Cyan
try {
    Set-NetConnectionProfile -InterfaceAlias 'WLAN' -NetworkCategory Private -ErrorAction Stop
    Write-Host 'WLAN profile -> Private' -ForegroundColor Green
} catch {
    Write-Host "Skip profile change: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host '[2/4] Create firewall rules for JoyCon host...' -ForegroundColor Cyan
$rules = @(
    @{ Name = "JoyCon-Web-$HttpPort"; Protocol = 'TCP'; Port = $HttpPort },
    @{ Name = "JoyCon-MediaMTX-WebRTC-8889"; Protocol = 'TCP'; Port = 8889 },
    @{ Name = "JoyCon-WebRTC-UDP-8189"; Protocol = 'UDP'; Port = 8189 }
)

if (-not $SkipUdp) {
    $rules += @{ Name = "JoyCon-UDP-$UdpPort"; Protocol = 'UDP'; Port = $UdpPort }
}

if ($SkipUdp) {
    netsh advfirewall firewall delete rule name="JoyCon-UDP-$UdpPort" | Out-Null
}

foreach ($r in $rules) {
    netsh advfirewall firewall delete rule name="$($r.Name)" | Out-Null
    netsh advfirewall firewall add rule name="$($r.Name)" dir=in action=allow protocol=$($r.Protocol) localport=$($r.Port) profile=any | Out-Null
    Write-Host "Rule ensured: $($r.Name)" -ForegroundColor Green
}

Write-Host '[3/4] Show candidate LAN IPs...' -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -match '^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)' } |
    Select-Object InterfaceAlias,IPAddress |
    Format-Table -AutoSize

Write-Host '[4/4] Verify port listen status...' -ForegroundColor Cyan
$listeners = @(Get-NetTCPConnection -LocalPort $HttpPort -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    $listeners |
        Select-Object -First 3 LocalAddress,LocalPort,State,OwningProcess |
        Format-Table -AutoSize
} else {
    Write-Host "Port $HttpPort is not listening yet; this is expected before the service starts." -ForegroundColor Yellow
}

Write-Host ''
if ($SkipUdp) {
    Write-Host "Done. Host target: <LAN_IP>:$HttpPort (Streaming gateway target, MediaMTX 8889/TCP and WebRTC 8189/UDP open)" -ForegroundColor Green
} else {
    Write-Host "Done. Host target: <LAN_IP>:$HttpPort (Streaming gateway target, MediaMTX 8889/TCP, WebRTC 8189/UDP, legacy UDP $UdpPort optional)" -ForegroundColor Green
}

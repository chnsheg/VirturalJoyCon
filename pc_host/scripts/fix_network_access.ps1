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
    @{ Name = 'JoyCon-Web-8080'; Protocol = 'TCP'; Port = 8080 },
    @{ Name = 'JoyCon-UDP-28777'; Protocol = 'UDP'; Port = 28777 }
)

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
Get-NetTCPConnection -LocalPort 8080 -State Listen |
    Select-Object -First 3 LocalAddress,LocalPort,State,OwningProcess |
    Format-Table -AutoSize

Write-Host ''
Write-Host 'Done. Open on phone: http://<LAN_IP>:8080' -ForegroundColor Green

import subprocess
import unittest
from pathlib import Path

from web_host import build_runtime_notes


class RuntimeNotesTests(unittest.TestCase):
    def test_runtime_notes_highlight_tcp_target_for_standalone_controller(self) -> None:
        notes = build_runtime_notes(
            bind_host="0.0.0.0",
            http_port=8081,
            udp_port=28777,
            access_urls=["http://192.168.0.119:8081"],
        )

        self.assertIn("[GamepadHost] Control API: http://0.0.0.0:8081", notes)
        self.assertIn("[GamepadHost] Standalone controller target: 192.168.0.119:8081", notes)
        self.assertIn("[GamepadHost] TCP 8081 must be reachable from the browser host", notes)
        self.assertIn(
            "[GamepadHost] Firewall helper (TCP only): .\\scripts\\fix_network_access.ps1 -HttpPort 8081 -SkipUdp",
            notes,
        )

    def test_runtime_notes_do_not_claim_one_target_when_multiple_lan_urls_exist(self) -> None:
        notes = build_runtime_notes(
            bind_host="0.0.0.0",
            http_port=8081,
            udp_port=28777,
            access_urls=[
                "http://192.168.0.119:8081",
                "http://10.0.0.25:8081",
            ],
        )

        self.assertIn("[GamepadHost] Candidate LAN API URLs:", notes)
        self.assertIn("  http://192.168.0.119:8081", notes)
        self.assertIn("  http://10.0.0.25:8081", notes)
        self.assertIn(
            "[GamepadHost] Standalone controller target: choose one LAN API URL above",
            notes,
        )
        self.assertNotIn("[GamepadHost] Standalone controller target: 192.168.0.119:8081", notes)

    def test_runtime_notes_do_not_emit_wildcard_bind_as_client_target_when_no_lan_url_exists(self) -> None:
        notes = build_runtime_notes(
            bind_host="0.0.0.0",
            http_port=8081,
            udp_port=28777,
            access_urls=[],
        )

        self.assertIn(
            "[GamepadHost] Standalone controller target: no private LAN API URL detected; enter this PC's reachable IPv4:port",
            notes,
        )
        self.assertNotIn("[GamepadHost] Standalone controller target: 0.0.0.0:8081", notes)

    def test_fix_network_access_skip_udp_removes_stale_udp_rule(self) -> None:
        script_path = Path(__file__).resolve().parents[1] / "scripts" / "fix_network_access.ps1"
        command = f"""
function Set-NetConnectionProfile {{ }}
function Get-NetIPAddress {{ @() }}
function Get-NetTCPConnection {{ @() }}
function netsh {{
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    "NETSH:$($Args -join ' ')"
}}
function Out-Null {{
    process {{ $_ }}
}}
& '{script_path}' -HttpPort 8081 -UdpPort 28777 -SkipUdp
"""
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr or result.stdout)
        self.assertIn(
            'NETSH:advfirewall firewall delete rule name=JoyCon-UDP-28777',
            result.stdout,
        )
        self.assertNotIn(
            'NETSH:advfirewall firewall add rule name=JoyCon-UDP-28777',
            result.stdout,
        )

    def test_fix_network_access_streaming_mode_keeps_8889_local_only_and_opens_frontend(self) -> None:
        script_path = Path(__file__).resolve().parents[1] / "scripts" / "fix_network_access.ps1"
        command = f"""
function Set-NetConnectionProfile {{ }}
function Get-NetIPAddress {{ @() }}
function Get-NetTCPConnection {{ @() }}
function netsh {{
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    "NETSH:$($Args -join ' ')"
}}
function Out-Null {{
    process {{ $_ }}
}}
& '{script_path}' -HttpPort 8082 -FrontendPort 8090 -EnableWebRtcMedia -SkipUdp
"""
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr or result.stdout)
        self.assertIn(
            'NETSH:advfirewall firewall add rule name=JoyCon-Web-8082',
            result.stdout,
        )
        self.assertIn(
            'NETSH:advfirewall firewall add rule name=JoyCon-Frontend-8090',
            result.stdout,
        )
        self.assertIn(
            'NETSH:advfirewall firewall add rule name=JoyCon-WebRTC-UDP-8189',
            result.stdout,
        )
        self.assertIn(
            'NETSH:advfirewall firewall delete rule name=JoyCon-MediaMTX-WebRTC-8889',
            result.stdout,
        )
        self.assertNotIn(
            'NETSH:advfirewall firewall add rule name=JoyCon-MediaMTX-WebRTC-8889',
            result.stdout,
        )


if __name__ == "__main__":
    unittest.main()

import unittest
from inspect import signature
from pathlib import Path
import subprocess
import tempfile


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _media_stack_exports():
    try:
        from streaming.media_stack import build_ffmpeg_publish_command, build_mediamtx_env
    except (ModuleNotFoundError, ImportError) as exc:
        raise AssertionError("streaming.media_stack exports are not implemented") from exc
    return build_mediamtx_env, build_ffmpeg_publish_command


class MediaStackTests(unittest.TestCase):
    def test_runtime_path_helper_finds_winget_executable_when_path_is_missing(self) -> None:
        helper_path = PROJECT_ROOT / "scripts" / "runtime_path_helpers.ps1"

        with tempfile.TemporaryDirectory() as temp_dir:
            package_root = (
                Path(temp_dir)
                / "Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe"
                / "ffmpeg-8.1-essentials_build"
                / "bin"
            )
            package_root.mkdir(parents=True, exist_ok=True)
            expected_exe = package_root / "ffmpeg.exe"
            expected_exe.write_text("", encoding="utf-8")

            command = (
                f"& {{ . '{helper_path}'; "
                "Resolve-ExecutablePath "
                "-ExecutableName 'ffmpeg.exe' "
                "-WingetPackagePrefix 'Gyan.FFmpeg.Essentials' "
                f"-SearchRoots @('{temp_dir}') }}"
            )
            result = subprocess.run(
                ["pwsh", "-NoLogo", "-NoProfile", "-Command", command],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(Path(result.stdout.strip()).samefile(expected_exe), result.stdout)

    def test_build_mediamtx_env_matches_planned_helper_contract(self) -> None:
        build_mediamtx_env, _ = _media_stack_exports()

        self.assertEqual(list(signature(build_mediamtx_env).parameters), ["api_port", "webrtc_udp_port"])

        env = build_mediamtx_env()

        self.assertEqual(env["MTX_API"], "yes")
        self.assertEqual(env["MTX_APIADDRESS"], ":9997")
        self.assertEqual(env["MTX_WEBRTC"], "yes")
        self.assertEqual(env["MTX_WEBRTCADDRESS"], ":8889")
        self.assertEqual(env["MTX_WEBRTCUDPADDRESS"], ":8189")
        self.assertEqual(env["MTX_WEBRTCLOCALUDPADDRESS"], ":8189")
        self.assertEqual(env["MTX_WEBRTCUDPADDRESS"], env["MTX_WEBRTCLOCALUDPADDRESS"])
        self.assertEqual(
            set(env),
            {
                "MTX_API",
                "MTX_APIADDRESS",
                "MTX_WEBRTC",
                "MTX_WEBRTCADDRESS",
                "MTX_WEBRTCUDPADDRESS",
                "MTX_WEBRTCLOCALUDPADDRESS",
            },
        )

    def test_build_ffmpeg_publish_command_uses_low_latency_rtsp_ingest_pipeline(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="rtsp://127.0.0.1:8554/game",
            width=1280,
            height=720,
            fps=60,
            video_device="desktop",
            audio_device="virtual-audio-capturer",
        )

        self.assertEqual(command[0], "ffmpeg.exe")
        self.assertIn("-f", command)
        self.assertIn("lavfi", command)
        self.assertIn("-i", command)
        self.assertIn("ddagrab=framerate=60:video_size=1280x720:draw_mouse=0", command)
        self.assertIn("dshow", command)
        self.assertIn("audio=virtual-audio-capturer", command)
        self.assertIn("h264_nvenc", command)
        self.assertIn("p1", command)
        self.assertIn("ull", command)
        self.assertIn("libopus", command)
        self.assertIn("-rtsp_transport", command)
        self.assertIn("udp", command)
        self.assertIn("rtsp", command)
        self.assertIn("rtsp://127.0.0.1:8554/game", command)
        self.assertNotIn("whip", command)
        self.assertNotIn("desktop", command)
        self.assertNotIn("ddagrab", command)
        self.assertNotIn("libx264", command)
        self.assertNotIn("wasapi", command)
        self.assertNotEqual(command[1:4], ["-f", "ddagrab", "-framerate"])
        self.assertIn("ddagrab=framerate=60:video_size=1280x720:draw_mouse=0", command)

    def test_build_ffmpeg_publish_command_supports_software_encoder_fallback(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="rtsp://127.0.0.1:8554/game",
            width=1280,
            height=720,
            fps=60,
            video_device="desktop",
            audio_device="virtual-audio-capturer",
            video_encoder="libx264",
        )

        self.assertIn("libx264", command)
        self.assertIn("-pix_fmt", command)
        self.assertIn("yuv420p", command)
        self.assertIn("ultrafast", command)
        self.assertIn("zerolatency", command)
        self.assertIn("libopus", command)
        self.assertNotIn("h264_nvenc", command)
        self.assertNotIn("ull", command)

    def test_build_ffmpeg_publish_command_supports_gdigrab_video_fallback(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="rtsp://127.0.0.1:8554/game",
            width=1280,
            height=720,
            fps=60,
            video_device="gdigrab",
            audio_device="virtual-audio-capturer",
        )

        self.assertEqual(command[0], "ffmpeg.exe")
        self.assertEqual(command[1:6], ["-f", "gdigrab", "-framerate", "60", "-draw_mouse"])
        self.assertEqual(command[6], "0")
        self.assertNotIn("-video_size", command)
        self.assertIn("desktop", command)
        self.assertIn("-vf", command)
        self.assertIn("scale=1280:720:flags=fast_bilinear", command)
        self.assertIn("audio=virtual-audio-capturer", command)
        self.assertNotIn("ddagrab=framerate=60:video_size=1280x720:draw_mouse=0", command)

    def test_build_ffmpeg_publish_command_supports_gfxcapture_video_source(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="rtsp://127.0.0.1:8554/game",
            width=1280,
            height=720,
            fps=60,
            video_device="gfxcapture",
            audio_device="",
        )

        self.assertEqual(command[0], "ffmpeg.exe")
        self.assertEqual(command[1:4], ["-f", "lavfi", "-i"])
        self.assertIn(
            "gfxcapture=monitor_idx=0:max_framerate=60:width=1280:height=720:capture_cursor=0:resize_mode=scale:scale_mode=bilinear",
            command,
        )
        self.assertIn("-an", command)
        self.assertNotIn("ddagrab=framerate=60:video_size=1280x720:draw_mouse=0", command)
        self.assertNotIn("desktop", command)
        self.assertNotIn("libopus", command)

    def test_build_ffmpeg_publish_command_sets_explicit_low_delay_nvenc_rate_control(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="rtsp://127.0.0.1:8554/game",
            width=960,
            height=540,
            fps=60,
            video_device="gfxcapture",
            audio_device="",
            video_bitrate_kbps=8500,
        )

        self.assertIn("-rc", command)
        self.assertIn("cbr_ld_hq", command)
        self.assertIn("-b:v", command)
        self.assertIn("8500k", command)
        self.assertIn("-maxrate", command)
        self.assertIn("-bufsize", command)
        self.assertIn("1700k", command)
        self.assertIn("-zerolatency", command)
        self.assertIn("1", command)
        self.assertIn("-rc-lookahead", command)
        self.assertEqual(command[command.index("-rc-lookahead") + 1], "0")
        self.assertIn("-delay", command)
        self.assertEqual(command[command.index("-delay") + 1], "0")

    def test_build_ffmpeg_publish_command_skips_audio_input_when_audio_device_is_blank(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="rtsp://127.0.0.1:8554/game",
            width=1280,
            height=720,
            fps=60,
            video_device="gfxcapture",
            audio_device="",
        )

        self.assertIn("-an", command)
        self.assertNotIn("dshow", command)
        self.assertNotIn("libopus", command)
        self.assertNotIn("-c:a", command)

    def test_build_ffmpeg_publish_command_keeps_whip_transport_available(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="http://127.0.0.1:8889/game/whip",
            width=1280,
            height=720,
            fps=60,
            video_device="gdigrab",
            audio_device="virtual-audio-capturer",
            publish_transport="whip",
        )

        self.assertIn("whip", command)
        self.assertIn("http://127.0.0.1:8889/game/whip", command)
        self.assertNotIn("-rtsp_transport", command)
        self.assertNotIn("rtsp://127.0.0.1:8554/game", command)

    def test_build_ffmpeg_publish_command_prefixes_dshow_alternative_device_names(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            publish_url="rtsp://127.0.0.1:8554/game",
            width=1280,
            height=720,
            fps=60,
            video_device="gdigrab",
            audio_device='@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{TEST}',
        )

        self.assertIn('audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{TEST}', command)

    def test_mediamtx_config_declares_expected_stream_path_and_ports(self) -> None:
        config_path = PROJECT_ROOT / "config" / "mediamtx.yml"
        self.assertTrue(config_path.exists(), f"Missing config file: {config_path}")

        config_text = config_path.read_text(encoding="utf-8")

        self.assertIn("api: yes", config_text)
        self.assertIn("apiAddress: :9997", config_text)
        self.assertIn("webrtc: yes", config_text)
        self.assertIn("webrtcAddress: :8889", config_text)
        self.assertIn("webrtcLocalUDPAddress: :8189", config_text)
        self.assertIn("webrtcIPsFromInterfaces: true", config_text)
        self.assertIn("webrtcIPsFromInterfacesList:", config_text)
        self.assertIn("  - WLAN", config_text)
        self.assertIn("  - astral", config_text)
        self.assertIn("webrtcAdditionalHosts:", config_text)
        self.assertIn("  - 10.0.0.7", config_text)
        self.assertIn("paths:", config_text)
        self.assertIn("game:", config_text)
        self.assertIn("source: publisher", config_text)

    def test_scripts_and_docs_include_streaming_runtime_conventions(self) -> None:
        media_stack_script = PROJECT_ROOT / "scripts" / "start_media_stack.ps1"
        publisher_script = PROJECT_ROOT / "scripts" / "start_stream_publisher.ps1"
        firewall_script = PROJECT_ROOT / "scripts" / "fix_network_access.ps1"
        launcher_script = PROJECT_ROOT / "scripts" / "start_lan_streaming_web_controller.ps1"
        runtime_helper_script = PROJECT_ROOT / "scripts" / "runtime_path_helpers.ps1"
        readme_path = PROJECT_ROOT / "README.md"

        self.assertTrue(media_stack_script.exists(), f"Missing script: {media_stack_script}")
        self.assertTrue(publisher_script.exists(), f"Missing script: {publisher_script}")
        self.assertTrue(firewall_script.exists(), f"Missing script: {firewall_script}")
        self.assertTrue(launcher_script.exists(), f"Missing script: {launcher_script}")
        self.assertTrue(runtime_helper_script.exists(), f"Missing script: {runtime_helper_script}")
        self.assertTrue(readme_path.exists(), f"Missing README: {readme_path}")

        media_stack_text = media_stack_script.read_text(encoding="utf-8")
        self.assertIn("#requires -Version 7.0", media_stack_text)
        self.assertIn("runtime_path_helpers.ps1", media_stack_text)
        self.assertIn("Resolve-ExecutablePath", media_stack_text)
        self.assertIn("bluenviron.mediamtx", media_stack_text)
        self.assertIn("mediamtx.yml", media_stack_text)

        publisher_text = publisher_script.read_text(encoding="utf-8")
        self.assertIn("#requires -Version 7.0", publisher_text)
        self.assertIn("runtime_path_helpers.ps1", publisher_text)
        self.assertIn("Resolve-ExecutablePath", publisher_text)
        self.assertIn("Gyan.FFmpeg.Essentials", publisher_text)
        self.assertIn("Get-PreferredAudioDevice", publisher_text)
        self.assertIn("'Continue'", publisher_text)
        self.assertIn("Exception.Message", publisher_text)
        self.assertIn('[string]$AudioDevice = ""', publisher_text)
        self.assertIn('[string]$VideoDevice = "gfxcapture"', publisher_text)
        self.assertIn('[string]$VideoEncoder = "h264_nvenc"', publisher_text)
        self.assertIn('[int]$VideoBitrateKbps = 6000', publisher_text)
        self.assertIn("libx264", publisher_text)
        self.assertIn("-pix_fmt yuv420p", publisher_text)
        self.assertIn("h264_nvenc", publisher_text)
        self.assertIn("-tune ull", publisher_text)
        self.assertIn("-rc cbr_ld_hq", publisher_text)
        self.assertIn("stream_settings.json", publisher_text)
        self.assertIn("stream_settings.active.json", publisher_text)
        self.assertIn("Get-FileHash", publisher_text)
        self.assertIn("Settings changed; restarting FFmpeg publisher", publisher_text)
        self.assertIn("Start-Sleep -Milliseconds", publisher_text)
        self.assertIn("WaitForExit", publisher_text)
        self.assertIn("$videoBitrate", publisher_text)
        self.assertIn("$videoBuffer", publisher_text)
        self.assertIn("-zerolatency 1", publisher_text)
        self.assertIn("-rc-lookahead 0", publisher_text)
        self.assertIn("-delay 0", publisher_text)
        self.assertIn("zerolatency", publisher_text)
        self.assertIn('"lavfi"', publisher_text)
        self.assertIn('"gdigrab"', publisher_text)
        self.assertIn('"gfxcapture"', publisher_text)
        self.assertIn('gfxcapture=monitor_idx=0:max_framerate=${Fps}:width=${Width}:height=${Height}:capture_cursor=0:resize_mode=scale:scale_mode=bilinear', publisher_text)
        self.assertIn('ddagrab=framerate=${Fps}:video_size=${Width}`x${Height}:draw_mouse=0', publisher_text)
        self.assertIn('-draw_mouse', publisher_text)
        self.assertIn('scale=${Width}:${Height}:flags=fast_bilinear', publisher_text)
        self.assertIn("-f dshow", publisher_text)
        self.assertIn("-an", publisher_text)
        self.assertIn("audio=", publisher_text)
        self.assertIn("ddagrab=", publisher_text)
        self.assertIn('[ValidateSet("rtsp", "whip")]', publisher_text)
        self.assertIn('[Alias("WhipUrl")]', publisher_text)
        self.assertIn("rtsp://127.0.0.1:8554/game", publisher_text)
        self.assertIn("-rtsp_transport udp", publisher_text)
        self.assertIn("-f rtsp", publisher_text)
        self.assertIn("-f whip", publisher_text)
        self.assertNotIn("-f ddagrab", publisher_text)
        self.assertNotIn("-f wasapi", publisher_text)
        self.assertIn("libopus", publisher_text)

        firewall_text = firewall_script.read_text(encoding="utf-8")
        self.assertIn("FrontendPort", firewall_text)
        self.assertIn("WebRtcControlProgram", firewall_text)
        self.assertIn("JoyCon-WebRTC-Control-UDP", firewall_text)
        self.assertIn("JoyCon-Frontend-$FrontendPort", firewall_text)
        self.assertIn("JoyCon-WebRTC-UDP-8189", firewall_text)
        self.assertIn("EnableWebRtcMedia", firewall_text)
        self.assertIn("remoteip=localsubnet", firewall_text)
        self.assertIn("Port = 8189", firewall_text)
        self.assertIn("delete rule name=\"JoyCon-MediaMTX-WebRTC-8889\"", firewall_text)
        self.assertNotIn("@{ Name = \"JoyCon-MediaMTX-WebRTC-8889\"", firewall_text)
        self.assertNotIn("Protocol = 'TCP'; Port = 8889", firewall_text)
        self.assertIn("Streaming gateway target", firewall_text)

        launcher_text = launcher_script.read_text(encoding="utf-8")
        self.assertIn("JoyCon-Frontend-$FrontendPort", launcher_text)
        self.assertIn("JoyCon-WebRTC-Control-UDP", launcher_text)
        self.assertIn("JoyCon-WebRTC-UDP-8189", launcher_text)
        self.assertIn("-FrontendPort", launcher_text)
        self.assertIn("-WebRtcControlProgram", launcher_text)
        self.assertIn("-EnableWebRtcMedia", launcher_text)
        self.assertIn("Media WHEP: http://$($address.IPAddress):$GatewayPort/media/whep", launcher_text)
        self.assertNotIn("JoyCon-MediaMTX-WebRTC-8889", launcher_text)

        readme_text = readme_path.read_text(encoding="utf-8")
        self.assertIn("# 局域网串流 Web Controller", readme_text)
        self.assertIn("## 环境安装", readme_text)
        self.assertIn("## 一键启动", readme_text)
        self.assertIn("## 手机访问", readme_text)
        self.assertIn("## 端口说明", readme_text)
        self.assertIn("mediamtx.exe", readme_text)
        self.assertIn("ffmpeg.exe", readme_text)
        self.assertIn("PowerShell 7", readme_text)
        self.assertIn("Python 3.12", readme_text)
        self.assertIn("ViGEmBus", readme_text)
        self.assertIn("winget install", readme_text)
        self.assertIn("virtual-audio-capturer", readme_text)
        self.assertIn("DirectShow", readme_text)
        self.assertIn("RTSP/TCP", readme_text)
        self.assertIn("rtsp://127.0.0.1:8554/game", readme_text)
        self.assertIn("pwsh .\\scripts\\start_lan_streaming_web_controller.ps1", readme_text)
        self.assertIn("192.168.0.119", readme_text)
        self.assertIn("http://192.168.0.119:8090", readme_text)
        self.assertIn("192.168.0.119:8082", readme_text)
        self.assertIn("http://192.168.0.119:8082/media/whep", readme_text)
        self.assertIn("8090/TCP", readme_text)
        self.assertIn("8082/TCP", readme_text)
        self.assertIn("8189/UDP", readme_text)
        self.assertIn("WebRTC DataChannel", readme_text)
        self.assertIn("Python 程序级 UDP", readme_text)
        self.assertIn("8889/TCP", readme_text)
        self.assertIn("8554/TCP", readme_text)
        self.assertIn("9997/TCP", readme_text)
        self.assertIn("28777/UDP", readme_text)
        self.assertIn("仅本机使用", readme_text)
        self.assertIn("WHEP", readme_text)
        self.assertIn("防火墙", readme_text)
        self.assertIn("管理员", readme_text)
        self.assertNotIn("## Streaming stack quick start", readme_text)

    def test_publisher_runtime_profile_is_not_locked_by_launch_time_dimensions(self) -> None:
        publisher_script = PROJECT_ROOT / "scripts" / "start_stream_publisher.ps1"
        self.assertTrue(publisher_script.exists(), f"Missing script: {publisher_script}")

        publisher_text = publisher_script.read_text(encoding="utf-8")

        self.assertNotIn('ContainsKey("Width")', publisher_text)
        self.assertNotIn('ContainsKey("Height")', publisher_text)
        self.assertNotIn('ContainsKey("Fps")', publisher_text)
        self.assertNotIn('ContainsKey("VideoBitrateKbps")', publisher_text)


if __name__ == "__main__":
    unittest.main()

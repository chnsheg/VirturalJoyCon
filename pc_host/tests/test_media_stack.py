import unittest
from inspect import signature
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _media_stack_exports():
    try:
        from streaming.media_stack import build_ffmpeg_publish_command, build_mediamtx_env
    except (ModuleNotFoundError, ImportError) as exc:
        raise AssertionError("streaming.media_stack exports are not implemented") from exc
    return build_mediamtx_env, build_ffmpeg_publish_command


class MediaStackTests(unittest.TestCase):
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

    def test_build_ffmpeg_publish_command_uses_low_latency_whip_pipeline(self) -> None:
        _, build_ffmpeg_publish_command = _media_stack_exports()

        command = build_ffmpeg_publish_command(
            ffmpeg_exe="ffmpeg.exe",
            whip_url="http://127.0.0.1:8889/game/whip",
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
        self.assertIn("ddagrab=framerate=60:video_size=1280x720", command)
        self.assertIn("virtual-audio-capturer", command)
        self.assertIn("h264_nvenc", command)
        self.assertIn("opus", command)
        self.assertIn("http://127.0.0.1:8889/game/whip", command)
        self.assertNotIn("desktop", command)
        self.assertNotIn("ddagrab", command)
        self.assertNotEqual(command[1:4], ["-f", "ddagrab", "-framerate"])

    def test_mediamtx_config_declares_expected_stream_path_and_ports(self) -> None:
        config_path = PROJECT_ROOT / "config" / "mediamtx.yml"
        self.assertTrue(config_path.exists(), f"Missing config file: {config_path}")

        config_text = config_path.read_text(encoding="utf-8")

        self.assertIn("api: yes", config_text)
        self.assertIn("apiAddress: :9997", config_text)
        self.assertIn("webrtc: yes", config_text)
        self.assertIn("webrtcAddress: :8889", config_text)
        self.assertIn("webrtcLocalUDPAddress: :8189", config_text)
        self.assertIn("paths:", config_text)
        self.assertIn("game:", config_text)
        self.assertIn("source: publisher", config_text)

    def test_scripts_and_docs_include_streaming_runtime_conventions(self) -> None:
        media_stack_script = PROJECT_ROOT / "scripts" / "start_media_stack.ps1"
        publisher_script = PROJECT_ROOT / "scripts" / "start_stream_publisher.ps1"
        firewall_script = PROJECT_ROOT / "scripts" / "fix_network_access.ps1"
        readme_path = PROJECT_ROOT / "README.md"

        self.assertTrue(media_stack_script.exists(), f"Missing script: {media_stack_script}")
        self.assertTrue(publisher_script.exists(), f"Missing script: {publisher_script}")
        self.assertTrue(firewall_script.exists(), f"Missing script: {firewall_script}")
        self.assertTrue(readme_path.exists(), f"Missing README: {readme_path}")

        self.assertIn("mediamtx.yml", media_stack_script.read_text(encoding="utf-8"))

        publisher_text = publisher_script.read_text(encoding="utf-8")
        self.assertIn("h264_nvenc", publisher_text)
        self.assertIn("-tune ull", publisher_text)
        self.assertIn("-f lavfi", publisher_text)
        self.assertIn("ddagrab=", publisher_text)
        self.assertNotIn("-f ddagrab", publisher_text)
        self.assertIn("http://127.0.0.1:8889/game/whip", publisher_text)

        firewall_text = firewall_script.read_text(encoding="utf-8")
        self.assertIn("JoyCon-MediaMTX-WebRTC-8889", firewall_text)
        self.assertIn("Protocol = 'TCP'; Port = 8889", firewall_text)
        self.assertIn("JoyCon-WebRTC-UDP-8189", firewall_text)
        self.assertIn("Port = 8189", firewall_text)
        self.assertIn("Streaming gateway target", firewall_text)

        readme_text = readme_path.read_text(encoding="utf-8")
        self.assertIn("## Streaming stack quick start", readme_text)
        self.assertIn("mediamtx.exe", readme_text)
        self.assertIn("ffmpeg.exe", readme_text)
        self.assertIn("virtual-audio-capturer", readme_text)
        self.assertIn("python stream_gateway.py --host 0.0.0.0 --port 8082", readme_text)
        self.assertIn(".\\scripts\\start_media_stack.ps1", readme_text)
        self.assertIn(".\\scripts\\start_stream_publisher.ps1", readme_text)


if __name__ == "__main__":
    unittest.main()

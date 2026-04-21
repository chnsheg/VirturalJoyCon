from __future__ import annotations


def build_mediamtx_env(api_port: int = 9997, webrtc_udp_port: int = 8189) -> dict[str, str]:
    # Keep the planned legacy helper key and the current MediaMTX local UDP key in sync.
    return {
        "MTX_API": "yes",
        "MTX_APIADDRESS": f":{api_port}",
        "MTX_WEBRTC": "yes",
        "MTX_WEBRTCADDRESS": ":8889",
        "MTX_WEBRTCUDPADDRESS": f":{webrtc_udp_port}",
        "MTX_WEBRTCLOCALUDPADDRESS": f":{webrtc_udp_port}",
    }


def build_ffmpeg_publish_command(
    ffmpeg_exe: str,
    whip_url: str,
    width: int,
    height: int,
    fps: int,
    video_device: str,
    audio_device: str,
) -> list[str]:
    video_filter = "ddagrab" if video_device == "desktop" else video_device
    video_source = f"{video_filter}=framerate={fps}:video_size={width}x{height}"
    return [
        ffmpeg_exe,
        "-f",
        "lavfi",
        "-i",
        video_source,
        "-f",
        "wasapi",
        "-i",
        audio_device,
        "-c:v",
        "h264_nvenc",
        "-tune",
        "ull",
        "-bf",
        "0",
        "-g",
        "30",
        "-c:a",
        "opus",
        "-f",
        "whip",
        whip_url,
    ]

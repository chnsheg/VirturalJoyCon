from __future__ import annotations


def _normalize_dshow_audio_source(audio_device: str) -> str:
    if audio_device.startswith("audio="):
        return audio_device
    return f"audio={audio_device}"


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
    publish_url: str,
    width: int,
    height: int,
    fps: int,
    video_device: str,
    audio_device: str,
    video_encoder: str = "h264_nvenc",
    publish_transport: str = "rtsp",
    video_bitrate_kbps: int = 6000,
) -> list[str]:
    normalized_bitrate_kbps = max(1500, min(50000, int(video_bitrate_kbps)))
    normalized_bufsize_kbps = max(800, int(round(normalized_bitrate_kbps * 0.2)))
    low_delay_nvenc_args = [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p1",
        "-tune",
        "ull",
        "-rc",
        "cbr_ld_hq",
        "-b:v",
        f"{normalized_bitrate_kbps}k",
        "-maxrate",
        f"{normalized_bitrate_kbps}k",
        "-bufsize",
        f"{normalized_bufsize_kbps}k",
        "-rc-lookahead",
        "0",
        "-delay",
        "0",
        "-zerolatency",
        "1",
        "-bf",
        "0",
        "-g",
        "30",
    ]
    video_filter_args: list[str] = []
    if video_device in {"desktop", "ddagrab"}:
        video_args = ["-f", "lavfi", "-i", f"ddagrab=framerate={fps}:video_size={width}x{height}:draw_mouse=0"]
    elif video_device == "gfxcapture":
        video_args = [
            "-f",
            "lavfi",
            "-i",
            "gfxcapture="
            f"monitor_idx=0:max_framerate={fps}:width={width}:height={height}:capture_cursor=0:"
            "resize_mode=scale:scale_mode=bilinear",
        ]
    elif video_device == "gdigrab":
        video_args = ["-f", "gdigrab", "-framerate", str(fps), "-draw_mouse", "0", "-i", "desktop"]
        video_filter_args = ["-vf", f"scale={width}:{height}:flags=fast_bilinear"]
    else:
        video_args = ["-f", "lavfi", "-i", f"{video_device}=framerate={fps}:video_size={width}x{height}"]

    audio_args: list[str]
    normalized_audio_device = str(audio_device or "").strip()
    if normalized_audio_device:
        audio_args = ["-f", "dshow", "-i", _normalize_dshow_audio_source(normalized_audio_device), "-c:a", "libopus"]
    else:
        audio_args = ["-an"]

    if video_encoder == "h264_nvenc":
        video_codec_args = low_delay_nvenc_args
    elif video_encoder == "libx264":
        video_codec_args = [
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-bf",
            "0",
            "-g",
            "30",
        ]
    else:
        raise ValueError(f"unsupported_video_encoder:{video_encoder}")

    if publish_transport == "rtsp":
        transport_args = ["-f", "rtsp", "-rtsp_transport", "udp", publish_url]
    elif publish_transport == "whip":
        transport_args = ["-f", "whip", publish_url]
    else:
        raise ValueError(f"unsupported_publish_transport:{publish_transport}")

    return [
        ffmpeg_exe,
        *video_args,
        *audio_args,
        *video_filter_args,
        *video_codec_args,
        *transport_args,
    ]

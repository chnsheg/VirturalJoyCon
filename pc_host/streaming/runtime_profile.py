from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class StreamProfile:
    width: int
    height: int
    fps: int
    bitrate_kbps: int

    def to_payload(self) -> dict[str, int]:
        return {
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "bitrateKbps": self.bitrate_kbps,
        }


@dataclass(frozen=True, slots=True)
class SourceCaps:
    width: int
    height: int
    fps: int

    def to_payload(self) -> dict[str, int]:
        return {
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
        }


DEFAULT_SOURCE_CAPS = SourceCaps(width=3840, height=2160, fps=60)
DEFAULT_RUNTIME_CAPS = SourceCaps(width=3840, height=2160, fps=60)


def clamp_effective_profile(
    requested: StreamProfile,
    *,
    source_caps: SourceCaps = DEFAULT_SOURCE_CAPS,
    runtime_caps: SourceCaps = DEFAULT_RUNTIME_CAPS,
) -> StreamProfile:
    return StreamProfile(
        width=min(requested.width, source_caps.width, runtime_caps.width),
        height=min(requested.height, source_caps.height, runtime_caps.height),
        fps=min(requested.fps, source_caps.fps, runtime_caps.fps),
        bitrate_kbps=requested.bitrate_kbps,
    )


def build_stream_settings_payload(
    *,
    requested: StreamProfile,
    effective: StreamProfile,
    source_caps: SourceCaps = DEFAULT_SOURCE_CAPS,
    applied: bool,
) -> dict[str, object]:
    return {
        **requested.to_payload(),
        "requested": requested.to_payload(),
        "effective": effective.to_payload(),
        "sourceCaps": source_caps.to_payload(),
        "applied": applied,
    }

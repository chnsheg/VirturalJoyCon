import unittest

from streaming.runtime_profile import (
    SourceCaps,
    StreamProfile,
    build_stream_settings_payload,
    clamp_effective_profile,
)


class RuntimeProfileTests(unittest.TestCase):
    def test_clamp_effective_profile_limits_requested_fps_to_source_cap(self) -> None:
        requested = StreamProfile(width=1920, height=1080, fps=90, bitrate_kbps=9000)

        effective = clamp_effective_profile(
            requested,
            source_caps=SourceCaps(width=2560, height=1440, fps=50),
            runtime_caps=SourceCaps(width=3840, height=2160, fps=60),
        )

        self.assertEqual(
            effective,
            StreamProfile(width=1920, height=1080, fps=50, bitrate_kbps=9000),
        )

    def test_build_stream_settings_payload_preserves_flat_requested_fields(self) -> None:
        requested = StreamProfile(width=1920, height=1080, fps=90, bitrate_kbps=9000)
        effective = StreamProfile(width=1920, height=1080, fps=60, bitrate_kbps=8500)

        payload = build_stream_settings_payload(
            requested=requested,
            effective=effective,
            source_caps=SourceCaps(width=3840, height=2160, fps=60),
            applied=False,
        )

        self.assertEqual(payload["width"], 1920)
        self.assertEqual(payload["height"], 1080)
        self.assertEqual(payload["fps"], 90)
        self.assertEqual(payload["bitrateKbps"], 9000)
        self.assertEqual(
            payload["requested"],
            {
                "width": 1920,
                "height": 1080,
                "fps": 90,
                "bitrateKbps": 9000,
            },
        )
        self.assertEqual(
            payload["effective"],
            {
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "bitrateKbps": 8500,
            },
        )
        self.assertEqual(
            payload["sourceCaps"],
            {
                "width": 3840,
                "height": 2160,
                "fps": 60,
            },
        )
        self.assertFalse(payload["applied"])


if __name__ == "__main__":
    unittest.main()

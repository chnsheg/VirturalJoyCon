# FRPC Low-Jitter Public Streaming Notes

**Goal**
Document the stable public behavior for the LAN streaming controller when operators expose it through FRPC or another public tunnel.

**Implemented behavior**
- Media stays on the existing WebRTC/WHEP path. When public UDP reachability is available, the effective media path remains WebRTC/UDP rather than falling back to a TCP media relay.
- Public control prefers WebRTC DataChannel. WebSocket remains a warm fallback, and HTTP is last resort when the higher-priority paths are unavailable.
- Requested stream settings remain separate from the effective stream profile. requested FPS may be clamped to the source refresh rate or other runtime caps before the publisher reports the active profile.
- Operators can verify the effective stream profile through `/api/stream/settings` and `.runtime/stream_settings.active.json`.
- Health telemetry plus transport hysteresis reduce visible stalls and control-mode flapping during short transport interruptions, but they do not remove the need for working FRPC UDP/public reachability.

**Non-goals**
- Do not claim parity with Moonlight transport behavior or perfect WAN resilience.
- Do not describe a guaranteed TCP media fallback path for video; the quality of the public path still depends on FRPC, NAT handling, and WAN conditions.

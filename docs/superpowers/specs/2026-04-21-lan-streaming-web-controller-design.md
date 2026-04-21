# LAN Streaming Web Controller Design

## Summary

This design adds a low-latency LAN game streaming layer to the existing JoyCon web controller so users can see the remote game, hear game audio, and operate the virtual gamepad in a single immersive browser screen.

The target multiplayer model is one Windows game host streaming one shared game view to multiple browser clients. Each active player receives a virtual gamepad seat such as 1P, 2P, 3P, or 4P. When all seats are occupied, additional users can watch and automatically take a seat when one becomes free.

Latency is the top priority. The design therefore chooses WebRTC media and WebRTC data channels as the primary protocols, with UDP host-candidate paths preferred on LAN and Astral-style overlay LANs. WebSocket and HTTP remain compatibility fallbacks, not the primary low-latency path.

## Goals

- Put game video, game audio, connection status, and the virtual gamepad on one web page.
- Remove the need for a separate remote screen-sharing application.
- Support one host game view shared by multiple players at the same time.
- Automatically assign free virtual gamepad seats in a first-come, first-served model.
- Keep media latency low enough for interactive game control, not passive viewing.
- Keep control latency independent from media buffering or video congestion.
- Reuse the existing web controller input model and Python virtual gamepad host where practical.
- Make the networking model work over normal LAN and Astral-style remote LAN software.

## Non-Goals

- No Internet-scale public cloud streaming platform in this iteration.
- No host-side game launcher, account system, billing, matchmaking, or friend list.
- No iPhone Safari hard requirement for the first version.
- No 4K-first quality target. 720p60 and 1080p60 are the first practical targets.
- No traditional live-streaming protocols such as HLS or MPEG-DASH for gameplay.
- No browser-only host capture path as the main architecture.

## Current Project Context

The repository currently contains a standalone browser gamepad under `pc_host/web/` and a Python `aiohttp` host in `pc_host/web_host.py`. The current control path supports:

- `GET /ws` for WebSocket input transport.
- `POST /input` and `OPTIONS /input` for HTTP fallback.
- Persistent client IDs and input stream IDs in browser storage.
- Virtual gamepad slot allocation through the Python host and `VirtualDevicePool`.
- A low-visibility drawer for host settings.

The new streaming tool should extend this shape instead of discarding it. The browser controller remains the UX foundation, but the media path becomes a first-class subsystem and the control protocol is upgraded for lower latency.

## Architecture

### Recommended Approach

Use a host-local room service with three cooperating responsibilities:

1. Native capture and hardware encoding.
2. WebRTC SFU-style media distribution.
3. Realtime room, seat, and control coordination.

The Windows host runs the game, captures video and system audio, encodes the stream once, and publishes that stream into a room. Multiple browser clients subscribe to the same media tracks and independently send their input packets back to the host.

The critical point is that the host must not encode a separate video stream per player. One encoded stream should be forwarded to many subscribers by the room service. This keeps the design aligned with mature game streaming systems such as Sunshine/Moonlight while making it browser-native through WebRTC.

### Runtime Topology

```text
Windows game
  -> native capture and encoder
  -> WebRTC publish to local room service / SFU
  -> browser clients subscribe to video and audio tracks

Browser virtual gamepad
  -> dedicated WebRTC DataChannel control connection
  -> room control gateway
  -> Python virtual gamepad host or native gamepad actuator
  -> game
```

The media path and control path share the same room identity but remain operationally separate. Video jitter must never queue control packets behind video work.

### Deployment Model

All primary services run on the Windows game host for the first version:

- `stream_host`: native capture, audio capture, hardware encoder, WebRTC publisher.
- `room_gateway`: signaling, room tokens, seat allocation, WebRTC negotiation, SFU forwarding, stats.
- `gamepad_host`: existing Python virtual gamepad host, adapted to accept room-aware control packets.
- `web_controller`: static browser UI with video, audio, gamepad overlay, and settings drawer.

This keeps LAN deployment simple and avoids introducing a cloud dependency. A future version may split the SFU onto another LAN machine if needed, but that is not required for the first implementation.

## Protocol Decision

### Media Protocol

Primary media protocol: WebRTC RTP/RTCP over SRTP, negotiated by WebRTC signaling.

The host encoder should publish audio and video into the room service using a WHIP-compatible or WHIP-inspired ingest endpoint when practical. Browser clients should subscribe using normal WebRTC offer/answer through the room gateway or a WHEP-style egress endpoint if the chosen media server supports it.

LAN priority order:

1. WebRTC UDP host candidate.
2. WebRTC UDP server-reflexive or overlay candidate when Astral exposes one.
3. WebRTC TCP only as a degraded compatibility path.
4. TURN relay only when explicitly enabled, because relay paths add latency and bandwidth load.

Traditional HLS, DASH, FLV, MSE chunked playback, and generic screen sharing are rejected for the gameplay path because their buffering model is built for playback stability rather than input-responsive gaming.

### Control Protocol

Primary control protocol: WebRTC DataChannel on a dedicated control `RTCPeerConnection`.

The control connection should not be multiplexed through the media SFU when a direct browser-to-host control gateway connection is available. A separate control peer connection gives the input channel its own SCTP association, buffering limits, stats, and reconnection lifecycle.

Use two channels:

- `joycon.input.v1`: unordered, unreliable, binary, `maxRetransmits: 0`, latest-state packets only.
- `joycon.control.v1`: ordered, reliable, binary or compact JSON, for join, seat, heartbeat, resync, and error events.

This is the lowest-latency practical browser protocol for the first version because it avoids TCP head-of-line blocking and reuses WebRTC ICE, DTLS, NAT traversal, and browser support. It is also mature enough across modern browsers.

WebTransport datagrams are a planned experimental transport, not the first primary transport. WebTransport is advanced and supports unreliable datagrams over HTTP/3, but it requires secure contexts, HTTP/3 server work, certificate handling, and does not provide WebRTC's media integration or ICE behavior. It should be evaluated after the WebRTC path is stable.

### Fallback Protocols

Fallback control order:

1. WebRTC DataChannel.
2. WebSocket over the room gateway.
3. Existing HTTP `POST /input` fallback for last-resort compatibility.

When falling back to WebSocket or HTTP, the UI must label the mode as degraded because TCP buffering can increase input latency under packet loss.

## Media Pipeline

### Video Capture

The native host should capture the game or desktop using this preference order:

1. Windows.Graphics.Capture for modern Windows capture and window selection.
2. DXGI Desktop Duplication as a compatibility fallback.
3. Full-screen display capture only if per-window capture is unavailable or unstable.

The capture path should avoid screenshot-style polling. The goal is to keep frames in GPU memory as long as practical and avoid unnecessary CPU copies before encoding.

### Audio Capture

Capture system audio through WASAPI loopback. The first version streams the same game/system audio to all clients.

Audio should be encoded with Opus through WebRTC. Echo cancellation and microphone processing are not part of the first version because the browser is receiving game audio, not publishing voice chat.

### Encoding

Use hardware encoding by default:

- NVIDIA NVENC.
- AMD AMF.
- Intel Quick Sync.

Encoding policy:

- Start with H.264 for browser compatibility and hardware decode reliability.
- Prefer a low-latency encoder preset.
- Disable B-frames for the gameplay profile.
- Use short GOP/keyframe intervals suitable for fast recovery.
- Prefer constant or constrained bitrate modes that avoid large encode buffers.
- Default to 720p60 or 1080p60, not 4K.
- Provide an experimental advanced codec profile for AV1 or HEVC only after capability probing confirms host encode and client hardware decode support.

Codec capability should be negotiated per client, but the room should avoid forcing the host to encode many custom variants in the first version. A single primary H.264 stream is the reliable baseline.

### SFU Distribution

The room service forwards encoded WebRTC tracks to subscribers without transcoding or compositing. This matches the SFU model: the publisher sends one encoded stream to the server, and the server forwards the track to interested subscribers.

The SFU should support:

- One hidden host publisher participant.
- Multiple browser subscriber participants.
- Selective subscription for video/audio tracks.
- Server-side stats for packet loss, jitter, bitrate, RTT, and selected candidate pair.
- Graceful subscriber removal without restarting the publisher stream.

The first version can run the SFU as a single local node. Distributed SFU routing is out of scope.

### Congestion and Quality Adaptation

The system should optimize for latency before quality:

- If jitter rises, reduce bitrate before increasing player buffer.
- If packet loss persists, reduce resolution or frame rate before accumulating delay.
- Warn users when the selected candidate pair is TCP or relay.
- Expose a simple quality selector: `Auto`, `Data Saver`, `Balanced`, `Sharp`.
- Keep `Auto` as the default and tune it toward low delay.

## Control and Seat Model

### Free Seating

The first version uses automatic free seating:

1. A browser joins a room using a room URL or target host.
2. The room gateway validates the room token.
3. The gateway assigns the first free seat from `1P` to `4P`.
4. If all seats are full, the client becomes a spectator.
5. Spectators receive audio and video but cannot send gameplay input.
6. When a seat becomes free, the first waiting spectator may be promoted.

No host approval UI is required for the first version.

### Seat Reservation

Each active player has:

- `room_id`.
- `player_id`.
- `seat_index`.
- `reconnect_token`.
- `seat_epoch`.
- `last_seen_ms`.
- `role`, either `player` or `spectator`.

When a player disconnects, the gateway reserves the seat for 8 to 15 seconds. If the same `player_id` reconnects with a valid `reconnect_token`, it should recover the same seat and increment the `seat_epoch`.

### Input Packet Semantics

Input packets represent latest full controller state, not irreversible edge-only commands. Every packet should include buttons, sticks, triggers, sequence number, monotonic client timestamp, seat epoch, and input stream ID.

Recommended binary fields:

```text
magic: u16
version: u8
flags: u8
room_id_hash: u64
player_id_hash: u64
seat_index: u8
seat_epoch: u16
stream_epoch: u16
sequence: u32
client_time_us: u64
buttons_bits: u32
left_x: i16
left_y: i16
right_x: i16
right_y: i16
lt: u16
rt: u16
```

Analog values should be quantized to fixed-width integers to reduce payload size and parsing overhead. The receiver must drop stale packets where `sequence` or `stream_epoch` is older than the latest accepted packet for that seat.

### Input Sending Policy

Buttons:

- Send immediately on press and release.
- Repeat the full state for a small burst after each edge to reduce the effect of one lost unreliable packet.

Sticks and triggers:

- Sample using pointer coalescing where available.
- Send at a capped rate, initially 120 Hz maximum.
- If the channel buffer is not empty, drop the older unsent analog state and keep only the latest state.

Heartbeats:

- Send low-rate heartbeats on `joycon.control.v1`.
- Do not create or hold a virtual gamepad seat until the user has actually joined as a player.

Release safety:

- On page hide, disconnect, or role downgrade, send a reliable all-buttons-up release on `joycon.control.v1`.
- The host must also release all controls for a seat when its reservation expires.

## Browser UX

### Immersive Layout

The default browser experience is landscape-first:

- WebRTC video fills the page as the base layer.
- Gamepad controls are semi-transparent overlays.
- Left stick sits near the lower-left side.
- Face buttons sit near the lower-right side.
- Start, Select, and auxiliary controls sit near the bottom center.
- The top status bar stays compact and low-contrast.

Portrait mode is supported as a fallback:

- Video remains the priority content.
- Controls move to a lower overlay or lower control region.
- The UI should encourage rotation for best latency perception and ergonomics.

### Status Display

The always-visible status layer should show:

- Room identifier or short room code.
- Seat such as `1P`, `2P`, `spectating`, or `reconnecting`.
- Input latency estimate.
- Media RTT or glass-to-glass estimate when available.
- Resolution and frame rate.
- Candidate type: `UDP`, `TCP`, or `relay`.
- Audio state.

The status layer must not become a dashboard. Detailed stats belong in the drawer.

### Settings Drawer

The existing low-visibility edge drawer should expand to include:

- Host or room target.
- Join/reconnect action.
- Quality selector.
- Audio mute toggle.
- Controller sensitivity.
- Current protocol mode.
- Debug stats toggle.

The drawer remains hidden during gameplay and should never cover the primary action areas when closed.

## Host and Service Boundaries

### Native Stream Host

Responsibilities:

- Capture video.
- Capture system audio.
- Encode video and audio.
- Publish media tracks into the room service.
- Report capture, encode, and send timing.

The native service may be implemented in a systems language or by integrating mature WebRTC/media libraries. The design does not require replacing the Python virtual gamepad code in the first version.

### Room Gateway

Responsibilities:

- Serve signaling endpoints.
- Issue and validate room tokens.
- Manage players, spectators, seats, and reconnect tokens.
- Own WebRTC negotiation for media subscribers and control peer connections.
- Forward media tracks through SFU behavior.
- Terminate DataChannel input packets or route them to the control actuator.
- Expose room and transport stats.

### Python Gamepad Host

Responsibilities:

- Maintain virtual gamepad pool.
- Map accepted seat input to virtual controller devices.
- Release devices on disconnect, timeout, or all-buttons-up safety events.

The Python host can initially receive sanitized control states from the room gateway over localhost IPC or a localhost UDP bridge. This avoids exposing the legacy HTTP/WS control endpoints as the main multiplayer control plane.

## Network and Firewall Design

### Ports

The host should expose:

- One HTTPS or HTTP signaling port for the web UI and room gateway.
- One UDP port or UDP range for WebRTC ICE host candidates.
- Optional TCP WebRTC fallback port.
- Optional legacy TCP port for old standalone controller compatibility.

For local development over HTTP, browser restrictions around secure contexts must be tested carefully. Production-like LAN use should move toward HTTPS because WebRTC, WebTransport experiments, permissions, and service worker features are increasingly tied to secure contexts.

### Astral and Overlay LAN Behavior

Astral-style remote LAN software should be treated as a private network path. The connection checker should show whether clients are using:

- Direct physical LAN.
- Astral overlay address.
- TCP fallback.
- Relay path.

The UI should recommend UDP direct or overlay UDP when possible. If the selected path becomes TCP, the player should see a clear degraded-mode warning.

## Latency Targets

These are first-version success targets, not guarantees:

- Browser-to-host input network p50 below 10 ms on a healthy LAN or overlay LAN.
- Browser-to-host input network p95 below 25 ms on a healthy LAN or overlay LAN.
- Glass-to-glass media p50 below 80 ms at 720p60 or 1080p60 on a healthy LAN.
- Glass-to-glass media p95 below 120 ms on a healthy LAN.
- Seat recovery after short disconnect within 2 seconds once transport reconnects.

Measurement should use a combination of:

- DataChannel ping/pong RTT.
- WebRTC `getStats()` selected candidate, RTT, jitter, packet loss, and bitrate.
- Host capture and encode timestamps.
- Optional visual latency calibration screen for glass-to-glass testing.

## Error Handling

### Media Errors

- If media cannot connect, the page should keep the controller layer alive only if the user explicitly enables input-without-video.
- If the selected path is TCP or relay, show degraded latency mode.
- If decoder capability fails, retry with H.264 baseline-compatible settings.
- If audio fails, keep video and controls alive with an audio warning.

### Control Errors

- If `joycon.input.v1` fails, try to reconnect the DataChannel without dropping the seat immediately.
- If DataChannel reconnection fails, downgrade to WebSocket and mark input mode as degraded.
- If the control path is fully unavailable, release the seat after the reservation window.
- If stale packets arrive for an old `seat_epoch`, drop them silently.

### Full Room

- A full room returns `role: spectator`.
- Spectators should see the video and an explicit `waiting for seat` status.
- Spectators must not instantiate virtual gamepad devices.

## Security Model

This is a LAN and overlay-LAN tool, not an Internet-facing public service. Still, the first version should include basic safety:

- Room join links include an unguessable token.
- Player reconnect tokens are separate from room tokens.
- The host only accepts control packets for valid room, player, seat, and epoch combinations.
- The UI shows which remote peers are connected.
- CORS remains permissive only for development endpoints that do not control gameplay.
- Public WAN exposure should be documented as unsupported unless a future hardening pass is completed.

## Testing Strategy

### Unit Tests

Add tests for:

- Room token parsing.
- Seat allocation and spectator overflow.
- Reconnect token seat recovery.
- Seat reservation expiry.
- Input packet sequence and epoch rejection.
- Binary input packet encode/decode.
- Controller release on disconnect and timeout.

### Integration Tests

Add tests for:

- Browser joins room and receives player role.
- Fifth browser becomes spectator when four seats are occupied.
- Spectator promotion after a player leaves.
- DataChannel input path updates the expected virtual seat.
- WebSocket fallback path is marked degraded.
- Media subscription failure does not corrupt seat state.

### Manual Verification

Verify:

- 720p60 and 1080p60 LAN sessions.
- Two, three, and four simultaneous browser clients.
- Android Chrome, desktop Chrome/Edge, and at least one tablet browser.
- Astral overlay address path.
- UDP path vs TCP fallback warning.
- Audio/video sync.
- Page hide, refresh, and reconnect release controls safely.
- Short Wi-Fi interruption preserves seat.

## Risks and Mitigations

- WebRTC implementation complexity is higher than WebSocket, but it is the browser-native path for low-latency media and unreliable realtime data.
- Hardware encoder behavior varies by GPU and driver. Mitigate with H.264 baseline defaults and explicit encoder diagnostics.
- Browser autoplay policies may block audio until user interaction. Mitigate by using the first controller interaction or join button to unlock audio.
- WebTransport may become attractive for control datagrams, but first-version compatibility and ICE behavior favor DataChannel.
- A single local SFU still consumes upstream bandwidth for each subscriber. It avoids repeated encoding, but Wi-Fi quality still matters for multiple clients.
- Overlay LAN tools may route through paths that are not truly low latency. The UI must reveal selected candidate type and measured RTT.

## References

- Sunshine describes a self-hosted low-latency game streaming host with AMD, Intel, and NVIDIA hardware encoding support: https://app.lizardbyte.dev/Sunshine/
- Moonlight documents game streaming goals such as broad client support, 120 FPS streaming, and low-latency options: https://moonlight-stream.org/
- MDN WebRTC API documents browser media and data connections through `RTCPeerConnection` and `RTCDataChannel`: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
- MDN RTCDataChannel documents ordered delivery, retransmission limits, buffering, and UDP/DTLS/SCTP data format: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel
- LiveKit's SFU documentation describes forwarding encoded tracks from publishers to subscribers without manipulating packets: https://docs.livekit.io/reference/internals/livekit-sfu
- LiveKit ports and firewall documentation shows WebRTC's UDP-first deployment requirements and TCP fallback behavior: https://docs.livekit.io/home/self-hosting/ports-firewall/
- RFC 9725 standardizes WHIP as a WebRTC-HTTP ingestion protocol for sending encoded media into WebRTC services: https://www.rfc-editor.org/rfc/rfc9725.html
- MDN WebTransport documents reliable streams and unreliable datagrams over HTTP/3, with secure-context requirements: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport

## Success Criteria

The design is successful when:

- Users can open one web page and see the remote game, hear audio, and operate the virtual controller.
- One host stream can support multiple simultaneous browser viewers without re-encoding per viewer.
- Four players can automatically receive independent virtual gamepad seats.
- Additional users become spectators instead of disturbing active players.
- Input remains responsive even when video quality adapts.
- The UI clearly indicates when the network path is no longer in the preferred UDP low-latency mode.
- Existing standalone controller behavior can remain available as a compatibility path.

# LAN Wireless Virtual Gamepad Host (MVP)

## Project startup overview

For the current streaming build, start the project from `pc_host` in this order:

1. Install Python and runtime dependencies once.
2. Open the Windows firewall only for the LAN-facing ports the phone actually needs: `8090/TCP`, `8082/TCP`, and `8189/UDP`.
3. Start `stream_gateway.py` on `8082/TCP`.
4. Start MediaMTX with `pwsh .\scripts\start_media_stack.ps1`.
5. Start FFmpeg publishing with `pwsh .\scripts\start_stream_publisher.ps1`.
6. Host `pc_host\web` as static files, open the page from the client, and enter `LAN_IP:8082` in the drawer.

Keep these three long-running processes open while testing: the Python stream gateway, MediaMTX, and the FFmpeg publisher. Use the standalone controller section later in this document only when you want the input-only `web_host.py` path on `8081/TCP`.

## Streaming stack quick start

Use this flow for the shared browser video/audio stream plus WebRTC control gateway. The phone only needs `8090/TCP` for the static frontend, `8082/TCP` for the gateway and proxied media entrypoint, plus `8189/UDP` for WebRTC media. `8889/TCP stays local` on the host and does not need a Windows firewall rule.
The stable Windows path is FFmpeg low-latency encoding into local RTSP/TCP ingest (`rtsp://127.0.0.1:8554/game`), then MediaMTX WHEP/WebRTC playback in the browser.
Run every PowerShell command in this section with PowerShell 7 via `pwsh`, not Windows PowerShell 5.1.

If you are chasing sub-20ms video latency, the PC display/capture path and the client display both need to sustain 120Hz-class updates. If FFmpeg stats show requested `90` or `120` fps but actual `fps` stays near `59`, or `dup=` keeps climbing, the capture source is capped around 60Hz and the frame budget is already mostly consumed before network and decode.

### 1. Install dependencies

Run inside `pc_host`:

```bash
pip install -r requirements.txt
```

You also need these non-Python runtime dependencies before the streaming stack will work:

- `mediamtx.exe` available on `PATH` or passed to `.\scripts\start_media_stack.ps1`
- `ffmpeg.exe` available on `PATH` or passed to `.\scripts\start_stream_publisher.ps1`
- A valid Windows DirectShow audio capture device for FFmpeg input, for example `virtual-audio-capturer`

Recommended install commands:

```powershell
winget install --id bluenviron.mediamtx --exact
winget install --id Gyan.FFmpeg.Essentials --exact
```

The startup scripts auto-detect the default winget install directories, so they still work when a fresh `pwsh` session has not picked up a PATH update yet.

For low latency on the same LAN, keep `config/mediamtx.yml` restricted to the physical Wi-Fi interface:

```yaml
webrtcIPsFromInterfaces: true
webrtcIPsFromInterfacesList:
  - WLAN
webrtcAdditionalHosts: []
```

Use the WLAN address printed by Windows, for example `192.168.0.119:8082`, in the controller drawer. Do not use tunnel or virtual-adapter addresses such as `10.x`, `172.25.x`, or `169.254.x` for the LAN latency test. If a remote browser is on the same Wi-Fi and MediaMTX logs still show a wrong WebRTC candidate such as `172.25.x.x` or `169.254.x.x`, restart MediaMTX after fixing `config/mediamtx.yml`.

### 2. Open the Windows firewall when needed

Run inside `pc_host` from an elevated PowerShell 7 session:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8082 -FrontendPort 8090 -EnableWebRtcMedia -SkipUdp
```

The helper opens only the LAN-facing ports: `8090/TCP`, `8082/TCP`, and `8189/UDP`. MediaMTX still listens locally on `8889/TCP`, but `8889/TCP stays local` and is not opened to the LAN.

### 3. Start the control gateway

Run inside `pc_host`:

```bash
python stream_gateway.py --host 0.0.0.0 --port 8082
```

### 4. Start MediaMTX

Run inside `pc_host`:

```powershell
pwsh .\scripts\start_media_stack.ps1
```

### 5. Start the Windows publisher

Run inside `pc_host`:

```powershell
pwsh .\scripts\start_stream_publisher.ps1
```

The default publisher path assumes an NVIDIA GPU with NVENC, uses `h264_nvenc`, and publishes to MediaMTX through local RTSP/TCP ingest. TCP is the default because it avoids local RTP packet loss between FFmpeg and MediaMTX, which otherwise forces the browser to recover from damaged or missing H264 frames.
The script auto-detects a DirectShow audio capture device and prefers virtual or loopback-style devices when available.
If NVENC is unavailable, use the software fallback without editing the script:

```powershell
pwsh .\scripts\start_stream_publisher.ps1 -VideoEncoder libx264
```

The `libx264` fallback keeps the low-latency design with `-preset ultrafast -tune zerolatency`, but it will use more CPU than the NVIDIA NVENC path.
If you want to force a specific audio source, pass the DirectShow device name explicitly:

```powershell
pwsh .\scripts\start_stream_publisher.ps1 -AudioDevice "virtual-audio-capturer"
```

If Desktop Duplication is unavailable on this machine, use the GDI fallback explicitly:

```powershell
pwsh .\scripts\start_stream_publisher.ps1 -VideoDevice gdigrab
```

If you later switch to a FFmpeg build with compatible direct WHIP ingest, you can opt into it explicitly:

```powershell
pwsh .\scripts\start_stream_publisher.ps1 -PublishTransport whip -PublishUrl http://127.0.0.1:8889/game/whip
```

RTSP/UDP remains available only for comparison runs. Use it if you want to verify whether a specific machine can avoid packet loss in MediaMTX logs:

```powershell
pwsh .\scripts\start_stream_publisher.ps1 -PublishTransport rtsp_udp
```

### 6. Open the frontend and connect

Host `pc_host\web` with any static HTTP server, open the page from the phone, then connect the drawer to `LAN_IP:8082`.

Example:

```bash
cd web
python -m http.server 8090 --bind 0.0.0.0
```

Open the frontend on the phone:

```text
http://192.168.0.119:8090
```

Enter this host target in the drawer:

```text
192.168.0.119:8082
```

For media playback, the browser or other client should subscribe through the gateway WHEP endpoint:

```text
http://192.168.0.119:8082/media/whep
```

Replace `192.168.0.119` with this host's reachable LAN IP. If a remote browser does not subscribe to `http://<LAN_IP>:8082/media/whep`, it will not receive the published stream even if the publisher is running.

## Standalone web controller quick start

### 1. Requirements

- Windows 10/11
- Python 3.12 or newer
- `ViGEmBus / Nefarius Virtual Gamepad Emulation Bus`
- Phone and PC on the same LAN

### 2. Install dependencies

Run inside `pc_host`:

```bash
pip install -r requirements.txt
```

### 3. Start the Python host

Run inside `pc_host`:

```bash
python web_host.py --host 0.0.0.0 --http-port 8081 --udp-port 28777 --timeout 8 --max-devices 4
```

The host prints `Standalone controller target: <LAN_IP>:8081` when it detects one private LAN address.
The standalone frontend expects an IPv4 target in `LAN_IP:port` format only.

If auto-detection does not find a private LAN address, manually enter this PC's reachable IPv4 address and port, for example `192.168.0.119:8081`.

### 4. Open the Windows firewall when needed

Run inside `pc_host` from an elevated PowerShell 7 session:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8081 -SkipUdp
```

If you also need the legacy UDP path:

```powershell
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8081 -UdpPort 28777
```

### 5. Host the standalone frontend

Frontend files are in `pc_host\web`. You can host them with any static HTTP server. Quick example:

```bash
cd web
python -m http.server 8090 --bind 0.0.0.0
```

### 6. Open the frontend and connect

- Visit the frontend page, for example `http://<frontend-host-ip>:8090`
- Pull open the thin right-side drawer
- Enter the Python host target as `LAN_IP:8081`
- Optionally adjust `Stick sensitivity` in the same drawer if the default stick feel is too stiff
- Press `Connect`
- The host target and stick sensitivity are saved locally on that device for the next visit

## Runtime summary

1. Install dependencies in `pc_host`:

```bash
pip install -r requirements.txt
```

2. Start the Python host:

```bash
python web_host.py --host 0.0.0.0 --http-port 8081 --udp-port 28777 --timeout 8 --max-devices 4
```

3. If the phone or another PC cannot reach `8081/TCP`, run the firewall helper in an elevated PowerShell 7 window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8081 -SkipUdp
```

4. Host `pc_host/web` separately and open it in a browser:

```text
http://<frontend-host-ip>:8090
```

5. In the frontend drawer, enter the host terminal's `Standalone controller target: <LAN_IP>:8081`.
   The input must stay in IPv4 `LAN_IP:port` format, not a hostname.

6. Optional: run the legacy UDP-only bridge:

```bash
python gamepad_session_manager.py --host 0.0.0.0 --port 28777 --timeout 8 --max-devices 4
```

## If the phone cannot reach the host

Usually this means:

- The current Wi-Fi network profile is `Public`
- Windows Firewall is not allowing inbound `8081/TCP`

Run inside `pc_host` from an elevated PowerShell 7 session:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8081 -SkipUdp
```

If you also need the legacy UDP bridge:

```powershell
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8081 -UdpPort 28777
```

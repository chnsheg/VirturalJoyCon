# LAN Wireless Virtual Gamepad Host (MVP)

## Streaming stack quick start

Use this flow for the shared browser video/audio stream plus WebRTC control gateway. It adds `8082/TCP` for the stream gateway, `8889/TCP` for MediaMTX WebRTC HTTP, and `8189/UDP` for WebRTC media.

### 1. Install dependencies

Run inside `pc_host`:

```bash
pip install -r requirements.txt
```

You also need these non-Python runtime dependencies before the streaming stack will work:

- `mediamtx.exe` available on `PATH` or passed to `.\scripts\start_media_stack.ps1`
- `ffmpeg.exe` available on `PATH` or passed to `.\scripts\start_stream_publisher.ps1`
- A valid Windows audio capture device for FFmpeg WASAPI input, for example `virtual-audio-capturer`

### 2. Open the Windows firewall when needed

Run inside `pc_host` from an elevated PowerShell session:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\fix_network_access.ps1 -HttpPort 8082 -SkipUdp
```

The helper keeps the standalone TCP rule behavior and also opens `8889/TCP` for MediaMTX plus `8189/UDP` for WebRTC.

### 3. Start the control gateway

Run inside `pc_host`:

```bash
python stream_gateway.py --host 0.0.0.0 --port 8082
```

### 4. Start MediaMTX

Run inside `pc_host`:

```powershell
.\scripts\start_media_stack.ps1
```

### 5. Start the Windows publisher

Run inside `pc_host`:

```powershell
.\scripts\start_stream_publisher.ps1
```

### 6. Host the frontend and connect

Host `pc_host\web` with any static HTTP server, then connect the page to `LAN_IP:8082`.

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

Run inside `pc_host` from an elevated PowerShell session:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\fix_network_access.ps1 -HttpPort 8081 -SkipUdp
```

If you also need the legacy UDP path:

```powershell
.\scripts\fix_network_access.ps1 -HttpPort 8081 -UdpPort 28777
```

### 5. Host the standalone frontend

Frontend files are in `pc_host\web`. You can host them with any static HTTP server. Quick example:

```bash
cd web
python -m http.server 8090
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

3. If the phone or another PC cannot reach `8081/TCP`, run the firewall helper in an elevated PowerShell window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\fix_network_access.ps1 -HttpPort 8081 -SkipUdp
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

Run inside `pc_host` from an elevated PowerShell session:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\fix_network_access.ps1 -HttpPort 8081 -SkipUdp
```

If you also need the legacy UDP bridge:

```powershell
.\scripts\fix_network_access.ps1 -HttpPort 8081 -UdpPort 28777
```

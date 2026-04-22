# 局域网串流 Web Controller

这个目录是 Windows 主机端。它会启动控制网关、MediaMTX、FFmpeg 推流器和手机访问的静态网页服务器，让同一局域网内的手机通过浏览器看画面并发送手柄输入。

## 环境安装

需要先准备：

- Windows 10/11
- PowerShell 7
- Python 3.12 或更高版本
- `ViGEmBus / Nefarius Virtual Gamepad Emulation Bus`
- `mediamtx.exe`
- `ffmpeg.exe`
- 一个 FFmpeg 可识别的 `DirectShow` 音频采集设备，例如 `virtual-audio-capturer`

在 `pc_host` 目录安装 Python 依赖：

```powershell
python -m pip install -r requirements.txt
```

推荐用 `winget` 安装 MediaMTX 和 FFmpeg：

```powershell
winget install --id bluenviron.mediamtx --exact
winget install --id Gyan.FFmpeg.Essentials --exact
```

## 一键启动

首次启动建议用管理员权限打开 PowerShell 7，因为脚本需要检查并修复防火墙。

在 `pc_host` 目录执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\start_lan_streaming_web_controller.ps1
```

这个脚本会检查运行环境、安装 Python 依赖、检查防火墙、启动控制网关、启动 MediaMTX、启动 FFmpeg 推流器，并启动静态网页服务器。

启动成功后，你会看到 4 个长期运行的服务窗口：

- `stream_gateway.py`，监听 `8082/TCP`
- `MediaMTX`，提供 `8889/TCP` 的 WHEP / WebRTC 媒体入口
- `FFmpeg` 推流器，把桌面画面推到本机 `rtsp://127.0.0.1:8554/game`
- `python -m http.server`，监听 `8090/TCP` 托管手机访问页面

重复执行一键启动脚本时，它会先停止自己这套栈上一次留下的旧进程，再重新启动；如果你不想自动重启旧进程，可以加 `-NoRestartExisting`。

如果只想预览启动流程，不真正启动服务：

```powershell
pwsh .\scripts\start_lan_streaming_web_controller.ps1 -DryRun -SkipDependencyInstall
```

## 手机访问

启动完成后，终端会打印局域网地址。假设主机 IP 是 `192.168.0.119`：

- 手机打开：`http://192.168.0.119:8090`
- 页面抽屉里的主机地址填写：`192.168.0.119:8082`
- 页面内部媒体代理地址：`http://192.168.0.119:8082/media/whep`
- MediaMTX 直接 WHEP 地址：`http://192.168.0.119:8889/game/whep`

正常使用只需要打开静态页面并填写 `192.168.0.119:8082`。不要填写 `127.0.0.1`，手机无法访问电脑自己的本机地址。

## 端口说明

需要对局域网开放：

| 端口 | 协议 | 作用 |
| --- | --- | --- |
| `8090` | `TCP` | 手机访问静态网页服务器 |
| `8082` | `TCP` | 控制网关，处理房间、WebRTC 控制协商和媒体代理 |
| `8889` | `TCP` | MediaMTX WebRTC / WHEP HTTP 入口，恢复 16:46 版本的开放方式 |
| `8189` | `UDP` | MediaMTX WebRTC 媒体传输 |

仅本机使用，不需要额外对外说明：

| 端口 | 协议 | 作用 |
| --- | --- | --- |
| `8554` | `TCP` | FFmpeg 推流到 MediaMTX 的 `RTSP/TCP` 入口 |
| `9997` | `TCP` | MediaMTX API |
| `28777` | `UDP` | 旧版 legacy UDP 输入通道，当前一键启动不使用 |

本机内部链路会用到 `8554/TCP`、`9997/TCP` 和 `28777/UDP`，但手机访问不需要直接连接这些端口。

当前脚本不会额外开放一大段动态 UDP 端口，也不会添加程序级 UDP 特殊规则。控制通道仍由页面和 Python 网关通过 WebRTC DataChannel 协商，端口开放方式回到 2026-04-22 16:46 的模型。

## 手动启动兜底

如果你暂时不想用一键启动，或者需要单独排查某一段链路，可以在 `pc_host` 目录手动开 4 个终端：

```powershell
python .\stream_gateway.py --host 0.0.0.0 --port 8082
```

```powershell
pwsh .\scripts\start_media_stack.ps1
```

```powershell
pwsh .\scripts\start_stream_publisher.ps1
```

```powershell
cd .\web
python -m http.server 8090 --bind 0.0.0.0
```

## 手动修复防火墙

如果一键启动提示防火墙规则缺失，请用管理员 PowerShell 7 在 `pc_host` 目录执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8082 -SkipUdp
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8090 -SkipUdp
```

这会放行 `8082/TCP`、`8090/TCP`、`8889/TCP` 和 `8189/UDP`。

# 局域网串流 Web Controller

这个目录是 Windows 主机端，用来把手柄控制、屏幕串流和手机端静态网页组合成一个可在同一局域网访问的 Web Controller。

## 环境安装

### 系统要求

- Windows 10/11
- PowerShell 7
- Python 3.12 或更高版本
- `ViGEmBus / Nefarius Virtual Gamepad Emulation Bus`
- 手机和 PC 在同一局域网

### 安装 Python 依赖

在 `pc_host` 目录执行：

```bash
pip install -r requirements.txt
```

### 安装本机运行时

必须具备以下本机依赖：

- `mediamtx.exe`
- `ffmpeg.exe`
- 可被 FFmpeg 识别的 Windows `DirectShow` 音频采集设备，例如 `virtual-audio-capturer`

推荐直接用 `winget` 安装：

```powershell
winget install --id bluenviron.mediamtx --exact
winget install --id Gyan.FFmpeg.Essentials --exact
```

当前串流链路默认是：

- FFmpeg 把画面推到 `rtsp://127.0.0.1:8554/game`
- MediaMTX 在本机处理 WebRTC / WHEP
- 外部手机统一通过网关地址访问，不直接连本机内部端口

其中 `rtsp://127.0.0.1:8554/game` 走的是 `RTSP/TCP` 本机内部推流链路。

## 一键启动

首次启动建议用`管理员`权限打开 `PowerShell 7`，这样脚本可以自动检查并修复防火墙。

在 `pc_host` 目录执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\start_lan_streaming_web_controller.ps1
```

这个脚本会自动完成：

- 检查 `Python 3.12`、`ViGEmBus`、`mediamtx.exe`、`ffmpeg.exe`
- 安装 `requirements.txt`
- 检查并修复局域网需要的防火墙规则
- 启动控制网关
- 启动 MediaMTX
- 启动 FFmpeg 发布器
- 启动静态网页服务器

如果你只想预览启动流程，不真正拉起服务，可以执行：

```powershell
pwsh .\scripts\start_lan_streaming_web_controller.ps1 -DryRun -SkipDependencyInstall
```

## 手机访问

启动完成后，终端会打印局域网地址。假设主机 IP 是 `192.168.0.119`，手机侧使用这 3 个地址：

- 前端页面：`http://192.168.0.119:8090`
- 抽屉里的主机地址：`192.168.0.119:8082`
- 媒体地址：`http://192.168.0.119:8082/media/whep`

访问步骤：

1. 手机打开 `http://192.168.0.119:8090`
2. 打开右侧抽屉
3. 输入 `192.168.0.119:8082`
4. 点击 `Connect`
5. 页面会通过 `WHEP` 从 `http://192.168.0.119:8082/media/whep` 拉取音视频

如果手机打不开页面或连不上主机，优先检查：

- 手机和 PC 是否在同一局域网
- 是否使用了主机真实 IPv4，而不是 `127.0.0.1`
- 首次启动时是否以管理员权限运行过脚本，让它完成防火墙配置

## 端口说明

### 需要对局域网开放

| 端口 | 协议 | 作用 |
| --- | --- | --- |
| `8090` | `TCP` | 手机访问静态网页服务器 |
| `8082` | `TCP` | 控制网关，也是外部统一访问入口 |
| `8189` | `UDP` | WebRTC 实际媒体传输 |

另外，一键启动脚本还会添加一条 `Python 程序级 UDP` 防火墙规则，用于浏览器到 Python 控制网关的 `WebRTC DataChannel`。这是因为 aiortc 的控制 WebRTC 会使用随机本地 UDP 端口；这不是固定端口暴露，而是限制为 Python 程序、UDP、Private 网络和 LocalSubnet 的入站规则，用来避免控制通道退回 `RTC+HTTP`。

### 仅本机使用

以下端口只在主机内部链路使用，`仅本机使用`，不需要对局域网开放：

| 端口 | 协议 | 作用 |
| --- | --- | --- |
| `8889` | `TCP` | MediaMTX 本机 WebRTC / WHEP 入口，上层由网关代理 |
| `8554` | `TCP` | FFmpeg 推流到 MediaMTX 的 `RTSP/TCP` 入口 |
| `9997` | `TCP` | MediaMTX API |
| `28777` | `UDP` | 旧版 legacy UDP 通道；当前一键启动不使用 |

对应的防火墙含义如下：

- 需要放行：`8090/TCP`、`8082/TCP`、`8189/UDP`
- 需要允许：Python 程序的局域网 UDP 入站，用于 `WebRTC DataChannel`
- 不需要放行：`8889/TCP`、`8554/TCP`、`9997/TCP`、`28777/UDP`

如果只想手动修复防火墙，也可以在管理员 PowerShell 7 中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pwsh .\scripts\fix_network_access.ps1 -HttpPort 8082 -FrontendPort 8090 -WebRtcControlProgram (Get-Command python).Source -EnableWebRtcMedia -SkipUdp
```

这条命令会按当前策略处理 `防火墙`：

- 放行 `8090/TCP`
- 放行 `8082/TCP`
- 放行 `8189/UDP`
- 添加 Python 程序级 UDP 规则，让控制通道继续走 `WebRTC DataChannel`
- 清理旧的 `8889/TCP` 外部规则
- 清理旧的 `28777/UDP` 外部规则

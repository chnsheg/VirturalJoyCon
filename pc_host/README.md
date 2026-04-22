# lan-streaming-web-controller 使用说明

## 1. 安装环境

电脑需要准备：

- Windows 10/11
- Python 3.12 或更新版本
- ViGEmBus / Nefarius Virtual Gamepad Emulation Bus 驱动
- 手机和电脑连接到同一个局域网

在 `pc_host` 目录安装依赖：

```powershell
cd pc_host
pip install -r requirements.txt
```

## 2. 启动项目

先启动手柄主机：

```powershell
cd pc_host
python web_host.py --host 0.0.0.0 --http-port 8081 --udp-port 28777 --timeout 8 --max-devices 4
```

如果手机连不上 `8081`，用管理员 PowerShell 执行：

```powershell
cd pc_host
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\fix_network_access.ps1 -HttpPort 8081 -SkipUdp
```

再启动手机页面：

```powershell
cd pc_host\web
python -m http.server 8090 --bind 0.0.0.0
```

如果手机打不开 `8090` 页面，手动放行 Windows 防火墙的 TCP `8090` 入站访问。

## 3. 手机访问

1. 在 `web_host.py` 终端输出里找到 `Standalone controller target: <LAN_IP>:8081`。
2. 手机浏览器打开 `http://<LAN_IP>:8090`。
3. 打开页面右侧抽屉，在 `Host` 里输入 `<LAN_IP>:8081`，然后点 `Connect`。

`Host` 只接受 IPv4 和端口，例如 `192.168.0.119:8081`。如果终端提示 `choose one LAN API URL above`，就在上方 `Candidate LAN API URLs` 里选一个同网段的 IPv4；如果没有自动识别出局域网地址，就手动填写这台电脑可访问的 IPv4 和 `8081` 端口。

# LAN Wireless Virtual Gamepad Host (MVP)

这是基于 `vgamepad` 的 PC Host 核心实现，目标是：
- 不使用全局键盘映射
- 每个手机客户端绑定独立虚拟手柄实例
- 支持独立多人同时控制（最多 4 人）

## 为什么手机端优先做 Web（而非原生 App）

为了快速实现与快速迭代，建议手机端先用前端网页（PWA/浏览器页面）：
- UI 改版和按键布局迭代速度明显更快
- 局域网内直接访问 Host 的网页或配置页，减少发版成本
- 输入协议（UDP JSON）先稳定，再决定是否原生化

## 运行方式

1. 安装依赖：

```bash
pip install -r requirements.txt
```

2. 启动 Web Host（推荐，手机浏览器可直接控制）：

```bash
python web_host.py --host 0.0.0.0 --http-port 8080 --udp-port 28777 --timeout 8 --max-devices 4
```

3. 手机与 PC 连接同一局域网，手机浏览器打开：

```text
http://<PC局域网IP>:8080
```

4. 可选：仅启动 UDP 服务（无网页）：

```bash
python gamepad_session_manager.py --host 0.0.0.0 --port 28777 --timeout 8 --max-devices 4
```

## 手机无法访问时（高概率是 Windows 防火墙/网络类别）

如果本机可访问 `http://127.0.0.1:8080`，但手机打不开，通常是：
- 当前 Wi-Fi 网卡是 Public 网络类别
- 入站规则未放行 8080/TCP

请用“管理员 PowerShell”执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
d:\JoyCon\pc_host\scripts\fix_network_access.ps1
```

然后手机访问：

```text
http://<WLAN的私网IP>:8080
```

## `image_1` 布局映射方案

- 顶部：
  - 左摇杆 -> `left_joystick`
  - D-Pad -> `XUSB_GAMEPAD_DPAD_UP/DOWN/LEFT/RIGHT`
  - A/B/X/Y -> `XUSB_GAMEPAD_A/B/X/Y`
  - 右摇杆 -> `right_joystick`
- 底部：
  - LB -> `XUSB_GAMEPAD_LEFT_SHOULDER`
  - SELECT -> `XUSB_GAMEPAD_BACK`
  - START -> `XUSB_GAMEPAD_START`
  - RB -> `XUSB_GAMEPAD_RIGHT_SHOULDER`
- 中间两个额外圆形键（可改）：
  - `extra_left` -> `XUSB_GAMEPAD_GUIDE`（Home）
  - `extra_right` -> `XUSB_GAMEPAD_RIGHT_THUMB`（Fn/可自定义）

## UDP 输入包（建议）

```json
{
  "device_id": "phone-A-uuid",
  "buttons": {
    "a": false,
    "b": false,
    "x": false,
    "y": false,
    "lb": false,
    "rb": false,
    "select": false,
    "start": false,
    "dpad_up": false,
    "dpad_down": false,
    "dpad_left": false,
    "dpad_right": false,
    "extra_left": false,
    "extra_right": false
  },
  "sticks": {
    "left": {
      "nx": 0.0,
      "ny": 0.0
    },
    "right": {
      "x": 462,
      "y": 812,
      "cx": 430,
      "cy": 840,
      "radius": 80
    }
  }
}
```

## 摇杆归一化（像素 -> XInput 16-bit）

以某摇杆为例：

- 计算位移：
  - `dx = touch_x - center_x`
  - `dy_screen = touch_y - center_y`
  - `dy = -dy_screen`（屏幕 Y 轴向下，XInput Y 轴向上）
- 半径裁剪：
  - 若 `sqrt(dx^2 + dy^2) > radius`，则按比例缩回圆周
- 归一化：
  - `nx = dx / radius`
  - `ny = dy / radius`
- 径向死区：
  - 若 `mag <= deadzone` 输出 0
  - 否则 `scaled = (mag - deadzone)/(1 - deadzone)`，并按方向缩放
- 量化到 16-bit：
  - `axis = round(n * 32767)`，并 clamp 到 `[-32768, 32767]`

## 会话绑定与隔离

- 使用 `SHA1(ip:port:device_id)` 作为 session key
- 每个 session 分配独立 `VX360Gamepad` 实例
- 状态更新只写入该 session 绑定实例
- 心跳超时后自动 `reset + update + release` 回收

import argparse
import asyncio
import dataclasses
import hashlib
import json
import math
import time
from typing import Dict, Optional, Tuple

import vgamepad as vg


XINPUT_MIN = -32768
XINPUT_MAX = 32767


BUTTON_MAP = {
    "a": vg.XUSB_BUTTON.XUSB_GAMEPAD_A,
    "b": vg.XUSB_BUTTON.XUSB_GAMEPAD_B,
    "x": vg.XUSB_BUTTON.XUSB_GAMEPAD_X,
    "y": vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,
    "lb": vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
    "rb": vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
    "select": vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
    "start": vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
    "dpad_up": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
    "dpad_down": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
    "dpad_left": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
    "dpad_right": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
    # image_1 中间两个额外圆形键：
    # extra_left -> GUIDE(Home), extra_right -> RIGHT_THUMB(Fn/自定义功能)
    "extra_left": vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,
    "extra_right": vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
}


@dataclasses.dataclass
class Session:
    session_key: str
    endpoint: Tuple[str, int]
    user_index: int
    gamepad: vg.VX360Gamepad
    last_seen: float


class VirtualDevicePool:
    def __init__(self, max_devices: int = 4):
        if max_devices < 1 or max_devices > 4:
            raise ValueError("max_devices 必须在 1..4 之间")
        self.max_devices = max_devices
        self._sessions: Dict[str, Session] = {}
        self._index_owners: Dict[int, str] = {}

    @property
    def sessions(self) -> Dict[str, Session]:
        return self._sessions

    def _next_free_index(self) -> Optional[int]:
        for idx in range(self.max_devices):
            if idx not in self._index_owners:
                return idx
        return None

    def get_or_create(self, session_key: str, endpoint: Tuple[str, int]) -> Optional[Session]:
        existing = self._sessions.get(session_key)
        if existing:
            existing.last_seen = time.time()
            return existing

        free_index = self._next_free_index()
        if free_index is None:
            return None

        gamepad = vg.VX360Gamepad()
        session = Session(
            session_key=session_key,
            endpoint=endpoint,
            user_index=free_index,
            gamepad=gamepad,
            last_seen=time.time(),
        )
        self._sessions[session_key] = session
        self._index_owners[free_index] = session_key
        return session

    def release(self, session_key: str) -> None:
        session = self._sessions.pop(session_key, None)
        if not session:
            return

        self._index_owners.pop(session.user_index, None)

        # 复位并触发一次 update，确保断连时不会残留按键状态
        session.gamepad.reset()
        session.gamepad.update()

        # 删除实例触发 ViGEm 设备回收（vgamepad 生命周期）
        del session.gamepad


class GamepadMapper:
    def __init__(self, deadzone: float = 0.12):
        if not (0.0 <= deadzone < 1.0):
            raise ValueError("deadzone 必须在 [0,1) 范围")
        self.deadzone = deadzone

    @staticmethod
    def _clamp(value: float, vmin: float, vmax: float) -> float:
        return max(vmin, min(vmax, value))

    @staticmethod
    def _to_xinput_axis(value: float) -> int:
        # value: [-1.0, 1.0]
        value = max(-1.0, min(1.0, value))
        mapped = int(round(value * XINPUT_MAX))
        return max(XINPUT_MIN, min(XINPUT_MAX, mapped))

    def _apply_radial_deadzone(self, nx: float, ny: float) -> Tuple[float, float]:
        mag = math.hypot(nx, ny)
        if mag <= self.deadzone:
            return 0.0, 0.0
        if mag > 1.0:
            nx, ny = nx / mag, ny / mag
            mag = 1.0

        scaled_mag = (mag - self.deadzone) / (1.0 - self.deadzone)
        scale = scaled_mag / mag if mag > 0 else 0.0
        return nx * scale, ny * scale

    def normalize_stick_from_pixels(
        self,
        touch_x: float,
        touch_y: float,
        center_x: float,
        center_y: float,
        radius: float,
    ) -> Tuple[int, int]:
        if radius <= 0:
            return 0, 0

        dx = touch_x - center_x
        dy_screen = touch_y - center_y

        # 屏幕坐标 y 向下为正，XInput 需要 y 向上为正
        dy = -dy_screen

        dist = math.hypot(dx, dy)
        if dist > radius:
            scale = radius / dist
            dx *= scale
            dy *= scale

        nx = self._clamp(dx / radius, -1.0, 1.0)
        ny = self._clamp(dy / radius, -1.0, 1.0)

        nx, ny = self._apply_radial_deadzone(nx, ny)

        return self._to_xinput_axis(nx), self._to_xinput_axis(ny)

    def normalize_stick_from_normalized(self, nx: float, ny: float) -> Tuple[int, int]:
        nx = self._clamp(nx, -1.0, 1.0)
        ny = self._clamp(ny, -1.0, 1.0)
        nx, ny = self._apply_radial_deadzone(nx, ny)
        return self._to_xinput_axis(nx), self._to_xinput_axis(ny)

    def _parse_stick(self, stick_obj: dict) -> Tuple[int, int]:
        if not stick_obj:
            return 0, 0

        # 方案 A：前端直接给归一化值 nx/ny（推荐，带宽最小）
        if "nx" in stick_obj and "ny" in stick_obj:
            return self.normalize_stick_from_normalized(
                float(stick_obj.get("nx", 0.0)),
                float(stick_obj.get("ny", 0.0)),
            )

        # 方案 B：前端给像素触点 + 摇杆底座中心 + 半径
        touch = stick_obj.get("touch") or {}
        center = stick_obj.get("center") or {}

        touch_x = float(stick_obj.get("x", touch.get("x", 0.0)))
        touch_y = float(stick_obj.get("y", touch.get("y", 0.0)))
        center_x = float(stick_obj.get("cx", center.get("x", 0.0)))
        center_y = float(stick_obj.get("cy", center.get("y", 0.0)))
        radius = float(stick_obj.get("radius", 0.0))

        return self.normalize_stick_from_pixels(
            touch_x=touch_x,
            touch_y=touch_y,
            center_x=center_x,
            center_y=center_y,
            radius=radius,
        )

    def apply_packet(self, gamepad: vg.VX360Gamepad, packet: dict) -> None:
        buttons = packet.get("buttons", {})

        for key, xbtn in BUTTON_MAP.items():
            pressed = bool(buttons.get(key, False))
            if pressed:
                gamepad.press_button(button=xbtn)
            else:
                gamepad.release_button(button=xbtn)

        sticks = packet.get("sticks", {})
        lx, ly = self._parse_stick(sticks.get("left", {}))
        rx, ry = self._parse_stick(sticks.get("right", {}))

        gamepad.left_joystick(x_value=lx, y_value=ly)
        gamepad.right_joystick(x_value=rx, y_value=ry)

        gamepad.update()


class GamepadSessionManagerProtocol(asyncio.DatagramProtocol):
    def __init__(self, pool: VirtualDevicePool, mapper: GamepadMapper):
        self.pool = pool
        self.mapper = mapper

    @staticmethod
    def make_session_key(addr: Tuple[str, int], packet: dict) -> str:
        # 默认身份绑定：IP:Port
        # 若客户端提供 device_id，可叠加形成更稳健唯一键
        raw = f"{addr[0]}:{addr[1]}:{packet.get('device_id', '')}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def datagram_received(self, data: bytes, addr: Tuple[str, int]) -> None:
        try:
            packet = json.loads(data.decode("utf-8"))
        except Exception:
            return

        session_key = self.make_session_key(addr, packet)
        session = self.pool.get_or_create(session_key=session_key, endpoint=addr)
        if session is None:
            # 设备池满，丢弃该客户端输入
            return

        session.last_seen = time.time()

        try:
            self.mapper.apply_packet(session.gamepad, packet)
        except Exception:
            # 输入异常时不影响主循环
            return


async def cleanup_loop(pool: VirtualDevicePool, timeout_sec: float, tick_sec: float = 1.0) -> None:
    while True:
        await asyncio.sleep(tick_sec)
        now = time.time()
        expired_keys = [
            key
            for key, session in pool.sessions.items()
            if (now - session.last_seen) > timeout_sec
        ]
        for key in expired_keys:
            pool.release(key)


async def run_server(host: str, port: int, timeout_sec: float, deadzone: float, max_devices: int) -> None:
    loop = asyncio.get_running_loop()
    pool = VirtualDevicePool(max_devices=max_devices)
    mapper = GamepadMapper(deadzone=deadzone)

    transport, _ = await loop.create_datagram_endpoint(
        lambda: GamepadSessionManagerProtocol(pool=pool, mapper=mapper),
        local_addr=(host, port),
    )

    cleanup_task = asyncio.create_task(cleanup_loop(pool=pool, timeout_sec=timeout_sec))

    print(f"[GamepadHost] UDP listening on {host}:{port}, max_devices={max_devices}, timeout={timeout_sec}s")
    try:
        await asyncio.Future()
    finally:
        cleanup_task.cancel()
        for key in list(pool.sessions.keys()):
            pool.release(key)
        transport.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LAN Wireless Virtual Gamepad Session Manager (vgamepad)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=28777)
    parser.add_argument("--timeout", type=float, default=8.0, help="Session heartbeat timeout in seconds")
    parser.add_argument("--deadzone", type=float, default=0.12, help="Radial deadzone in [0,1)")
    parser.add_argument("--max-devices", type=int, default=4, help="Virtual gamepad pool size, up to 4")
    args = parser.parse_args()

    asyncio.run(
        run_server(
            host=args.host,
            port=args.port,
            timeout_sec=args.timeout,
            deadzone=args.deadzone,
            max_devices=args.max_devices,
        )
    )

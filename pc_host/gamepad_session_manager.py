import argparse
import asyncio
import dataclasses
import hashlib
import json
import math
import time
from typing import Callable, Dict, Optional, Tuple

from xbox_protocol import XUSB_BUTTON, Xbox360Controller


XINPUT_MIN = -32768
XINPUT_MAX = 32767
TRIGGER_MAX = 255


BUTTON_MAP = {
    "a": int(XUSB_BUTTON.XUSB_GAMEPAD_A),
    "b": int(XUSB_BUTTON.XUSB_GAMEPAD_B),
    "x": int(XUSB_BUTTON.XUSB_GAMEPAD_X),
    "y": int(XUSB_BUTTON.XUSB_GAMEPAD_Y),
    "lb": int(XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER),
    "rb": int(XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER),
    "select": int(XUSB_BUTTON.XUSB_GAMEPAD_BACK),
    "start": int(XUSB_BUTTON.XUSB_GAMEPAD_START),
    "dpad_up": int(XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP),
    "dpad_down": int(XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN),
    "dpad_left": int(XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT),
    "dpad_right": int(XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT),
    "ls": int(XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB),
    "rs": int(XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB),
    "extra_left": int(XUSB_BUTTON.XUSB_GAMEPAD_GUIDE),
    "extra_right": int(XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB),
}


@dataclasses.dataclass
class Session:
    session_key: str
    endpoint: Tuple[str, int]
    user_index: int
    gamepad: object
    last_seen: float
    input_stream_id: str = ""
    last_packet_seq: int = -1
    pool_slot: int = -1

    def accepts_packet(self, packet: dict) -> bool:
        stream_id = str(packet.get("input_stream_id", "")).strip()
        seq = packet.get("seq")

        if not stream_id or not isinstance(seq, int):
            return True

        if stream_id != self.input_stream_id:
            self.input_stream_id = stream_id
            self.last_packet_seq = -1

        if seq <= self.last_packet_seq:
            return False

        self.last_packet_seq = seq
        return True


class VirtualDevicePool:
    def __init__(self, max_devices: int = 4, controller_factory: Optional[Callable[[], object]] = None):
        if max_devices < 1 or max_devices > 4:
            raise ValueError("max_devices must be in 1..4")
        self.max_devices = max_devices
        self.controller_factory = controller_factory or Xbox360Controller
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

        gamepad = self.controller_factory()
        reported_user_index = getattr(gamepad, "get_user_index", lambda: free_index)()

        session = Session(
            session_key=session_key,
            endpoint=endpoint,
            user_index=free_index if reported_user_index is None else int(reported_user_index),
            gamepad=gamepad,
            last_seen=time.time(),
            pool_slot=free_index,
        )
        self._sessions[session_key] = session
        self._index_owners[free_index] = session_key
        return session

    def release(self, session_key: str) -> None:
        session = self._sessions.pop(session_key, None)
        if not session:
            return

        self._index_owners.pop(session.pool_slot if session.pool_slot >= 0 else session.user_index, None)

        reset = getattr(session.gamepad, "reset", None)
        if callable(reset):
            reset()

        update = getattr(session.gamepad, "update", None)
        if callable(update):
            update()

        close = getattr(session.gamepad, "close", None)
        if callable(close):
            close()

        del session.gamepad


class GamepadMapper:
    def __init__(self, deadzone: float = 0.12):
        if not (0.0 <= deadzone < 1.0):
            raise ValueError("deadzone must be in [0,1)")
        self.deadzone = deadzone

    @staticmethod
    def _clamp(value: float, vmin: float, vmax: float) -> float:
        return max(vmin, min(vmax, value))

    @staticmethod
    def _to_xinput_axis(value: float) -> int:
        value = max(-1.0, min(1.0, value))
        mapped = int(round(value * XINPUT_MAX))
        return max(XINPUT_MIN, min(XINPUT_MAX, mapped))

    @staticmethod
    def _to_trigger_value(value: float) -> int:
        value = max(0.0, min(1.0, value))
        mapped = int(round(value * TRIGGER_MAX))
        return max(0, min(TRIGGER_MAX, mapped))

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
        dy = -(touch_y - center_y)

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

    def map_processed_stick(self, nx: float, ny: float) -> Tuple[int, int]:
        nx = self._clamp(nx, -1.0, 1.0)
        ny = self._clamp(ny, -1.0, 1.0)
        return self._to_xinput_axis(nx), self._to_xinput_axis(ny)

    def _parse_stick(self, stick_obj: dict) -> Tuple[int, int]:
        if not stick_obj:
            return 0, 0

        if "nx" in stick_obj and "ny" in stick_obj:
            if bool(stick_obj.get("processed", False)):
                return self.map_processed_stick(
                    float(stick_obj.get("nx", 0.0)),
                    float(stick_obj.get("ny", 0.0)),
                )
            return self.normalize_stick_from_normalized(
                float(stick_obj.get("nx", 0.0)),
                float(stick_obj.get("ny", 0.0)),
            )

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

    def apply_packet(self, gamepad: object, packet: dict) -> None:
        buttons = packet.get("buttons", {}) or {}
        for key, xbtn in BUTTON_MAP.items():
            if bool(buttons.get(key, False)):
                gamepad.press_button(button=xbtn)
            else:
                gamepad.release_button(button=xbtn)

        sticks = packet.get("sticks", {}) or {}
        lx, ly = self._parse_stick(sticks.get("left", {}))
        rx, ry = self._parse_stick(sticks.get("right", {}))
        triggers = packet.get("triggers", {}) or {}
        lt = self._to_trigger_value(float(triggers.get("lt", 0.0)))
        rt = self._to_trigger_value(float(triggers.get("rt", 0.0)))

        gamepad.left_joystick(x_value=lx, y_value=ly)
        gamepad.right_joystick(x_value=rx, y_value=ry)
        gamepad.left_trigger(value=lt)
        gamepad.right_trigger(value=rt)
        gamepad.update()


class GamepadSessionManagerProtocol(asyncio.DatagramProtocol):
    def __init__(self, pool: VirtualDevicePool, mapper: GamepadMapper):
        self.pool = pool
        self.mapper = mapper

    @staticmethod
    def make_session_key(addr: Tuple[str, int], packet: dict) -> str:
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
            return

        session.last_seen = time.time()
        if not session.accepts_packet(packet):
            return

        try:
            self.mapper.apply_packet(session.gamepad, packet)
        except Exception:
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
    parser = argparse.ArgumentParser(description="LAN Wireless Virtual Gamepad Session Manager (ViGEm/XUSB)")
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

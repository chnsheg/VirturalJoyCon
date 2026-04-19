import argparse
import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Dict, Set, Tuple

from aiohttp import WSMsgType, web

from gamepad_session_manager import (
    GamepadMapper,
    GamepadSessionManagerProtocol,
    VirtualDevicePool,
    cleanup_loop,
)


class WebGamepadHub:
    def __init__(self, pool: VirtualDevicePool, mapper: GamepadMapper):
        self.pool = pool
        self.mapper = mapper
        self.ws_to_session_keys: Dict[int, Set[str]] = {}
        self.ws_primary_session_key: Dict[int, str] = {}
        self.last_log_at: Dict[str, float] = {}

    @staticmethod
    def _summarize_packet(packet: dict) -> str:
        buttons = packet.get("buttons", {}) or {}
        sticks = packet.get("sticks", {}) or {}
        pressed = sorted([key for key, value in buttons.items() if bool(value)])
        left = sticks.get("left", {}) or {}
        right = sticks.get("right", {}) or {}
        lnx = float(left.get("nx", 0.0)) if isinstance(left, dict) else 0.0
        lny = float(left.get("ny", 0.0)) if isinstance(left, dict) else 0.0
        rnx = float(right.get("nx", 0.0)) if isinstance(right, dict) else 0.0
        rny = float(right.get("ny", 0.0)) if isinstance(right, dict) else 0.0
        return f"pressed={pressed} left=({lnx:.2f},{lny:.2f}) right=({rnx:.2f},{rny:.2f})"

    def _log_packet(self, source: str, session_key: str, slot: int, peer: Tuple[str, int], packet: dict) -> None:
        now = time.time()
        if (now - self.last_log_at.get(session_key, 0.0)) < 0.4:
            return
        self.last_log_at[session_key] = now
        logging.info(
            "input source=%s slot=%s peer=%s session=%s %s",
            source,
            slot,
            peer,
            session_key[:10],
            self._summarize_packet(packet),
        )

    @staticmethod
    def _session_key(peer: Tuple[str, int], packet: dict) -> str:
        client_session_id = str(packet.get("client_session_id", "")).strip()
        device_id = str(packet.get("device_id", ""))
        if client_session_id:
            raw = f"web:{client_session_id}"
        elif device_id:
            raw = f"web:{peer[0]}:{device_id}"
        else:
            raw = f"web:{peer[0]}:{peer[1]}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    async def handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=15)
        await ws.prepare(request)

        transport = request.transport
        peername = transport.get_extra_info("peername") if transport else None
        if isinstance(peername, tuple) and len(peername) >= 2:
            peer = (str(peername[0]), int(peername[1]))
        else:
            peer = ("unknown", 0)

        ws_id = id(ws)
        self.ws_to_session_keys[ws_id] = set()

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        packet = json.loads(msg.data)
                    except Exception:
                        continue

                    session_key = self.ws_primary_session_key.get(ws_id)
                    if not session_key:
                        session_key = self._session_key(peer, packet)
                        self.ws_primary_session_key[ws_id] = session_key

                    session = self.pool.get_or_create(session_key=session_key, endpoint=peer)
                    if session is None:
                        await ws.send_json({"type": "error", "reason": "device_pool_full"})
                        continue

                    self.ws_to_session_keys[ws_id].add(session_key)
                    session.last_seen = time.time()

                    try:
                        self.mapper.apply_packet(session.gamepad, packet)
                    except Exception:
                        continue

                    self._log_packet("ws", session_key, session.user_index, peer, packet)

                    await ws.send_json({"type": "ack", "slot": session.user_index})

                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            keys = self.ws_to_session_keys.pop(ws_id, set())
            self.ws_primary_session_key.pop(ws_id, None)
            for key in keys:
                logging.info("release source=ws session=%s", key[:10])
                self.pool.release(key)

        return ws

    async def handle_http_input(self, request: web.Request) -> web.Response:
        try:
            packet = await request.json()
        except Exception:
            return web.json_response({"ok": False, "reason": "bad_json"}, status=400)

        transport = request.transport
        peername = transport.get_extra_info("peername") if transport else None
        if isinstance(peername, tuple) and len(peername) >= 2:
            peer = (str(peername[0]), int(peername[1]))
        else:
            peer = ("unknown", 0)

        session_key = self._session_key(peer, packet)
        session = self.pool.get_or_create(session_key=session_key, endpoint=peer)
        if session is None:
            return web.json_response({"ok": False, "reason": "device_pool_full"}, status=503)

        session.last_seen = time.time()

        try:
            self.mapper.apply_packet(session.gamepad, packet)
        except Exception:
            return web.json_response({"ok": False, "reason": "bad_packet"}, status=400)

        self._log_packet("http", session_key, session.user_index, peer, packet)

        return web.json_response({"ok": True, "slot": session.user_index})


async def start_udp_bridge(loop: asyncio.AbstractEventLoop, pool: VirtualDevicePool, mapper: GamepadMapper, host: str, port: int):
    return await loop.create_datagram_endpoint(
        lambda: GamepadSessionManagerProtocol(pool=pool, mapper=mapper),
        local_addr=(host, port),
    )


async def run_web_host(
    bind_host: str,
    http_port: int,
    udp_port: int,
    timeout_sec: float,
    deadzone: float,
    max_devices: int,
) -> None:
    logs_dir = Path(__file__).parent / "logs"
    logs_dir.mkdir(exist_ok=True)
    log_path = logs_dir / "web_host.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )

    pool = VirtualDevicePool(max_devices=max_devices)
    mapper = GamepadMapper(deadzone=deadzone)
    hub = WebGamepadHub(pool=pool, mapper=mapper)

    @web.middleware
    async def no_cache_middleware(request: web.Request, handler):
        response = await handler(request)
        if request.path == "/" or request.path.endswith(".html") or request.path.endswith(".js"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    app = web.Application(middlewares=[no_cache_middleware])
    static_dir = Path(__file__).parent / "web"
    app.add_routes(
        [
            web.get("/ws", hub.handle_ws),
            web.post("/input", hub.handle_http_input),
            web.static("/", str(static_dir), show_index=True),
        ]
    )

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, bind_host, http_port)
    await site.start()

    loop = asyncio.get_running_loop()
    udp_transport, _ = await start_udp_bridge(loop, pool, mapper, bind_host, udp_port)
    cleanup_task = asyncio.create_task(cleanup_loop(pool=pool, timeout_sec=timeout_sec))

    print(f"[GamepadHost] Web UI: http://{bind_host}:{http_port}")
    print(f"[GamepadHost] WS endpoint: ws://{bind_host}:{http_port}/ws")
    print(f"[GamepadHost] UDP bridge: {bind_host}:{udp_port}")
    print(f"[GamepadHost] max_devices={max_devices}, timeout={timeout_sec}s")
    print(f"[GamepadHost] logs: {log_path}")
    logging.info("host_started http=%s udp=%s max_devices=%s timeout=%s", http_port, udp_port, max_devices, timeout_sec)

    try:
        await asyncio.Future()
    finally:
        cleanup_task.cancel()
        for key in list(pool.sessions.keys()):
            pool.release(key)
        udp_transport.close()
        await runner.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LAN Wireless Virtual Gamepad Web Host (vgamepad + WebSocket)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--http-port", type=int, default=8080)
    parser.add_argument("--udp-port", type=int, default=28777)
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--deadzone", type=float, default=0.12)
    parser.add_argument("--max-devices", type=int, default=4)
    args = parser.parse_args()

    asyncio.run(
        run_web_host(
            bind_host=args.host,
            http_port=args.http_port,
            udp_port=args.udp_port,
            timeout_sec=args.timeout,
            deadzone=args.deadzone,
            max_devices=args.max_devices,
        )
    )

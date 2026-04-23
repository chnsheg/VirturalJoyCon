import argparse
import asyncio
import ctypes
import hashlib
import json
import os
from contextlib import suppress
from collections.abc import Awaitable, Callable, Mapping
from ctypes import wintypes
from pathlib import Path

from aiohttp import ClientSession, web

from gamepad_session_manager import GamepadMapper, VirtualDevicePool, cleanup_loop
from streaming.control_peer import ControlPeerFactory
from streaming.runtime_profile import (
    DEFAULT_RUNTIME_CAPS,
    DEFAULT_SOURCE_CAPS,
    StreamProfile,
    build_stream_settings_payload,
    clamp_effective_profile,
)
from streaming.room_state import RoomRegistry
from streaming.sdp_rewrite import (
    _extract_host_only,
    describe_host_candidates,
    filter_or_rewrite_media_answer,
    rewrite_control_answer_host_candidates,
)
from web_host import WebGamepadHub, handle_input_options


CORS_ALLOW_METHODS = "GET, POST, OPTIONS"
CORS_ALLOW_HEADERS = "Content-Type"
CORS_MAX_AGE = "86400"
DEFAULT_WHEP_BACKEND_URL = "http://127.0.0.1:8889/game/whep"
DEFAULT_STREAM_SETTINGS = {
    "width": 1280,
    "height": 720,
    "fps": 60,
    "bitrateKbps": 6000,
}
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PUBLISHER_IDENTITY_UNSET = object()


if os.name == "nt":
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _FILETIME(ctypes.Structure):
        _fields_ = [
            ("dwLowDateTime", wintypes.DWORD),
            ("dwHighDateTime", wintypes.DWORD),
        ]

    _open_process = _kernel32.OpenProcess
    _open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _open_process.restype = wintypes.HANDLE

    _get_process_times = _kernel32.GetProcessTimes
    _get_process_times.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_FILETIME),
        ctypes.POINTER(_FILETIME),
        ctypes.POINTER(_FILETIME),
        ctypes.POINTER(_FILETIME),
    ]
    _get_process_times.restype = wintypes.BOOL

    _close_handle = _kernel32.CloseHandle
    _close_handle.argtypes = [wintypes.HANDLE]
    _close_handle.restype = wintypes.BOOL


def add_cors_headers(response: web.StreamResponse) -> web.StreamResponse:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = CORS_ALLOW_METHODS
    response.headers["Access-Control-Allow-Headers"] = CORS_ALLOW_HEADERS
    response.headers["Access-Control-Max-Age"] = CORS_MAX_AGE
    return response


def cors_json_response(payload: dict, status: int = 200) -> web.Response:
    return add_cors_headers(web.json_response(payload, status=status))


def _runtime_stream_settings_path() -> Path:
    return Path(__file__).resolve().parent / ".runtime" / "stream_settings.json"


def _runtime_active_stream_settings_path() -> Path:
    return Path(__file__).resolve().parent / ".runtime" / "stream_settings.active.json"


def _normalize_stream_settings_value(
    value: object,
    *,
    fallback: int,
    minimum: int,
    maximum: int,
) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        numeric = fallback
    return max(minimum, min(maximum, numeric))


def _normalize_even_dimension(
    value: object,
    *,
    fallback: int,
    minimum: int,
    maximum: int,
) -> int:
    numeric = _normalize_stream_settings_value(
        value,
        fallback=fallback,
        minimum=minimum,
        maximum=maximum,
    )
    return max(minimum, min(maximum, numeric - (numeric % 2)))


def _normalize_bitrate_kbps(
    value: object,
    *,
    fallback: int,
    minimum: int,
    maximum: int,
) -> int:
    numeric = _normalize_stream_settings_value(
        value,
        fallback=fallback,
        minimum=minimum,
        maximum=maximum,
    )
    quantized = ((numeric + 50) // 100) * 100
    return max(minimum, min(maximum, quantized))


def normalize_stream_settings(payload: Mapping[str, object] | None = None) -> dict[str, int]:
    source = payload or {}
    return {
        "width": _normalize_even_dimension(
            source.get("width"),
            fallback=DEFAULT_STREAM_SETTINGS["width"],
            minimum=640,
            maximum=3840,
        ),
        "height": _normalize_even_dimension(
            source.get("height"),
            fallback=DEFAULT_STREAM_SETTINGS["height"],
            minimum=360,
            maximum=2160,
        ),
        "fps": _normalize_stream_settings_value(
            source.get("fps"),
            fallback=DEFAULT_STREAM_SETTINGS["fps"],
            minimum=24,
            maximum=120,
        ),
        "bitrateKbps": _normalize_bitrate_kbps(
            source.get("bitrateKbps"),
            fallback=DEFAULT_STREAM_SETTINGS["bitrateKbps"],
            minimum=1500,
            maximum=50000,
        ),
    }


def _load_optional_json_mapping(settings_path: Path) -> dict[str, object] | None:
    try:
        payload = json.loads(settings_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError):
        return None

    if not isinstance(payload, Mapping):
        return None
    return dict(payload)


def load_optional_stream_settings(settings_path: Path) -> dict[str, int] | None:
    payload = _load_optional_json_mapping(settings_path)
    if payload is None:
        return None
    return normalize_stream_settings(payload)


def _read_required_strict_integer(payload: Mapping[str, object], field_name: str) -> int | None:
    if field_name not in payload:
        return None
    value = payload[field_name]
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def parse_active_stream_settings(payload: Mapping[str, object] | None) -> dict[str, object] | None:
    if payload is None:
        return None

    raw_settings: dict[str, int] = {}
    for field_name in ("width", "height", "fps", "bitrateKbps"):
        value = _read_required_strict_integer(payload, field_name)
        if value is None:
            return None
        raw_settings[field_name] = value

    if normalize_stream_settings(raw_settings) != raw_settings:
        return None
    if clamp_effective_profile(
        _stream_profile_from_settings(raw_settings),
        source_caps=DEFAULT_SOURCE_CAPS,
        runtime_caps=DEFAULT_RUNTIME_CAPS,
    ) != _stream_profile_from_settings(raw_settings):
        return None

    request_fingerprint = str(payload.get("requestFingerprint") or "").strip().upper()
    publisher_pid = _read_required_strict_integer(payload, "publisherPid")
    publisher_started_at = _read_required_strict_integer(
        payload,
        "publisherStartedAtFileTimeUtc",
    )
    if (
        not request_fingerprint
        or publisher_pid is None
        or publisher_pid <= 0
        or publisher_started_at is None
        or publisher_started_at <= 0
    ):
        return None

    return {
        **raw_settings,
        "requestFingerprint": request_fingerprint,
        "publisherPid": publisher_pid,
        "publisherStartedAtFileTimeUtc": publisher_started_at,
    }


def load_optional_active_stream_settings(settings_path: Path) -> dict[str, object] | None:
    return parse_active_stream_settings(_load_optional_json_mapping(settings_path))


def _filetime_to_int(filetime: object) -> int:
    return (int(filetime.dwHighDateTime) << 32) | int(filetime.dwLowDateTime)


def _get_process_filetimes(pid: int) -> tuple[int, int] | None:
    if pid <= 0 or os.name != "nt":
        return None

    process_handle = _open_process(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not process_handle:
        return None

    creation_time = _FILETIME()
    exit_time = _FILETIME()
    kernel_time = _FILETIME()
    user_time = _FILETIME()

    try:
        if not _get_process_times(
            process_handle,
            ctypes.byref(creation_time),
            ctypes.byref(exit_time),
            ctypes.byref(kernel_time),
            ctypes.byref(user_time),
        ):
            return None
        return _filetime_to_int(creation_time), _filetime_to_int(exit_time)
    finally:
        _close_handle(process_handle)


def get_process_identity(pid: int) -> tuple[int, int] | None:
    filetimes = _get_process_filetimes(pid)
    if filetimes is None:
        return None

    creation_time, exit_time = filetimes
    if exit_time != 0:
        return None
    return pid, creation_time


def active_publisher_identity(
    active_settings: Mapping[str, object] | None,
) -> tuple[int, int] | None:
    if active_settings is None:
        return None

    publisher_pid = active_settings.get("publisherPid")
    publisher_started_at = active_settings.get("publisherStartedAtFileTimeUtc")
    if not isinstance(publisher_pid, int) or not isinstance(publisher_started_at, int):
        return None

    identity = get_process_identity(publisher_pid)
    if identity != (publisher_pid, publisher_started_at):
        return None
    return identity


def is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


def load_stream_settings(settings_path: Path) -> dict[str, int]:
    settings, _ = load_requested_stream_settings_snapshot(settings_path)
    return settings


def save_stream_settings(settings_path: Path, payload: Mapping[str, object]) -> dict[str, int]:
    settings = normalize_stream_settings(payload)
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, ensure_ascii=True, indent=2), encoding="utf-8")
    return settings


def load_requested_stream_settings_snapshot(settings_path: Path) -> tuple[dict[str, int], str]:
    try:
        settings_bytes = settings_path.read_bytes()
    except FileNotFoundError:
        return dict(DEFAULT_STREAM_SETTINGS), ""
    except OSError:
        return dict(DEFAULT_STREAM_SETTINGS), ""

    try:
        payload = json.loads(settings_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return dict(DEFAULT_STREAM_SETTINGS), ""

    if not isinstance(payload, Mapping):
        return dict(DEFAULT_STREAM_SETTINGS), ""

    return (
        normalize_stream_settings(dict(payload)),
        hashlib.sha256(settings_bytes).hexdigest().upper(),
    )


def stream_settings_applied(
    settings_fingerprint: str,
    active_settings: Mapping[str, object] | None,
    *,
    publisher_identity: tuple[int, int] | None | object = PUBLISHER_IDENTITY_UNSET,
) -> bool:
    if active_settings is None or not settings_fingerprint:
        return False
    active_fingerprint = str(active_settings.get("requestFingerprint") or "").strip().upper()
    active_identity = (
        active_publisher_identity(active_settings)
        if publisher_identity is PUBLISHER_IDENTITY_UNSET
        else publisher_identity
    )
    return active_fingerprint == settings_fingerprint and active_identity is not None


def get_stream_settings_fingerprint(settings_path: Path) -> str:
    try:
        return hashlib.sha256(settings_path.read_bytes()).hexdigest().upper()
    except FileNotFoundError:
        return ""
    except OSError:
        return ""


def _stream_profile_from_settings(settings: Mapping[str, object]) -> StreamProfile:
    normalized = normalize_stream_settings(settings)
    return StreamProfile(
        width=normalized["width"],
        height=normalized["height"],
        fps=normalized["fps"],
        bitrate_kbps=normalized["bitrateKbps"],
    )


def _stream_settings_payload(
    settings: Mapping[str, object],
    settings_fingerprint: str,
    active_settings: Mapping[str, object] | None,
) -> dict[str, object]:
    requested = _stream_profile_from_settings(settings)
    active_identity = active_publisher_identity(active_settings)
    trusted_active_settings = active_settings if active_identity is not None else None
    effective = (
        clamp_effective_profile(
            _stream_profile_from_settings(trusted_active_settings),
            source_caps=DEFAULT_SOURCE_CAPS,
            runtime_caps=DEFAULT_RUNTIME_CAPS,
        )
        if trusted_active_settings is not None
        else clamp_effective_profile(
            requested,
            source_caps=DEFAULT_SOURCE_CAPS,
            runtime_caps=DEFAULT_RUNTIME_CAPS,
        )
    )
    return build_stream_settings_payload(
        requested=requested,
        effective=effective,
        source_caps=DEFAULT_SOURCE_CAPS,
        applied=stream_settings_applied(
            settings_fingerprint,
            active_settings,
            publisher_identity=active_identity,
        ),
    )


def _read_required_text(mapping: Mapping[str, object], field_name: str) -> str:
    if field_name not in mapping:
        raise ValueError(f"missing_{field_name}")

    value = mapping[field_name]
    if not isinstance(value, str):
        raise ValueError(f"invalid_{field_name}")

    value = value.strip()
    if not value:
        raise ValueError(f"blank_{field_name}")
    return value


def filter_whep_answer_for_host(answer_sdp: str, preferred_host: str) -> str:
    return filter_or_rewrite_media_answer(answer_sdp, preferred_host=preferred_host)


async def proxy_whep_offer_to_backend(
    offer_sdp: str,
    backend_url: str = DEFAULT_WHEP_BACKEND_URL,
) -> tuple[int, str, str]:
    async with ClientSession() as session:
        async with session.post(
            backend_url,
            data=offer_sdp,
            headers={
                "Content-Type": "application/sdp",
                "Accept": "application/sdp",
            },
        ) as response:
            return (
                response.status,
                await response.text(),
                response.headers.get("Content-Type", "application/sdp"),
            )


def create_stream_app(
    room_registry: RoomRegistry | None = None,
    control_peer_factory: ControlPeerFactory | None = None,
    input_hub: WebGamepadHub | None = None,
    input_timeout_sec: float = 8.0,
    input_deadzone: float = 0.12,
    input_max_devices: int = 4,
    whep_offer_handler: Callable[[str], Awaitable[tuple[int, str, str]]] | None = None,
    stream_settings_path: Path | None = None,
    active_stream_settings_path: Path | None = None,
) -> web.Application:
    app = web.Application()
    room_registry_key = web.AppKey("room_registry", RoomRegistry)
    control_peer_factory_key = web.AppKey("control_peer_factory", ControlPeerFactory)
    input_hub_key = web.AppKey("input_hub", WebGamepadHub)
    whep_offer_handler_key = web.AppKey(
        "whep_offer_handler",
        Callable[[str], Awaitable[tuple[int, str, str]]],
    )
    app[room_registry_key] = room_registry or RoomRegistry()
    app[input_hub_key] = input_hub or WebGamepadHub(
        pool=VirtualDevicePool(max_devices=input_max_devices),
        mapper=GamepadMapper(deadzone=input_deadzone),
    )
    app[control_peer_factory_key] = control_peer_factory or ControlPeerFactory(
        input_packet_handler=lambda packet: app[input_hub_key].apply_input_packet(
            packet,
            peer=("webrtc", 0),
            source="webrtc",
        )
    )
    app[whep_offer_handler_key] = whep_offer_handler or proxy_whep_offer_to_backend
    stream_settings_path_key = web.AppKey("stream_settings_path", Path)
    active_stream_settings_path_key = web.AppKey("active_stream_settings_path", Path)
    app[stream_settings_path_key] = stream_settings_path or _runtime_stream_settings_path()
    app[active_stream_settings_path_key] = (
        active_stream_settings_path or _runtime_active_stream_settings_path()
    )

    async def input_cleanup_context(app: web.Application):
        cleanup_task = asyncio.create_task(
            cleanup_loop(pool=app[input_hub_key].pool, timeout_sec=input_timeout_sec)
        )
        yield
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task

    async def cleanup_control_peers(app: web.Application) -> None:
        close_all = getattr(app[control_peer_factory_key], "close_all", None)
        if callable(close_all):
            await close_all()

    async def cleanup_input_sessions(app: web.Application) -> None:
        pool = app[input_hub_key].pool
        for session_key in list(pool.sessions.keys()):
            pool.release(session_key)

    async def handle_join(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return cors_json_response({"ok": False, "reason": "bad_json"}, status=400)

        if not isinstance(payload, Mapping):
            return cors_json_response({"ok": False, "reason": "invalid_body"}, status=400)

        try:
            room_id = _read_required_text(payload, "room_id")
            player_id = _read_required_text(payload, "player_id")
            joined = request.app[room_registry_key].join_room(room_id=room_id, player_id=player_id)
        except ValueError as exc:
            reason = str(exc)
            status = 409 if reason == "reconnect_required" else 400
            return cors_json_response({"ok": False, "reason": reason}, status=status)

        return cors_json_response(
            {
                "room_id": joined.room_id,
                "player_id": joined.player_id,
                "role": joined.role,
                "seat_index": joined.seat_index,
                "seat_epoch": joined.seat_epoch,
                "reconnect_token": joined.reconnect_token,
            }
        )

    async def handle_status(request: web.Request) -> web.Response:
        try:
            room_id = _read_required_text(request.query, "room_id")
        except ValueError as exc:
            return cors_json_response({"ok": False, "reason": str(exc)}, status=400)

        snapshot = request.app[room_registry_key].snapshot(room_id)
        return cors_json_response(snapshot)

    async def handle_reconnect(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return cors_json_response({"ok": False, "reason": "bad_json"}, status=400)

        if not isinstance(payload, Mapping):
            return cors_json_response({"ok": False, "reason": "invalid_body"}, status=400)

        try:
            room_id = _read_required_text(payload, "room_id")
            player_id = _read_required_text(payload, "player_id")
            reconnect_token = _read_required_text(payload, "reconnect_token")
            reconnected = request.app[room_registry_key].reconnect_room(
                room_id=room_id,
                player_id=player_id,
                reconnect_token=reconnect_token,
            )
        except ValueError as exc:
            reason = str(exc)
            status = 409 if reason == "bad_reconnect_token" else 400
            return cors_json_response({"ok": False, "reason": reason}, status=status)

        return cors_json_response(
            {
                "room_id": reconnected.room_id,
                "player_id": reconnected.player_id,
                "role": reconnected.role,
                "seat_index": reconnected.seat_index,
                "seat_epoch": reconnected.seat_epoch,
                "reconnect_token": reconnected.reconnect_token,
            }
        )

    async def handle_control_offer(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return cors_json_response({"ok": False, "reason": "bad_json"}, status=400)

        if not isinstance(payload, Mapping):
            return cors_json_response({"ok": False, "reason": "invalid_body"}, status=400)

        try:
            room_id = _read_required_text(payload, "room_id")
            player_id = _read_required_text(payload, "player_id")
            reconnect_token = _read_required_text(payload, "reconnect_token")
            offer_sdp = _read_required_text(payload, "sdp")
            offer_type = "offer"
            if "type" in payload:
                offer_type = _read_required_text(payload, "type")

            member = request.app[room_registry_key].require_player(
                room_id=room_id,
                player_id=player_id,
                reconnect_token=reconnect_token,
            )
            if member.role != "player":
                raise ValueError("spectator_cannot_control")

            answer = await request.app[control_peer_factory_key].answer_offer(
                offer_sdp=offer_sdp,
                offer_type=offer_type,
            )
        except ValueError as exc:
            reason = str(exc)
            status = 409 if reason in {"bad_reconnect_token", "spectator_cannot_control"} else 400
            return cors_json_response({"ok": False, "reason": reason}, status=status)

        answer_sdp = str(answer.get("sdp") or "")
        request_host = _extract_host_only(request.host)
        rewritten_answer_sdp = rewrite_control_answer_host_candidates(
            answer_sdp,
            preferred_host=request.host,
        )
        diagnostics = {
            "request_host": request_host,
            **describe_host_candidates(answer_sdp),
        }

        return cors_json_response(
            {
                **answer,
                "sdp": rewritten_answer_sdp,
                "diagnostics": diagnostics,
            }
        )

    async def handle_media_whep(request: web.Request) -> web.Response:
        offer_sdp = await request.text()
        status, answer_sdp, _ = await request.app[whep_offer_handler_key](offer_sdp)
        filtered_answer = filter_or_rewrite_media_answer(answer_sdp, preferred_host=request.host)
        return add_cors_headers(
            web.Response(
                status=status,
                text=filtered_answer,
                content_type="application/sdp",
            )
        )

    async def handle_stream_settings_get(request: web.Request) -> web.Response:
        settings, settings_fingerprint = load_requested_stream_settings_snapshot(
            request.app[stream_settings_path_key]
        )
        active_settings = load_optional_active_stream_settings(
            request.app[active_stream_settings_path_key]
        )
        return cors_json_response(
            {
                "ok": True,
                **_stream_settings_payload(settings, settings_fingerprint, active_settings),
            }
        )

    async def handle_stream_settings_post(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return cors_json_response({"ok": False, "reason": "bad_json"}, status=400)

        if not isinstance(payload, Mapping):
            return cors_json_response({"ok": False, "reason": "invalid_body"}, status=400)

        save_stream_settings(request.app[stream_settings_path_key], payload)
        settings, settings_fingerprint = load_requested_stream_settings_snapshot(
            request.app[stream_settings_path_key]
        )
        active_settings = load_optional_active_stream_settings(
            request.app[active_stream_settings_path_key]
        )
        return cors_json_response(
            {
                "ok": True,
                **_stream_settings_payload(settings, settings_fingerprint, active_settings),
            }
        )

    async def handle_options(request: web.Request) -> web.Response:
        return add_cors_headers(web.Response(status=204))

    app.add_routes(
        [
            web.options("/api/room/join", handle_options),
            web.post("/api/room/join", handle_join),
            web.options("/api/room/reconnect", handle_options),
            web.post("/api/room/reconnect", handle_reconnect),
            web.options("/api/room/status", handle_options),
            web.get("/api/room/status", handle_status),
            web.options("/api/control/offer", handle_options),
            web.post("/api/control/offer", handle_control_offer),
            web.options("/api/stream/settings", handle_options),
            web.get("/api/stream/settings", handle_stream_settings_get),
            web.post("/api/stream/settings", handle_stream_settings_post),
            web.options("/media/whep", handle_options),
            web.post("/media/whep", handle_media_whep),
            web.get("/ws", app[input_hub_key].handle_ws),
            web.options("/input", handle_input_options),
            web.post("/input", app[input_hub_key].handle_http_input),
        ]
    )
    app.cleanup_ctx.append(input_cleanup_context)
    app.on_cleanup.append(cleanup_control_peers)
    app.on_cleanup.append(cleanup_input_sessions)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="LAN Streaming Gateway")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8082)
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--deadzone", type=float, default=0.12)
    parser.add_argument("--max-devices", type=int, default=4)
    args = parser.parse_args()
    web.run_app(
        create_stream_app(
            input_timeout_sec=args.timeout,
            input_deadzone=args.deadzone,
            input_max_devices=args.max_devices,
        ),
        host=args.host,
        port=args.port,
    )


if __name__ == "__main__":
    main()

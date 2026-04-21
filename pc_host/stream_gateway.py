import argparse
from collections.abc import Mapping

from aiohttp import web

from streaming.room_state import RoomRegistry


CORS_ALLOW_METHODS = "GET, POST, OPTIONS"
CORS_ALLOW_HEADERS = "Content-Type"
CORS_MAX_AGE = "86400"


def add_cors_headers(response: web.StreamResponse) -> web.StreamResponse:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = CORS_ALLOW_METHODS
    response.headers["Access-Control-Allow-Headers"] = CORS_ALLOW_HEADERS
    response.headers["Access-Control-Max-Age"] = CORS_MAX_AGE
    return response


def cors_json_response(payload: dict, status: int = 200) -> web.Response:
    return add_cors_headers(web.json_response(payload, status=status))


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


def create_stream_app(room_registry: RoomRegistry | None = None) -> web.Application:
    app = web.Application()
    room_registry_key = web.AppKey("room_registry", RoomRegistry)
    app[room_registry_key] = room_registry or RoomRegistry()

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

    async def handle_options(request: web.Request) -> web.Response:
        return add_cors_headers(web.Response(status=204))

    app.add_routes(
        [
            web.options("/api/room/join", handle_options),
            web.post("/api/room/join", handle_join),
            web.options("/api/room/status", handle_options),
            web.get("/api/room/status", handle_status),
        ]
    )
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="LAN Streaming Gateway")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8082)
    args = parser.parse_args()
    web.run_app(create_stream_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()

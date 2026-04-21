import argparse

from aiohttp import web

from streaming.room_state import RoomRegistry


ROOM_REGISTRY_KEY = web.AppKey("room_registry", RoomRegistry)


async def handle_join(request: web.Request) -> web.Response:
    payload = await request.json()
    room_id = str(payload["room_id"]).strip()
    player_id = str(payload["player_id"]).strip()
    joined = request.app[ROOM_REGISTRY_KEY].join_room(room_id=room_id, player_id=player_id)
    return web.json_response(
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
    room_id = request.query["room_id"]
    snapshot = request.app[ROOM_REGISTRY_KEY].snapshot(room_id)
    return web.json_response(snapshot)


def create_stream_app(room_registry: RoomRegistry | None = None) -> web.Application:
    app = web.Application()
    app[ROOM_REGISTRY_KEY] = room_registry or RoomRegistry()
    app.add_routes(
        [
            web.post("/api/room/join", handle_join),
            web.get("/api/room/status", handle_status),
        ]
    )
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LAN Streaming Gateway")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8082)
    args = parser.parse_args()
    web.run_app(create_stream_app(), host=args.host, port=args.port)

import unittest
from unittest.mock import patch

from aiohttp.test_utils import AioHTTPTestCase

import stream_gateway
from stream_gateway import create_stream_app
from streaming.room_state import RoomRegistry


class StreamGatewayCliTests(unittest.TestCase):
    def test_main_runs_gateway_with_cli_host_and_port(self) -> None:
        app = object()

        with (
            patch.object(stream_gateway, "create_stream_app", return_value=app),
            patch.object(stream_gateway.web, "run_app") as run_app,
            patch("sys.argv", ["stream_gateway.py", "--host", "127.0.0.1", "--port", "9090"]),
        ):
            stream_gateway.main()

        run_app.assert_called_once_with(app, host="127.0.0.1", port=9090)

    def test_module_does_not_expose_room_registry_key(self) -> None:
        self.assertFalse(hasattr(stream_gateway, "ROOM_REGISTRY_KEY"))


class StreamGatewayApiTests(AioHTTPTestCase):
    async def get_application(self):
        self.registry = RoomRegistry(max_seats=4, seat_hold_seconds=10.0, now_fn=lambda: 100.0)
        return create_stream_app(room_registry=self.registry)

    async def test_join_returns_player_seat_and_reconnect_token(self) -> None:
        response = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["role"], "player")
        self.assertEqual(payload["seat_index"], 1)
        self.assertEqual(payload["room_id"], "living-room")
        self.assertIn("reconnect_token", payload)

    async def test_fifth_join_becomes_spectator(self) -> None:
        for idx in range(4):
            await self.client.post(
                "/api/room/join",
                json={"room_id": "living-room", "player_id": f"p{idx}"},
            )

        response = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "p4"},
        )
        payload = await response.json()

        self.assertEqual(payload["role"], "spectator")
        self.assertIsNone(payload["seat_index"])

    async def test_status_exposes_room_snapshot(self) -> None:
        await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )

        response = await self.client.get("/api/room/status?room_id=living-room")
        payload = await response.json()

        self.assertEqual(payload["room_id"], "living-room")
        self.assertEqual(payload["players"][0]["seat_index"], 1)


if __name__ == "__main__":
    unittest.main()

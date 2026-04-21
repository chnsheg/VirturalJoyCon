import unittest

from aiohttp.test_utils import AioHTTPTestCase

from stream_gateway import create_stream_app
from streaming.room_state import RoomRegistry


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

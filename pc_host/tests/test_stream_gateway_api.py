import unittest
from unittest.mock import patch

from aiohttp.test_utils import AioHTTPTestCase

import stream_gateway
from stream_gateway import create_stream_app
from streaming.room_state import RoomRegistry


class FakeControlPeerFactory:
    def __init__(self) -> None:
        self.calls: list[dict[str, str]] = []

    async def answer_offer(self, offer_sdp: str, offer_type: str = "offer") -> dict:
        self.calls.append({"offer_sdp": offer_sdp, "offer_type": offer_type})
        return {"sdp": "fake-answer", "type": "answer"}


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


class RoomRegistrySnapshotTests(unittest.TestCase):
    def test_snapshot_for_unknown_room_is_empty_and_does_not_create_room(self) -> None:
        registry = RoomRegistry(now_fn=lambda: 100.0)

        snapshot = registry.snapshot("missing-room")

        self.assertEqual(snapshot, {"room_id": "missing-room", "players": []})
        self.assertEqual(registry._rooms, {})


class StreamGatewayApiTests(AioHTTPTestCase):
    async def get_application(self):
        self.now = [100.0]
        self.registry = RoomRegistry(max_seats=4, seat_hold_seconds=10.0, now_fn=lambda: self.now[0])
        self.control_peer_factory = FakeControlPeerFactory()
        return create_stream_app(
            room_registry=self.registry,
            control_peer_factory=self.control_peer_factory,
        )

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

    async def test_status_returns_empty_snapshot_for_unknown_room(self) -> None:
        response = await self.client.get("/api/room/status?room_id=missing-room")
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {"room_id": "missing-room", "players": []})

    async def test_status_cleans_expired_reservations_and_promotes_waiting_spectator(self) -> None:
        for player_id in ["alice", "bob", "charlie", "dana", "erin"]:
            await self.client.post(
                "/api/room/join",
                json={"room_id": "living-room", "player_id": player_id},
            )

        self.registry.mark_disconnected("living-room", "alice")
        self.now[0] = 111.0

        response = await self.client.get("/api/room/status?room_id=living-room")
        payload = await response.json()

        self.assertEqual(response.status, 200)
        players_by_id = {player["player_id"]: player for player in payload["players"]}

        self.assertNotIn("alice", players_by_id)
        self.assertEqual(players_by_id["erin"]["role"], "player")
        self.assertEqual(players_by_id["erin"]["seat_index"], 1)
        self.assertEqual(players_by_id["erin"]["seat_epoch"], 1)

    async def test_join_rejects_duplicate_active_player_with_json_conflict(self) -> None:
        await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )

        response = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )
        payload = await response.json()

        self.assertEqual(response.status, 409)
        self.assertEqual(payload, {"ok": False, "reason": "reconnect_required"})

    async def test_join_rejects_missing_or_blank_fields_with_json_error(self) -> None:
        missing_response = await self.client.post("/api/room/join", json={"room_id": "living-room"})
        missing_payload = await missing_response.json()
        blank_response = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "   "},
        )
        blank_payload = await blank_response.json()

        self.assertEqual(missing_response.status, 400)
        self.assertEqual(missing_payload, {"ok": False, "reason": "missing_player_id"})
        self.assertEqual(blank_response.status, 400)
        self.assertEqual(blank_payload, {"ok": False, "reason": "blank_player_id"})

    async def test_join_rejects_scalar_json_body_with_json_error(self) -> None:
        response = await self.client.post("/api/room/join", json=123)
        payload = await response.json()

        self.assertEqual(response.status, 400)
        self.assertEqual(payload, {"ok": False, "reason": "invalid_body"})

    async def test_join_rejects_malformed_json_body_with_bad_json_error(self) -> None:
        response = await self.client.post(
            "/api/room/join",
            data=b'{"room_id":',
            headers={"Content-Type": "application/json"},
        )
        payload = await response.json()

        self.assertEqual(response.status, 400)
        self.assertEqual(payload, {"ok": False, "reason": "bad_json"})

    async def test_join_rejects_null_room_or_player_id(self) -> None:
        null_room_response = await self.client.post(
            "/api/room/join",
            json={"room_id": None, "player_id": "alice"},
        )
        null_room_payload = await null_room_response.json()
        null_player_response = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": None},
        )
        null_player_payload = await null_player_response.json()

        self.assertEqual(null_room_response.status, 400)
        self.assertEqual(null_room_payload, {"ok": False, "reason": "invalid_room_id"})
        self.assertEqual(null_player_response.status, 400)
        self.assertEqual(null_player_payload, {"ok": False, "reason": "invalid_player_id"})

    async def test_status_requires_room_id_query_parameter(self) -> None:
        response = await self.client.get("/api/room/status")
        payload = await response.json()

        self.assertEqual(response.status, 400)
        self.assertEqual(payload, {"ok": False, "reason": "missing_room_id"})

    async def test_gateway_options_and_json_responses_include_cors_headers(self) -> None:
        options_response = await self.client.options("/api/room/join")
        join_response = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )
        status_response = await self.client.get("/api/room/status?room_id=living-room")

        self.assertEqual(options_response.status, 204)
        self.assertEqual(options_response.headers["Access-Control-Allow-Origin"], "*")
        self.assertIn("POST", options_response.headers["Access-Control-Allow-Methods"])
        self.assertIn("GET", options_response.headers["Access-Control-Allow-Methods"])
        self.assertIn("OPTIONS", options_response.headers["Access-Control-Allow-Methods"])
        self.assertEqual(join_response.headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(status_response.headers["Access-Control-Allow-Origin"], "*")

    async def test_control_offer_returns_answer_for_active_player(self) -> None:
        join = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )
        joined = await join.json()

        response = await self.client.post(
            "/api/control/offer",
            json={
                "room_id": "living-room",
                "player_id": joined["player_id"],
                "reconnect_token": joined["reconnect_token"],
                "sdp": "fake-offer",
                "type": "offer",
            },
        )
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {"sdp": "fake-answer", "type": "answer"})
        self.assertEqual(
            self.control_peer_factory.calls,
            [{"offer_sdp": "fake-offer", "offer_type": "offer"}],
        )
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    async def test_control_offer_rejects_spectators(self) -> None:
        for idx in range(4):
            await self.client.post(
                "/api/room/join",
                json={"room_id": "living-room", "player_id": f"p{idx}"},
            )

        join = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "spectator"},
        )
        joined = await join.json()

        response = await self.client.post(
            "/api/control/offer",
            json={
                "room_id": "living-room",
                "player_id": joined["player_id"],
                "reconnect_token": joined["reconnect_token"],
                "sdp": "fake-offer",
                "type": "offer",
            },
        )
        payload = await response.json()

        self.assertEqual(response.status, 409)
        self.assertEqual(payload, {"ok": False, "reason": "spectator_cannot_control"})
        self.assertEqual(self.control_peer_factory.calls, [])
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    async def test_control_offer_rejects_bad_reconnect_token_without_creating_room(self) -> None:
        response = await self.client.post(
            "/api/control/offer",
            json={
                "room_id": "missing-room",
                "player_id": "alice",
                "reconnect_token": "wrong-token",
                "sdp": "fake-offer",
                "type": "offer",
            },
        )
        payload = await response.json()

        self.assertEqual(response.status, 409)
        self.assertEqual(payload, {"ok": False, "reason": "bad_reconnect_token"})
        self.assertEqual(self.registry._rooms, {})
        self.assertEqual(self.control_peer_factory.calls, [])

    async def test_control_offer_validates_bad_json_invalid_body_and_missing_fields(self) -> None:
        bad_json_response = await self.client.post(
            "/api/control/offer",
            data=b'{"room_id":',
            headers={"Content-Type": "application/json"},
        )
        bad_json_payload = await bad_json_response.json()

        invalid_body_response = await self.client.post("/api/control/offer", json=123)
        invalid_body_payload = await invalid_body_response.json()

        missing_field_response = await self.client.post(
            "/api/control/offer",
            json={"room_id": "living-room", "player_id": "alice"},
        )
        missing_field_payload = await missing_field_response.json()

        self.assertEqual(bad_json_response.status, 400)
        self.assertEqual(bad_json_payload, {"ok": False, "reason": "bad_json"})
        self.assertEqual(invalid_body_response.status, 400)
        self.assertEqual(invalid_body_payload, {"ok": False, "reason": "invalid_body"})
        self.assertEqual(missing_field_response.status, 400)
        self.assertEqual(missing_field_payload, {"ok": False, "reason": "missing_reconnect_token"})

    async def test_control_offer_options_and_error_responses_include_cors_headers(self) -> None:
        options_response = await self.client.options("/api/control/offer")
        error_response = await self.client.post(
            "/api/control/offer",
            json={"room_id": "living-room", "player_id": "alice"},
        )

        self.assertEqual(options_response.status, 204)
        self.assertEqual(options_response.headers["Access-Control-Allow-Origin"], "*")
        self.assertIn("POST", options_response.headers["Access-Control-Allow-Methods"])
        self.assertIn("OPTIONS", options_response.headers["Access-Control-Allow-Methods"])
        self.assertEqual(error_response.headers["Access-Control-Allow-Origin"], "*")


if __name__ == "__main__":
    unittest.main()

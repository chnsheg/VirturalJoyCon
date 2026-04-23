import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import AioHTTPTestCase, TestClient, TestServer

import stream_gateway
from stream_gateway import create_stream_app
from streaming.control_peer import ControlPeerFactory
from streaming.room_state import RoomRegistry
from web_host import WebGamepadHub


class FakeControlPeerFactory:
    def __init__(self, answer_sdp: str = "fake-answer") -> None:
        self.calls: list[dict[str, str]] = []
        self.close_all_calls = 0
        self.answer_sdp = answer_sdp

    async def answer_offer(self, offer_sdp: str, offer_type: str = "offer") -> dict:
        self.calls.append({"offer_sdp": offer_sdp, "offer_type": offer_type})
        return {"sdp": self.answer_sdp, "type": "answer"}

    async def close_all(self) -> None:
        self.close_all_calls += 1


class FakeInputSession:
    def __init__(self) -> None:
        self.user_index = 1
        self.last_seen = 0.0
        self.gamepad = object()

    def accepts_packet(self, packet: dict) -> bool:
        return True


class FakeInputPool:
    def __init__(self) -> None:
        self.sessions = {}
        self.released: list[str] = []

    def get_or_create(self, session_key, endpoint):
        session = FakeInputSession()
        self.sessions[session_key] = session
        return session

    def release(self, session_key: str) -> None:
        self.released.append(session_key)
        self.sessions.pop(session_key, None)


class FakeInputMapper:
    def __init__(self) -> None:
        self.packets: list[dict] = []

    def apply_packet(self, gamepad, packet: dict) -> None:
        self.packets.append(packet)


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


class WhepSdpFilterTests(unittest.TestCase):
    def test_filter_whep_answer_keeps_only_candidates_matching_the_requested_host(self) -> None:
        answer = "\r\n".join(
            [
                "v=0",
                "o=- 0 0 IN IP4 127.0.0.1",
                "s=-",
                "t=0 0",
                "a=candidate:1 1 UDP 2122252543 10.0.0.7 8189 typ host",
                "a=candidate:2 1 UDP 2122252543 192.168.0.112 8189 typ host",
                "a=end-of-candidates",
                "",
            ]
        )

        filtered = stream_gateway.filter_whep_answer_for_host(answer, preferred_host="192.168.0.112")

        self.assertIn("192.168.0.112 8189 typ host", filtered)
        self.assertNotIn("10.0.0.7 8189 typ host", filtered)
        self.assertIn("a=end-of-candidates", filtered)

    def test_filter_whep_answer_rewrites_host_candidates_when_requested_host_is_missing(self) -> None:
        answer = "\r\n".join(
            [
                "v=0",
                "a=candidate:1 1 UDP 2122252543 10.0.0.7 8189 typ host",
                "a=candidate:2 1 UDP 2122252543 192.168.129.24 8189 typ host",
                "a=end-of-candidates",
                "",
            ]
        )

        filtered = stream_gateway.filter_whep_answer_for_host(answer, preferred_host="192.168.0.112")

        self.assertIn("192.168.0.112 8189 typ host", filtered)
        self.assertNotIn("10.0.0.7 8189 typ host", filtered)
        self.assertNotIn("192.168.129.24 8189 typ host", filtered)
        self.assertIn("a=end-of-candidates", filtered)


class FakeChannel:
    def __init__(
        self,
        *,
        label: str = "joycon.control.v1",
        ordered: bool = True,
        max_retransmits=None,
        max_packet_lifetime=None,
    ) -> None:
        self.label = label
        self.ordered = ordered
        self.maxRetransmits = max_retransmits
        self.maxPacketLifeTime = max_packet_lifetime
        self.handlers: dict[str, object] = {}
        self.sent_messages: list[str] = []
        self.close_calls = 0

    def on(self, event_name: str):
        def register(handler):
            self.handlers[event_name] = handler
            return handler

        return register

    def send(self, message: str) -> None:
        self.sent_messages.append(message)

    def close(self) -> None:
        self.close_calls += 1


class FakeSessionDescription:
    def __init__(self, *, sdp: str, type: str) -> None:
        self.sdp = sdp
        self.type = type


class FakePeer:
    def __init__(
        self,
        *,
        fail_on_set_remote_description: bool = False,
        fail_on_create_answer: bool = False,
    ) -> None:
        self.handlers: dict[str, object] = {}
        self.remote_description = None
        self.localDescription = None
        self.connectionState = "new"
        self.close_calls = 0
        self.fail_on_set_remote_description = fail_on_set_remote_description
        self.fail_on_create_answer = fail_on_create_answer

    def on(self, event_name: str):
        def register(handler):
            self.handlers[event_name] = handler
            return handler

        return register

    async def setRemoteDescription(self, description) -> None:
        if self.fail_on_set_remote_description:
            raise RuntimeError("set_remote_description_failed")
        self.remote_description = description

    async def createAnswer(self):
        if self.fail_on_create_answer:
            raise RuntimeError("create_answer_failed")
        return FakeSessionDescription(sdp="fake-answer", type="answer")

    async def setLocalDescription(self, description) -> None:
        self.localDescription = description

    async def close(self) -> None:
        self.close_calls += 1
        self.connectionState = "closed"

    async def emit_connectionstatechange(self, state: str) -> None:
        self.connectionState = state
        handler = self.handlers.get("connectionstatechange")
        if handler is not None:
            result = handler()
            if result is not None:
                await result


class ControlPeerFactoryTests(unittest.TestCase):
    def test_accepts_control_channel_for_ordered_reliable_transport(self) -> None:
        channel = FakeChannel()

        self.assertTrue(ControlPeerFactory.accepts_control_channel(channel))

    def test_rejects_control_channel_when_unordered(self) -> None:
        channel = FakeChannel(ordered=False)

        self.assertFalse(ControlPeerFactory.accepts_control_channel(channel))

    def test_rejects_control_channel_when_max_retransmits_is_set(self) -> None:
        channel = FakeChannel(max_retransmits=0)

        self.assertFalse(ControlPeerFactory.accepts_control_channel(channel))

    def test_rejects_control_channel_when_max_packet_lifetime_is_set(self) -> None:
        channel = FakeChannel(max_packet_lifetime=1)

        self.assertFalse(ControlPeerFactory.accepts_control_channel(channel))

    def test_rejects_control_channel_with_wrong_label(self) -> None:
        channel = FakeChannel(label="joycon.input.v1")

        self.assertFalse(ControlPeerFactory.accepts_control_channel(channel))

    def test_accepts_input_channel_for_unordered_unreliable_transport(self) -> None:
        channel = FakeChannel(label="joycon.input.v1", ordered=False, max_retransmits=0)

        self.assertTrue(ControlPeerFactory.accepts_input_channel(channel))

    def test_configure_control_channel_registers_ping_pong_for_supported_channel(self) -> None:
        factory = ControlPeerFactory()
        channel = FakeChannel()

        configured = factory.configure_control_channel(channel)

        self.assertTrue(configured)
        self.assertEqual(channel.close_calls, 0)
        self.assertIn("message", channel.handlers)
        channel.handlers["message"]("ping")
        self.assertEqual(channel.sent_messages, ["pong"])

    def test_configure_control_channel_closes_unsupported_control_channel(self) -> None:
        factory = ControlPeerFactory()
        channel = FakeChannel(max_retransmits=0)

        configured = factory.configure_control_channel(channel)

        self.assertFalse(configured)
        self.assertEqual(channel.close_calls, 1)
        self.assertNotIn("message", channel.handlers)

    def test_configure_input_channel_applies_latest_state_packets(self) -> None:
        applied_packets: list[dict] = []
        factory = ControlPeerFactory(input_packet_handler=applied_packets.append)
        channel = FakeChannel(label="joycon.input.v1", ordered=False, max_retransmits=0)

        configured = factory.configure_input_channel(channel)

        self.assertTrue(configured)
        self.assertEqual(channel.close_calls, 0)
        self.assertIn("message", channel.handlers)
        channel.handlers["message"](json.dumps({"client_session_id": "browser-01", "buttons": {"a": True}}))
        self.assertEqual(applied_packets, [{"client_session_id": "browser-01", "buttons": {"a": True}}])


class ControlPeerFactoryLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_answer_offer_keeps_peer_alive_and_returns_answer(self) -> None:
        created_peers: list[FakePeer] = []

        def create_peer() -> FakePeer:
            peer = FakePeer()
            created_peers.append(peer)
            return peer

        factory = ControlPeerFactory(
            peer_factory=create_peer,
            session_description_factory=FakeSessionDescription,
        )

        answer = await factory.answer_offer("fake-offer", "offer")

        self.assertEqual(answer, {"sdp": "fake-answer", "type": "answer"})
        self.assertEqual(len(created_peers), 1)
        self.assertEqual(factory.active_peers, {created_peers[0]})
        self.assertEqual(created_peers[0].remote_description.sdp, "fake-offer")
        self.assertEqual(created_peers[0].remote_description.type, "offer")

    async def test_answer_offer_cleans_up_peer_on_closed_state(self) -> None:
        peer = FakePeer()
        factory = ControlPeerFactory(
            peer_factory=lambda: peer,
            session_description_factory=FakeSessionDescription,
        )

        await factory.answer_offer("fake-offer", "offer")
        await peer.emit_connectionstatechange("closed")

        self.assertEqual(factory.active_peers, set())

    async def test_answer_offer_cleans_up_peer_on_failed_state(self) -> None:
        peer = FakePeer()
        factory = ControlPeerFactory(
            peer_factory=lambda: peer,
            session_description_factory=FakeSessionDescription,
        )

        await factory.answer_offer("fake-offer", "offer")
        await peer.emit_connectionstatechange("failed")

        self.assertEqual(factory.active_peers, set())
        self.assertEqual(peer.close_calls, 1)

    async def test_answer_offer_keeps_peer_alive_on_disconnected_state(self) -> None:
        peer = FakePeer()
        factory = ControlPeerFactory(
            peer_factory=lambda: peer,
            session_description_factory=FakeSessionDescription,
        )

        await factory.answer_offer("fake-offer", "offer")
        self.assertEqual(factory.active_peers, {peer})

        await peer.emit_connectionstatechange("disconnected")

        self.assertEqual(factory.active_peers, {peer})
        self.assertEqual(peer.close_calls, 0)

    async def test_answer_offer_cleans_up_peer_when_set_remote_description_fails(self) -> None:
        peer = FakePeer(fail_on_set_remote_description=True)
        factory = ControlPeerFactory(
            peer_factory=lambda: peer,
            session_description_factory=FakeSessionDescription,
        )

        with self.assertRaisesRegex(RuntimeError, "set_remote_description_failed"):
            await factory.answer_offer("fake-offer", "offer")

        self.assertEqual(factory.active_peers, set())
        self.assertEqual(peer.close_calls, 1)

    async def test_answer_offer_cleans_up_peer_when_create_answer_fails(self) -> None:
        peer = FakePeer(fail_on_create_answer=True)
        factory = ControlPeerFactory(
            peer_factory=lambda: peer,
            session_description_factory=FakeSessionDescription,
        )

        with self.assertRaisesRegex(RuntimeError, "create_answer_failed"):
            await factory.answer_offer("fake-offer", "offer")

        self.assertEqual(factory.active_peers, set())
        self.assertEqual(peer.close_calls, 1)

    async def test_close_all_closes_and_clears_active_peers(self) -> None:
        peer_one = FakePeer()
        peer_two = FakePeer()
        factory = ControlPeerFactory()
        factory.active_peers.update({peer_one, peer_two})

        await factory.close_all()

        self.assertEqual(factory.active_peers, set())
        self.assertEqual(peer_one.close_calls, 1)
        self.assertEqual(peer_two.close_calls, 1)


class StreamGatewayAppLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_app_cleanup_calls_control_peer_factory_close_all(self) -> None:
        factory = FakeControlPeerFactory()
        app = create_stream_app(
            room_registry=RoomRegistry(now_fn=lambda: 100.0),
            control_peer_factory=factory,
        )

        app.freeze()
        await app.startup()
        await app.cleanup()

        self.assertEqual(factory.close_all_calls, 1)


class StreamGatewayApiTests(AioHTTPTestCase):
    async def get_application(self):
        self.now = [100.0]
        self.registry = RoomRegistry(max_seats=4, seat_hold_seconds=10.0, now_fn=lambda: self.now[0])
        self.control_peer_factory = FakeControlPeerFactory()
        self.input_pool = FakeInputPool()
        self.input_mapper = FakeInputMapper()
        self.settings_temp_dir = tempfile.TemporaryDirectory()
        self.settings_path = Path(self.settings_temp_dir.name) / "stream_settings.json"
        self.active_settings_path = Path(self.settings_temp_dir.name) / "stream_settings.active.json"
        return create_stream_app(
            room_registry=self.registry,
            control_peer_factory=self.control_peer_factory,
            input_hub=WebGamepadHub(pool=self.input_pool, mapper=self.input_mapper),
            stream_settings_path=self.settings_path,
            active_stream_settings_path=self.active_settings_path,
        )

    def tearDown(self) -> None:
        try:
            self.settings_temp_dir.cleanup()
        finally:
            super().tearDown()

    async def test_input_options_and_http_input_are_available_on_the_stream_gateway_port(self) -> None:
        options_response = await self.client.options(
            "/input",
            headers={
                "Origin": "http://controller.local:8090",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        post_response = await self.client.post(
            "/input",
            headers={
                "Origin": "http://controller.local:8090",
                "Content-Type": "application/json",
            },
            json={
                "client_session_id": "browser-01",
                "buttons": {"a": True},
                "sticks": {
                    "left": {"nx": 0.0, "ny": 0.0, "processed": True},
                    "right": {"nx": 0.0, "ny": 0.0, "processed": True},
                },
                "triggers": {"lt": 0.0, "rt": 0.0},
            },
        )
        payload = await post_response.json()

        self.assertEqual(options_response.status, 204)
        self.assertEqual(options_response.headers["Access-Control-Allow-Origin"], "*")
        self.assertIn("POST", options_response.headers["Access-Control-Allow-Methods"])
        self.assertEqual(post_response.status, 200)
        self.assertEqual(post_response.headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(payload, {"ok": True, "slot": 1})
        self.assertEqual(len(self.input_mapper.packets), 1)

    async def test_media_whep_proxy_filters_answer_candidates_to_the_requested_gateway_host(self) -> None:
        async def whep_offer_handler(offer_sdp: str) -> tuple[int, str, str]:
            self.assertEqual(offer_sdp, "test-offer")
            return (
                200,
                "\r\n".join(
                    [
                        "v=0",
                        "a=candidate:1 1 UDP 2122252543 10.0.0.7 8189 typ host",
                        "a=candidate:2 1 UDP 2122252543 192.168.0.112 8189 typ host",
                        "",
                    ]
                ),
                "application/sdp",
            )

        app = create_stream_app(
            room_registry=self.registry,
            control_peer_factory=self.control_peer_factory,
            input_hub=WebGamepadHub(pool=self.input_pool, mapper=self.input_mapper),
            whep_offer_handler=whep_offer_handler,
        )
        server = TestServer(app)
        client = TestClient(server)
        await client.start_server()
        try:
            response = await client.post(
                "/media/whep",
                data="test-offer",
                headers={
                    "Host": "192.168.0.112:8082",
                    "Content-Type": "application/sdp",
                },
            )
            answer = await response.text()

            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
            self.assertIn("192.168.0.112 8189 typ host", answer)
            self.assertNotIn("10.0.0.7 8189 typ host", answer)
        finally:
            await client.close()

    async def test_media_whep_proxy_rewrites_stale_answer_candidates_to_the_requested_gateway_host(self) -> None:
        async def whep_offer_handler(offer_sdp: str) -> tuple[int, str, str]:
            self.assertEqual(offer_sdp, "test-offer")
            return (
                200,
                "\r\n".join(
                    [
                        "v=0",
                        "a=candidate:1 1 UDP 2122252543 10.0.0.7 8189 typ host",
                        "a=candidate:2 1 UDP 2122252543 192.168.129.24 8189 typ host",
                        "a=end-of-candidates",
                        "",
                    ]
                ),
                "application/sdp",
            )

        app = create_stream_app(
            room_registry=self.registry,
            control_peer_factory=self.control_peer_factory,
            input_hub=WebGamepadHub(pool=self.input_pool, mapper=self.input_mapper),
            whep_offer_handler=whep_offer_handler,
        )
        server = TestServer(app)
        client = TestClient(server)
        await client.start_server()
        try:
            response = await client.post(
                "/media/whep",
                data="test-offer",
                headers={
                    "Host": "10.126.126.2:8082",
                    "Content-Type": "application/sdp",
                },
            )
            answer = await response.text()

            self.assertEqual(response.status, 200)
            self.assertIn("10.126.126.2 8189 typ host", answer)
            self.assertNotIn("10.0.0.7 8189 typ host", answer)
            self.assertNotIn("192.168.129.24 8189 typ host", answer)
            self.assertIn("a=end-of-candidates", answer)
        finally:
            await client.close()

    async def test_ws_endpoint_is_available_on_the_stream_gateway_port(self) -> None:
        ws = await self.client.ws_connect("/ws")
        await ws.send_json({"type": "ping", "client_sent_at_ms": 123})
        message = await ws.receive_json()
        await ws.close()

        self.assertEqual(message["type"], "pong")
        self.assertEqual(message["client_sent_at_ms"], 123)

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

    async def test_reconnect_recovers_the_same_seat(self) -> None:
        join = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )
        joined = await join.json()

        response = await self.client.post(
            "/api/room/reconnect",
            json={
                "room_id": "living-room",
                "player_id": joined["player_id"],
                "reconnect_token": joined["reconnect_token"],
            },
        )
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["seat_index"], 1)
        self.assertGreater(payload["seat_epoch"], joined["seat_epoch"])
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    async def test_reconnect_restores_spectator_for_future_promotion(self) -> None:
        for player_id in ["alice", "bob", "charlie", "dana"]:
            await self.client.post(
                "/api/room/join",
                json={"room_id": "living-room", "player_id": player_id},
            )

        join = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "spectator"},
        )
        joined = await join.json()

        self.registry.mark_disconnected("living-room", "spectator")
        reconnect = await self.client.post(
            "/api/room/reconnect",
            json={
                "room_id": "living-room",
                "player_id": joined["player_id"],
                "reconnect_token": joined["reconnect_token"],
            },
        )
        reconnect_payload = await reconnect.json()

        self.assertEqual(reconnect.status, 200)
        self.assertEqual(reconnect_payload["role"], "spectator")

        self.registry.mark_disconnected("living-room", "alice")
        self.now[0] = 111.0
        status = await self.client.get("/api/room/status?room_id=living-room")
        payload = await status.json()
        players_by_id = {player["player_id"]: player for player in payload["players"]}

        self.assertEqual(players_by_id["spectator"]["role"], "player")
        self.assertEqual(players_by_id["spectator"]["seat_index"], 1)

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

    async def test_control_offer_returns_control_answer_without_host_rewrite(self) -> None:
        self.control_peer_factory.answer_sdp = (
            "\r\n".join(
                [
                    "v=0",
                    "m=application 53389 UDP/DTLS/SCTP webrtc-datachannel",
                    "c=IN IP4 10.0.0.2",
                    "a=candidate:1 1 udp 2130706431 10.0.0.2 53389 typ host",
                    "a=candidate:2 1 udp 2130706431 172.25.16.1 53390 typ host",
                    "a=candidate:3 1 udp 2130706431 192.168.0.119 53394 typ host",
                    "a=end-of-candidates",
                ]
            )
            + "\r\n"
        )

        join = await self.client.post(
            "/api/room/join",
            json={"room_id": "living-room", "player_id": "alice"},
        )
        joined = await join.json()

        response = await self.client.post(
            "/api/control/offer",
            headers={"Host": "192.168.0.119:8082"},
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
        self.assertIn("c=IN IP4 10.0.0.2", payload["sdp"])
        self.assertIn("a=candidate:1 1 udp 2130706431 10.0.0.2 53389 typ host", payload["sdp"])
        self.assertIn("a=candidate:2 1 udp 2130706431 172.25.16.1 53390 typ host", payload["sdp"])
        self.assertIn("a=candidate:3 1 udp 2130706431 192.168.0.119 53394 typ host", payload["sdp"])

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

    async def test_stream_settings_get_returns_the_default_profile_when_none_has_been_saved(self) -> None:
        response = await self.client.get("/api/stream/settings")
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(
            payload,
            {
                "ok": True,
                "width": 1280,
                "height": 720,
                "fps": 60,
                "bitrateKbps": 6000,
                "requested": {
                    "width": 1280,
                    "height": 720,
                    "fps": 60,
                    "bitrateKbps": 6000,
                },
                "effective": {
                    "width": 1280,
                    "height": 720,
                    "fps": 60,
                    "bitrateKbps": 6000,
                },
                "sourceCaps": {
                    "width": 3840,
                    "height": 2160,
                    "fps": 60,
                },
                "applied": False,
            },
        )

    async def test_stream_settings_get_reports_requested_and_effective_values(self) -> None:
        self.settings_path.write_text(
            json.dumps({"width": 1920, "height": 1080, "fps": 90, "bitrateKbps": 9000}),
            encoding="utf-8",
        )

        response = await self.client.get("/api/stream/settings")
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(
            payload["requested"],
            {
                "width": 1920,
                "height": 1080,
                "fps": 90,
                "bitrateKbps": 9000,
            },
        )
        self.assertEqual(
            payload["effective"],
            {
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "bitrateKbps": 9000,
            },
        )
        self.assertEqual(payload["width"], 1920)
        self.assertEqual(payload["height"], 1080)
        self.assertEqual(payload["fps"], 60)
        self.assertEqual(payload["bitrateKbps"], 9000)
        self.assertEqual(payload["sourceCaps"]["fps"], 60)
        self.assertFalse(payload["applied"])

    async def test_stream_settings_get_reports_applied_when_the_active_profile_matches(self) -> None:
        self.settings_path.write_text(
            json.dumps({"width": 1920, "height": 1080, "fps": 90, "bitrateKbps": 9000}),
            encoding="utf-8",
        )
        self.active_settings_path.write_text(
            json.dumps({"width": 1920, "height": 1080, "fps": 90, "bitrateKbps": 9000}),
            encoding="utf-8",
        )

        response = await self.client.get("/api/stream/settings")
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["applied"], True)

    async def test_stream_settings_post_persists_the_validated_profile(self) -> None:
        response = await self.client.post(
            "/api/stream/settings",
            json={
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "bitrateKbps": 9000,
            },
        )
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["width"], 1920)
        self.assertEqual(payload["height"], 1080)
        self.assertEqual(payload["fps"], 60)
        self.assertEqual(payload["bitrateKbps"], 9000)
        self.assertEqual(payload["applied"], False)
        self.assertTrue(self.settings_path.exists())
        self.assertEqual(
            json.loads(self.settings_path.read_text(encoding="utf-8")),
            {
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "bitrateKbps": 9000,
            },
        )

    async def test_stream_settings_post_reports_applied_when_the_active_profile_already_matches(self) -> None:
        self.active_settings_path.write_text(
            json.dumps({"width": 1920, "height": 1080, "fps": 60, "bitrateKbps": 9000}),
            encoding="utf-8",
        )

        response = await self.client.post(
            "/api/stream/settings",
            json={
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "bitrateKbps": 9000,
            },
        )
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["applied"], True)

    async def test_stream_settings_post_normalizes_even_dimensions_and_bitrate_step(self) -> None:
        response = await self.client.post(
            "/api/stream/settings",
            json={
                "width": 1981,
                "height": 1079,
                "fps": 61,
                "bitrateKbps": 6055,
            },
        )
        payload = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(
            payload,
            {
                "ok": True,
                "width": 1980,
                "height": 1078,
                "fps": 60,
                "bitrateKbps": 6100,
                "requested": {
                    "width": 1980,
                    "height": 1078,
                    "fps": 61,
                    "bitrateKbps": 6100,
                },
                "effective": {
                    "width": 1980,
                    "height": 1078,
                    "fps": 60,
                    "bitrateKbps": 6100,
                },
                "sourceCaps": {
                    "width": 3840,
                    "height": 2160,
                    "fps": 60,
                },
                "applied": False,
            },
        )


if __name__ == "__main__":
    unittest.main()

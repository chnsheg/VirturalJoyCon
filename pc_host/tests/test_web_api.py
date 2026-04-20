import unittest

from aiohttp.test_utils import AioHTTPTestCase

from web_host import WebGamepadHub, create_web_app


class _FakeSession:
    def __init__(self) -> None:
        self.user_index = 1
        self.last_seen = 0.0
        self.gamepad = object()

    def accepts_packet(self, packet: dict) -> bool:
        return True


class _FakePool:
    def __init__(self) -> None:
        self.sessions = {}

    def get_or_create(self, session_key, endpoint):
        session = _FakeSession()
        self.sessions[session_key] = session
        return session

    def release(self, session_key: str) -> None:
        self.sessions.pop(session_key, None)


class _FakeMapper:
    def __init__(self) -> None:
        self.packets = []

    def apply_packet(self, gamepad, packet: dict) -> None:
        self.packets.append(packet)


class WebApiTests(AioHTTPTestCase):
    async def get_application(self):
        self.pool = _FakePool()
        self.mapper = _FakeMapper()
        hub = WebGamepadHub(pool=self.pool, mapper=self.mapper)
        return create_web_app(hub)

    async def test_options_input_returns_cors_headers(self) -> None:
        response = await self.client.options(
            "/input",
            headers={
                "Origin": "http://controller.local:8090",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
        self.assertIn("POST", response.headers["Access-Control-Allow-Methods"])
        self.assertIn("Content-Type", response.headers["Access-Control-Allow-Headers"])

    async def test_post_input_returns_cors_headers_for_cross_origin_requests(self) -> None:
        response = await self.client.post(
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

        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
        self.assertTrue(body["ok"])
        self.assertEqual(body["slot"], 1)

    async def test_root_is_not_served_as_static_site(self) -> None:
        response = await self.client.get("/")
        self.assertEqual(response.status, 404)


if __name__ == "__main__":
    unittest.main()

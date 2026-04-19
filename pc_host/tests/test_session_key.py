import unittest

from web_host import WebGamepadHub, build_access_urls


class _FakeSession:
    def __init__(self) -> None:
        self.last_seen = 0.0


class _FakePool:
    def __init__(self) -> None:
        self.sessions = {}
        self.create_calls = []

    def get_or_create(self, session_key, endpoint):
        self.create_calls.append((session_key, endpoint))
        session = _FakeSession()
        self.sessions[session_key] = session
        return session


class SessionKeyTests(unittest.TestCase):
    def test_session_key_is_stable_for_same_device_across_port_changes(self) -> None:
        packet = {"device_id": "phone-001"}
        k1 = WebGamepadHub._session_key(("10.201.54.10", 51000), packet)
        k2 = WebGamepadHub._session_key(("10.201.54.10", 51001), packet)
        self.assertEqual(k1, k2)

    def test_session_key_differs_for_different_device_ids(self) -> None:
        k1 = WebGamepadHub._session_key(("10.201.54.10", 51000), {"device_id": "phone-001"})
        k2 = WebGamepadHub._session_key(("10.201.54.10", 51000), {"device_id": "phone-002"})
        self.assertNotEqual(k1, k2)

    def test_session_key_stable_by_client_session_id_without_device_id(self) -> None:
        packet = {"client_session_id": "sess-abc-001"}
        k1 = WebGamepadHub._session_key(("10.201.54.10", 53001), packet)
        k2 = WebGamepadHub._session_key(("10.201.54.10", 53099), packet)
        self.assertEqual(k1, k2)

    def test_build_access_urls_uses_private_ipv4_addresses_for_wildcard_host(self) -> None:
        urls = build_access_urls(
            bind_host="0.0.0.0",
            http_port=8081,
            candidate_ips=[
                "192.168.0.119",
                "192.168.70.1",
                "10.1.2.3",
                "169.254.10.2",
                "8.8.8.8",
            ],
        )

        self.assertEqual(
            urls,
            [
                "http://10.1.2.3:8081",
                "http://192.168.0.119:8081",
                "http://192.168.70.1:8081",
            ],
        )

    def test_build_access_urls_prefers_explicit_bind_host(self) -> None:
        urls = build_access_urls(
            bind_host="192.168.0.119",
            http_port=8081,
            candidate_ips=["192.168.0.119", "10.1.2.3"],
        )

        self.assertEqual(urls, ["http://192.168.0.119:8081"])

    def test_idle_packet_does_not_allocate_virtual_controller(self) -> None:
        pool = _FakePool()
        hub = WebGamepadHub(pool=pool, mapper=None)
        packet = {
            "buttons": {"a": False, "start": False},
            "sticks": {
                "left": {"nx": 0.0, "ny": 0.0, "processed": True},
                "right": {"nx": 0.0, "ny": 0.0, "processed": True},
            },
            "triggers": {"lt": 0.0, "rt": 0.0},
        }

        session_key = WebGamepadHub._session_key(("127.0.0.1", 5000), {"client_session_id": "idle-tab"})
        session = hub._ensure_session_for_packet(session_key, ("127.0.0.1", 5000), packet)

        self.assertIs(session, WebGamepadHub.IDLE_PACKET)
        self.assertEqual(pool.create_calls, [])

    def test_active_packet_allocates_virtual_controller(self) -> None:
        pool = _FakePool()
        hub = WebGamepadHub(pool=pool, mapper=None)
        packet = {
            "buttons": {"a": False},
            "sticks": {
                "left": {"nx": 0.0, "ny": 0.76, "processed": True},
                "right": {"nx": 0.0, "ny": 0.0, "processed": True},
            },
            "triggers": {"lt": 0.0, "rt": 0.0},
        }

        session_key = WebGamepadHub._session_key(("192.168.0.8", 6000), {"client_session_id": "phone-active"})
        session = hub._ensure_session_for_packet(session_key, ("192.168.0.8", 6000), packet)

        self.assertIsNotNone(session)
        self.assertEqual(len(pool.create_calls), 1)


if __name__ == "__main__":
    unittest.main()

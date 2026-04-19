from web_host import WebGamepadHub


def test_session_key_is_stable_for_same_device_across_port_changes() -> None:
    packet = {"device_id": "phone-001"}
    k1 = WebGamepadHub._session_key(("10.201.54.10", 51000), packet)
    k2 = WebGamepadHub._session_key(("10.201.54.10", 51001), packet)
    assert k1 == k2


def test_session_key_differs_for_different_device_ids() -> None:
    k1 = WebGamepadHub._session_key(("10.201.54.10", 51000), {"device_id": "phone-001"})
    k2 = WebGamepadHub._session_key(("10.201.54.10", 51000), {"device_id": "phone-002"})
    assert k1 != k2


def test_session_key_stable_by_client_session_id_without_device_id() -> None:
    packet = {"client_session_id": "sess-abc-001"}
    k1 = WebGamepadHub._session_key(("10.201.54.10", 53001), packet)
    k2 = WebGamepadHub._session_key(("10.201.54.10", 53099), packet)
    assert k1 == k2

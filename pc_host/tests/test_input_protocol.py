import unittest

import vgamepad as vg

from gamepad_session_manager import GamepadMapper, Session, VirtualDevicePool


class FakeGamepad:
    def __init__(self) -> None:
        self.pressed = []
        self.released = []
        self.left_axes = None
        self.right_axes = None
        self.lt = None
        self.rt = None
        self.updated = 0

    def press_button(self, button) -> None:
        self.pressed.append(button)

    def release_button(self, button) -> None:
        self.released.append(button)

    def left_joystick(self, x_value: int, y_value: int) -> None:
        self.left_axes = (x_value, y_value)

    def right_joystick(self, x_value: int, y_value: int) -> None:
        self.right_axes = (x_value, y_value)

    def left_trigger(self, value: int) -> None:
        self.lt = value

    def right_trigger(self, value: int) -> None:
        self.rt = value

    def update(self) -> None:
        self.updated += 1


class FakeLowLevelController(FakeGamepad):
    def __init__(self, user_index: int = 2) -> None:
        super().__init__()
        self._user_index = user_index
        self.closed = False

    def get_user_index(self) -> int:
        return self._user_index

    def close(self) -> None:
        self.closed = True


class SessionSequenceTests(unittest.TestCase):
    def make_session(self) -> Session:
        return Session(
            session_key="sess-1",
            endpoint=("127.0.0.1", 28777),
            user_index=0,
            gamepad=FakeGamepad(),
            last_seen=0.0,
        )

    def test_session_rejects_stale_sequence_in_same_stream(self) -> None:
        session = self.make_session()

        self.assertTrue(session.accepts_packet({"input_stream_id": "stream-a", "seq": 10}))
        self.assertFalse(session.accepts_packet({"input_stream_id": "stream-a", "seq": 10}))
        self.assertFalse(session.accepts_packet({"input_stream_id": "stream-a", "seq": 9}))
        self.assertTrue(session.accepts_packet({"input_stream_id": "stream-a", "seq": 11}))

    def test_session_accepts_reset_sequence_when_stream_changes(self) -> None:
        session = self.make_session()

        self.assertTrue(session.accepts_packet({"input_stream_id": "stream-a", "seq": 42}))
        self.assertTrue(session.accepts_packet({"input_stream_id": "stream-b", "seq": 1}))


class MapperProtocolTests(unittest.TestCase):
    def test_mapper_supports_processed_sticks_thumb_buttons_and_triggers(self) -> None:
        mapper = GamepadMapper(deadzone=0.8)
        gamepad = FakeGamepad()

        packet = {
            "buttons": {
                "ls": True,
                "rs": False,
            },
            "sticks": {
                "left": {"nx": 0.15, "ny": 0.5, "processed": True},
                "right": {"nx": -0.25, "ny": 0.0, "processed": True},
            },
            "triggers": {
                "lt": 0.7,
                "rt": 0.2,
            },
        }

        mapper.apply_packet(gamepad, packet)

        self.assertIn(vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB, gamepad.pressed)
        self.assertIn(vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB, gamepad.released)
        self.assertEqual(gamepad.left_axes, (4915, 16384))
        self.assertEqual(gamepad.right_axes, (-8192, 0))
        self.assertEqual(gamepad.lt, 178)
        self.assertEqual(gamepad.rt, 51)
        self.assertEqual(gamepad.updated, 1)

    def test_virtual_device_pool_uses_protocol_controller_and_real_user_index(self) -> None:
        pool = VirtualDevicePool(max_devices=4, controller_factory=lambda: FakeLowLevelController(user_index=3))

        session = pool.get_or_create("sess-protocol", ("127.0.0.1", 28777))

        self.assertIsNotNone(session)
        self.assertEqual(session.user_index, 3)

        controller = session.gamepad
        pool.release("sess-protocol")
        self.assertTrue(controller.closed)


if __name__ == "__main__":
    unittest.main()

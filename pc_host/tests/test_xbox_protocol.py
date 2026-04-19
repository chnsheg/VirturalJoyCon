import unittest


class _FakeBackend:
    def __init__(self, user_index: int = 2) -> None:
        self.user_index = user_index
        self.connected = False
        self.added_targets = []
        self.removed_targets = []
        self.updated_reports = []
        self.freed_targets = []
        self.allocated_targets = 0

    def connect(self):
        self.connected = True
        return "bus"

    def alloc_target(self):
        self.allocated_targets += 1
        return f"target-{self.allocated_targets}"

    def add_target(self, bus_handle, target_handle):
        self.added_targets.append((bus_handle, target_handle))

    def update_x360(self, bus_handle, target_handle, report):
        self.updated_reports.append((bus_handle, target_handle, report))

    def get_user_index(self, bus_handle, target_handle):
        return self.user_index

    def remove_target(self, bus_handle, target_handle):
        self.removed_targets.append((bus_handle, target_handle))

    def free_target(self, target_handle):
        self.freed_targets.append(target_handle)


class XboxProtocolTests(unittest.TestCase):
    def test_controller_writes_xusb_report_fields_exactly(self) -> None:
        from xbox_protocol import Xbox360Controller, XUSB_BUTTON

        backend = _FakeBackend(user_index=1)
        controller = Xbox360Controller(backend=backend)
        controller.press_button(XUSB_BUTTON.XUSB_GAMEPAD_A)
        controller.press_button(XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER)
        controller.left_trigger(77)
        controller.right_trigger(201)
        controller.left_joystick(1234, -2345)
        controller.right_joystick(-3456, 4567)
        controller.update()

        self.assertEqual(len(backend.updated_reports), 2)
        _, _, report = backend.updated_reports[-1]
        self.assertEqual(int(report.wButtons), int(XUSB_BUTTON.XUSB_GAMEPAD_A | XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER))
        self.assertEqual(report.bLeftTrigger, 77)
        self.assertEqual(report.bRightTrigger, 201)
        self.assertEqual(report.sThumbLX, 1234)
        self.assertEqual(report.sThumbLY, -2345)
        self.assertEqual(report.sThumbRX, -3456)
        self.assertEqual(report.sThumbRY, 4567)

    def test_controller_exposes_real_xinput_user_index(self) -> None:
        from xbox_protocol import Xbox360Controller

        backend = _FakeBackend(user_index=3)
        controller = Xbox360Controller(backend=backend)

        self.assertEqual(controller.get_user_index(), 3)


if __name__ == "__main__":
    unittest.main()

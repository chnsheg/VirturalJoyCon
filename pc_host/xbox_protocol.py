import ctypes
from enum import IntFlag
from typing import Optional

import vgamepad.win.vigem_client as vigem_client
import vgamepad.win.vigem_commons as vigem_commons


class XUSB_BUTTON(IntFlag):
    XUSB_GAMEPAD_DPAD_UP = 0x0001
    XUSB_GAMEPAD_DPAD_DOWN = 0x0002
    XUSB_GAMEPAD_DPAD_LEFT = 0x0004
    XUSB_GAMEPAD_DPAD_RIGHT = 0x0008
    XUSB_GAMEPAD_START = 0x0010
    XUSB_GAMEPAD_BACK = 0x0020
    XUSB_GAMEPAD_LEFT_THUMB = 0x0040
    XUSB_GAMEPAD_RIGHT_THUMB = 0x0080
    XUSB_GAMEPAD_LEFT_SHOULDER = 0x0100
    XUSB_GAMEPAD_RIGHT_SHOULDER = 0x0200
    XUSB_GAMEPAD_GUIDE = 0x0400
    XUSB_GAMEPAD_A = 0x1000
    XUSB_GAMEPAD_B = 0x2000
    XUSB_GAMEPAD_X = 0x4000
    XUSB_GAMEPAD_Y = 0x8000


class XUSB_REPORT(ctypes.Structure):
    _fields_ = [
        ("wButtons", ctypes.c_ushort),
        ("bLeftTrigger", ctypes.c_ubyte),
        ("bRightTrigger", ctypes.c_ubyte),
        ("sThumbLX", ctypes.c_short),
        ("sThumbLY", ctypes.c_short),
        ("sThumbRX", ctypes.c_short),
        ("sThumbRY", ctypes.c_short),
    ]


class _ViGEmBackend:
    def connect(self):
        bus_handle = vigem_client.vigem_alloc()
        self._check(vigem_client.vigem_connect(bus_handle))
        return bus_handle

    def alloc_target(self):
        return vigem_client.vigem_target_x360_alloc()

    def add_target(self, bus_handle, target_handle):
        self._check(vigem_client.vigem_target_add(bus_handle, target_handle))

    def update_x360(self, bus_handle, target_handle, report):
        payload = vigem_commons.XUSB_REPORT(
            wButtons=int(report.wButtons),
            bLeftTrigger=int(report.bLeftTrigger),
            bRightTrigger=int(report.bRightTrigger),
            sThumbLX=int(report.sThumbLX),
            sThumbLY=int(report.sThumbLY),
            sThumbRX=int(report.sThumbRX),
            sThumbRY=int(report.sThumbRY),
        )
        self._check(vigem_client.vigem_target_x360_update(bus_handle, target_handle, payload))

    def get_user_index(self, bus_handle, target_handle):
        index = ctypes.c_ulong(0)
        self._check(vigem_client.vigem_target_x360_get_user_index(bus_handle, target_handle, ctypes.byref(index)))
        return int(index.value)

    def remove_target(self, bus_handle, target_handle):
        self._check(vigem_client.vigem_target_remove(bus_handle, target_handle))

    def free_target(self, target_handle):
        vigem_client.vigem_target_free(target_handle)

    @staticmethod
    def _check(error_code):
        if error_code != vigem_commons.VIGEM_ERRORS.VIGEM_ERROR_NONE:
            raise RuntimeError(vigem_commons.VIGEM_ERRORS(error_code).name)


_GLOBAL_BACKEND = _ViGEmBackend()
_GLOBAL_BUS_HANDLE = None


def _get_global_bus_handle():
    global _GLOBAL_BUS_HANDLE
    if _GLOBAL_BUS_HANDLE is None:
        _GLOBAL_BUS_HANDLE = _GLOBAL_BACKEND.connect()
    return _GLOBAL_BUS_HANDLE


class Xbox360Controller:
    def __init__(self, backend=None) -> None:
        self._backend = backend or _GLOBAL_BACKEND
        self._bus_handle = _get_global_bus_handle() if backend is None else backend.connect()
        self._target_handle = self._backend.alloc_target()
        self._backend.add_target(self._bus_handle, self._target_handle)
        self.report = self._default_report()
        self._closed = False
        self.update()

    @staticmethod
    def _default_report():
        return XUSB_REPORT(
            wButtons=0,
            bLeftTrigger=0,
            bRightTrigger=0,
            sThumbLX=0,
            sThumbLY=0,
            sThumbRX=0,
            sThumbRY=0,
        )

    def reset(self) -> None:
        self.report = self._default_report()

    def press_button(self, button) -> None:
        self.report.wButtons = int(self.report.wButtons | int(button))

    def release_button(self, button) -> None:
        self.report.wButtons = int(self.report.wButtons & ~int(button))

    def left_trigger(self, value: int) -> None:
        self.report.bLeftTrigger = value

    def right_trigger(self, value: int) -> None:
        self.report.bRightTrigger = value

    def left_joystick(self, x_value: int, y_value: int) -> None:
        self.report.sThumbLX = x_value
        self.report.sThumbLY = y_value

    def right_joystick(self, x_value: int, y_value: int) -> None:
        self.report.sThumbRX = x_value
        self.report.sThumbRY = y_value

    def update(self) -> None:
        self._backend.update_x360(self._bus_handle, self._target_handle, self.report)

    def get_user_index(self) -> Optional[int]:
        return self._backend.get_user_index(self._bus_handle, self._target_handle)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._backend.remove_target(self._bus_handle, self._target_handle)
        finally:
            self._backend.free_target(self._target_handle)

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass

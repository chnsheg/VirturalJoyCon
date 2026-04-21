from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from streaming.control_packets import ControlPacket


def _is_newer_counter(candidate: int, current: int, bits: int) -> bool:
    modulus = 1 << bits
    delta = (candidate - current) % modulus
    return 0 < delta < (modulus // 2)


@dataclass
class _SeatCursor:
    seat_epoch: int
    stream_epoch: int
    sequence: int


class SeatInputRouter:
    def __init__(self, apply_state: Callable[[int, ControlPacket], None]) -> None:
        self._apply_state = apply_state
        self._seats: dict[int, _SeatCursor] = {}

    def accept(self, packet: ControlPacket) -> bool:
        current = self._seats.get(packet.seat_index)
        if current is not None:
            if packet.seat_epoch != current.seat_epoch:
                if not _is_newer_counter(packet.seat_epoch, current.seat_epoch, 16):
                    return False
            elif packet.stream_epoch != current.stream_epoch:
                if not _is_newer_counter(packet.stream_epoch, current.stream_epoch, 16):
                    return False
            elif not _is_newer_counter(packet.sequence, current.sequence, 32):
                return False

        next_cursor = _SeatCursor(
            seat_epoch=packet.seat_epoch,
            stream_epoch=packet.stream_epoch,
            sequence=packet.sequence,
        )
        self._apply_state(packet.seat_index, packet)
        self._seats[packet.seat_index] = next_cursor
        return True

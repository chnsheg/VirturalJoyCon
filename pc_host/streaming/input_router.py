from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from streaming.control_packets import ControlPacket


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
            if packet.seat_epoch < current.seat_epoch:
                return False
            if packet.seat_epoch == current.seat_epoch and packet.stream_epoch < current.stream_epoch:
                return False
            if (
                packet.seat_epoch == current.seat_epoch
                and packet.stream_epoch == current.stream_epoch
                and packet.sequence <= current.sequence
            ):
                return False

        self._seats[packet.seat_index] = _SeatCursor(
            seat_epoch=packet.seat_epoch,
            stream_epoch=packet.stream_epoch,
            sequence=packet.sequence,
        )
        self._apply_state(packet.seat_index, packet)
        return True

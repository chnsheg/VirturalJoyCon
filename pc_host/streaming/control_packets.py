from __future__ import annotations

import struct
from dataclasses import dataclass


_PACKET_STRUCT = struct.Struct("<QQBIIIQIhhhhBB")


@dataclass(frozen=True)
class ControlPacket:
    room_id_hash: int
    player_id_hash: int
    seat_index: int
    seat_epoch: int
    stream_epoch: int
    sequence: int
    client_time_us: int
    buttons_bits: int
    left_x: int
    left_y: int
    right_x: int
    right_y: int
    lt: int
    rt: int


def encode_packet(packet: ControlPacket) -> bytes:
    return _PACKET_STRUCT.pack(
        packet.room_id_hash,
        packet.player_id_hash,
        packet.seat_index,
        packet.seat_epoch,
        packet.stream_epoch,
        packet.sequence,
        packet.client_time_us,
        packet.buttons_bits,
        packet.left_x,
        packet.left_y,
        packet.right_x,
        packet.right_y,
        packet.lt,
        packet.rt,
    )


def decode_packet(data: bytes) -> ControlPacket:
    return ControlPacket(*_PACKET_STRUCT.unpack(data))

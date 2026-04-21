import unittest


def _control_packet_exports():
    try:
        from streaming.control_packets import ControlPacket, decode_packet, encode_packet
    except ModuleNotFoundError as exc:
        raise AssertionError("streaming.control_packets exports are not implemented") from exc
    return ControlPacket, encode_packet, decode_packet


class ControlPacketCodecTests(unittest.TestCase):
    def test_packet_round_trips_through_binary_codec(self) -> None:
        ControlPacket, encode_packet, decode_packet = _control_packet_exports()
        packet = ControlPacket(
            room_id_hash=0x0123456789ABCDEF,
            player_id_hash=0x0FEDCBA987654321,
            seat_index=3,
            seat_epoch=7,
            stream_epoch=11,
            sequence=19,
            client_time_us=1234567890123,
            buttons_bits=0b1010101010101010,
            left_x=-32768,
            left_y=32767,
            right_x=-1234,
            right_y=2345,
            lt=64,
            rt=255,
        )

        encoded = encode_packet(packet)
        decoded = decode_packet(encoded)

        self.assertEqual(decoded, packet)


if __name__ == "__main__":
    unittest.main()

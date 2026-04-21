import unittest


def _control_packet_exports():
    try:
        from streaming.control_packets import ControlPacket, PACKET_STRUCT, decode_packet, encode_packet
    except (ModuleNotFoundError, ImportError) as exc:
        raise AssertionError("streaming.control_packets exports are not implemented") from exc
    return ControlPacket, PACKET_STRUCT, encode_packet, decode_packet


class ControlPacketCodecTests(unittest.TestCase):
    def test_packet_struct_matches_specified_wire_layout(self) -> None:
        _, packet_struct, _, _ = _control_packet_exports()

        self.assertEqual(packet_struct.format, "<QQBHHIQIhhhhHH")
        self.assertEqual(packet_struct.size, 49)

    def test_packet_round_trips_through_binary_codec(self) -> None:
        ControlPacket, packet_struct, encode_packet, decode_packet = _control_packet_exports()
        packet = ControlPacket(
            room_id_hash=0x0123456789ABCDEF,
            player_id_hash=0x0FEDCBA987654321,
            seat_index=3,
            seat_epoch=0xBEEF,
            stream_epoch=0x1234,
            sequence=0xDEADBEEF,
            client_time_us=1234567890123,
            buttons_bits=0xFEDCBA98,
            left_x=-32768,
            left_y=32767,
            right_x=-1234,
            right_y=2345,
            lt=1024,
            rt=65535,
        )

        encoded = encode_packet(packet)
        decoded = decode_packet(encoded)

        self.assertEqual(len(encoded), packet_struct.size)
        self.assertEqual(decoded, packet)


if __name__ == "__main__":
    unittest.main()

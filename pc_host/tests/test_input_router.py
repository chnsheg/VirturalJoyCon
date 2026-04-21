import unittest


def _router_exports():
    try:
        from streaming.control_packets import ControlPacket
        from streaming.input_router import SeatInputRouter
    except ModuleNotFoundError as exc:
        raise AssertionError("streaming input routing exports are not implemented") from exc
    return ControlPacket, SeatInputRouter


class SeatInputRouterTests(unittest.TestCase):
    def make_packet(
        self,
        *,
        seat_index: int = 1,
        seat_epoch: int = 1,
        stream_epoch: int = 1,
        sequence: int = 1,
    ):
        ControlPacket, _ = _router_exports()
        return ControlPacket(
            room_id_hash=11,
            player_id_hash=22,
            seat_index=seat_index,
            seat_epoch=seat_epoch,
            stream_epoch=stream_epoch,
            sequence=sequence,
            client_time_us=333,
            buttons_bits=444,
            left_x=0,
            left_y=0,
            right_x=0,
            right_y=0,
            lt=0,
            rt=0,
        )

    def test_router_drops_stale_sequence_for_a_seat(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        first = self.make_packet(seat_index=2, sequence=10)
        stale = self.make_packet(seat_index=2, sequence=9)

        self.assertTrue(router.accept(first))
        self.assertFalse(router.accept(stale))
        self.assertEqual(applied, [(2, first)])

    def test_router_accepts_higher_sequence_in_same_epoch_and_stream(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        first = self.make_packet(seat_index=1, sequence=10)
        later = self.make_packet(seat_index=1, sequence=11)

        self.assertTrue(router.accept(first))
        self.assertTrue(router.accept(later))
        self.assertEqual(applied, [(1, first), (1, later)])

    def test_router_does_not_advance_cursor_when_apply_state_fails(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        failures_left = 1

        def apply_state(*args):
            nonlocal failures_left
            if failures_left:
                failures_left -= 1
                raise RuntimeError("temporary apply failure")
            applied.append(args)

        router = SeatInputRouter(apply_state)
        packet = self.make_packet(seat_index=1, sequence=10)

        with self.assertRaisesRegex(RuntimeError, "temporary apply failure"):
            router.accept(packet)

        self.assertTrue(router.accept(packet))
        self.assertEqual(applied, [(1, packet)])

    def test_router_rejects_older_stream_epoch_for_same_seat(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        newer_stream = self.make_packet(seat_index=1, stream_epoch=5, sequence=2)
        older_stream = self.make_packet(seat_index=1, stream_epoch=4, sequence=99)

        self.assertTrue(router.accept(newer_stream))
        self.assertFalse(router.accept(older_stream))
        self.assertEqual(applied, [(1, newer_stream)])

    def test_router_accepts_stream_epoch_wraparound_and_resets_sequence_tracking(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        prior = self.make_packet(seat_index=1, stream_epoch=65535, sequence=0xFFFFFFFF)
        wrapped_stream = self.make_packet(seat_index=1, stream_epoch=0, sequence=0)

        self.assertTrue(router.accept(prior))
        self.assertTrue(router.accept(wrapped_stream))
        self.assertEqual(applied, [(1, prior), (1, wrapped_stream)])

    def test_router_rejects_older_seat_epoch_for_same_seat(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        newer_epoch = self.make_packet(seat_index=1, seat_epoch=3, stream_epoch=1, sequence=1)
        older_epoch = self.make_packet(seat_index=1, seat_epoch=2, stream_epoch=99, sequence=99)

        self.assertTrue(router.accept(newer_epoch))
        self.assertFalse(router.accept(older_epoch))
        self.assertEqual(applied, [(1, newer_epoch)])

    def test_router_accepts_seat_epoch_wraparound_and_resets_stream_sequence_tracking(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        prior = self.make_packet(seat_index=1, seat_epoch=65535, stream_epoch=65535, sequence=0xFFFFFFFF)
        wrapped_seat = self.make_packet(seat_index=1, seat_epoch=0, stream_epoch=0, sequence=0)

        self.assertTrue(router.accept(prior))
        self.assertTrue(router.accept(wrapped_seat))
        self.assertEqual(applied, [(1, prior), (1, wrapped_seat)])

    def test_router_resets_sequence_tracking_when_stream_epoch_advances(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        prior = self.make_packet(seat_index=1, stream_epoch=1, sequence=9)
        newer_stream = self.make_packet(seat_index=1, stream_epoch=2, sequence=1)

        self.assertTrue(router.accept(prior))
        self.assertTrue(router.accept(newer_stream))
        self.assertEqual(applied, [(1, prior), (1, newer_stream)])

    def test_router_resets_stream_and_sequence_tracking_when_seat_epoch_advances(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        prior = self.make_packet(seat_index=1, seat_epoch=1, stream_epoch=7, sequence=12)
        newer_seat = self.make_packet(seat_index=1, seat_epoch=2, stream_epoch=1, sequence=1)

        self.assertTrue(router.accept(prior))
        self.assertTrue(router.accept(newer_seat))
        self.assertEqual(applied, [(1, prior), (1, newer_seat)])

    def test_router_accepts_sequence_wraparound(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        prior = self.make_packet(seat_index=1, sequence=0xFFFFFFFF)
        wrapped_sequence = self.make_packet(seat_index=1, sequence=0)

        self.assertTrue(router.accept(prior))
        self.assertTrue(router.accept(wrapped_sequence))
        self.assertEqual(applied, [(1, prior), (1, wrapped_sequence)])

    def test_router_tracks_each_seat_independently(self) -> None:
        _, SeatInputRouter = _router_exports()
        applied = []
        router = SeatInputRouter(lambda *args: applied.append(args))

        seat_one = self.make_packet(seat_index=1, sequence=5)
        seat_two = self.make_packet(seat_index=2, sequence=1)

        self.assertTrue(router.accept(seat_one))
        self.assertTrue(router.accept(seat_two))
        self.assertEqual(applied, [(1, seat_one), (2, seat_two)])


if __name__ == "__main__":
    unittest.main()

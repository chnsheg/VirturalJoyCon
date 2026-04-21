import unittest


def _room_state_exports():
    try:
        from streaming.room_state import JoinResult, RoomMember, RoomRegistry
    except ModuleNotFoundError as exc:
        raise AssertionError("streaming.room_state exports are not implemented") from exc
    return RoomRegistry, JoinResult, RoomMember


class _Clock:
    def __init__(self, start: float) -> None:
        self.value = start

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class RoomStateTests(unittest.TestCase):
    def test_join_room_assigns_seats_then_spectator_role(self) -> None:
        RoomRegistry, JoinResult, RoomMember = _room_state_exports()
        clock = _Clock(100.0)
        registry = RoomRegistry(max_seats=4, now_fn=clock.now)

        results = [registry.join_room("alpha", f"player-{index}") for index in range(1, 6)]

        self.assertTrue(all(isinstance(result, JoinResult) for result in results))
        self.assertEqual([result.room_id for result in results], ["alpha"] * 5)
        self.assertEqual([result.player_id for result in results], [f"player-{index}" for index in range(1, 6)])
        self.assertEqual([result.role for result in results], ["player", "player", "player", "player", "spectator"])
        self.assertEqual([result.seat_index for result in results], [1, 2, 3, 4, None])
        self.assertEqual([result.seat_epoch for result in results], [1, 1, 1, 1, 0])
        self.assertTrue(all(result.reconnect_token for result in results))

        room = registry._rooms["alpha"]
        self.assertTrue(all(isinstance(member, RoomMember) for member in room.members.values()))

    def test_reconnect_room_restores_same_seat_with_higher_epoch(self) -> None:
        RoomRegistry, _, _ = _room_state_exports()
        clock = _Clock(100.0)
        registry = RoomRegistry(max_seats=4, seat_hold_seconds=10.0, now_fn=clock.now)

        joined = registry.join_room("alpha", "player-1")
        registry.mark_disconnected("alpha", "player-1")
        clock.advance(5.0)

        reconnected = registry.reconnect_room("alpha", "player-1", joined.reconnect_token)

        self.assertEqual(reconnected.room_id, "alpha")
        self.assertEqual(reconnected.player_id, "player-1")
        self.assertEqual(reconnected.role, "player")
        self.assertEqual(reconnected.seat_index, joined.seat_index)
        self.assertGreater(reconnected.seat_epoch, joined.seat_epoch)
        self.assertEqual(reconnected.reconnect_token, joined.reconnect_token)

    def test_reconnect_room_rejects_invalid_reconnect_token(self) -> None:
        RoomRegistry, _, _ = _room_state_exports()
        clock = _Clock(100.0)
        registry = RoomRegistry(max_seats=4, seat_hold_seconds=10.0, now_fn=clock.now)

        registry.join_room("alpha", "player-1")
        registry.mark_disconnected("alpha", "player-1")

        with self.assertRaisesRegex(ValueError, "bad_reconnect_token"):
            registry.reconnect_room("alpha", "player-1", "bad-token")

    def test_expire_reservations_promotes_oldest_spectator(self) -> None:
        RoomRegistry, _, _ = _room_state_exports()
        clock = _Clock(100.0)
        registry = RoomRegistry(max_seats=2, seat_hold_seconds=10.0, now_fn=clock.now)

        registry.join_room("alpha", "player-1")
        registry.join_room("alpha", "player-2")
        spectator = registry.join_room("alpha", "spectator-1")
        registry.mark_disconnected("alpha", "player-1")
        clock.advance(11.0)

        promotions = registry.expire_reservations("alpha")

        self.assertEqual(len(promotions), 1)
        promoted = promotions[0]
        self.assertEqual(promoted.player_id, spectator.player_id)
        self.assertEqual(promoted.role, "player")
        self.assertEqual(promoted.seat_index, 1)
        self.assertGreater(promoted.seat_epoch, spectator.seat_epoch)

    def test_expired_reservation_does_not_block_join_or_revive_stale_reconnect(self) -> None:
        RoomRegistry, _, _ = _room_state_exports()
        clock = _Clock(100.0)
        registry = RoomRegistry(max_seats=1, seat_hold_seconds=10.0, now_fn=clock.now)

        original = registry.join_room("alpha", "player-1")
        registry.mark_disconnected("alpha", "player-1")
        clock.advance(11.0)

        replacement = registry.join_room("alpha", "player-2")
        stale = registry.reconnect_room("alpha", "player-1", original.reconnect_token)

        self.assertEqual(replacement.role, "player")
        self.assertEqual(replacement.seat_index, 1)
        self.assertEqual(stale.role, "spectator")
        self.assertIsNone(stale.seat_index)
        self.assertEqual(stale.seat_epoch, 0)

    def test_disconnected_spectator_can_rejoin_and_be_promoted(self) -> None:
        RoomRegistry, _, _ = _room_state_exports()
        clock = _Clock(100.0)
        registry = RoomRegistry(max_seats=2, seat_hold_seconds=10.0, now_fn=clock.now)

        registry.join_room("alpha", "player-1")
        registry.join_room("alpha", "player-2")
        spectator = registry.join_room("alpha", "spectator-1")

        registry.mark_disconnected("alpha", "spectator-1")
        rejoined = registry.join_room("alpha", "spectator-1")

        self.assertEqual(rejoined.role, "spectator")
        self.assertIsNone(rejoined.seat_index)

        registry.mark_disconnected("alpha", "player-1")
        clock.advance(11.0)
        promotions = registry.expire_reservations("alpha")

        self.assertEqual(len(promotions), 1)
        promoted = promotions[0]
        self.assertEqual(promoted.player_id, spectator.player_id)
        self.assertEqual(promoted.role, "player")
        self.assertEqual(promoted.seat_index, 1)


if __name__ == "__main__":
    unittest.main()

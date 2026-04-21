import unittest


def _room_registry_class():
    try:
        from streaming.room_state import RoomRegistry
    except ModuleNotFoundError as exc:
        raise AssertionError("streaming.room_state.RoomRegistry is not implemented") from exc
    return RoomRegistry


class RoomStateTests(unittest.TestCase):
    def test_join_room_assigns_player_seats_before_spectators(self) -> None:
        RoomRegistry = _room_registry_class()

        registry = RoomRegistry(max_players=4)

        results = [
            registry.join_room("alpha", f"member-{index}", now=100.0)
            for index in range(1, 6)
        ]

        self.assertEqual([result.member.seat for result in results], [1, 2, 3, 4, None])
        self.assertEqual([result.member.is_spectator for result in results], [False, False, False, False, True])
        self.assertFalse(any(result.reconnected for result in results))

    def test_reconnect_room_restores_reserved_player_seat(self) -> None:
        RoomRegistry = _room_registry_class()

        registry = RoomRegistry(max_players=4, reservation_ttl=10.0)
        joined = registry.join_room("alpha", "phone-1", now=100.0)

        registry.mark_disconnected("alpha", "phone-1", now=105.0)
        reconnected = registry.reconnect_room("alpha", "phone-1", now=109.0)

        self.assertTrue(reconnected.reconnected)
        self.assertEqual(reconnected.member.member_id, "phone-1")
        self.assertEqual(reconnected.member.seat, joined.member.seat)
        self.assertGreater(reconnected.member.seat_epoch, joined.member.seat_epoch)
        self.assertFalse(reconnected.member.is_spectator)
        self.assertTrue(reconnected.member.connected)

    def test_expire_reservations_promotes_oldest_spectator_to_open_seat(self) -> None:
        RoomRegistry = _room_registry_class()

        registry = RoomRegistry(max_players=2, reservation_ttl=10.0)
        registry.join_room("alpha", "player-1", now=100.0)
        registry.join_room("alpha", "player-2", now=101.0)
        spectator = registry.join_room("alpha", "spectator-1", now=102.0)
        registry.mark_disconnected("alpha", "player-1", now=103.0)

        registry.expire_reservations(now=114.0)
        promoted = registry.reconnect_room("alpha", "spectator-1", now=115.0)

        self.assertTrue(spectator.member.is_spectator)
        self.assertEqual(promoted.member.seat, 1)
        self.assertFalse(promoted.member.is_spectator)
        self.assertTrue(promoted.member.connected)


if __name__ == "__main__":
    unittest.main()

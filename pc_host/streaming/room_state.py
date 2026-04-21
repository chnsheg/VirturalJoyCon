from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, replace
from typing import Callable, Dict, List, Optional


@dataclass(frozen=True)
class RoomMember:
    player_id: str
    role: str
    seat_index: Optional[int]
    seat_epoch: int
    reconnect_token: str
    connected: bool
    disconnect_deadline: Optional[float]
    joined_at: float


@dataclass(frozen=True)
class JoinResult:
    room_id: str
    player_id: str
    role: str
    seat_index: Optional[int]
    seat_epoch: int
    reconnect_token: str


@dataclass
class _Room:
    room_id: str
    members: Dict[str, RoomMember]


class RoomRegistry:
    def __init__(
        self,
        max_seats: int = 4,
        seat_hold_seconds: float = 10.0,
        now_fn: Callable[[], float] | None = None,
    ) -> None:
        self.max_seats = max_seats
        self.seat_hold_seconds = seat_hold_seconds
        self.now_fn = now_fn or time.monotonic
        self._rooms: Dict[str, _Room] = {}

    def join_room(self, room_id: str, player_id: str) -> JoinResult:
        room = self._room(room_id)
        self._delete_expired_player_reservations(room)

        current = room.members.get(player_id)
        if current is not None:
            if current.role == "player":
                raise ValueError("reconnect_required")
            if not current.connected:
                current = replace(current, connected=True, disconnect_deadline=None)
                room.members[player_id] = current
            return self._join_result(room_id, current)

        member = RoomMember(
            player_id=player_id,
            role="spectator",
            seat_index=None,
            seat_epoch=0,
            reconnect_token=self._new_reconnect_token(),
            connected=True,
            disconnect_deadline=None,
            joined_at=self.now_fn(),
        )

        seat_index = self._next_open_seat(room)
        if seat_index is not None:
            member = replace(member, role="player", seat_index=seat_index, seat_epoch=1)

        room.members[player_id] = member
        return self._join_result(room_id, member)

    def mark_disconnected(self, room_id: str, player_id: str) -> None:
        room = self._rooms.get(room_id)
        if room is None:
            return

        member = room.members.get(player_id)
        if member is None:
            return

        deadline = None
        if member.role == "player":
            deadline = self.now_fn() + self.seat_hold_seconds
        room.members[player_id] = replace(member, connected=False, disconnect_deadline=deadline)

    def reconnect_room(self, room_id: str, player_id: str, reconnect_token: str) -> JoinResult:
        room = self._room(room_id)
        self._delete_expired_player_reservations(room)

        member = room.members.get(player_id)
        if member is None:
            return self.join_room(room_id, player_id)

        if member.role == "player" and member.reconnect_token != reconnect_token:
            raise ValueError("bad_reconnect_token")

        if (
            member.role == "player"
            and not member.connected
        ):
            member = replace(
                member,
                connected=True,
                disconnect_deadline=None,
                seat_epoch=member.seat_epoch + 1,
            )
            room.members[player_id] = member
            return self._join_result(room_id, member)

        return self._join_result(room_id, member)

    def expire_reservations(self, room_id: str) -> List[JoinResult]:
        room = self._rooms.get(room_id)
        if room is None:
            return []
        return self._sweep_room(room)

    def _room(self, room_id: str) -> _Room:
        if room_id not in self._rooms:
            self._rooms[room_id] = _Room(room_id=room_id, members={})
        return self._rooms[room_id]

    def _sweep_room(self, room: _Room) -> List[JoinResult]:
        self._delete_expired_player_reservations(room)
        return self._promote_spectators(room)

    def _delete_expired_player_reservations(self, room: _Room) -> None:
        now = self.now_fn()
        expired_player_ids = [
            player_id
            for player_id, member in room.members.items()
            if member.role == "player"
            and not member.connected
            and member.disconnect_deadline is not None
            and member.disconnect_deadline <= now
        ]
        for player_id in expired_player_ids:
            del room.members[player_id]

    def _promote_spectators(self, room: _Room) -> List[JoinResult]:
        promotions: List[JoinResult] = []
        while True:
            seat_index = self._next_open_seat(room)
            if seat_index is None:
                return promotions

            spectator = self._oldest_connected_spectator(room)
            if spectator is None:
                return promotions

            promoted = replace(
                spectator,
                role="player",
                seat_index=seat_index,
                seat_epoch=spectator.seat_epoch + 1,
                disconnect_deadline=None,
            )
            room.members[promoted.player_id] = promoted
            promotions.append(self._join_result(room.room_id, promoted))

    def _next_open_seat(self, room: _Room) -> Optional[int]:
        occupied = {
            member.seat_index
            for member in room.members.values()
            if member.role == "player" and member.seat_index is not None
        }
        for seat_index in range(1, self.max_seats + 1):
            if seat_index not in occupied:
                return seat_index
        return None

    def _oldest_connected_spectator(self, room: _Room) -> Optional[RoomMember]:
        spectators = [
            member
            for member in room.members.values()
            if member.role == "spectator" and member.connected
        ]
        if not spectators:
            return None
        return min(spectators, key=lambda member: member.joined_at)

    def _join_result(self, room_id: str, member: RoomMember) -> JoinResult:
        return JoinResult(
            room_id=room_id,
            player_id=member.player_id,
            role=member.role,
            seat_index=member.seat_index,
            seat_epoch=member.seat_epoch,
            reconnect_token=member.reconnect_token,
        )

    def _new_reconnect_token(self) -> str:
        return secrets.token_urlsafe(16)

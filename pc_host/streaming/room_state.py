from __future__ import annotations

import time
from dataclasses import dataclass, replace
from typing import Dict, Optional


@dataclass(frozen=True)
class RoomMember:
    room_id: str
    member_id: str
    seat: Optional[int]
    seat_epoch: int
    connected: bool
    joined_at: float
    reservation_expires_at: Optional[float] = None

    @property
    def is_spectator(self) -> bool:
        return self.seat is None


@dataclass(frozen=True)
class JoinResult:
    member: RoomMember
    reconnected: bool = False


@dataclass
class _Room:
    room_id: str
    members: Dict[str, RoomMember]


class RoomRegistry:
    def __init__(self, max_players: int = 4, reservation_ttl: float = 30.0) -> None:
        self.max_players = max_players
        self.reservation_ttl = reservation_ttl
        self._rooms: Dict[str, _Room] = {}

    def join_room(self, room_id: str, member_id: str, now: Optional[float] = None) -> JoinResult:
        room = self._room(room_id)
        current = room.members.get(member_id)
        if current is not None:
            member = replace(current, connected=True, reservation_expires_at=None)
            room.members[member_id] = member
            return JoinResult(member=member, reconnected=not current.connected)

        member = RoomMember(
            room_id=room_id,
            member_id=member_id,
            seat=self._next_open_seat(room),
            seat_epoch=0,
            connected=True,
            joined_at=self._now(now),
        )
        if member.seat is not None:
            member = replace(member, seat_epoch=1)
        room.members[member_id] = member
        return JoinResult(member=member)

    def mark_disconnected(self, room_id: str, member_id: str, now: Optional[float] = None) -> Optional[RoomMember]:
        room = self._rooms.get(room_id)
        if room is None or member_id not in room.members:
            return None

        member = replace(
            room.members[member_id],
            connected=False,
            reservation_expires_at=self._now(now) + self.reservation_ttl,
        )
        room.members[member_id] = member
        return member

    def reconnect_room(self, room_id: str, member_id: str, now: Optional[float] = None) -> JoinResult:
        room = self._room(room_id)
        member = room.members.get(member_id)
        if member is None:
            return self.join_room(room_id, member_id, now=now)

        if member.reservation_expires_at is not None and member.reservation_expires_at <= self._now(now):
            del room.members[member_id]
            self._promote_spectators(room)
            return self.join_room(room_id, member_id, now=now)

        reconnected = replace(
            member,
            seat_epoch=member.seat_epoch + 1 if member.seat is not None else member.seat_epoch,
            connected=True,
            reservation_expires_at=None,
        )
        room.members[member_id] = reconnected
        return JoinResult(member=reconnected, reconnected=True)

    def expire_reservations(self, now: Optional[float] = None) -> None:
        cutoff = self._now(now)
        for room in self._rooms.values():
            expired_ids = [
                member_id
                for member_id, member in room.members.items()
                if not member.connected
                and member.reservation_expires_at is not None
                and member.reservation_expires_at <= cutoff
            ]
            for member_id in expired_ids:
                del room.members[member_id]
            self._promote_spectators(room)

    def _room(self, room_id: str) -> _Room:
        if room_id not in self._rooms:
            self._rooms[room_id] = _Room(room_id=room_id, members={})
        return self._rooms[room_id]

    def _next_open_seat(self, room: _Room) -> Optional[int]:
        occupied = {member.seat for member in room.members.values() if member.seat is not None}
        for seat in range(1, self.max_players + 1):
            if seat not in occupied:
                return seat
        return None

    def _promote_spectators(self, room: _Room) -> None:
        while True:
            seat = self._next_open_seat(room)
            if seat is None:
                return

            spectators = sorted(
                (member for member in room.members.values() if member.connected and member.is_spectator),
                key=lambda member: member.joined_at,
            )
            if not spectators:
                return

            spectator = spectators[0]
            room.members[spectator.member_id] = replace(
                spectator,
                seat=seat,
                seat_epoch=spectator.seat_epoch + 1,
            )

    def _now(self, now: Optional[float]) -> float:
        if now is None:
            return time.monotonic()
        return now

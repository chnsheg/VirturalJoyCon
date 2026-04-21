import test from "node:test";
import assert from "node:assert/strict";

import {
  STREAM_ROOM_ID,
  buildRoomApiUrls,
  createInitialStreamState,
  createRoomSessionClient,
  reduceJoinResponse,
  roomStatusText,
} from "../stream-session.mjs";

test("reduceJoinResponse maps a player seat into stream state", () => {
  assert.deepEqual(
    reduceJoinResponse({
      room_id: "living-room",
      player_id: "alice",
      role: "player",
      seat_index: 2,
      seat_epoch: 1,
      reconnect_token: "token",
    }),
    {
      roomId: "living-room",
      playerId: "alice",
      role: "player",
      seatIndex: 2,
      seatEpoch: 1,
      reconnectToken: "token",
      degraded: false,
      lastError: "",
    },
  );
});

test("roomStatusText labels spectators and degraded players with ASCII text", () => {
  assert.equal(roomStatusText({ role: "spectator", seatIndex: null, degraded: false }), "spectating");
  assert.equal(roomStatusText({ role: "player", seatIndex: 3, degraded: true }), "3P degraded");
});

test("buildRoomApiUrls derives room endpoints from the host target", () => {
  assert.deepEqual(buildRoomApiUrls("192.168.0.10:8082"), {
    joinUrl: "http://192.168.0.10:8082/api/room/join",
    statusUrl: "http://192.168.0.10:8082/api/room/status",
    controlOfferUrl: "http://192.168.0.10:8082/api/control/offer",
  });
});

test("createRoomSessionClient joins with the default room id and reduces the response", async () => {
  const fetchCalls = [];
  const client = createRoomSessionClient({
    hostTarget: "192.168.0.10:8082",
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            room_id: STREAM_ROOM_ID,
            player_id: "player-1",
            role: "player",
            seat_index: 1,
            seat_epoch: 4,
            reconnect_token: "token-1",
          };
        },
      };
    },
  });

  const joined = await client.join({ playerId: "player-1" });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://192.168.0.10:8082/api/room/join");
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    room_id: STREAM_ROOM_ID,
    player_id: "player-1",
  });
  assert.deepEqual(joined, {
    ...createInitialStreamState(),
    roomId: STREAM_ROOM_ID,
    playerId: "player-1",
    role: "player",
    seatIndex: 1,
    seatEpoch: 4,
    reconnectToken: "token-1",
  });
});

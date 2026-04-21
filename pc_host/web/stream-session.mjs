export const STREAM_ROOM_ID = "living-room";

function normalizeHostTarget(hostTarget) {
  return String(hostTarget ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

async function readJsonResponse(response) {
  if (!response?.ok) {
    throw new Error(`http_${response?.status ?? "error"}`);
  }
  return response.json();
}

export function createInitialStreamState() {
  return {
    roomId: "",
    playerId: "",
    role: "",
    seatIndex: null,
    seatEpoch: 0,
    reconnectToken: "",
    degraded: false,
    lastError: "",
  };
}

export function reduceJoinResponse(payload) {
  return {
    ...createInitialStreamState(),
    roomId: payload?.room_id ?? "",
    playerId: payload?.player_id ?? "",
    role: payload?.role ?? "",
    seatIndex: payload?.seat_index ?? null,
    seatEpoch: payload?.seat_epoch ?? 0,
    reconnectToken: payload?.reconnect_token ?? "",
  };
}

export function roomStatusText({ role, seatIndex, degraded, lastError } = {}) {
  if (lastError) {
    return lastError;
  }

  if (role === "spectator") {
    return "spectating";
  }

  if (role === "player" && Number.isInteger(seatIndex)) {
    return degraded ? `${seatIndex}P degraded` : `${seatIndex}P`;
  }

  return "not connected";
}

export function buildRoomApiUrls(hostTarget) {
  const target = normalizeHostTarget(hostTarget);
  return {
    joinUrl: `http://${target}/api/room/join`,
    statusUrl: `http://${target}/api/room/status`,
    controlOfferUrl: `http://${target}/api/control/offer`,
  };
}

export function createRoomSessionClient({
  hostTarget,
  roomId = STREAM_ROOM_ID,
  fetchImpl = fetch,
} = {}) {
  const urls = buildRoomApiUrls(hostTarget);

  return {
    urls,
    async join({ playerId }) {
      const payload = await readJsonResponse(
        await fetchImpl(urls.joinUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room_id: roomId,
            player_id: playerId,
          }),
        }),
      );

      return reduceJoinResponse(payload);
    },
    async status() {
      return readJsonResponse(await fetchImpl(`${urls.statusUrl}?room_id=${encodeURIComponent(roomId)}`));
    },
  };
}

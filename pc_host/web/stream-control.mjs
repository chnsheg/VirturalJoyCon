import { buildRoomApiUrls } from "./stream-session.mjs";

export const INPUT_CHANNEL_LABEL = "joycon.input.v1";
export const CONTROL_CHANNEL_LABEL = "joycon.control.v1";

async function readJsonResponse(response) {
  if (!response?.ok) {
    throw new Error(`http_${response?.status ?? "error"}`);
  }
  return response.json();
}

async function waitForIceGatheringComplete(peer) {
  if (!peer || peer.iceGatheringState === "complete" || typeof peer.addEventListener !== "function") {
    return;
  }

  await new Promise((resolve) => {
    const handleIceGatheringStateChange = () => {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener?.("icegatheringstatechange", handleIceGatheringStateChange);
        resolve();
      }
    };

    peer.addEventListener("icegatheringstatechange", handleIceGatheringStateChange);
  });
}

export function createInputChannelOptions() {
  return {
    ordered: false,
    maxRetransmits: 0,
  };
}

export function createControlChannelOptions() {
  return {
    ordered: true,
  };
}

export function shouldDropPendingAnalogState(channel) {
  return Number(channel?.bufferedAmount ?? 0) >= 2048;
}

export function createControlOfferPayload({
  roomId,
  playerId,
  reconnectToken,
  description,
}) {
  return {
    room_id: roomId,
    player_id: playerId,
    reconnect_token: reconnectToken,
    type: description?.type ?? "offer",
    sdp: description?.sdp ?? "",
  };
}

export function getControlHudText(mode) {
  if (mode === "webrtc") {
    return "control: webrtc";
  }
  if (mode === "ws") {
    return "control: websocket degraded";
  }
  if (mode === "http") {
    return "control: http degraded";
  }
  return "control: idle";
}

export function computeControlMode({ hasDataChannel, hasWebSocketFallback }) {
  if (hasDataChannel) {
    return { label: "webrtc", degraded: false };
  }

  if (hasWebSocketFallback) {
    return { label: "ws", degraded: true };
  }

  return { label: "idle", degraded: true };
}

export async function negotiateControlPeer({
  hostTarget,
  roomId,
  playerId,
  reconnectToken,
  fetchImpl = fetch,
  peerFactory = () => new globalThis.RTCPeerConnection(),
}) {
  const peer = peerFactory();
  const channel = peer.createDataChannel(CONTROL_CHANNEL_LABEL, createControlChannelOptions());
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForIceGatheringComplete(peer);
  const description = peer.localDescription ?? offer;

  const urls = buildRoomApiUrls(hostTarget);
  const answer = await readJsonResponse(
    await fetchImpl(urls.controlOfferUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        createControlOfferPayload({
          roomId,
          playerId,
          reconnectToken,
          description,
        }),
      ),
    }),
  );

  await peer.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
  return { peer, channel };
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_CHANNEL_LABEL,
  INPUT_CHANNEL_LABEL,
  createControlChannelOptions,
  createControlOfferPayload,
  createInputChannelOptions,
  computeControlMode,
  createTransportHysteresis,
  getControlHudText,
  negotiateControlPeer,
  shouldDropPendingAnalogState,
} from "../stream-control.mjs";

test("input channel options prefer unordered unreliable delivery", () => {
  assert.deepEqual(createInputChannelOptions(), {
    ordered: false,
    maxRetransmits: 0,
  });
});

test("control channel options stay ordered and reliable for the current backend", () => {
  assert.deepEqual(createControlChannelOptions(), {
    ordered: true,
  });
});

test("analog state drops old packets when the buffer is backed up", () => {
  assert.equal(shouldDropPendingAnalogState({ bufferedAmount: 0 }), false);
  assert.equal(shouldDropPendingAnalogState({ bufferedAmount: 2048 }), true);
});

test("createControlOfferPayload maps browser state into the backend json contract", () => {
  assert.deepEqual(
    createControlOfferPayload({
      roomId: "living-room",
      playerId: "player-1",
      reconnectToken: "token-1",
      description: { type: "offer", sdp: "v=0" },
    }),
    {
      room_id: "living-room",
      player_id: "player-1",
      reconnect_token: "token-1",
      type: "offer",
      sdp: "v=0",
    },
  );
});

test("negotiateControlPeer uses the supported control channel contract", async () => {
  const fetchCalls = [];
  const peer = {
    localDescription: null,
    remoteDescription: null,
    channels: [],
    iceGatheringState: "new",
    createDataChannel(label, options) {
      const channel = { label, options };
      this.channels.push(channel);
      return channel;
    },
    async createOffer() {
      return { type: "offer", sdp: "control-offer" };
    },
    async setLocalDescription(description) {
      this.localDescription = {
        type: description.type,
        sdp: "control-offer-with-ice",
      };
      this.iceGatheringState = "complete";
    },
    async setRemoteDescription(description) {
      this.remoteDescription = description;
    },
  };

  const result = await negotiateControlPeer({
    hostTarget: "192.168.0.10:8082",
    roomId: "living-room",
    playerId: "player-1",
    reconnectToken: "token-1",
    peerFactory: () => peer,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            type: "answer",
            sdp: "control-answer",
          };
        },
      };
    },
  });

  assert.equal(result.peer, peer);
  assert.equal(result.controlChannel.label, CONTROL_CHANNEL_LABEL);
  assert.deepEqual(result.controlChannel.options, { ordered: true });
  assert.equal(result.inputChannel.label, INPUT_CHANNEL_LABEL);
  assert.deepEqual(result.inputChannel.options, { ordered: false, maxRetransmits: 0 });
  assert.deepEqual(
    peer.channels.map((channel) => ({
      label: channel.label,
      options: channel.options,
    })),
    [
      { label: CONTROL_CHANNEL_LABEL, options: { ordered: true } },
      { label: INPUT_CHANNEL_LABEL, options: { ordered: false, maxRetransmits: 0 } },
    ],
  );
  assert.equal(fetchCalls[0].url, "http://192.168.0.10:8082/api/control/offer");
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    room_id: "living-room",
    player_id: "player-1",
    reconnect_token: "token-1",
    type: "offer",
    sdp: "control-offer-with-ice",
  });
  assert.deepEqual(peer.remoteDescription, { type: "answer", sdp: "control-answer" });
});

test("getControlHudText marks tcp fallback modes as degraded", () => {
  assert.equal(getControlHudText("idle"), "control: idle");
  assert.equal(getControlHudText("ws"), "control: websocket degraded");
  assert.equal(getControlHudText("http"), "control: http degraded");
  assert.equal(getControlHudText("webrtc"), "control: webrtc");
});

test("computeControlMode prefers datachannel and marks fallbacks degraded", () => {
  assert.deepEqual(
    computeControlMode({ hasDataChannel: true, hasWebSocketFallback: true, hasHttpFallback: true }),
    { label: "webrtc", degraded: false },
  );
  assert.deepEqual(
    computeControlMode({ hasDataChannel: false, hasWebSocketFallback: true, hasHttpFallback: true }),
    { label: "ws", degraded: true },
  );
  assert.deepEqual(
    computeControlMode({ hasDataChannel: false, hasWebSocketFallback: false, hasHttpFallback: true }),
    { label: "http", degraded: true },
  );
  assert.deepEqual(
    computeControlMode({ hasDataChannel: false, hasWebSocketFallback: false, hasHttpFallback: false }),
    { label: "idle", degraded: true },
  );
});

test("transport hysteresis delays visible degrade from webrtc to websocket fallback", () => {
  const hysteresis = createTransportHysteresis({
    initialMode: "webrtc",
    degradeAfterMs: 500,
    recoverAfterMs: 300,
  });

  assert.equal(hysteresis.update({ mode: "webrtc", nowMs: 0 }), "webrtc");
  assert.equal(hysteresis.update({ mode: "ws", nowMs: 100 }), "webrtc");
  assert.equal(hysteresis.update({ mode: "ws", nowMs: 599 }), "webrtc");
  assert.equal(hysteresis.update({ mode: "ws", nowMs: 600 }), "ws");
});

test("transport hysteresis delays visible recovery from websocket fallback to webrtc", () => {
  const hysteresis = createTransportHysteresis({
    initialMode: "ws",
    degradeAfterMs: 500,
    recoverAfterMs: 300,
  });

  assert.equal(hysteresis.update({ mode: "ws", nowMs: 0 }), "ws");
  assert.equal(hysteresis.update({ mode: "webrtc", nowMs: 100 }), "ws");
  assert.equal(hysteresis.update({ mode: "webrtc", nowMs: 399 }), "ws");
  assert.equal(hysteresis.update({ mode: "webrtc", nowMs: 400 }), "webrtc");
});

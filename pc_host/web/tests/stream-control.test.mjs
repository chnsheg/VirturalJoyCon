import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_CHANNEL_LABEL,
  createControlChannelOptions,
  createControlOfferPayload,
  createInputChannelOptions,
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
  assert.equal(result.channel.label, CONTROL_CHANNEL_LABEL);
  assert.deepEqual(result.channel.options, { ordered: true });
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

import test from "node:test";
import assert from "node:assert/strict";

import { attachRemoteStream, buildWhepUrl, subscribeViaWhep } from "../stream-media.mjs";

test("buildWhepUrl derives the media server WHEP endpoint from the host target", () => {
  assert.equal(buildWhepUrl("192.168.0.10:8082"), "http://192.168.0.10:8889/game/whep");
});

test("attachRemoteStream assigns the stream and attempts playback", async () => {
  const calls = [];
  const videoEl = {
    srcObject: null,
    async play() {
      calls.push("play");
    },
  };
  const stream = { id: "remote-stream" };

  await attachRemoteStream(videoEl, stream);

  assert.equal(videoEl.srcObject, stream);
  assert.deepEqual(calls, ["play"]);
});

test("subscribeViaWhep posts an SDP offer and attaches remote tracks", async () => {
  const fetchCalls = [];
  let trackHandler = null;
  const peer = {
    localDescription: null,
    remoteDescription: null,
    transceivers: [],
    iceGatheringState: "new",
    addTransceiver(kind, options) {
      this.transceivers.push({ kind, options });
    },
    set ontrack(handler) {
      trackHandler = handler;
    },
    async createOffer() {
      return { type: "offer", sdp: "media-offer" };
    },
    async setLocalDescription(description) {
      this.localDescription = {
        type: description.type,
        sdp: "media-offer-with-ice",
      };
      this.iceGatheringState = "complete";
    },
    async setRemoteDescription(description) {
      this.remoteDescription = description;
    },
  };
  const videoEl = {
    srcObject: null,
    async play() {},
  };

  const connectedPeer = await subscribeViaWhep({
    hostTarget: "192.168.0.10:8082",
    videoEl,
    peerFactory: () => peer,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        async text() {
          return "media-answer";
        },
      };
    },
  });

  assert.equal(connectedPeer, peer);
  assert.deepEqual(peer.transceivers, [
    { kind: "video", options: { direction: "recvonly" } },
    { kind: "audio", options: { direction: "recvonly" } },
  ]);
  assert.equal(fetchCalls[0].url, "http://192.168.0.10:8889/game/whep");
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.equal(fetchCalls[0].init.body, "media-offer-with-ice");
  assert.deepEqual(peer.remoteDescription, { type: "answer", sdp: "media-answer" });

  const stream = { id: "remote-stream" };
  await trackHandler({ streams: [stream] });
  assert.equal(videoEl.srcObject, stream);
});

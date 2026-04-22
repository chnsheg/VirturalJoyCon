import test from "node:test";
import assert from "node:assert/strict";

import {
  attachRemoteStream,
  buildWhepUrl,
  computeContainRect,
  computeCoverRect,
  createStreamCanvasRenderer,
  subscribeViaWhep,
} from "../stream-media.mjs";

test("buildWhepUrl derives the media server WHEP endpoint from the host target", () => {
  assert.equal(buildWhepUrl("192.168.0.10:8082"), "http://192.168.0.10:8082/media/whep");
});

test("computeContainRect preserves the full frame inside a portrait viewport", () => {
  assert.deepEqual(
    computeContainRect({
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 720,
      targetHeight: 1280,
    }),
    {
      x: 0,
      y: 437.5,
      width: 720,
      height: 405,
    },
  );
});

test("computeCoverRect can fill the immersive backdrop without affecting the foreground fit", () => {
  assert.deepEqual(
    computeCoverRect({
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 720,
      targetHeight: 1280,
    }),
    {
      x: -777.7777777777778,
      y: 0,
      width: 2275.5555555555557,
      height: 1280,
    },
  );
});

test("attachRemoteStream assigns the stream and attempts playback", async () => {
  const calls = [];
  const videoEl = {
    srcObject: null,
    playsInline: false,
    autoplay: false,
    muted: false,
    disablePictureInPicture: false,
    async play() {
      calls.push("play");
    },
  };
  const stream = { id: "remote-stream" };

  await attachRemoteStream(videoEl, stream);

  assert.equal(videoEl.srcObject, stream);
  assert.deepEqual(calls, ["play"]);
  assert.equal(videoEl.playsInline, true);
  assert.equal(videoEl.autoplay, true);
  assert.equal(videoEl.muted, true);
  assert.equal(videoEl.disablePictureInPicture, true);
});

test("createStreamCanvasRenderer syncs canvas drawing to decoded video frames when supported", () => {
  const scheduledVideoCallbacks = [];
  const cancelledVideoHandles = [];
  const fallbackAnimationFrames = [];
  const drawCalls = [];
  const videoEl = {
    videoWidth: 1920,
    videoHeight: 1080,
    requestVideoFrameCallback(callback) {
      scheduledVideoCallbacks.push(callback);
      return scheduledVideoCallbacks.length;
    },
    cancelVideoFrameCallback(handle) {
      cancelledVideoHandles.push(handle);
    },
  };
  const canvasFactory = () => ({
    clientWidth: 1280,
    clientHeight: 720,
    width: 0,
    height: 0,
    getContext() {
      return {
        clearRect() {},
        setTransform() {},
        drawImage(...args) {
          drawCalls.push(args);
        },
      };
    },
  });

  const renderer = createStreamCanvasRenderer({
    videoEl,
    canvasEl: canvasFactory(),
    backdropCanvasEl: canvasFactory(),
    requestAnimationFrameImpl(callback) {
      fallbackAnimationFrames.push(callback);
      return fallbackAnimationFrames.length;
    },
  });

  renderer.start();

  assert.equal(scheduledVideoCallbacks.length, 1);
  assert.equal(fallbackAnimationFrames.length, 0);

  scheduledVideoCallbacks[0](0, { width: 1920, height: 1080 });

  assert.ok(drawCalls.length >= 2, "expected both foreground and backdrop canvases to draw");
  assert.equal(scheduledVideoCallbacks.length, 2);

  renderer.stop();

  assert.deepEqual(cancelledVideoHandles, [2]);
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
  ]);
  assert.equal(fetchCalls[0].url, "http://192.168.0.10:8082/media/whep");
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.equal(fetchCalls[0].init.body, "media-offer-with-ice");
  assert.deepEqual(peer.remoteDescription, { type: "answer", sdp: "media-answer" });

  const stream = { id: "remote-stream" };
  await trackHandler({ streams: [stream] });
  assert.equal(videoEl.srcObject, stream);
});

test("subscribeViaWhep attaches track-only events by creating a fallback MediaStream", async () => {
  const createdStreams = [];
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
  const videoTrack = { id: "video-track" };

  await subscribeViaWhep({
    hostTarget: "192.168.0.10:8082",
    videoEl,
    peerFactory: () => peer,
    mediaStreamFactory: () => {
      const stream = {
        tracks: [],
        addTrack(track) {
          this.tracks.push(track);
        },
      };
      createdStreams.push(stream);
      return stream;
    },
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return "media-answer";
      },
    }),
  });

  await trackHandler({ streams: [], track: videoTrack });

  assert.equal(createdStreams.length, 1);
  assert.equal(videoEl.srcObject, createdStreams[0]);
  assert.deepEqual(createdStreams[0].tracks, [videoTrack]);
});

test("subscribeViaWhep requests zero playout delay on supported video receivers", async () => {
  const receiver = {
    track: { kind: "video" },
    playoutDelayHint: 0.45,
    jitterBufferTarget: 0.12,
  };
  const peer = {
    localDescription: null,
    remoteDescription: null,
    iceGatheringState: "new",
    addTransceiver() {},
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
    getReceivers() {
      return [receiver];
    },
  };

  await subscribeViaWhep({
    hostTarget: "192.168.0.10:8082",
    videoEl: {
      srcObject: null,
      async play() {},
    },
    peerFactory: () => peer,
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return "media-answer";
      },
    }),
  });

  assert.equal(receiver.playoutDelayHint, 0);
  assert.equal(receiver.jitterBufferTarget, 0);
});

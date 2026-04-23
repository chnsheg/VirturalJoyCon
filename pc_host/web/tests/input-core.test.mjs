import test from "node:test";
import assert from "node:assert/strict";

import {
  AdaptiveStickProcessor,
  LayoutGestureLease,
  LatencyTracker,
  LayoutInteractionLock,
  LatestStateTransmitter,
  applyRadialResponse,
  createStickFrame,
  vectorFromFrame,
} from "../input-core.mjs";

test("applyRadialResponse removes inner deadzone and preserves direction", () => {
  assert.deepEqual(
    applyRadialResponse({ x: 0, y: 0.03 }, { deadzone: 0.08, antiDeadzone: 0.04, responseExponent: 1.6 }),
    { x: 0, y: 0 },
  );

  const result = applyRadialResponse(
    { x: 0, y: 0.75 },
    { deadzone: 0.08, antiDeadzone: 0.04, responseExponent: 1.6 },
  );

  assert.equal(result.x, 0);
  assert.ok(result.y > 0.5);
  assert.ok(result.y < 1);
});

test("AdaptiveStickProcessor keeps upward motion upward under jitter", () => {
  const processor = new AdaptiveStickProcessor({
    deadzone: 0.08,
    antiDeadzone: 0.05,
    responseExponent: 1.55,
    minCutoff: 1.2,
    beta: 0.35,
    derivativeCutoff: 1.0,
  });

  const outputs = [
    processor.sampleVector({ x: 0.01, y: 0.92, now: 0 }),
    processor.sampleVector({ x: -0.02, y: 0.95, now: 8 }),
    processor.sampleVector({ x: 0.015, y: 0.9, now: 16 }),
  ];

  for (const output of outputs) {
    assert.ok(output.state.y > 0.7);
    assert.ok(Math.abs(output.state.x) < 0.08);
  }
});

test("AdaptiveStickProcessor reacts to a quick menu flick after a centered touch", () => {
  const processor = new AdaptiveStickProcessor({
    deadzone: 0.08,
    antiDeadzone: 0.05,
    outerDeadzone: 0.02,
    responseExponent: 1.35,
    minCutoff: 1.2,
    beta: 0.35,
    derivativeCutoff: 1.0,
  });

  processor.sampleVector({ x: 0, y: 0, now: 0 });
  const output = processor.sampleVector({ x: 0, y: 0.32, now: 12 });

  assert.ok(output.state.y > 0.16);
  assert.equal(output.state.x, 0);
});

test("AdaptiveStickProcessor uses filtered vectors for final state instead of the raw spike", () => {
  const processor = new AdaptiveStickProcessor({
    deadzone: 0.13,
    outerDeadzone: 0.02,
    responseExponent: 1.45,
    minCutoff: 1.2,
    beta: 0.35,
    derivativeCutoff: 1.0,
  });

  processor.sampleVector({ x: 0, y: 0, now: 0 });
  const output = processor.sampleVector({ x: 0.92, y: 0, now: 8 });
  const rawState = applyRadialResponse(
    { x: 0.92, y: 0 },
    { deadzone: 0.13, outerDeadzone: 0.02, responseExponent: 1.45 },
  );

  assert.ok(output.filtered.x < output.raw.x);
  assert.ok(output.state.x < rawState.x);
  assert.equal(output.state.y, 0);
});

test("AdaptiveStickProcessor clears actuation quickly when the thumb flicks back to center", () => {
  const processor = new AdaptiveStickProcessor({
    deadzone: 0.13,
    outerDeadzone: 0.02,
    responseExponent: 1.45,
    engageThreshold: 0.58,
    releaseThreshold: 0.35,
    repeatDelayMs: 240,
    repeatIntervalMs: 100,
    axisSwitchRatio: 1.25,
  });

  processor.sampleVector({ x: 0, y: 0, now: 0 });
  const engaged = processor.sampleVector({ x: 0, y: 0.94, now: 16 });
  const released = processor.sampleVector({ x: 0, y: 0.04, now: 80 });

  assert.equal(engaged.navigation?.direction, "up");
  assert.equal(engaged.navigation?.justPressed, true);
  assert.equal(engaged.navigation?.repeatReady, false);
  assert.equal(released.navigation?.engaged, false);
  assert.equal(released.state.x, 0);
  assert.equal(released.state.y, 0);
});

test("AdaptiveStickProcessor keeps the previous dominant axis through small diagonal jitter", () => {
  const processor = new AdaptiveStickProcessor({
    deadzone: 0.13,
    outerDeadzone: 0.02,
    responseExponent: 1.45,
    engageThreshold: 0.58,
    releaseThreshold: 0.35,
    axisSwitchRatio: 1.25,
  });

  processor.sampleVector({ x: 0, y: 0, now: 0 });
  const first = processor.sampleVector({ x: 0.16, y: 0.88, now: 16 });
  const second = processor.sampleVector({ x: 0.29, y: 0.8, now: 48 });

  assert.equal(first.navigation?.direction, "up");
  assert.equal(second.navigation?.direction, "up");
  assert.ok(Math.abs(second.state.x) < Math.abs(second.state.y));
});

test("AdaptiveStickProcessor recenters immediately after a sustained drag returns to center", () => {
  const processor = new AdaptiveStickProcessor({
    deadzone: 0.08,
    antiDeadzone: 0.05,
    outerDeadzone: 0.02,
    responseExponent: 1.35,
    minCutoff: 1.2,
    beta: 0.35,
    derivativeCutoff: 1.0,
  });

  processor.sampleVector({ x: 0, y: 0, now: 0 });
  processor.sampleVector({ x: 0, y: 0.7, now: 16 });
  processor.sampleVector({ x: 0, y: 0.7, now: 32 });
  const output = processor.sampleVector({ x: 0, y: 0, now: 48 });

  assert.equal(output.state.y, 0);
  assert.equal(output.state.x, 0);
  assert.equal(output.display.y, 0);
});

test("higher stick sensitivity boosts small input and keeps full deflection capped", () => {
  const softExponent = 1.85;
  const quickExponent = 1.15;
  const soft = applyRadialResponse(
    { x: 0, y: 0.42 },
    { deadzone: 0.08, antiDeadzone: 0.05, outerDeadzone: 0.02, responseExponent: softExponent },
  );
  const quick = applyRadialResponse(
    { x: 0, y: 0.42 },
    { deadzone: 0.08, antiDeadzone: 0.05, outerDeadzone: 0.02, responseExponent: quickExponent },
  );

  assert.ok(quick.y > soft.y);
  assert.equal(
    applyRadialResponse({ x: 0, y: 1 }, { responseExponent: softExponent }).y,
    1,
  );
  assert.equal(
    applyRadialResponse({ x: 0, y: 1 }, { responseExponent: quickExponent }).y,
    1,
  );

  const processor = new AdaptiveStickProcessor({
    deadzone: 0.08,
    antiDeadzone: 0.05,
    outerDeadzone: 0.02,
    responseExponent: softExponent,
    minCutoff: 1.2,
    beta: 0.35,
    derivativeCutoff: 1.0,
  });
  processor.setResponseExponent(quickExponent);
  const output = processor.sampleVector({ x: 0, y: 0.42, now: 0 });
  assert.equal(output.state.y, quick.y);
});

test("LatestStateTransmitter only sends dirty newest state and respects websocket backpressure", () => {
  const sent = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  const state = {
    device_id: "phone-a",
    client_session_id: "client-a",
    input_stream_id: "stream-a",
    buttons: { a: false },
    sticks: { left: { nx: 0, ny: 0 }, right: { nx: 0, ny: 0 } },
    triggers: { lt: 0, rt: 0 },
  };

  const transmitter = new LatestStateTransmitter({
    getSocket: () => socket,
    readState: () => state,
    heartbeatMs: 250,
    minIntervalMs: 8,
    maxBufferedAmount: 64,
  });

  transmitter.markDirty();
  assert.equal(transmitter.tryFlush(0), "ws");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].seq, 1);

  socket.bufferedAmount = 128;
  state.sticks.left.ny = 1;
  transmitter.markDirty();
  assert.equal(transmitter.tryFlush(8), false);
  assert.equal(sent.length, 1);

  socket.bufferedAmount = 0;
  assert.equal(transmitter.tryFlush(16), "ws");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].seq, 2);
  assert.equal(sent[1].sticks.left.ny, 1);
});

test("LatestStateTransmitter prefers the rtc input datachannel when it is open", () => {
  const sent = [];
  const dataChannel = {
    readyState: "open",
    bufferedAmount: 0,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  const transmitter = new LatestStateTransmitter({
    getDataChannel: () => dataChannel,
    getSocket: () => null,
    readState: () => ({
      device_id: "phone-a",
      client_session_id: "client-a",
      input_stream_id: "stream-a",
      buttons: { a: true },
      sticks: { left: { nx: 0, ny: 0 }, right: { nx: 0, ny: 0 } },
      triggers: { lt: 0, rt: 0 },
    }),
  });

  transmitter.markDirty(true);
  assert.equal(transmitter.tryFlush(0), "datachannel");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].buttons.a, true);
});

test("LatestStateTransmitter keeps websocket fallback latest-state semantics when rtc is unavailable", () => {
  const sent = [];
  const dataChannel = {
    readyState: "closed",
    bufferedAmount: 0,
    send() {
      throw new Error("closed datachannel should not receive fallback packets");
    },
  };
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const state = {
    device_id: "phone-a",
    client_session_id: "client-a",
    input_stream_id: "stream-a",
    buttons: { a: false },
    sticks: { left: { nx: 0, ny: 0 }, right: { nx: 0, ny: 0 } },
    triggers: { lt: 0, rt: 0 },
  };

  const transmitter = new LatestStateTransmitter({
    getDataChannel: () => dataChannel,
    getSocket: () => socket,
    readState: () => state,
    heartbeatMs: 250,
    minIntervalMs: 8,
    maxBufferedAmount: 64,
  });

  socket.bufferedAmount = 128;
  state.sticks.right.nx = 0.25;
  transmitter.markDirty();
  assert.equal(transmitter.tryFlush(0), false);

  state.sticks.right.nx = 0.75;
  socket.bufferedAmount = 0;
  assert.equal(transmitter.tryFlush(8), "ws");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].seq, 1);
  assert.equal(sent[0].sticks.right.nx, 0.75);
});

test("LatestStateTransmitter honors a preferred rtc transport and avoids immediate websocket fallback during brief rtc blips", () => {
  const wsSent = [];
  const dataChannel = {
    readyState: "closing",
    bufferedAmount: 0,
    send() {
      throw new Error("closing datachannel should not send");
    },
  };
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload) {
      wsSent.push(JSON.parse(payload));
    },
  };

  const transmitter = new LatestStateTransmitter({
    getDataChannel: () => dataChannel,
    getSocket: () => socket,
    getPreferredTransport: () => "datachannel",
    readState: () => ({
      device_id: "phone-a",
      client_session_id: "client-a",
      input_stream_id: "stream-a",
      buttons: { a: true },
      sticks: { left: { nx: 0, ny: 0 }, right: { nx: 0, ny: 0 } },
      triggers: { lt: 0, rt: 0 },
    }),
  });

  transmitter.markDirty(true);

  assert.equal(transmitter.tryFlush(0), false);
  assert.equal(wsSent.length, 0);
});

test("LatestStateTransmitter can stay on websocket during rtc recovery hysteresis even after rtc reopens", () => {
  const rtcSent = [];
  const wsSent = [];
  const dataChannel = {
    readyState: "open",
    bufferedAmount: 0,
    send(payload) {
      rtcSent.push(JSON.parse(payload));
    },
  };
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload) {
      wsSent.push(JSON.parse(payload));
    },
  };

  const transmitter = new LatestStateTransmitter({
    getDataChannel: () => dataChannel,
    getSocket: () => socket,
    getPreferredTransport: () => "ws",
    readState: () => ({
      device_id: "phone-a",
      client_session_id: "client-a",
      input_stream_id: "stream-a",
      buttons: { a: false },
      sticks: { left: { nx: 0.25, ny: 0 }, right: { nx: 0, ny: 0 } },
      triggers: { lt: 0, rt: 0 },
    }),
  });

  transmitter.markDirty(true);

  assert.equal(transmitter.tryFlush(0), "ws");
  assert.equal(wsSent.length, 1);
  assert.equal(rtcSent.length, 0);
});

test("LatencyTracker smooths ping samples and expires stale values", () => {
  const tracker = new LatencyTracker({ maxSamples: 5, staleAfterMs: 2500 });

  const ping1 = tracker.noteRoundTrip(34, 1000);
  const ping2 = tracker.noteRoundTrip(42, 1500);
  const ping3 = tracker.noteRoundTrip(38, 1900);

  assert.equal(ping1, 34);
  assert.equal(ping2, 38);
  assert.equal(ping3, 38);
  assert.equal(tracker.getDisplayValue(2200), "38 ms");
  assert.equal(tracker.getDisplayValue(5000), "--");
});

test("createStickFrame keeps stick direction stable even if layout shifts mid-drag", () => {
  const frame = createStickFrame({ left: 100, top: 200, width: 160, height: 160 }, 54);
  const beforeShift = vectorFromFrame(260, 280, frame);
  const afterShift = vectorFromFrame(260, 280, frame);

  assert.deepEqual(beforeShift, afterShift);
  assert.ok(afterShift.x > 0.9);
  assert.equal(afterShift.y, 0);
});

test("LayoutInteractionLock defers resize application until gestures end", () => {
  const lock = new LayoutInteractionLock();

  assert.equal(lock.requestApply(), true);
  lock.beginGesture();
  lock.beginGesture();
  assert.equal(lock.requestApply(), false);
  assert.equal(lock.endGesture(), false);
  assert.equal(lock.endGesture(), true);
  assert.equal(lock.requestApply(), true);
});

test("LayoutGestureLease ignores duplicate releases so concurrent gestures stay locked", () => {
  const lock = new LayoutInteractionLock();
  const first = new LayoutGestureLease(lock);
  const second = new LayoutGestureLease(lock);

  first.begin();
  second.begin();

  assert.equal(lock.requestApply(), false);
  assert.equal(first.end(), false);
  assert.equal(first.end(), false);
  assert.equal(second.end(), true);
  assert.equal(lock.requestApply(), true);
});

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
  assert.equal(transmitter.tryFlush(0), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].seq, 1);

  socket.bufferedAmount = 128;
  state.sticks.left.ny = 1;
  transmitter.markDirty();
  assert.equal(transmitter.tryFlush(8), false);
  assert.equal(sent.length, 1);

  socket.bufferedAmount = 0;
  assert.equal(transmitter.tryFlush(16), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].seq, 2);
  assert.equal(sent[1].sticks.left.ny, 1);
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

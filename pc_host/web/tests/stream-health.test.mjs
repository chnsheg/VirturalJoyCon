import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyStreamHealth,
  createInitialStreamHealth,
} from "../stream-health.mjs";

test("classifies stressed playback before recovery when fallback latency roughly doubles and playback stops advancing", () => {
  let health = createInitialStreamHealth();

  health = classifyStreamHealth(health, {
    nowMs: 0,
    fallbackLatencyMs: 42,
    frameCount: 120,
    currentTime: 2,
  });

  const stressed = classifyStreamHealth(health, {
    nowMs: 1000,
    fallbackLatencyMs: 86,
    frameCount: 120,
    currentTime: 2,
  });

  assert.equal(stressed.status, "stressed");
  assert.equal(stressed.reason, "latency-stalled");
  assert.equal(stressed.playbackAdvanced, false);
  assert.equal(stressed.shouldRecover, false);
  assert.equal(stressed.latencySource, "fallback");
});

test("classifies frozen playback when a doubled-latency stall persists for roughly two seconds without freeze count support", () => {
  let health = createInitialStreamHealth();

  health = classifyStreamHealth(health, {
    nowMs: 0,
    fallbackLatencyMs: 42,
    frameCount: 120,
    currentTime: 2,
  });

  const frozen = classifyStreamHealth(health, {
    nowMs: 2200,
    fallbackLatencyMs: 86,
    frameCount: 120,
    currentTime: 2,
  });

  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.reason, "latency-stalled");
  assert.equal(frozen.playbackAdvanced, false);
  assert.equal(frozen.shouldRecover, true);
  assert.equal(frozen.latencySource, "fallback");
});

test("classifies frozen playback when the browser freeze count increases", () => {
  let health = createInitialStreamHealth();

  health = classifyStreamHealth(health, {
    nowMs: 0,
    fallbackLatencyMs: 35,
    frameCount: 90,
    currentTime: 1.5,
    freezeCount: 0,
  });

  const frozen = classifyStreamHealth(health, {
    nowMs: 800,
    fallbackLatencyMs: 38,
    frameCount: 90,
    currentTime: 1.5,
    freezeCount: 1,
  });

  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.reason, "freeze-count");
  assert.equal(frozen.shouldRecover, true);
});

test("classifies frozen playback when freeze count first appears after earlier samples omitted it", () => {
  let health = createInitialStreamHealth();

  health = classifyStreamHealth(health, {
    nowMs: 0,
    fallbackLatencyMs: 35,
    frameCount: 90,
    currentTime: 1.5,
  });

  const frozen = classifyStreamHealth(health, {
    nowMs: 800,
    fallbackLatencyMs: 38,
    frameCount: 90,
    currentTime: 1.5,
    freezeCount: 1,
  });

  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.reason, "freeze-count");
  assert.equal(frozen.shouldRecover, true);
});

test("omitted freeze count preserves the last observed cumulative value", () => {
  let health = createInitialStreamHealth();

  health = classifyStreamHealth(health, {
    nowMs: 0,
    fallbackLatencyMs: 35,
    frameCount: 90,
    currentTime: 1.5,
    freezeCount: 0,
  });
  health = classifyStreamHealth(health, {
    nowMs: 800,
    fallbackLatencyMs: 38,
    frameCount: 90,
    currentTime: 1.5,
    freezeCount: 1,
  });

  const omitted = classifyStreamHealth(health, {
    nowMs: 1600,
    fallbackLatencyMs: 40,
    frameCount: 150,
    currentTime: 2.5,
  });
  const repeated = classifyStreamHealth(omitted, {
    nowMs: 2200,
    fallbackLatencyMs: 42,
    frameCount: 150,
    currentTime: 2.5,
    freezeCount: 1,
  });

  assert.equal(omitted.freezeCount, 1);
  assert.equal(repeated.status, "healthy");
  assert.equal(repeated.shouldRecover, false);
});

test("classifies frozen playback when the first observed sample already reports a positive freeze count", () => {
  const frozen = classifyStreamHealth(createInitialStreamHealth(), {
    nowMs: 0,
    fallbackLatencyMs: 38,
    frameCount: 120,
    currentTime: 2,
    freezeCount: 1,
  });

  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.reason, "freeze-count");
  assert.equal(frozen.shouldRecover, true);
});

test("classifies frozen playback when decoded progress remains stalled beyond the freeze threshold", () => {
  let health = createInitialStreamHealth();

  health = classifyStreamHealth(health, {
    nowMs: 0,
    fallbackLatencyMs: 35,
    frameCount: 90,
    currentTime: 1.5,
  });

  const frozen = classifyStreamHealth(health, {
    nowMs: 3800,
    fallbackLatencyMs: 36,
    frameCount: 90,
    currentTime: 1.5,
  });

  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.reason, "playback-stalled");
  assert.equal(frozen.shouldRecover, true);
});

test("uses fallback latency when direct media round-trip time is unavailable", () => {
  let health = createInitialStreamHealth();

  health = classifyStreamHealth(health, {
    nowMs: 0,
    mediaRoundTripTimeMs: Number.NaN,
    fallbackLatencyMs: 57,
    frameCount: 30,
    currentTime: 0.5,
  });

  assert.equal(health.latencyMs, 57);
  assert.equal(health.latencySource, "fallback");

  const direct = classifyStreamHealth(health, {
    nowMs: 1000,
    mediaRoundTripTimeMs: 24,
    fallbackLatencyMs: 57,
    frameCount: 90,
    currentTime: 1.5,
  });

  assert.equal(direct.latencyMs, 24);
  assert.equal(direct.latencySource, "media");
});

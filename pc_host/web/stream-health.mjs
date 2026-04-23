const PLAYBACK_EPSILON_SECONDS = 0.001;
const STRESS_LATENCY_RATIO = 1.8;
const STRESS_STALL_MS = 900;
const FREEZE_STALL_MS = 3600;

function toFiniteOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function selectLatencyMs(mediaRoundTripTimeMs, fallbackLatencyMs) {
  const mediaLatencyMs = toFiniteOrNull(mediaRoundTripTimeMs);
  if (mediaLatencyMs !== null && mediaLatencyMs >= 0) {
    return {
      latencyMs: mediaLatencyMs,
      latencySource: "media",
    };
  }

  const fallbackLatency = toFiniteOrNull(fallbackLatencyMs);
  if (fallbackLatency !== null && fallbackLatency >= 0) {
    return {
      latencyMs: fallbackLatency,
      latencySource: "fallback",
    };
  }

  return {
    latencyMs: null,
    latencySource: "unavailable",
  };
}

export function createInitialStreamHealth() {
  return {
    status: "idle",
    reason: "idle",
    latencyMs: null,
    latencySource: "unavailable",
    baselineLatencyMs: null,
    frameCount: 0,
    currentTime: 0,
    freezeCount: null,
    playbackAdvanced: false,
    stalledForMs: 0,
    lastAdvancedAtMs: 0,
    updatedAtMs: 0,
    initialized: false,
    shouldRecover: false,
    recoveryLocked: false,
  };
}

export function classifyStreamHealth(previousHealth = createInitialStreamHealth(), sample = {}) {
  const previous = previousHealth ?? createInitialStreamHealth();
  const nowMs = Number.isFinite(sample.nowMs) ? Number(sample.nowMs) : previous.updatedAtMs;
  const frameCount = Number.isFinite(sample.frameCount) ? Number(sample.frameCount) : previous.frameCount;
  const currentTime = Number.isFinite(sample.currentTime) ? Number(sample.currentTime) : previous.currentTime;
  const freezeCount = Number.isFinite(sample.freezeCount) ? Number(sample.freezeCount) : previous.freezeCount;
  const { latencyMs, latencySource } = selectLatencyMs(
    sample.mediaRoundTripTimeMs,
    sample.fallbackLatencyMs,
  );

  const playbackAdvanced =
    !previous.initialized
    || frameCount > previous.frameCount
    || currentTime > (previous.currentTime + PLAYBACK_EPSILON_SECONDS);
  const lastAdvancedAtMs = playbackAdvanced ? nowMs : previous.lastAdvancedAtMs;
  const stalledForMs = playbackAdvanced ? 0 : Math.max(0, nowMs - lastAdvancedAtMs);

  let baselineLatencyMs = previous.baselineLatencyMs;
  if (latencyMs !== null) {
    if (baselineLatencyMs === null || !previous.initialized) {
      baselineLatencyMs = latencyMs;
    } else if (playbackAdvanced) {
      baselineLatencyMs = Number(((baselineLatencyMs * 0.75) + (latencyMs * 0.25)).toFixed(2));
    }
  }

  const priorFreezeCount =
    previous.freezeCount !== null
      ? previous.freezeCount
      : 0;
  const freezeCountObservedOnFirstSample =
    !previous.initialized
    && freezeCount !== null
    && freezeCount > 0;
  const freezeCountIncreased =
    freezeCount !== null
    && previous.initialized
    && !playbackAdvanced
    && freezeCount > priorFreezeCount;
  const freezeCountTriggered =
    freezeCountObservedOnFirstSample
    || freezeCountIncreased;
  const latencyRatio =
    latencyMs !== null && baselineLatencyMs !== null && baselineLatencyMs > 0
      ? latencyMs / baselineLatencyMs
      : Number.NaN;
  const isFrozen =
    freezeCountTriggered
    || (previous.initialized && !playbackAdvanced && stalledForMs >= FREEZE_STALL_MS);
  const isStressed =
    !isFrozen
    && previous.initialized
    && !playbackAdvanced
    && stalledForMs >= STRESS_STALL_MS
    && Number.isFinite(latencyRatio)
    && latencyRatio >= STRESS_LATENCY_RATIO;

  const status = isFrozen ? "frozen" : isStressed ? "stressed" : "healthy";
  const reason = isFrozen
    ? (freezeCountTriggered ? "freeze-count" : "playback-stalled")
    : isStressed
      ? "latency-stalled"
      : "ok";
  const shouldRecover = isFrozen && !previous.recoveryLocked;

  return {
    ...previous,
    status,
    reason,
    latencyMs,
    latencySource,
    baselineLatencyMs,
    frameCount,
    currentTime,
    freezeCount,
    playbackAdvanced,
    stalledForMs,
    lastAdvancedAtMs,
    updatedAtMs: nowMs,
    initialized: true,
    shouldRecover,
    recoveryLocked: isFrozen,
  };
}

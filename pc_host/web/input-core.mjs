const DEFAULT_STICK_CONFIG = Object.freeze({
  deadzone: 0.13,
  outerDeadzone: 0.02,
  responseExponent: 1.45,
  minCutoff: 1.2,
  beta: 0.35,
  derivativeCutoff: 1.0,
  engageThreshold: 0.58,
  releaseThreshold: 0.35,
  repeatDelayMs: 240,
  repeatIntervalMs: 100,
  axisSwitchRatio: 1.25,
  flickResponseFloor: 0.95,
});

const SOCKET_OPEN = 1;
const DATA_CHANNEL_OPEN = "open";

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

function roundAxis(value, digits = 4) {
  return Number(clamp(value, -1, 1).toFixed(digits));
}

function smoothingAlpha(cutoff, dtSeconds) {
  const safeCutoff = Math.max(0.0001, cutoff);
  const safeDt = Math.max(0.000001, dtSeconds);
  const tau = 1 / (2 * Math.PI * safeCutoff);
  return 1 / (1 + tau / safeDt);
}

class LowPassFilter {
  constructor() {
    this.ready = false;
    this.value = 0;
  }

  reset() {
    this.ready = false;
    this.value = 0;
  }

  filter(nextValue, alpha) {
    if (!this.ready) {
      this.ready = true;
      this.value = nextValue;
      return nextValue;
    }

    this.value += alpha * (nextValue - this.value);
    return this.value;
  }
}

class OneEuroAxisFilter {
  constructor({ minCutoff, beta, derivativeCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.valueFilter = new LowPassFilter();
    this.derivativeFilter = new LowPassFilter();
    this.lastTimestamp = null;
    this.lastRawValue = 0;
  }

  reset() {
    this.valueFilter.reset();
    this.derivativeFilter.reset();
    this.lastTimestamp = null;
    this.lastRawValue = 0;
  }

  filter(value, timestampMs) {
    if (this.lastTimestamp === null) {
      this.lastTimestamp = timestampMs;
      this.lastRawValue = value;
      this.valueFilter.filter(value, 1);
      this.derivativeFilter.filter(0, 1);
      return value;
    }

    const dt = Math.max(1 / 240, (timestampMs - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestampMs;

    const derivative = (value - this.lastRawValue) / dt;
    this.lastRawValue = value;
    const filteredDerivative = this.derivativeFilter.filter(
      derivative,
      smoothingAlpha(this.derivativeCutoff, dt),
    );

    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    return this.valueFilter.filter(value, smoothingAlpha(cutoff, dt));
  }
}

class TwoAxisOneEuroFilter {
  constructor(config) {
    this.x = new OneEuroAxisFilter(config);
    this.y = new OneEuroAxisFilter(config);
  }

  reset() {
    this.x.reset();
    this.y.reset();
  }

  filter(vector, timestampMs) {
    return {
      x: this.x.filter(vector.x, timestampMs),
      y: this.y.filter(vector.y, timestampMs),
    };
  }
}

function normalizeVector(vector) {
  const x = clamp(vector.x ?? 0, -1, 1);
  const y = clamp(vector.y ?? 0, -1, 1);
  const magnitude = Math.hypot(x, y);
  if (magnitude <= 1) {
    return { x, y };
  }

  return {
    x: x / magnitude,
    y: y / magnitude,
  };
}

function scaleVector(vector, magnitude) {
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return { x: 0, y: 0 };
  }

  const normalized = normalizeVector(vector);
  const currentMagnitude = Math.hypot(normalized.x, normalized.y);
  if (currentMagnitude <= 0) {
    return { x: 0, y: 0 };
  }

  const directionX = normalized.x / currentMagnitude;
  const directionY = normalized.y / currentMagnitude;
  return {
    x: directionX * clamp01(magnitude),
    y: directionY * clamp01(magnitude),
  };
}

function roundVector(vector) {
  return {
    x: roundAxis(vector.x),
    y: roundAxis(vector.y),
  };
}

function remapRadialMagnitude(magnitude, config) {
  if (magnitude <= config.deadzone) {
    return 0;
  }

  const withoutInnerDeadzone = clamp01((magnitude - config.deadzone) / (1 - config.deadzone));
  return withoutInnerDeadzone >= (1 - config.outerDeadzone)
    ? 1
    : withoutInnerDeadzone / (1 - config.outerDeadzone);
}

function describeRadialResponse(vector, config = DEFAULT_STICK_CONFIG) {
  const settings = { ...DEFAULT_STICK_CONFIG, ...config };
  const normalized = normalizeVector(vector);
  const magnitude = Math.hypot(normalized.x, normalized.y);

  if (magnitude <= settings.deadzone) {
    return {
      linear: { x: 0, y: 0 },
      state: { x: 0, y: 0 },
    };
  }

  const remappedMagnitude = remapRadialMagnitude(magnitude, settings);
  const antiDeadzone = clamp01(settings.antiDeadzone ?? 0);
  const curvedMagnitude = antiDeadzone
    + (1 - antiDeadzone) * Math.pow(remappedMagnitude, settings.responseExponent);

  const linear = scaleVector(normalized, remappedMagnitude);
  return {
    linear: roundVector(linear),
    state: roundVector(scaleVector(normalized, curvedMagnitude)),
  };
}

export function applyRadialResponse(vector, config = DEFAULT_STICK_CONFIG) {
  return describeRadialResponse(vector, config).state;
}

function applyTouchResponseAssist(raw, filtered, previousRawMagnitude, config = DEFAULT_STICK_CONFIG) {
  const rawMagnitude = Math.hypot(raw.x, raw.y);
  const filteredMagnitude = Math.hypot(filtered.x, filtered.y);

  if (rawMagnitude < previousRawMagnitude && filteredMagnitude > rawMagnitude) {
    return scaleVector(filtered, rawMagnitude);
  }

  if (rawMagnitude > config.deadzone) {
    const floorMagnitude = Math.min(1, rawMagnitude * config.flickResponseFloor);
    if (filteredMagnitude < floorMagnitude) {
      return scaleVector(filteredMagnitude > 0 ? filtered : raw, floorMagnitude);
    }
  }

  return normalizeVector(filtered);
}

function pickDominantDirection(vector, previousDirection, axisSwitchRatio) {
  const absX = Math.abs(vector.x);
  const absY = Math.abs(vector.y);

  if (absX === 0 && absY === 0) {
    return null;
  }

  if (previousDirection === "up" || previousDirection === "down") {
    if (absX > absY * axisSwitchRatio) {
      return vector.x >= 0 ? "right" : "left";
    }
    return vector.y >= 0 ? "up" : "down";
  }

  if (previousDirection === "left" || previousDirection === "right") {
    if (absY > absX * axisSwitchRatio) {
      return vector.y >= 0 ? "up" : "down";
    }
    return vector.x >= 0 ? "right" : "left";
  }

  return absY >= absX
    ? (vector.y >= 0 ? "up" : "down")
    : (vector.x >= 0 ? "right" : "left");
}

class DirectionalActuationGate {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  setConfig(config) {
    this.config = config;
  }

  reset() {
    this.direction = null;
    this.engaged = false;
    this.engagedAt = -Infinity;
    this.lastRepeatAt = -Infinity;
  }

  sample(vector, now) {
    const nextDirection = pickDominantDirection(
      vector,
      this.direction,
      this.config.axisSwitchRatio,
    );
    const nextMagnitude = Math.max(Math.abs(vector.x), Math.abs(vector.y));
    const shouldEngage = Boolean(nextDirection) && nextMagnitude >= this.config.engageThreshold;
    const shouldRelease = !nextDirection || nextMagnitude <= this.config.releaseThreshold;

    let justPressed = false;
    let justReleased = false;

    if (!this.engaged && shouldEngage) {
      this.engaged = true;
      this.direction = nextDirection;
      this.engagedAt = now;
      this.lastRepeatAt = now;
      justPressed = true;
    } else if (this.engaged && shouldRelease) {
      this.engaged = false;
      this.direction = null;
      justReleased = true;
    } else if (this.engaged && nextDirection) {
      this.direction = nextDirection;
    }

    let repeatReady = false;
    if (
      this.engaged
      && (now - this.engagedAt) >= this.config.repeatDelayMs
      && (now - this.lastRepeatAt) >= this.config.repeatIntervalMs
    ) {
      repeatReady = true;
      this.lastRepeatAt = now;
    }

    return {
      direction: this.direction,
      engaged: this.engaged,
      justPressed,
      justReleased,
      repeatReady,
    };
  }
}

export class AdaptiveStickProcessor {
  constructor(config = {}) {
    this.baseConfig = { ...DEFAULT_STICK_CONFIG, ...config };
    this.config = { ...this.baseConfig };
    this.filter = new TwoAxisOneEuroFilter(this.config);
    this.gate = new DirectionalActuationGate(this.config);
    this.lastRawMagnitude = 0;
  }

  reset() {
    this.filter.reset();
    this.gate.reset();
    this.lastRawMagnitude = 0;
    return {
      raw: { x: 0, y: 0 },
      filtered: { x: 0, y: 0 },
      state: { x: 0, y: 0 },
      display: { x: 0, y: 0 },
      navigation: {
        direction: null,
        engaged: false,
        justPressed: false,
        justReleased: false,
        repeatReady: false,
      },
    };
  }

  setResponseExponent(responseExponent) {
    if (Number.isFinite(responseExponent)) {
      this.config = {
        ...this.baseConfig,
        responseExponent,
      };
      this.gate.setConfig(this.config);
    }

    return this.config;
  }

  sampleVector({ x, y, now }) {
    const raw = normalizeVector({ x, y });
    const filtered = this.filter.filter(raw, now);
    const assisted = applyTouchResponseAssist(raw, filtered, this.lastRawMagnitude, this.config);
    this.lastRawMagnitude = Math.hypot(raw.x, raw.y);
    const radial = describeRadialResponse(assisted, this.config);
    const navigation = this.gate.sample(radial.linear, now);
    return {
      raw,
      filtered: roundVector(filtered),
      state: radial.state,
      display: radial.state,
      navigation,
    };
  }
}

export function vectorFromPoint(clientX, clientY, rect, radiusPx) {
  return vectorFromFrame(clientX, clientY, createStickFrame(rect, radiusPx));
}

export function createStickFrame(rect, radiusPx) {
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    radius: Math.max(1, radiusPx),
  };
}

export function vectorFromFrame(clientX, clientY, frame) {
  const dx = clientX - frame.cx;
  const dy = frame.cy - clientY;

  return normalizeVector({
    x: dx / frame.radius,
    y: dy / frame.radius,
  });
}

export function createPacketSnapshot(state, seq, nowMs) {
  return {
    device_id: state.device_id,
    client_session_id: state.client_session_id,
    input_stream_id: state.input_stream_id,
    seq,
    sent_at_ms: Math.round(nowMs),
    buttons: { ...state.buttons },
    sticks: {
      left: {
        nx: roundAxis(state.sticks.left.nx),
        ny: roundAxis(state.sticks.left.ny),
        processed: true,
      },
      right: {
        nx: roundAxis(state.sticks.right.nx),
        ny: roundAxis(state.sticks.right.ny),
        processed: true,
      },
    },
    triggers: {
      lt: Number(clamp01(state.triggers.lt).toFixed(4)),
      rt: Number(clamp01(state.triggers.rt).toFixed(4)),
    },
  };
}

export class LatencyTracker {
  constructor({ maxSamples = 5, staleAfterMs = 2500 } = {}) {
    this.maxSamples = maxSamples;
    this.staleAfterMs = staleAfterMs;
    this.samples = [];
    this.lastUpdatedAt = -Infinity;
  }

  noteRoundTrip(roundTripMs, nowMs = Date.now()) {
    const nextSample = Math.max(0, Math.round(roundTripMs));
    this.samples.push(nextSample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    this.lastUpdatedAt = nowMs;
    return this.getNumericValue();
  }

  getNumericValue() {
    if (this.samples.length === 0) {
      return null;
    }

    const total = this.samples.reduce((sum, value) => sum + value, 0);
    return Math.round(total / this.samples.length);
  }

  getDisplayValue(nowMs = Date.now()) {
    const numericValue = this.getNumericValue();
    if (numericValue === null || (nowMs - this.lastUpdatedAt) > this.staleAfterMs) {
      return "--";
    }

    return `${numericValue} ms`;
  }
}

export class LayoutInteractionLock {
  constructor() {
    this.activeGestures = 0;
    this.pendingApply = false;
  }

  beginGesture() {
    this.activeGestures += 1;
  }

  endGesture() {
    if (this.activeGestures > 0) {
      this.activeGestures -= 1;
    }

    if (this.activeGestures === 0 && this.pendingApply) {
      this.pendingApply = false;
      return true;
    }

    return false;
  }

  requestApply() {
    if (this.activeGestures > 0) {
      this.pendingApply = true;
      return false;
    }

    return true;
  }
}

export class LayoutGestureLease {
  constructor(lock) {
    this.lock = lock;
    this.active = false;
  }

  begin() {
    if (this.active) {
      return false;
    }

    this.active = true;
    this.lock.beginGesture();
    return true;
  }

  end() {
    if (!this.active) {
      return false;
    }

    this.active = false;
    return this.lock.endGesture();
  }
}

export class LatestStateTransmitter {
  constructor({
    getSocket,
    getDataChannel,
    getPreferredTransport,
    readState,
    minIntervalMs = 8,
    heartbeatMs = 250,
    maxBufferedAmount = 32768,
    maxDataChannelBufferedAmount = 2048,
  }) {
    this.getSocket = getSocket;
    this.getDataChannel = getDataChannel;
    this.getPreferredTransport = getPreferredTransport;
    this.readState = readState;
    this.minIntervalMs = minIntervalMs;
    this.heartbeatMs = heartbeatMs;
    this.maxBufferedAmount = maxBufferedAmount;
    this.maxDataChannelBufferedAmount = maxDataChannelBufferedAmount;
    this.sequence = 0;
    this.lastSendAt = -Infinity;
    this.lastSerialized = "";
    this.dirty = true;
    this.priority = false;
  }

  markDirty(priority = false) {
    this.dirty = true;
    this.priority = this.priority || priority;
  }

  shouldFlush(nowMs) {
    const heartbeatDue = (nowMs - this.lastSendAt) >= this.heartbeatMs;
    if (!this.dirty && !heartbeatDue) {
      return false;
    }

    if (!this.priority && (nowMs - this.lastSendAt) < this.minIntervalMs) {
      return false;
    }

    return true;
  }

  createPayload(nowMs) {
    if (!this.shouldFlush(nowMs)) {
      return null;
    }

    const packet = createPacketSnapshot(this.readState(), this.sequence + 1, nowMs);
    const serialized = JSON.stringify(packet);
    return { packet, serialized };
  }

  commit(payload, nowMs) {
    this.sequence = payload.packet.seq;
    this.lastSerialized = payload.serialized;
    this.lastSendAt = nowMs;
    this.dirty = false;
    this.priority = false;
  }

  tryFlushDataChannel(nowMs) {
    const dataChannel = this.getDataChannel?.();
    if (!dataChannel || dataChannel.readyState !== DATA_CHANNEL_OPEN) {
      return false;
    }

    if ((dataChannel.bufferedAmount ?? 0) > this.maxDataChannelBufferedAmount) {
      return false;
    }

    const payload = this.createPayload(nowMs);
    if (!payload) {
      return false;
    }

    dataChannel.send(payload.serialized);
    this.commit(payload, nowMs);
    return "datachannel";
  }

  tryFlushSocket(nowMs) {
    const socket = this.getSocket?.();
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return false;
    }

    if ((socket.bufferedAmount ?? 0) > this.maxBufferedAmount) {
      return false;
    }

    const payload = this.createPayload(nowMs);
    if (!payload) {
      return false;
    }

    socket.send(payload.serialized);
    this.commit(payload, nowMs);
    return "ws";
  }

  tryFlush(nowMs) {
    const preferredTransport = this.getPreferredTransport?.();
    if (preferredTransport === "datachannel") {
      return this.tryFlushDataChannel(nowMs);
    }
    if (preferredTransport === "ws") {
      return this.tryFlushSocket(nowMs);
    }
    return this.tryFlushDataChannel(nowMs) || this.tryFlushSocket(nowMs);
  }
}

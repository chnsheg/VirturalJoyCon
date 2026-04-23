import {
  AdaptiveStickProcessor,
  LatencyTracker,
  LayoutGestureLease,
  LayoutInteractionLock,
  LatestStateTransmitter,
  clamp,
  clamp01,
  createStickFrame,
  createPacketSnapshot,
  vectorFromFrame,
} from "./input-core.mjs";
import {
  buildTransportUrls,
  DEFAULT_STREAM_SETTINGS,
  getStickResponseExponent,
  HostDrawerController,
  normalizeHostTarget,
  normalizeStreamSettings,
} from "./host-config.mjs?v=stream-20260422-9";
import { computeLayoutMetrics } from "./layout-core.mjs";
import { getControlHudText, negotiateControlPeer } from "./stream-control.mjs";
import { classifyStreamHealth, createInitialStreamHealth } from "./stream-health.mjs";
import { createStreamCanvasRenderer, subscribeViaWhep } from "./stream-media.mjs?v=stream-20260423-3";
import { createInitialStreamState, createRoomSessionClient, roomStatusText } from "./stream-session.mjs";

const connEl = document.getElementById("conn");
const slotEl = document.getElementById("slot");
const latencyEl = document.getElementById("latency");
const hostEl = document.getElementById("host");
const hostDrawerEl = document.getElementById("hostDrawer");
const hostDrawerHandleEl = document.getElementById("hostDrawerHandle");
const hostDrawerBackdropEl = document.getElementById("hostDrawerBackdrop");
const hostTargetFormEl = document.getElementById("hostTargetForm");
const hostTargetInputEl = document.getElementById("hostTargetInput");
const stickSensitivityInputEl = document.getElementById("stickSensitivityInput");
const stickSensitivityValueEl = document.getElementById("stickSensitivityValue");
const controlOpacityInputEl = document.getElementById("controlOpacityInput");
const controlOpacityValueEl = document.getElementById("controlOpacityValue");
const controllerVisibleInputEl = document.getElementById("controllerVisibleInput");
const hudVisibleInputEl = document.getElementById("hudVisibleInput");
const hostTargetStatusEl = document.getElementById("hostTargetStatus");
const controllerEl = document.querySelector(".controller");
const leftTriggerEl = document.getElementById("leftTrigger");
const rightTriggerEl = document.getElementById("rightTrigger");
const leftStickEl = document.getElementById("leftStick");
const rightStickEl = document.getElementById("rightStick");
const remoteVideoEl = document.getElementById("remoteVideo");
const streamBackdropCanvasEl = document.getElementById("streamBackdropCanvas");
const streamCanvasEl = document.getElementById("streamCanvas");
const roomStatusEl = document.getElementById("roomStatus");
const transportModeEl = document.getElementById("transportMode");
const streamTelemetryEl = document.getElementById("streamTelemetry");
const videoWidthInputEl = document.getElementById("videoWidthInput");
const videoHeightInputEl = document.getElementById("videoHeightInput");
const videoFpsInputEl = document.getElementById("videoFpsInput");
const videoBitrateInputEl = document.getElementById("videoBitrateInput");
const streamSettingsSaveEl = document.getElementById("streamSettingsSave");
const streamSettingsStatusEl = document.getElementById("streamSettingsStatus");
const fullscreenPlaybackEl = document.getElementById("fullscreenPlayback");
const STREAM_RECONNECT_TOKEN_KEY = "joycon_stream_reconnect_token";
const STREAM_APPLY_POLL_INTERVAL_MS = 180;
const STREAM_APPLY_POLL_ATTEMPTS = 20;
const STREAM_TELEMETRY_POLL_MS = 1000;
const STREAM_TELEMETRY_SMOOTHING_ALPHA = 0.34;
const STREAM_RESYNC_COOLDOWN_MS = 1200;
const STREAM_STALE_FRAME_THRESHOLD_MS = 3600;

window.addEventListener("error", (event) => {
  connEl.textContent = `JS error: ${event.message || "unknown"}`;
});

function fallbackId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getPersistentId(key, storage) {
  try {
    const existing = storage.getItem(key);
    if (existing) {
      return existing;
    }
  } catch {}

  const created = window.crypto?.randomUUID?.() || fallbackId(key);
  try {
    storage.setItem(key, created);
  } catch {}
  return created;
}

function loadReconnectToken(storage) {
  try {
    return storage?.getItem?.(STREAM_RECONNECT_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveReconnectToken(storage, reconnectToken) {
  try {
    if (reconnectToken) {
      storage?.setItem?.(STREAM_RECONNECT_TOKEN_KEY, reconnectToken);
    } else if (typeof storage?.removeItem === "function") {
      storage.removeItem(STREAM_RECONNECT_TOKEN_KEY);
    }
  } catch {}
}

const state = {
  device_id: getPersistentId("joycon_device_id", window.localStorage),
  client_session_id: getPersistentId("joycon_client_session_id", window.localStorage),
  input_stream_id: getPersistentId("joycon_input_stream_id", window.sessionStorage),
  buttons: {
    a: false,
    b: false,
    x: false,
    y: false,
    lb: false,
    rb: false,
    select: false,
    start: false,
    dpad_up: false,
    dpad_down: false,
    dpad_left: false,
    dpad_right: false,
    ls: false,
    rs: false,
  },
  sticks: {
    left: { nx: 0, ny: 0 },
    right: { nx: 0, ny: 0 },
  },
  triggers: {
    lt: 0,
    rt: 0,
  },
};
const hostDrawerController = new HostDrawerController({ storage: window.localStorage });
const initialDrawerSnapshot = hostDrawerController.snapshot();
const stickProcessors = {
  left: new AdaptiveStickProcessor({
    responseExponent: getStickResponseExponent(initialDrawerSnapshot.stickSensitivity),
  }),
  right: new AdaptiveStickProcessor({
    responseExponent: getStickResponseExponent(initialDrawerSnapshot.stickSensitivity),
  }),
};
let remoteEndpoints = hostDrawerController.hostTarget
  ? buildTransportUrls(hostDrawerController.hostTarget)
  : null;
let suppressNextReconnect = false;

let ws = null;
let reconnectTimer = null;
let httpSending = false;
let httpQueued = false;
let transportMode = "ws";
let lastPingSentAt = -Infinity;
let streamAttempt = 0;
let activeMediaPeer = null;
let activeControlPeer = null;
let activeControlChannel = null;
let activeInputChannel = null;
let controlHudMode = "idle";
let streamSettingsDirty = false;
let streamSettingsSavePromise = null;
let hostDrawerWasOpen = false;
let streamTelemetryInFlight = false;
let lastStreamTelemetryPollAt = -Infinity;
let lastStreamTelemetrySample = null;
let lastStreamTelemetryRenderAt = -Infinity;
let lastStreamTelemetryMarkup = "";
let currentStreamTelemetryMetrics = {
  fps: Number.NaN,
  bitrateKbps: Number.NaN,
  lossPercent: Number.NaN,
};
let lastStreamFrameAt = performance.now();
let lastStreamFrameCount = 0;
let lastStreamCurrentTime = 0;
let lastTelemetryVideoSample = null;
let streamResyncInFlight = false;
let lastStreamResyncAt = -Infinity;
let holdWebrtcControlHudDuringStreamResync = false;
let streamHealthRecoveryHudUntil = -Infinity;
let appWasHidden = globalThis.document?.visibilityState === "hidden";
let immersiveRequestInFlight = false;
const streamState = createInitialStreamState();
let streamHealth = createInitialStreamHealth();
const streamRenderer = createStreamCanvasRenderer({
  videoEl: remoteVideoEl,
  canvasEl: streamCanvasEl,
  backdropCanvasEl: streamBackdropCanvasEl,
});

const transmitter = new LatestStateTransmitter({
  getSocket: () => ws,
  getDataChannel: () => activeInputChannel,
  readState: () => state,
  minIntervalMs: 8,
  heartbeatMs: 220,
  maxBufferedAmount: 2048,
});
const latencyTracker = new LatencyTracker({ maxSamples: 5, staleAfterMs: 2500 });
const layoutInteractionLock = new LayoutInteractionLock();

function updateConnectionText(text) {
  connEl.textContent = text;
}

function updateSlot(slot, mode = transportMode) {
  slotEl.textContent = `slot: ${slot}`;
}

function clearSlot(mode = transportMode) {
  updateSlot("-", mode);
}

function renderRoomState() {
  if (roomStatusEl) {
    roomStatusEl.textContent = roomStatusText(streamState);
  }

  if (transportModeEl) {
    transportModeEl.textContent = getControlHudText(controlHudMode);
    transportModeEl.hidden = true;
    transportModeEl.setAttribute("aria-hidden", "true");
  }

  globalThis.document?.body?.classList?.toggle("stream-degraded", Boolean(streamState.degraded));
  renderStreamTelemetry(performance.now(), { force: true });
}

function readVideoProgress(videoEl) {
  const playbackQuality = videoEl?.getVideoPlaybackQuality?.();
  const frameCount = Number(
    playbackQuality?.totalVideoFrames
    ?? playbackQuality?.totalFrames
    ?? videoEl?.webkitDecodedFrameCount
    ?? videoEl?.mozDecodedFrames
    ?? 0,
  );
  const currentTime = Number(videoEl?.currentTime ?? 0);
  return {
    frameCount: Number.isFinite(frameCount) ? frameCount : 0,
    currentTime: Number.isFinite(currentTime) ? currentTime : 0,
    freezeCount: Number.isFinite(Number(playbackQuality?.freezeCount))
      ? Number(playbackQuality.freezeCount)
      : null,
  };
}

function resetStreamDiagnostics(nowMs = performance.now()) {
  lastStreamTelemetryPollAt = -Infinity;
  lastStreamTelemetrySample = null;
  lastStreamTelemetryRenderAt = -Infinity;
  lastStreamTelemetryMarkup = "";
  currentStreamTelemetryMetrics = {
    fps: Number.NaN,
    bitrateKbps: Number.NaN,
    lossPercent: Number.NaN,
  };
  streamHealth = createInitialStreamHealth();
  const progress = readVideoProgress(remoteVideoEl);
  lastStreamFrameAt = nowMs;
  lastStreamFrameCount = progress.frameCount;
  lastStreamCurrentTime = progress.currentTime;
  lastTelemetryVideoSample = {
    nowMs,
    frameCount: progress.frameCount,
    currentTime: progress.currentTime,
  };
}

function getConfiguredHostTarget() {
  return hostDrawerController.snapshot().hostTarget;
}

function smoothTelemetryMetric(previousValue, nextValue, alpha = STREAM_TELEMETRY_SMOOTHING_ALPHA) {
  if (!Number.isFinite(nextValue) || nextValue < 0) {
    return previousValue;
  }

  if (!Number.isFinite(previousValue) || previousValue < 0) {
    return nextValue;
  }

  return Number((previousValue + ((nextValue - previousValue) * alpha)).toFixed(2));
}

function formatBitrateKbps(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} Mbps`;
  }

  return `${Math.round(value)} kbps`;
}

function formatFps(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }

  return `${Math.round(value)} fps`;
}

function formatLossPercent(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "--";
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatProtocolLabel(mode) {
  if (!activeMediaPeer) {
    if (mode === "ws") {
      return "WS";
    }
    if (mode === "http") {
      return "HTTP";
    }
    return "Idle";
  }

  if (mode === "webrtc") {
    return "RTC";
  }

  if (mode === "ws") {
    return "RTC+WS";
  }

  if (mode === "http") {
    return "RTC+HTTP";
  }

  return "RTC";
}

function readFallbackLatencyMs(nowMs) {
  const numericValue = latencyTracker.getNumericValue();
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  if ((nowMs - latencyTracker.lastUpdatedAt) > latencyTracker.staleAfterMs) {
    return null;
  }

  return numericValue;
}

function readMediaRoundTripTimeMs(videoStats) {
  const roundTripTime = Number(
    videoStats?.roundTripTime
    ?? videoStats?.currentRoundTripTime,
  );
  if (!Number.isFinite(roundTripTime) || roundTripTime < 0) {
    return null;
  }

  return roundTripTime <= 10 ? roundTripTime * 1000 : roundTripTime;
}

function updateStreamHealth(nowMs, { progress = readVideoProgress(remoteVideoEl), videoStats = null } = {}) {
  if (!activeMediaPeer) {
    streamHealth = createInitialStreamHealth();
    return streamHealth;
  }

  const freezeCountFromStats = Number(videoStats?.freezeCount);
  const freezeCount =
    Number.isFinite(freezeCountFromStats)
      ? freezeCountFromStats
      : progress.freezeCount;
  streamHealth = classifyStreamHealth(streamHealth, {
    nowMs,
    frameCount: progress.frameCount,
    currentTime: progress.currentTime,
    freezeCount,
    mediaRoundTripTimeMs: readMediaRoundTripTimeMs(videoStats),
    fallbackLatencyMs: readFallbackLatencyMs(nowMs),
  });

  if (streamHealth.status === "healthy" || streamHealth.status === "stressed" || streamHealth.status === "frozen") {
    streamHealthRecoveryHudUntil = -Infinity;
  }

  if (
    streamHealth.shouldRecover
    && !streamResyncInFlight
    && globalThis.document?.visibilityState !== "hidden"
  ) {
    void resyncActiveStreaming("stale", { observedAtMs: nowMs });
  }

  return streamHealth;
}

function describeStreamHealthLabel(nowMs = performance.now()) {
  if (
    streamResyncInFlight
    || streamState.lastError === "resyncing stream"
    || nowMs <= streamHealthRecoveryHudUntil
  ) {
    return "recovering";
  }

  if (!activeMediaPeer) {
    return "idle";
  }

  if (!streamHealth.initialized) {
    return "recovering";
  }

  if (streamHealth.status === "frozen") {
    return "frozen";
  }

  if (streamHealth.status === "stressed") {
    return "stressed";
  }

  if (streamHealth.status === "healthy") {
    return "healthy";
  }

  return "recovering";
}

function estimatePlaybackFps(videoEl, progress = readVideoProgress(videoEl)) {
  if (progress.frameCount <= 0 || progress.currentTime <= 0.05) {
    return Number.NaN;
  }

  return progress.frameCount / progress.currentTime;
}

function updateLocalVideoTelemetry(nowMs, progress = readVideoProgress(remoteVideoEl)) {
  if (!lastTelemetryVideoSample) {
    lastTelemetryVideoSample = {
      nowMs,
      frameCount: progress.frameCount,
      currentTime: progress.currentTime,
    };
    return;
  }

  const deltaMs = nowMs - lastTelemetryVideoSample.nowMs;
  const frameDelta = Math.max(0, progress.frameCount - lastTelemetryVideoSample.frameCount);
  const timeDelta = Math.max(0, progress.currentTime - lastTelemetryVideoSample.currentTime);

  if (deltaMs <= 0) {
    lastTelemetryVideoSample = {
      nowMs,
      frameCount: progress.frameCount,
      currentTime: progress.currentTime,
    };
    return;
  }

  if (deltaMs >= 250 && (frameDelta > 0 || timeDelta > 0)) {
    const fpsFromFrames = frameDelta > 0 ? frameDelta / (deltaMs / 1000) : Number.NaN;
    const fpsFromPlayback = (frameDelta > 0 && timeDelta > 0) ? frameDelta / timeDelta : Number.NaN;
    const measuredFps =
      Number.isFinite(fpsFromPlayback) && fpsFromPlayback > 0
        ? fpsFromPlayback
        : fpsFromFrames;
    currentStreamTelemetryMetrics.fps = smoothTelemetryMetric(
      currentStreamTelemetryMetrics.fps,
      measuredFps,
    );
    lastTelemetryVideoSample = {
      nowMs,
      frameCount: progress.frameCount,
      currentTime: progress.currentTime,
    };
  }
}

function buildStreamTelemetryItems(nowMs = performance.now()) {
  const fallbackFps = estimatePlaybackFps(remoteVideoEl);
  const telemetryFps = Number.isFinite(currentStreamTelemetryMetrics.fps) && currentStreamTelemetryMetrics.fps > 0
    ? currentStreamTelemetryMetrics.fps
    : fallbackFps;
  return [
    { label: "Protocol", value: formatProtocolLabel(controlHudMode) },
    { label: "FPS", value: formatFps(telemetryFps) },
    { label: "Bitrate", value: formatBitrateKbps(currentStreamTelemetryMetrics.bitrateKbps) },
    { label: "Latency", value: latencyTracker.getDisplayValue(nowMs) },
    { label: "Quality", value: describeStreamHealthLabel(nowMs) },
    { label: "Loss", value: formatLossPercent(currentStreamTelemetryMetrics.lossPercent) },
  ];
}

function buildStreamTelemetryMarkup(nowMs = performance.now()) {
  const items = buildStreamTelemetryItems(nowMs);
  return `
    <div class="stream-telemetry-line">
      ${items.map(({ label, value }, index) => `
        ${index > 0 ? '<span class="stream-telemetry-separator" aria-hidden="true">·</span>' : ""}
        <span class="stream-telemetry-segment">
          <span class="stream-telemetry-label">${label}</span>
          <span class="stream-telemetry-value">${value}</span>
        </span>
      `).join("")}
    </div>
  `;
}

function renderStreamTelemetry(nowMs = performance.now(), { force = false } = {}) {
  if (!streamTelemetryEl) {
    return;
  }

  const { hudVisible } = hostDrawerController.snapshot();
  streamTelemetryEl.hidden = !hudVisible;
  if (!hudVisible) {
    return;
  }

  if (!force && (nowMs - lastStreamTelemetryRenderAt) < STREAM_TELEMETRY_POLL_MS) {
    return;
  }

  const markup = buildStreamTelemetryMarkup(nowMs);
  if (!force && markup === lastStreamTelemetryMarkup) {
    lastStreamTelemetryRenderAt = nowMs;
    return;
  }

  streamTelemetryEl.innerHTML = markup;
  lastStreamTelemetryMarkup = markup;
  lastStreamTelemetryRenderAt = nowMs;
}

function selectInboundVideoStats(report) {
  if (!report || typeof report.forEach !== "function") {
    return null;
  }

  let selected = null;
  report.forEach((stat) => {
    if (!stat) {
      return;
    }

    const isVideo = stat.kind === "video" || stat.mediaType === "video";
    const isInboundVideo = stat.type === "inbound-rtp" && isVideo;
    const isTrackVideo = stat.type === "track" && isVideo;
    if (isInboundVideo || isTrackVideo) {
      selected = stat;
    }
  });
  return selected;
}

async function pollStreamTelemetry(nowMs) {
  if (!streamTelemetryEl) {
    return;
  }

  const progress = readVideoProgress(remoteVideoEl);
  updateLocalVideoTelemetry(nowMs, progress);

  if (streamTelemetryInFlight || (nowMs - lastStreamTelemetryPollAt) < STREAM_TELEMETRY_POLL_MS) {
    return;
  }

  lastStreamTelemetryPollAt = nowMs;

  if (!activeMediaPeer || typeof activeMediaPeer.getStats !== "function") {
    updateStreamHealth(nowMs, { progress });
    renderStreamTelemetry(nowMs);
    return;
  }

  streamTelemetryInFlight = true;
  try {
    const report = await activeMediaPeer.getStats();
    const videoStats = selectInboundVideoStats(report);
    if (!videoStats) {
      updateStreamHealth(nowMs, { progress });
      renderStreamTelemetry(nowMs);
      return;
    }

    const nextSample = {
      nowMs,
      framesDecoded: Number(videoStats.framesDecoded ?? 0),
      bytesReceived: Number(videoStats.bytesReceived ?? 0),
      packetsReceived: Number(videoStats.packetsReceived ?? 0),
      packetsLost: Number(videoStats.packetsLost ?? 0),
    };
    let metrics = null;
    if (lastStreamTelemetrySample) {
      const deltaMs = nextSample.nowMs - lastStreamTelemetrySample.nowMs;
      if (deltaMs > 0) {
        const deltaSeconds = deltaMs / 1000;
        const framesDelta = Math.max(0, nextSample.framesDecoded - lastStreamTelemetrySample.framesDecoded);
        const bytesDelta = Math.max(0, nextSample.bytesReceived - lastStreamTelemetrySample.bytesReceived);
        const packetsReceivedDelta = Math.max(0, nextSample.packetsReceived - lastStreamTelemetrySample.packetsReceived);
        const packetsLostDelta = Math.max(0, nextSample.packetsLost - lastStreamTelemetrySample.packetsLost);
        const totalPackets = packetsReceivedDelta + packetsLostDelta;
        metrics = {
          fps: framesDelta / deltaSeconds,
          bitrateKbps: (bytesDelta * 8) / deltaSeconds / 1000,
          lossPercent: totalPackets > 0 ? (packetsLostDelta / totalPackets) * 100 : 0,
        };
      }
    }

    lastStreamTelemetrySample = nextSample;
    if (metrics) {
      currentStreamTelemetryMetrics = {
        ...currentStreamTelemetryMetrics,
        fps: smoothTelemetryMetric(currentStreamTelemetryMetrics.fps, metrics.fps),
        bitrateKbps: smoothTelemetryMetric(currentStreamTelemetryMetrics.bitrateKbps, metrics.bitrateKbps),
        lossPercent: smoothTelemetryMetric(currentStreamTelemetryMetrics.lossPercent, metrics.lossPercent),
      };
    }
    updateStreamHealth(nowMs, { progress, videoStats });
    renderStreamTelemetry(nowMs);
  } catch {
    updateStreamHealth(nowMs, { progress });
    renderStreamTelemetry(nowMs);
  } finally {
    streamTelemetryInFlight = false;
  }
}

function updateStreamDegradedState() {
  streamState.degraded =
    streamState.role === "player"
    && (controlHudMode !== "webrtc" || Boolean(streamState.lastError));
  renderRoomState();
}

function setControlHudMode(mode) {
  if (
    holdWebrtcControlHudDuringStreamResync
    && controlHudMode === "webrtc"
    && mode !== "webrtc"
  ) {
    updateStreamDegradedState();
    renderStreamTelemetry(performance.now(), { force: true });
    return;
  }

  controlHudMode = mode;
  updateStreamDegradedState();
  renderStreamTelemetry(performance.now(), { force: true });
}

function syncControlHudToTransport() {
  if (streamState.role === "spectator") {
    setControlHudMode("idle");
    return;
  }

  if (activeInputChannel?.readyState === "open") {
    setControlHudMode("webrtc");
    return;
  }

  if (transportMode === "http") {
    setControlHudMode("http");
    return;
  }

  if (transportMode === "ws") {
    setControlHudMode("ws");
    return;
  }

  setControlHudMode("idle");
}

function bindRtcChannelLifecycle(channel) {
  if (!channel || typeof channel.addEventListener !== "function") {
    return;
  }

  ["open", "closing", "close", "error"].forEach((eventName) => {
    channel.addEventListener(eventName, () => {
      syncControlHudToTransport();
    });
  });
}

function closeStreamPeer(peer) {
  try {
    peer?.close?.();
  } catch {}
}

function resetStreamingState() {
  streamAttempt += 1;
  closeStreamPeer(activeMediaPeer);
  closeStreamPeer(activeControlPeer);
  activeMediaPeer = null;
  activeControlPeer = null;
  activeControlChannel = null;
  activeInputChannel = null;
  streamRenderer.stop();
  if (remoteVideoEl) {
    remoteVideoEl.srcObject = null;
  }
  Object.assign(streamState, createInitialStreamState());
  setControlHudMode("idle");
  resetStreamDiagnostics(performance.now());
}

async function connectMedia(hostTarget) {
  if (!hostTarget || !remoteVideoEl || typeof globalThis.RTCPeerConnection !== "function") {
    return null;
  }

  return subscribeViaWhep({ hostTarget, videoEl: remoteVideoEl });
}

async function connectStreaming(hostTarget) {
  resetStreamingState();
  const target = String(hostTarget ?? "").trim();
  if (!target) {
    return;
  }

  const currentAttempt = streamAttempt;
  const roomClient = createRoomSessionClient({ hostTarget: target });

  if (roomStatusEl) {
    roomStatusEl.textContent = "joining room";
  }

  try {
    const savedReconnectToken = loadReconnectToken(window.localStorage);
    let joined;
    if (savedReconnectToken) {
      try {
        joined = await roomClient.reconnect({
          playerId: state.client_session_id,
          reconnectToken: savedReconnectToken,
        });
      } catch {
        joined = await roomClient.join({ playerId: state.client_session_id });
      }
    } else {
      joined = await roomClient.join({ playerId: state.client_session_id });
    }

    if (currentAttempt !== streamAttempt) {
      return;
    }

    Object.assign(streamState, joined);
    saveReconnectToken(window.localStorage, joined.reconnectToken);
    updateStreamDegradedState();

    try {
      const mediaPeer = await connectMedia(target);
      if (currentAttempt !== streamAttempt) {
        closeStreamPeer(mediaPeer);
        return;
      }
      activeMediaPeer = mediaPeer;
      streamRenderer.start();
      streamState.lastError = "";
      updateStreamDegradedState();
      resetStreamDiagnostics(performance.now());
    } catch {
      if (currentAttempt !== streamAttempt) {
        return;
      }
      streamState.lastError = "stream unavailable";
      updateStreamDegradedState();
    }

    if (joined.role !== "player") {
      setControlHudMode("idle");
      return;
    }

    if (typeof globalThis.RTCPeerConnection !== "function") {
      setControlHudMode(transportMode === "http" ? "http" : "ws");
      return;
    }

    try {
      const negotiated = await negotiateControlPeer({
        hostTarget: target,
        roomId: joined.roomId,
        playerId: joined.playerId,
        reconnectToken: joined.reconnectToken,
      });
      if (currentAttempt !== streamAttempt) {
        closeStreamPeer(negotiated.peer);
        return;
      }
      activeControlPeer = negotiated.peer;
      activeControlChannel = negotiated.controlChannel ?? null;
      activeInputChannel = negotiated.inputChannel ?? null;
      bindRtcChannelLifecycle(activeControlChannel);
      bindRtcChannelLifecycle(activeInputChannel);
      syncControlHudToTransport();
    } catch {
      if (currentAttempt !== streamAttempt) {
        return;
      }
      setControlHudMode(transportMode === "http" ? "http" : "ws");
    }
  } catch {
    if (currentAttempt !== streamAttempt) {
      return;
    }
    Object.assign(streamState, createInitialStreamState(), { lastError: "join failed" });
    setControlHudMode(transportMode === "http" ? "http" : "idle");
  }
}

function updateHostText() {
  const snapshot = hostDrawerController.snapshot();
  hostEl.textContent = snapshot.hostTarget ? `host: ${snapshot.hostTarget}` : "host: not set";
  document.body.classList.toggle("host-configured", Boolean(snapshot.hostTarget));
}

function formatStickSensitivityValue(sensitivity) {
  return `${Math.round(sensitivity * 100)}%`;
}

function formatControlOpacityValue(controlOpacity) {
  return `${Math.round(controlOpacity * 100)}%`;
}

function deriveActiveControlOpacity(controlOpacity) {
  return Number(clamp(controlOpacity + 0.14, 0.18, 0.72).toFixed(2));
}

function applyStickSensitivitySetting(sensitivity) {
  const responseExponent = getStickResponseExponent(sensitivity);
  stickProcessors.left.setResponseExponent(responseExponent);
  stickProcessors.right.setResponseExponent(responseExponent);

  if (stickSensitivityInputEl) {
    stickSensitivityInputEl.value = String(sensitivity);
  }

  if (stickSensitivityValueEl) {
    stickSensitivityValueEl.textContent = formatStickSensitivityValue(sensitivity);
  }
}

function applyControlOpacitySetting(controlOpacity) {
  if (controlOpacityInputEl) {
    controlOpacityInputEl.value = String(controlOpacity);
  }

  if (controlOpacityValueEl) {
    controlOpacityValueEl.textContent = formatControlOpacityValue(controlOpacity);
  }

  const rootStyle = document.documentElement?.style;
  rootStyle?.setProperty?.("--transparent-control-alpha", String(controlOpacity));
  rootStyle?.setProperty?.("--transparent-control-active-alpha", String(deriveActiveControlOpacity(controlOpacity)));
}

function applyControllerVisibilitySetting(controllerVisible) {
  if (controllerVisibleInputEl) {
    controllerVisibleInputEl.checked = Boolean(controllerVisible);
  }

  if (controllerEl) {
    controllerEl.hidden = !controllerVisible;
    controllerEl.setAttribute("aria-hidden", controllerVisible ? "false" : "true");
  }
}

function applyHudVisibilitySetting(hudVisible) {
  if (hudVisibleInputEl) {
    hudVisibleInputEl.checked = Boolean(hudVisible);
  }

  if (streamTelemetryEl) {
    streamTelemetryEl.hidden = !hudVisible;
  }
}

function buildStreamSettingsUrl(hostTarget) {
  return `http://${hostTarget}/api/stream/settings`;
}

function waitForTimeout(delayMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

async function pollAppliedStreamSettings(hostTarget) {
  for (let attempt = 0; attempt < STREAM_APPLY_POLL_ATTEMPTS; attempt += 1) {
    await waitForTimeout(STREAM_APPLY_POLL_INTERVAL_MS);

    try {
      const response = await fetch(buildStreamSettingsUrl(hostTarget), {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (payload?.applied) {
        return payload;
      }
    } catch {}
  }

  return null;
}

function requestedStreamSettingsFromPayload(payload) {
  return normalizeStreamSettings({
    ...payload,
    ...(payload?.requested ?? {}),
  });
}

function applyStreamSettingsForm(settings = DEFAULT_STREAM_SETTINGS) {
  const normalized = normalizeStreamSettings(settings);
  if (videoWidthInputEl) {
    videoWidthInputEl.value = String(normalized.width);
  }
  if (videoHeightInputEl) {
    videoHeightInputEl.value = String(normalized.height);
  }
  if (videoFpsInputEl) {
    videoFpsInputEl.value = String(normalized.fps);
  }
  if (videoBitrateInputEl) {
    videoBitrateInputEl.value = String(normalized.bitrateKbps);
  }
}

function readStreamSettingsForm() {
  return normalizeStreamSettings({
    width: videoWidthInputEl?.value,
    height: videoHeightInputEl?.value,
    fps: videoFpsInputEl?.value,
    bitrateKbps: videoBitrateInputEl?.value,
  });
}

async function loadStreamSettings(hostTarget) {
  if (!streamSettingsStatusEl) {
    return DEFAULT_STREAM_SETTINGS;
  }

  if (!hostTarget) {
    applyStreamSettingsForm(DEFAULT_STREAM_SETTINGS);
    streamSettingsDirty = false;
    streamSettingsStatusEl.textContent = "";
    return DEFAULT_STREAM_SETTINGS;
  }

  try {
    const response = await fetch(buildStreamSettingsUrl(hostTarget), {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    const payload = await response.json();
    const settings = requestedStreamSettingsFromPayload(payload);
    applyStreamSettingsForm(settings);
    streamSettingsDirty = false;
    streamSettingsStatusEl.textContent = payload.applied ? "stream applied" : "stream profile ready";
    return settings;
  } catch {
    applyStreamSettingsForm(DEFAULT_STREAM_SETTINGS);
    streamSettingsDirty = false;
    streamSettingsStatusEl.textContent = "stream profile unavailable";
    return DEFAULT_STREAM_SETTINGS;
  }
}

async function saveStreamSettings(hostTarget, { force = false } = {}) {
  if (!streamSettingsStatusEl) {
    return;
  }

  if (streamSettingsSavePromise) {
    return streamSettingsSavePromise;
  }

  if (!force && !streamSettingsDirty) {
    return;
  }

  if (!hostTarget) {
    streamSettingsStatusEl.textContent = "Set the host first";
    return;
  }

  const settings = readStreamSettingsForm();
  applyStreamSettingsForm(settings);
  streamSettingsStatusEl.textContent = "saving stream profile";

  streamSettingsSavePromise = (async () => {
    try {
      const response = await fetch(buildStreamSettingsUrl(hostTarget), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.reason || `http_${response.status}`);
      }
      applyStreamSettingsForm(requestedStreamSettingsFromPayload(payload));
      streamSettingsDirty = false;
      if (payload.applied) {
        streamSettingsStatusEl.textContent = "stream applied";
        return;
      }

      streamSettingsStatusEl.textContent = "applying stream profile";
      const appliedPayload = await pollAppliedStreamSettings(hostTarget);
      if (appliedPayload) {
        applyStreamSettingsForm(requestedStreamSettingsFromPayload(appliedPayload));
        streamSettingsDirty = false;
        streamSettingsStatusEl.textContent = "stream applied";
        return;
      }

      streamSettingsStatusEl.textContent = "saved; publisher still reloading";
    } catch {
      streamSettingsDirty = true;
      streamSettingsStatusEl.textContent = "save failed";
    } finally {
      streamSettingsSavePromise = null;
    }
  })();

  return streamSettingsSavePromise;
}

function resolveStreamSettingsHostTarget() {
  const currentInput = normalizeHostTarget(hostTargetInputEl?.value ?? "");
  if (currentInput.ok) {
    return currentInput.value;
  }

  return hostDrawerController.snapshot().hostTarget;
}

function renderHostDrawer(statusMessage = "") {
  const snapshot = hostDrawerController.snapshot();
  hostDrawerEl.classList.toggle("is-open", snapshot.isOpen);
  hostDrawerHandleEl.classList.toggle("is-active", snapshot.isOpen);
  hostDrawerHandleEl.setAttribute("aria-expanded", snapshot.isOpen ? "true" : "false");
  hostDrawerBackdropEl.hidden = !snapshot.isOpen;
  hostDrawerBackdropEl.classList.toggle("is-visible", snapshot.isOpen);
  const draftHostTarget = snapshot.hostTargetDraft || snapshot.hostTarget;
  if (!snapshot.isOpen || !hostDrawerWasOpen) {
    hostTargetInputEl.value = draftHostTarget;
  }
  hostTargetStatusEl.textContent = snapshot.error || statusMessage;
  applyStickSensitivitySetting(snapshot.stickSensitivity);
  applyControlOpacitySetting(snapshot.controlOpacity);
  applyControllerVisibilitySetting(snapshot.controllerVisible);
  applyHudVisibilitySetting(snapshot.hudVisible);
  renderStreamTelemetry(performance.now(), { force: true });
  updateHostText();
  hostDrawerWasOpen = snapshot.isOpen;
}

async function requestImmersiveViewport({ silent = true } = {}) {
  const documentEl = globalThis.document;
  const rootEl = documentEl?.documentElement;

  if (!rootEl || typeof rootEl.requestFullscreen !== "function") {
    if (!silent) {
      hostTargetStatusEl.textContent = "fullscreen unavailable";
    }
    return false;
  }

  if (documentEl.fullscreenElement || immersiveRequestInFlight) {
    return Boolean(documentEl.fullscreenElement);
  }

  immersiveRequestInFlight = true;
  try {
    await rootEl.requestFullscreen({ navigationUI: "hide" });
    try {
      await globalThis.screen?.orientation?.lock?.("landscape");
    } catch {}
    if (!silent) {
      hostTargetStatusEl.textContent = "";
    }
    return true;
  } catch {
    try {
      await rootEl.requestFullscreen();
      try {
        await globalThis.screen?.orientation?.lock?.("landscape");
      } catch {}
      if (!silent) {
        hostTargetStatusEl.textContent = "";
      }
      return true;
    } catch {
      if (!silent) {
        hostTargetStatusEl.textContent = "fullscreen unavailable";
      }
      return false;
    }
  } finally {
    immersiveRequestInFlight = false;
  }
}

async function requestFullscreenPlayback() {
  await requestImmersiveViewport({ silent: false });
}

async function resyncActiveStreaming(reason = "resume", { observedAtMs = performance.now() } = {}) {
  const hostTarget = getConfiguredHostTarget();
  if (!hostTarget || streamResyncInFlight) {
    return;
  }

  const nowMs = observedAtMs;
  if ((nowMs - lastStreamResyncAt) < STREAM_RESYNC_COOLDOWN_MS) {
    return;
  }

  streamResyncInFlight = true;
  lastStreamResyncAt = nowMs;
  const preserveWebrtcControlHud = reason === "stale" && controlHudMode === "webrtc";
  if (preserveWebrtcControlHud) {
    holdWebrtcControlHudDuringStreamResync = true;
  }
  if (reason === "stale") {
    streamHealthRecoveryHudUntil = nowMs + Math.max(STREAM_TELEMETRY_POLL_MS, STREAM_RESYNC_COOLDOWN_MS);
  }
  streamState.lastError = reason === "stale" ? "resyncing stream" : "";
  updateStreamDegradedState();
  closeSocketAndReconnectTimer();
  connectWS();

  try {
    await connectStreaming(hostTarget);
  } finally {
    streamResyncInFlight = false;
    resetStreamDiagnostics(performance.now());
    if (preserveWebrtcControlHud) {
      holdWebrtcControlHudDuringStreamResync = false;
    }
  }
}

function markStreamSettingsPending() {
  if (!streamSettingsStatusEl) {
    return;
  }

  const hostTarget = resolveStreamSettingsHostTarget();
  if (!hostTarget) {
    streamSettingsStatusEl.textContent = "Set the host first";
    return;
  }

  streamSettingsDirty = true;
  streamSettingsStatusEl.textContent = "stream profile edited";
}

function getWsUrl() {
  return remoteEndpoints?.wsUrl ?? "";
}

function getHttpUrl() {
  return remoteEndpoints?.httpUrl ?? "";
}

function closeSocketAndReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    suppressNextReconnect = true;
    try {
      ws.close();
    } catch {}
    ws = null;
  }
}

function renderLatency(nowMs = performance.now()) {
  if (!latencyEl || latencyEl.hidden) {
    return;
  }
  const displayValue = latencyTracker.getDisplayValue(nowMs);
  latencyEl.textContent = displayValue;
  latencyEl.classList.toggle("is-stale", displayValue === "--");
}

function maybeResyncStaleStream(nowMs) {
  if (
    !activeMediaPeer
    || streamResyncInFlight
    || globalThis.document?.visibilityState === "hidden"
  ) {
    return;
  }

  updateStreamHealth(nowMs, { progress: readVideoProgress(remoteVideoEl) });
}

function applyResponsiveLayout() {
  const metrics = computeLayoutMetrics({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const root = document.documentElement;

  root.style.setProperty("--face-size", `${metrics.faceSize}px`);
  root.style.setProperty("--small-size", `${metrics.smallSize}px`);
  root.style.setProperty("--meta-size", `${metrics.metaSize}px`);
  root.style.setProperty("--shoulder-width", `${metrics.shoulderWidth}px`);
  root.style.setProperty("--shoulder-height", `${metrics.shoulderHeight}px`);
  root.style.setProperty("--stick-size", `${metrics.stickSize}px`);
  root.style.setProperty("--trigger-width", `${metrics.triggerWidth}px`);
  root.style.setProperty("--trigger-height", `${metrics.triggerHeight}px`);
  root.style.setProperty("--controller-gap-x", `${metrics.gapX}px`);
  root.style.setProperty("--controller-gap-y", `${metrics.gapY}px`);
  root.style.setProperty("--controller-pad-top-extra", `${metrics.padTop}px`);
  root.style.setProperty("--left-meta-column", metrics.leftMetaColumn);
  root.style.setProperty("--right-meta-column", metrics.rightMetaColumn);
  root.style.setProperty("--left-meta-row", metrics.leftMetaRow);
  root.style.setProperty("--right-meta-row", metrics.rightMetaRow);
  root.style.setProperty("--trigger-label-side-offset", metrics.triggerLabelSideOffset);
  root.style.setProperty("--face-cluster-scale", `${metrics.faceClusterScale}`);

  controllerEl.dataset.layout = metrics.layoutMode;
  document.body.dataset.layout = metrics.layoutMode;
}

function requestResponsiveLayout() {
  if (layoutInteractionLock.requestApply()) {
    applyResponsiveLayout();
  }
}

function markDirty(priority = false) {
  transmitter.markDirty(priority);
}

const activeGameplayTouchIds = new Set();

function extractTouchIdentifiers(event) {
  return Array.from(event?.changedTouches ?? [], (touch) => String(touch.identifier));
}

function rememberGameplayTouches(event) {
  const identifiers = extractTouchIdentifiers(event);
  if (identifiers.length === 0) {
    activeGameplayTouchIds.add("generic");
    return;
  }

  identifiers.forEach((identifier) => {
    activeGameplayTouchIds.add(identifier);
  });
}

function clearGameplayTouches(event) {
  const identifiers = extractTouchIdentifiers(event);
  if (identifiers.length === 0) {
    activeGameplayTouchIds.clear();
    return;
  }

  identifiers.forEach((identifier) => {
    activeGameplayTouchIds.delete(identifier);
  });

  if (activeGameplayTouchIds.size === 1 && activeGameplayTouchIds.has("generic")) {
    activeGameplayTouchIds.clear();
  }
}

function hasTrackedGameplayTouch(event) {
  if (activeGameplayTouchIds.has("generic")) {
    return true;
  }

  const identifiers = extractTouchIdentifiers(event);
  if (identifiers.length === 0) {
    return activeGameplayTouchIds.size > 0;
  }

  return identifiers.some((identifier) => activeGameplayTouchIds.has(identifier));
}

function trapGameplayTouchGesture(event, phase = "move") {
  if (phase === "start") {
    rememberGameplayTouches(event);
  } else if (phase === "end") {
    clearGameplayTouches(event);
  }

  if (event?.cancelable !== false) {
    event.preventDefault?.();
  }
  event.stopPropagation?.();
}

function bindGameplayTouchShield(element) {
  if (!element || typeof element.addEventListener !== "function") {
    return;
  }

  element.addEventListener("touchstart", (event) => trapGameplayTouchGesture(event, "start"), { passive: false });
  element.addEventListener("touchmove", (event) => trapGameplayTouchGesture(event, "move"), { passive: false });
  element.addEventListener("touchend", (event) => trapGameplayTouchGesture(event, "end"), { passive: false });
  element.addEventListener("touchcancel", (event) => trapGameplayTouchGesture(event, "end"), { passive: false });
}

function bindDocumentGameplayTouchShield(rootEl) {
  const documentEl = globalThis.document;
  if (!rootEl || !documentEl || typeof documentEl.addEventListener !== "function") {
    return;
  }

  const targetIsWithinRoot = (target) => {
    if (!target || target === rootEl) {
      return target === rootEl;
    }

    if (typeof rootEl.contains === "function") {
      return rootEl.contains(target);
    }

    return false;
  };

  documentEl.addEventListener("touchstart", (event) => {
    if (!targetIsWithinRoot(event.target) && !hasTrackedGameplayTouch(event)) {
      return;
    }
    trapGameplayTouchGesture(event, "start");
  }, { capture: true, passive: false });

  documentEl.addEventListener("touchmove", (event) => {
    if (!targetIsWithinRoot(event.target) && !hasTrackedGameplayTouch(event)) {
      return;
    }
    trapGameplayTouchGesture(event, "move");
  }, { capture: true, passive: false });

  ["touchend", "touchcancel"].forEach((eventName) => {
    documentEl.addEventListener(eventName, (event) => {
      if (!targetIsWithinRoot(event.target) && !hasTrackedGameplayTouch(event)) {
        return;
      }
      trapGameplayTouchGesture(event, "end");
    }, { capture: true, passive: false });
  });
}

function updateButton(key, pressed, el) {
  if (state.buttons[key] === pressed) {
    return;
  }

  state.buttons[key] = pressed;
  el?.classList.toggle("on", pressed);
  markDirty(true);
}

function bindHoldButton(el, key) {
  const press = () => updateButton(key, true, el);
  const release = () => updateButton(key, false, el);
  const interaction = new LayoutGestureLease(layoutInteractionLock);

  el.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    requestImmersiveViewport();
    el.setPointerCapture(event.pointerId);
    interaction.begin();
    press();
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
    el.addEventListener(type, (event) => {
      event.preventDefault();
      release();
      if (interaction.end()) {
        applyResponsiveLayout();
      }
    });
  });

  el.addEventListener("contextmenu", (event) => event.preventDefault());
  el.addEventListener("click", (event) => {
    event.preventDefault();
    el.blur();
  });
}

function getCoalescedPointerEvent(event) {
  if (typeof event.getCoalescedEvents !== "function") {
    return event;
  }

  const coalesced = event.getCoalescedEvents();
  return coalesced.length > 0 ? coalesced[coalesced.length - 1] : event;
}

function setStickState(stickKey, knob, vector, radiusPx) {
  state.sticks[stickKey].nx = vector.x;
  state.sticks[stickKey].ny = vector.y;
  knob.style.transform = `translate(${Math.round(vector.x * radiusPx)}px, ${Math.round(-vector.y * radiusPx)}px)`;
}

function bindStick(stickEl, stickKey, processor) {
  const knob = stickEl.querySelector(".stick-knob");
  const interaction = new LayoutGestureLease(layoutInteractionLock);
  let activePointerId = null;
  let activeFrame = null;

  const visualRadius = () => Math.min(stickEl.clientWidth, stickEl.clientHeight) * 0.26;

  const reset = () => {
    activePointerId = null;
    activeFrame = null;
    processor.reset();
    setStickState(stickKey, knob, { x: 0, y: 0 }, visualRadius());
    markDirty(true);
    if (interaction.end()) {
      applyResponsiveLayout();
    }
  };

  const updateFromPointer = (event) => {
    const sample = getCoalescedPointerEvent(event);
    if (!activeFrame) {
      const radiusPx = Math.min(stickEl.clientWidth, stickEl.clientHeight) * 0.34;
      activeFrame = createStickFrame(stickEl.getBoundingClientRect(), radiusPx);
    }
    const vector = vectorFromFrame(sample.clientX, sample.clientY, activeFrame);
    const output = processor.sampleVector({
      x: vector.x,
      y: vector.y,
      now: performance.now(),
    });
    setStickState(stickKey, knob, output.display, visualRadius());
    markDirty(false);
  };

  stickEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    requestImmersiveViewport();
    activePointerId = event.pointerId;
    interaction.begin();
    activeFrame = createStickFrame(
      stickEl.getBoundingClientRect(),
      Math.min(stickEl.clientWidth, stickEl.clientHeight) * 0.34,
    );
    stickEl.setPointerCapture(activePointerId);
    updateFromPointer(event);
  });

  stickEl.addEventListener("pointermove", (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    event.preventDefault();
    updateFromPointer(event);
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
    stickEl.addEventListener(type, (event) => {
      if (activePointerId !== null && event.pointerId !== activePointerId && type !== "lostpointercapture") {
        return;
      }
      event.preventDefault();
      reset();
    });
  });
}

function setTriggerState(triggerKey, control, value) {
  const nextValue = clamp01(value);
  if (Math.abs(state.triggers[triggerKey] - nextValue) < 0.0001) {
    return;
  }

  state.triggers[triggerKey] = nextValue;
  control.style.setProperty("--trigger-value", `${nextValue}`);
  control.classList.toggle("on", nextValue > 0.02);
  markDirty(nextValue === 0 || nextValue >= 0.95);
}

function bindTrigger(control, triggerKey) {
  const interaction = new LayoutGestureLease(layoutInteractionLock);
  let activePointerId = null;
  let activeRect = null;

  const readValue = (event) => {
    const sample = getCoalescedPointerEvent(event);
    const rect = activeRect || control.getBoundingClientRect();
    const ratio = 1 - ((sample.clientY - rect.top) / rect.height);
    return clamp(ratio, 0, 1);
  };

  const reset = () => {
    activePointerId = null;
    activeRect = null;
    setTriggerState(triggerKey, control, 0);
    if (interaction.end()) {
      applyResponsiveLayout();
    }
  };

  const update = (event) => {
    const value = readValue(event);
    setTriggerState(triggerKey, control, value);
  };

  control.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    requestImmersiveViewport();
    activePointerId = event.pointerId;
    activeRect = control.getBoundingClientRect();
    interaction.begin();
    control.setPointerCapture(activePointerId);
    update(event);
  });

  control.addEventListener("pointermove", (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    event.preventDefault();
    update(event);
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
    control.addEventListener(type, (event) => {
      if (activePointerId !== null && event.pointerId !== activePointerId && type !== "lostpointercapture") {
        return;
      }
      event.preventDefault();
      reset();
    });
  });
}

async function sendHttpFallback(nowMs) {
  const httpUrl = getHttpUrl();
  if (!httpUrl) {
    updateConnectionText("WS: host not set");
    clearSlot("idle");
    setControlHudMode("idle");
    return false;
  }

  if (httpSending) {
    httpQueued = true;
    return false;
  }

  const payload = transmitter.createPayload(nowMs);
  if (!payload) {
    return false;
  }

  httpSending = true;
  transportMode = "http";
  syncControlHudToTransport();
  const requestStartedAt = performance.now();

  try {
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload.serialized,
      keepalive: true,
      cache: "no-store",
    });

    if (response.ok) {
      const message = await response.json();
      if (Number.isInteger(message.slot)) {
        updateSlot(message.slot, "http");
      }
      latencyTracker.noteRoundTrip(performance.now() - requestStartedAt, performance.now());
      renderLatency(performance.now());
      transmitter.commit(payload, nowMs);
    }
  } catch {
    updateConnectionText("WS: reconnecting, HTTP fallback unavailable");
  } finally {
    httpSending = false;
    if (httpQueued) {
      httpQueued = false;
      void sendHttpFallback(performance.now());
    }
  }

  return true;
}

function scheduleReconnect(delayMs = 900) {
  if (reconnectTimer !== null) {
    return;
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, delayMs);
}

function connectWS() {
  const url = getWsUrl();
  if (!url) {
    transportMode = "ws";
    updateConnectionText("WS: host not set");
    clearSlot("idle");
    setControlHudMode("idle");
    return;
  }

  clearSlot("ws");
  updateConnectionText(`WS: connecting ${url}`);

  try {
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener("open", () => {
      transportMode = "ws";
      lastPingSentAt = -Infinity;
      updateConnectionText("WS: connected");
      syncControlHudToTransport();
      markDirty(true);
    });

    socket.addEventListener("close", () => {
      if (ws === socket) {
        ws = null;
      }

      if (suppressNextReconnect) {
        suppressNextReconnect = false;
        return;
      }

      transportMode = "http";
      updateConnectionText("WS: closed, HTTP fallback active");
      clearSlot("http");
      syncControlHudToTransport();
      renderLatency(performance.now());
      scheduleReconnect(900);
    });

    socket.addEventListener("error", () => {
      transportMode = "http";
      updateConnectionText("WS: error, HTTP fallback active");
      clearSlot("http");
      syncControlHudToTransport();
      renderLatency(performance.now());
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "slot" && Number.isInteger(message.slot)) {
          updateSlot(message.slot, "ws");
        } else if (message.type === "pong" && Number.isFinite(message.client_sent_at_ms)) {
          latencyTracker.noteRoundTrip(performance.now() - Number(message.client_sent_at_ms), performance.now());
          renderLatency(performance.now());
        }
      } catch {}
    });
  } catch (error) {
    updateConnectionText(`WS ctor error: ${error?.message || "unknown"}`);
    scheduleReconnect(1200);
    return;
  }
}

function maybeSendWsPing(nowMs) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  if ((nowMs - lastPingSentAt) < 1000) {
    return;
  }

  lastPingSentAt = nowMs;
  ws.send(JSON.stringify({ type: "ping", client_sent_at_ms: Math.round(nowMs) }));
}

function transportLoop(nowMs) {
  maybeSendWsPing(nowMs);
  const flushTransport = transmitter.tryFlush(nowMs);
  if (!flushTransport && activeInputChannel?.readyState !== "open" && (!ws || ws.readyState !== WebSocket.OPEN)) {
    void sendHttpFallback(nowMs);
  }

  updateLocalVideoTelemetry(nowMs);
  renderLatency(nowMs);
  void pollStreamTelemetry(nowMs);
  maybeResyncStaleStream(nowMs);
  window.requestAnimationFrame(transportLoop);
}

const gameplayButtons = [...document.querySelectorAll("[data-btn]")];

bindGameplayTouchShield(controllerEl);
bindGameplayTouchShield(leftStickEl);
bindGameplayTouchShield(rightStickEl);
bindGameplayTouchShield(leftTriggerEl);
bindGameplayTouchShield(rightTriggerEl);
bindDocumentGameplayTouchShield(controllerEl);

gameplayButtons.forEach((element) => {
  bindGameplayTouchShield(element);
  bindHoldButton(element, element.dataset.btn);
});

bindStick(leftStickEl, "left", stickProcessors.left);
bindStick(rightStickEl, "right", stickProcessors.right);
bindTrigger(leftTriggerEl, "lt");
bindTrigger(rightTriggerEl, "rt");

window.addEventListener("resize", requestResponsiveLayout);
window.addEventListener("orientationchange", () => window.setTimeout(requestResponsiveLayout, 60));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    appWasHidden = true;
    return;
  }

  if (appWasHidden) {
    appWasHidden = false;
    void resyncActiveStreaming("visibility");
  }
});
window.addEventListener("focus", () => {
  if (document.visibilityState !== "hidden" && appWasHidden) {
    appWasHidden = false;
    void resyncActiveStreaming("focus");
  }
});
window.addEventListener("pageshow", (event) => {
  if (event?.persisted || appWasHidden) {
    appWasHidden = false;
    void resyncActiveStreaming("pageshow");
  }
});
window.addEventListener("pagehide", () => {
  appWasHidden = true;
  const httpUrl = getHttpUrl();
  if (!httpUrl) {
    return;
  }

  const payload = createPacketSnapshot(
    {
      ...state,
      buttons: Object.fromEntries(Object.keys(state.buttons).map((key) => [key, false])),
      sticks: {
        left: { nx: 0, ny: 0 },
        right: { nx: 0, ny: 0 },
      },
      triggers: { lt: 0, rt: 0 },
    },
    transmitter.sequence + 1,
    performance.now(),
  );

  navigator.sendBeacon?.(httpUrl, new Blob([JSON.stringify(payload)], { type: "application/json" }));
});

hostDrawerHandleEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  hostDrawerController.open();
  renderHostDrawer();
  hostTargetInputEl.focus();
  hostTargetInputEl.select();
});

hostDrawerBackdropEl.addEventListener("click", () => {
  hostDrawerController.close();
  renderHostDrawer();
});

hostTargetInputEl?.addEventListener("input", () => {
  hostDrawerController.updateHostDraft(hostTargetInputEl.value);
  renderHostDrawer();
});

stickSensitivityInputEl?.addEventListener("input", () => {
  const result = hostDrawerController.updateStickSensitivity(stickSensitivityInputEl.value);
  if (!result.ok) {
    renderHostDrawer();
    return;
  }

  renderHostDrawer();
});

controlOpacityInputEl?.addEventListener("input", () => {
  const result = hostDrawerController.updateControlOpacity(controlOpacityInputEl.value);
  if (!result.ok) {
    renderHostDrawer();
    return;
  }

  renderHostDrawer();
});

controllerVisibleInputEl?.addEventListener("input", () => {
  const result = hostDrawerController.updateControllerVisible(controllerVisibleInputEl.checked);
  if (!result.ok) {
    renderHostDrawer();
    return;
  }

  renderHostDrawer();
});

hudVisibleInputEl?.addEventListener("input", () => {
  const result = hostDrawerController.updateHudVisible(hudVisibleInputEl.checked);
  if (!result.ok) {
    renderHostDrawer();
    return;
  }

  renderHostDrawer();
});

hostTargetFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  requestImmersiveViewport();
  const result = hostDrawerController.submit(hostTargetInputEl.value);
  if (!result.ok) {
    renderHostDrawer();
    return;
  }

  remoteEndpoints = result.endpoints;
  renderHostDrawer("saved");
  closeSocketAndReconnectTimer();
  connectWS();
  void loadStreamSettings(result.hostTarget);
  void connectStreaming(result.hostTarget);
});

[
  videoWidthInputEl,
  videoHeightInputEl,
  videoFpsInputEl,
  videoBitrateInputEl,
].forEach((element) => {
  element?.addEventListener("input", () => {
    markStreamSettingsPending();
  });

  element?.addEventListener("blur", () => {
    void saveStreamSettings(resolveStreamSettingsHostTarget());
  });
});

streamSettingsSaveEl?.addEventListener("click", () => {
  void saveStreamSettings(resolveStreamSettingsHostTarget(), { force: true });
});

fullscreenPlaybackEl?.addEventListener("click", (event) => {
  event.preventDefault();
  void requestFullscreenPlayback();
});

applyResponsiveLayout();
updateHostText();
renderHostDrawer();
applyStreamSettingsForm(DEFAULT_STREAM_SETTINGS);
streamSettingsDirty = false;
renderRoomState();
if (latencyEl) {
  latencyEl.hidden = true;
}
void requestImmersiveViewport();
connectWS();
void loadStreamSettings(hostDrawerController.hostTarget);
void connectStreaming(hostDrawerController.hostTarget);
renderLatency(performance.now());
window.requestAnimationFrame(transportLoop);

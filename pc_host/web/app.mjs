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
  getStickResponseExponent,
  HostDrawerController,
} from "./host-config.mjs";
import { computeLayoutMetrics } from "./layout-core.mjs";

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
const hostTargetStatusEl = document.getElementById("hostTargetStatus");
const controllerEl = document.querySelector(".controller");

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

const transmitter = new LatestStateTransmitter({
  getSocket: () => ws,
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
  slotEl.textContent = `slot: ${slot} mode:${mode}`;
}

function clearSlot(mode = transportMode) {
  updateSlot("-", mode);
}

function updateHostText() {
  const snapshot = hostDrawerController.snapshot();
  hostEl.textContent = snapshot.hostTarget ? `host: ${snapshot.hostTarget}` : "host: not set";
  document.body.classList.toggle("host-configured", Boolean(snapshot.hostTarget));
}

function formatStickSensitivityValue(sensitivity) {
  return `${Math.round(sensitivity * 100)}%`;
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

function renderHostDrawer(statusMessage = "") {
  const snapshot = hostDrawerController.snapshot();
  hostDrawerEl.classList.toggle("is-open", snapshot.isOpen);
  hostDrawerHandleEl.classList.toggle("is-active", snapshot.isOpen);
  hostDrawerHandleEl.setAttribute("aria-expanded", snapshot.isOpen ? "true" : "false");
  hostDrawerBackdropEl.hidden = !snapshot.isOpen;
  hostDrawerBackdropEl.classList.toggle("is-visible", snapshot.isOpen);
  hostTargetInputEl.value = snapshot.isOpen ? hostTargetInputEl.value || snapshot.hostTarget : snapshot.hostTarget;
  hostTargetStatusEl.textContent = snapshot.error || statusMessage;
  applyStickSensitivitySetting(snapshot.stickSensitivity);
  updateHostText();
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
  const displayValue = latencyTracker.getDisplayValue(nowMs);
  latencyEl.textContent = displayValue;
  latencyEl.classList.toggle("is-stale", displayValue === "--");
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
      renderLatency(performance.now());
      scheduleReconnect(900);
    });

    socket.addEventListener("error", () => {
      transportMode = "http";
      updateConnectionText("WS: error, HTTP fallback active");
      clearSlot("http");
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
  const sentByWs = transmitter.tryFlush(nowMs);
  if (!sentByWs && (!ws || ws.readyState !== WebSocket.OPEN)) {
    void sendHttpFallback(nowMs);
  }

  renderLatency(nowMs);
  window.requestAnimationFrame(transportLoop);
}

document.querySelectorAll("[data-btn]").forEach((element) => {
  bindHoldButton(element, element.dataset.btn);
});

bindStick(document.getElementById("leftStick"), "left", stickProcessors.left);
bindStick(document.getElementById("rightStick"), "right", stickProcessors.right);
bindTrigger(document.getElementById("leftTrigger"), "lt");
bindTrigger(document.getElementById("rightTrigger"), "rt");

window.addEventListener("resize", requestResponsiveLayout);
window.addEventListener("orientationchange", () => window.setTimeout(requestResponsiveLayout, 60));
window.addEventListener("pagehide", () => {
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

stickSensitivityInputEl?.addEventListener("input", () => {
  const result = hostDrawerController.updateStickSensitivity(stickSensitivityInputEl.value);
  if (!result.ok) {
    renderHostDrawer();
    return;
  }

  renderHostDrawer();
});

hostTargetFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const result = hostDrawerController.submit(hostTargetInputEl.value);
  if (!result.ok) {
    renderHostDrawer();
    return;
  }

  remoteEndpoints = result.endpoints;
  renderHostDrawer("saved");
  closeSocketAndReconnectTimer();
  connectWS();
});

applyResponsiveLayout();
updateHostText();
renderHostDrawer();
connectWS();
renderLatency(performance.now());
window.requestAnimationFrame(transportLoop);

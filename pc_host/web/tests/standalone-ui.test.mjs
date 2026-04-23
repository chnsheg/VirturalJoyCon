import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function extractCssRule(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`, "m"));
  assert.ok(match, `missing css rule for ${selectorPattern}`);
  return match[1];
}

function extractCssPixelVar(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*(\\d+)px;`));
  assert.ok(match, `missing css pixel var ${name}`);
  return Number(match[1]);
}

function createStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

class MockClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    if (force === undefined) {
      if (this.values.has(name)) {
        this.values.delete(name);
        return false;
      }
      this.values.add(name);
      return true;
    }

    if (force) {
      this.values.add(name);
      return true;
    }

    this.values.delete(name);
    return false;
  }

  contains(name) {
    return this.values.has(name);
  }

  remove(name) {
    this.values.delete(name);
  }
}

class MockElement {
  constructor({ dataset = {}, children = {}, width = 200, height = 200 } = {}) {
    this.dataset = { ...dataset };
    this.children = children;
    this.clientWidth = width;
    this.clientHeight = height;
    this.classList = new MockClassList();
    this.style = {
      values: new Map(),
      setProperty: (name, value) => {
        this.style.values.set(name, value);
      },
    };
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = "";
    this._innerHTML = "";
    this.innerHTMLUpdates = 0;
    this.value = "";
    this.checked = false;
    this.attributes = new Map();
  }

  addEventListener(type, listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({
        preventDefault() {},
        ...event,
      });
    }
  }

  querySelector(selector) {
    return this.children[selector] ?? null;
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: this.clientWidth,
      height: this.clientHeight,
      right: this.clientWidth,
      bottom: this.clientHeight,
    };
  }

  setPointerCapture() {}

  blur() {}

  focus() {}

  select() {}

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.innerHTMLUpdates += 1;
    this.textContent = this._innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function createMockCanvasElement() {
  const element = new MockElement({ width: 1280, height: 720 });
  element.width = 1280;
  element.height = 720;
  element.drawCalls = [];
  element.getContext = (type) => {
    if (type !== "2d") {
      return null;
    }

    return {
      filter: "none",
      clearRect() {},
      drawImage(...args) {
        element.drawCalls.push(args);
      },
      save() {},
      restore() {},
      setTransform() {},
      fillRect() {},
    };
  };
  return element;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.listeners = new Map();
    this.sentPackets = [];
  }

  addEventListener(type, listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close");
  }

  serverClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close");
  }

  send(payload) {
    this.sentPackets.push(JSON.parse(payload));
  }
}

function installAppHarness({
  savedHostTarget,
  savedStickSensitivity,
  savedControlOpacity,
  savedControllerVisible,
  savedHudVisible,
  savedReconnectToken,
  fakeLocationHost = "example.invalid",
  enableRtc = false,
  fetchImpl = null,
  rtcGetStatsImpl = null,
  performanceStepMs = null,
}) {
  const originalGlobals = new Map();
  for (const key of [
    "window",
    "document",
    "navigator",
    "fetch",
    "WebSocket",
    "RTCPeerConnection",
    "location",
    "screen",
    "performance",
  ]) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  const connEl = new MockElement();
  const slotEl = new MockElement();
  const latencyEl = new MockElement();
  const hostEl = new MockElement();
  const hostDrawerEl = new MockElement();
  const hostDrawerHandleEl = new MockElement();
  const hostDrawerBackdropEl = new MockElement();
  const hostTargetFormEl = new MockElement();
  const hostTargetInputEl = new MockElement();
  const hostTargetStatusEl = new MockElement();
  const stickSensitivityInputEl = new MockElement();
  const stickSensitivityValueEl = new MockElement();
  const controlOpacityInputEl = new MockElement();
  const controlOpacityValueEl = new MockElement();
  const controllerVisibleInputEl = new MockElement();
  const hudVisibleInputEl = new MockElement();
  const remoteVideoEl = new MockElement();
  remoteVideoEl.play = async () => undefined;
  remoteVideoEl.readyState = 4;
  remoteVideoEl.videoWidth = 1920;
  remoteVideoEl.videoHeight = 1080;
  remoteVideoEl.currentTime = 0;
  let playbackFrameCount = 0;
  remoteVideoEl.getVideoPlaybackQuality = () => {
    playbackFrameCount += 60;
    remoteVideoEl.currentTime += 1;
    return { totalVideoFrames: playbackFrameCount };
  };
  remoteVideoEl.requestVideoFrameCallback = (callback) => {
    videoFrameCallbacks.push(callback);
    return videoFrameCallbacks.length;
  };
  remoteVideoEl.cancelVideoFrameCallback = (handle) => {
    if (handle > 0 && handle <= videoFrameCallbacks.length) {
      videoFrameCallbacks[handle - 1] = null;
    }
  };
  const streamBackdropCanvasEl = createMockCanvasElement();
  const streamCanvasEl = createMockCanvasElement();
  const roomStatusEl = new MockElement();
  const transportModeEl = new MockElement();
  const streamTelemetryEl = new MockElement();
  const fullscreenPlaybackEl = new MockElement();
  const videoWidthInputEl = new MockElement();
  const videoHeightInputEl = new MockElement();
  const videoFpsInputEl = new MockElement();
  const videoBitrateInputEl = new MockElement();
  const streamSettingsSaveEl = new MockElement();
  const streamSettingsStatusEl = new MockElement();
  const controllerEl = new MockElement();
  const leftTriggerEl = new MockElement();
  const rightTriggerEl = new MockElement();
  const leftStickKnobEl = new MockElement();
  const rightStickKnobEl = new MockElement();
  const leftStickEl = new MockElement({ children: { ".stick-knob": leftStickKnobEl } });
  const rightStickEl = new MockElement({ children: { ".stick-knob": rightStickKnobEl } });

  const buttonIds = [
    "a",
    "b",
    "x",
    "y",
    "lb",
    "rb",
    "select",
    "start",
    "dpad_up",
    "dpad_down",
    "dpad_left",
    "dpad_right",
    "ls",
    "rs",
  ];
  const buttonElements = buttonIds.map((buttonId) => new MockElement({ dataset: { btn: buttonId } }));

  const idMap = new Map([
    ["conn", connEl],
    ["slot", slotEl],
    ["latency", latencyEl],
    ["host", hostEl],
    ["hostDrawer", hostDrawerEl],
    ["hostDrawerHandle", hostDrawerHandleEl],
    ["hostDrawerBackdrop", hostDrawerBackdropEl],
    ["hostTargetForm", hostTargetFormEl],
    ["hostTargetInput", hostTargetInputEl],
    ["hostTargetStatus", hostTargetStatusEl],
    ["stickSensitivityInput", stickSensitivityInputEl],
    ["stickSensitivityValue", stickSensitivityValueEl],
    ["controlOpacityInput", controlOpacityInputEl],
    ["controlOpacityValue", controlOpacityValueEl],
    ["controllerVisibleInput", controllerVisibleInputEl],
    ["hudVisibleInput", hudVisibleInputEl],
    ["remoteVideo", remoteVideoEl],
    ["streamBackdropCanvas", streamBackdropCanvasEl],
    ["streamCanvas", streamCanvasEl],
    ["roomStatus", roomStatusEl],
    ["transportMode", transportModeEl],
    ["streamTelemetry", streamTelemetryEl],
    ["fullscreenPlayback", fullscreenPlaybackEl],
    ["videoWidthInput", videoWidthInputEl],
    ["videoHeightInput", videoHeightInputEl],
    ["videoFpsInput", videoFpsInputEl],
    ["videoBitrateInput", videoBitrateInputEl],
    ["streamSettingsSave", streamSettingsSaveEl],
    ["streamSettingsStatus", streamSettingsStatusEl],
    ["leftTrigger", leftTriggerEl],
    ["rightTrigger", rightTriggerEl],
    ["leftStick", leftStickEl],
    ["rightStick", rightStickEl],
  ]);

  const timers = new Map();
  let nextTimerId = 1;
  const webSockets = [];
  const fetchCalls = [];
  const animationFrameCallbacks = [];
  const videoFrameCallbacks = [];
  const fullscreenRequests = [];
  const orientationLocks = [];
  let syntheticNowMs = 0;
  const frameTimeOrigin = performance.now();

  function defaultFetch(url, init = {}) {
    if (String(url).includes("/api/room/join")) {
      return {
        ok: true,
        async json() {
          return {
            room_id: "living-room",
            player_id: "uuid-fixed",
            role: "player",
            seat_index: 1,
            seat_epoch: 1,
            reconnect_token: "reconnect-fixed",
          };
        },
      };
    }

    if (String(url).includes("/api/control/offer")) {
      return {
        ok: true,
        async json() {
          return {
            type: "answer",
            sdp: "control-answer",
          };
        },
      };
    }

    if (String(url).includes("/api/stream/settings")) {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            width: 1280,
            height: 720,
            fps: 60,
            bitrateKbps: 6000,
            applied: false,
          };
        },
      };
    }

    return {
      ok: true,
      async json() {
        return {};
      },
      async text() {
        return "v=0\r\n";
      },
    };
  }

  const document = {
    listeners: new Map(),
    visibilityState: "visible",
    fullscreenElement: null,
    body: {
      classList: new MockClassList(),
      dataset: {},
    },
    documentElement: {
      style: {
        values: new Map(),
        setProperty(name, value) {
          this.values.set(name, value);
        },
      },
      async requestFullscreen(options) {
        fullscreenRequests.push(options ?? {});
        document.fullscreenElement = document.documentElement;
      },
    },
    getElementById(id) {
      return idMap.get(id) ?? null;
    },
    addEventListener(type, listener) {
      const existing = this.listeners.get(type) ?? [];
      existing.push(listener);
      this.listeners.set(type, existing);
    },
    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({
          preventDefault() {},
          stopPropagation() {},
          ...event,
        });
      }
    },
    querySelector(selector) {
      if (selector === ".controller") {
        return controllerEl;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-btn]") {
        return buttonElements;
      }
      return [];
    },
  };

  const windowListeners = new Map();
  const location = {
    host: fakeLocationHost,
    hostname: fakeLocationHost.split(":")[0],
    href: `https://${fakeLocationHost}/remote`,
    origin: `https://${fakeLocationHost}`,
    protocol: "https:",
  };
  const window = {
    document,
    localStorage: createStorage({
      joycon_host_target: savedHostTarget,
      joycon_stick_sensitivity: savedStickSensitivity,
      joycon_control_opacity: savedControlOpacity,
      joycon_controller_visible: savedControllerVisible,
      joycon_hud_visible: savedHudVisible,
      joycon_stream_reconnect_token: savedReconnectToken,
    }),
    sessionStorage: createStorage(),
    location,
    crypto: {
      randomUUID() {
        return "uuid-fixed";
      },
    },
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener(type, listener) {
      const existing = windowListeners.get(type) ?? [];
      existing.push(listener);
      windowListeners.set(type, existing);
    },
    removeEventListener() {},
    dispatch(type, event = {}) {
      for (const listener of windowListeners.get(type) ?? []) {
        listener({
          preventDefault() {},
          stopPropagation() {},
          ...event,
        });
      }
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) {
        timer.cleared = true;
      }
    },
    requestAnimationFrame(callback) {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    },
  };

  class HarnessWebSocket extends MockWebSocket {
    constructor(url) {
      super(url);
      webSockets.push(this);
    }
  }

  class FakeRtcPeerConnection {
    constructor() {
      this.localDescription = null;
      this.remoteDescription = null;
      this.channels = [];
      this.transceivers = [];
    }

    addTransceiver(kind, options) {
      this.transceivers.push({ kind, options });
    }

    createDataChannel(label, options) {
      const channel = {
        label,
        options,
        readyState: "open",
        bufferedAmount: 0,
        listeners: new Map(),
        addEventListener(type, listener) {
          const existing = this.listeners.get(type) ?? [];
          existing.push(listener);
          this.listeners.set(type, existing);
        },
        dispatch(type, event = {}) {
          for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
          }
        },
        send() {},
        close() {},
      };
      this.channels.push(channel);
      return channel;
    }

    async createOffer() {
      return { type: "offer", sdp: "rtc-offer" };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }

    async getStats() {
      if (typeof rtcGetStatsImpl === "function") {
        return rtcGetStatsImpl.call(this);
      }
      this.statsSampleIndex = (this.statsSampleIndex ?? 0) + 1;
      const index = this.statsSampleIndex;
      return new Map([
        [
          "video-inbound",
          {
            type: "inbound-rtp",
            kind: "video",
            framesDecoded: 60 * index,
            bytesReceived: 900000 * index,
            packetsReceived: 1000 * index,
            packetsLost: 4 * index,
          },
        ],
      ]);
    }

    close() {}
  }

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: document,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { sendBeacon() { return true; } },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (url, init = {}) => {
      fetchCalls.push([url, init]);
      if (typeof fetchImpl === "function") {
        return fetchImpl(url, init, { fetchCalls });
      }

      return defaultFetch(url, init);
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: HarnessWebSocket,
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    writable: true,
    value: enableRtc ? FakeRtcPeerConnection : undefined,
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: location,
  });
  Object.defineProperty(globalThis, "screen", {
    configurable: true,
    writable: true,
    value: {
      orientation: {
        async lock(orientation) {
          orientationLocks.push(orientation);
        },
      },
    },
  });
  if (Number.isFinite(performanceStepMs) && performanceStepMs > 0) {
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      writable: true,
      value: {
        now() {
          syntheticNowMs += performanceStepMs;
          return syntheticNowMs;
        },
      },
    });
  }

  return {
    connEl,
    slotEl,
    hostDrawerHandleEl,
    hostDrawerBackdropEl,
    hostTargetFormEl,
    hostTargetInputEl,
    streamSettingsSaveEl,
    streamSettingsStatusEl,
    videoWidthInputEl,
    videoHeightInputEl,
    videoFpsInputEl,
    videoBitrateInputEl,
    streamTelemetryEl,
    fullscreenPlaybackEl,
    buttonElements,
    leftTriggerEl,
    leftStickEl,
    stickSensitivityInputEl,
    stickSensitivityValueEl,
    controlOpacityInputEl,
    controlOpacityValueEl,
    controllerVisibleInputEl,
    hudVisibleInputEl,
    controllerEl,
    timers,
    webSockets,
    fetchCalls,
    fullscreenRequests,
    orientationLocks,
    roomStatusEl,
    transportModeEl,
    rootStyle: document.documentElement.style,
    latencyEl,
    storage: window.localStorage,
    setVisibility(value) {
      document.visibilityState = value;
      document.dispatch("visibilitychange");
    },
    dispatchWindow(type, event = {}) {
      window.dispatch(type, event);
    },
    runAnimationFrame(nowMs = 0) {
      const resolvedNowMs = frameTimeOrigin + nowMs;
      const animationFrameCallback = animationFrameCallbacks.shift();
      animationFrameCallback?.(resolvedNowMs);
      const videoFrameCallback = videoFrameCallbacks.shift();
      videoFrameCallback?.(resolvedNowMs, { width: 1920, height: 1080 });
    },
    dispatchDocument(type, event = {}) {
      document.dispatch(type, event);
    },
    async settle() {
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
      }
    },
    restore() {
      for (const [key, descriptor] of originalGlobals.entries()) {
        if (descriptor === undefined) {
          delete globalThis[key];
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
    },
  };
}

test("index.html exposes the host drawer controls", async () => {
  const html = await readFile(resolve(here, "../index.html"), "utf8");
  assert.match(html, /id="host"/);
  assert.match(html, /id="hostDrawer"/);
  assert.match(html, /id="hostDrawerHandle"/);
  assert.match(html, /id="hostDrawerBackdrop"/);
  assert.match(html, /id="hostTargetForm"/);
  assert.match(html, /id="hostTargetInput"/);
  assert.match(html, /id="hostTargetStatus"/);
  assert.match(html, /id="stickSensitivityInput"/);
  assert.match(html, /id="stickSensitivityValue"/);
  assert.match(html, /id="controlOpacityInput"/);
  assert.match(html, /id="controlOpacityValue"/);
  assert.match(html, /id="controllerVisibleInput"/);
  assert.match(html, /id="hudVisibleInput"/);
});

test("index.html keeps the host input in text entry mode", async () => {
  const html = await readFile(resolve(here, "../index.html"), "utf8");
  assert.match(html, /id="hostTargetInput"[\s\S]*inputmode="text"/);
});

test("styles.css defines the drawer and handle hooks", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.host-drawer-handle/);
  assert.match(css, /\.host-drawer\.is-open/);
  assert.match(css, /\.host-drawer-backdrop\.is-visible/);
});

test("styles.css restores normal text input behavior inside the drawer input", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.host-drawer-input\s*\{[\s\S]*touch-action:\s*auto;/);
  assert.match(css, /\.host-drawer-input\s*\{[\s\S]*-webkit-user-select:\s*text;/);
  assert.match(css, /\.host-drawer-input\s*\{[\s\S]*user-select:\s*text;/);
});

test("styles.css defines the drawer sensitivity hooks", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.host-drawer-range-row/);
  assert.match(css, /\.host-drawer-range/);
  assert.match(css, /\.host-drawer-value/);
});

test("styles.css defines the drawer visibility toggle hooks", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.host-drawer-toggle-row/);
  assert.match(css, /\.host-drawer-toggle-input/);
  assert.match(css, /\.host-drawer-toggle-input::after/);
});

test("styles.css centers telemetry as a compact single-line hud and hides the redundant bottom-right latency pill", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.stream-telemetry-line/);
  assert.match(css, /\.stream-telemetry-segment/);
  assert.match(css, /\.stream-telemetry-separator/);
  assert.match(css, /\.stream-telemetry\s*\{[\s\S]*left:\s*50%;/);
  assert.match(css, /\.stream-telemetry\s*\{[\s\S]*transform:\s*translateX\(-50%\);/);
  assert.match(css, /\.stream-telemetry\s*\{[\s\S]*white-space:\s*nowrap;/);
  assert.match(css, /\.stream-telemetry-value/);
  assert.match(css, /\.latency\s*\{[\s\S]*display:\s*none;/);
});

test("styles.css shifts the top button groups downward and hides the redundant top-right transport pill", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.ok(extractCssPixelVar(css, "--upper-cluster-offset") >= 42);
  assert.match(css, /\.dpad-cluster\s*\{[\s\S]*transform:\s*translateY\(var\(--upper-cluster-offset\)\);/);
  assert.match(css, /\.abxy-cluster\s*\{[\s\S]*transform:\s*translateY\(var\(--upper-cluster-offset\)\);/);
  assert.match(css, /\.aux-left\s*\{[\s\S]*transform:\s*translateY\(var\(--upper-cluster-offset\)\);/);
  assert.match(css, /\.aux-right\s*\{[\s\S]*transform:\s*translateY\(var\(--upper-cluster-offset\)\);/);
  assert.match(
    extractCssRule(css, String.raw`\.controller\[data-layout="compact"\]`),
    /--upper-cluster-offset:\s*(3\d|[4-9]\d)px;/,
  );
  assert.match(css, /\.transport-mode\s*\{[\s\S]*display:\s*none;/);
});

test("styles.css moves both stick shells inward and exposes a dedicated center inset variable", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.ok(extractCssPixelVar(css, "--stick-center-inset") >= 24);
  assert.match(css, /\.left-stick-shell\s*\{[\s\S]*transform:\s*translateX\(var\(--stick-center-inset\)\);/);
  assert.match(css, /\.right-stick-shell\s*\{[\s\S]*transform:\s*translateX\(calc\(var\(--stick-center-inset\) \* -1\)\);/);
  assert.match(
    extractCssRule(css, String.raw`\.controller\[data-layout="compact"\]`),
    /--stick-center-inset:\s*(1[89]|[2-9]\d)px;/,
  );
});

test("styles.css keeps the settings drawer scrollable on short landscape screens", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.host-drawer\s*\{[\s\S]*bottom:\s*max\(/);
  assert.match(css, /\.host-drawer\s*\{[\s\S]*overflow-y:\s*auto;/);
  assert.match(css, /\.host-drawer\s*\{[\s\S]*overscroll-behavior:\s*contain;/);
  assert.match(css, /\.host-drawer\s*\{[\s\S]*-webkit-overflow-scrolling:\s*touch;/);
  assert.match(css, /\.host-drawer\s*\{[\s\S]*touch-action:\s*pan-y;/);
  assert.match(css, /\.host-drawer \*\s*\{[\s\S]*touch-action:\s*pan-y;/);
  assert.match(css, /\.host-drawer-range\s*\{[\s\S]*touch-action:\s*pan-x pan-y;/);
});

test("index.html exposes the remote stream stage", async () => {
  const html = await readFile(resolve(here, "../index.html"), "utf8");
  assert.match(html, /id="remoteVideo"/);
  assert.match(html, /id="streamBackdropCanvas"/);
  assert.match(html, /id="streamCanvas"/);
  assert.match(html, /id="roomStatus"/);
  assert.match(html, /id="transportMode"/);
  assert.match(html, /id="streamTelemetry"/);
  assert.match(html, /id="fullscreenPlayback"/);
  assert.match(html, /id="videoWidthInput"/);
  assert.match(html, /id="videoHeightInput"/);
  assert.match(html, /id="videoFpsInput"/);
  assert.match(html, /id="videoBitrateInput"/);
});

test("index.html keeps the decode video hidden behind the canvas renderer", async () => {
  const html = await readFile(resolve(here, "../index.html"), "utf8");
  assert.match(html, /<video[^>]*id="remoteVideo"[^>]*hidden/);
});

test("index.html cache-busts the top-level frontend assets", async () => {
  const html = await readFile(resolve(here, "../index.html"), "utf8");
  assert.match(html, /href="\/styles\.css\?v=[^"]+"/);
  assert.match(html, /src="\/app\.mjs\?v=[^"]+"/);
});

test("index.html points users at the streaming gateway port", async () => {
  const html = await readFile(resolve(here, "../index.html"), "utf8");
  assert.match(html, /placeholder="192\.168\.0\.10:8082"/);
});

test("styles.css keeps the controller fixed above the video layer", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.stream-stage\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(css, /\.stream-stage\s*\{[\s\S]*z-index:\s*0;/);
  assert.match(css, /\.controller\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(css, /\.controller\s*\{[\s\S]*inset:\s*0;/);
  assert.match(css, /\.controller\s*\{[\s\S]*z-index:\s*10;/);
});

test("styles.css fits the full remote frame inside the phone viewport", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /\.stream-canvas\s*\{[\s\S]*width:\s*100%;/);
  assert.match(css, /\.stream-canvas\s*\{[\s\S]*height:\s*100%;/);
  assert.match(css, /\.stream-canvas-foreground/);
  assert.match(css, /\.stream-canvas-backdrop/);
});

test("styles.css keeps the live video free from dark glass overlays", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  assert.match(css, /body::after\s*\{[\s\S]*(display:\s*none;|background:\s*none;)/);
  assert.match(css, /\.stream-stage::after\s*\{[\s\S]*(display:\s*none;|background:\s*none;)/);
  assert.match(css, /\.stream-canvas-foreground\s*\{[\s\S]*filter:\s*none;/);
});

test("styles.css renders transparent controls without frosted-glass blur", async () => {
  const css = await readFile(resolve(here, "../styles.css"), "utf8");
  const buttonRule = extractCssRule(
    css,
    String.raw`\.btn,\s*\.face-btn,\s*\.meta-btn,\s*\.shoulder-btn,\s*\.system-btn`,
  );
  const stickRule = extractCssRule(css, String.raw`\.stick`);
  const stickKnobRule = extractCssRule(css, String.raw`\.stick-knob`);

  assert.match(buttonRule, /background:\s*rgba\([^)]*,\s*0\.\d+\)/);
  assert.doesNotMatch(buttonRule, /backdrop-filter:/);
  assert.match(stickRule, /background:\s*radial-gradient\(/);
  assert.doesNotMatch(stickRule, /backdrop-filter:/);
  assert.doesNotMatch(stickKnobRule, /backdrop-filter:/);
  assert.match(buttonRule, /--control-alpha:\s*var\(--transparent-control-alpha\)/);
  assert.match(buttonRule, /opacity:\s*var\(--control-alpha\)/);
  assert.match(extractCssRule(css, String.raw`\.trigger-label`), /opacity:\s*var\(--control-alpha\)/);
  assert.match(extractCssRule(css, String.raw`\.stick`), /opacity:\s*var\(--control-alpha\)/);
});

test("startup ignores window.location.host when no host target is saved", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "",
    fakeLocationHost: "fallback.example.test:9000",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-blank-host`);

  harness.runAnimationFrame(0);

  assert.equal(harness.webSockets.length, 0);
  assert.deepEqual(harness.fetchCalls, []);
  assert.equal(harness.connEl.textContent, "WS: host not set");
});

test("host switches after a prior disconnect still reconnect on the next close", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "192.168.0.10:8081" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}`);

  assert.equal(harness.webSockets.length, 1);
  const firstSocket = harness.webSockets[0];

  firstSocket.serverClose();
  assert.equal(
    [...harness.timers.values()].filter((timer) => !timer.cleared).length,
    1,
    "the initial disconnect should schedule a reconnect",
  );

  harness.hostTargetInputEl.value = "192.168.0.11:8081";
  harness.hostTargetFormEl.dispatch("submit");

  assert.equal(harness.webSockets.length, 2);
  assert.equal(
    [...harness.timers.values()].filter((timer) => !timer.cleared).length,
    0,
    "changing hosts should clear the old reconnect timer",
  );

  const secondSocket = harness.webSockets[1];
  secondSocket.serverClose();

  const activeTimers = [...harness.timers.values()].filter((timer) => !timer.cleared);
  assert.equal(activeTimers.length, 1, "the replacement socket should still schedule a reconnect");

  activeTimers[0].callback();
  assert.equal(harness.webSockets.length, 3);
  assert.match(harness.connEl.textContent, /WS: connecting ws:\/\/192\.168\.0\.11:8081\/ws/);
});

test("startup requests browser fullscreen with hidden navigation UI when supported", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-startup-fullscreen`);
  await harness.settle();

  assert.deepEqual(harness.fullscreenRequests, [{ navigationUI: "hide" }]);
  assert.deepEqual(harness.orientationLocks, ["landscape"]);
});

test("host submit does not spam another fullscreen request once immersive playback is already active", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-fullscreen-submit`);
  await harness.settle();

  assert.equal(harness.fullscreenRequests.length, 1);
  harness.hostTargetInputEl.value = "192.168.0.11:8082";
  harness.hostTargetFormEl.dispatch("submit");
  await harness.settle();

  assert.deepEqual(harness.fullscreenRequests, [{ navigationUI: "hide" }]);
  assert.deepEqual(harness.orientationLocks, ["landscape"]);
});

test("first gameplay interaction does not spam another fullscreen request when immersive playback is already active", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "192.168.0.11:8082" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-first-gesture-fullscreen`);
  await harness.settle();

  assert.equal(harness.fullscreenRequests.length, 1);
  harness.buttonElements[0].dispatch("pointerdown", { pointerId: 7 });
  await harness.settle();

  assert.deepEqual(harness.fullscreenRequests, [{ navigationUI: "hide" }]);
  assert.deepEqual(harness.orientationLocks, ["landscape"]);
});

test("drawer fullscreen button requests browser fullscreen with hidden navigation UI", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "192.168.0.11:8082" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-drawer-fullscreen`);
  await harness.settle();

  globalThis.document.fullscreenElement = null;
  harness.fullscreenPlaybackEl.dispatch("click");
  await harness.settle();

  assert.deepEqual(harness.fullscreenRequests, [{ navigationUI: "hide" }, { navigationUI: "hide" }]);
  assert.deepEqual(harness.orientationLocks, ["landscape", "landscape"]);
});

test("gameplay controls cancel native mobile media gestures immediately", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "192.168.0.11:8082" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-touch-trap`);

  let buttonPrevented = false;
  let stickPrevented = false;
  harness.buttonElements[0].dispatch("touchstart", {
    cancelable: true,
    preventDefault() {
      buttonPrevented = true;
    },
  });
  harness.leftStickEl.dispatch("touchmove", {
    cancelable: true,
    preventDefault() {
      stickPrevented = true;
    },
  });

  assert.equal(buttonPrevented, true);
  assert.equal(stickPrevented, true);
});

test("gameplay drag keeps cancelling document-level touch moves after the finger leaves the control", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "192.168.0.11:8082" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-document-touch-guard`);

  let startPrevented = false;
  let movePrevented = false;
  let endPrevented = false;

  harness.leftStickEl.dispatch("touchstart", {
    cancelable: true,
    changedTouches: [{ identifier: 17 }],
    preventDefault() {
      startPrevented = true;
    },
  });
  harness.dispatchDocument("touchmove", {
    cancelable: true,
    changedTouches: [{ identifier: 17 }],
    preventDefault() {
      movePrevented = true;
    },
  });
  harness.dispatchDocument("touchend", {
    cancelable: true,
    changedTouches: [{ identifier: 17 }],
    preventDefault() {
      endPrevented = true;
    },
  });

  assert.equal(startPrevented, true);
  assert.equal(movePrevented, true);
  assert.equal(endPrevented, true);
});

test("quick stick flick sends a damped active packet and then a centered release payload", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    performanceStepMs: 16,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-stick-flick-release`);
  await harness.settle();

  harness.leftStickEl.dispatch("pointerdown", { pointerId: 11, clientX: 100, clientY: 100 });
  harness.leftStickEl.dispatch("pointermove", { pointerId: 11, clientX: 100, clientY: 18 });
  harness.runAnimationFrame(16);
  harness.leftStickEl.dispatch("pointerup", { pointerId: 11, clientX: 100, clientY: 100 });
  harness.runAnimationFrame(32);
  await harness.settle();

  const inputPackets = harness.webSockets[0].sentPackets.filter((packet) => packet.sticks?.left);
  const activePacket = inputPackets.find((packet) => packet.sticks.left.ny > 0.01);
  const releasePacket = inputPackets.at(-1);

  assert.ok(activePacket, "expected one non-zero upward packet");
  assert.ok(activePacket.sticks.left.ny < 0.95);
  assert.equal(releasePacket.sticks.left.nx, 0);
  assert.equal(releasePacket.sticks.left.ny, 0);
});

test("slot resets when the host changes and when websocket falls back", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "192.168.0.10:8081" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-slot-reset`);

  assert.equal(harness.webSockets.length, 1);
  const firstSocket = harness.webSockets[0];
  firstSocket.dispatch("message", { data: JSON.stringify({ type: "slot", slot: 7 }) });
  assert.equal(harness.slotEl.textContent, "slot: 7");

  harness.hostTargetInputEl.value = "192.168.0.11:8081";
  harness.hostTargetFormEl.dispatch("submit");

  assert.equal(harness.webSockets.length, 2);
  assert.equal(harness.slotEl.textContent, "slot: -");

  const secondSocket = harness.webSockets[1];
  secondSocket.serverClose();
  assert.equal(harness.slotEl.textContent, "slot: -");
});

test("startup restores saved stick sensitivity and slider changes persist", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    savedStickSensitivity: "0.82",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-sensitivity`);

  assert.equal(harness.stickSensitivityInputEl.value, "0.82");
  assert.equal(harness.stickSensitivityValueEl.textContent, "82%");

  harness.stickSensitivityInputEl.value = "0.9";
  harness.stickSensitivityInputEl.dispatch("input");

  assert.equal(harness.storage.getItem("joycon_stick_sensitivity"), "0.9");
  assert.equal(harness.stickSensitivityValueEl.textContent, "90%");
});

test("startup restores saved control opacity and slider changes persist to the runtime css vars", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    savedControlOpacity: "0.31",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-control-opacity`);

  assert.equal(harness.controlOpacityInputEl.value, "0.31");
  assert.equal(harness.controlOpacityValueEl.textContent, "31%");
  assert.equal(harness.rootStyle.values.get("--transparent-control-alpha"), "0.31");

  harness.controlOpacityInputEl.value = "0.45";
  harness.controlOpacityInputEl.dispatch("input");

  assert.equal(harness.storage.getItem("joycon_control_opacity"), "0.45");
  assert.equal(harness.controlOpacityValueEl.textContent, "45%");
  assert.equal(harness.rootStyle.values.get("--transparent-control-alpha"), "0.45");
});

test("startup restores controller and hud visibility, and drawer toggles persist both switches", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    savedControllerVisible: "false",
    savedHudVisible: "false",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-visibility-switches`);
  await harness.settle();

  assert.equal(harness.controllerVisibleInputEl.checked, false);
  assert.equal(harness.hudVisibleInputEl.checked, false);
  assert.equal(harness.controllerEl.hidden, true);
  assert.equal(harness.streamTelemetryEl.hidden, true);

  harness.controllerVisibleInputEl.checked = true;
  harness.controllerVisibleInputEl.dispatch("input");
  harness.hudVisibleInputEl.checked = true;
  harness.hudVisibleInputEl.dispatch("input");

  assert.equal(harness.storage.getItem("joycon_controller_visible"), "true");
  assert.equal(harness.storage.getItem("joycon_hud_visible"), "true");
  assert.equal(harness.controllerEl.hidden, false);
  assert.equal(harness.streamTelemetryEl.hidden, false);
});

test("host input changes persist a local draft before connect is pressed", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-host-draft`);

  harness.hostTargetInputEl.value = "10.0.0.3:8082";
  harness.hostTargetInputEl.dispatch("input");

  assert.equal(harness.storage.getItem("joycon_host_target_draft"), "10.0.0.3:8082");
});

test("apply stream uses the current host input before connect saves it", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-apply-stream-current-host`);
  await harness.settle();

  harness.hostTargetInputEl.value = "10.0.0.3:8082";
  harness.streamSettingsSaveEl.dispatch("click");
  await harness.settle();

  assert.ok(
    harness.fetchCalls.some(
      ([url, init]) => String(url) === "http://10.0.0.3:8082/api/stream/settings" && init?.method === "POST",
    ),
    "expected Apply Stream to post to the current host input",
  );
});

test("load stream settings hydrates the form from nested requested values when flat fields are effective", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "10.0.0.3:8082",
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("/api/stream/settings") && init.method === "GET") {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              width: 1980,
              height: 1080,
              fps: 60,
              bitrateKbps: 6000,
              requested: {
                width: 1980,
                height: 1080,
                fps: 90,
                bitrateKbps: 6000,
              },
              effective: {
                width: 1980,
                height: 1080,
                fps: 60,
                bitrateKbps: 6000,
              },
              applied: false,
            };
          },
        };
      }

      return {
        ok: true,
        async json() {
          return {};
        },
        async text() {
          return "v=0\r\n";
        },
      };
    },
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-stream-requested-load`);
  await harness.settle();

  assert.equal(harness.videoWidthInputEl.value, "1980");
  assert.equal(harness.videoHeightInputEl.value, "1080");
  assert.equal(harness.videoFpsInputEl.value, "90");
  assert.equal(harness.videoBitrateInputEl.value, "6000");
});

test("apply stream polls until the publisher reports the profile is active", async (t) => {
  let getCount = 0;
  const harness = installAppHarness({
    savedHostTarget: "",
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("/api/stream/settings") && init.method === "POST") {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              width: 1980,
              height: 1080,
              fps: 60,
              bitrateKbps: 6000,
              requested: {
                width: 1980,
                height: 1080,
                fps: 90,
                bitrateKbps: 6000,
              },
              effective: {
                width: 1980,
                height: 1080,
                fps: 60,
                bitrateKbps: 6000,
              },
              applied: false,
            };
          },
        };
      }

      if (String(url).includes("/api/stream/settings") && init.method === "GET") {
        getCount += 1;
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              width: 1980,
              height: 1080,
              fps: 60,
              bitrateKbps: 6000,
              requested: {
                width: 1980,
                height: 1080,
                fps: 90,
                bitrateKbps: 6000,
              },
              effective: {
                width: 1980,
                height: 1080,
                fps: 60,
                bitrateKbps: 6000,
              },
              applied: getCount >= 2,
            };
          },
        };
      }

      return {
        ok: true,
        async json() {
          return {};
        },
        async text() {
          return "v=0\r\n";
        },
      };
    },
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-apply-stream-poll`);
  await harness.settle();

  harness.hostTargetInputEl.value = "10.0.0.3:8082";
  harness.streamSettingsSaveEl.dispatch("click");
  await harness.settle();
  assert.equal(harness.videoFpsInputEl.value, "90");
  assert.equal(harness.streamSettingsStatusEl.textContent, "applying stream profile");

  const firstPoll = [...harness.timers.values()].find((timer) => !timer.cleared);
  firstPoll.callback();
  await harness.settle();
  assert.equal(harness.videoFpsInputEl.value, "90");
  assert.equal(harness.streamSettingsStatusEl.textContent, "applying stream profile");
  const secondPoll = [...harness.timers.values()].find((timer) => !timer.cleared && timer !== firstPoll);
  secondPoll.callback();
  await harness.settle();

  assert.equal(harness.videoFpsInputEl.value, "90");
  assert.equal(harness.streamSettingsStatusEl.textContent, "stream applied");
});

test("stream settings input waits for blur before auto-applying", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "10.0.0.3:8082",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-stream-apply-on-blur`);
  await harness.settle();

  harness.videoHeightInputEl.value = "1080";
  harness.videoHeightInputEl.dispatch("input");
  harness.videoFpsInputEl.value = "90";
  harness.videoFpsInputEl.dispatch("input");
  harness.videoBitrateInputEl.value = "12000";
  harness.videoBitrateInputEl.dispatch("input");

  assert.equal(
    harness.fetchCalls.some(
      ([url, init]) => String(url) === "http://10.0.0.3:8082/api/stream/settings" && init?.method === "POST",
    ),
    false,
    "expected no stream settings POST while the field is still focused",
  );

  harness.videoBitrateInputEl.dispatch("blur");
  await harness.settle();

  const streamSaveCall = harness.fetchCalls.find(
    ([url, init]) => String(url) === "http://10.0.0.3:8082/api/stream/settings" && init?.method === "POST",
  );
  assert.ok(streamSaveCall, "expected a stream settings POST after blur");
  assert.deepEqual(JSON.parse(streamSaveCall[1].body), {
    width: 1280,
    height: 1080,
    fps: 90,
    bitrateKbps: 12000,
  });
});

test("startup prefers the reconnect endpoint when a saved token exists", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    savedReconnectToken: "saved-token",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-prefer-reconnect`);
  await harness.settle();

  assert.ok(
    harness.fetchCalls.some(([url]) => /\/api\/room\/reconnect$/.test(String(url))),
    "expected the startup flow to call the reconnect endpoint",
  );
});

test("successful room negotiation persists the reconnect token", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-persist-reconnect`);
  await harness.settle();

  assert.equal(harness.storage.getItem("joycon_stream_reconnect_token"), "reconnect-fixed");
});

test("becoming visible again re-syncs the stream session instead of freezing on stale peers", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-visibility-resync`);
  await harness.settle();

  const initialRoomCalls = harness.fetchCalls.filter(([url]) => /\/api\/room\/(join|reconnect)$/.test(String(url))).length;
  const initialMediaCalls = harness.fetchCalls.filter(([url]) => String(url).includes("/media/whep")).length;
  const initialSocketCount = harness.webSockets.length;

  harness.setVisibility("hidden");
  harness.setVisibility("visible");
  await harness.settle();

  const resumedRoomCalls = harness.fetchCalls.filter(([url]) => /\/api\/room\/(join|reconnect)$/.test(String(url))).length;
  const resumedMediaCalls = harness.fetchCalls.filter(([url]) => String(url).includes("/media/whep")).length;

  assert.ok(harness.webSockets.length > initialSocketCount, "expected websocket reconnect on visibility resume");
  assert.ok(resumedRoomCalls > initialRoomCalls, "expected room resync on visibility resume");
  assert.ok(resumedMediaCalls > initialMediaCalls, "expected media renegotiation on visibility resume");
});

test("stream telemetry shows live protocol, fps, bitrate, latency, quality, and loss", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-stream-telemetry`);
  await harness.settle();

  harness.runAnimationFrame(0);
  harness.runAnimationFrame(1200);
  await harness.settle();

  assert.match(harness.streamTelemetryEl.textContent, /protocol/i);
  assert.match(harness.streamTelemetryEl.textContent, /fps/i);
  assert.match(harness.streamTelemetryEl.textContent, /bitrate/i);
  assert.match(harness.streamTelemetryEl.textContent, /latency/i);
  assert.match(harness.streamTelemetryEl.textContent, /quality/i);
  assert.match(harness.streamTelemetryEl.textContent, /loss/i);
  assert.doesNotMatch(harness.streamTelemetryEl.textContent, /webrtc\/webrtc/i);
  assert.match(harness.streamTelemetryEl.innerHTML ?? "", /stream-telemetry-line/);
  assert.match(harness.streamTelemetryEl.innerHTML ?? "", /stream-telemetry-separator/);
});

test("stream telemetry falls back to decoded video progress when rtc stats omit inbound video fps", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
    rtcGetStatsImpl: () => new Map(),
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-stream-telemetry-fallback`);
  await harness.settle();

  harness.runAnimationFrame(0);
  harness.runAnimationFrame(1200);
  await harness.settle();

  assert.doesNotMatch(harness.streamTelemetryEl.textContent, /fps\s*--/i);
  assert.match(harness.streamTelemetryEl.textContent, /fps/i);
});

test("stream telemetry hud does not re-render on every animation frame between one-second samples", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-stream-telemetry-cadence`);
  await harness.settle();

  harness.runAnimationFrame(0);
  await harness.settle();
  const initialUpdates = harness.streamTelemetryEl.innerHTMLUpdates;

  harness.runAnimationFrame(200);
  harness.runAnimationFrame(400);
  harness.runAnimationFrame(800);
  await harness.settle();

  assert.equal(
    harness.streamTelemetryEl.innerHTMLUpdates,
    initialUpdates,
    "the hud should wait for the next one-second telemetry sample before re-rendering",
  );

  harness.runAnimationFrame(1200);
  await harness.settle();

  assert.ok(harness.streamTelemetryEl.innerHTMLUpdates > initialUpdates);
});

test("bottom latency pill stays hidden once the structured telemetry hud is active", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-latency-hidden`);
  await harness.settle();

  assert.equal(harness.latencyEl.hidden, true);
});

test("top-right transport pill stays hidden after the centered protocol hud takes over", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-transport-pill-hidden`);
  await harness.settle();

  assert.equal(harness.transportModeEl.hidden, true);
});

test("rtc control negotiation clears the degraded room label", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-rtc-ready`);
  await harness.settle();

  assert.deepEqual(
    {
      room: harness.roomStatusEl.textContent,
      hud: harness.transportModeEl.textContent,
    },
    {
      room: "1P",
      hud: "control: webrtc",
    },
  );
});

test("transport hud stays on webrtc while the rtc input channel is alive", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-rtc-http-fallback`);
  await harness.settle();

  harness.webSockets[0].serverClose();

  assert.equal(harness.transportModeEl.textContent, "control: webrtc");
});

test("media failure is surfaced as a visible stream error", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
    fetchImpl: async (url) => {
      if (String(url).includes("/media/whep")) {
        return {
          ok: false,
          status: 503,
          async text() {
            return "";
          },
        };
      }

      if (String(url).includes("/api/control/offer")) {
        return {
          ok: true,
          async json() {
            return {
              type: "answer",
              sdp: "control-answer",
            };
          },
        };
      }

      return {
        ok: true,
        async json() {
          return {
            room_id: "living-room",
            player_id: "uuid-fixed",
            role: "player",
            seat_index: 1,
            seat_epoch: 1,
            reconnect_token: "reconnect-fixed",
          };
        },
      };
    },
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-media-failure`);
  await harness.settle();

  assert.equal(harness.roomStatusEl.textContent, "stream unavailable");
});

test("stale media completion does not overwrite a newer host attempt", async (t) => {
  let releaseFirstMedia;
  const firstMediaPromise = new Promise((resolve) => {
    releaseFirstMedia = resolve;
  });

  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
    fetchImpl: async (url) => {
      if (String(url).includes("192.168.0.10") && String(url).includes("/api/room/join")) {
        return {
          ok: true,
          async json() {
            return {
              room_id: "living-room",
              player_id: "uuid-fixed",
              role: "player",
              seat_index: 1,
              seat_epoch: 1,
              reconnect_token: "token-1",
            };
          },
        };
      }

      if (String(url).includes("192.168.0.10") && String(url).includes("/media/whep")) {
        await firstMediaPromise;
        return {
          ok: true,
          async text() {
            return "first-answer";
          },
        };
      }

      if (String(url).includes("192.168.0.11") && String(url).includes("/api/room/join")) {
        return {
          ok: true,
          async json() {
            return {
              room_id: "living-room",
              player_id: "uuid-fixed",
              role: "player",
              seat_index: 2,
              seat_epoch: 2,
              reconnect_token: "token-2",
            };
          },
        };
      }

      if (String(url).includes("192.168.0.11") && String(url).includes("/api/room/reconnect")) {
        return {
          ok: true,
          async json() {
            return {
              room_id: "living-room",
              player_id: "uuid-fixed",
              role: "player",
              seat_index: 2,
              seat_epoch: 2,
              reconnect_token: "token-2",
            };
          },
        };
      }

      if (String(url).includes("192.168.0.11") && String(url).includes("/media/whep")) {
        return {
          ok: true,
          async text() {
            return "second-answer";
          },
        };
      }

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
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-host-race`);
  await harness.settle();

  harness.hostTargetInputEl.value = "192.168.0.11:8081";
  harness.hostTargetFormEl.dispatch("submit");
  await harness.settle();

  releaseFirstMedia();
  await harness.settle();

  assert.equal(harness.roomStatusEl.textContent, "2P");
});

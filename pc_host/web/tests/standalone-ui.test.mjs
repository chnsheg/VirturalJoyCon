import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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
    this.value = "";
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

  send() {}
}

function installAppHarness({
  savedHostTarget,
  savedStickSensitivity,
  fakeLocationHost = "example.invalid",
  enableRtc = false,
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
  const remoteVideoEl = new MockElement();
  remoteVideoEl.play = async () => undefined;
  const roomStatusEl = new MockElement();
  const transportModeEl = new MockElement();
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
    ["remoteVideo", remoteVideoEl],
    ["roomStatus", roomStatusEl],
    ["transportMode", transportModeEl],
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

  const document = {
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
    },
    getElementById(id) {
      return idMap.get(id) ?? null;
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

  return {
    connEl,
    slotEl,
    hostTargetFormEl,
    hostTargetInputEl,
    stickSensitivityInputEl,
    stickSensitivityValueEl,
    timers,
    webSockets,
    fetchCalls,
    roomStatusEl,
    transportModeEl,
    storage: window.localStorage,
    runAnimationFrame(nowMs = 0) {
      const callback = animationFrameCallbacks.shift();
      callback?.(nowMs);
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

test("index.html exposes the remote stream stage", async () => {
  const html = await readFile(resolve(here, "../index.html"), "utf8");
  assert.match(html, /id="remoteVideo"/);
  assert.match(html, /id="roomStatus"/);
  assert.match(html, /id="transportMode"/);
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

test("slot resets when the host changes and when websocket falls back", async (t) => {
  const harness = installAppHarness({ savedHostTarget: "192.168.0.10:8081" });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-slot-reset`);

  assert.equal(harness.webSockets.length, 1);
  const firstSocket = harness.webSockets[0];
  firstSocket.dispatch("message", { data: JSON.stringify({ type: "slot", slot: 7 }) });
  assert.equal(harness.slotEl.textContent, "slot: 7 mode:ws");

  harness.hostTargetInputEl.value = "192.168.0.11:8081";
  harness.hostTargetFormEl.dispatch("submit");

  assert.equal(harness.webSockets.length, 2);
  assert.equal(harness.slotEl.textContent, "slot: - mode:ws");

  const secondSocket = harness.webSockets[1];
  secondSocket.serverClose();
  assert.equal(harness.slotEl.textContent, "slot: - mode:http");
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

test("transport hud follows later http fallback after rtc negotiation", async (t) => {
  const harness = installAppHarness({
    savedHostTarget: "192.168.0.10:8081",
    enableRtc: true,
  });
  t.after(() => harness.restore());

  await import(`${pathToFileURL(resolve(here, "../app.mjs")).href}?case=${Date.now()}-rtc-http-fallback`);
  await harness.settle();

  harness.webSockets[0].serverClose();

  assert.equal(harness.transportModeEl.textContent, "control: http degraded");
});

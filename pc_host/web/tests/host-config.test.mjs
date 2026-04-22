import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTransportUrls,
  CONTROL_OPACITY_STORAGE_KEY,
  CONTROLLER_VISIBLE_STORAGE_KEY,
  DEFAULT_CONTROL_OPACITY,
  DEFAULT_CONTROLLER_VISIBLE,
  DEFAULT_HUD_VISIBLE,
  DEFAULT_STREAM_SETTINGS,
  DEFAULT_STORAGE_KEY,
  DEFAULT_STICK_SENSITIVITY,
  HUD_VISIBLE_STORAGE_KEY,
  HostDrawerController,
  HOST_ERROR,
  STICK_SENSITIVITY_STORAGE_KEY,
  getStickResponseExponent,
  loadSavedControlOpacity,
  loadSavedStickSensitivity,
  loadSavedHostTarget,
  normalizeControlOpacity,
  normalizeStreamSettings,
  normalizeStickSensitivity,
  normalizeHostTarget,
  saveControlOpacity,
  saveStickSensitivity,
  saveHostTarget,
} from "../host-config.mjs";

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("normalizeHostTarget trims and accepts IPv4:port", () => {
  assert.deepEqual(normalizeHostTarget(" 192.168.0.8:8081 "), {
    ok: true,
    value: "192.168.0.8:8081",
  });
});

test("host-config exports the host constants", () => {
  assert.equal(DEFAULT_STORAGE_KEY, "joycon_host_target");
  assert.equal(HOST_ERROR, "Use an IPv4 address and port like 192.168.0.10:8082");
  assert.equal(STICK_SENSITIVITY_STORAGE_KEY, "joycon_stick_sensitivity");
  assert.equal(DEFAULT_STICK_SENSITIVITY, 0.68);
  assert.equal(CONTROL_OPACITY_STORAGE_KEY, "joycon_control_opacity");
  assert.equal(DEFAULT_CONTROL_OPACITY, 0.18);
  assert.equal(CONTROLLER_VISIBLE_STORAGE_KEY, "joycon_controller_visible");
  assert.equal(DEFAULT_CONTROLLER_VISIBLE, true);
  assert.equal(HUD_VISIBLE_STORAGE_KEY, "joycon_hud_visible");
  assert.equal(DEFAULT_HUD_VISIBLE, true);
});

test("normalizeHostTarget rejects malformed host strings", () => {
  assert.deepEqual(normalizeHostTarget("192.168.0.999:8081"), {
    ok: false,
    error: "Use an IPv4 address and port like 192.168.0.10:8082",
  });
  assert.deepEqual(normalizeHostTarget("192.168.0.8:99999"), {
    ok: false,
    error: "Use an IPv4 address and port like 192.168.0.10:8082",
  });
  assert.deepEqual(normalizeHostTarget(""), {
    ok: false,
    error: "Use an IPv4 address and port like 192.168.0.10:8082",
  });
});

test("buildTransportUrls uses the explicit host target", () => {
  assert.deepEqual(buildTransportUrls("192.168.0.8:8081"), {
    wsUrl: "ws://192.168.0.8:8081/ws",
    httpUrl: "http://192.168.0.8:8081/input",
  });
});

test("stream settings normalization clamps invalid values into the supported low-latency range", () => {
  assert.deepEqual(DEFAULT_STREAM_SETTINGS, {
    width: 1280,
    height: 720,
    fps: 60,
    bitrateKbps: 6000,
  });

  assert.deepEqual(
    normalizeStreamSettings({
      width: "5120",
      height: "120",
      fps: "999",
      bitrateKbps: "250",
    }),
    {
      width: 3840,
      height: 360,
      fps: 120,
      bitrateKbps: 1500,
    },
  );

  assert.deepEqual(
    normalizeStreamSettings({
      width: "1981",
      height: "1079",
      fps: "61",
      bitrateKbps: "6055",
    }),
    {
      width: 1980,
      height: 1078,
      fps: 61,
      bitrateKbps: 6100,
    },
  );
});

test("loadSavedHostTarget ignores invalid saved values", () => {
  const storage = createMemoryStorage();
  storage.setItem("joycon_host_target", "bad-value");
  assert.equal(loadSavedHostTarget(storage), "");
});

test("stick sensitivity helpers clamp, persist, and map higher values to a faster curve", () => {
  const storage = createMemoryStorage();

  assert.equal(loadSavedStickSensitivity(storage), DEFAULT_STICK_SENSITIVITY);
  assert.equal(normalizeStickSensitivity(1.5), 1);
  assert.equal(normalizeStickSensitivity(-1), 0);
  assert.equal(normalizeStickSensitivity("0.837"), 0.84);

  storage.setItem(STICK_SENSITIVITY_STORAGE_KEY, "bad-value");
  assert.equal(loadSavedStickSensitivity(storage), DEFAULT_STICK_SENSITIVITY);

  const saved = saveStickSensitivity(storage, 0.91);
  assert.deepEqual(saved, { ok: true, value: 0.91 });
  assert.equal(storage.getItem(STICK_SENSITIVITY_STORAGE_KEY), "0.91");
  assert.ok(getStickResponseExponent(0.9) < getStickResponseExponent(0.2));
});

test("control opacity helpers clamp, persist, and restore transparent button alpha", () => {
  const storage = createMemoryStorage();

  assert.equal(loadSavedControlOpacity(storage), DEFAULT_CONTROL_OPACITY);
  assert.equal(normalizeControlOpacity(""), DEFAULT_CONTROL_OPACITY);
  assert.equal(normalizeControlOpacity(-1), 0.05);
  assert.equal(normalizeControlOpacity(2), 0.65);
  assert.equal(normalizeControlOpacity("0.337"), 0.34);

  storage.setItem(CONTROL_OPACITY_STORAGE_KEY, "bad-value");
  assert.equal(loadSavedControlOpacity(storage), DEFAULT_CONTROL_OPACITY);

  const saved = saveControlOpacity(storage, 0.42);
  assert.deepEqual(saved, { ok: true, value: 0.42 });
  assert.equal(storage.getItem(CONTROL_OPACITY_STORAGE_KEY), "0.42");
});

test("saveHostTarget fails when storage is missing", () => {
  assert.deepEqual(saveHostTarget(undefined, "192.168.0.8:8081"), {
    ok: false,
    error: "Unable to save the host target on this device",
  });
});

test("saveHostTarget fails when storage.setItem throws", () => {
  const storage = {
    setItem() {
      throw new Error("disk full");
    },
  };

  assert.deepEqual(saveHostTarget(storage, "192.168.0.8:8081"), {
    ok: false,
    error: "Unable to save the host target on this device",
  });
});

test("HostDrawerController keeps the drawer open on invalid input and auto-hides after save", () => {
  const storage = createMemoryStorage();
  const controller = new HostDrawerController({ storage });

  assert.equal(controller.snapshot().isOpen, false);
  assert.equal(controller.snapshot().stickSensitivity, DEFAULT_STICK_SENSITIVITY);
  assert.equal(controller.snapshot().controlOpacity, DEFAULT_CONTROL_OPACITY);
  assert.equal(controller.snapshot().controllerVisible, DEFAULT_CONTROLLER_VISIBLE);
  assert.equal(controller.snapshot().hudVisible, DEFAULT_HUD_VISIBLE);
  controller.open();
  assert.equal(controller.snapshot().isOpen, true);
  controller.close();
  assert.equal(controller.snapshot().isOpen, false);
  controller.open();

  const invalid = controller.submit("abc");
  assert.equal(invalid.ok, false);
  assert.equal(controller.snapshot().isOpen, true);
  assert.equal(controller.snapshot().error, "Use an IPv4 address and port like 192.168.0.10:8082");

  const valid = controller.submit("192.168.0.8:8081");
  assert.equal(valid.ok, true);
  assert.equal(controller.snapshot().isOpen, false);
  assert.equal(controller.snapshot().hostTarget, "192.168.0.8:8081");
  assert.equal(storage.getItem("joycon_host_target"), "192.168.0.8:8081");
  assert.equal(valid.endpoints.wsUrl, "ws://192.168.0.8:8081/ws");
  assert.equal(valid.endpoints.httpUrl, "http://192.168.0.8:8081/input");

  const sensitivity = controller.updateStickSensitivity(0.82);
  assert.deepEqual(sensitivity, {
    ok: true,
    value: 0.82,
    responseExponent: getStickResponseExponent(0.82),
  });
  assert.equal(controller.snapshot().isOpen, false);
  assert.equal(controller.snapshot().stickSensitivity, 0.82);
  assert.equal(storage.getItem(STICK_SENSITIVITY_STORAGE_KEY), "0.82");

  const overwritten = controller.submit("192.168.0.9:8082");
  assert.equal(overwritten.ok, true);
  assert.equal(storage.getItem("joycon_host_target"), "192.168.0.9:8082");

  controller.open();
  controller.updateStickSensitivity(0.9);
  controller.updateControlOpacity(0.41);
  controller.updateControllerVisible(false);
  controller.updateHudVisible(false);
  assert.equal(controller.snapshot().isOpen, true);
  assert.equal(controller.snapshot().controlOpacity, 0.41);
  assert.equal(controller.snapshot().controllerVisible, false);
  assert.equal(controller.snapshot().hudVisible, false);
  assert.equal(storage.getItem(CONTROL_OPACITY_STORAGE_KEY), "0.41");
  assert.equal(storage.getItem(CONTROLLER_VISIBLE_STORAGE_KEY), "false");
  assert.equal(storage.getItem(HUD_VISIBLE_STORAGE_KEY), "false");
});

test("HostDrawerController persists a host draft separately from the connected host target", () => {
  const storage = createMemoryStorage();
  const controller = new HostDrawerController({ storage });

  assert.equal(controller.snapshot().hostTarget, "");
  assert.equal(controller.snapshot().hostTargetDraft, "");

  controller.updateHostDraft("10.0.0.3:8082");

  assert.equal(storage.getItem("joycon_host_target_draft"), "10.0.0.3:8082");
  assert.equal(controller.snapshot().hostTarget, "");
  assert.equal(controller.snapshot().hostTargetDraft, "10.0.0.3:8082");

  controller.submit("10.0.0.3:8082");

  assert.equal(controller.snapshot().hostTarget, "10.0.0.3:8082");
  assert.equal(controller.snapshot().hostTargetDraft, "10.0.0.3:8082");
});

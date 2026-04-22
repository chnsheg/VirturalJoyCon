import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTransportUrls,
  DEFAULT_STORAGE_KEY,
  DEFAULT_STICK_SENSITIVITY,
  HostDrawerController,
  HOST_ERROR,
  STICK_SENSITIVITY_STORAGE_KEY,
  getStickResponseExponent,
  loadSavedStickSensitivity,
  loadSavedHostTarget,
  normalizeStickSensitivity,
  normalizeHostTarget,
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
  assert.equal(HOST_ERROR, "Use an IPv4 address and port like 192.168.0.10:8081");
  assert.equal(STICK_SENSITIVITY_STORAGE_KEY, "joycon_stick_sensitivity");
  assert.equal(DEFAULT_STICK_SENSITIVITY, 0.68);
});

test("normalizeHostTarget rejects malformed host strings", () => {
  assert.deepEqual(normalizeHostTarget("192.168.0.999:8081"), {
    ok: false,
    error: "Use an IPv4 address and port like 192.168.0.10:8081",
  });
  assert.deepEqual(normalizeHostTarget("192.168.0.8:99999"), {
    ok: false,
    error: "Use an IPv4 address and port like 192.168.0.10:8081",
  });
  assert.deepEqual(normalizeHostTarget(""), {
    ok: false,
    error: "Use an IPv4 address and port like 192.168.0.10:8081",
  });
});

test("buildTransportUrls uses the explicit host target", () => {
  assert.deepEqual(buildTransportUrls("192.168.0.8:8081"), {
    wsUrl: "ws://192.168.0.8:8081/ws",
    httpUrl: "http://192.168.0.8:8081/input",
  });
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
  controller.open();
  assert.equal(controller.snapshot().isOpen, true);
  controller.close();
  assert.equal(controller.snapshot().isOpen, false);
  controller.open();

  const invalid = controller.submit("abc");
  assert.equal(invalid.ok, false);
  assert.equal(controller.snapshot().isOpen, true);
  assert.equal(controller.snapshot().error, "Use an IPv4 address and port like 192.168.0.10:8081");

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
  assert.equal(controller.snapshot().isOpen, true);
});

export const DEFAULT_STORAGE_KEY = "joycon_host_target";
export const HOST_ERROR = "Use an IPv4 address and port like 192.168.0.10:8081";
export const STICK_SENSITIVITY_STORAGE_KEY = "joycon_stick_sensitivity";
export const DEFAULT_STICK_SENSITIVITY = 0.68;
export const STICK_SENSITIVITY_ERROR = "Unable to save the stick sensitivity on this device";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeHostTarget(value) {
  const trimmed = String(value ?? "").trim();
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(trimmed);
  if (!match) {
    return { ok: false, error: HOST_ERROR };
  }

  const octets = match[1].split(".").map((part) => Number(part));
  const port = Number(match[2]);
  const validOctets = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;

  if (!validOctets || !validPort) {
    return { ok: false, error: HOST_ERROR };
  }

  return {
    ok: true,
    value: `${octets.join(".")}:${port}`,
  };
}

export function buildTransportUrls(hostTarget) {
  return {
    wsUrl: `ws://${hostTarget}/ws`,
    httpUrl: `http://${hostTarget}/input`,
  };
}

export function normalizeStickSensitivity(value) {
  if (value === null || value === undefined) {
    return DEFAULT_STICK_SENSITIVITY;
  }

  if (typeof value === "string" && value.trim() === "") {
    return DEFAULT_STICK_SENSITIVITY;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_STICK_SENSITIVITY;
  }

  return Number(clamp(numeric, 0, 1).toFixed(2));
}

export function getStickResponseExponent(sensitivity) {
  const normalized = normalizeStickSensitivity(sensitivity);
  return Number((1.9 - normalized * 0.8).toFixed(3));
}

export function loadSavedHostTarget(storage, storageKey = DEFAULT_STORAGE_KEY) {
  try {
    const value = storage?.getItem?.(storageKey) ?? "";
    const normalized = normalizeHostTarget(value);
    return normalized.ok ? normalized.value : "";
  } catch {
    return "";
  }
}

export function loadSavedStickSensitivity(
  storage,
  storageKey = STICK_SENSITIVITY_STORAGE_KEY,
) {
  try {
    const value = storage?.getItem?.(storageKey);
    return normalizeStickSensitivity(value);
  } catch {
    return DEFAULT_STICK_SENSITIVITY;
  }
}

export function saveHostTarget(storage, value, storageKey = DEFAULT_STORAGE_KEY) {
  const normalized = normalizeHostTarget(value);
  if (!normalized.ok) {
    return normalized;
  }

  if (typeof storage?.setItem !== "function") {
    return { ok: false, error: "Unable to save the host target on this device" };
  }

  try {
    storage.setItem(storageKey, normalized.value);
  } catch {
    return { ok: false, error: "Unable to save the host target on this device" };
  }

  return normalized;
}

export function saveStickSensitivity(
  storage,
  value,
  storageKey = STICK_SENSITIVITY_STORAGE_KEY,
) {
  const normalized = normalizeStickSensitivity(value);
  if (typeof storage?.setItem !== "function") {
    return { ok: false, error: STICK_SENSITIVITY_ERROR };
  }

  try {
    storage.setItem(storageKey, String(normalized));
  } catch {
    return { ok: false, error: STICK_SENSITIVITY_ERROR };
  }

  return { ok: true, value: normalized };
}

export class HostDrawerController {
  constructor({
    storage,
    storageKey = DEFAULT_STORAGE_KEY,
    stickSensitivityStorageKey = STICK_SENSITIVITY_STORAGE_KEY,
  } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.stickSensitivityStorageKey = stickSensitivityStorageKey;
    this.hostTarget = loadSavedHostTarget(storage, storageKey);
    this.stickSensitivity = loadSavedStickSensitivity(storage, stickSensitivityStorageKey);
    this.isOpen = false;
    this.error = "";
  }

  open() {
    this.isOpen = true;
    return this.snapshot();
  }

  close() {
    this.isOpen = false;
    return this.snapshot();
  }

  submit(value) {
    const saved = saveHostTarget(this.storage, value, this.storageKey);
    if (!saved.ok) {
      this.isOpen = true;
      this.error = saved.error;
      return { ok: false, error: this.error };
    }

    this.hostTarget = saved.value;
    this.error = "";
    this.isOpen = false;
    return {
      ok: true,
      hostTarget: this.hostTarget,
      endpoints: buildTransportUrls(this.hostTarget),
    };
  }

  updateStickSensitivity(value) {
    const saved = saveStickSensitivity(this.storage, value, this.stickSensitivityStorageKey);
    if (!saved.ok) {
      this.error = saved.error;
      return saved;
    }

    this.stickSensitivity = saved.value;
    return {
      ok: true,
      value: this.stickSensitivity,
      responseExponent: getStickResponseExponent(this.stickSensitivity),
    };
  }

  snapshot() {
    return {
      hostTarget: this.hostTarget,
      stickSensitivity: this.stickSensitivity,
      isOpen: this.isOpen,
      error: this.error,
    };
  }
}

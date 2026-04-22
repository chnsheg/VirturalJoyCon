export const DEFAULT_STORAGE_KEY = "joycon_host_target";
export const HOST_DRAFT_STORAGE_KEY = "joycon_host_target_draft";
export const HOST_ERROR = "Use an IPv4 address and port like 192.168.0.10:8082";
export const STICK_SENSITIVITY_STORAGE_KEY = "joycon_stick_sensitivity";
export const DEFAULT_STICK_SENSITIVITY = 0.68;
export const STICK_SENSITIVITY_ERROR = "Unable to save the stick sensitivity on this device";
export const CONTROL_OPACITY_STORAGE_KEY = "joycon_control_opacity";
export const DEFAULT_CONTROL_OPACITY = 0.18;
export const CONTROL_OPACITY_ERROR = "Unable to save the control opacity on this device";
export const CONTROLLER_VISIBLE_STORAGE_KEY = "joycon_controller_visible";
export const DEFAULT_CONTROLLER_VISIBLE = true;
export const CONTROLLER_VISIBLE_ERROR = "Unable to save the controller visibility on this device";
export const HUD_VISIBLE_STORAGE_KEY = "joycon_hud_visible";
export const DEFAULT_HUD_VISIBLE = true;
export const HUD_VISIBLE_ERROR = "Unable to save the HUD visibility on this device";
export const DEFAULT_STREAM_SETTINGS = Object.freeze({
  width: 1280,
  height: 720,
  fps: 60,
  bitrateKbps: 6000,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBoundedInteger(value, fallback, min, max) {
  const numeric = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.round(clamp(numeric, min, max));
}

function normalizeEvenDimension(value, fallback, min, max) {
  const normalized = normalizeBoundedInteger(value, fallback, min, max);
  return Math.max(min, Math.min(max, normalized - (normalized % 2)));
}

function normalizeBitrateKbps(value, fallback, min, max) {
  const normalized = normalizeBoundedInteger(value, fallback, min, max);
  return Math.max(min, Math.min(max, Math.round(normalized / 100) * 100));
}

function normalizeBooleanSetting(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
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

export function normalizeStreamSettings(input = {}) {
  return {
    width: normalizeEvenDimension(input.width, DEFAULT_STREAM_SETTINGS.width, 640, 3840),
    height: normalizeEvenDimension(input.height, DEFAULT_STREAM_SETTINGS.height, 360, 2160),
    fps: normalizeBoundedInteger(input.fps, DEFAULT_STREAM_SETTINGS.fps, 24, 120),
    bitrateKbps: normalizeBitrateKbps(
      input.bitrateKbps,
      DEFAULT_STREAM_SETTINGS.bitrateKbps,
      1500,
      50000,
    ),
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

export function normalizeControlOpacity(value) {
  if (value === null || value === undefined) {
    return DEFAULT_CONTROL_OPACITY;
  }

  if (typeof value === "string" && value.trim() === "") {
    return DEFAULT_CONTROL_OPACITY;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_CONTROL_OPACITY;
  }

  return Number(clamp(numeric, 0.05, 0.65).toFixed(2));
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

export function loadSavedHostTargetDraft(
  storage,
  draftStorageKey = HOST_DRAFT_STORAGE_KEY,
  fallback = "",
) {
  try {
    const value = String(storage?.getItem?.(draftStorageKey) ?? "").trim();
    return value || String(fallback ?? "").trim();
  } catch {
    return String(fallback ?? "").trim();
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

export function loadSavedControlOpacity(
  storage,
  storageKey = CONTROL_OPACITY_STORAGE_KEY,
) {
  try {
    const value = storage?.getItem?.(storageKey);
    return normalizeControlOpacity(value);
  } catch {
    return DEFAULT_CONTROL_OPACITY;
  }
}

function loadSavedBooleanSetting(storage, storageKey, fallback) {
  try {
    return normalizeBooleanSetting(storage?.getItem?.(storageKey), fallback);
  } catch {
    return fallback;
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

export function saveHostTargetDraft(
  storage,
  value,
  storageKey = HOST_DRAFT_STORAGE_KEY,
) {
  const draft = String(value ?? "").trim();
  if (typeof storage?.setItem !== "function") {
    return { ok: false, value: draft };
  }

  try {
    storage.setItem(storageKey, draft);
  } catch {
    return { ok: false, value: draft };
  }

  return { ok: true, value: draft };
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

export function saveControlOpacity(
  storage,
  value,
  storageKey = CONTROL_OPACITY_STORAGE_KEY,
) {
  const normalized = normalizeControlOpacity(value);
  if (typeof storage?.setItem !== "function") {
    return { ok: false, error: CONTROL_OPACITY_ERROR };
  }

  try {
    storage.setItem(storageKey, String(normalized));
  } catch {
    return { ok: false, error: CONTROL_OPACITY_ERROR };
  }

  return { ok: true, value: normalized };
}

function saveBooleanSetting(storage, value, storageKey, errorMessage) {
  const normalized = normalizeBooleanSetting(value, true);
  if (typeof storage?.setItem !== "function") {
    return { ok: false, error: errorMessage };
  }

  try {
    storage.setItem(storageKey, String(normalized));
  } catch {
    return { ok: false, error: errorMessage };
  }

  return { ok: true, value: normalized };
}

export class HostDrawerController {
  constructor({
    storage,
    storageKey = DEFAULT_STORAGE_KEY,
    hostDraftStorageKey = HOST_DRAFT_STORAGE_KEY,
    stickSensitivityStorageKey = STICK_SENSITIVITY_STORAGE_KEY,
    controlOpacityStorageKey = CONTROL_OPACITY_STORAGE_KEY,
    controllerVisibleStorageKey = CONTROLLER_VISIBLE_STORAGE_KEY,
    hudVisibleStorageKey = HUD_VISIBLE_STORAGE_KEY,
  } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.hostDraftStorageKey = hostDraftStorageKey;
    this.stickSensitivityStorageKey = stickSensitivityStorageKey;
    this.controlOpacityStorageKey = controlOpacityStorageKey;
    this.controllerVisibleStorageKey = controllerVisibleStorageKey;
    this.hudVisibleStorageKey = hudVisibleStorageKey;
    this.hostTarget = loadSavedHostTarget(storage, storageKey);
    this.hostTargetDraft = loadSavedHostTargetDraft(storage, hostDraftStorageKey, this.hostTarget);
    this.stickSensitivity = loadSavedStickSensitivity(storage, stickSensitivityStorageKey);
    this.controlOpacity = loadSavedControlOpacity(storage, controlOpacityStorageKey);
    this.controllerVisible = loadSavedBooleanSetting(storage, controllerVisibleStorageKey, DEFAULT_CONTROLLER_VISIBLE);
    this.hudVisible = loadSavedBooleanSetting(storage, hudVisibleStorageKey, DEFAULT_HUD_VISIBLE);
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

  updateHostDraft(value) {
    const saved = saveHostTargetDraft(this.storage, value, this.hostDraftStorageKey);
    this.hostTargetDraft = saved.value;
    this.error = "";
    return {
      ok: true,
      value: this.hostTargetDraft,
    };
  }

  submit(value) {
    this.updateHostDraft(value);
    const saved = saveHostTarget(this.storage, value, this.storageKey);
    if (!saved.ok) {
      this.isOpen = true;
      this.error = saved.error;
      return { ok: false, error: this.error };
    }

    this.hostTarget = saved.value;
    this.hostTargetDraft = saved.value;
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

  updateControlOpacity(value) {
    const saved = saveControlOpacity(this.storage, value, this.controlOpacityStorageKey);
    if (!saved.ok) {
      this.error = saved.error;
      return saved;
    }

    this.controlOpacity = saved.value;
    return {
      ok: true,
      value: this.controlOpacity,
    };
  }

  updateControllerVisible(value) {
    const saved = saveBooleanSetting(
      this.storage,
      value,
      this.controllerVisibleStorageKey,
      CONTROLLER_VISIBLE_ERROR,
    );
    if (!saved.ok) {
      this.error = saved.error;
      return saved;
    }

    this.controllerVisible = saved.value;
    this.error = "";
    return {
      ok: true,
      value: this.controllerVisible,
    };
  }

  updateHudVisible(value) {
    const saved = saveBooleanSetting(
      this.storage,
      value,
      this.hudVisibleStorageKey,
      HUD_VISIBLE_ERROR,
    );
    if (!saved.ok) {
      this.error = saved.error;
      return saved;
    }

    this.hudVisible = saved.value;
    this.error = "";
    return {
      ok: true,
      value: this.hudVisible,
    };
  }

  snapshot() {
    return {
      hostTarget: this.hostTarget,
      hostTargetDraft: this.hostTargetDraft,
      stickSensitivity: this.stickSensitivity,
      controlOpacity: this.controlOpacity,
      controllerVisible: this.controllerVisible,
      hudVisible: this.hudVisible,
      isOpen: this.isOpen,
      error: this.error,
    };
  }
}

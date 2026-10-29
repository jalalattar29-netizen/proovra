/**
 * THE ONE DEVICE-LOCATION READ for every native capture path (product
 * decision 2, 2026-10-29).
 *
 * Location is ONE user choice — the Capture toggle — and when it is on, the
 * outcome of asking the device is always STATED: a fix, or why there is none
 * (DENIED / UNAVAILABLE / TIMEOUT). When it is off, the record says the
 * submitter chose not to include it (NOT_REQUESTED), never "not recorded".
 *
 * Rules every caller inherits by going through here:
 *   - foreground permission only; never a background or precise-upgrade ask;
 *   - a FRESH position with an explicit deadline — the platform call has no
 *     timeout of its own, and a hung request used to hang Finish;
 *   - never a cached/last-known fix: a stale position presented as "where the
 *     device was" is a false statement about the record;
 *   - the provider's mock flag travels with the fix (AUD-37);
 *   - 0 is a coordinate (the equator / prime meridian), not "missing";
 *   - never IP-geolocated.
 *
 * For a screen recording the read happens BEFORE the recording starts, and the
 * result is carried through the reservation; a location acquired later is
 * never presented as the recording's start location.
 */
import * as Location from "expo-location";
import { Alert } from "react-native";

export type LocationFailureOutcome = "DENIED" | "UNAVAILABLE" | "TIMEOUT";
/** What the reservation records when it carries no coordinates. */
export type LocationRequestOutcome = LocationFailureOutcome | "NOT_REQUESTED";

export type DeviceGps = {
  lat: number;
  lng: number;
  accuracyMeters?: number;
  providerReportedMock?: boolean;
};

export type DeviceLocationResult =
  | { outcome: "GRANTED"; gps: DeviceGps; acquiredAtIso: string }
  | { outcome: LocationFailureOutcome; gps: null };

/** How long a fresh fix may take before the outcome is TIMEOUT. */
export const DEVICE_LOCATION_TIMEOUT_MS = 15_000;
/** A fix older than this (by its own timestamp) is stale and never used. */
export const DEVICE_LOCATION_MAX_AGE_MS = 2 * 60 * 1000;

/** The slice of expo-location this module uses (injectable for tests). */
export type LocationApi = {
  requestForegroundPermissionsAsync: () => Promise<{ granted: boolean }>;
  getCurrentPositionAsync: (o: { accuracy: number }) => Promise<{
    coords: { latitude: number; longitude: number; accuracy?: number | null };
    timestamp?: number;
    mocked?: boolean;
  }>;
  Accuracy: { Balanced: number };
};

const isCoordinate = (v: unknown, limit: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;

/**
 * Ask the device for where it is NOW.
 *
 * Never throws: every way of not getting a fix is one of the three stated
 * outcomes, so a caller cannot forget to say why there is no location.
 */
export async function acquireDeviceLocation(
  options: { timeoutMs?: number; location?: LocationApi; now?: () => number } = {},
): Promise<DeviceLocationResult> {
  const api = options.location ?? (Location as unknown as LocationApi);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEVICE_LOCATION_TIMEOUT_MS;

  let granted = false;
  try {
    granted = (await api.requestForegroundPermissionsAsync()).granted === true;
  } catch {
    granted = false;
  }
  if (!granted) return { outcome: "DENIED", gps: null };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMEOUT"), timeoutMs);
  });
  try {
    const raced = await Promise.race([
      api.getCurrentPositionAsync({ accuracy: api.Accuracy.Balanced }),
      deadline,
    ]);
    if (raced === "TIMEOUT") return { outcome: "TIMEOUT", gps: null };
    const pos = raced;
    const lat = pos?.coords?.latitude;
    const lng = pos?.coords?.longitude;
    if (!isCoordinate(lat, 90) || !isCoordinate(lng, 180)) return { outcome: "UNAVAILABLE", gps: null };
    // A timestamp of 0 / absent means the platform did not say; a known one
    // that is old is a cached fix, which is not "where the device is".
    const ts = typeof pos.timestamp === "number" && Number.isFinite(pos.timestamp) ? pos.timestamp : 0;
    if (ts > 0 && now() - ts > DEVICE_LOCATION_MAX_AGE_MS) return { outcome: "UNAVAILABLE", gps: null };
    const accuracy = pos.coords.accuracy;
    return {
      outcome: "GRANTED",
      acquiredAtIso: new Date(now()).toISOString(),
      gps: {
        lat,
        lng,
        ...(typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracyMeters: accuracy } : {}),
        // AUD-37 — Android reports a fix from a mock provider; it is stated,
        // never presented as an ordinary recorded location.
        ...(pos.mocked === true ? { providerReportedMock: true } : {}),
      },
    };
  } catch {
    return { outcome: "UNAVAILABLE", gps: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What the person is told about one outcome, immediately. */
export function locationOutcomeMessage(outcome: DeviceLocationResult["outcome"] | "NOT_REQUESTED"): string {
  switch (outcome) {
    case "GRANTED":
      return "Location is available and will be recorded with this capture.";
    case "DENIED":
      return "Location permission is off for PROOVRA, so no location can be recorded. Allow it in Settings, or continue without location.";
    case "TIMEOUT":
      return "The device did not provide a location in time.";
    case "UNAVAILABLE":
      return "The device could not provide a current location.";
    default:
      return "Location will not be included.";
  }
}

/**
 * The reservation's location fields for one choice.
 *
 * Off ⇒ NOT_REQUESTED. On with a fix ⇒ the fix. On without one ⇒ the stated
 * reason. On with no attempt recorded ⇒ UNAVAILABLE: the choice was made and
 * nothing was obtained, which must not read as "not requested".
 */
export function reservationLocationFields(input: {
  useLocation: boolean;
  result: DeviceLocationResult | null;
}): { gps?: DeviceGps; locationRequestOutcome?: LocationRequestOutcome } {
  if (!input.useLocation) return { locationRequestOutcome: "NOT_REQUESTED" };
  const r = input.result;
  if (r && r.outcome === "GRANTED") return { gps: r.gps };
  return { locationRequestOutcome: r ? r.outcome : "UNAVAILABLE" };
}

export type LocationFailureChoice = "retry" | "proceed" | "cancel";

/** The words and buttons of the failure prompt (pure, so tests read them). */
export function locationFailurePrompt(
  outcome: LocationFailureOutcome,
  options: { required: boolean; proceedLabel?: string },
): { title: string; message: string; buttons: Array<{ label: string; choice: LocationFailureChoice }> } {
  const message = options.required
    ? `${locationOutcomeMessage(outcome)} The selected plan requires location, so this capture cannot finish without it.`
    : locationOutcomeMessage(outcome);
  return {
    title: outcome === "DENIED" ? "Location not allowed" : "Location not available",
    message,
    buttons: [
      { label: "Retry", choice: "retry" },
      // Never offered when the plan requires location.
      ...(options.required ? [] : [{ label: options.proceedLabel ?? "Finish without location", choice: "proceed" as const }]),
      { label: "Cancel", choice: "cancel" },
    ],
  };
}

/** Ask the person what to do about a failed read (system alert). */
export function askLocationFailure(
  outcome: LocationFailureOutcome,
  options: { required: boolean; proceedLabel?: string },
  alert: typeof Alert.alert = Alert.alert,
): Promise<LocationFailureChoice> {
  const p = locationFailurePrompt(outcome, options);
  return new Promise((resolve) => {
    let settled = false;
    const done = (c: LocationFailureChoice) => {
      if (settled) return;
      settled = true;
      resolve(c);
    };
    alert(
      p.title,
      p.message,
      p.buttons.map((b) => ({
        text: b.label,
        style: b.choice === "cancel" ? ("cancel" as const) : ("default" as const),
        onPress: () => done(b.choice),
      })),
      { cancelable: true, onDismiss: () => done("cancel") },
    );
  });
}

export type LocationDecision =
  | { kind: "acquired"; result: Extract<DeviceLocationResult, { outcome: "GRANTED" }> }
  | { kind: "proceed"; result: Extract<DeviceLocationResult, { gps: null }> }
  | { kind: "cancel"; result: DeviceLocationResult | null };

/**
 * Acquire, and on failure ASK — never a silent continue.
 *
 * Retry repeats the read (bounded, so a stuck dialog loop cannot spin); proceed
 * is offered only when the plan does not require location; cancel stops the
 * caller before anything starts.
 */
export async function acquireLocationWithChoice(input: {
  required: boolean;
  proceedLabel?: string;
  acquire?: () => Promise<DeviceLocationResult>;
  ask?: (outcome: LocationFailureOutcome, o: { required: boolean; proceedLabel?: string }) => Promise<LocationFailureChoice>;
  maxAttempts?: number;
}): Promise<LocationDecision> {
  const acquire = input.acquire ?? (() => acquireDeviceLocation());
  const ask = input.ask ?? ((o, opts) => askLocationFailure(o, opts));
  const max = Math.max(1, input.maxAttempts ?? 5);
  let last: DeviceLocationResult | null = null;
  for (let attempt = 0; attempt < max; attempt += 1) {
    last = await acquire();
    if (last.outcome === "GRANTED") return { kind: "acquired", result: last };
    const choice = await ask(last.outcome, { required: input.required, proceedLabel: input.proceedLabel });
    if (choice === "retry") continue;
    if (choice === "proceed" && !input.required) return { kind: "proceed", result: last };
    return { kind: "cancel", result: last };
  }
  return { kind: "cancel", result: last };
}

/** A route param ("1"/"true") read as the Capture toggle's value. */
export function locationParam(value: unknown): boolean {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "1" || v === "true";
}

/** The persisted form of a location carried on a staged screen record. */
export type CarriedLocation = {
  useLocation: boolean;
  /** The outcome at the START of the recording (null: off, never asked). */
  outcome: DeviceLocationResult["outcome"] | null;
  /** True when the read happened before the recording started. */
  recordedAtStart: boolean;
};

export function parseCarriedLocation(raw: unknown): CarriedLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.useLocation !== "boolean") return null;
  const outcomes = ["GRANTED", "DENIED", "UNAVAILABLE", "TIMEOUT"];
  return {
    useLocation: o.useLocation,
    outcome: typeof o.outcome === "string" && outcomes.includes(o.outcome) ? (o.outcome as CarriedLocation["outcome"]) : null,
    recordedAtStart: o.recordedAtStart === true,
  };
}

/** What /capture states (read-only) about a recording's carried location. */
export function carriedLocationStatus(loc: CarriedLocation | null): string | null {
  if (!loc || !loc.recordedAtStart) return null;
  if (!loc.useLocation) return "Location was not included when this recording started.";
  if (loc.outcome === "GRANTED") return "Location recorded at the start of the recording.";
  return `Location was requested at the start of the recording: ${locationOutcomeMessage(loc.outcome ?? "UNAVAILABLE")}`;
}

export const LOCATION_CANNOT_BE_ADDED_LATER =
  "Location cannot be added to a recording that has already started. It is recorded only at the start, so a later position is never presented as where the recording began.";

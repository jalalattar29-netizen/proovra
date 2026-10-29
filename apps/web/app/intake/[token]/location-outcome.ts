/**
 * F-36 (2026-10-29) — THE contributor location state machine of the public
 * intake page, kept pure so it is testable without a browser.
 *
 * ONE choice: the contributor's explicit Share click is the consent, and the
 * only call to navigator.geolocation. What the page sends is exactly what
 * happened, and the server's submit pipeline acts on every value it sends:
 *
 *   granted   → GRANTED + coordinates (0 is a coordinate, never "missing")
 *   denied    → DENIED        (the browser/user refused the permission)
 *   timeout   → TIMEOUT       (no fix within the time limit)
 *   unavailable → UNAVAILABLE (no geolocation support / position unavailable)
 *   skipped   → NOT_REQUESTED (the contributor chose not to share: "not included")
 *
 * A failed request is shown IMMEDIATELY with Try again, and — on an OPTIONAL
 * link — Continue without location (which keeps the recorded outcome). A
 * REQUIRED link blocks Submit until a fix is captured (the server refuses
 * too, with an actionable message). A NONE link shows nothing and sends
 * nothing: the page never advertises an option the pipeline ignores.
 */

export type IntakeLocationPolicy = "NONE" | "OPTIONAL" | "REQUIRED";

export type IntakeLocationFailure = "DENIED" | "UNAVAILABLE" | "TIMEOUT";

export type LocationState =
  | { phase: "idle" }
  | { phase: "requesting" }
  | {
      phase: "granted";
      lat: number;
      lng: number;
      accuracyMeters: number | null;
      capturedAt: string;
    }
  | { phase: "denied" }
  | { phase: "timeout" }
  | { phase: "unavailable"; reason: string }
  /** The contributor chose not to share (before or after a request). */
  | { phase: "skipped"; after: IntakeLocationFailure | null };

export type IntakeLocationSubmitBody = {
  consentState: "GRANTED" | "DENIED" | "UNAVAILABLE" | "TIMEOUT" | "NOT_REQUESTED";
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  capturedAtUtc?: string;
  source?: "BROWSER_GEOLOCATION";
};

export function normalizeIntakeLocationPolicy(raw: unknown): IntakeLocationPolicy {
  return raw === "OPTIONAL" || raw === "REQUIRED" ? raw : "NONE";
}

/** GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT. */
export function locationStateFromGeolocationError(code: number): LocationState {
  if (code === 1) return { phase: "denied" };
  if (code === 3) return { phase: "timeout" };
  return {
    phase: "unavailable",
    reason: "Your device couldn't determine its location.",
  };
}

export function locationStateFromPosition(pos: {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  timestamp: number;
}): LocationState {
  return {
    phase: "granted",
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracyMeters: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : null,
    capturedAt: new Date(pos.timestamp).toISOString(),
  };
}

/** The failure a state records, if any (also kept through "continue without"). */
export function locationFailureOf(state: LocationState): IntakeLocationFailure | null {
  if (state.phase === "denied") return "DENIED";
  if (state.phase === "timeout") return "TIMEOUT";
  if (state.phase === "unavailable") return "UNAVAILABLE";
  if (state.phase === "skipped") return state.after;
  return null;
}

/** "Not now" / "Continue without location": keeps the outcome of a failed request. */
export function skipLocationState(state: LocationState): LocationState {
  return { phase: "skipped", after: locationFailureOf(state) };
}

/**
 * The submit body's `location`. NONE sends nothing. Coordinates are sent only
 * for a captured fix; zero is a valid coordinate and is preserved.
 */
export function intakeLocationSubmitBody(
  policy: IntakeLocationPolicy,
  state: LocationState,
): IntakeLocationSubmitBody | undefined {
  if (policy === "NONE") return undefined;
  if (state.phase === "granted") {
    return {
      consentState: "GRANTED",
      latitude: state.lat,
      longitude: state.lng,
      ...(typeof state.accuracyMeters === "number" ? { accuracyMeters: state.accuracyMeters } : {}),
      capturedAtUtc: state.capturedAt,
      source: "BROWSER_GEOLOCATION",
    };
  }
  const failure = locationFailureOf(state);
  return { consentState: failure ?? "NOT_REQUESTED" };
}

/**
 * Why location stops Submit right now, or null. REQUIRED needs a captured
 * fix; any policy waits for a request already in flight, so a fix that is
 * about to land is never silently dropped.
 */
export function locationSubmitBlock(policy: IntakeLocationPolicy, state: LocationState): string | null {
  if (policy === "NONE") return null;
  if (state.phase === "requesting") return "Waiting for your location…";
  if (policy === "REQUIRED" && state.phase !== "granted") {
    return "This request needs your location. Use Share location above.";
  }
  return null;
}

/** The contributor-facing statement of a failed request (shown immediately). */
export function locationFailureMessage(policy: IntakeLocationPolicy, state: LocationState): string | null {
  const required = policy === "REQUIRED";
  switch (state.phase) {
    case "denied":
      return required
        ? "Location permission was denied. This request needs your location: allow location for this site in your browser settings, then try again — or contact the sender."
        : "Location permission was denied. Try again after allowing location for this site, or continue without location.";
    case "timeout":
      return required
        ? "Your device took too long to find its location. Move somewhere with a clearer signal and try again — or contact the sender."
        : "Your device took too long to find its location. Try again, or continue without location.";
    case "unavailable":
      return required
        ? `${state.reason} This request needs your location: try again, or contact the sender.`
        : `${state.reason} Try again, or continue without location.`;
    case "skipped":
      return "Location not included. You can still submit.";
    default:
      return null;
  }
}

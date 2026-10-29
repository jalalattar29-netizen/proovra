import type { LocationRequestOutcome } from "@proovra/shared";

import { roundGpsCoordinate } from "./file-utils";

/** The outcomes a browser request can end in without coordinates. */
export type BrowserLocationFailure = Extract<LocationRequestOutcome, "DENIED" | "UNAVAILABLE" | "TIMEOUT">;

export type BrowserCaptureLocation =
  | { gps: { lat: number; lng: number; accuracyMeters?: number }; outcome?: undefined }
  | { gps?: undefined; outcome: BrowserLocationFailure };

/** How long the browser may take to answer before the request reads TIMEOUT. */
export const BROWSER_LOCATION_TIMEOUT_MS = 10_000;

/**
 * One browser location request for a capture. Coordinates are reduced to
 * ~100 m unless the selected plan requires precise location. A request that
 * yields no coordinates says why — refused (DENIED), not answered in time
 * (TIMEOUT) or not provided (UNAVAILABLE) — so the record's location state
 * reads "not shared", "timed out" or "unavailable" instead of "not recorded".
 * Never both. `maximumAge: 0`: a cached (stale) fix is never accepted.
 */
export async function requestBrowserCaptureLocation(precise: boolean): Promise<BrowserCaptureLocation> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return { outcome: "UNAVAILABLE" };
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: BROWSER_LOCATION_TIMEOUT_MS,
        maximumAge: 0,
      }),
    );
    const round = (v: number) => (precise ? v : roundGpsCoordinate(v, 3));
    return {
      gps: { lat: round(pos.coords.latitude), lng: round(pos.coords.longitude), accuracyMeters: pos.coords.accuracy },
    };
  } catch (err) {
    // GeolocationPositionError: PERMISSION_DENIED 1, POSITION_UNAVAILABLE 2, TIMEOUT 3.
    const code = (err as { code?: number } | null)?.code;
    return { outcome: code === 1 ? "DENIED" : code === 3 ? "TIMEOUT" : "UNAVAILABLE" };
  }
}

/** What the capture screen says about a failed request, and what the user can do. */
export function browserLocationFailureMessage(outcome: BrowserLocationFailure, required: boolean): string {
  const why =
    outcome === "DENIED"
      ? "Location permission was denied. Allow location for this site in your browser, then retry."
      : outcome === "TIMEOUT"
        ? "Your browser did not provide a location in time."
        : "Your browser could not determine a location.";
  return required
    ? `${why} The selected plan requires location, so this record cannot be finished without it.`
    : `${why} Retry, or finish without location — the record will state that location was requested and not obtained.`;
}

type LocationCheckLike = { status: string; accuracyMeters?: number | null };

/** A check that ended without coordinates (the screen offers Retry). */
export function isLocationCheckFailure(check: LocationCheckLike): boolean {
  return check.status === "DENIED" || check.status === "UNAVAILABLE" || check.status === "TIMEOUT";
}

/** The one-line state under the Location toggle. Never implies coordinates exist when they do not. */
export function captureLocationCheckLabel(useLocation: boolean, check: LocationCheckLike): string {
  if (!useLocation) return "Not included";
  switch (check.status) {
    case "checking":
      return "Included · checking location…";
    case "ready":
      return typeof check.accuracyMeters === "number" && Number.isFinite(check.accuracyMeters)
        ? `Included · location available (±${Math.round(check.accuracyMeters)} m)`
        : "Included · location available";
    case "DENIED":
      return "Included · permission denied";
    case "TIMEOUT":
      return "Included · location timed out";
    case "UNAVAILABLE":
      return "Included · location unavailable";
    default:
      return "Included · measured when you finish";
  }
}

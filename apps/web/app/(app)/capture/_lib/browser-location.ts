import type { LocationRequestOutcome } from "@proovra/shared";

import { roundGpsCoordinate } from "./file-utils";

export type BrowserCaptureLocation =
  | { gps: { lat: number; lng: number; accuracyMeters?: number }; outcome?: undefined }
  | { gps?: undefined; outcome: Extract<LocationRequestOutcome, "DENIED" | "UNAVAILABLE"> };

/**
 * One browser location request for a capture. Coordinates are reduced to
 * ~100 m unless the selected plan requires precise location. A request that
 * yields no coordinates says why — refused (DENIED) or not provided
 * (UNAVAILABLE) — so the record's location state can read "not shared" or
 * "unavailable" instead of "not recorded". Never both.
 */
export async function requestBrowserCaptureLocation(precise: boolean): Promise<BrowserCaptureLocation> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return { outcome: "UNAVAILABLE" };
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000 }),
    );
    const round = (v: number) => (precise ? v : roundGpsCoordinate(v, 3));
    return {
      gps: { lat: round(pos.coords.latitude), lng: round(pos.coords.longitude), accuracyMeters: pos.coords.accuracy },
    };
  } catch (err) {
    // GeolocationPositionError.PERMISSION_DENIED is 1; anything else is the device failing to provide one.
    return { outcome: (err as { code?: number } | null)?.code === 1 ? "DENIED" : "UNAVAILABLE" };
  }
}

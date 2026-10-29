import test from "node:test";
import assert from "node:assert/strict";

import { requestBrowserCaptureLocation } from "../app/(app)/capture/_lib/browser-location";

/**
 * A capture's browser location request: coordinates when the browser gives
 * them (reduced to ~100 m unless the plan requires precision), otherwise WHY
 * there are none — refused (DENIED) vs not provided (UNAVAILABLE) — never both.
 * That outcome is what lets the record read "Location not shared" /
 * "Location unavailable" instead of a bare "not recorded", and never "Blocked".
 */
type Geo = Pick<Geolocation, "getCurrentPosition">;

async function withGeolocation<T>(geo: Geo | undefined, run: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: geo ? { geolocation: geo } : {}, configurable: true });
  try {
    return await run();
  } finally {
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

const position = (lat: number, lng: number, accuracy: number) =>
  ({ coords: { latitude: lat, longitude: lng, accuracy } }) as GeolocationPosition;
const granted = (pos: GeolocationPosition): Geo => ({ getCurrentPosition: (ok) => ok(pos) });
const failing = (code: number): Geo => ({
  getCurrentPosition: (_ok, fail) => fail?.({ code, message: "x" } as GeolocationPositionError),
});

test("granted, precise plan: exact coordinates, no outcome", async () => {
  const r = await withGeolocation(granted(position(52.520008, 13.404954, 9)), () => requestBrowserCaptureLocation(true));
  assert.deepEqual(r, { gps: { lat: 52.520008, lng: 13.404954, accuracyMeters: 9 } });
});

test("granted, ordinary plan: coordinates reduced to three decimals", async () => {
  const r = await withGeolocation(granted(position(52.520008, 13.404954, 9)), () => requestBrowserCaptureLocation(false));
  assert.deepEqual(r, { gps: { lat: 52.52, lng: 13.405, accuracyMeters: 9 } });
});

test("permission refused (code 1) is DENIED, with no coordinates", async () => {
  assert.deepEqual(await withGeolocation(failing(1), () => requestBrowserCaptureLocation(false)), { outcome: "DENIED" });
});

test("position unavailable (2) is UNAVAILABLE and timeout (3) is TIMEOUT — never DENIED", async () => {
  assert.deepEqual(await withGeolocation(failing(2), () => requestBrowserCaptureLocation(false)), { outcome: "UNAVAILABLE" });
  // 2026-10-29: a timeout is its own recorded outcome ("Location timed out"), so
  // the screen and the record can say the browser did not answer in time.
  assert.deepEqual(await withGeolocation(failing(3), () => requestBrowserCaptureLocation(false)), { outcome: "TIMEOUT" });
});

test("a browser without geolocation is UNAVAILABLE", async () => {
  assert.deepEqual(await withGeolocation(undefined, () => requestBrowserCaptureLocation(false)), { outcome: "UNAVAILABLE" });
});

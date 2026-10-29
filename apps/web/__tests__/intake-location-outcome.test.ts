/**
 * F-36 (2026-10-29) — the public intake page's location state machine.
 *
 * The contributor's Share click is the consent; what the page sends is what
 * happened (GRANTED / DENIED / TIMEOUT / UNAVAILABLE / NOT_REQUESTED), every
 * failure is shown at once with Try again (and Continue without on an
 * OPTIONAL link), REQUIRED blocks Submit until a fix lands, NONE sends
 * nothing, and 0 is a coordinate.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  intakeLocationSubmitBody,
  locationFailureMessage,
  locationStateFromGeolocationError,
  locationStateFromPosition,
  locationSubmitBlock,
  normalizeIntakeLocationPolicy,
  skipLocationState,
} from "../app/intake/[token]/location-outcome";

const __filename = fileURLToPath(import.meta.url);
const PAGE = resolve(dirname(__filename), "..", "app", "intake", "[token]", "page.tsx");

test("geolocation errors map to distinct outcomes (TIMEOUT is not UNAVAILABLE)", () => {
  assert.deepEqual(intakeLocationSubmitBody("OPTIONAL", locationStateFromGeolocationError(1)), { consentState: "DENIED" });
  assert.deepEqual(intakeLocationSubmitBody("OPTIONAL", locationStateFromGeolocationError(2)), { consentState: "UNAVAILABLE" });
  assert.deepEqual(intakeLocationSubmitBody("OPTIONAL", locationStateFromGeolocationError(3)), { consentState: "TIMEOUT" });
});

test("a 0 / 0 fix is sent as coordinates, never dropped", () => {
  const s = locationStateFromPosition({ coords: { latitude: 0, longitude: 0, accuracy: 0 }, timestamp: 0 });
  const body = intakeLocationSubmitBody("OPTIONAL", s);
  assert.equal(body?.consentState, "GRANTED");
  assert.equal(body?.latitude, 0);
  assert.equal(body?.longitude, 0);
  assert.equal(body?.accuracyMeters, 0);
});

test("NONE sends nothing and never blocks; unknown policies read as NONE", () => {
  const granted = locationStateFromPosition({ coords: { latitude: 1, longitude: 2 }, timestamp: 0 });
  assert.equal(intakeLocationSubmitBody("NONE", granted), undefined);
  assert.equal(locationSubmitBlock("NONE", { phase: "idle" }), null);
  assert.equal(normalizeIntakeLocationPolicy("MAYBE"), "NONE");
  assert.equal(normalizeIntakeLocationPolicy("REQUIRED"), "REQUIRED");
});

test("REQUIRED blocks until a fix; any policy waits for an in-flight request", () => {
  for (const s of [{ phase: "idle" } as const, { phase: "denied" } as const, { phase: "timeout" } as const]) {
    assert.match(String(locationSubmitBlock("REQUIRED", s)), /needs your location/);
  }
  assert.equal(
    locationSubmitBlock("REQUIRED", locationStateFromPosition({ coords: { latitude: 1, longitude: 2 }, timestamp: 0 })),
    null,
  );
  assert.equal(locationSubmitBlock("OPTIONAL", { phase: "denied" }), null);
  assert.match(String(locationSubmitBlock("OPTIONAL", { phase: "requesting" })), /Waiting/);
});

test("continue without keeps the failed outcome; Not now before asking is NOT_REQUESTED", () => {
  assert.deepEqual(intakeLocationSubmitBody("OPTIONAL", skipLocationState({ phase: "timeout" })), { consentState: "TIMEOUT" });
  assert.deepEqual(intakeLocationSubmitBody("OPTIONAL", skipLocationState({ phase: "denied" })), { consentState: "DENIED" });
  assert.deepEqual(intakeLocationSubmitBody("OPTIONAL", skipLocationState({ phase: "idle" })), { consentState: "NOT_REQUESTED" });
});

test("every failure is stated with what to do next", () => {
  for (const policy of ["OPTIONAL", "REQUIRED"] as const) {
    for (const s of [{ phase: "denied" } as const, { phase: "timeout" } as const, locationStateFromGeolocationError(2)]) {
      const msg = String(locationFailureMessage(policy, s));
      assert.match(msg, /try again/i, `${policy}/${s.phase}`);
      if (policy === "OPTIONAL") assert.match(msg, /continue without location/i);
      else assert.doesNotMatch(msg, /continue without/i);
    }
  }
});

test("the page wires the module: retry + continue-without controls, no inline outcome mapping", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.match(src, /intakeLocationSubmitBody\(locationPolicy, locationState\)/);
  assert.match(src, /locationStateFromGeolocationError\(err\.code\)/);
  assert.match(src, /data-intake-location-retry="true"/);
  assert.match(src, /data-intake-location-continue-without="true"/);
  // The old mapping sent "Not now" as DENIED.
  assert.doesNotMatch(src, /function skipLocation\(\) \{\s*setLocationState\(\{ phase: "denied" \}\)/);
});

// THE CANONICAL EVIDENCE LOCATION STATE — the truth table every surface reads.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_LOCATION_STATE_PRESENTATION,
  hasCaptureLocationMetadata,
  locationRequestOutcomeFromCustody,
  locationRequirementFromIntakePlan,
  resolveEvidenceLocation,
} from "../dist/index.js";

const created = (extra = {}) => ({ eventType: "EVIDENCE_CREATED", payload: { phase: "evidence_created", ...extra } });
const intake = (consent) => ({ eventType: "EXTERNAL_INTAKE_SUBMITTED", payload: { locationConsentState: consent } });

const CASES = [
  // [name, facts, expected state]
  ["valid recorded coordinates (web capture)", { lat: 52.52, lng: 13.405, accuracyMeters: 12, locationSource: "CAPTURE_BROWSER_GEOLOCATION" }, "RECORDED"],
  ["valid recorded coordinates (mobile capture)", { lat: "51.5", lng: "-0.12", locationSource: "CLIENT_APP_DEVICE_LOCATION" }, "RECORDED"],
  ["intake capture with shared location", { lat: 48.1, lng: 11.5, locationSource: "INTAKE_LINK_GEOLOCATION", requestOutcome: "GRANTED" }, "RECORDED"],
  ["not requested", { requestOutcome: "NOT_REQUESTED" }, "NOT_RECORDED"],
  ["no opt-in / uploaded evidence without location", { lat: null, lng: null }, "NOT_RECORDED"],
  ["legacy record with no location facts", {}, "NOT_RECORDED"],
  ["persisted permission denied / declined", { requestOutcome: "DENIED" }, "NOT_SHARED"],
  ["technical unavailability", { requestOutcome: "UNAVAILABLE" }, "UNAVAILABLE"],
  ["granted but nothing stored", { requestOutcome: "GRANTED" }, "UNAVAILABLE"],
  ["invalid: latitude out of range", { lat: 123, lng: 10 }, "INVALID"],
  ["invalid: one coordinate missing", { lat: 10, lng: null }, "INVALID"],
  ["invalid: not a number", { lat: "abc", lng: "1" }, "INVALID"],
  ["invalid coordinates win over a request outcome", { lat: 10, lng: 999, requestOutcome: "DENIED" }, "INVALID"],
];

for (const [name, facts, expected] of CASES) {
  test(`location truth table — ${name} → ${expected}`, () => {
    const p = resolveEvidenceLocation(facts);
    assert.equal(p.state, expected);
    assert.equal(p.label, EVIDENCE_LOCATION_STATE_PRESENTATION[expected].label);
    assert.notEqual(p.tone, "danger");
    assert.doesNotMatch(p.label + (p.detail ?? ""), /block/i, "a location state is never 'blocked'");
    if (expected === "RECORDED") {
      assert.ok(p.coordinates, "recorded coordinates are carried for the map");
      assert.ok(p.sourceLabel);
    } else {
      assert.equal(p.coordinates, null, "no coordinates (and so no map) unless recorded and valid");
      assert.equal(p.sourceLabel, null);
    }
  });
}

test("labels and tones: recorded is informational, absence is neutral with no detail, invalid is the only warning", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(EVIDENCE_LOCATION_STATE_PRESENTATION).map(([k, v]) => [k, [v.label, v.tone]])),
    {
      RECORDED: ["Location recorded", "info"],
      NOT_RECORDED: ["Location not recorded", "neutral"],
      NOT_SHARED: ["Location not shared", "neutral"],
      UNAVAILABLE: ["Location unavailable", "neutral"],
      INVALID: ["Location metadata invalid", "warning"],
    },
  );
  assert.equal(EVIDENCE_LOCATION_STATE_PRESENTATION.NOT_RECORDED.detail, null);
});

test("denied is not invalid; invalid coordinates are never shown", () => {
  assert.notEqual(resolveEvidenceLocation({ requestOutcome: "DENIED" }).state, "INVALID");
  const invalid = resolveEvidenceLocation({ lat: 91, lng: 0 });
  assert.equal(invalid.coordinates, null);
  assert.equal(hasCaptureLocationMetadata({ lat: 91, lng: 0 }), false, "the map gate refuses out-of-range coordinates");
  assert.equal(hasCaptureLocationMetadata({ lat: 0, lng: 181 }), false);
  assert.equal(hasCaptureLocationMetadata({ lat: -90, lng: 180 }), true);
});

test("a workflow requirement is stated apart from the recorded truth", () => {
  const missing = resolveEvidenceLocation({ requirement: "required" });
  assert.equal(missing.state, "NOT_RECORDED");
  assert.deepEqual(missing.requirement, { level: "required", label: "Required by the collection plan", unmet: true });
  const met = resolveEvidenceLocation({ lat: 1, lng: 1, requirement: "required" });
  assert.equal(met.requirement.unmet, false);
  assert.equal(resolveEvidenceLocation({ requirement: "optional" }).requirement.unmet, false);
  assert.equal(resolveEvidenceLocation({ requirement: "nonsense" }).requirement, null);
  assert.equal(locationRequirementFromIntakePlan({ locationRequirement: "recommended" }), "recommended");
  assert.equal(locationRequirementFromIntakePlan(null), null);
});

test("request outcomes are read only from the custody facts capture paths record", () => {
  assert.equal(locationRequestOutcomeFromCustody([]), null);
  assert.equal(locationRequestOutcomeFromCustody([created()]), null, "a legacy create records no outcome");
  assert.equal(locationRequestOutcomeFromCustody([created({ locationRequest: { outcome: "DENIED" } })]), "DENIED");
  assert.equal(locationRequestOutcomeFromCustody([created(), intake("UNAVAILABLE")]), "UNAVAILABLE");
  assert.equal(locationRequestOutcomeFromCustody([created(), intake(null)]), null, "a NONE-policy intake records nothing");
  assert.equal(locationRequestOutcomeFromCustody([intake("BOGUS")]), null);
});

/**
 * AUD-37 (2026-10-20) — a location the device's provider marked as MOCKED is
 * never presented as an ordinary recorded fix, in any language.
 * AUD-52 (2026-10-20) — a capture channel recorded LATER (a backfill) says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MOCK_LOCATION_DETAIL,
  acquisitionRecordedByQualified,
  localizeEvidenceLocation,
  locationProviderMockFromCustody,
  resolveEvidenceLocation,
} from "../dist/index.js";

const COORDS = { lat: 51.5, lng: -0.12, accuracyMeters: 8 };

test("a mocked fix stays RECORDED but is stated as a mock, with a warning tone", () => {
  const r = resolveEvidenceLocation({ ...COORDS, providerReportedMock: true });
  assert.equal(r.state, "RECORDED");
  assert.equal(r.providerReportedMock, true);
  assert.equal(r.tone, "warning");
  assert.equal(r.detail, MOCK_LOCATION_DETAIL);
});

test("an ordinary fix is unchanged", () => {
  const r = resolveEvidenceLocation(COORDS);
  assert.equal(r.providerReportedMock, false);
  assert.equal(r.tone, "info");
  assert.equal(r.detail, null);
});

test("a mock flag without valid coordinates claims nothing", () => {
  const r = resolveEvidenceLocation({ providerReportedMock: true });
  assert.equal(r.state, "NOT_RECORDED");
  assert.equal(r.providerReportedMock, false);
});

test("the mock warning survives localization in every language", () => {
  const served = resolveEvidenceLocation({ ...COORDS, providerReportedMock: true });
  for (const locale of ["en", "de", "ar"]) {
    const view = localizeEvidenceLocation(served, locale);
    assert.ok(view.detail && view.detail.length > 20, locale);
  }
  assert.equal(localizeEvidenceLocation(served, "en").detail, MOCK_LOCATION_DETAIL);
  assert.match(localizeEvidenceLocation(served, "de").detail, /Mock/);
  // An ordinary fix keeps its (empty) detail.
  assert.equal(localizeEvidenceLocation(resolveEvidenceLocation(COORDS), "de").detail, null);
});

test("the creation custody event is the authority for the mock flag", () => {
  const created = (gps) => ({ eventType: "EVIDENCE_CREATED", payload: { gps } });
  assert.equal(locationProviderMockFromCustody([created({ lat: 1, lng: 2, providerReportedMock: true })]), true);
  assert.equal(locationProviderMockFromCustody([created({ lat: 1, lng: 2 })]), false);
  assert.equal(locationProviderMockFromCustody([{ eventType: "OTHER", payload: { gps: { providerReportedMock: true } } }]), false);
  assert.equal(locationProviderMockFromCustody(null), false);
});

test("a backfilled capture channel is stated as recorded later; a creation-time one reads plainly", () => {
  assert.equal(acquisitionRecordedByQualified("Secure intake", "RECORDED_AT_CREATION"), "Secure intake");
  assert.equal(acquisitionRecordedByQualified("Secure intake", null), "Secure intake");
  assert.equal(
    acquisitionRecordedByQualified("Secure intake", "BACKFILL_INTAKE_SESSION_LINK"),
    "Secure intake (recorded later, from the secure-intake session link)",
  );
});

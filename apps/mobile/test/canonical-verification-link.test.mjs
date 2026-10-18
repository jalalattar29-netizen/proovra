/**
 * The mobile Evidence screen's verification link is the record's CANONICAL
 * page — the same resolver as the web Evidence page (`resolveCanonicalVerificationLink`):
 * the review workspace's canonical contract when the API sends it; only an API
 * that predates the contract falls back to the published link.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let ER;
before(async () => {
  ER = await loadModule("src/product/evidence-record.ts");
});

const ORIGIN = "https://www.proovra.com";
const REF = "pvr_" + "c".repeat(27);
const PUBLISHED = { publicVerificationSummary: { state: "PUBLISHED", sharePath: "/verify/11111111-1111-4111-8111-111111111111" } };
const canonical = (over = {}) => ({ status: "AVAILABLE", reference: REF, verifyPath: `/verify/${REF}`, issuedAtUtc: null, refusalReason: null, ...over });

test("an AVAILABLE canonical reference is THE link", () => {
  assert.equal(ER.resolveCanonicalVerificationLink({ ...PUBLISHED, canonicalVerification: canonical() }, ORIGIN), `${ORIGIN}/verify/${REF}`);
  assert.equal(
    ER.resolveCanonicalVerificationLink({ publicVerificationSummary: { state: "CONFIGURED_NOT_PUBLISHED", sharePath: null }, canonicalVerification: canonical() }, ORIGIN),
    `${ORIGIN}/verify/${REF}`,
  );
});

test("REGRESSION: the historical published record-id link never stands in for a canonical link that is not available", () => {
  for (const over of [{ status: "NOT_ISSUED", reference: null, verifyPath: null }, { status: "WITHDRAWN" }, { status: "RETAINED" }]) {
    assert.equal(ER.resolveCanonicalVerificationLink({ ...PUBLISHED, canonicalVerification: canonical(over) }, ORIGIN), null);
  }
});

test("(2026-10-18) the publication model is retired: without the canonical contract there is no link — never a record-id link", () => {
  assert.equal(ER.resolveCanonicalVerificationLink(PUBLISHED, ORIGIN), null);
  assert.equal(ER.resolveCanonicalVerificationLink({ ...PUBLISHED, canonicalVerification: canonical() }, null), null);
  assert.equal(ER.buildPublishedVerificationUrl, undefined);
  // A non-pvr_ path is never a canonical link.
  assert.equal(ER.resolveCanonicalVerificationLink({ canonicalVerification: canonical({ verifyPath: "/verify/pvs_share" }) }, ORIGIN), null);
});

test("the summary's access states and disclosure, in words (publicationState / published removed)", () => {
  const pv = (over) => ER.projectPublicVerification({ publicVerificationSummary: { state: "AVAILABLE", disclosureMode: "VERIFICATION_ONLY", showRecordedLocation: false, ...over } });
  assert.deepEqual(ER.describePublicVerificationState(pv({})).label, "Available");
  assert.deepEqual(ER.describePublicVerificationState(pv({ state: "WITHDRAWN" })).label, "Withdrawn");
  assert.deepEqual(ER.describePublicVerificationState(pv({ state: "SUSPENDED" })).label, "Suspended");
  assert.deepEqual(ER.describePublicVerificationState(pv({ state: "NOT_INCLUDED" })).label, "Not included on plan");
  assert.equal(ER.describePublicVerificationState(pv({ state: "PUBLISHED" })).label, "State unavailable", "a retired state is not read");
  assert.equal(ER.publicVerificationTone("AVAILABLE"), "neutral", "a reachable page is not a verification");
  assert.equal(ER.publicVerificationTone("WITHDRAWN"), "risk");
  assert.deepEqual(ER.describeVerificationDisclosure(pv({})), {
    modeLabel: "Verification only",
    locationLabel: "Recorded location hidden",
    sentence: "Visitors see the complete verification result; the record's content is withheld.",
  });
  assert.equal(ER.describeVerificationDisclosure(pv({ disclosureMode: "CONTENT_PREVIEW", showRecordedLocation: true })).locationLabel, "Recorded location shown");
  // The location flag counts only with CONTENT_PREVIEW.
  assert.equal(ER.describeVerificationDisclosure(pv({ showRecordedLocation: true })).locationLabel, "Recorded location hidden");
  assert.equal(ER.describeVerificationDisclosure(pv({ disclosureMode: "SOMETHING" })), null);
  assert.equal(ER.webRecordPageUrl("https://www.proovra.com/", "ev-1"), "https://www.proovra.com/evidence/ev-1");
  assert.equal(ER.webRecordPageUrl(null, "ev-1"), null);
});

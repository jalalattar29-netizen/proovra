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

test("an AVAILABLE canonical reference is THE link, independent of publication", () => {
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

test("only an API without the contract falls back to the published link", () => {
  assert.equal(ER.resolveCanonicalVerificationLink(PUBLISHED, ORIGIN), `${ORIGIN}/verify/11111111-1111-4111-8111-111111111111`);
  assert.equal(ER.resolveCanonicalVerificationLink({ ...PUBLISHED, canonicalVerification: canonical() }, null), null);
});

/**
 * Mobile ↔ web parity for legal hold and retention (2026-10-23).
 *
 * The mobile Integrity matrix read the storage object's native legal-hold
 * header (no longer written) and only the workspace-policy retention column —
 * the same two defects the web Integrity tab had. Both now render the SHARED
 * `presentEvidenceProtection` over the canonical `lifecycle` projection, so
 * this asserts that every legal-hold × retention × lifecycle case produces
 * EXACTLY the shared authority's rows — no mobile-only interpretation.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let ER;
let SHARED;
before(async () => {
  ER = await loadModule("src/product/evidence-record.ts");
  SHARED = await import("@proovra/shared");
});

const fmt = (iso) => iso.slice(0, 10);
const lifecycle = (over) => ({
  productState: "ACTIVE",
  legalHold: false,
  legalHoldState: "NONE",
  appRetentionUntilUtc: null,
  objectLockRetainUntilUtc: null,
  effectiveRetentionUntilUtc: null,
  ...over,
});
const workspace = (lc, evOver = {}) => ({
  // The matrix renders only for a response that carries one.
  preservationMatrix: { report: {}, verificationPackage: {}, signature: {}, tsa: {}, ots: {}, storage: {} },
  evidence: {
    id: "ev-1",
    lifecycle: lc,
    // The fields the old rows read — set to values that would have produced
    // the old (wrong) wording, to prove they are no longer consulted.
    storageObjectLockLegalHoldStatus: null,
    retentionUntilUtc: null,
    ...evOver,
  },
});

const rowsOf = (rw) => {
  const m = ER.buildPreservationMatrix(rw, fmt);
  return {
    legalHold: m.find((r) => r.label === "Legal hold"),
    retention: m.find((r) => r.label === "Retention"),
  };
};

const CASES = [
  ["active hold", lifecycle({ legalHold: true, legalHoldState: "ACTIVE" })],
  ["no hold", lifecycle({})],
  ["hold check failed", lifecycle({ legalHold: true, legalHoldState: "UNAVAILABLE" })],
  ["list-row boolean only", lifecycle({ legalHold: true, legalHoldState: undefined })],
  ["storage lock only", lifecycle({ objectLockRetainUntilUtc: "2034-10-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" })],
  ["workspace policy only", lifecycle({ appRetentionUntilUtc: "2027-01-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2027-01-01T00:00:00.000Z" })],
  ["both", lifecycle({ appRetentionUntilUtc: "2027-01-01T00:00:00.000Z", objectLockRetainUntilUtc: "2034-10-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" })],
  ["retention ended", lifecycle({ objectLockRetainUntilUtc: "2020-01-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2020-01-01T00:00:00.000Z" })],
  ["archived", lifecycle({ productState: "ARCHIVED", objectLockRetainUntilUtc: "2034-10-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" })],
  ["trashed under hold", lifecycle({ productState: "TRASHED", legalHold: true, legalHoldState: "ACTIVE" })],
  ["destroyed", lifecycle({ productState: "DESTROYED", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" })],
  ["projection missing", null],
];

for (const [name, lc] of CASES) {
  test(`${name}: mobile rows are exactly the shared presentation`, () => {
    const expected = SHARED.presentEvidenceProtection(lc, fmt);
    const got = rowsOf(workspace(lc));
    assert.ok(got.legalHold, "a Legal hold row exists");
    assert.ok(got.retention, "a Retention row exists");
    assert.equal(got.legalHold.value, expected.legalHold.value);
    assert.equal(got.legalHold.state, expected.legalHold.state);
    assert.equal(got.retention.value, expected.retention.value);
    assert.equal(got.retention.state, expected.retention.state);
  });
}

test("the old storage-header and workspace-column readings are gone", () => {
  // A record under an ACTIVE hold whose storage header says OFF and whose
  // workspace column is empty: the old matrix said "Legal hold off" and
  // "No record-level retention deadline recorded".
  const got = rowsOf(
    workspace(lifecycle({ legalHold: true, legalHoldState: "ACTIVE", objectLockRetainUntilUtc: "2034-10-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" }), {
      storageObjectLockLegalHoldStatus: "OFF",
    }),
  );
  assert.match(got.legalHold.value, /^Active legal hold/);
  assert.match(got.retention.value, /^Retained until 2034-10-01/);
  const all = ER.buildPreservationMatrix(workspace(lifecycle({})), fmt).map((r) => r.value).join(" | ");
  assert.doesNotMatch(all, /No legal hold metadata recorded|No record-level retention deadline recorded|Legal hold off/);
});

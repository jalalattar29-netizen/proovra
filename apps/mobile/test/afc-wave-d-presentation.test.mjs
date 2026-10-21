/**
 * Independent forward audit closure — Wave D on the native app.
 *
 * F-12: the Integrity matrix states the signature from its VALIDITY STATE; a
 *       revoked or mismatched key was a neutral "Recorded".
 * F-13: the record status badge is the shared label and tone ("Integrity
 *       failed" / "Uploaded" disagreed with every other surface).
 * F-15: storage protection is the shared classification; a COMPLIANCE lock
 *       recorded at sealing read "Not exposed in current API response".
 * F-16: the Reports fallback rows use the shared row mapping (ARTIFACT_MISSING
 *       read as "not requested"), for the ACTIVE workspace only.
 * F-26: after capture, "Report still generating" was said for every state —
 *       a plan without reports, a block, a terminal failure, a failed read.
 *
 * Real modules (esbuild bundle of the app source + the built shared package);
 * expected values are literals.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let ER;
let ED;
let DD;
let R;
before(async () => {
  ER = await loadModule("src/product/evidence-record.ts");
  ED = await loadModule("src/product/evidence-detail.ts");
  DD = await loadModule("src/product/domain-display.ts");
  R = await loadModule("src/product/reports.ts");
});

const fmt = (iso) => iso.slice(0, 10);
const workspace = (pm) => ({ preservationMatrix: { verificationStatus: "RECORDED_INTEGRITY_VERIFIED", ...pm } });
const row = (rows, label) => rows.find((r) => r.label === label);

test("F-12: a revoked signing key is a failed signature row, never 'Recorded'", () => {
  const rows = ER.buildPreservationMatrix(
    workspace({ signature: { recorded: true, valid: true, validityState: "REVOKED_KEY", signingKeyRevokedAtUtc: "2026-10-01T00:00:00.000Z" } }),
    fmt,
  );
  const sig = row(rows, "Signature");
  assert.equal(sig.state, "failed");
  assert.match(sig.value, /^Signing key revoked at /);
  assert.notEqual(sig.value, "Recorded");
});

test("F-12: a valid signature is verified; a signature with no stated validity is not", () => {
  assert.deepEqual(
    (({ value, state }) => ({ value, state }))(row(ER.buildPreservationMatrix(workspace({ signature: { recorded: true, valid: true, validityState: "VALID" } }), fmt), "Signature")),
    { value: "Signature verified", state: "verified" },
  );
  const unstated = row(ER.buildPreservationMatrix(workspace({ signature: { recorded: true, valid: true } }), fmt), "Signature");
  assert.deepEqual({ value: unstated.value, state: unstated.state }, { value: "Signature validity not stated", state: "unavailable" });
});

test("F-12: the evidence-detail projection carries the same presentation", () => {
  const view = ED.projectPreservation(workspace({ signature: { recorded: true, valid: false, validityState: "KEY_MISMATCH", keyId: "k1" } }));
  assert.equal(view.signature.state, "failed");
  assert.equal(view.signature.keyId, "k1");
});

test("F-13: the native status badge is the shared label and tone", () => {
  assert.deepEqual(DD.evidenceStatusDisplay("FAILED_HASH_MISMATCH"), { label: "Integrity check failed", tone: "risk" });
  assert.deepEqual(DD.evidenceStatusDisplay("UPLOADED"), { label: "Uploaded (legacy)", tone: "neutral" });
  assert.deepEqual(DD.evidenceStatusDisplay("SIGNED"), { label: "Signed", tone: "verified" });
  assert.deepEqual(DD.evidenceStatusDisplay("UPLOADING"), { label: "Uploading", tone: "pending" });
});

test("F-15: a COMPLIANCE lock recorded at sealing is stated as protection", () => {
  const rows = ER.buildPreservationMatrix(
    workspace({ storage: { mode: "COMPLIANCE", retainUntil: "2036-01-01T00:00:00.000Z", legalHold: "OFF", source: "RECORDED", verified: false } }),
    fmt,
  );
  const storage = row(rows, "Storage protection");
  assert.equal(storage.value, "Object Lock COMPLIANCE until 2036-01-01 (recorded at sealing)");
  assert.equal(storage.state, "recorded");
});

test("F-15: the server's own classification wins; an unreadable posture is never protection", () => {
  const rows = ER.buildPreservationMatrix(workspace({ storage: { protection: "READ_FAILED", readFailed: true } }), fmt);
  assert.equal(row(rows, "Storage protection").state, "unavailable");
});

test("F-16: Reports fallback rows use the shared row mapping", () => {
  const page = R.parseUserScopedReports({
    items: [
      { evidenceId: "e1", status: "REPORTED", reportLifecycle: "ARTIFACT_MISSING", packageLifecycle: "BLOCKED", createdAt: "2026-10-01T00:00:00.000Z" },
      { evidenceId: "e2", status: "SIGNED", reportLifecycle: "ENTITLEMENT_UNAVAILABLE", packageLifecycle: "SOMETHING_NEW", createdAt: "2026-10-01T00:00:00.000Z" },
    ],
    nextCursor: null,
  });
  const [a, b] = page.items;
  assert.equal(a.reportState, "failed");
  assert.equal(a.packageState, "blocked");
  assert.equal(b.reportState, "unavailable");
  assert.equal(b.packageState, "unavailable");
});

test("F-16: the fallback is asked for the active workspace", () => {
  assert.equal(R.buildUserReportsPath("team 1"), "/v1/reports?teamId=team%201");
  assert.equal(R.buildUserReportsPath("team-1", "c/2"), "/v1/reports?teamId=team-1&cursor=c%2F2");
});

test("F-26: the capture screen waits only while a report can still arrive", () => {
  for (const state of ["QUEUED", "GENERATING", "ELIGIBLE_NOT_GENERATED", "RETRYABLE_FAILURE", "ENTITLEMENT_UNAVAILABLE"]) {
    assert.equal(ER.captureReportWaitStep(state).keepWaiting, true, state);
  }
  assert.deepEqual(ER.captureReportWaitStep("READY"), { message: null, keepWaiting: false });
  assert.deepEqual(ER.captureReportWaitStep("NOT_INCLUDED"), {
    message:
      "No report has been issued for this record: reports are not included in the plan that covers this record. The original evidence is finalized and can be verified.",
    keepWaiting: false,
  });
  assert.deepEqual(ER.captureReportWaitStep("BLOCKED"), { message: "Report generation is blocked by a policy decision.", keepWaiting: false });
  assert.deepEqual(ER.captureReportWaitStep("TERMINAL_FAILURE"), { message: "The report could not be produced for this record.", keepWaiting: false });
  // An unreadable or unknown state is never "still generating".
  for (const v of [undefined, null, "", "SIGNED"]) {
    const step = ER.captureReportWaitStep(v);
    assert.equal(step.keepWaiting, false, String(v));
    assert.equal(step.message, "The report status is unavailable right now.");
  }
  assert.equal(ER.REPORT_STATUS_UNREADABLE_MESSAGE, "The report status could not be checked just now. Open the record to see it.");
});

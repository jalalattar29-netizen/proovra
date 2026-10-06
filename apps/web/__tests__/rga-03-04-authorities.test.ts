/**
 * RGA-03 (shared reason authority) and RGA-04 (shared download-failure authority)
 * — behavioural tests of the ONE shared implementation every surface consumes.
 */
import { test } from "node:test";
import assert from "node:assert";

import {
  NEW_VERSION_REASON_MIN,
  NEW_VERSION_REASON_MAX,
  normalizeNewVersionReason,
  validateNewVersionReason,
  newVersionReasonError,
  resolveArtifactDownloadFailure,
} from "@proovra/shared";

import { describeArtifactDownloadFailure } from "../lib/evidence/report-download-feedback";

// ---------------------------------------------------------------------------
// RGA-03 — reason authority
// ---------------------------------------------------------------------------

test("RGA-03: bounds are the shared canonical min/max", () => {
  assert.equal(NEW_VERSION_REASON_MIN, 3);
  assert.equal(NEW_VERSION_REASON_MAX, 120);
});

test("RGA-03: normalize strips control/invisible/angle chars, collapses whitespace, trims", () => {
  const raw = "  a\u0000b​ c\t\td<e>f  ‮g  ";
  const out = normalizeNewVersionReason(raw);
  const forbidden = ["\u0000", "​", "‮", "<", ">"];
  for (const ch of forbidden) {
    assert.ok(!out.includes(ch), "control/invisible/angle removed");
  }
  assert.ok(!/\s{2,}/.test(out), "whitespace collapsed");
  assert.equal(out, out.trim(), "trimmed");
});

test("RGA-03: validate rejects empty, whitespace-only, too-short; accepts valid", () => {
  assert.deepEqual(validateNewVersionReason("   "), { ok: false, value: "", reason: "EMPTY" });
  const short = validateNewVersionReason("ab");
  assert.equal(short.ok, false);
  assert.equal(short.ok === false ? short.reason : null, "TOO_SHORT");
  const ok = validateNewVersionReason("TSA validated after v1");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok ? ok.value : null, "TSA validated after v1");
});

test("RGA-03: validate flags TOO_LONG before silent truncation", () => {
  const long = "x".repeat(NEW_VERSION_REASON_MAX + 25);
  const v = validateNewVersionReason(long);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "TOO_LONG");
  // normalize still bounds the stored value.
  assert.equal(normalizeNewVersionReason(long).length, NEW_VERSION_REASON_MAX);
});

test("RGA-03: control-char-only input is EMPTY, not accepted", () => {
  const v = validateNewVersionReason("\u0000\u0000​");
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "EMPTY");
});

test("RGA-03: every typed failure has a distinct, non-empty inline message", () => {
  const msgs = ["EMPTY", "TOO_SHORT", "TOO_LONG"].map((r) =>
    newVersionReasonError(r as "EMPTY" | "TOO_SHORT" | "TOO_LONG"),
  );
  for (const m of msgs) assert.ok(m.length > 0);
  assert.equal(new Set(msgs).size, msgs.length, "messages are distinct");
});

// ---------------------------------------------------------------------------
// RGA-04 — download-failure authority
// ---------------------------------------------------------------------------

test("RGA-04: report and package names appear in the right messages", () => {
  const r = resolveArtifactDownloadFailure("report", { statusCode: 404 });
  const p = resolveArtifactDownloadFailure("verificationPackage", { statusCode: 404 });
  assert.ok(/report/i.test(r!.message));
  assert.ok(/verification package/i.test(p!.message));
});

test("RGA-04: a missing stored object of an issued (immutable) version is a support matter, never a regeneration", () => {
  const r = resolveArtifactDownloadFailure("report", { statusCode: 410, code: "report_artifact_missing" });
  assert.equal(r!.action, "NONE");
  assert.equal(r!.retryable, false);
  assert.equal(r!.report, false);
  assert.match(r!.message, /Contact support; nothing has been changed./);
  const p = resolveArtifactDownloadFailure("verificationPackage", {
    statusCode: 410,
    code: "verification_package_artifact_missing",
  });
  assert.equal(p!.action, "NONE");
});

test("RGA-04: the package endpoint's own codes and a missing VERSION resolve through the one authority", () => {
  assert.equal(resolveArtifactDownloadFailure("verificationPackage", { code: "verification_package_pending", statusCode: 202 })!.action, "REFRESH");
  assert.equal(resolveArtifactDownloadFailure("verificationPackage", { code: "verification_package_generation_failed", statusCode: 409 })!.action, "RECOVER");
  assert.match(resolveArtifactDownloadFailure("verificationPackage", { code: "verification_package_not_included", statusCode: 409 })!.message, /not included/);
  const v = resolveArtifactDownloadFailure("report", { statusCode: 404 }, { version: 3 });
  assert.equal(v!.message, "Report v3 is not available for this record.");
});

test("RGA-04: governance/503 is retryable with RETRY; access/hold is NONE", () => {
  const gov = resolveArtifactDownloadFailure("report", { statusCode: 503, code: "GOVERNANCE_CHECK_FAILED" });
  assert.equal(gov!.action, "RETRY");
  assert.equal(gov!.retryable, true);
  const hold = resolveArtifactDownloadFailure("report", { statusCode: 403, code: "BLOCKED_BY_HOLD" });
  assert.equal(hold!.action, "NONE");
  assert.equal(hold!.retryable, false);
});

test("RGA-04: an unknown status returns null so the caller's safe reporter files it", () => {
  assert.equal(resolveArtifactDownloadFailure("report", { statusCode: 500, code: "INTERNAL" }), null);
});

test("RGA-04: no outcome leaks storage keys, stack traces or raw codes", () => {
  const samples = [
    { statusCode: 403, code: "ACCESS_DENIED" },
    { statusCode: 410, code: "report_artifact_missing" },
    { statusCode: 503, code: "GOVERNANCE_CHECK_FAILED" },
    { statusCode: 404 },
    { statusCode: 409 },
  ];
  for (const s of samples) {
    const out = resolveArtifactDownloadFailure("verificationPackage", s)!;
    assert.ok(!/s3:\/\/|storage_key|\/var\/|at Object\.|P20\d\d/i.test(out.message), `safe: ${out.message}`);
  }
});

test("RGA-04: the web wrapper delegates known cases and reports unknowns", () => {
  const known = describeArtifactDownloadFailure("report", { statusCode: 404 });
  assert.ok(/no report/i.test(known.message));
  assert.equal(known.report, false);
  const unknown = describeArtifactDownloadFailure("report", { statusCode: 500, code: "INTERNAL", message: "prisma raw" });
  assert.ok(!/prisma raw/i.test(unknown.message), "raw text never surfaces");
  assert.equal(unknown.tone, "error");
  assert.equal(unknown.report, true);
});

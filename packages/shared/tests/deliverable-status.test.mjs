/**
 * THE RECORD'S DELIVERABLE STATUS (2026-10-16) — one mutually exclusive
 * category per record, from the canonical per-output states, and the words
 * for every bounded value in en/de/ar.
 *
 *   * a failure superseded by a newer report is HISTORY, never a current one;
 *   * unknown / not included / not applicable is never a failure;
 *   * in-flight work outranks a failure it is retrying;
 *   * every status and reason has non-empty copy in en, de and ar, and a
 *     translation keeps every {placeholder} of its English source.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERABLE_STATUSES,
  DELIVERABLE_STATUS_REASONS,
  EVIDENCE_OUTPUT_STATES,
  deliverableStatusFor,
  isCurrentReportUpdateFailure,
} from "../dist/index.js";
import { reportsCopyFor, reportsDict } from "../dist/i18n.js";

const s = (report, verificationPackage, reportUpdateFailed = false) =>
  deliverableStatusFor({ report, verificationPackage, reportUpdateFailed });

test("a complete pair is READY; a report with its package not in the plan is READY too", () => {
  assert.deepEqual(s("READY", "READY"), { status: "READY", reason: "COMPLETE" });
  assert.deepEqual(s("READY", "NOT_INCLUDED"), { status: "READY", reason: "COMPLETE" });
});

test("a superseded failure is not a current failure; a failure after the latest report is", () => {
  assert.deepEqual(s("READY", "READY", false), { status: "READY", reason: "COMPLETE" });
  assert.deepEqual(s("READY", "READY", true), { status: "NEEDS_ATTENTION", reason: "REPORT_UPDATE_FAILED" });

  const at = (iso) => new Date(iso);
  // Failed at 10:00, the report it failed to replace was generated at 11:00 —
  // a newer artifact superseded the failure.
  assert.equal(
    isCurrentReportUpdateFailure({
      reportState: "READY",
      reportRequestState: "FAILED_TERMINAL",
      requestCreatedAt: at("2026-10-13T10:00:00Z"),
      latestReportGeneratedAt: at("2026-10-13T11:00:00Z"),
    }),
    false,
  );
  // Requested after the latest report and failed: current.
  assert.equal(
    isCurrentReportUpdateFailure({
      reportState: "READY",
      reportRequestState: "FAILED_RETRYABLE",
      requestCreatedAt: at("2026-10-13T12:00:00Z"),
      latestReportGeneratedAt: at("2026-10-13T11:00:00Z"),
    }),
    true,
  );
  // Not READY: the report axis states its own failure; this helper is silent.
  assert.equal(
    isCurrentReportUpdateFailure({
      reportState: "TERMINAL_FAILURE",
      reportRequestState: "FAILED_TERMINAL",
      requestCreatedAt: at("2026-10-13T12:00:00Z"),
      latestReportGeneratedAt: null,
    }),
    false,
  );
  // A succeeded request is not a failure at all.
  assert.equal(
    isCurrentReportUpdateFailure({
      reportState: "READY",
      reportRequestState: "SUCCEEDED",
      requestCreatedAt: at("2026-10-13T12:00:00Z"),
      latestReportGeneratedAt: at("2026-10-13T11:00:00Z"),
    }),
    false,
  );
});

test("work in flight outranks the failure it is retrying", () => {
  assert.equal(s("GENERATING", "TERMINAL_FAILURE").status, "IN_PROGRESS");
  assert.equal(s("READY", "QUEUED").status, "IN_PROGRESS");
});

test("genuine failures, blocks and missing files need attention; owed outputs are incomplete", () => {
  assert.deepEqual(s("RETRYABLE_FAILURE", "RETRYABLE_FAILURE"), { status: "NEEDS_ATTENTION", reason: "REPORT_FAILED" });
  assert.deepEqual(s("READY", "TERMINAL_FAILURE"), { status: "NEEDS_ATTENTION", reason: "PACKAGE_FAILED" });
  assert.deepEqual(s("BLOCKED", "BLOCKED"), { status: "NEEDS_ATTENTION", reason: "REPORT_BLOCKED" });
  assert.deepEqual(s("READY", "BLOCKED"), { status: "NEEDS_ATTENTION", reason: "PACKAGE_BLOCKED" });
  assert.deepEqual(s("ARTIFACT_MISSING", "READY"), { status: "NEEDS_ATTENTION", reason: "ARTIFACT_MISSING" });
  assert.deepEqual(s("ELIGIBLE_NOT_GENERATED", "ELIGIBLE_NOT_GENERATED"), {
    status: "INCOMPLETE",
    reason: "REPORT_AWAITING_ISSUANCE",
  });
  assert.deepEqual(s("READY", "ELIGIBLE_NOT_GENERATED"), { status: "INCOMPLETE", reason: "PACKAGE_MISSING" });
});

test("not included, entitlement unknown and not applicable are NEVER failures", () => {
  assert.deepEqual(s("NOT_INCLUDED", "NOT_INCLUDED"), { status: "NOT_AVAILABLE", reason: "NOT_INCLUDED" });
  assert.deepEqual(s("ENTITLEMENT_UNAVAILABLE", "ENTITLEMENT_UNAVAILABLE"), {
    status: "NOT_AVAILABLE",
    reason: "ENTITLEMENT_UNAVAILABLE",
  });
  assert.deepEqual(s("NOT_APPLICABLE", "NOT_APPLICABLE"), { status: "NOT_AVAILABLE", reason: "NOT_APPLICABLE" });
});

test("total and exclusive: every pair of canonical states lands in exactly one bounded status and reason", () => {
  for (const r of EVIDENCE_OUTPUT_STATES) {
    for (const p of EVIDENCE_OUTPUT_STATES) {
      for (const u of [false, true]) {
        const out = s(r, p, u);
        assert.ok(DELIVERABLE_STATUSES.includes(out.status), `${r}/${p}: ${out.status}`);
        assert.ok(DELIVERABLE_STATUS_REASONS.includes(out.reason), `${r}/${p}: ${out.reason}`);
        if (out.status === "NEEDS_ATTENTION") {
          // Only a genuine failure, block or missing file gets here.
          assert.ok(
            [r, p].some((x) => ["RETRYABLE_FAILURE", "TERMINAL_FAILURE", "BLOCKED", "ARTIFACT_MISSING"].includes(x)) ||
              (r === "READY" && u),
            `${r}/${p}/${u} needs attention without a failure`,
          );
        }
      }
    }
  }
});

// ---------------------------------------------------------------- the copy
const leaves = (node, path = "") =>
  node && typeof node === "object"
    ? Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k))
    : [{ path, value: node }];
const at = (root, path) => path.split(".").reduce((n, k) => (n && typeof n === "object" ? n[k] : undefined), root);
const placeholders = (str) => new Set(Array.from(str.matchAll(/\{(\w+)\}/g), (m) => m[1]));

test("every Reports string is present and non-empty in en, de and ar, keeping its placeholders", () => {
  const en = leaves(reportsDict.en);
  assert.ok(en.length > 120, `expected the full vocabulary, found ${en.length}`);
  for (const locale of ["de", "ar"]) {
    for (const { path, value } of en) {
      const v = at(reportsDict[locale], path);
      assert.equal(typeof v, "string", `${locale}.${path} missing`);
      assert.ok(v.trim().length > 0, `${locale}.${path} empty`);
      for (const p of placeholders(value)) assert.ok(v.includes(`{${p}}`), `${locale}.${path} drops {${p}}`);
    }
  }
});

test("every bounded status and reason has words, and no word is a raw code", () => {
  for (const locale of ["en", "de", "ar"]) {
    const c = reportsCopyFor(locale);
    for (const st of DELIVERABLE_STATUSES) {
      assert.ok(c.statuses[st], `${locale} status ${st}`);
      assert.doesNotMatch(c.statuses[st], /[A-Z]{3,}_[A-Z]/);
    }
    for (const r of DELIVERABLE_STATUS_REASONS) {
      assert.ok(c.reasons[r], `${locale} reason ${r}`);
      assert.doesNotMatch(c.reasons[r], /[A-Z]{3,}_[A-Z]|_/);
    }
  }
  assert.equal(reportsCopyFor("fr"), reportsDict.en);
});

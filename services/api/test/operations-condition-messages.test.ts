/**
 * OPERATIONS CONDITION MESSAGES — the one catalogue every writer stamps and
 * every client resolves (packages/shared/src/operations-condition-messages.ts).
 *
 * Proves, per code and per locale:
 *   - en/de/ar all render, non-empty, with no placeholder or raw key left;
 *   - de and ar are actually translated (never the English sentence);
 *   - Arabic wraps every technical value in Unicode isolates (RTL safety);
 *   - params are validated and interpolated as TEXT: markup and braces stay
 *     literal, controls and bidi overrides are stripped, a malformed or
 *     undeclared param refuses the code;
 *   - unknown codes, bad params and legacy rows render the STORED text —
 *     never a raw key, never an empty string; English always renders stored;
 *   - the reviewed English names no internal code, enum, field or error class;
 *   - every registered source has a label in every locale, and the English
 *     label is the registry's own.
 */
import { describe, expect, it } from "vitest";

import {
  CONDITION_MESSAGE_CODES,
  CONDITION_SOURCE_LABEL_IDS,
  conditionSourceLabel,
  localizeCondition,
  renderConditionMessage,
  sanitizeConditionText,
  stampConditionMessage,
  validateConditionParams,
  type ConditionMessageCode,
} from "@proovra/shared";
import {
  OPERATIONS_SOURCE_LIFECYCLES,
  UNREGISTERED_CONDITION_LIFECYCLE,
} from "@proovra/shared-runtime";

/** One valid param set per code — every declared param, every kind. */
const SAMPLE: Record<ConditionMessageCode, Record<string, unknown>> = {
  "ops.identity.runtime_block": { action: "EVIDENCE_DELETE", riskScore: 87 },
  "ops.identity.high_risk_session_surge": { count: 14 },
  "ops.identity.idp_outage": { provider: "OIDC", failures: 5 },
  "ops.security.signal": { eventType: "webhook_signature_invalid", severity: "HIGH", teamRef: "1a2b3c4d", fields: "destinationId, reason" },
  "ops.integration.webhook_destination_disabled": { failures: 10 },
  "ops.billing.provider_authorization": { provider: "STRIPE", operation: "PAYMENT_LOOKUP" },
  "ops.billing.dependent_cancellation.ungrantable_manual": { payer: "personal" },
  "ops.billing.dependent_cancellation.ungrantable_stopping": { payer: "workspace" },
  "ops.billing.dependent_cancellation.pending": { payer: "workspace" },
  "ops.billing.dependent_cancellation.retry_provider_unreachable": { payer: "personal" },
  "ops.billing.dependent_cancellation.retry": { payer: "workspace" },
  "ops.billing.dependent_cancellation.manual": { payer: "personal" },
  "ops.billing.dependent_cancellation.unconfirmed": { payer: "workspace" },
  "ops.pipeline.report_backlog": { high: 25, critical: 100 },
  "ops.pipeline.package_backlog": { high: 25, critical: 100 },
  "ops.review.stale_workflows": { hours: 72 },
  "ops.coordination.backlog_stale": { days: 7 },
  "ops.review.escalation": { reason: "REVIEW_OVERDUE", note: "Customer called twice about this." },
  "ops.review.escalation.overdue_auto": { reason: "REVIEW_OVERDUE" },
  "ops.review.escalation.stuck_auto": { reason: "WORKFLOW_STALLED", stuck: "assigned_never_opened" },
  "ops.review.escalation_storm": { count: 12 },
  "ops.governance.destruction_executed": { reviewId: "5e0c1b2a-0000-4000-8000-000000000001", evidenceId: "9f1d2c3b-0000-4000-8000-000000000002" },
  "ops.governance.notification.destruction_executed": { evidenceRef: "9f1d2c3b", certificateRef: "ab12cd34ef56ab78" },
  "ops.governance.notification.destruction_blocked": { cause: "hold" },
  "ops.governance.notification.immutable_drift": { evidenceRef: "9f1d2c3b", outcome: "MISSING_LOCK" },
  "ops.governance.notification.destruction_pending": { evidenceRef: "9f1d2c3b", reviewRef: "5e0c1b2a" },
  "ops.governance.notification.retention_blocked": { cause: "case_hold" },
  "ops.governance.notification.retention_extended": { days: 30 },
  "ops.governance.notification.lifecycle_drift": {},
  "ops.storage.immutable_drift": { outcome: "MISSING_LOCK", evidenceRef: "9f1d2c3b", detail: "db_has_retention_storage_has_no_lock" },
  "ops.evidence_integrity.tsa_failed": { recordTitle: "Roof damage, north side", recordRef: "9f1d2c3b", failureClass: "RETRYABLE_PROVIDER" },
  "ops.evidence_integrity.ots_failed": { recordTitle: null, recordRef: "9f1d2c3b", failureClass: "QUOTA" },
  "ops.evidence_integrity.ots_pending_aged": { recordRef: "9f1d2c3b", warningHours: 24, highHours: 72 },
  "ops.evidence_integrity.ots_initialization_stalled": { recordTitle: "Contract scan", recordRef: "9f1d2c3b" },
  "ops.evidence_integrity.ots_budget_exhausted": { recordRef: "9f1d2c3b" },
  "ops.pipeline.report_generation_failed.retries_exhausted": { version: 2, recordRef: "9f1d2c3b", errorClass: "REPORT_RENDER_TIMEOUT" },
  "ops.pipeline.report_generation_failed.not_retriable": { version: 1, recordRef: "9f1d2c3b", errorClass: "UNCLASSIFIED" },
  "ops.pipeline.report_generation_failed.retry_budget_exhausted": { version: 3, recordRef: "9f1d2c3b" },
  "ops.pipeline.report_generation_failed.sanitized": {},
  "ops.pipeline.package_generation_failed.sanitized": {},
  "ops.pipeline.package_generation_failed.storage_rejected": { version: 2, recordRef: "9f1d2c3b" },
  "ops.pipeline.package_generation_failed.failed": { version: 2, recordRef: "9f1d2c3b" },
  "ops.pipeline.package_generation_failed.retry_budget_exhausted": { version: 2, recordRef: "9f1d2c3b" },
  "ops.pipeline.package_generation_denied": { outcome: "BLOCKED_BY_HOLD" },
  "ops.platform.worker_heartbeat_stale": {},
  "ops.job.background_failure": { queue: "Report generation" },
  "ops.search.not_built": {},
  "ops.search.reconciliation_failing": {},
  "ops.platform.operational_seed": { seedRunId: "5e0c1b2a-0000-4000-8000-000000000003", scenario: "escalation_storm" },
  "ops.capture.upload_stalled": { recordTitle: "Site survey.mp4", recordRef: "9f1d2c3b", minutes: 90 },
};

const FSI = "\u2068";
const PDI = "\u2069";
const LOCALES = ["en", "de", "ar"] as const;

describe("every code renders in every locale", () => {
  it("the sample table covers exactly the catalogue", () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...CONDITION_MESSAGE_CODES].sort());
  });

  for (const code of CONDITION_MESSAGE_CODES) {
    it(code, () => {
      const en = renderConditionMessage("en", code, SAMPLE[code])!;
      expect(en, `${code} rejected its own sample`).not.toBeNull();
      for (const loc of LOCALES) {
        const r = renderConditionMessage(loc, code, SAMPLE[code])!;
        for (const text of [r.title, r.summary]) {
          expect(text.trim().length, `${code}/${loc}`).toBeGreaterThan(0);
          // No placeholder left behind, no raw key, no stringified nothing.
          // (`=null` is a technical predicate some summaries quote verbatim.)
          expect(text, `${code}/${loc}`).not.toMatch(/\{\w+\}|undefined|(?<!=)\bnull\b|\[object /);
          expect(text, `${code}/${loc}`).not.toContain(code);
        }
        if (loc !== "en") {
          expect(r.title, `${code}/${loc} title is untranslated`).not.toBe(en.title);
        }
      }
    });
  }

  it("German and Arabic summaries are translated wherever the English is prose", () => {
    for (const code of CONDITION_MESSAGE_CODES) {
      const en = renderConditionMessage("en", code, SAMPLE[code])!;
      // `ops.review.escalation` shows a PERSON's note as written: user text is
      // never machine-translated, so its summary is the same in every locale.
      if (code === "ops.review.escalation") continue;
      for (const loc of ["de", "ar"] as const) {
        expect(renderConditionMessage(loc, code, SAMPLE[code])!.summary, `${code}/${loc}`).not.toBe(en.summary);
      }
    }
  });

  it("Arabic isolates every technical value it interpolates (RTL safety)", () => {
    const r = renderConditionMessage("ar", "ops.pipeline.report_generation_failed.not_retriable", {
      version: 4,
      recordRef: "9f1d2c3b",
      errorClass: "REPORT_RENDER_TIMEOUT",
    })!;
    expect(r.title).toContain(`${FSI}v4${PDI}`);
    expect(r.title).toContain(`${FSI}9f1d2c3b${PDI}`);
    // The error class is a technical reference, never part of the sentence.
    expect(r.summary).not.toContain("REPORT_RENDER_TIMEOUT");
    expect(r.summary).toContain(`${FSI}4${PDI}`);
    // Every isolate is closed.
    for (const code of CONDITION_MESSAGE_CODES) {
      const ar = renderConditionMessage("ar", code, SAMPLE[code])!;
      for (const text of [ar.title, ar.summary]) {
        expect(text.split(FSI).length, `${code}`).toBe(text.split(PDI).length);
      }
      // The Arabic sentence is Arabic: it contains Arabic script.
      expect(ar.title + ar.summary, code).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("interpolation is text, validated and bounded", () => {
  it("braces and markup in a text param are inserted literally, never expanded or rendered", () => {
    const r = renderConditionMessage("de", "ops.evidence_integrity.ots_initialization_stalled", {
      recordTitle: "{recordRef} <img src=x onerror=alert(1)>",
      recordRef: "9f1d2c3b",
    })!;
    expect(r.title).toContain("{recordRef} <img src=x onerror=alert(1)>");
    // The real ref was NOT substituted into the user's braces.
    expect(r.title).not.toContain("9f1d2c3b <img");
  });

  it("controls and bidi overrides are stripped from text params; length is bounded", () => {
    expect(sanitizeConditionText("a\u202Eevil\u2066b\u0000c\nd")).toBe("a evil b c d");
    expect(sanitizeConditionText("x".repeat(1000))).toHaveLength(400);
    const ar = renderConditionMessage("ar", "ops.evidence_integrity.ots_initialization_stalled", {
      recordTitle: "\u202Eabc\u2069",
      recordRef: "9f1d2c3b",
    })!;
    expect(ar.title).not.toContain("\u202E");
    expect(ar.title.split(FSI).length).toBe(ar.title.split(PDI).length);
  });

  it("a malformed, missing or undeclared param refuses the code", () => {
    expect(validateConditionParams("ops.identity.idp_outage", { provider: "OIDC" })).toBeNull();
    expect(validateConditionParams("ops.identity.idp_outage", { provider: "OIDC", failures: 2.5 })).toBeNull();
    expect(validateConditionParams("ops.identity.idp_outage", { provider: "has spaces", failures: 2 })).toBeNull();
    expect(validateConditionParams("ops.identity.idp_outage", { provider: "OIDC", failures: 2, extra: 1 })).toBeNull();
    expect(validateConditionParams("ops.pipeline.package_generation_denied", { outcome: "NOT_AN_OUTCOME" })).toBeNull();
    expect(validateConditionParams("ops.review.escalation", { reason: "X1", note: "   " })).toBeNull();
    expect(validateConditionParams("ops.identity.idp_outage", { provider: "OIDC", failures: 2 })).toEqual({ provider: "OIDC", failures: 2 });
  });

  it("a writer's invalid message is not stamped", () => {
    expect(stampConditionMessage({ code: "ops.identity.idp_outage", params: { provider: "OIDC" } })).toBeNull();
    expect(stampConditionMessage({ code: "ops.no_such_code", params: {} })).toBeNull();
  });
});

describe("the reader falls back to the stored text — never a raw key", () => {
  const stored = { title: "Stored English title", safeSummary: "Stored English summary." };

  it("a legacy row (no code) renders its stored text in every locale", () => {
    for (const loc of LOCALES) {
      const r = localizeCondition(loc, { ...stored, message: null });
      expect(r).toEqual({ title: stored.title, summary: stored.safeSummary, localized: false });
    }
    // An older server that sends no `message` field at all.
    expect(localizeCondition("de", stored).title).toBe(stored.title);
  });

  it("an unknown code renders the stored text", () => {
    const r = localizeCondition("ar", { ...stored, message: { code: "ops.future.code", params: {} } });
    expect(r).toEqual({ title: stored.title, summary: stored.safeSummary, localized: false });
  });

  it("missing or malformed params render the stored text", () => {
    const r = localizeCondition("de", {
      ...stored,
      message: { code: "ops.identity.idp_outage", params: { provider: "OIDC" } },
    });
    expect(r.title).toBe(stored.title);
    expect(r.localized).toBe(false);
  });

  it("English renders the CURRENT reviewed sentence when the code is valid, not the stored text", () => {
    const r = localizeCondition("en", {
      ...stored,
      message: { code: "ops.platform.worker_heartbeat_stale", params: {} },
    });
    expect(r.title).toBe("Worker heartbeat stale");
    expect(r.localized).toBe(true);
  });

  it("an unsupported locale falls back to the English catalogue sentence", () => {
    const r = localizeCondition("fr", { ...stored, message: { code: "ops.platform.worker_heartbeat_stale", params: {} } });
    expect(r.title).toBe("Worker heartbeat stale");
  });

  it("a known code renders the locale's sentence", () => {
    const de = localizeCondition("de", {
      ...stored,
      message: { code: "ops.integration.webhook_destination_disabled", params: { failures: 10 } },
    });
    expect(de.localized).toBe(true);
    expect(de.title).toBe("Webhook-Ziel nach wiederholten Fehlern deaktiviert");
    expect(de.summary).toContain("10");
  });

  it("a SOURCE_LABEL title resolves the source's label; an unknown source keeps the stored title", () => {
    const de = localizeCondition("de", {
      title: "Report generation backlog",
      safeSummary: "x",
      sourceId: "pipeline.report_backlog",
      titleSource: "SOURCE_LABEL",
      message: null,
    });
    expect(de.title).toBe("Rückstau bei der Berichtserstellung");
    const unknown = localizeCondition("de", {
      title: "Stored",
      safeSummary: "x",
      sourceId: "nope.unknown",
      titleSource: "SOURCE_LABEL",
      message: null,
    });
    expect(unknown.title).toBe("Stored");
  });
});

describe("the reviewed English names no internal code (2026-10-14)", () => {
  // The writers' sentences as they now read. Codes, enums, field names and
  // error classes are technical references, never part of a sentence.
  it.each([
    [
      "ops.integration.webhook_destination_disabled",
      { failures: 7 },
      "Webhook destination disabled after repeated failures",
      "Automation stopped delivering to this webhook destination after 7 consecutive failed deliveries. Fix the receiving endpoint, then re-enable the destination in Automation.",
    ],
    [
      "ops.pipeline.report_generation_failed.not_retriable",
      { version: 3, recordRef: "9f1d2c3b", errorClass: "UNCLASSIFIED" },
      "Report v3 generation failed — record 9f1d2c3b",
      "Report version 3 of this record could not be generated and will not be retried automatically. The evidence is unaffected. An operator can recover it from Operations; the condition clears only when report version 3 exists.",
    ],
    [
      "ops.evidence_integrity.tsa_failed",
      { recordTitle: "Roof", recordRef: "9f1d2c3b", failureClass: "CONFIGURATION" },
      'Trusted timestamp missing for "Roof"',
      "This record has no trusted timestamp: the provider rejected our credentials or configuration. It stays open until the record's timestamp is validated. Each affected record is tracked separately — this condition covers one record only.",
    ],
    [
      "ops.billing.provider_authorization",
      { provider: "PAYPAL", operation: "CAPTURE" },
      "PayPal refused our credentials",
      "PayPal rejected the platform's credentials during a payment check. Payment states cannot be verified until the credentials are restored. No customer payment has been changed.",
    ],
    [
      "ops.security.signal",
      { eventType: "upload_stalled", severity: "WARNING", teamRef: "6488cb98", fields: "stalledThresholdMinutes, previousStatus" },
      "Upload appears stalled",
      "An upload in this workspace stopped making progress. This older condition does not record which upload it was; newer conditions name the affected record.",
    ],
    [
      "ops.capture.upload_stalled",
      { recordTitle: "Site survey.mp4", recordRef: "9f1d2c3b", minutes: 60 },
      "Upload appears stalled",
      'No upload progress has been recorded for 1 hour on "Site survey.mp4". The person uploading can resume it from the record; if it is not resumed it is closed as abandoned. This condition closes on its own when the upload completes or is closed.',
    ],
  ] as const)("%s", (code, params, title, summary) => {
    const stamped = stampConditionMessage({ code, params })!;
    expect(stamped.title).toBe(title);
    expect(stamped.summary).toBe(summary);
  });
});

describe("source labels", () => {
  const registered = [...OPERATIONS_SOURCE_LIFECYCLES, UNREGISTERED_CONDITION_LIFECYCLE];

  it("every registered source has a label in every locale, and only those", () => {
    expect([...CONDITION_SOURCE_LABEL_IDS].sort()).toEqual(registered.map((l) => l.sourceId).sort());
    for (const l of registered) {
      for (const loc of LOCALES) {
        expect(conditionSourceLabel(loc, l.sourceId), `${l.sourceId}/${loc}`).toBeTruthy();
      }
    }
  });

  it("the English label IS the registry's display label", () => {
    for (const l of registered) {
      expect(conditionSourceLabel("en", l.sourceId), l.sourceId).toBe(l.displayLabel);
    }
  });

  it("German and Arabic labels are translated", () => {
    for (const l of registered) {
      expect(conditionSourceLabel("de", l.sourceId), l.sourceId).not.toBe(l.displayLabel);
      expect(conditionSourceLabel("ar", l.sourceId), l.sourceId).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("no internal language in any rendered sentence (2026-10-14)", () => {
  // A reader sees sentences. Signal codes, enum constants, field lists, team
  // ids and diagnostics belong under Technical references, never here.
  const INTERNAL: Array<[string, RegExp]> = [
    ["snake_case identifier", /\b[a-z]+(?:_[a-z0-9]+)+\b/],
    ["enum constant", /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/],
    ["field list", /\bfields:/i],
    ["raw security-signal label", /Security signal:/i],
    ["team id", /\bteam [0-9a-f]{6,}/i],
    ["UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ["key=value diagnostic", /\b[a-z][a-zA-Z]*=[A-Za-z0-9]/],
  ];
  it.each([...CONDITION_MESSAGE_CODES])("%s", (code) => {
    for (const loc of LOCALES) {
      const r = renderConditionMessage(loc, code, SAMPLE[code])!;
      const text = `${r.title} ${r.summary}`.replaceAll(FSI, "").replaceAll(PDI, "");
      const found = INTERNAL.filter(([, re]) => re.test(text)).map(([n]) => n);
      expect(found, `${code}/${loc}: ${text}`).toEqual([]);
    }
  });
});

/**
 * Legal hold and retention, as one record's page states them (2026-10-23).
 *
 * The Integrity tab's "Legal hold" row read the S3 object's native legal-hold
 * HEADER captured at sealing — a header the platform stopped writing on
 * 2026-08-24 — so a record under an ACTIVE PROOVRA legal hold read "No legal
 * hold metadata recorded · Unavailable". Its "Retention until" row read only
 * the workspace-policy deadline, so a record kept by its 2920-day COMPLIANCE
 * Object Lock read "No record-level retention deadline recorded · Unavailable"
 * as if nothing protected it.
 *
 * These rows now read the canonical lifecycle projection
 * (`toEvidenceLifecycleProjection`, with the union legal-hold evaluator), and
 * keep apart the facts that are different:
 *
 *   - legal hold: a compliance action on the record, its case or its
 *     workspace — ACTIVE, NONE, or a check that could not complete;
 *   - retention: the later of the workspace-policy deadline and the storage
 *     Object Lock, each named by its source; neither is ever inferred from
 *     upload or report dates or from a plan;
 *   - storage immutability is NOT a legal hold, and no hold is NOT "no
 *     protection".
 */

import type { EvidenceLifecycleProjection } from "./evidence-retention-lifecycle.js";

/** The row states the Integrity card renders (its own vocabulary). */
export type ProtectionRowState = "recorded" | "not-applicable" | "unavailable";

export type ProtectionRow = { value: string; state: ProtectionRowState };

export type EvidenceProtectionRows = {
  legalHold: ProtectionRow;
  retention: ProtectionRow;
};

export function presentEvidenceProtection(
  lifecycle: Pick<
    EvidenceLifecycleProjection,
    | "productState"
    | "legalHold"
    | "legalHoldState"
    | "appRetentionUntilUtc"
    | "objectLockRetainUntilUtc"
    | "effectiveRetentionUntilUtc"
  > | null | undefined,
  formatDate: (iso: string) => string,
  now: Date = new Date(),
): EvidenceProtectionRows {
  if (!lifecycle) {
    // The projection was not part of the response this viewer received.
    const missing: ProtectionRow = {
      value: "Not available in this view. Reload the page to try again.",
      state: "unavailable",
    };
    return { legalHold: missing, retention: missing };
  }

  // A row from a list projection carries only the fail-closed boolean.
  const holdState =
    lifecycle.legalHoldState ?? (lifecycle.legalHold ? "ACTIVE" : "NONE");
  const legalHold: ProtectionRow =
    holdState === "ACTIVE"
      ? { value: "Active legal hold. Deletion and destruction are blocked while it applies.", state: "recorded" }
      : holdState === "NONE"
        ? {
            value: "No active legal hold. A legal hold is a separate compliance action from storage protection.",
            state: "not-applicable",
          }
        : {
            value: "The legal-hold check could not be completed. Deletion stays blocked; reload to check again.",
            state: "unavailable",
          };

  if (lifecycle.productState === "DESTROYED") {
    return {
      legalHold,
      retention: { value: "The stored bytes were destroyed; no retention applies any more.", state: "not-applicable" },
    };
  }

  const app = lifecycle.appRetentionUntilUtc;
  const lock = lifecycle.objectLockRetainUntilUtc;
  const effective = lifecycle.effectiveRetentionUntilUtc ?? app ?? lock;
  let retention: ProtectionRow;
  if (!effective) {
    retention = {
      value: "No retention deadline is recorded for this record.",
      state: "not-applicable",
    };
  } else {
    const ended = Date.parse(effective) <= now.getTime();
    const sources = [
      app ? `workspace policy until ${formatDate(app)}` : null,
      lock ? `storage lock until ${formatDate(lock)}` : null,
    ].filter(Boolean);
    retention = {
      value: `${ended ? "Retention ended" : "Retained until"} ${formatDate(effective)}${
        sources.length > 0 ? ` (${sources.join("; ")})` : ""
      }`,
      state: "recorded",
    };
  }
  return { legalHold, retention };
}

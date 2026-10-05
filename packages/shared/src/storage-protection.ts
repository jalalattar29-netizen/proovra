/**
 * STORAGE PROTECTION — ONE CLASSIFICATION FOR EVERY SURFACE.
 *
 * The record's Object Lock state reaches the product two ways: RECORDED on the
 * row at sealing (from a HEAD of the exact object version), or OBSERVED by a
 * live HEAD when nothing was recorded. ET-PKG-06 narrowed the summary's
 * `verified` flag to mean "observed on the object just now" — correct as a
 * statement about provenance — but the review alert, the Integrity tab and the
 * library's "protected" filter kept reading `verified` as "protected". So a
 * record sealed under COMPLIANCE retention that is still in force was told
 * "Storage object lock or legal hold settings are not fully configured", while
 * the workspace counter (any lock column non-null) counted expired retention and
 * an OFF legal hold as protected. Three answers to one question.
 *
 * This is the question, answered once:
 *   PROTECTED          — COMPLIANCE/GOVERNANCE retention whose retain-until is
 *                        still in the future, or a legal hold that is ON.
 *   RETENTION_EXPIRED  — retention was applied and its retain-until has passed.
 *   NOT_APPLIED        — the object's lock metadata was read and carries no
 *                        retention and no legal hold.
 *   UNCONFIRMED        — nothing could be read: no stored object is recorded,
 *                        or reading its metadata failed.
 * Provenance (RECORDED vs OBSERVED) is reported beside it, never instead of it.
 */

export const STORAGE_PROTECTION_CLASSES = [
  "PROTECTED",
  "RETENTION_EXPIRED",
  "NOT_APPLIED",
  "UNCONFIRMED",
] as const;
export type StorageProtectionClass = (typeof STORAGE_PROTECTION_CLASSES)[number];

export type StorageProtectionFacts = {
  mode?: string | null;
  retainUntil?: string | Date | null;
  legalHold?: string | null;
  /** The live metadata read failed (or there was no object to read). */
  readFailed?: boolean;
};

const RETENTION_MODES = new Set(["COMPLIANCE", "GOVERNANCE"]);

function untilMs(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value.trim()) return Date.parse(value);
  return Number.NaN;
}

export function classifyStorageProtection(
  facts: StorageProtectionFacts | null | undefined,
  now: Date = new Date(),
): StorageProtectionClass {
  if (!facts || facts.readFailed) return "UNCONFIRMED";
  const mode = (facts.mode ?? "").trim().toUpperCase();
  const until = untilMs(facts.retainUntil);
  const legalHoldOn = (facts.legalHold ?? "").trim().toUpperCase() === "ON";
  const retentionInForce = RETENTION_MODES.has(mode) && Number.isFinite(until) && until > now.getTime();
  if (retentionInForce || legalHoldOn) return "PROTECTED";
  if (Number.isFinite(until) && until <= now.getTime()) return "RETENTION_EXPIRED";
  return "NOT_APPLIED";
}

/**
 * The review alert for a class, or null when there is nothing to flag. Worded
 * as what is TRUE of this record's stored object — never a claim about how the
 * platform is configured, which this record cannot know.
 */
export function storageProtectionAlert(
  cls: StorageProtectionClass,
): { severity: "warning" | "info"; label: string; detail: string } | null {
  switch (cls) {
    case "PROTECTED":
      return null;
    case "RETENTION_EXPIRED":
      return {
        severity: "info",
        label: "Storage retention ended",
        detail: "The Object Lock retention recorded for this record's stored object has passed its retain-until date.",
      };
    case "NOT_APPLIED":
      return {
        severity: "warning",
        label: "Storage protection incomplete",
        detail: "No Object Lock retention or legal hold is applied to this record's stored object.",
      };
    case "UNCONFIRMED":
      return {
        severity: "warning",
        label: "Storage protection not confirmed",
        detail: "The stored object's lock metadata could not be read, so its protection is not confirmed.",
      };
  }
}

/** Short value for an Integrity row. */
export function describeStorageProtection(
  facts: (StorageProtectionFacts & { source?: "RECORDED" | "OBSERVED" | null }) | null | undefined,
  cls: StorageProtectionClass,
  formatDate: (iso: string) => string = (iso) => iso,
): string {
  const until =
    facts?.retainUntil instanceof Date
      ? facts.retainUntil.toISOString()
      : typeof facts?.retainUntil === "string"
        ? facts.retainUntil
        : null;
  const mode = (facts?.mode ?? "").trim().toUpperCase();
  const how = facts?.source === "OBSERVED" ? "observed on the stored object" : "recorded at sealing";
  switch (cls) {
    case "PROTECTED":
      if (RETENTION_MODES.has(mode) && until) return `Object Lock ${mode} until ${formatDate(until)} (${how})`;
      return `Legal hold on (${how})`;
    case "RETENTION_EXPIRED":
      return until ? `Retention ended ${formatDate(until)}` : "Retention ended";
    case "NOT_APPLIED":
      return "Not applied";
    case "UNCONFIRMED":
      return "Not confirmed";
  }
}

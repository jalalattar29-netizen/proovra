/**
 * STORED-BYTES INTEGRITY STATE (ET-SM-07, owner decision 2026-09-30).
 *
 * Integrity rechecking is a core PROOVRA commitment for every signed record,
 * including one that never receives a report. "The signature verifies" is a
 * statement about the signed metadata; "the stored bytes still match the
 * signed digest" is a separate statement, and it is only as fresh as the last
 * time someone read the bytes. This is the one place that turns the recorded
 * facts into the state a surface may show.
 *
 * THE RULE: only `verified_current` may be presented as current verified
 * integrity. Stale, pending and unknown are said as what they are.
 *
 *   verified_current  the last attempt read the bytes at their exact recorded
 *                     version, they matched, and that was within the cadence
 *   verified_stale    they matched once, but that is older than the cadence —
 *                     or a later attempt could not read storage
 *   pending           never verified, and a recheck has been requested
 *   failed            the bytes did not match, or the recorded object version
 *                     is gone
 *   unknown           never checked (or storage was unavailable and nothing
 *                     earlier is on record)
 */
export const STORED_BYTES_INTEGRITY_STATES = [
  "verified_current",
  "verified_stale",
  "pending",
  "failed",
  "unknown",
] as const;
export type StoredBytesIntegrityState = (typeof STORED_BYTES_INTEGRITY_STATES)[number];

/** The outcome of one recheck attempt, as the authority records it. */
export const INTEGRITY_CHECK_OUTCOMES = ["VERIFIED", "FAILED", "UNAVAILABLE"] as const;
export type IntegrityCheckOutcome = (typeof INTEGRITY_CHECK_OUTCOMES)[number];

/** Bounded failure codes. FAILED carries one of the first two; UNAVAILABLE the rest. */
export const INTEGRITY_CHECK_FAILURE_CODES = [
  /** The bytes at the recorded version hash to something else. */
  "DIGEST_MISMATCH",
  /** The recorded object version does not exist in the store. */
  "OBJECT_VERSION_MISSING",
  /** The store could not be read (throttling, network, 5xx, access). Retried. */
  "STORAGE_UNAVAILABLE",
  /** The record has no stored location or no signed digest to compare with. */
  "NOT_CHECKABLE",
] as const;
export type IntegrityCheckFailureCode = (typeof INTEGRITY_CHECK_FAILURE_CODES)[number];

/** What asked for a check. */
export const INTEGRITY_CHECK_TRIGGERS = [
  "FINALIZATION",
  "REPORT_ISSUANCE",
  "PACKAGE_ISSUANCE",
  "PUBLIC_VERIFY",
  "ORIGINAL_RELEASE",
  "RECOVERY",
  "STORAGE_ANOMALY",
  "SCHEDULED",
] as const;
export type IntegrityCheckTrigger = (typeof INTEGRITY_CHECK_TRIGGERS)[number];

/** The periodic cadence, in days, unless configured otherwise. */
export const INTEGRITY_RECHECK_INTERVAL_DAYS_DEFAULT = 30;

export type StoredBytesIntegrityFacts = {
  /** The record is terminally rejected (status FAILED_HASH_MISMATCH). */
  rejected: boolean;
  lastVerifiedAtUtc: Date | string | null;
  lastCheckedAtUtc: Date | string | null;
  lastOutcome: string | null;
  lastFailureCode: string | null;
  recheckRequestedAtUtc: Date | string | null;
};

export type StoredBytesIntegrity = {
  state: StoredBytesIntegrityState;
  /** ISO time the bytes last matched; null when they never have. */
  lastVerifiedAtUtc: string | null;
  /** ISO time of the last attempt, whatever its outcome. */
  lastCheckedAtUtc: string | null;
  /** The bounded failure code of the last attempt, when it did not verify. */
  failureCode: IntegrityCheckFailureCode | null;
  /** The cadence this state was judged against. */
  intervalDays: number;
};

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function resolveStoredBytesIntegrity(
  facts: StoredBytesIntegrityFacts,
  now: Date = new Date(),
  intervalDays: number = INTEGRITY_RECHECK_INTERVAL_DAYS_DEFAULT,
): StoredBytesIntegrity {
  const verifiedAt = toDate(facts.lastVerifiedAtUtc);
  const checkedAt = toDate(facts.lastCheckedAtUtc);
  const failureCode = (INTEGRITY_CHECK_FAILURE_CODES as readonly string[]).includes(facts.lastFailureCode ?? "")
    ? (facts.lastFailureCode as IntegrityCheckFailureCode)
    : null;
  const base = {
    lastVerifiedAtUtc: verifiedAt ? verifiedAt.toISOString() : null,
    lastCheckedAtUtc: checkedAt ? checkedAt.toISOString() : null,
    intervalDays,
  };

  if (facts.rejected || facts.lastOutcome === "FAILED") {
    return { ...base, state: "failed", failureCode: failureCode ?? (facts.rejected ? "DIGEST_MISMATCH" : null) };
  }
  if (verifiedAt) {
    const ageMs = now.getTime() - verifiedAt.getTime();
    const withinCadence = ageMs <= intervalDays * 24 * 60 * 60 * 1000;
    // Current ONLY when the LATEST attempt is the one that verified: a later
    // attempt that could not read storage means "not confirmed now".
    if (withinCadence && facts.lastOutcome === "VERIFIED") {
      return { ...base, state: "verified_current", failureCode: null };
    }
    return { ...base, state: "verified_stale", failureCode: facts.lastOutcome === "VERIFIED" ? null : failureCode };
  }
  if (toDate(facts.recheckRequestedAtUtc)) {
    return { ...base, state: "pending", failureCode };
  }
  return { ...base, state: "unknown", failureCode };
}

/** May this state be presented as current verified integrity? Only one may. */
export function storedBytesIntegrityIsCurrent(state: StoredBytesIntegrityState): boolean {
  return state === "verified_current";
}

/** One sentence per state, for every surface (Verify page, record detail, native). */
export function storedBytesIntegrityCopy(integrity: StoredBytesIntegrity): { label: string; detail: string } {
  const on = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
  switch (integrity.state) {
    case "verified_current":
      return {
        label: "Stored file rechecked",
        detail: `The stored file was re-read and matched its signed hash on ${on(integrity.lastVerifiedAtUtc)}.`,
      };
    case "verified_stale":
      return {
        label: "Stored file recheck is out of date",
        detail: `The stored file last matched its signed hash on ${on(integrity.lastVerifiedAtUtc)}. That is older than the ${integrity.intervalDays}-day recheck interval, so it is not stated as current; a recheck is scheduled.`,
      };
    case "pending":
      return {
        label: "Stored file recheck pending",
        detail: "A recheck of the stored file against its signed hash has been requested and has not completed yet.",
      };
    case "failed":
      return {
        label: "Stored file recheck failed",
        detail:
          integrity.failureCode === "OBJECT_VERSION_MISSING"
            ? "The stored file could not be found at its recorded version, so it could not be matched to its signed hash."
            : "The stored file did not match its signed hash when it was last re-read.",
      };
    case "unknown":
      return {
        label: "Stored file not yet rechecked",
        detail: "The stored file has not been re-read against its signed hash since it was recorded, so its current state is not stated.",
      };
  }
}

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
 *                     version, they matched, and that was within the short
 *                     freshness window (UC-TRUST-008; not the 30-day cadence)
 *   verified_stale    they matched once, but that is older than the window —
 *                     or a later attempt could not read storage — or the store
 *                     keeps no immutable version of what was read, so a pass
 *                     says nothing about the bytes after the moment it read them
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

/**
 * UC-TRUST-008 — THE FRESHNESS WINDOW. The recheck cadence (above) decides
 * when a record is DUE; it does not decide what may be called CURRENT. A
 * stored-bytes check is a statement about the moment the bytes were read, so
 * only a passing check of the pinned version inside this short window is
 * presented as "Verified". An older passing check is said as
 * "last verified <time>" (STALE), never as a present-tense badge, and a reader
 * that finds a record outside the window requests a pinned-version recheck.
 */
export const STORED_BYTES_FRESHNESS_HOURS_DEFAULT = 24;

/**
 * The one check vocabulary every surface (Public Verify, report, package, web,
 * native) uses for the CURRENT OBJECT — a separate statement from the recorded
 * digest, which is immutable and signed:
 *
 *   VERIFIED     the pinned version was re-read inside the freshness window and
 *                matched the digest in the signed fingerprint
 *   MISMATCH     the bytes did NOT match the signed digest (substituted bytes),
 *                or the digest columns disagree with the signed fingerprint
 *   UNAVAILABLE  the pinned version does not exist or storage could not be read
 *   STALE        it matched once, outside the freshness window
 *   PENDING      never matched; a recheck has been requested
 *   UNKNOWN      never checked
 */
export const STORED_BYTES_CHECK_STATUSES = [
  "VERIFIED",
  "MISMATCH",
  "UNAVAILABLE",
  "STALE",
  "PENDING",
  "UNKNOWN",
] as const;
export type StoredBytesCheckStatus = (typeof STORED_BYTES_CHECK_STATUSES)[number];

export type StoredBytesIntegrityFacts = {
  /** The record is terminally rejected (status FAILED_HASH_MISMATCH). */
  rejected: boolean;
  lastVerifiedAtUtc: Date | string | null;
  lastCheckedAtUtc: Date | string | null;
  lastOutcome: string | null;
  lastFailureCode: string | null;
  recheckRequestedAtUtc: Date | string | null;
  /** The object VersionId the record pins (null for multipart / unversioned). */
  pinnedVersionId?: string | null;
  /** The digest the record's signed fingerprint certifies. */
  recordedDigest?: string | null;
  /**
   * UC-TRUST-008 — every stored object the check reads is a PINNED, immutable
   * version (the record's single VersionId, or one per part). Without it the
   * object can be replaced in place after a passing check, so the pass is never
   * "current". Absent = not pinned (fail closed).
   */
  versionPinned?: boolean;
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
  /** UC-TRUST-008 — the check status of the CURRENT object (see above). */
  checkStatus?: StoredBytesCheckStatus;
  /** The window inside which a passing check is presented as current. */
  freshnessHours?: number;
  /** The pinned object version a check reads; null when not single-object. */
  pinnedVersionId?: string | null;
  /** The recorded (signed) digest a check compares against. */
  recordedDigest?: string | null;
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
  freshnessHours: number = STORED_BYTES_FRESHNESS_HOURS_DEFAULT,
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
    freshnessHours,
    pinnedVersionId: facts.pinnedVersionId ?? null,
    recordedDigest: facts.recordedDigest ?? null,
  };

  if (facts.rejected || facts.lastOutcome === "FAILED") {
    const code = failureCode ?? (facts.rejected ? "DIGEST_MISMATCH" : null);
    return {
      ...base,
      state: "failed",
      failureCode: code,
      checkStatus: code === "OBJECT_VERSION_MISSING" ? "UNAVAILABLE" : "MISMATCH",
    };
  }
  if (verifiedAt) {
    const ageMs = now.getTime() - verifiedAt.getTime();
    const withinWindow = ageMs <= freshnessHours * 60 * 60 * 1000;
    // Current ONLY when the LATEST attempt is the one that verified AND it read
    // the bytes inside the short freshness window. A later attempt that could
    // not read storage means "not confirmed now".
    const pinned = facts.versionPinned === true || Boolean(facts.pinnedVersionId);
    if (withinWindow && facts.lastOutcome === "VERIFIED" && pinned) {
      return { ...base, state: "verified_current", failureCode: null, checkStatus: "VERIFIED" };
    }
    return {
      ...base,
      state: "verified_stale",
      failureCode: facts.lastOutcome === "VERIFIED" ? null : failureCode,
      checkStatus: "STALE",
    };
  }
  if (facts.lastOutcome === "UNAVAILABLE" && failureCode === "STORAGE_UNAVAILABLE") {
    return {
      ...base,
      state: toDate(facts.recheckRequestedAtUtc) ? "pending" : "unknown",
      failureCode,
      checkStatus: "UNAVAILABLE",
    };
  }
  if (toDate(facts.recheckRequestedAtUtc)) {
    return { ...base, state: "pending", failureCode, checkStatus: "PENDING" };
  }
  return { ...base, state: "unknown", failureCode, checkStatus: "UNKNOWN" };
}

/** The check status, also for a payload written before `checkStatus` existed. */
export function storedBytesCheckStatusOf(integrity: StoredBytesIntegrity): StoredBytesCheckStatus {
  if (integrity.checkStatus) return integrity.checkStatus;
  switch (integrity.state) {
    case "verified_current":
      return "VERIFIED";
    case "verified_stale":
      return "STALE";
    case "pending":
      return "PENDING";
    case "failed":
      return integrity.failureCode === "OBJECT_VERSION_MISSING" ? "UNAVAILABLE" : "MISMATCH";
    case "unknown":
      return "UNKNOWN";
  }
}

/** May this state be presented as current verified integrity? Only one may. */
export function storedBytesIntegrityIsCurrent(state: StoredBytesIntegrityState): boolean {
  return state === "verified_current";
}

/** A stored-bytes state that contradicts the recorded digest (substituted or gone). */
export function storedBytesIntegrityContradicts(integrity: StoredBytesIntegrity | null | undefined): boolean {
  if (!integrity) return false;
  const s = storedBytesCheckStatusOf(integrity);
  return s === "MISMATCH" || (s === "UNAVAILABLE" && integrity.state === "failed");
}

/** One sentence per state, for every surface (Verify page, record detail, native). */
export function storedBytesIntegrityCopy(integrity: StoredBytesIntegrity): { label: string; detail: string } {
  const at = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "an unrecorded time");
  switch (integrity.state) {
    case "verified_current":
      return {
        label: "Stored file rechecked",
        detail: `The stored file (its pinned version) was re-read and matched the digest in the signed fingerprint at ${at(integrity.lastVerifiedAtUtc)}.`,
      };
    case "verified_stale":
      return {
        label: `Stored file last verified ${at(integrity.lastVerifiedAtUtc)}`,
        detail: `The stored file last matched the digest in the signed fingerprint at ${at(integrity.lastVerifiedAtUtc)}. That is outside the ${integrity.freshnessHours ?? STORED_BYTES_FRESHNESS_HOURS_DEFAULT}-hour freshness window, so it is not stated as current; a recheck of the pinned version has been requested.`,
      };
    case "pending":
      if (integrity.checkStatus === "UNAVAILABLE") {
        return {
          label: "Stored file could not be read",
          detail: "Storage could not be read at the last attempt and the stored file has never been matched to its signed digest; a recheck is pending.",
        };
      }
      return {
        label: "Stored file recheck pending",
        detail: "A recheck of the stored file against its signed digest has been requested and has not completed yet.",
      };
    case "failed":
      return integrity.failureCode === "OBJECT_VERSION_MISSING"
        ? {
            label: "Stored file unavailable",
            detail: "The stored file could not be found at its recorded version, so it could not be matched to its signed digest.",
          }
        : {
            label: "Stored file does not match",
            detail: "The stored file did not match the digest in the signed fingerprint when it was last re-read.",
          };
    case "unknown":
      if (integrity.checkStatus === "UNAVAILABLE") {
        return {
          label: "Stored file could not be read",
          detail: "Storage could not be read at the last attempt and the stored file has never been matched to its signed digest, so its current state is not stated.",
        };
      }
      return {
        label: "Stored file not yet rechecked",
        detail: "The stored file has not been re-read against its signed digest since it was recorded, so its current state is not stated.",
      };
  }
}

// ---------------------------------------------------------------------------
// UC-TRUST-001 — THE SIGNED DIGESTS
// ---------------------------------------------------------------------------

/**
 * What the record's SIGNED fingerprint (`fingerprintCanonicalJson`, covered by
 * the Ed25519 signature) says the original bytes hash to. The `fileSha256` and
 * `evidence_parts.sha256` columns are unsigned and mutable; every byte-level
 * check compares against THIS, and a disagreement between the columns and the
 * fingerprint is itself an integrity failure.
 *
 *   single     `file.sha256` — the one object's digest
 *   multipart  `file.parts[].sha256` in partIndex order; the record digest is
 *              sha256(parts.join("|")) — computed by the caller's hasher, so
 *              this module stays free of a crypto dependency
 *
 * Null when the fingerprint is absent or cannot be read (a legacy record); the
 * caller then says it could not bind the check to the signature.
 */
export type SignedFingerprintDigests =
  | { kind: "single"; sha256: string }
  | {
      kind: "multipart";
      parts: ReadonlyArray<{
        partIndex: number;
        sha256: string;
        storageBucket: string | null;
        storageKey: string | null;
      }>;
    };

const HEX64 = /^[a-f0-9]{64}$/i;

export function signedDigestsFromFingerprint(
  fingerprintCanonicalJson: string | null | undefined,
): SignedFingerprintDigests | null {
  if (!fingerprintCanonicalJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprintCanonicalJson);
  } catch {
    return null;
  }
  const file = (parsed as { file?: unknown } | null)?.file as Record<string, unknown> | undefined;
  if (!file || typeof file !== "object") return null;
  if (file["multipart"] === true) {
    const raw = Array.isArray(file["parts"]) ? (file["parts"] as unknown[]) : [];
    const parts = raw
      .map((p) => p as Record<string, unknown>)
      .filter((p) => typeof p["partIndex"] === "number" && typeof p["sha256"] === "string" && HEX64.test(p["sha256"] as string))
      .map((p) => ({
        partIndex: p["partIndex"] as number,
        sha256: (p["sha256"] as string).toLowerCase(),
        storageBucket: typeof p["storageBucket"] === "string" ? (p["storageBucket"] as string) : null,
        storageKey: typeof p["storageKey"] === "string" ? (p["storageKey"] as string) : null,
      }))
      .sort((a, b) => a.partIndex - b.partIndex);
    if (parts.length === 0 || parts.length !== raw.length) return null;
    return { kind: "multipart", parts };
  }
  const sha = file["sha256"];
  return typeof sha === "string" && HEX64.test(sha) ? { kind: "single", sha256: sha.toLowerCase() } : null;
}

/**
 * The record-level digest the signed fingerprint certifies — the value a
 * recheck must reproduce. `sha256Hex` is the caller's hasher (node:crypto on
 * the server).
 */
export function signedRecordDigest(
  signed: SignedFingerprintDigests,
  sha256Hex: (text: string) => string,
): string {
  if (signed.kind === "single") return signed.sha256;
  return signed.parts.length === 1
    ? signed.parts[0]!.sha256
    : sha256Hex(signed.parts.map((p) => p.sha256).join("|"));
}

/**
 * Do the unsigned digest columns agree with the signed fingerprint? True /
 * false; null when there is no readable fingerprint to compare with.
 *
 * `fileSha256` must equal the signed record digest (a single-part multipart
 * record may also carry the legacy composite of its one part), and every
 * part row must carry the signed digest of its partIndex.
 */
export function digestColumnsMatchSignedFingerprint(
  input: {
    fingerprintCanonicalJson: string | null | undefined;
    fileSha256: string | null | undefined;
    parts?: ReadonlyArray<{ partIndex: number; sha256: string | null }>;
  },
  sha256Hex: (text: string) => string,
): boolean | null {
  const signed = signedDigestsFromFingerprint(input.fingerprintCanonicalJson);
  if (!signed) return null;
  const file = (input.fileSha256 ?? "").toLowerCase();
  const expected = signedRecordDigest(signed, sha256Hex);
  const legacyComposite =
    signed.kind === "single" ? sha256Hex(signed.sha256) : signed.parts.length === 1 ? sha256Hex(signed.parts[0]!.sha256) : null;
  if (file !== expected && file !== legacyComposite) return false;
  const rows = input.parts ?? [];
  if (signed.kind === "multipart") {
    if (rows.length !== signed.parts.length) return false;
    const byIndex = new Map(rows.map((r) => [r.partIndex, (r.sha256 ?? "").toLowerCase()]));
    return signed.parts.every((p) => byIndex.get(p.partIndex) === p.sha256);
  }
  // A single-file fingerprint: a part row, when one exists, must carry the signed digest.
  return rows.every((r) => (r.sha256 ?? "").toLowerCase() === signed.sha256);
}

// ---------------------------------------------------------------------------
// UC-TRUST-005 — THE STORED BYTES ARE AN INPUT TO THE VERDICT
// ---------------------------------------------------------------------------

/**
 * The trust decision is computed over PROOVRA's signed records. This applies
 * the stored-bytes statement to it, so a headline can never stay positive
 * while the stored original is gone or does not match its signed digest:
 *
 *   contradicts (MISMATCH, missing version) or the digest columns disagree
 *   with the signed fingerprint  ->  REVIEW_REQUIRED, low reliance
 *   not re-verified inside the freshness window (STALE / PENDING / UNKNOWN /
 *   unreadable)  ->  a "high reliance" verdict is capped at conditional
 *   VERIFIED  ->  unchanged
 *
 * Generic over the decision shape so it serves the shared TrustDecision and
 * the snapshot copies of it; only the named presentation fields are touched.
 */
export function applyStoredBytesToTrustDecision<
  D extends {
    verdict: string;
    level: string;
    tone: string;
    presentationState: string;
    presentationTone: string;
    verdictLabel: string;
    shortLabel: string;
    title: string;
    confidenceLabel: string;
    primaryReason: string;
    reviewerAction: string;
    relianceLevel: string;
  },
>(
  decision: D,
  storedBytes: StoredBytesIntegrity | null | undefined,
  opts: { digestColumnsMatchSignedFingerprint?: boolean | null } = {},
): D {
  const columnsDisagree = opts.digestColumnsMatchSignedFingerprint === false;
  if (storedBytesIntegrityContradicts(storedBytes) || columnsDisagree) {
    const missing = storedBytes?.failureCode === "OBJECT_VERSION_MISSING";
    return {
      ...decision,
      verdict: "REVIEW_REQUIRED",
      level: "review",
      tone: "danger",
      presentationState: "FAILED_VERIFICATION",
      presentationTone: "danger",
      verdictLabel: "Integrity review required",
      shortLabel: "Review",
      title: columnsDisagree
        ? "Recorded digests disagree with the signed fingerprint"
        : missing
          ? "Stored original unavailable at its recorded version"
          : "Stored file does not match its signed digest",
      confidenceLabel: "Low",
      primaryReason: columnsDisagree
        ? "The digest recorded for the file does not match the digest in the signed fingerprint."
        : storedBytes
          ? storedBytesIntegrityCopy(storedBytes).detail
          : "The stored file could not be matched to its signed digest.",
      reviewerAction: "Do not rely on this record until the stored original has been investigated.",
      relianceLevel: "low",
    };
  }
  const status = storedBytes ? storedBytesCheckStatusOf(storedBytes) : null;
  if (status !== "VERIFIED" && decision.relianceLevel === "high") {
    return {
      ...decision,
      level: "standard",
      tone: "warning",
      presentationState: "VERIFIED_WITH_DEGRADED_SIGNALS",
      presentationTone: "warning",
      verdictLabel:
        status === "STALE" && storedBytes?.lastVerifiedAtUtc
          ? `Recorded integrity verified; stored file last verified ${storedBytes.lastVerifiedAtUtc.slice(0, 10)}`
          : "Recorded integrity verified; stored file not re-verified recently",
      shortLabel: "Conditional",
      confidenceLabel: "Conditional",
      relianceLevel: "medium",
    };
  }
  return decision;
}

/**
 * UC-STR-001 — THE capture resource limits. ONE source of truth.
 *
 * Before this module the continuous client, the native recorders and the
 * continuity-manifest validator each carried "600 segments / 50 minutes" while
 * the part writer (ET-ACQ-07) accepted part indexes 0..199 only. A recording
 * that reached segment 200 could not declare it, the manifest part collided,
 * staging failed and the whole session was discarded.
 *
 * Every bound below is consumed from here:
 *   - the API part writer and the capture routes (part index ceiling),
 *   - the continuity-manifest validator and the streaming client bounds
 *     (`screen-continuous-manifest.ts` derives from these values),
 *   - the mobile JS binding (segment clamp),
 *   - the Kotlin and Swift recorders — BY VALUE, since native code cannot
 *     import TypeScript. `apps/mobile/test/capture-limits-native-sync.test.mjs`
 *     parses the native constants and fails when they drift.
 *
 * These are technical safety limits, not commercial entitlements.
 */

/** THE upper bound on a record's parts: indexes 0..MAX-1 (ET-ACQ-07). */
export const MAX_EVIDENCE_PARTS = 200 as const;

export const CAPTURE_LIMITS = {
  /** Part indexes a record may use: 0 .. maxEvidenceParts - 1. */
  maxEvidenceParts: MAX_EVIDENCE_PARTS,
  /**
   * The most ORIGINAL segments one continuous session may record. One part is
   * reserved for the continuity manifest, so segments + manifest always fit
   * inside `maxEvidenceParts` (segment part indexes 0..198, manifest <= 199).
   */
  maxContinuousSegments: MAX_EVIDENCE_PARTS - 1,
  /** Max wall-clock duration of one continuous session (ms). */
  maxContinuousSessionMs: 50 * 60 * 1000,
  /** Per-segment byte ceiling (native rollover; defence in depth). */
  maxContinuousSegmentBytes: 64 * 1024 * 1024,
  /** Whole-session byte ceiling across all ORIGINAL segments. */
  maxContinuousSessionBytes: 512 * 1024 * 1024,
  /** Default and clamp window of one continuous segment (ms). */
  defaultContinuousSegmentMs: 6000,
  minContinuousSegmentMs: 2000,
  maxContinuousSegmentMs: 30000,
} as const;

/**
 * UC-STR-002 / UC-STR-006 — THE seal claim of a direct-capture session.
 *
 * A seal hashes every part OUTSIDE any transaction. Before it starts, a short
 * transaction under the session lock checks the manifest against the
 * declarations and CLAIMS the session: status stays ACTIVE and `endReason` is
 * set to `endReason` below (an ACTIVE session's end reason is otherwise always
 * NULL, so the value is unambiguous) — the row's `updatedAt` is the claim's
 * timestamp. While a claim is LIVE (younger than `leaseMs`), declarations,
 * reservations, discards and other seals answer SESSION_BUSY; a STALE claim
 * (a crashed seal) is reclaimed by the next seal attempt and released by the
 * capture reaper. The lease is well above the longest completion transaction
 * (120 s) plus hashing.
 */
export const CAPTURE_SEAL_CLAIM = {
  endReason: "SEAL_IN_PROGRESS",
  leaseMs: 10 * 60 * 1000,
} as const;

/** True when the session holds a seal claim that is still within its lease. */
export function isLiveSealClaim(
  session: { status: string; endReason: string | null; updatedAt: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (session.status !== "ACTIVE" || session.endReason !== CAPTURE_SEAL_CLAIM.endReason) return false;
  const at = session.updatedAt ? new Date(session.updatedAt).getTime() : 0;
  return now.getTime() - at < CAPTURE_SEAL_CLAIM.leaseMs;
}

/** True when the session holds a seal claim whose lease has expired (a crashed seal). */
export function isStaleSealClaim(
  session: { status: string; endReason: string | null; updatedAt: Date | string | null },
  now: Date = new Date(),
): boolean {
  return (
    session.status === "ACTIVE" &&
    session.endReason === CAPTURE_SEAL_CLAIM.endReason &&
    !isLiveSealClaim(session, now)
  );
}

/** True when `partIndex` is an index a record may hold. */
export function isCapturePartIndexInBounds(partIndex: unknown): partIndex is number {
  return (
    typeof partIndex === "number" &&
    Number.isInteger(partIndex) &&
    partIndex >= 0 &&
    partIndex < CAPTURE_LIMITS.maxEvidenceParts
  );
}

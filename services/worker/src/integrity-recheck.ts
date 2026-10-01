/**
 * THE WORKER'S INTEGRITY RECHECK (ET-SM-07, owner decision 2026-09-30).
 *
 * Integrity rechecking is a core commitment for every signed record, on every
 * plan, including a record that never receives a report. The stored bytes used
 * to be re-hashed only inside report generation — which is commercially gated —
 * so a record without a report was never re-verified and storage drift on it
 * stayed invisible.
 *
 * This module is the one place in the worker that:
 *   - READS the original object(s) at their exact recorded VersionId and
 *     computes the digest (`observeOriginalDigest`) — the same rule the report
 *     pipeline applies (single object; or the per-part hashes joined, with the
 *     legacy single-part composite still accepted);
 *   - RECORDS an observation through the shared authority and, on a digest
 *     mismatch, applies the terminal rejection (`recordIntegrityObservation`).
 *     `rejectEvidenceIntegrity` has no other caller;
 *   - RECHECKS one record under the authority's claim
 *     (`recheckEvidenceIntegrity`);
 *   - SWEEPS the due population on a schedule (`runIntegrityRecheckSweep`),
 *     paginated and bounded, under the reconciliation-run lock, so it is
 *     idempotent, retryable and observable, and needs no queue: a lost tick is
 *     recovered by the next one because due-ness is a fact in the database.
 *
 * Report issuance already reads every original byte; it reports what it saw
 * through `recordIntegrityObservation` instead of hashing twice.
 *
 * A recheck never changes a record's lifecycle. A mismatch makes the record
 * FAILED_HASH_MISMATCH where it is (trashed stays trashed); destroyed and
 * being-destroyed records are out of scope.
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import * as prismaPkg from "@prisma/client";
import {
  compositeSha256,
  sha256HexFromStream,
  INTEGRITY_RECHECK_CLAIM_LEASE_MS,
  claimIntegrityRecheck,
  integrityRecheckDueWhere,
  integrityRecheckEligibleWhere,
  recordIntegrityCheckTx,
  runGovernanceReconciliation,
  type IntegrityCheckedObject,
} from "@proovra/shared-runtime";
import {
  digestColumnsMatchSignedFingerprint,
  signedDigestsFromFingerprint,
  signedRecordDigest,
  type IntegrityCheckFailureCode,
  type IntegrityCheckOutcome,
  type IntegrityCheckTrigger,
} from "@proovra/shared";

import { prisma } from "./db.js";
import { rejectEvidenceIntegrity, type IntegrityRejectionSource } from "./integrity-rejection.service.js";
import { logger } from "./logger.js";
import { getObjectStream, headObject } from "./storage.js";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * `IntegrityRecheckSweep` is its own recovery: a claim whose owner died expires
 * after `INTEGRITY_RECHECK_CLAIM_LEASE_MS` and the record is due again, and a
 * tick that never ran is made up by the next one because due-ness is a fact on
 * the Evidence row.
 *
 * Keys, not values: the registry addresses work through `SWEEP_NAMES`, and a
 * literal string here would be a second spelling of a name the shared
 * authority already owns.
 */
export const RECOVERED_WORK_TYPES = ["INTEGRITY_RECHECK"] as const;

/** The storage reads a recheck needs. Injected so the rule is testable without a bucket. */
export type IntegrityObjectReader = {
  head: (o: { bucket: string; key: string; versionId: string | null }) => Promise<{ sizeBytes: number | null }>;
  stream: (o: { bucket: string; key: string; versionId: string | null }) => Promise<Readable>;
};

const workerReader: IntegrityObjectReader = {
  head: (o) => headObject(o),
  stream: async (o) => (await getObjectStream(o)) as unknown as Readable,
};

// UC-ARCH-006 — the ONE digest rules live in @proovra/shared-runtime
// (integrity/digest.ts); re-exported for callers and tests of this module.
export { compositeSha256 };

const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * UC-TRUST-001 — THE EXPECTED DIGEST OF EVERY BYTE CHECK.
 *
 * The unsigned `fileSha256` / `evidence_parts.sha256` columns are mutable; the
 * fingerprint is what the Ed25519 signature covers. The expected digest is
 * therefore read from the SIGNED fingerprint (single `file.sha256`, or the
 * composite of `file.parts[].sha256` in partIndex order), and a column that
 * disagrees with it is reported (`columnsAgree: false`) so the caller treats
 * it as an integrity failure. A legacy record without a readable fingerprint
 * falls back to the column and says so (`signed: false`).
 */
export function resolveExpectedOriginalDigest(input: {
  fingerprintCanonicalJson?: string | null;
  fileSha256: string | null;
  parts?: ReadonlyArray<{ partIndex: number; sha256?: string | null }>;
}): {
  expectedDigest: string | null;
  signed: boolean;
  columnsAgree: boolean | null;
  signedPartDigests: ReadonlyMap<number, string> | null;
} {
  const signed = signedDigestsFromFingerprint(input.fingerprintCanonicalJson ?? null);
  if (!signed) {
    return { expectedDigest: input.fileSha256 ?? null, signed: false, columnsAgree: null, signedPartDigests: null };
  }
  const columnsAgree = digestColumnsMatchSignedFingerprint(
    {
      fingerprintCanonicalJson: input.fingerprintCanonicalJson ?? null,
      fileSha256: input.fileSha256,
      parts: input.parts?.map((p) => ({ partIndex: p.partIndex, sha256: p.sha256 ?? null })),
    },
    sha256Text,
  );
  return {
    expectedDigest: signedRecordDigest(signed, sha256Text),
    signed: true,
    columnsAgree,
    signedPartDigests: signed.kind === "multipart" ? new Map(signed.parts.map((p) => [p.partIndex, p.sha256])) : null,
  };
}

/** The store answered "not found" for this exact object version. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NoSuchVersion" ||
    e?.name === "NotFound" ||
    e?.Code === "NoSuchKey" ||
    e?.Code === "NoSuchVersion" ||
    e?.code === "EVIDENCE_ORIGINAL_NOT_FOUND" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export type IntegrityObservation = {
  /** UC-TRUST-001 — the digest the check compared against (the SIGNED one when readable). */
  expectedDigest?: string | null;
  outcome: IntegrityCheckOutcome;
  failureCode: IntegrityCheckFailureCode | null;
  /** The digest computed over the stored bytes; null when they could not all be read. */
  checkedDigest: string | null;
  storageVersionId: string | null;
  checkedObjects: IntegrityCheckedObject[];
};

type OriginalLocation = {
  id: string;
  fileSha256: string | null;
  /** The signed fingerprint; the expected digest is read from it (UC-TRUST-001). */
  fingerprintCanonicalJson?: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  storageVersionId: string | null;
};
type PartLocation = {
  partIndex: number;
  /** The unsigned per-part digest column, compared with the fingerprint. */
  sha256?: string | null;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
};

/**
 * Read the record's original bytes at their exact recorded versions and say
 * what was found. Never throws for a storage answer: "not found" is FAILED /
 * OBJECT_VERSION_MISSING, anything else the store refuses is UNAVAILABLE.
 */
export async function observeOriginalDigest(
  evidence: OriginalLocation,
  parts: readonly PartLocation[],
  reader: IntegrityObjectReader = workerReader,
): Promise<IntegrityObservation> {
  const objects: Array<{ partIndex: number | null; bucket: string; key: string; versionId: string | null }> =
    parts.length > 0
      ? parts.map((p) => ({
          partIndex: p.partIndex,
          bucket: p.storageBucket,
          key: p.storageKey,
          versionId: p.storageVersionId ?? null,
        }))
      : evidence.storageBucket && evidence.storageKey
        ? [{ partIndex: null, bucket: evidence.storageBucket, key: evidence.storageKey, versionId: evidence.storageVersionId ?? null }]
        : [];
  const single = parts.length === 0;
  const storageVersionId = single ? (evidence.storageVersionId ?? null) : null;
  const expected = resolveExpectedOriginalDigest({
    fingerprintCanonicalJson: evidence.fingerprintCanonicalJson ?? null,
    fileSha256: evidence.fileSha256,
    parts,
  });
  const expectedDigest = expected.expectedDigest;

  if (objects.length === 0 || !expectedDigest) {
    return { expectedDigest, outcome: "UNAVAILABLE", failureCode: "NOT_CHECKABLE", checkedDigest: null, storageVersionId, checkedObjects: [] };
  }

  const checked: IntegrityCheckedObject[] = [];
  const hashes: string[] = [];
  for (const o of objects) {
    try {
      const head = await reader.head(o);
      if (!head.sizeBytes || head.sizeBytes <= 0) {
        checked.push({ partIndex: o.partIndex, versionId: o.versionId, sha256: null });
        return { expectedDigest, outcome: "FAILED", failureCode: "OBJECT_VERSION_MISSING", checkedDigest: null, storageVersionId, checkedObjects: checked };
      }
      const sha = await sha256HexFromStream(await reader.stream(o));
      hashes.push(sha);
      checked.push({ partIndex: o.partIndex, versionId: o.versionId, sha256: sha });
    } catch (err) {
      checked.push({ partIndex: o.partIndex, versionId: o.versionId, sha256: null });
      return isNotFound(err)
        ? { expectedDigest, outcome: "FAILED", failureCode: "OBJECT_VERSION_MISSING", checkedDigest: null, storageVersionId, checkedObjects: checked }
        : { expectedDigest, outcome: "UNAVAILABLE", failureCode: "STORAGE_UNAVAILABLE", checkedDigest: null, storageVersionId, checkedObjects: checked };
    }
  }

  const digest = single ? hashes[0]! : hashes.length === 1 ? hashes[0]! : compositeSha256(hashes);
  const legacySinglePartComposite = !single && hashes.length === 1 ? compositeSha256(hashes) : null;
  // Every part must carry the digest the fingerprint signed for its index, the
  // record digest must equal the signed one, and the unsigned columns must
  // agree with the fingerprint (UC-TRUST-001): a consistent rewrite of bytes
  // AND columns is a mismatch, not a pass.
  const partsMatchSigned =
    expected.signedPartDigests === null ||
    checked.every((c) => c.partIndex === null || expected.signedPartDigests!.get(c.partIndex) === c.sha256);
  const matches =
    (digest === expectedDigest || legacySinglePartComposite === expectedDigest) &&
    partsMatchSigned &&
    expected.columnsAgree !== false;
  return {
    expectedDigest,
    outcome: matches ? "VERIFIED" : "FAILED",
    failureCode: matches ? null : "DIGEST_MISMATCH",
    checkedDigest: digest,
    storageVersionId,
    checkedObjects: checked,
  };
}


/**
 * Record one observation and apply its consequence. THE one writer.
 *
 * The history row and the latest-state columns go in together. A DIGEST
 * MISMATCH then applies the terminal rejection (status FAILED_HASH_MISMATCH,
 * custody event, security event) — idempotently, so a duplicate observation
 * of the same drift writes one rejection.
 */
export async function recordIntegrityObservation(input: {
  evidenceId: string;
  teamId: string | null;
  expectedDigest: string | null;
  observation: IntegrityObservation;
  trigger: IntegrityCheckTrigger;
  correlationId?: string | null;
  attempt?: number | null;
  /**
   * Which reader saw the mismatch. The report pipeline names its single-file
   * or multipart path; every other reader is the recheck itself.
   */
  rejectionSource?: IntegrityRejectionSource;
  now?: Date;
}): Promise<{ checkId: string; rejected: boolean }> {
  const { observation } = input;
  const expectedDigest = observation.expectedDigest ?? input.expectedDigest;
  const recorded = await prisma.$transaction((tx) =>
    recordIntegrityCheckTx(tx, {
      evidenceId: input.evidenceId,
      teamId: input.teamId,
      outcome: observation.outcome,
      failureCode: observation.failureCode,
      trigger: input.trigger,
      storageVersionId: observation.storageVersionId,
      checkedObjects: observation.checkedObjects,
      expectedDigest,
      checkedDigest: observation.checkedDigest,
      correlationId: input.correlationId ?? null,
      checkedAtUtc: input.now,
    }),
  );

  let rejected = false;
  if (observation.outcome === "FAILED" && observation.failureCode === "DIGEST_MISMATCH" && observation.checkedDigest) {
    const result = await rejectEvidenceIntegrity({
      evidenceId: input.evidenceId,
      expectedSha256: expectedDigest,
      computedSha256: observation.checkedDigest,
      source: input.rejectionSource ?? "worker.reconciler",
      jobId: input.correlationId ?? null,
      attempt: input.attempt ?? null,
    });
    rejected = result.applied || result.reason === "already_rejected";
  }

  if (observation.outcome !== "VERIFIED") {
    logger.warn(
      {
        evidenceId: input.evidenceId,
        trigger: input.trigger,
        outcome: observation.outcome,
        failureCode: observation.failureCode,
        correlationId: input.correlationId ?? null,
        // A failed check is an operator matter; an unavailable store is retried.
        ...(observation.outcome === "FAILED" ? { alert: true, severity: "high" } : {}),
      },
      "evidence.integrity.recheck_not_verified",
    );
  }
  return { checkId: recorded.id, rejected };
}

export type IntegrityRecheckResult =
  | { checked: true; outcome: IntegrityCheckOutcome; failureCode: IntegrityCheckFailureCode | null; rejected: boolean }
  | { checked: false; reason: "NOT_ELIGIBLE_OR_HELD" };

/**
 * Recheck ONE record: claim it, read its bytes, record what was found.
 *
 * `force` rechecks an eligible record that is not yet due (recovery, an
 * issuance that must know now). Without it only a due record is taken — which
 * is what makes a duplicate call a no-op. A record another checker holds, or
 * one that is out of scope (destroyed, being destroyed, not signed), is not
 * touched.
 */
export async function recheckEvidenceIntegrity(input: {
  evidenceId: string;
  trigger: IntegrityCheckTrigger;
  correlationId?: string | null;
  force?: boolean;
  reader?: IntegrityObjectReader;
  now?: Date;
}): Promise<IntegrityRecheckResult> {
  const now = input.now ?? new Date();
  const claimed = await claimIntegrityRecheck(prisma, input.evidenceId, { now, force: input.force });
  if (!claimed) return { checked: false, reason: "NOT_ELIGIBLE_OR_HELD" };

  const evidence = await prisma.evidence.findUnique({
    where: { id: input.evidenceId },
    select: {
      id: true,
      teamId: true,
      fileSha256: true,
      fingerprintCanonicalJson: true,
      storageBucket: true,
      storageKey: true,
      storageVersionId: true,
    },
  });
  if (!evidence) return { checked: false, reason: "NOT_ELIGIBLE_OR_HELD" };
  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId: evidence.id },
    orderBy: { partIndex: "asc" },
    select: { partIndex: true, sha256: true, storageBucket: true, storageKey: true, storageVersionId: true },
  });

  const observation = await observeOriginalDigest(evidence, parts, input.reader);
  const recorded = await recordIntegrityObservation({
    evidenceId: evidence.id,
    teamId: evidence.teamId ?? null,
    expectedDigest: evidence.fileSha256 ?? null,
    observation,
    trigger: input.trigger,
    correlationId: input.correlationId ?? null,
    now,
  });
  return { checked: true, outcome: observation.outcome, failureCode: observation.failureCode, rejected: recorded.rejected };
}

/** Records one tick examines. Bounded: a tick is a slice, the schedule is the loop. */
export const INTEGRITY_RECHECK_SWEEP_BATCH = 25;
export const INTEGRITY_RECHECK_SWEEP_MAX_BATCH = 200;

export type IntegrityRecheckSweepResult = {
  runId: string | null;
  status: string;
  scanned: number;
  verified: number;
  failed: number;
  unavailable: number;
  skipped: number;
};

/**
 * THE SCHEDULED SWEEP. Pages through the due population — on-demand requests
 * first, then never-checked records, then the oldest checks — and rechecks up
 * to `limit` of them.
 *
 * One run at a time (the reconciliation-run lock, with a lease a crashed run
 * frees). Idempotent: every record is taken under its own claim, so an
 * overlapping or repeated tick rechecks nothing twice. Recoverable without a
 * queue: what is due is a fact in the database, so a tick that never ran is
 * simply made up by the next one. Every plan, every workspace; each record is
 * read by its own id and recorded against its own workspace.
 */
export async function runIntegrityRecheckSweep(
  options: {
    trigger?: string;
    limit?: number;
    reader?: IntegrityObjectReader;
    now?: Date;
    /** Restrict the run to one workspace (an operator-requested recheck). Its lock is that workspace's own. */
    teamId?: string | null;
  } = {},
): Promise<IntegrityRecheckSweepResult> {
  const limit = Math.max(1, Math.min(options.limit ?? INTEGRITY_RECHECK_SWEEP_BATCH, INTEGRITY_RECHECK_SWEEP_MAX_BATCH));
  const tally = { scanned: 0, verified: 0, failed: 0, unavailable: 0, skipped: 0 };

  const run = await runGovernanceReconciliation(prisma, {
    kind: prismaPkg.GovernanceReconciliationKind.INTEGRITY_RECHECK,
    trigger: options.trigger ?? "scheduler",
    teamId: options.teamId ?? null,
    body: async (ctx) => {
      const now = options.now ?? new Date();
      const due = await prisma.evidence.findMany({
        where: options.teamId
          ? { AND: [integrityRecheckDueWhere(now), { teamId: options.teamId }] }
          : integrityRecheckDueWhere(now),
        // Requested first (NULLS LAST on a desc-less asc would put them last,
        // so requests are ordered explicitly), then never-checked, then oldest.
        orderBy: [
          { integrityRecheckRequestedAtUtc: { sort: "asc", nulls: "last" } },
          { integrityCheckedAtUtc: { sort: "asc", nulls: "first" } },
          { id: "asc" },
        ],
        take: limit,
        select: { id: true },
      });
      ctx.reportProgress({ scanned: due.length });
      tally.scanned = due.length;

      for (const row of due) {
        const result = await recheckEvidenceIntegrity({
          evidenceId: row.id,
          trigger: "SCHEDULED",
          correlationId: `integrity-recheck:${ctx.runId}`,
          reader: options.reader,
          now: options.now,
        });
        if (!result.checked) {
          tally.skipped += 1;
          ctx.reportProgress({ skipped: 1 });
          continue;
        }
        if (result.outcome === "VERIFIED") {
          tally.verified += 1;
          ctx.reportProgress({ matched: 1 });
        } else if (result.outcome === "FAILED") {
          tally.failed += 1;
          ctx.reportProgress({ incident: 1 });
        } else {
          tally.unavailable += 1;
          ctx.reportProgress({ failed: 1 });
        }
      }
      ctx.setMetadata("verified", tally.verified);
      ctx.setMetadata("failed", tally.failed);
      ctx.setMetadata("unavailable", tally.unavailable);
      ctx.setMetadata("claimLeaseMs", INTEGRITY_RECHECK_CLAIM_LEASE_MS);
      return tally;
    },
  });

  return { runId: run.runId ?? null, status: String(run.status), ...tally };
}

/** How many eligible records are due right now — the sweep's backlog. */
export async function countIntegrityRecheckBacklog(now: Date = new Date()): Promise<{ due: number; eligible: number }> {
  const [due, eligible] = await Promise.all([
    prisma.evidence.count({ where: integrityRecheckDueWhere(now) }),
    prisma.evidence.count({ where: integrityRecheckEligibleWhere() }),
  ]);
  return { due, eligible };
}

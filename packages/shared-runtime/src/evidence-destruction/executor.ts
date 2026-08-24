/**
 * THE ONE PHYSICAL EVIDENCE DESTRUCTION EXECUTOR.
 *
 * Before this module there were FOUR, and no two of them did the same thing:
 *
 *   1. `processPurgeDeletedEvidence` (worker) deleted the S3 objects and then
 *      HARD-DELETED the Evidence row along with its custody events — leaving no
 *      tombstone, no DESTROYED state, no certificate, and no audit chain. It
 *      also skipped archived records entirely, so an archived-then-trashed
 *      record was never destroyed at all.
 *   2. `runDestructionOrchestration` (worker governance) wrote
 *      `status: "STORAGE_DELETED"` WITHOUT CONTACTING STORAGE, then flipped
 *      `lifecycleState` to DESTROYED and emitted a destruction certificate. The
 *      bytes were still in the bucket.
 *   3. `executeDestruction` (API Phase-4B) did delete objects, but never
 *      re-read the record, never re-computed eligibility, held no lease, and
 *      never verified that the objects were actually gone before certifying.
 *   4. `executeApprovedReview` (API governance-lifecycle) set DESTROYED and a
 *      certificate hash with, again, zero storage deletion.
 *
 * Two of the four could therefore produce a signed statement that evidence had
 * been destroyed while every byte of it remained retrievable. That is the
 * defect this module exists to make impossible, and it is made impossible
 * structurally: the certificate is minted at ONE place in ONE function, and the
 * only path to that place runs through a verified delete.
 *
 * THE SEQUENCE, AND WHY EACH STEP IS WHERE IT IS
 * ---------------------------------------------------------------------------
 *   1. CLAIM a durable lease. Not a row lock: a row lock is transaction-scoped
 *      and the storage calls take seconds to minutes, so it would have to be
 *      held across network I/O or dropped exactly when it matters. The claim is
 *      a compare-and-set on `lifecycle_state` (TRASHED -> PENDING_DESTRUCTION)
 *      plus a lease stamp, so it survives the storage work, it is visible to an
 *      operator reading the row, and a crashed executor's claim expires instead
 *      of stranding the record forever.
 *   2. RELOAD the row inside the claim. Everything read before the claim is
 *      advisory; the facts that decide an irreversible operation must be the
 *      facts as of the moment the claim was won.
 *   3. RECOMPUTE eligibility from the canonical authority. A legal hold placed
 *      between "the reconciler listed this candidate" and "the executor ran"
 *      must win, and it does.
 *   4. FAIL CLOSED on any block reason, releasing the claim.
 *   5. ENUMERATE every storage key the record owns.
 *   6. DELETE them.
 *   7. VERIFY they are gone, by asking storage again. A delete that returned
 *      200 against a bucket with a COMPLIANCE lock, or against a versioned
 *      bucket where the delete only wrote a marker, has not destroyed anything.
 *      This step is the difference between "we asked" and "it happened".
 *   8. ONLY THEN tombstone, stamp `destroyed_at_utc`, and mint the certificate.
 *
 * If step 6 or step 7 fails: the state goes BACK to TRASHED, `destroyed_at_utc`
 * stays null, and no certificate exists. There is no branch in this file that
 * reaches the certificate without passing step 7.
 *
 * WHAT THE TOMBSTONE KEEPS
 * ---------------------------------------------------------------------------
 * The Evidence row survives, and so does its custody chain, its anchors and its
 * certifications — those ARE the audit record of a record that used to exist,
 * and the old purge deleted them, which is why a purged record left no trace
 * that anything had ever been destroyed. What does not survive is content:
 * storage pointers are cleared, and the part / report / verification-package
 * rows are removed because the objects they address no longer exist and a
 * dangling pointer is worse than no pointer.
 *
 * PORTS
 * ---------------------------------------------------------------------------
 * Storage is injected. This package cannot import either host's S3 client
 * (they configure their own), and injecting it also means the destructive path
 * is exercised in tests against a disposable MinIO through the same code the
 * hosts run, rather than through a mock of it.
 */

import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  computeEvidenceDestructionEligibility,
  type EvidenceLifecycleBlockReason,
} from "@proovra/shared";
import { buildCustodyEventHash, canonicalJsonValue } from "@proovra/shared/custody-hash";
import { createHash } from "node:crypto";

/**
 * How long a destruction claim stays valid before another executor may take it
 * over. Generous: the work is bounded by storage round-trips over a record that
 * may own hundreds of objects, and reclaiming a claim that is merely slow would
 * be the one way to get two executors deleting the same keys at once.
 */
export const DESTRUCTION_CLAIM_LEASE_MS = 30 * 60 * 1000;

/** The certificate body version. Bound into the hash. */
export const DESTRUCTION_CERTIFICATE_VERSION =
  "PROOVRA_EVIDENCE_DESTRUCTION_CERT_V2" as const;

/**
 * The storage operations the executor needs, and nothing else.
 *
 * `objectExists` MUST answer from the store, not from a cache and not from the
 * result of the delete that just ran. It is the verification step; an
 * implementation that returns `false` without asking would silently disable the
 * safety property this whole module is built around.
 */
export interface EvidenceDestructionStoragePort {
  deleteObject(input: {
    bucket: string;
    key: string;
  }): Promise<{ ok: boolean; error?: string }>;
  objectExists(input: { bucket: string; key: string }): Promise<boolean>;
}

export type DestructionTrigger =
  | "trash_grace_reconciler"
  | "destruction_review"
  | "destruction_request"
  | "purge_job"
  | "manual";

export interface ExecuteEvidenceDestructionInput {
  evidenceId: string;
  /** Who or what asked. Recorded in the certificate; never used to authorize. */
  trigger: DestructionTrigger;
  actorUserId?: string | null;
  /** The governance record that authorized this, when there is one. */
  destructionReviewId?: string | null;
  destructionRequestId?: string | null;
  /**
   * Whether this record's workspace requires an approved destruction record,
   * and whether one exists. Resolved by the CALLER from its own governance
   * store — the executor never guesses an approval into existence.
   */
  destructionApprovalRequired?: boolean;
  destructionApproved?: boolean;
  /** The effective legal-hold verdict, fail-closed, resolved by the caller. */
  legalHold: boolean;
  now?: Date;
  correlationId?: string | null;
}

export interface DestructionCertificateBody {
  certificateVersion: typeof DESTRUCTION_CERTIFICATE_VERSION;
  evidenceId: string;
  teamId: string | null;
  organizationId: string | null;
  trigger: DestructionTrigger;
  destructionReviewId: string | null;
  destructionRequestId: string | null;
  executedByUserId: string | null;
  destroyedAtUtc: string;
  /** SHA-256 of the sorted storage keys, so the certificate binds WHAT went. */
  destroyedStorageKeysSha256: string;
  destroyedObjectCount: number;
  /** Proof that verification ran, not merely that deletion was requested. */
  storageDeletionVerified: true;
  retentionPolicyVersionId: string | null;
  appRetentionUntilUtc: string | null;
  objectLockRetainUntilUtc: string | null;
}

export type ExecuteEvidenceDestructionResult =
  | {
      ok: true;
      outcome: "DESTROYED";
      certificateHash: string;
      certificate: DestructionCertificateBody;
      destroyedObjectCount: number;
    }
  | {
      ok: true;
      /** Terminal already. Idempotent no-op; no second certificate is minted. */
      outcome: "ALREADY_DESTROYED";
    }
  | {
      ok: false;
      outcome: "BLOCKED";
      /** The canonical reason destruction is not permitted right now. */
      reason: EvidenceLifecycleBlockReason;
    }
  | {
      ok: false;
      outcome: "CLAIM_HELD";
    }
  | {
      ok: false;
      outcome: "NOT_FOUND";
    }
  | {
      ok: false;
      /**
       * Storage refused, or storage still holds an object after the delete.
       * The record is back in TRASHED, unchanged, uncertified.
       */
      outcome: "STORAGE_DELETE_FAILED" | "STORAGE_VERIFY_FAILED";
      failedKeys: string[];
    };

type StorageTarget = { bucket: string; key: string };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const EXECUTOR_SELECT = {
  id: true,
  teamId: true,
  organizationId: true,
  ownerUserId: true,
  lifecycleState: true,
  archivedAt: true,
  deletedAt: true,
  destroyedAtUtc: true,
  lockedAt: true,
  deleteScheduledForUtc: true,
  retentionUntilUtc: true,
  retentionPolicyVersionId: true,
  storageBucket: true,
  storageKey: true,
  storageObjectLockMode: true,
  storageObjectLockRetainUntilUtc: true,
} as const;

/**
 * Destroy ONE evidence record's bytes, then record that it happened.
 *
 * Every caller — the trash-grace reconciler, the destruction-review executor,
 * the Phase-4B request executor and the legacy purge job — routes here. None of
 * them deletes an object or writes DESTROYED on its own any more.
 */
export async function executeEvidenceDestruction(
  prisma: PrismaClient,
  input: ExecuteEvidenceDestructionInput,
  storage: EvidenceDestructionStoragePort,
): Promise<ExecuteEvidenceDestructionResult> {
  const now = input.now ?? new Date();
  const leaseCutoff = new Date(now.getTime() - DESTRUCTION_CLAIM_LEASE_MS);

  const preflight = await prisma.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, lifecycleState: true, destroyedAtUtc: true },
  });
  if (!preflight) return { ok: false, outcome: "NOT_FOUND" };
  if (
    preflight.lifecycleState === "DESTROYED" ||
    preflight.destroyedAtUtc !== null
  ) {
    // Terminal. Returning success without a certificate is deliberate: the
    // certificate for this record already exists, and minting a second one on a
    // redelivered job would put two contradictory-looking attestations of the
    // same event into the ledger.
    return { ok: true, outcome: "ALREADY_DESTROYED" };
  }

  // 1. THE CLAIM. One statement, decided by the database.
  //
  //    A fresh claim requires TRASHED. A takeover requires an EXPIRED
  //    PENDING_DESTRUCTION claim. Both are expressed in the WHERE, so two
  //    executors racing produce exactly one winner and the loser gets count 0.
  const claim = await prisma.evidence.updateMany({
    where: {
      id: input.evidenceId,
      OR: [
        { lifecycleState: "TRASHED" },
        {
          lifecycleState: "PENDING_DESTRUCTION",
          destructionClaimedAtUtc: { lt: leaseCutoff },
        },
        {
          lifecycleState: "PENDING_DESTRUCTION",
          destructionClaimedAtUtc: null,
        },
      ],
    },
    data: {
      lifecycleState: "PENDING_DESTRUCTION",
      destructionClaimedAtUtc: now,
    },
  });
  if (claim.count !== 1) return { ok: false, outcome: "CLAIM_HELD" };

  /** Put the record back where it was. Used on every refusal below. */
  const releaseClaim = async () => {
    await prisma.evidence.updateMany({
      where: { id: input.evidenceId, lifecycleState: "PENDING_DESTRUCTION" },
      data: { lifecycleState: "TRASHED", destructionClaimedAtUtc: null },
    });
  };

  // 2. RELOAD inside the claim.
  const evidence = await prisma.evidence.findUnique({
    where: { id: input.evidenceId },
    select: EXECUTOR_SELECT,
  });
  if (!evidence) {
    return { ok: false, outcome: "NOT_FOUND" };
  }

  // 3. RECOMPUTE against the canonical authority.
  //
  //    `lifecycleState` is PENDING_DESTRUCTION at this point — a
  //    governance-internal posture, not a product state — so the authority
  //    resolves the product state from the lifecycle event timestamps and sees
  //    TRASHED, which is exactly what it must see to consider destruction at
  //    all. Nothing here re-implements a boundary; every one of them (trash
  //    grace, application retention, Object Lock, legal hold, approval,
  //    permanent lock) is the authority's answer.
  const eligibility = computeEvidenceDestructionEligibility(
    {
      lifecycleState: evidence.lifecycleState,
      archivedAt: evidence.archivedAt,
      trashedAt: evidence.deletedAt,
      destroyedAt: evidence.destroyedAtUtc,
      lockedAt: evidence.lockedAt,
      trashGraceUntil: evidence.deleteScheduledForUtc,
      appRetentionUntil: evidence.retentionUntilUtc,
      objectLockRetainUntil: evidence.storageObjectLockRetainUntilUtc,
      objectLockMode: evidence.storageObjectLockMode,
      legalHold: input.legalHold,
      destructionApprovalRequired: input.destructionApprovalRequired ?? false,
      destructionApproved: input.destructionApproved ?? false,
    },
    now,
  );

  // 4. FAIL CLOSED.
  if (!eligibility.eligible) {
    await releaseClaim();
    return {
      ok: false,
      outcome: "BLOCKED",
      reason: eligibility.blockReason ?? "NOT_TRASHED",
    };
  }

  // 5. ENUMERATE. Everything the Evidence record owns bytes for.
  const targets = await enumerateStorageTargets(prisma, evidence.id, evidence);

  // 6. DELETE.
  const deleteFailures: string[] = [];
  for (const target of targets) {
    const res = await storage.deleteObject(target);
    if (!res.ok) deleteFailures.push(target.key);
  }
  if (deleteFailures.length > 0) {
    await releaseClaim();
    return {
      ok: false,
      outcome: "STORAGE_DELETE_FAILED",
      failedKeys: deleteFailures.slice(0, 50),
    };
  }

  // 7. VERIFY. The step whose absence produced certificates for evidence that
  //    was never deleted.
  //
  //    A storage error during verification counts as "still there". The
  //    conservative reading is the only safe one: we are about to sign a
  //    statement that these bytes are gone, and "I could not check" is not
  //    evidence that they are.
  const survivors: string[] = [];
  for (const target of targets) {
    let stillThere = true;
    try {
      stillThere = await storage.objectExists(target);
    } catch {
      stillThere = true;
    }
    if (stillThere) survivors.push(target.key);
  }
  if (survivors.length > 0) {
    await releaseClaim();
    return {
      ok: false,
      outcome: "STORAGE_VERIFY_FAILED",
      failedKeys: survivors.slice(0, 50),
    };
  }

  // 8. TOMBSTONE + CERTIFICATE. Only reachable from a verified deletion.
  const certificate: DestructionCertificateBody = {
    certificateVersion: DESTRUCTION_CERTIFICATE_VERSION,
    evidenceId: evidence.id,
    teamId: evidence.teamId ?? null,
    organizationId: evidence.organizationId ?? null,
    trigger: input.trigger,
    destructionReviewId: input.destructionReviewId ?? null,
    destructionRequestId: input.destructionRequestId ?? null,
    executedByUserId: input.actorUserId ?? null,
    destroyedAtUtc: now.toISOString(),
    destroyedStorageKeysSha256: sha256Hex(
      targets
        .map((t) => `${t.bucket}/${t.key}`)
        .sort()
        .join("\n"),
    ),
    destroyedObjectCount: targets.length,
    storageDeletionVerified: true,
    retentionPolicyVersionId: evidence.retentionPolicyVersionId ?? null,
    appRetentionUntilUtc: evidence.retentionUntilUtc?.toISOString() ?? null,
    objectLockRetainUntilUtc:
      evidence.storageObjectLockRetainUntilUtc?.toISOString() ?? null,
  };
  const certificateHash = sha256Hex(canonicalJsonValue(certificate));

  await prisma.$transaction(async (tx) => {
    // The custody event goes FIRST, while the child rows it may reference
    // still exist, and it is never deleted — the chain is the tombstone's
    // whole point.
    await appendCustodyEventInTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EVIDENCE_PURGED,
      atUtc: now,
      payload: {
        destroyedAtUtc: now.toISOString(),
        trashedAtUtc: evidence.deletedAt?.toISOString() ?? null,
        destroyedObjectCount: targets.length,
        certificateHash,
        certificateVersion: DESTRUCTION_CERTIFICATE_VERSION,
        trigger: input.trigger,
        storageDeletionVerified: true,
      },
    });

    // Content-bearing children. Their objects are gone and verified gone, so
    // the rows address nothing.
    await tx.verificationView.deleteMany({ where: { evidenceId: evidence.id } });
    await tx.verificationPackage.deleteMany({
      where: { evidenceId: evidence.id },
    });
    await tx.report.deleteMany({ where: { evidenceId: evidence.id } });
    await tx.evidencePart.deleteMany({ where: { evidenceId: evidence.id } });

    // The tombstone. The row stays; the content pointers do not.
    await tx.evidence.update({
      where: { id: evidence.id },
      data: {
        lifecycleState: "DESTROYED",
        destroyedAtUtc: now,
        destructionClaimedAtUtc: null,
        storageBucket: null,
        storageKey: null,
        sizeBytes: BigInt(0),
        activeDestructionReviewId: null,
      },
    });

    // The governance ledger row IS the per-evidence destruction certificate.
    // One row, one hash, minted here and nowhere else.
    if (evidence.teamId) {
      await tx.evidenceLifecycleEvent.create({
        data: {
          teamId: evidence.teamId,
          evidenceId: evidence.id,
          fromState: "PENDING_DESTRUCTION",
          toState: "DESTROYED",
          eventType: "destruction_executed",
          summary:
            "Evidence physically destroyed; storage deletion verified before tombstone",
          metadata: {
            certificateHash,
            certificate,
            correlationId: input.correlationId ?? null,
          } as unknown as prismaPkg.Prisma.InputJsonValue,
          actorUserId: input.actorUserId ?? undefined,
          requestId: input.correlationId?.slice(0, 64) ?? null,
        },
      });
    }
  });

  return {
    ok: true,
    outcome: "DESTROYED",
    certificateHash,
    certificate,
    destroyedObjectCount: targets.length,
  };
}

/**
 * Every object the Evidence record owns: its own payload, its parts, its
 * generated reports, its verification packages, and any READY redaction
 * derivative produced from it.
 *
 * Redaction derivatives are included because they are copies of the evidence
 * content by construction. The old purge worker did not delete them, so a
 * "purged" record could leave a fully readable redacted rendering behind.
 */
async function enumerateStorageTargets(
  prisma: PrismaClient,
  evidenceId: string,
  evidence: { storageBucket: string | null; storageKey: string | null },
): Promise<StorageTarget[]> {
  const [parts, reports, packages, derivatives] = await Promise.all([
    prisma.evidencePart.findMany({
      where: { evidenceId },
      select: { storageBucket: true, storageKey: true },
    }),
    prisma.report.findMany({
      where: { evidenceId },
      select: { storageBucket: true, storageKey: true },
    }),
    prisma.verificationPackage.findMany({
      where: { evidenceId },
      select: { storageBucket: true, storageKey: true },
    }),
    prisma.redactionDerivative.findMany({
      where: { version: { project: { evidenceId } } },
      select: { storageBucket: true, storageKey: true },
    }),
  ]);

  const all: Array<{ bucket: string | null; key: string | null }> = [
    { bucket: evidence.storageBucket, key: evidence.storageKey },
    ...[...parts, ...reports, ...packages, ...derivatives].map((row) => ({
      bucket: row.storageBucket,
      key: row.storageKey,
    })),
  ];

  const seen = new Set<string>();
  const targets: StorageTarget[] = [];
  for (const row of all) {
    if (!row.bucket || !row.key) continue;
    const id = `${row.bucket} ${row.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({ bucket: row.bucket, key: row.key });
  }
  return targets;
}

/**
 * Custody append, inside the caller's transaction.
 *
 * Duplicated shape rather than duplicated decision: the hash is computed by the
 * ONE `buildCustodyEventHash` in `@proovra/shared`, so this cannot produce a
 * chain that disagrees with the API's or the worker's appender. It lives here
 * because both hosts' appenders are in their own service trees and this package
 * cannot import either.
 */
async function appendCustodyEventInTx(
  tx: prismaPkg.Prisma.TransactionClient,
  params: {
    evidenceId: string;
    eventType: prismaPkg.CustodyEventType;
    atUtc: Date;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))`;

  const last = await tx.custodyEvent.findFirst({
    where: { evidenceId: params.evidenceId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });
  const sequence = (last?.sequence ?? 0) + 1;
  const prevEventHash = last?.eventHash ?? null;
  const payload = params.payload as prismaPkg.Prisma.InputJsonValue;

  const eventHash = buildCustodyEventHash({
    evidenceId: params.evidenceId,
    sequence,
    eventType: params.eventType,
    atUtc: params.atUtc,
    payload: payload as never,
    prevEventHash,
  });

  await tx.custodyEvent.create({
    data: {
      evidenceId: params.evidenceId,
      eventType: params.eventType,
      atUtc: params.atUtc,
      sequence,
      payload,
      prevEventHash,
      eventHash,
    },
  });
}

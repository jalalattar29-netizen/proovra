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

/**
 * The certificate body version. Bound into the hash.
 *
 * V3 (2026-09-29): a certificate is minted only after EVERY VERSION of every
 * object is verified absent. V2 certificates were minted after a key-level
 * delete and a key-level HEAD, which a versioned (Object Lock) bucket answers
 * with 404 while locked versions remain; see
 * services/api/src/scripts/destruction-certificate-audit.ts for the read-only
 * inventory of V2 certificates that may be inaccurate.
 */
export const DESTRUCTION_CERTIFICATE_VERSION =
  "PROOVRA_EVIDENCE_DESTRUCTION_CERT_V3" as const;

/**
 * The storage operations the executor needs, and nothing else.
 *
 * `objectExists` MUST answer from the store, not from a cache and not from the
 * result of the delete that just ran. It is the verification step; an
 * implementation that returns `false` without asking would silently disable the
 * safety property this whole module is built around.
 */
export interface EvidenceDestructionStoragePort {
  /**
   * Every version and delete marker of EXACTLY this key, answered by the
   * store, with each data version's retention read by VersionId. MUST throw
   * rather than return a partial list.
   */
  listObjectVersions(input: { bucket: string; key: string }): Promise<ObjectVersionInfo[]>;
  /** Delete ONE version by its VersionId ("null" for an unversioned object). */
  deleteObjectVersion(input: {
    bucket: string;
    key: string;
    versionId: string;
  }): Promise<{ ok: boolean; error?: string }>;
  /**
   * (2026-09-29, audit H2) Every distinct KEY under a prefix that still has any
   * version or delete marker, answered by the store. Optional so an older port
   * keeps working; without it the inventory is row-based only. MUST throw
   * rather than return a partial list.
   */
  listKeysUnderPrefix?(input: { bucket: string; prefix: string }): Promise<string[]>;
}

/**
 * THE OBJECT PREFIXES A RECORD OWNS (2026-09-29, audit H2/M5) — one list, for
 * the executor and the certificate audit alike. Every object under these is
 * this record's content or derived from it, whether or not a row still points
 * at it: package staging residue, the immutable orphan a lost publication race
 * leaves behind, superseded derived renditions.
 */
export function evidenceOwnedStoragePrefixes(evidenceId: string): string[] {
  return [
    `evidence/${evidenceId}/`,
    `reports/${evidenceId}/`,
    `verification/${evidenceId}/`,
    `internal/package-staging/${evidenceId}/`,
    `derived-assets/${evidenceId}/`,
  ];
}

export type ObjectVersionInfo = {
  versionId: string;
  isDeleteMarker: boolean;
  isLatest: boolean;
  retainUntil: Date | null;
  lockMode: string | null;
  legalHold: boolean;
};

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
  /** Object VERSIONS deleted (data versions + delete markers). */
  destroyedVersionCount: number;
  /**
   * Proof that verification ran, not merely that deletion was requested — and
   * what was verified: no version of any object remains.
   */
  storageDeletionVerified: true;
  verification: "ALL_OBJECT_VERSIONS_ABSENT";
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
      /**
       * Set when stored object VERSIONS are still under Object Lock retention
       * or legal hold: the earliest moment every retained version could be
       * deleted (null for a legal hold, which has no date).
       */
      retainedUntilUtc?: string | null;
      retainedObjectCount?: number;
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
        // COMPATIBILITY, and it is load-bearing during a rolling deploy: a
        // record trashed by a build that predates the state pointer carries
        // `deleted_at` and a `lifecycle_state` that never caught up. Requiring
        // the pointer alone would leave those records permanently unclaimable —
        // eligible by every boundary, invisible to the one thing that could act
        // on them. The canonical authority already resolves such a row as
        // TRASHED (its fail-safe fallthrough); the claim now agrees with it.
        {
          deletedAt: { not: null },
          lifecycleState: { notIn: ["DESTROYED", "PENDING_DESTRUCTION"] },
        },
        // A governance record approved for destruction, whose previous claim
        // expired or was never stamped.
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

  /**
   * Put the record back where it was — WHERE IT WAS, not where the ordinary
   * path would have found it.
   *
   * This used to restore TRASHED unconditionally, which is right for the trash
   * path and wrong for the governance one: a record approved for destruction
   * that had never been in anybody's trash would have been released INTO the
   * trash by a failed attempt, where an ordinary user could then restore it.
   * A refusal must leave the record exactly as it found it.
   */
  const priorState = preflight.lifecycleState;
  const releaseClaim = async () => {
    await prisma.evidence.updateMany({
      where: { id: input.evidenceId, lifecycleState: "PENDING_DESTRUCTION" },
      data: { lifecycleState: priorState, destructionClaimedAtUtc: null },
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
  const targets = await enumerateStorageTargets(prisma, evidence.id, evidence, storage);

  // 5b. INVENTORY every VERSION before touching anything.
  //
  //    A version under Object Lock retention or legal hold cannot be deleted,
  //    and deleting everything ELSE first would leave a record half destroyed
  //    with no certificate. So retention is decided up front, over every
  //    version of every object — not just the evidence object's own date — and
  //    a single retained version blocks the whole destruction until it lapses.
  const inventory = new Map<string, ObjectVersionInfo[]>();
  try {
    for (const target of targets) {
      inventory.set(`${target.bucket} ${target.key}`, await storage.listObjectVersions(target));
    }
  } catch {
    await releaseClaim();
    return {
      ok: false,
      outcome: "STORAGE_VERIFY_FAILED",
      failedKeys: targets.map((t) => t.key).slice(0, 50),
    };
  }
  let retainedUntilMs: number | null = null;
  let retainedObjectCount = 0;
  let legalHoldVersion = false;
  for (const versions of inventory.values()) {
    for (const v of versions) {
      if (v.isDeleteMarker) continue;
      const held = v.legalHold;
      const retained = v.retainUntil !== null && v.retainUntil.getTime() > now.getTime();
      if (held || retained) {
        retainedObjectCount++;
        if (held) legalHoldVersion = true;
        if (retained) {
          retainedUntilMs = Math.max(retainedUntilMs ?? 0, v.retainUntil!.getTime());
        }
      }
    }
  }
  if (retainedObjectCount > 0) {
    await releaseClaim();
    return {
      ok: false,
      outcome: "BLOCKED",
      reason: legalHoldVersion ? "LEGAL_HOLD_ACTIVE" : "OBJECT_LOCK_RETENTION_ACTIVE",
      retainedUntilUtc:
        legalHoldVersion || retainedUntilMs === null
          ? null
          : new Date(retainedUntilMs).toISOString(),
      retainedObjectCount,
    } as ExecuteEvidenceDestructionResult;
  }

  // 6. DELETE every version (data versions AND delete markers) by VersionId.
  const deleteFailures: string[] = [];
  let destroyedVersionCount = 0;
  for (const target of targets) {
    for (const v of inventory.get(`${target.bucket} ${target.key}`) ?? []) {
      const res = await storage.deleteObjectVersion({ ...target, versionId: v.versionId });
      if (res.ok) destroyedVersionCount++;
      else deleteFailures.push(`${target.key}@${v.versionId}`);
    }
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
  //    was never deleted — and, until 2026-09-29, a step that asked the wrong
  //    question: a HEAD by key sees a delete marker as absence. It now asks for
  //    every VERSION of every key, and any surviving version (or any error)
  //    refuses the certificate.
  const survivors: string[] = [];
  for (const target of targets) {
    try {
      const remaining = await storage.listObjectVersions(target);
      if (remaining.some((v) => !v.isDeleteMarker)) survivors.push(target.key);
    } catch {
      survivors.push(target.key);
    }
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
    destroyedVersionCount,
    storageDeletionVerified: true,
    verification: "ALL_OBJECT_VERSIONS_ABSENT",
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
        destroyedVersionCount,
        verification: "ALL_OBJECT_VERSIONS_ABSENT",
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

    // (2026-09-29, audit H2) SIU export bundles of this record's cases carried
    // its report and package; their objects are gone and verified gone, so
    // the rows point at nothing and say so.
    await tx.caseSiuExport.updateMany({
      where: {
        caseId: { in: (
          await tx.caseEvidenceLink.findMany({ where: { evidenceId: evidence.id }, select: { caseId: true } })
        ).map((l) => l.caseId) },
        artifactStorageKey: { not: null },
      },
      data: { artifactStorageKey: null, exportStatus: "destroyed" },
    });

    // UC-0 (P0-7) — everything PROOVRA DERIVED from the content. These tables
    // have no foreign key to the tombstone (or cascade only on a row delete the
    // tombstone never performs), so without this they outlived destruction:
    // thumbnails/frames/proxies (objects already deleted above), OCR and
    // transcript text, extracted text, semantic chunks, and the search
    // documents that index that text.
    await tx.evidencePartDerivedAsset.deleteMany({
      where: { evidenceId: evidence.id },
    });
    await tx.evidenceOcrText.deleteMany({ where: { evidenceId: evidence.id } });
    await tx.evidenceTranscriptSegment.deleteMany({
      where: { evidenceId: evidence.id },
    });
    await tx.evidenceExtractedText.deleteMany({
      where: { evidenceId: evidence.id },
    });
    await tx.evidenceSemanticChunk.deleteMany({
      where: { evidenceId: evidence.id },
    });
    await tx.evidenceSearchDocument.deleteMany({
      where: { evidenceId: evidence.id },
    });

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

    // The governance ledger row IS the per-evidence destruction certificate for
    // a WORKSPACE record. One row, one hash, minted here and nowhere else.
    //
    // A PERSONAL record has no workspace governance to report to, and
    // `EvidenceLifecycleEvent` is workspace-scoped by schema, so it earns no
    // ledger row. Its attestation is the custody event written above, which
    // carries the same certificate hash and exists for every scope. Nothing is
    // silently unattested; the two scopes attest in the place each one has.
    if (evidence.teamId) {
      await tx.evidenceLifecycleEvent.create({
        data: {
          teamId: evidence.teamId,
          evidenceId: evidence.id,
          fromState: "PENDING_DESTRUCTION",
          toState: "DESTROYED",
          eventType: "destruction_executed",
          summary:
            "Evidence physically destroyed; every object version verified absent before tombstone",
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
 *
 * UC-0 (P0-7) — part-level derived assets (thumbnails, frames, waveforms,
 * proxies) are included for the same reason. Every row with a storage pointer
 * is enumerated regardless of status: a FAILED regeneration keeps the pointer
 * of the bytes that still exist.
 */
async function enumerateStorageTargets(
  prisma: PrismaClient,
  evidenceId: string,
  evidence: { storageBucket: string | null; storageKey: string | null },
  storage?: EvidenceDestructionStoragePort,
): Promise<StorageTarget[]> {
  const caseIds = (
    await prisma.caseEvidenceLink.findMany({ where: { evidenceId }, select: { caseId: true } })
  ).map((l) => l.caseId);
  const [parts, reports, packages, derivatives, derivedAssets, siuExports] = await Promise.all([
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
    prisma.evidencePartDerivedAsset.findMany({
      where: { evidenceId, storageKey: { not: null } },
      select: { storageBucket: true, storageKey: true },
    }),
    // (2026-09-29, audit H2) An SIU export bundle of any case this record is
    // linked to carries its report and verification package.
    caseIds.length
      ? prisma.caseSiuExport.findMany({
          where: { caseId: { in: caseIds }, artifactStorageKey: { not: null } },
          select: { artifactStorageBucket: true, artifactStorageKey: true },
        })
      : Promise.resolve([] as Array<{ artifactStorageBucket: string | null; artifactStorageKey: string | null }>),
  ]);

  const all: Array<{ bucket: string | null; key: string | null }> = [
    { bucket: evidence.storageBucket, key: evidence.storageKey },
    ...[...parts, ...reports, ...packages, ...derivatives, ...derivedAssets].map((row) => ({
      bucket: row.storageBucket,
      key: row.storageKey,
    })),
    ...siuExports.map((row) => ({ bucket: row.artifactStorageBucket, key: row.artifactStorageKey })),
  ];

  /*
   * (2026-09-29, audit H2) EVERY OBJECT UNDER THE RECORD'S OWN PREFIXES, not
   * only those a row still points at: package staging residue, the immutable
   * orphan of a lost publication race, superseded derived renditions. Listed
   * in every bucket the record's rows use.
   */
  if (storage?.listKeysUnderPrefix) {
    const buckets = new Set(all.map((r) => r.bucket).filter((b): b is string => !!b));
    for (const bucket of buckets) {
      for (const prefix of evidenceOwnedStoragePrefixes(evidenceId)) {
        for (const key of await storage.listKeysUnderPrefix({ bucket, prefix })) {
          all.push({ bucket, key });
        }
      }
    }
  }

  const seen = new Set<string>();
  const targets: StorageTarget[] = [];
  for (const row of all) {
    if (!row.bucket || !row.key) continue;
    // A space is an unambiguous separator: S3 bucket names are restricted to
    // lowercase letters, digits, dots and hyphens, so one cannot contain a
    // space and `bucket key` cannot collide with a different pair.
    const id = `${row.bucket} ${row.key}`;
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

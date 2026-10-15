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
import { canonicalJsonValue } from "@proovra/shared/custody-hash";
import { appendCustodyEventTx } from "../custody/custody-chain.js";
import { evaluateEffectiveLegalHold } from "../governance/effective-legal-hold.js";
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
  /**
   * RETENTION ARCHIVE (owner decision 2026-10-14) — whether this deployment
   * writes Object Lock retention. When true, a REQUIRED object whose current
   * version carries no retain-until is missing metadata and blocks destruction
   * (fail closed). Read by the host from its own configuration.
   */
  objectLockExpected?: boolean;
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

type StorageTarget = { bucket: string; key: string; required?: boolean };

/**
 * RETENTION ARCHIVE (owner decision 2026-10-14) — THE STORAGE-TRUTH READING of
 * a record's retention, read-only. Uses exactly the executor's own target
 * enumeration and version listing, so the reconciler's archive/purge decision
 * and the executor's final refusal can never read different objects.
 *
 *   latestRequiredRetainUntil  max retain-until over every DATA version of
 *                              every target (originals, parts, every report,
 *                              every package, derived assets, residue)
 *   legalHoldVersion           any version under an S3 legal hold
 *   truth                      VERIFIED, or why the reading cannot be trusted:
 *     UNAVAILABLE   any listing threw (a partial listing is never permission)
 *     MISSING       Object Lock is expected and a REQUIRED object (one a row
 *                   points at) has a current data version with no retain-until
 *     INCONSISTENT  storage reports an earlier retain-until than PROOVRA
 *                   recorded for that row, or the record's signed original has
 *                   a newer data version than the one recorded and signed
 */
export type RequiredObjectRetentionReading = {
  truth: "VERIFIED" | "MISSING" | "INCONSISTENT" | "UNAVAILABLE";
  latestRequiredRetainUntil: Date | null;
  legalHoldVersion: boolean;
  objectCount: number;
  /** Bounded detail for an operational condition. Never a storage key. */
  detail: string | null;
  /**
   * The Object Lock modes storage reports across the data versions read, as
   * stored (e.g. ["COMPLIANCE"]) — never inferred from configuration.
   */
  lockModes?: string[];
};

export async function readRequiredObjectRetention(
  prisma: PrismaClient,
  evidenceId: string,
  storage: EvidenceDestructionStoragePort,
  options: { objectLockExpected: boolean; now?: Date },
): Promise<RequiredObjectRetentionReading> {
  const nowMs = (options.now ?? new Date()).getTime();
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      storageBucket: true,
      storageKey: true,
      storageVersionId: true,
      storageObjectLockRetainUntilUtc: true,
    },
  });
  if (!evidence) {
    return { truth: "UNAVAILABLE", latestRequiredRetainUntil: null, legalHoldVersion: false, objectCount: 0, detail: "EVIDENCE_NOT_FOUND" };
  }
  let targets: StorageTarget[];
  try {
    targets = await enumerateStorageTargets(prisma, evidenceId, evidence, storage);
  } catch {
    return { truth: "UNAVAILABLE", latestRequiredRetainUntil: null, legalHoldVersion: false, objectCount: 0, detail: "TARGET_LISTING_FAILED" };
  }
  // What PROOVRA recorded per row, so a storage reading can never shorten it.
  const [parts, reports, packages] = await Promise.all([
    prisma.evidencePart.findMany({
      where: { evidenceId },
      select: { storageKey: true, storageVersionId: true, storageObjectLockRetainUntilUtc: true },
    }),
    prisma.report.findMany({
      where: { evidenceId },
      select: { storageKey: true, storageObjectLockRetainUntilUtc: true },
    }),
    prisma.verificationPackage.findMany({
      where: { evidenceId },
      select: { storageKey: true, storageObjectLockRetainUntilUtc: true },
    }),
  ]);
  const recordedUntil = new Map<string, number>();
  const signedVersion = new Map<string, string>();
  const note = (key: string | null, until: Date | null, version?: string | null) => {
    if (!key) return;
    if (until) recordedUntil.set(key, Math.max(recordedUntil.get(key) ?? 0, until.getTime()));
    if (version) signedVersion.set(key, version);
  };
  note(evidence.storageKey, evidence.storageObjectLockRetainUntilUtc, evidence.storageVersionId);
  for (const r of parts) note(r.storageKey, r.storageObjectLockRetainUntilUtc, r.storageVersionId);
  for (const r of [...reports, ...packages]) note(r.storageKey, r.storageObjectLockRetainUntilUtc);

  let latest: number | null = null;
  const lockModes = new Set<string>();
  let legalHoldVersion = false;
  let truth: RequiredObjectRetentionReading["truth"] = "VERIFIED";
  let detail: string | null = null;
  for (const target of targets) {
    let versions: ObjectVersionInfo[];
    try {
      versions = await storage.listObjectVersions(target);
    } catch {
      return { truth: "UNAVAILABLE", latestRequiredRetainUntil: null, legalHoldVersion: false, objectCount: targets.length, detail: "VERSION_LISTING_FAILED" };
    }
    const data = versions.filter((v) => !v.isDeleteMarker);
    let keyLatest: number | null = null;
    for (const v of data) {
      if (v.legalHold) legalHoldVersion = true;
      if (v.lockMode) lockModes.add(String(v.lockMode).toUpperCase());
      if (v.retainUntil) {
        keyLatest = Math.max(keyLatest ?? 0, v.retainUntil.getTime());
        latest = Math.max(latest ?? 0, v.retainUntil.getTime());
      }
    }
    if (!target.required) continue;
    if (data.length === 0) continue; // a missing object is the restore check's concern, not a retention barrier
    const current = data.find((v) => v.isLatest) ?? data[0];
    if (options.objectLockExpected && current && current.retainUntil === null && truth === "VERIFIED") {
      truth = "MISSING";
      detail = "REQUIRED_VERSION_WITHOUT_RETENTION";
    }
    // Only a recorded retention STILL IN FORCE can be shortened by a storage
    // answer; one that has already passed protects nothing either way.
    const recorded = recordedUntil.get(target.key);
    if (recorded !== undefined && recorded > nowMs && (keyLatest === null || keyLatest < recorded)) {
      truth = "INCONSISTENT";
      detail = "STORAGE_RETENTION_EARLIER_THAN_RECORDED";
    }
    const signed = signedVersion.get(target.key);
    if (signed && current && current.versionId !== signed && data.some((v) => v.versionId === signed)) {
      truth = "INCONSISTENT";
      detail = "NEWER_DATA_VERSION_THAN_SIGNED";
    }
  }
  return {
    truth,
    latestRequiredRetainUntil: latest === null ? null : new Date(latest),
    legalHoldVersion,
    objectCount: targets.length,
    detail,
    lockModes: [...lockModes].sort(),
  };
}

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

  const priorState = preflight.lifecycleState;

  // 0. THE STORAGE-TRUTH READING (owner decision 2026-10-14). Object-version
  //    retain-until read from storage is the authority, not a column. It is
  //    read before the claim (storage round-trips do not belong inside the
  //    decision transaction) and enters the decision below as an input: a
  //    later report, package or proof with a later retain-until extends the
  //    boundary, and a missing, inconsistent or failed reading refuses.
  const retentionReading = await readRequiredObjectRetention(prisma, input.evidenceId, storage, {
    objectLockExpected: input.objectLockExpected === true,
    now,
  });

  // 1–4. THE DECISION — one transaction under the evidence lock.
  //
  //    ET-SEC-01 (Invariant E, legal hold wins). The claim, the reload, the
  //    legal-hold re-read and the eligibility recompute happen in ONE
  //    transaction holding pg_advisory_xact_lock(hashtext(evidenceId)) — the
  //    same lock evidence-scope hold placement takes. The caller's
  //    `input.legalHold` is a pre-check only: the holds are re-read HERE, through
  //    the one union evaluator, and a failure to read them is a hold (fail
  //    closed). A refusal rolls the claim back atomically, so PENDING_DESTRUCTION
  //    with a claim stamp now means exactly "decided with no hold in force".
  class DecisionRefused extends Error {
    constructor(readonly result: ExecuteEvidenceDestructionResult) {
      super("destruction decision refused");
    }
  }
  let evidence: Awaited<ReturnType<typeof loadForDecision>>;
  async function loadForDecision(tx: PrismaClient) {
    return tx.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { ...EXECUTOR_SELECT, caseLinks: { select: { caseId: true } } },
    });
  }
  try {
    evidence = await prisma.$transaction(async (txClient) => {
      const tx = txClient as unknown as PrismaClient;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.evidenceId}))`;

      // THE CLAIM. A fresh claim requires TRASHED. A takeover requires an
      // EXPIRED PENDING_DESTRUCTION claim. Both are expressed in the WHERE, so
      // two executors racing produce exactly one winner.
      const claim = await tx.evidence.updateMany({
        where: {
          id: input.evidenceId,
          OR: [
            { lifecycleState: "TRASHED" },
            // RETENTION ARCHIVE (owner decision 2026-10-14) — a record that left
            // the Trash for the archive; eligible only once every barrier ended,
            // which the recompute below decides.
            { lifecycleState: "RETENTION_ARCHIVED" },
            // COMPATIBILITY, and it is load-bearing during a rolling deploy: a
            // record trashed by a build that predates the state pointer carries
            // `deleted_at` and a `lifecycle_state` that never caught up. The
            // canonical authority already resolves such a row as TRASHED.
            {
              deletedAt: { not: null },
              lifecycleState: { notIn: ["DESTROYED", "PENDING_DESTRUCTION"] },
            },
            // A governance record approved for destruction, whose previous claim
            // expired or was never stamped.
            { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: { lt: leaseCutoff } },
            { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: null },
          ],
        },
        data: { lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: now },
      });
      if (claim.count !== 1) throw new DecisionRefused({ ok: false, outcome: "CLAIM_HELD" });

      const row = await loadForDecision(tx);
      if (!row) throw new DecisionRefused({ ok: false, outcome: "NOT_FOUND" });

      let heldNow = true;
      try {
        const held = await evaluateEffectiveLegalHold(tx, {
          teamId: row.teamId,
          evidenceId: row.id,
          caseIds: row.caseLinks.map((l) => l.caseId),
        });
        heldNow = held.held;
      } catch {
        // Hold truth cannot be established — that is a hold.
        heldNow = true;
      }

      // RECOMPUTE against the canonical authority. `lifecycleState` is
      // PENDING_DESTRUCTION here — a governance-internal posture — so the
      // authority resolves the product state from the lifecycle timestamps and
      // sees TRASHED. Every boundary (trash grace, application retention, Object
      // Lock, legal hold, approval, permanent lock) is the authority's answer.
      // RETENTION ARCHIVE — restore and purge must never both succeed: an
      // open archive-restore request blocks the purge (and the restore
      // workflow refuses a record under a destruction claim).
      const openRestores = await tx.evidenceArchiveRestoreRequest.count({
        where: { evidenceId: row.id, status: { in: ["REQUESTED", "RUNNING"] } },
      });
      const eligibility = computeEvidenceDestructionEligibility(
        {
          // The authority reads the state the record was CLAIMED from: the
          // claim wrote PENDING_DESTRUCTION, which it accepts on its own.
          archiveRestoreInProgress: openRestores > 0,
          requiredObjectRetainUntil: retentionReading.latestRequiredRetainUntil,
          storageRetentionTruth: retentionReading.truth,
          lifecycleState: row.lifecycleState,
          archivedAt: row.archivedAt,
          trashedAt: row.deletedAt,
          destroyedAt: row.destroyedAtUtc,
          lockedAt: row.lockedAt,
          trashGraceUntil: row.deleteScheduledForUtc,
          appRetentionUntil: row.retentionUntilUtc,
          objectLockRetainUntil: row.storageObjectLockRetainUntilUtc,
          objectLockMode: row.storageObjectLockMode,
          legalHold: input.legalHold || heldNow || retentionReading.legalHoldVersion,
          destructionApprovalRequired: input.destructionApprovalRequired ?? false,
          destructionApproved: input.destructionApproved ?? false,
        },
        now,
      );
      if (!eligibility.eligible) {
        throw new DecisionRefused({
          ok: false,
          outcome: "BLOCKED",
          reason: eligibility.blockReason ?? "NOT_TRASHED",
        });
      }
      return row;
    });
  } catch (err) {
    if (err instanceof DecisionRefused) return err.result;
    throw err;
  }
  if (!evidence) return { ok: false, outcome: "NOT_FOUND" };

  /**
   * Put the record back where it was — WHERE IT WAS, not where the ordinary
   * path would have found it. A refusal after the decision (storage-side) must
   * leave the record exactly as it found it.
   */
  const releaseClaim = async () => {
    await prisma.evidence.updateMany({
      where: { id: input.evidenceId, lifecycleState: "PENDING_DESTRUCTION" },
      data: { lifecycleState: priorState, destructionClaimedAtUtc: null },
    });
  };

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
    await appendCustodyEventTx(tx, {
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
    // ET-SEC-12 — the tombstone is written only over THIS executor's own
    // decided claim. Any other state (a claim lost to a takeover, a record moved
    // underneath us) rolls the whole transaction back rather than writing
    // DESTROYED over it.
    const tombstoned = await tx.evidence.updateMany({
      where: { id: evidence.id, lifecycleState: "PENDING_DESTRUCTION", destructionClaimedAtUtc: now },
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
    if (tombstoned.count !== 1) {
      throw new Error("destruction tombstone refused: the decided claim is no longer held by this executor");
    }

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

  const all: Array<{ bucket: string | null; key: string | null; required?: boolean }> = [
    { bucket: evidence.storageBucket, key: evidence.storageKey, required: true },
    ...[...parts, ...reports, ...packages].map((row) => ({
      bucket: row.storageBucket,
      key: row.storageKey,
      required: true,
    })),
    ...[...derivatives, ...derivedAssets].map((row) => ({
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
    targets.push({ bucket: row.bucket, key: row.key, required: row.required === true });
  }
  return targets;
}


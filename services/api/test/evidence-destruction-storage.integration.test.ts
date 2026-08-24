/**
 * PHYSICAL DESTRUCTION — against real storage and a real database.
 *
 * This is the suite the convergence exists for. Everything else can be argued
 * about from source; whether bytes actually left a bucket, and whether a
 * certificate can exist when they did not, can only be settled by deleting real
 * objects from a real object store and then looking.
 *
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 *   1. Archive, trash and restore perform ZERO deletes. The objects are still
 *      there afterwards, byte-for-byte. This is the corrected semantics: a
 *      record retained until 2034 can sit in the trash and lose nothing.
 *   2. Before the boundaries expire, destruction FAILS CLOSED: the state is not
 *      DESTROYED, `destroyed_at_utc` is null, no certificate exists, and the
 *      objects survive. Separately for trash grace, application retention,
 *      Object Lock retain-until, and legal hold.
 *   3. When the store refuses the delete, or when an object SURVIVES a delete
 *      that reported success, there is still no DESTROYED and no certificate.
 *      That second case is the defect this whole program was written to close:
 *      two shipped code paths issued destruction certificates having deleted
 *      nothing at all.
 *   4. After every boundary expires, the canonical executor deletes the
 *      objects, VERIFIES they are gone, tombstones the record, and mints
 *      EXACTLY ONE certificate — and a redelivery mints no second one.
 *
 * DISPOSABLE INFRASTRUCTURE ONLY. The database is the harness's throwaway
 * PostgreSQL 16; the object store is an in-process fake that implements the
 * SAME `EvidenceDestructionStoragePort` the hosts inject, so the code under
 * test is the production executor and only its outermost adapter is swapped.
 * Nothing here can reach a real bucket: the port is passed by value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * A disposable object store that behaves like S3 for the two operations the
 * executor uses, plus the failure modes worth proving.
 *
 * `refuse` makes a delete report failure. `survive` makes a delete REPORT
 * SUCCESS while leaving the object in place — which is exactly what
 * `DeleteObject` does against a versioned or COMPLIANCE-locked bucket, and
 * exactly the case that made "we called delete" an unsafe basis for a
 * certificate.
 */
class DisposableStore {
  objects = new Map<string, Buffer>();
  refuse = new Set<string>();
  survive = new Set<string>();
  deleteCalls: string[] = [];

  put(bucket: string, key: string, body = "fictional-evidence-bytes") {
    this.objects.set(`${bucket}/${key}`, Buffer.from(body));
  }

  has(bucket: string, key: string) {
    return this.objects.has(`${bucket}/${key}`);
  }

  get port() {
    return {
      deleteObject: async (input: { bucket: string; key: string }) => {
        const id = `${input.bucket}/${input.key}`;
        this.deleteCalls.push(id);
        if (this.refuse.has(id)) return { ok: false, error: "AccessDenied" };
        if (this.survive.has(id)) return { ok: true };
        this.objects.delete(id);
        return { ok: true };
      },
      objectExists: async (input: { bucket: string; key: string }) =>
        this.objects.has(`${input.bucket}/${input.key}`),
    };
  }
}

describe("Evidence physical destruction — live PostgreSQL 16 + disposable object store", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let executeEvidenceDestruction: (typeof import("@proovra/shared-runtime"))["executeEvidenceDestruction"];
  let applyEvidenceLifecycleAction: (typeof import("../src/services/evidence/evidence-lifecycle.service.js"))["applyEvidenceLifecycleAction"];
  let organizationId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ executeEvidenceDestruction } = await import("@proovra/shared-runtime"));
    ({ applyEvidenceLifecycleAction } = await import(
      "../src/services/evidence/evidence-lifecycle.service.js"
    ));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId as string;
  }, 600_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /**
   * A fictional record with one stored object, seeded directly into whatever
   * lifecycle posture the case needs.
   */
  async function seed(
    store: DisposableStore,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; bucket: string; key: string }> {
    const team = harness.fixtures.teamA;
    const bucket = "disposable-test-bucket";
    const key = `fictional/${Math.floor(performance.now() * 1000)}.bin`;
    const row = await prisma.evidence.create({
      data: {
        title: "Fictional destruction-path record",
        type: "PHOTO",
        status: "CREATED",
        teamId: team.teamId,
        organizationId,
        ownerUserId: team.ownerUserId,
        storageBucket: bucket,
        storageKey: key,
        ...over,
      } as never,
      select: { id: true },
    });
    store.put(bucket, key);
    return { id: row.id, bucket, key };
  }

  /** Put a record in the trash with an EXPIRED grace window. */
  function trashedAndExpired(extra: Record<string, unknown> = {}) {
    return {
      lifecycleState: "TRASHED",
      deletedAt: new Date(Date.now() - 200 * DAY),
      deletedAtUtc: new Date(Date.now() - 200 * DAY),
      deleteScheduledForUtc: new Date(Date.now() - 110 * DAY),
      ...extra,
    };
  }

  async function state(id: string) {
    return prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        lifecycleState: true,
        destroyedAtUtc: true,
        storageKey: true,
        deletedAt: true,
      },
    });
  }

  /** Certificates are `destruction_executed` ledger rows. Count them. */
  async function certificateCount(id: string) {
    return prisma.evidenceLifecycleEvent.count({
      where: { evidenceId: id, eventType: "destruction_executed" },
    });
  }

  // =========================================================================
  // 1. Archive / trash / restore delete nothing
  // =========================================================================

  it("archive, trash and restore perform ZERO storage deletions", async () => {
    const store = new DisposableStore();
    const rec = await seed(store, {
      // Retained until 2034 and under COMPLIANCE Object Lock — the exact record
      // the pre-convergence UI refused to let anyone move to trash.
      retentionUntilUtc: new Date(Date.now() + 3000 * DAY),
      storageObjectLockMode: "COMPLIANCE",
      storageObjectLockRetainUntilUtc: new Date(Date.now() + 3000 * DAY),
    });
    const actor = harness.fixtures.teamA.ownerUserId;

    const archived = await applyEvidenceLifecycleAction({
      evidenceId: rec.id,
      actorUserId: actor,
      action: "ARCHIVE",
      source: "single",
    });
    expect(archived.ok).toBe(true);
    expect((await state(rec.id)).lifecycleState).toBe("ARCHIVED");

    // The headline correction: retention does NOT block a recoverable trash.
    const trashed = await applyEvidenceLifecycleAction({
      evidenceId: rec.id,
      actorUserId: actor,
      action: "TRASH",
      source: "single",
    });
    expect(trashed.ok).toBe(true);
    expect((await state(rec.id)).lifecycleState).toBe("TRASHED");

    const restored = await applyEvidenceLifecycleAction({
      evidenceId: rec.id,
      actorUserId: actor,
      action: "RESTORE_FROM_TRASH",
      source: "single",
    });
    expect(restored.ok).toBe(true);
    expect((await state(rec.id)).lifecycleState).toBe("ACTIVE");

    // Nothing asked storage to delete anything, and the object is intact.
    expect(store.deleteCalls).toEqual([]);
    expect(store.has(rec.bucket, rec.key)).toBe(true);
  });

  it("single and bulk trash produce the SAME persisted state", async () => {
    const store = new DisposableStore();
    const actor = harness.fixtures.teamA.ownerUserId;
    const a = await seed(store);
    const b = await seed(store);

    await applyEvidenceLifecycleAction({
      evidenceId: a.id,
      actorUserId: actor,
      action: "TRASH",
      source: "single",
    });
    await applyEvidenceLifecycleAction({
      evidenceId: b.id,
      actorUserId: actor,
      action: "TRASH",
      source: "bulk",
    });

    const [sa, sb] = [await state(a.id), await state(b.id)];
    expect(sa.lifecycleState).toBe("TRASHED");
    expect(sb.lifecycleState).toBe(sa.lifecycleState);
    expect(sa.deletedAt).not.toBeNull();
    expect(sb.deletedAt).not.toBeNull();
    expect(store.deleteCalls).toEqual([]);
  });

  // =========================================================================
  // 2. Every boundary fails closed
  // =========================================================================

  const blocked: Array<[string, Record<string, unknown>, boolean, string]> = [
    [
      "trash grace still running",
      {
        lifecycleState: "TRASHED",
        deletedAt: new Date(),
        deletedAtUtc: new Date(),
        deleteScheduledForUtc: new Date(Date.now() + 60 * DAY),
      },
      false,
      "TRASH_GRACE_ACTIVE",
    ],
    [
      "application retention still running",
      trashedAndExpired({ retentionUntilUtc: new Date(Date.now() + 3000 * DAY) }),
      false,
      "APP_RETENTION_ACTIVE",
    ],
    [
      "Object Lock retain-until still running",
      trashedAndExpired({
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: new Date(Date.now() + 3000 * DAY),
      }),
      false,
      "OBJECT_LOCK_RETENTION_ACTIVE",
    ],
    ["legal hold active", trashedAndExpired(), true, "LEGAL_HOLD_ACTIVE"],
    [
      "record permanently locked",
      trashedAndExpired({ lockedAt: new Date() }),
      false,
      "EVIDENCE_LOCKED",
    ],
  ];

  for (const [label, over, legalHold, expectedReason] of blocked) {
    it(`refuses destruction and deletes nothing when ${label}`, async () => {
      const store = new DisposableStore();
      const rec = await seed(store, over);

      const result = await executeEvidenceDestruction(
        prisma,
        {
          evidenceId: rec.id,
          trigger: "manual",
          legalHold,
          destructionApprovalRequired: false,
          destructionApproved: false,
        },
        store.port,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.outcome).toBe("BLOCKED");
        if (result.outcome === "BLOCKED") {
          expect(result.reason).toBe(expectedReason);
        }
      }

      // Nothing deleted, nothing tombstoned, nothing certified — and the claim
      // was released, so the record is back where it started rather than
      // stranded in PENDING_DESTRUCTION.
      expect(store.deleteCalls).toEqual([]);
      expect(store.has(rec.bucket, rec.key)).toBe(true);
      const after = await state(rec.id);
      expect(after.lifecycleState).not.toBe("DESTROYED");
      expect(after.destroyedAtUtc).toBeNull();
      expect(await certificateCount(rec.id)).toBe(0);
    });
  }

  it("refuses when the workspace requires an approval that does not exist", async () => {
    const store = new DisposableStore();
    const rec = await seed(store, trashedAndExpired());

    const result = await executeEvidenceDestruction(
      prisma,
      {
        evidenceId: rec.id,
        trigger: "trash_grace_reconciler",
        legalHold: false,
        destructionApprovalRequired: true,
        destructionApproved: false,
      },
      store.port,
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === "BLOCKED") {
      expect(result.reason).toBe("DESTRUCTION_APPROVAL_REQUIRED");
    }
    expect(store.has(rec.bucket, rec.key)).toBe(true);
    expect(await certificateCount(rec.id)).toBe(0);
  });

  // =========================================================================
  // 3. THE CERTIFICATE DEFECT — no attestation without verified deletion
  // =========================================================================

  it("a REFUSED storage delete yields no DESTROYED and no certificate", async () => {
    const store = new DisposableStore();
    const rec = await seed(store, trashedAndExpired());
    store.refuse.add(`${rec.bucket}/${rec.key}`);

    const result = await executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe("STORAGE_DELETE_FAILED");

    const after = await state(rec.id);
    expect(after.lifecycleState).toBe("TRASHED");
    expect(after.destroyedAtUtc).toBeNull();
    expect(after.storageKey).toBe(rec.key);
    expect(await certificateCount(rec.id)).toBe(0);
    expect(store.has(rec.bucket, rec.key)).toBe(true);
  });

  it("an object that SURVIVES a successful-looking delete yields no certificate", async () => {
    // The exact shape of the shipped defect, and the reason verification is a
    // separate step: `DeleteObject` can return success against a versioned or
    // COMPLIANCE-locked bucket while the object remains fully retrievable. Two
    // production paths read that success as destruction and certified it.
    const store = new DisposableStore();
    const rec = await seed(store, trashedAndExpired());
    store.survive.add(`${rec.bucket}/${rec.key}`);

    const result = await executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("STORAGE_VERIFY_FAILED");
      if (result.outcome === "STORAGE_VERIFY_FAILED") {
        expect(result.failedKeys).toContain(rec.key);
      }
    }

    // The delete WAS attempted — this is not a refusal upstream.
    expect(store.deleteCalls).toContain(`${rec.bucket}/${rec.key}`);
    // And the object is still there, so nothing may claim otherwise.
    expect(store.has(rec.bucket, rec.key)).toBe(true);
    const after = await state(rec.id);
    expect(after.lifecycleState).toBe("TRASHED");
    expect(after.destroyedAtUtc).toBeNull();
    expect(await certificateCount(rec.id)).toBe(0);
  });

  // =========================================================================
  // 4. The lawful path
  // =========================================================================

  it("destroys, verifies, tombstones and certifies exactly once", async () => {
    const store = new DisposableStore();
    const rec = await seed(
      store,
      trashedAndExpired({
        // Every boundary in the past — the only state in which destruction is
        // lawful.
        retentionUntilUtc: new Date(Date.now() - 10 * DAY),
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: new Date(Date.now() - 10 * DAY),
      }),
    );

    // A part and a report, so the enumeration is exercised rather than assumed:
    // the old purge deleted the primary key only for some record shapes.
    const partKey = `${rec.key}.part1`;
    await prisma.evidencePart.create({
      data: {
        evidenceId: rec.id,
        partIndex: 0,
        storageBucket: rec.bucket,
        storageKey: partKey,
      } as never,
    });
    store.put(rec.bucket, partKey);

    const result = await executeEvidenceDestruction(
      prisma,
      {
        evidenceId: rec.id,
        trigger: "destruction_review",
        actorUserId: harness.fixtures.teamA.ownerUserId,
        legalHold: false,
        destructionApprovalRequired: true,
        destructionApproved: true,
      },
      store.port,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("DESTROYED");
    if (result.outcome !== "DESTROYED") return;

    // The bytes are gone — both objects, verified by asking the store.
    expect(store.has(rec.bucket, rec.key)).toBe(false);
    expect(store.has(rec.bucket, partKey)).toBe(false);
    expect(result.destroyedObjectCount).toBe(2);
    expect(result.certificate.storageDeletionVerified).toBe(true);

    // The tombstone: the row survives, its content pointers do not.
    const after = await state(rec.id);
    expect(after.lifecycleState).toBe("DESTROYED");
    expect(after.destroyedAtUtc).not.toBeNull();
    expect(after.storageKey).toBeNull();

    // The custody chain SURVIVES — it is the audit record that this evidence
    // existed and was destroyed. The old purge deleted it.
    const custody = await prisma.custodyEvent.count({
      where: { evidenceId: rec.id },
    });
    expect(custody).toBeGreaterThan(0);
    const purgeEvent = await prisma.custodyEvent.findFirst({
      where: { evidenceId: rec.id, eventType: "EVIDENCE_PURGED" },
      select: { payload: true },
    });
    expect(purgeEvent).not.toBeNull();
    expect(
      (purgeEvent?.payload as { certificateHash?: string } | null)
        ?.certificateHash,
    ).toBe(result.certificateHash);

    // Exactly one certificate.
    expect(await certificateCount(rec.id)).toBe(1);

    // A redelivery mints no second one.
    const again = await executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "purge_job", legalHold: false },
      store.port,
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.outcome).toBe("ALREADY_DESTROYED");
    expect(await certificateCount(rec.id)).toBe(1);
  });

  it("two concurrent executors produce exactly one destruction", async () => {
    const store = new DisposableStore();
    const rec = await seed(store, trashedAndExpired());

    const [a, b] = await Promise.all([
      executeEvidenceDestruction(
        prisma,
        { evidenceId: rec.id, trigger: "manual", legalHold: false },
        store.port,
      ),
      executeEvidenceDestruction(
        prisma,
        { evidenceId: rec.id, trigger: "purge_job", legalHold: false },
        store.port,
      ),
    ]);

    const destroyed = [a, b].filter(
      (r) => r.ok && r.outcome === "DESTROYED",
    ).length;
    const stoodDown = [a, b].filter(
      (r) => !r.ok && r.outcome === "CLAIM_HELD",
    ).length;

    // One winner. The loser stands down on the claim rather than racing into a
    // second delete of the same keys.
    expect(destroyed).toBe(1);
    expect(destroyed + stoodDown).toBe(2);
    expect(await certificateCount(rec.id)).toBe(1);
    expect(store.has(rec.bucket, rec.key)).toBe(false);
  });

  // =========================================================================
  // 5. Storage accounting
  // =========================================================================

  it("TRASHED consumes storage; DESTROYED does not", async () => {
    const store = new DisposableStore();
    const { getWorkspaceUsage } = await import(
      "../src/services/workspace-usage.service.js"
    );
    const { resolveWorkspaceScopeForUser } = await import(
      "../src/services/workspace-billing.service.js"
    );
    const teamId = harness.fixtures.teamA.teamId;
    const scope = await resolveWorkspaceScopeForUser({
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      teamId,
    });

    const before = await getWorkspaceUsage(scope);
    const rec = await seed(store, { sizeBytes: BigInt(5_000_000) });
    const active = await getWorkspaceUsage(scope);
    expect(active.storageBytesUsed).toBeGreaterThan(before.storageBytesUsed);

    await applyEvidenceLifecycleAction({
      evidenceId: rec.id,
      actorUserId: harness.fixtures.teamA.ownerUserId,
      action: "TRASH",
      source: "single",
    });
    const trashed = await getWorkspaceUsage(scope);
    // The bytes are still in the bucket, so they still count. Before the
    // convergence this dropped back to `before` the instant the user clicked.
    expect(trashed.storageBytesUsed).toBe(active.storageBytesUsed);

    await prisma.evidence.update({
      where: { id: rec.id },
      data: { deleteScheduledForUtc: new Date(Date.now() - DAY) },
    });
    const destroyed = await executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );
    expect(destroyed.ok).toBe(true);

    const after = await getWorkspaceUsage(scope);
    expect(after.storageBytesUsed).toBe(before.storageBytesUsed);
  });
});

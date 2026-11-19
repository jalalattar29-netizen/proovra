/**
 * WS-SCHED / PRO-W1C-04 — destruction includes Evidence Exchange ZIPs that
 * embed the record (metadata.json + full custody payloads), through the real
 * executor against a disposable PostgreSQL and an in-memory versioned store.
 *
 * At base enumerateStorageTargets never read evidence_exchange_packages, so the
 * ZIP survived a DESTROYED record with a certificate, and the package stayed
 * READY. Now: every attempt object of a package naming the record is deleted
 * and verified gone, and the package is REVOKED with no storage pointer; a ZIP
 * still under a later lock (another included record) blocks the destruction
 * with OBJECT_LOCK_RETENTION_ACTIVE and its date instead of certifying.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeEvidenceDestruction } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";
import { versionedDestructionPort } from "./helpers/versioned-destruction-port.js";
import { seedExecutableReview } from "./support/executable-destruction-review.js";

const BUCKET = "ws-sched-bucket";

describe("PRO-W1C-04 exchange ZIPs are part of a record's destruction (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const A = () => h.fixtures.teamA;

  async function trashedRecord() {
    const past = new Date(Date.now() - 86_400_000);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: "exchange zip subject",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        lifecycleState: "TRASHED",
        deletedAt: past,
        deleteScheduledForUtc: past,
        storageBucket: BUCKET,
        storageKey: `evidence/${randomUUID()}/original.jpg`,
      } as never,
      select: { id: true, storageKey: true },
    });
    return ev;
  }

  async function readyPackage(evidenceIds: string[]) {
    const pkgId = randomUUID();
    const winner = `exchange-packages/${A().teamId}/${pkgId}/1-${randomUUID()}.zip`;
    const loser = `exchange-packages/${A().teamId}/${pkgId}/2-${randomUUID()}.zip`;
    await prisma.evidenceExchangePackage.create({
      data: {
        id: pkgId,
        teamId: A().teamId,
        kind: "EVIDENCE",
        state: "READY",
        evidenceIds: evidenceIds as never,
        createdByUserId: A().ownerUserId,
        storageKey: winner,
        readyAtUtc: new Date(),
      },
    });
    return { pkgId, winner, loser };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("deletes every attempt object of a package naming the record and revokes the package", async () => {
    const ev = await trashedRecord();
    const { pkgId, winner, loser } = await readyPackage([ev.id]);
    const objects = new Set([`${BUCKET}/${ev.storageKey}`, `${BUCKET}/${winner}`, `${BUCKET}/${loser}`]);
    const port = versionedDestructionPort({
      exists: (id) => objects.has(id),
      remove: (id) => void objects.delete(id),
      ids: () => [...objects],
    });
    await seedExecutableReview(prisma as never, ev.id);
    const res = await executeEvidenceDestruction(
      prisma as never,
      { evidenceId: ev.id, trigger: "manual", legalHold: false },
      port,
    );
    expect(res).toMatchObject({ ok: true, outcome: "DESTROYED" });
    expect(objects.has(`${BUCKET}/${winner}`)).toBe(false);
    expect(objects.has(`${BUCKET}/${loser}`)).toBe(false);
    const pkg = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: pkgId } });
    expect(pkg.state).toBe("REVOKED");
    expect(pkg.storageKey).toBeNull();
  });

  it("a ZIP still locked for another included record blocks with its date and certifies nothing", async () => {
    const ev = await trashedRecord();
    const other = await trashedRecord();
    const { pkgId, winner } = await readyPackage([ev.id, other.id]);
    const lockedUntil = new Date(Date.now() + 365 * 86_400_000);
    const objects = new Set([`${BUCKET}/${ev.storageKey}`, `${BUCKET}/${winner}`]);
    const port = versionedDestructionPort({
      exists: (id) => objects.has(id),
      remove: (id) => void objects.delete(id),
      ids: () => [...objects],
      retainUntil: (id) => (id === `${BUCKET}/${winner}` ? lockedUntil : null),
    });
    await seedExecutableReview(prisma as never, ev.id);
    const res = await executeEvidenceDestruction(
      prisma as never,
      { evidenceId: ev.id, trigger: "manual", legalHold: false },
      port,
    );
    expect(res).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "OBJECT_LOCK_RETENTION_ACTIVE" });
    expect(objects.has(`${BUCKET}/${ev.storageKey}`), "nothing deleted").toBe(true);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } })).lifecycleState).not.toBe("DESTROYED");
    expect((await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: pkgId } })).state).toBe("READY");
  });
});

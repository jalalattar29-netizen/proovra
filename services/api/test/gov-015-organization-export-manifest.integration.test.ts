/**
 * GOV-015 — the manifest of an organization reconciles: every record of every
 * workspace, in or out of a case, with its digests, and nothing of anyone else's.
 *
 * FIXTURES (labelled): records, parts and the hold row are seeded directly. Storage
 * is an in-memory port; the real S3 listing is proven by the destruction suites.
 * The hold is a fixture row because placing one needs a contract term.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("GOV-015 organization export manifest (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/organization/organization-export-manifest.service.js");

  const A = () => h.fixtures.teamA;

  async function organizationOf(teamId: string) {
    return (
      await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })
    ).organizationId!;
  }

  async function stored(teamId: string, ownerUserId: string, over: Record<string, unknown> = {}) {
    const organizationId = await organizationOf(teamId);
    const key = `evidence/${randomUUID()}/original.bin`;
    const ev = await prisma.evidence.create({
      data: {
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId,
        ownerUserId,
        storageBucket: "bucket",
        storageKey: key,
        storageVersionId: "v1",
        fileSha256: "a".repeat(64),
        fingerprintHash: "b".repeat(64),
        sizeBytes: 100n,
        ...over,
      } as never,
      select: { id: true },
    });
    return { id: ev.id, key };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/organization/organization-export-manifest.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("lists every record and object with digests, reconciles, flags holds and excludes other tenants", async () => {
    const organizationId = await organizationOf(A().teamId);
    const baseline = await svc.buildOrganizationExportManifest({ organizationId }, prisma as never);

    const loose = await stored(A().teamId, A().ownerUserId);
    const held = await stored(A().teamId, A().ownerUserId);
    const multi = await stored(A().teamId, A().ownerUserId);
    await prisma.evidencePart.create({
      data: {
        evidenceId: multi.id,
        partIndex: 0,
        storageBucket: "bucket",
        storageKey: `${multi.key}.part0`,
        sha256: "c".repeat(64),
        sizeBytes: 25n,
      } as never,
    });
    const gone = await stored(A().teamId, A().ownerUserId, {
      lifecycleState: "DESTROYED",
      destroyedAtUtc: new Date(),
      storageBucket: null,
      storageKey: null,
    });
    await prisma.evidenceLegalHold.create({
      data: {
        teamId: A().teamId,
        scope: "EVIDENCE",
        evidenceId: held.id,
        status: "ACTIVE",
        title: "gov-015 hold (fixture row)",
        reason: "gov-015",
        placedByUserId: A().ownerUserId,
      } as never,
    });
    const foreign = await stored(h.fixtures.teamB.teamId, h.fixtures.teamB.ownerUserId);

    const manifest = await svc.buildOrganizationExportManifest({ organizationId }, prisma as never);

    expect(manifest.recordCount).toBe(baseline.recordCount + 3);
    expect(manifest.objectCount).toBe(baseline.objectCount + 4);
    expect(BigInt(manifest.byteCount)).toBe(BigInt(baseline.byteCount) + 325n);
    expect(manifest.destroyedRecordCount).toBe(baseline.destroyedRecordCount + 1);
    expect(manifest.heldRecordCount).toBe(baseline.heldRecordCount + 1);
    const ids = manifest.records.map((r) => r.evidenceId);
    expect(ids).toContain(loose.id);
    expect(ids).not.toContain(gone.id);
    expect(ids).not.toContain(foreign.id);
    expect(manifest.records.find((r) => r.evidenceId === held.id)?.legalHold).toBe(true);
    const original = manifest.records.find((r) => r.evidenceId === loose.id)?.objects[0];
    expect(original).toMatchObject({ kind: "ORIGINAL", versionId: "v1", sha256: "a".repeat(64), sizeBytes: "100" });
    expect(manifest.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the storage check names what is missing, by object and by version", async () => {
    const organizationId = await organizationOf(A().teamId);
    const rec = await stored(A().teamId, A().ownerUserId);
    const manifest = await svc.buildOrganizationExportManifest({ organizationId }, prisma as never);

    const present = await svc.checkManifestAgainstStorage(manifest, {
      listObjectVersions: async () => [
        { versionId: "v1", isDeleteMarker: false, isLatest: true, retainUntil: null, lockMode: null, legalHold: false },
      ],
    });
    expect(present.checkedObjects).toBe(manifest.objectCount);

    const tampered = await svc.checkManifestAgainstStorage(manifest, {
      listObjectVersions: async ({ key }) =>
        key === rec.key
          ? [{ versionId: "other", isDeleteMarker: false, isLatest: true, retainUntil: null, lockMode: null, legalHold: false }]
          : [],
    });
    expect(tampered.missing).toContainEqual({ evidenceId: rec.id, key: rec.key, reason: "NO_SUCH_VERSION" });
    expect(tampered.missing.some((m) => m.reason === "NO_SUCH_OBJECT")).toBe(true);
  });
});

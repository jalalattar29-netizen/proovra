/**
 * UC-PROV-008 — an exchange package names HOW a record entered PROOVRA from
 * the acquisition authority, never from the captureMethod STRUCTURE column
 * (live PostgreSQL 16, the real worker builder; storage replaced at its module
 * boundary so the archive bytes can be read back).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { readZipEntries } from "./helpers/read-zip.js";

const uploads = vi.hoisted(() => ({ bodies: [] as Buffer[] }));
vi.mock("../../worker/src/storage.js", () => ({
  putObjectBuffer: async (p: { body: Buffer }) => {
    uploads.bodies.push(p.body);
    return { versionId: null };
  },
  deleteObject: async () => undefined,
}));
vi.mock("../../worker/src/config.js", () => ({ env: { S3_BUCKET: "test-bucket" } }));
vi.mock("../../worker/src/db.js", () => ({ prisma: {} }));

describe("exchange package acquisition truth (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    const { teamA } = h.fixtures;
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({ teamId: teamA.teamId, key: "FEATURE_EVIDENCE_EXCHANGE", value: true, kind: "FEATURE", source: "CUSTOM", grantedByUserId: teamA.ownerUserId });
    await upsertEntitlementGrant({ teamId: teamA.teamId, key: "QUOTA_EXPORT_PACKAGES_PER_MONTH", value: 100, kind: "QUOTA", source: "CUSTOM", grantedByUserId: teamA.ownerUserId });
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const where = { teamId: h.fixtures.teamA.teamId };
      await prisma.evidenceExchangePackageBuild.deleteMany({ where }).catch(() => undefined);
      await prisma.evidenceExchangePackage.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  it("a DIRECT_SCREEN_CAPTURE_ANDROID record: acquisition.mode present, structure named evidenceStructure, no origin 'captureMethod'", async () => {
    const { teamA } = h.fixtures;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: "screen capture",
        type: "PHOTO",
        status: "SIGNED",
        teamId: teamA.teamId,
        organizationId: team.organizationId,
        ownerUserId: teamA.ownerUserId,
        captureMethod: "UPLOADED_FILE",
        acquisitionMode: "DIRECT_SCREEN_CAPTURE_ANDROID",
        acquisitionModeSource: "RECORDED_AT_CREATION",
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const pkg = await prisma.evidenceExchangePackage.create({
      data: { teamId: teamA.teamId, kind: "EVIDENCE", state: "BUILDING", evidenceIds: [ev.id] as never, createdByUserId: teamA.ownerUserId },
      select: { id: true },
    });
    const { buildExchangePackage } = await import("../../worker/src/exchange-package-builder.js");
    uploads.bodies.length = 0;
    await buildExchangePackage(pkg.id, prisma as never);
    const zip = uploads.bodies.find((b) => b.readUInt32LE(0) === 0x04034b50);
    expect(zip, "no archive was uploaded").toBeDefined();
    const entries = readZipEntries(zip!);
    const meta = JSON.parse(entries.get(`evidence/${ev.id}/metadata.json`)!.toString("utf8"));
    expect(meta.acquisition).toMatchObject({ mode: "DIRECT_SCREEN_CAPTURE_ANDROID", recorded: true });
    expect(meta.evidenceStructure).toBe("UPLOADED_FILE");
    expect(meta).not.toHaveProperty("captureMethod");
    void randomUUID;
  });
});

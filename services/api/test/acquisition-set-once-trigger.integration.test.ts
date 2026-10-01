/**
 * UC-PROV-009 — the acquisition set-once trigger refuses giving a legacy
 * (NULL) record a contemporaneous-looking acquisition later: on UPDATE,
 * NULL -> (any mode, 'RECORDED_AT_CREATION') is a check_violation; only the
 * BACKFILL_* sources may be written after creation. Live PostgreSQL 16.
 *
 * Depends on the additive trigger migration requested by lane A
 * (remediation/lanes/A.json migrationRequests, UC-PROV-009); RED until applied.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("UC-PROV-009 acquisition set-once trigger (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function legacyRecord(): Promise<string> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: { type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true, acquisitionMode: true },
    });
    expect(row.acquisitionMode).toBeNull();
    return row.id;
  }

  it("NULL -> RECORDED_AT_CREATION on UPDATE is refused", async () => {
    const id = await legacyRecord();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "evidence" SET "acquisition_mode" = 'DIRECT_WEB_CAPTURE_EXTENSION', "acquisition_mode_source" = 'RECORDED_AT_CREATION' WHERE "id" = $1::uuid`,
        id,
      ),
    ).rejects.toThrow(/acquisition|check/i);
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { acquisitionMode: true } });
    expect(after.acquisitionMode).toBeNull();
  });

  it("a BACKFILL_* source may still be written once", async () => {
    const id = await legacyRecord();
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence" SET "acquisition_mode" = 'SECURE_INTAKE_LINK', "acquisition_mode_source" = 'BACKFILL_INTAKE_SESSION_LINK' WHERE "id" = $1::uuid`,
      id,
    );
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { acquisitionModeSource: true } });
    expect(after.acquisitionModeSource).toBe("BACKFILL_INTAKE_SESSION_LINK");
  });
});

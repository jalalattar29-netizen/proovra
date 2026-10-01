/**
 * UC-ARCH-002 — the legacy retention backfill (migration
 * 20281001000700_retention_backfill_direct_capture), executed for real against
 * live PostgreSQL 16.
 *
 * Records created by the mobile app, the extension and Android/iOS screen capture
 * before the fix carried retention_until_utc NULL. The migration gives them
 * created_at + the workspace default; this suite seeds such legacy rows plus the
 * controls the migration must leave alone, runs the migration's SQL file
 * verbatim, and checks every row.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  resolve(HERE, "../prisma/migrations/20281001000700_retention_backfill_direct_capture/migration.sql"),
  "utf8",
);
const DAY_MS = 86_400_000;

describe("UC-ARCH-002 — legacy retention backfill (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  let policyCreated = false;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const teamId = h.fixtures.teamA.teamId;
    const existing = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId } });
    if (existing) {
      await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: { defaultRetentionDays: 30 } });
    } else {
      await prisma.workspaceGovernancePolicy.create({ data: { teamId, defaultRetentionDays: 30 } as never });
      policyCreated = true;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma && created.length) {
      await prisma.evidence.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    }
    if (prisma && policyCreated) {
      await prisma.workspaceGovernancePolicy
        .delete({ where: { teamId: h.fixtures.teamA.teamId } })
        .catch(() => undefined);
    }
    await h?.cleanup();
  });

  async function legacy(opts: {
    mode: string | null;
    teamId?: string | null;
    retention?: Date | null;
    deleted?: boolean;
  }): Promise<{ id: string; createdAt: Date }> {
    const createdAt = new Date(Date.now() - 400 * DAY_MS);
    const teamId = opts.teamId === undefined ? h.fixtures.teamA.teamId : opts.teamId;
    const team = teamId
      ? await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })
      : null;
    const row = await prisma.evidence.create({
      data: {
        ownerUserId: h.fixtures.teamA.ownerUserId,
        teamId,
        organizationId: team?.organizationId ?? null,
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/png",
        createdAt,
        retentionUntilUtc: opts.retention ?? null,
        deletedAt: opts.deleted ? new Date() : null,
        acquisitionMode: opts.mode,
        acquisitionModeSource: opts.mode ? "RECORDED_AT_CREATION" : null,
      } as never,
      select: { id: true },
    });
    created.push(row.id);
    return { id: row.id, createdAt };
  }

  it("gives each skipped channel created_at + the workspace default, and touches nothing else", async () => {
    const skipped = [
      "PROOVRA_MOBILE_APP",
      "DIRECT_WEB_CAPTURE_EXTENSION",
      "DIRECT_SCREEN_CAPTURE_ANDROID",
      "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      "DIRECT_SCREEN_CAPTURE_IOS",
    ];
    const targets = [];
    for (const mode of skipped) targets.push(await legacy({ mode }));
    const existingDate = new Date(Date.now() + 999 * DAY_MS);
    const keepsExisting = await legacy({ mode: "DIRECT_SCREEN_CAPTURE_IOS", retention: existingDate });
    const webUpload = await legacy({ mode: "PROOVRA_WEB_UPLOAD" });
    const trashed = await legacy({ mode: "PROOVRA_MOBILE_APP", deleted: true });
    const otherWorkspace = await legacy({ mode: "PROOVRA_MOBILE_APP", teamId: h.fixtures.teamB.teamId });

    await prisma.$executeRawUnsafe(MIGRATION_SQL);
    // Idempotent: a second application changes nothing.
    const again = await prisma.$executeRawUnsafe(MIGRATION_SQL);
    expect(again).toBe(0);

    const rows = await prisma.evidence.findMany({
      where: { id: { in: created } },
      select: { id: true, retentionUntilUtc: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.retentionUntilUtc]));
    for (const t of targets) {
      expect(byId.get(t.id)?.getTime()).toBe(t.createdAt.getTime() + 30 * DAY_MS);
    }
    expect(byId.get(keepsExisting.id)?.getTime()).toBe(existingDate.getTime());
    expect(byId.get(webUpload.id)).toBeNull();
    expect(byId.get(trashed.id)).toBeNull();
    expect(byId.get(otherWorkspace.id)).toBeNull();
  });
});

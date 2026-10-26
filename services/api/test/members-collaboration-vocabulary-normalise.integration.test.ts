/**
 * Members re-audit N-8 — legacy Collaboration Team values are normalised, so a
 * legacy row can be archived or updated again, and each vocabulary CHECK is
 * VALIDATED once nothing violates it. Proven against a real PostgreSQL by
 * running the forward migration file whole, exactly as `migrate deploy` does.
 *
 * The defect: the DOM-08 CHECKs are NOT VALID, and PostgreSQL checks a NOT
 * VALID CHECK on every later UPDATE of a row — so a legacy row holding, say,
 * 'active' could no longer be updated by any writer (23514 → 500).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = path.resolve(HERE, "../prisma/migrations/20281026000600_collaboration_vocabulary_checks/migration.sql");
const NORMALISE = path.resolve(HERE, "../prisma/migrations/20281026001400_collaboration_vocabulary_normalise/migration.sql");
const CONSTRAINTS: ReadonlyArray<[string, string]> = [
  ["collaboration_teams", "collaboration_teams_status_vocab"],
  ["collaboration_team_members", "collaboration_team_members_status_vocab"],
  ["collaboration_team_members", "collaboration_team_members_role_vocab"],
  ["collaboration_team_invites", "collaboration_team_invites_status_vocab"],
  ["collaboration_team_invites", "collaboration_team_invites_role_vocab"],
  ["collaboration_team_invites", "collaboration_team_invites_delivery_vocab"],
  ["collaboration_team_assignments", "collaboration_team_assignments_status_vocab"],
];

describe("N-8 — legacy Collaboration Team values normalised; vocabulary validated (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let conn: pg.Client;
  let teamId: string;
  let memberId: string;
  let inviteId: string;
  let assignmentId: string;
  let unknownAssignmentId: string;
  let mixedInviteId: string;

  const run = async (file: string) => {
    await conn.query(readFileSync(file, "utf8"));
  };
  const validated = async (name: string) =>
    (await conn.query(`SELECT convalidated FROM pg_constraint WHERE conname = $1`, [name])).rows[0]?.convalidated as boolean;
  const read = async (table: string, id: string, column: string) =>
    (await conn.query(`SELECT "${column}" AS v FROM "${table}" WHERE id = $1::uuid`, [id])).rows[0]?.v as string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    conn = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await conn.connect();
    const W = h.fixtures.teamA;
    teamId = (
      await prisma.collaborationTeam.create({
        data: { workspaceId: W.teamId, name: `Legacy ${randomUUID().slice(0, 6)}`, createdByUserId: W.ownerUserId },
        select: { id: true },
      })
    ).id;
    memberId = (
      await prisma.collaborationTeamMember.create({ data: { teamId, userId: W.memberUserId, status: "ACTIVE" }, select: { id: true } })
    ).id;
    const invite = () =>
      prisma.collaborationTeamInvite.create({
        data: {
          teamId,
          workspaceId: W.teamId,
          email: `legacy-${randomUUID().slice(0, 6)}@test.proovra.local`,
          channel: "EMAIL",
          tokenHash: randomUUID().replace(/-/g, ""),
          createdByUserId: W.ownerUserId,
          expiresAtUtc: new Date(Date.now() + 86_400_000),
        } as never,
        select: { id: true },
      });
    inviteId = (await invite()).id;
    mixedInviteId = (await invite()).id;
    const assignment = () =>
      prisma.collaborationTeamAssignment.create({
        data: { teamId, workspaceId: W.teamId, targetType: "CASE", targetId: randomUUID(), assignedByUserId: W.ownerUserId } as never,
        select: { id: true },
      });
    assignmentId = (await assignment()).id;
    unknownAssignmentId = (await assignment()).id;

    // Recreate the legacy world: rows written before the CHECKs existed.
    for (const [table, name] of CONSTRAINTS) await conn.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
    const legacy = async (table: string, column: string, id: string, value: string) =>
      conn.query(`UPDATE "${table}" SET "${column}" = $1 WHERE id = $2::uuid`, [value, id]);
    await legacy("collaboration_teams", "status", teamId, "active");
    await legacy("collaboration_team_members", "status", memberId, " Suspended ");
    await legacy("collaboration_team_members", "role", memberId, "lead");
    await legacy("collaboration_team_invites", "status", inviteId, "pending");
    await legacy("collaboration_team_invites", "role", inviteId, "Viewer");
    await legacy("collaboration_team_invites", "delivery_status", inviteId, "sent");
    await legacy("collaboration_team_assignments", "status", assignmentId, "Canceled");
    // A value with no canonical meaning: never guessed.
    await legacy("collaboration_team_assignments", "status", unknownAssignmentId, "ON_HOLD");
    // A row mixing a mappable value with one that has no canonical meaning: it
    // cannot be rewritten at all (the whole new row is checked), so it is left
    // untouched — and must not abort the migration.
    await legacy("collaboration_team_invites", "status", mixedInviteId, "pending");
    await legacy("collaboration_team_invites", "delivery_status", mixedInviteId, "QUEUED");
    await run(CHECKS); // the CHECKs as released: NOT VALID
  }, 900_000);

  afterAll(async () => {
    await conn?.end();
    await h?.cleanup();
  }, 300_000);

  it("before the fix, a legacy row cannot be updated at all (23514) — the defect", async () => {
    await expect(
      conn.query(`UPDATE "collaboration_teams" SET "name" = "name" WHERE id = $1::uuid`, [teamId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("normalises every legacy value with a canonical meaning; the rows can then be archived and updated", async () => {
    await run(NORMALISE);

    expect(await read("collaboration_teams", teamId, "status")).toBe("ACTIVE");
    expect(await read("collaboration_team_members", memberId, "status")).toBe("SUSPENDED");
    expect(await read("collaboration_team_members", memberId, "role")).toBe("LEAD");
    expect(await read("collaboration_team_invites", inviteId, "status")).toBe("PENDING");
    expect(await read("collaboration_team_invites", inviteId, "role")).toBe("VIEWER");
    expect(await read("collaboration_team_invites", inviteId, "delivery_status")).toBe("SENT");
    expect(await read("collaboration_team_assignments", assignmentId, "status")).toBe("CANCELLED");
    // No canonical meaning → left exactly as it was.
    expect(await read("collaboration_team_assignments", unknownAssignmentId, "status")).toBe("ON_HOLD");
    expect(await read("collaboration_team_invites", mixedInviteId, "status")).toBe("pending");
    expect(await read("collaboration_team_invites", mixedInviteId, "delivery_status")).toBe("QUEUED");

    // Every former legacy row now takes ordinary writes.
    await prisma.collaborationTeamMember.update({ where: { id: memberId }, data: { status: "REMOVED" } });
    await prisma.collaborationTeamInvite.update({ where: { id: inviteId }, data: { status: "EXPIRED" } as never });
    await prisma.collaborationTeamAssignment.update({ where: { id: assignmentId }, data: { status: "REASSIGNED" } as never });
    await prisma.collaborationTeam.update({ where: { id: teamId }, data: { status: "ARCHIVED" } as never });
    expect(await read("collaboration_teams", teamId, "status")).toBe("ARCHIVED");
  });

  const STILL_VIOLATED = new Set([
    "collaboration_team_assignments_status_vocab",
    "collaboration_team_invites_status_vocab",
    "collaboration_team_invites_delivery_vocab",
  ]);

  it("validates every constraint with no violator left, and leaves those with a remaining violator NOT VALID", async () => {
    for (const [, name] of CONSTRAINTS) {
      expect(await validated(name), name).toBe(!STILL_VIOLATED.has(name));
    }
    // A validated constraint still refuses a value outside the vocabulary.
    await expect(
      conn.query(`UPDATE "collaboration_team_members" SET "role" = 'OWNER' WHERE id = $1::uuid`, [memberId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("is idempotent, and validates the remaining constraints once their violators are resolved by an operator", async () => {
    await run(NORMALISE);
    expect(await read("collaboration_team_assignments", unknownAssignmentId, "status")).toBe("ON_HOLD");
    for (const name of STILL_VIOLATED) expect(await validated(name), name).toBe(false);
    // The operator's decision (here: the rows are removed); the next run validates.
    await conn.query(`DELETE FROM "collaboration_team_assignments" WHERE id = $1::uuid`, [unknownAssignmentId]);
    await conn.query(`DELETE FROM "collaboration_team_invites" WHERE id = $1::uuid`, [mixedInviteId]);
    await run(NORMALISE);
    for (const [, name] of CONSTRAINTS) expect(await validated(name), name).toBe(true);
  });

  it("a write to a row still holding an unmappable legacy value is a typed 409 for the operator, never a 500", async () => {
    const W = h.fixtures.teamA;
    const g = await prisma.collaborationTeam.create({
      data: { workspaceId: W.teamId, name: "legacy-task-group", createdByUserId: W.ownerUserId } as never,
      select: { id: true },
    });
    await prisma.collaborationTeamMember.create({ data: { teamId: g.id, userId: W.ownerUserId, role: "LEAD", status: "ACTIVE" } as never });
    const c = await prisma.case.create({ data: { name: "legacy-task-case", teamId: W.teamId, ownerUserId: W.ownerUserId }, select: { id: true } });
    const task = async () =>
      (
        await prisma.collaborationTeamAssignment.create({
          data: { teamId: g.id, workspaceId: W.teamId, assignedByUserId: W.ownerUserId, targetType: "CASE", targetId: c.id, status: "OPEN" } as never,
          select: { id: true },
        })
      ).id;
    const legacy = await task();
    const clean = await task();
    // The real legacy state: the check exists NOT VALID and the row predates it.
    const name = "collaboration_team_assignments_status_vocab";
    const def = (await conn.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, [name])).rows[0].d as string;
    await conn.query(`ALTER TABLE "collaboration_team_assignments" DROP CONSTRAINT "${name}"`);
    await conn.query(`UPDATE "collaboration_team_assignments" SET "status" = 'ON_HOLD' WHERE id = $1::uuid`, [legacy]);
    await conn.query(`ALTER TABLE "collaboration_team_assignments" ADD CONSTRAINT "${name}" ${def.replace(/ NOT VALID$/, "")} NOT VALID`);
    try {
      const reprioritise = (id: string) =>
        h.app.inject({
          method: "PATCH",
          url: `/v1/collaboration-teams/${g.id}/assignments/${id}`,
          headers: { authorization: `Bearer ${W.ownerToken}`, "x-proovra-workspace-id": W.teamId },
          payload: { priority: "HIGH" },
        });
      const refused = await reprioritise(legacy);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "LEGACY_RECORD_NEEDS_REVIEW" } });
      expect(await read("collaboration_team_assignments", legacy, "status")).toBe("ON_HOLD");
      // Positive control: a clean task takes the same write.
      const ok = await reprioritise(clean);
      expect(ok.statusCode, ok.body).toBeLessThan(300);
    } finally {
      await conn.query(`DELETE FROM "collaboration_team_assignments" WHERE id = $1::uuid`, [legacy]);
    }
  });
});

/**
 * DOM-08 — the Collaboration Team vocabulary is enforced by the database.
 *
 * Every role/status column of the Collaboration Team tables refuses a value
 * outside the shared vocabulary (@proovra/shared collaboration-team.ts), and
 * accepts every value in it. Driven with raw SQL against a real PostgreSQL —
 * the point is that a write the services never make (a hand-written UPDATE,
 * a writer bug) is refused too.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import {
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_DELIVERY_STATUSES,
  COLLABORATION_TEAM_INVITE_STATUSES,
  COLLABORATION_TEAM_MEMBER_STATUSES,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_STATUSES,
} from "@proovra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations/20281026000600_collaboration_vocabulary_checks/migration.sql",
);
const CONSTRAINTS: ReadonlyArray<[string, string]> = [
  ["collaboration_teams", "collaboration_teams_status_vocab"],
  ["collaboration_team_members", "collaboration_team_members_status_vocab"],
  ["collaboration_team_members", "collaboration_team_members_role_vocab"],
  ["collaboration_team_invites", "collaboration_team_invites_status_vocab"],
  ["collaboration_team_invites", "collaboration_team_invites_role_vocab"],
  ["collaboration_team_invites", "collaboration_team_invites_delivery_vocab"],
  ["collaboration_team_assignments", "collaboration_team_assignments_status_vocab"],
];

describe("DOM-08 — Collaboration Team vocabulary CHECKs (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let teamId: string;
  let memberId: string;
  let inviteId: string;
  let assignmentId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    // The constraints under test are the ones THIS migration installs: drop
    // them, re-apply the file exactly as `migrate deploy` runs it, and assert
    // on the result — so a change to the migration is what the cases below
    // see, not whatever the shared database was migrated with earlier.
    const conn = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await conn.connect();
    try {
      for (const [table, name] of CONSTRAINTS) {
        await conn.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
      }
      await conn.query(readFileSync(MIGRATION, "utf8"));
    } finally {
      await conn.end();
    }
    const W = h.fixtures.teamA;
    const team = await prisma.collaborationTeam.create({
      data: { workspaceId: W.teamId, name: `Vocab ${randomUUID().slice(0, 6)}`, createdByUserId: W.ownerUserId },
      select: { id: true },
    });
    teamId = team.id;
    memberId = (
      await prisma.collaborationTeamMember.create({ data: { teamId, userId: W.memberUserId, status: "ACTIVE" }, select: { id: true } })
    ).id;
    inviteId = (
      await prisma.collaborationTeamInvite.create({
        data: {
          teamId,
          workspaceId: W.teamId,
          email: `vocab-${randomUUID().slice(0, 6)}@test.proovra.local`,
          channel: "EMAIL",
          tokenHash: randomUUID().replace(/-/g, ""),
          createdByUserId: W.ownerUserId,
          expiresAtUtc: new Date(Date.now() + 86_400_000),
        } as never,
        select: { id: true },
      })
    ).id;
    assignmentId = (
      await prisma.collaborationTeamAssignment.create({
        data: {
          teamId,
          workspaceId: W.teamId,
          targetType: "CASE",
          targetId: randomUUID(),
          assignedByUserId: W.ownerUserId,
        } as never,
        select: { id: true },
      })
    ).id;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const COLUMNS: Array<{ table: string; column: string; id: () => string; vocab: readonly string[] }> = [
    { table: "collaboration_teams", column: "status", id: () => teamId, vocab: COLLABORATION_TEAM_STATUSES },
    { table: "collaboration_team_members", column: "status", id: () => memberId, vocab: COLLABORATION_TEAM_MEMBER_STATUSES },
    { table: "collaboration_team_members", column: "role", id: () => memberId, vocab: COLLABORATION_TEAM_ROLES },
    { table: "collaboration_team_invites", column: "status", id: () => inviteId, vocab: COLLABORATION_TEAM_INVITE_STATUSES },
    { table: "collaboration_team_invites", column: "role", id: () => inviteId, vocab: COLLABORATION_TEAM_ROLES },
    { table: "collaboration_team_invites", column: "delivery_status", id: () => inviteId, vocab: COLLABORATION_TEAM_DELIVERY_STATUSES },
    { table: "collaboration_team_assignments", column: "status", id: () => assignmentId, vocab: COLLABORATION_TEAM_ASSIGNMENT_STATUSES },
  ];

  const set = (table: string, column: string, id: string, value: string) =>
    prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2::uuid`, value, id);

  for (const c of COLUMNS) {
    it(`${c.table}.${c.column} accepts exactly the shared vocabulary`, async () => {
      for (const v of c.vocab) expect(await set(c.table, c.column, c.id(), v)).toBe(1);
      await expect(set(c.table, c.column, c.id(), "INACTIVE")).rejects.toThrow(/check constraint/i);
      await expect(set(c.table, c.column, c.id(), "active")).rejects.toThrow(/check constraint/i);
      // Leave the row in its first legal state for the next case.
      expect(await set(c.table, c.column, c.id(), c.vocab[0]!)).toBe(1);
    });
  }
});

#!/usr/bin/env node
/**
 * Teams Entitlement Alignment (2026-07-14) — READ-ONLY data audit.
 *
 * Reports every ACTIVE Team (collaboration team) whose owning account
 * no longer satisfies the commercial contract:
 *
 *   - owner plan includes ZERO Teams (FREE / PAYG), or
 *   - owner owns MORE active Teams than the plan's cap.
 *
 * Remediation policy (implemented dynamically in billing-guards — no
 * schema change, no data mutation):
 *   grandfathered — the Team and all its data stay readable and
 *   exportable; member adds, every invitation, and invite acceptance
 *   are locked (402 TEAM_INVITES_NOT_INCLUDED) until the owner
 *   upgrades. Nothing is deleted, no roles change, no assignments are
 *   orphaned.
 *
 * Usage:  DATABASE_URL=... node scripts/audit-restricted-teams.mjs
 * Output: human table on stdout + JSON report on fd 1 after the table.
 * This script performs SELECTs only.
 */
import { PrismaClient } from "@prisma/client";

const LIMITS = {
  FREE: 0,
  PAYG: 0,
  PRO: 2,
  TEAM: 5,
  ENTERPRISE: 1000,
};

const prisma = new PrismaClient();

async function main() {
  const teams = await prisma.collaborationTeam.findMany({
    where: { status: "ACTIVE", archivedAtUtc: null },
    select: {
      id: true,
      name: true,
      workspaceId: true,
      workspace: { select: { ownerUserId: true } },
    },
  });

  const byOwner = new Map();
  for (const t of teams) {
    const owner = t.workspace?.ownerUserId ?? "unknown";
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(t);
  }

  const affected = [];
  for (const [ownerUserId, owned] of byOwner) {
    const ent = await prisma.entitlement.findFirst({
      where: { userId: ownerUserId, active: true },
      orderBy: { createdAt: "desc" },
      select: { plan: true },
    });
    const plan = ent?.plan ?? "FREE";
    const cap = LIMITS[plan] ?? 0;
    if (owned.length <= cap && cap > 0) continue;

    for (const t of owned) {
      const [memberCount, pendingInvites, discussionCount] =
        await Promise.all([
          prisma.collaborationTeamMember.count({
            where: { teamId: t.id, status: "ACTIVE" },
          }),
          prisma.collaborationTeamInvite.count({
            where: { teamId: t.id, status: "PENDING" },
          }),
          prisma.discussionThread
            .count({ where: { teamId: t.workspaceId } })
            .catch(() => null),
        ]);
      affected.push({
        teamId: t.id,
        name: t.name,
        workspaceId: t.workspaceId,
        ownerUserId,
        ownerPlan: plan,
        planCap: cap,
        ownedActiveTeams: owned.length,
        memberCount,
        pendingInvites,
        workspaceDiscussionThreads: discussionCount,
        remediation:
          cap === 0
            ? "grandfathered: plan includes zero Teams — readable, growth locked"
            : "grandfathered: over plan cap — readable, growth locked on ALL owner teams until within cap or upgraded",
      });
    }
  }

  console.log(
    `\nTeams Entitlement Alignment audit — ${new Date().toISOString()}`,
  );
  console.log(
    `Active Teams: ${teams.length} · Owners: ${byOwner.size} · Affected Teams: ${affected.length}\n`,
  );
  if (affected.length > 0) {
    console.table(
      affected.map((a) => ({
        team: a.teamId.slice(0, 8),
        name: a.name.slice(0, 24),
        owner: a.ownerUserId.slice(0, 8),
        plan: a.ownerPlan,
        cap: a.planCap,
        owned: a.ownedActiveTeams,
        members: a.memberCount,
        pending: a.pendingInvites,
      })),
    );
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), affected }, null, 2));
}

main()
  .catch((err) => {
    console.error("audit failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

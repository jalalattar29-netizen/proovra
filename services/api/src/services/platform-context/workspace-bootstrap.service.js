/**
 * Phase EMERGENCY-RECOVERY — Personal workspace bootstrap.
 *
 * Every authenticated user must have a usable workspace. The
 * platform previously treated "no `currentWorkspaceId`" as a
 * synthetic personal mode with `workspace.id === null`, which:
 *
 *   - Surfaced as "No workspace selected" / "Switch to workspace"
 *     on every team-scoped read endpoint (matter-queue, reports,
 *     search, ops, reviewer-ops, governance, …).
 *   - Forced page-level code to invent personal-mode fallbacks per
 *     endpoint, leading to drift.
 *
 * This module replaces that synthetic mode with a REAL personal
 * `Team` row tagged `isPersonal = true`. Bootstrapping is:
 *
 *   1. Idempotent — `ensurePersonalWorkspace` calls are safe at any
 *      cadence, including on every `/v1/platform/context` request.
 *   2. Concurrency-safe — racing inserts collide on the partial
 *      unique index `teams_owner_personal_uniq` (one per owner).
 *      The loser catches `P2002`, re-reads, and returns the winner.
 *   3. Side-effect minimal — only creates the bare `Team` +
 *      `TeamMember(OWNER, ACTIVE)` rows. No billing changes, no
 *      audit emission, no signed URLs, no governance writes.
 *   4. Backward-compatible — existing teams default `is_personal`
 *      to `false`; the bootstrap creates a NEW row for users who
 *      lack one. Legacy `teamId IS NULL` evidence remains owned by
 *      `ownerUserId` and is still reachable via user-scoped reads
 *      (`/v1/evidence?scope=active`, `/v1/cases/summary`, etc.).
 *
 * Naming policy:
 *
 *   - Default name: `<First Last>'s personal workspace` when names
 *     exist, else `<email>'s personal workspace`, else
 *     `"Personal workspace"`. All bounded ≤ 120 chars (the Team
 *     model's `name` field cap).
 *   - Personal workspaces never become billing surfaces — the
 *     `billingPlan` defaults to FREE; PRO plans live on the user's
 *     `Entitlement` row, not on the personal Team.
 */
import { prisma as defaultPrisma } from "../../db.js";
const NAME_MAX = 120;
function buildPersonalName(input) {
    const full = [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
    const base = full ||
        input.displayName?.trim() ||
        input.email?.trim() ||
        "";
    const label = base ? `${base}'s personal workspace` : "Personal workspace";
    return label.length > NAME_MAX ? label.slice(0, NAME_MAX) : label;
}
/**
 * Resolve (or create) the personal `Team` row for a user.
 *
 * Concurrency-safety pattern:
 *
 *   1. Read the existing personal team — fast path.
 *   2. If missing, attempt to create inside a transaction with the
 *      partial unique index (`teams_owner_personal_uniq`) acting as
 *      the source of truth.
 *   3. On `P2002` (unique violation — concurrent winner), re-read
 *      and return the winning row.
 *
 * Returns the bootstrap result. Never throws for the normal "exists"
 * or "created concurrently" cases; rethrows for unexpected DB errors.
 */
export async function ensurePersonalWorkspace(input, client = defaultPrisma) {
    const existing = await client.team.findFirst({
        where: { ownerUserId: input.userId, isPersonal: true },
        select: { id: true, name: true },
    });
    if (existing) {
        // Ensure the OWNER TeamMember row also exists (cheap upsert).
        // The bootstrap can be called against a row whose membership was
        // somehow removed (e.g. a manual DB intervention). The unique
        // `[teamId, userId]` constraint keeps this idempotent.
        await client.teamMember.upsert({
            where: {
                teamId_userId: { teamId: existing.id, userId: input.userId },
            },
            create: {
                teamId: existing.id,
                userId: input.userId,
                role: "OWNER",
                status: "ACTIVE",
            },
            update: {
            // No-op for existing rows. We intentionally do NOT clobber
            // the status/role of an existing membership.
            },
        });
        return {
            teamId: existing.id,
            name: existing.name,
            isPersonal: true,
            created: false,
        };
    }
    // Read user identity to compose the workspace name.
    const user = await client.user.findUnique({
        where: { id: input.userId },
        select: {
            email: true,
            displayName: true,
            firstName: true,
            lastName: true,
        },
    });
    const name = buildPersonalName({
        firstName: user?.firstName ?? null,
        lastName: user?.lastName ?? null,
        displayName: user?.displayName ?? null,
        email: user?.email ?? null,
    });
    try {
        const created = await client.$transaction(async (tx) => {
            // Phase 2.7X Stage 6 — atomically create the Organization
            // alongside the personal Team so the team is never observed
            // with a NULL `organization_id`. Stage 7 will tighten the
            // schema constraint; this code path makes that tightening
            // safe ahead of time.
            const org = await tx.organization.create({
                data: {
                    name, // mirrors team name; operator can rename later
                    billingOwnerUserId: input.userId,
                    status: "ACTIVE",
                },
                select: { id: true },
            });
            await tx.organizationMembership.create({
                data: {
                    organizationId: org.id,
                    userId: input.userId,
                    role: "ORG_OWNER",
                },
            });
            const team = await tx.team.create({
                data: {
                    name,
                    ownerUserId: input.userId,
                    isPersonal: true,
                    organizationId: org.id,
                },
                select: { id: true, name: true },
            });
            await tx.teamMember.create({
                data: {
                    teamId: team.id,
                    userId: input.userId,
                    role: "OWNER",
                    status: "ACTIVE",
                },
            });
            return team;
        });
        return {
            teamId: created.id,
            name: created.name,
            isPersonal: true,
            created: true,
        };
    }
    catch (err) {
        // P2002 = unique constraint violation. Lost the race; re-fetch.
        const code = err.code;
        if (code === "P2002") {
            const winner = await client.team.findFirst({
                where: { ownerUserId: input.userId, isPersonal: true },
                select: { id: true, name: true },
            });
            if (winner) {
                // Ensure OWNER membership for the winner too.
                await client.teamMember.upsert({
                    where: {
                        teamId_userId: { teamId: winner.id, userId: input.userId },
                    },
                    create: {
                        teamId: winner.id,
                        userId: input.userId,
                        role: "OWNER",
                        status: "ACTIVE",
                    },
                    update: {},
                });
                return {
                    teamId: winner.id,
                    name: winner.name,
                    isPersonal: true,
                    created: false,
                };
            }
        }
        throw err;
    }
}

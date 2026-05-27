/**
 * Phase 2.7X Stage 3 — Organization runtime endpoints (dual-read).
 *
 * Four GET-only endpoints that expose the Phase 2.7X Org domain as
 * read-only governance metadata. These are the FIRST runtime
 * activation of the Organization architecture.
 *
 *   GET /v1/me/orgs                  — current user's org memberships
 *   GET /v1/orgs/:id                 — org metadata
 *   GET /v1/orgs/:id/members         — org member list (governance only)
 *   GET /v1/orgs/:id/workspaces      — workspaces (teams) bound to org
 *
 * Hard rules:
 *
 *   - Org membership grants ONLY org-level governance reads. NO
 *     evidence content, NO case content, NO reviewer queues, NO
 *     workspace-level data is exposed here. The /workspaces endpoint
 *     returns ONLY team id + name + isPersonal + createdAt — no
 *     evidence counts, no member counts, no case counts.
 *
 *   - All endpoints respond 403 to authed non-members. Org existence
 *     is not enumerable. The exact code (403 vs 404) is acceptable
 *     either way per the Phase 2.6B/C/D contract.
 *
 *   - Stage 2 backfilled 1 org per existing team. The /workspaces
 *     endpoint therefore returns 1 row per org for currently
 *     backfilled state. Multi-team orgs are a Stage 6+ feature.
 *
 *   - Pagination is intentionally NOT implemented yet. Stage 4
 *     ships paginated list endpoints once write surfaces exist;
 *     until then the response shape includes a `summary` envelope
 *     that future pagination can wrap.
 *
 *   - These endpoints are local-runtime-only in the sense that
 *     production deploy of the Org runtime is still blocked by
 *     Stages 4-6. They do not require any new migration — Stage 1
 *     shipped the schema and Stage 2 the backfill.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { checkOrgAccess } from "../services/organization/org-access.js";
// Phase 2.7X Stage 4 — audit emitter (writes inside the mutation tx).
import { emitOrgAuditEvent } from "../services/organization/org-audit.service.js";

const UuidParam = z.string().uuid();

// ---------------------------------------------------------------------------
// Phase 2.7X Stage 4 — write-endpoint schemas.
// ---------------------------------------------------------------------------
const OrgRoleSchema = z.enum([
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
]);
type OrgRoleValue = z.infer<typeof OrgRoleSchema>;

const CreateOrgBody = z.object({
  name: z.string().trim().min(1).max(180),
  legalName: z.string().trim().min(1).max(180).optional(),
  legalEmail: z.string().email().optional(),
  address: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  logoUrl: z.string().url().optional(),
});

const UpdateOrgBody = z
  .object({
    name: z.string().trim().min(1).max(180),
    legalName: z.string().trim().min(1).max(180).nullable(),
    legalEmail: z.string().email().nullable(),
    address: z.string().trim().min(1).nullable(),
    timezone: z.string().trim().min(1).max(64).nullable(),
    logoUrl: z.string().url().nullable(),
  })
  .partial();

const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: OrgRoleSchema.optional(),
});

const RoleChangeBody = z.object({
  role: OrgRoleSchema,
});

const ORG_ROLE_PRECEDENCE: Record<OrgRoleValue, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

/**
 * Construct a single-use invite token. 32 random bytes hex-encoded
 * = 64 chars (fits the `token` VARCHAR(128) column with headroom).
 * Hex avoids URL-encoding surprises in the future invite-link path.
 *
 * The raw token is RETURNED ONCE to the inviter (via the
 * POST response). It is NEVER persisted to the database after
 * Phase 2.7X Stage 6 — only its SHA-256 hash is stored.
 */
function newInviteToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Phase 2.7X Stage 6 — Hash an invite token for DB storage / lookup.
 *
 * SHA-256 over UTF-8 bytes, hex-encoded (64 chars). Used both at
 * write time (storing the hash on a new invite) and at read time
 * (looking up an invite by token in the accept endpoint).
 *
 * SHA-256 is constant-time for fixed-length input, so this is not
 * vulnerable to timing-based extraction of partial-match
 * information at the hashing layer. The DB index probe is also
 * effectively constant-time for the realistic search space (2^256
 * possible tokens — enumeration is infeasible regardless of
 * timing).
 */
export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** 7-day invite expiry. Local-only Stage 4 default; configurable later. */
function inviteExpiresAt(now = Date.now()): Date {
  return new Date(now + 7 * 24 * 60 * 60 * 1000);
}

/**
 * Compose the same gate the teams routes use: require auth, then
 * require legal acceptance. (Phase 2.7X Stage 3 doesn't introduce
 * a new gate; we reuse the exact same composition so a future
 * legal-prompt change applies uniformly.)
 */
async function requireAuthAndLegal(
  req: FastifyRequest,
  reply: Parameters<typeof requireAuth>[1],
) {
  await requireAuth(req, reply);
  // requireAuth replies on failure; if we reach here auth succeeded.
  await requireLegalAcceptance(req, reply);
}

export async function organizationsRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /v1/me/orgs
  //
  // List the orgs the calling user belongs to, with their role in
  // each, AND the small set of governance counts the org-list
  // surface needs to render with operational density: member count,
  // workspace count, pending-invite count.
  //
  // Phase A.1B operational completion — earlier we deferred these
  // counts to the per-org endpoint, which forced the org list page
  // to either N+1 fetch or render flat cards with no operational
  // signal. The counts here are CHEAP aggregations the dual-read
  // architecture already uses on the per-org endpoint; surfacing
  // them on the list endpoint is the right scope.
  //
  // Strict hard rules preserved:
  //   - No evidence/case/reviewer aggregates leak through. We only
  //     return governance counts (members, workspaces, invites).
  //   - `pendingInviteCount` is returned to EVERY caller (visibility
  //     is a governance signal, not an audit signal). The list
  //     surface uses it to indicate "this org has X open invites";
  //     the actual invite metadata stays gated behind ORG_ADMIN+.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/me/orgs",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const rows = await prisma.organizationMembership.findMany({
        where: { userId },
        select: {
          role: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              status: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      const orgIds = rows.map((r) => r.organization.id);
      // Aggregate the three governance counts in parallel. groupBy
      // returns ONE row per org-id-that-has-at-least-one-record, so
      // we hydrate a Map<orgId, count> and default missing keys to 0.
      const now = new Date();
      const [memberCounts, workspaceCounts, pendingInviteCounts] =
        orgIds.length === 0
          ? [[], [], []]
          : await Promise.all([
              prisma.organizationMembership.groupBy({
                by: ["organizationId"],
                where: { organizationId: { in: orgIds } },
                _count: { id: true },
              }),
              prisma.team.groupBy({
                by: ["organizationId"],
                where: { organizationId: { in: orgIds } },
                _count: { id: true },
              }),
              prisma.organizationInvite.groupBy({
                by: ["organizationId"],
                where: {
                  organizationId: { in: orgIds },
                  // Only invites that are still actionable count as
                  // "pending" for governance visibility: not accepted,
                  // not revoked, not expired.
                  acceptedAt: null,
                  revokedAt: null,
                  expiresAt: { gt: now },
                },
                _count: { id: true },
              }),
            ]);

      const memberCountByOrg = new Map<string, number>();
      for (const r of memberCounts) {
        if (r.organizationId)
          memberCountByOrg.set(r.organizationId, r._count.id);
      }
      const workspaceCountByOrg = new Map<string, number>();
      for (const r of workspaceCounts) {
        if (r.organizationId)
          workspaceCountByOrg.set(r.organizationId, r._count.id);
      }
      const pendingInviteByOrg = new Map<string, number>();
      for (const r of pendingInviteCounts) {
        if (r.organizationId)
          pendingInviteByOrg.set(r.organizationId, r._count.id);
      }

      return reply.code(200).send({
        summary: { totalOrgs: rows.length },
        orgs: rows.map((r) => ({
          organizationId: r.organization.id,
          name: r.organization.name,
          status: r.organization.status,
          role: r.role,
          orgCreatedAt: r.organization.createdAt.toISOString(),
          memberSince: r.createdAt.toISOString(),
          memberCount: memberCountByOrg.get(r.organization.id) ?? 0,
          workspaceCount: workspaceCountByOrg.get(r.organization.id) ?? 0,
          pendingInviteCount: pendingInviteByOrg.get(r.organization.id) ?? 0,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id
  //
  // Org metadata for a single org. Returns 403 if the caller is
  // not a member. Returns ONLY governance fields — no aggregates
  // that could leak workspace-level info (e.g. we deliberately
  // omit evidence counts, case counts, reviewer queue counts).
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:id",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, { orgId, userId });
      if (access.kind !== "ok") {
        // Both "not_found" and "forbidden" return 403 — non-members
        // cannot distinguish "org exists but you're not in it" from
        // "org doesn't exist". This is the same defense-in-depth
        // pattern used by Phase 2.6B/C/D aggregators.
        return reply.code(403).send({ message: "Forbidden" });
      }

      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          id: true,
          name: true,
          legalName: true,
          legalEmail: true,
          address: true,
          timezone: true,
          logoUrl: true,
          status: true,
          billingOwnerUserId: true,
          verificationState: true,
          verifiedAtUtc: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!org) {
        // Should be impossible given checkOrgAccess returned "ok",
        // but defense in depth.
        return reply.code(403).send({ message: "Forbidden" });
      }

      // Aggregate counts at the GOVERNANCE level only — member count
      // (org-level), workspace count (number of teams linked to the
      // org), pending-invite count (Phase A.1B operational signal).
      // None reveals workspace-internal data (evidence/case/reviewer).
      const [memberCount, workspaceCount, pendingInviteCount] =
        await Promise.all([
          prisma.organizationMembership.count({
            where: { organizationId: orgId },
          }),
          prisma.team.count({ where: { organizationId: orgId } }),
          prisma.organizationInvite.count({
            where: {
              organizationId: orgId,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
          }),
        ]);

      return reply.code(200).send({
        organizationId: org.id,
        name: org.name,
        legalName: org.legalName,
        legalEmail: org.legalEmail,
        // Phase A.1B — fields the PATCH endpoint already supports
        // round-trip on the GET so the Settings form can prefill
        // them.
        address: org.address,
        timezone: org.timezone,
        logoUrl: org.logoUrl,
        status: org.status,
        billingOwnerUserId: org.billingOwnerUserId,
        verificationState: org.verificationState,
        verifiedAtUtc: org.verifiedAtUtc ? org.verifiedAtUtc.toISOString() : null,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
        callerRole: access.role,
        summary: {
          memberCount,
          workspaceCount,
          pendingInviteCount,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/members
  //
  // List org memberships — userId + email + displayName + role +
  // memberSince. NO workspace-level info per member. NO evidence
  // counts, NO case counts.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:id/members",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, { orgId, userId });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const memberships = await prisma.organizationMembership.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          user: { select: { email: true, displayName: true } },
        },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      });

      return reply.code(200).send({
        organizationId: orgId,
        summary: { totalMembers: memberships.length },
        members: memberships.map((m) => ({
          membershipId: m.id,
          userId: m.userId,
          email: m.user.email,
          displayName: m.user.displayName,
          role: m.role,
          memberSince: m.createdAt.toISOString(),
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/workspaces
  //
  // Workspaces (= teams) bound to the org. Always returns:
  //   - team id, name, isPersonal, createdAt
  //
  // Phase A.1B Wave 2 — for callers with ORG_ADMIN+ role, also returns
  // the workspace's billing plan, billing status, and seat configuration.
  // This is real data the Team model already owns. Surfacing it on the
  // org governance surface closes the "billing visibility" gap without
  // inventing org-level billing.
  //
  // Still does NOT return:
  //   - evidence counts (would leak workspace size)
  //   - team member counts (would leak access topology)
  //   - case counts (would leak governance load)
  //   - retention policy / verification state (workspace-private
  //     governance attributes; not yet promoted to the org surface)
  //
  // ORG_MEMBER / ORG_AUDITOR callers see workspace identity only; the
  // billing fields are omitted from their response payload.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:id/workspaces",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, { orgId, userId });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const canSeeBilling =
        access.role === "ORG_OWNER" ||
        access.role === "ORG_ADMIN" ||
        access.role === "ORG_BILLING_ADMIN";

      const workspaces = await prisma.team.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          name: true,
          isPersonal: true,
          createdAt: true,
          billingPlan: canSeeBilling,
          billingStatus: canSeeBilling,
          includedSeats: canSeeBilling,
          overSeatLimit: canSeeBilling,
          billingOwnerUserId: canSeeBilling,
        },
        orderBy: { createdAt: "asc" },
      });

      return reply.code(200).send({
        organizationId: orgId,
        summary: { totalWorkspaces: workspaces.length },
        callerCanSeeBilling: canSeeBilling,
        workspaces: workspaces.map((w) => ({
          workspaceId: w.id,
          name: w.name,
          isPersonal: w.isPersonal,
          createdAt: w.createdAt.toISOString(),
          ...(canSeeBilling
            ? {
                billing: {
                  plan: w.billingPlan,
                  status: w.billingStatus,
                  includedSeats: w.includedSeats,
                  overSeatLimit: w.overSeatLimit,
                  billingOwnerUserId: w.billingOwnerUserId,
                },
              }
            : {}),
        })),
      });
    },
  );

  // ===========================================================================
  // ============================================================  Stage 4  ===
  // ============================================  Organization write surfaces ===
  // ===========================================================================
  //
  // All mutations:
  //   - run inside a single Prisma transaction
  //   - emit an `organization_audit_events` row via
  //     `emitOrgAuditEvent` BEFORE the transaction commits
  //   - return the same 403-shaped response for "not a member" and
  //     "org doesn't exist" (defense in depth)
  //   - validate request bodies via zod (Fastify maps zod errors to 400)
  //   - NEVER mutate evidence, cases, reviewer workflows, or any
  //     workspace-scoped data
  //
  // Role precedence:
  //   ORG_OWNER (5) > ORG_ADMIN (4)
  //                 > ORG_SECURITY_ADMIN (3) = ORG_BILLING_ADMIN (3)
  //                 > ORG_AUDITOR (2)
  //                 > ORG_MEMBER (1)
  //
  // Special restrictions enforced at the route layer:
  //   - Cannot CHANGE-TO or CHANGE-FROM ORG_OWNER unless the actor is
  //     themselves ORG_OWNER. Promote-to-owner requires owner.
  //   - The LAST ORG_OWNER cannot be demoted or removed. The route
  //     counts ORG_OWNER rows for the org and blocks the mutation
  //     when removal would zero the count.
  //   - An actor cannot SELF-MODIFY their own role or SELF-REMOVE
  //     their own membership. They must transfer ownership first.
  //   - An actor cannot INVITE at a role STRICTLY GREATER than
  //     their own. So an ORG_ADMIN cannot invite as ORG_OWNER.

  // -------------------------------------------------------------------------
  // POST /v1/orgs
  //
  // Create a new organization. Caller becomes ORG_OWNER. This is the
  // "create my first organization" path for new signups and the
  // "create another org" path for operators with prior orgs.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = CreateOrgBody.parse(req.body);
      const userId = getAuthUserId(req);

      const result = await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            name: body.name,
            legalName: body.legalName,
            legalEmail: body.legalEmail,
            address: body.address,
            timezone: body.timezone,
            logoUrl: body.logoUrl,
            billingOwnerUserId: userId,
            status: "ACTIVE",
          },
          select: {
            id: true,
            name: true,
            legalName: true,
            legalEmail: true,
            status: true,
            billingOwnerUserId: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        await tx.organizationMembership.create({
          data: {
            organizationId: org.id,
            userId,
            role: "ORG_OWNER",
          },
        });

        await emitOrgAuditEvent(tx, {
          organizationId: org.id,
          actorUserId: userId,
          eventType: "ORG_CREATED",
          targetType: "organization",
          targetId: org.id,
          metadata: {
            name: org.name,
            billingOwnerUserId: org.billingOwnerUserId,
          },
        });

        return org;
      });

      return reply.code(201).send({
        organizationId: result.id,
        name: result.name,
        legalName: result.legalName,
        legalEmail: result.legalEmail,
        status: result.status,
        billingOwnerUserId: result.billingOwnerUserId,
        callerRole: "ORG_OWNER",
        createdAt: result.createdAt.toISOString(),
        updatedAt: result.updatedAt.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/orgs/:id
  //
  // Update org metadata (name, legalName, legalEmail, address,
  // timezone, logoUrl). Requires ORG_ADMIN+.
  // -------------------------------------------------------------------------
  app.patch(
    "/v1/orgs/:id",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);
      const body = UpdateOrgBody.parse(req.body);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const result = await prisma.$transaction(async (tx) => {
        const before = await tx.organization.findUniqueOrThrow({
          where: { id: orgId },
          select: {
            name: true,
            legalName: true,
            legalEmail: true,
            address: true,
            timezone: true,
            logoUrl: true,
          },
        });

        const updated = await tx.organization.update({
          where: { id: orgId },
          data: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.legalName !== undefined && { legalName: body.legalName }),
            ...(body.legalEmail !== undefined && { legalEmail: body.legalEmail }),
            ...(body.address !== undefined && { address: body.address }),
            ...(body.timezone !== undefined && { timezone: body.timezone }),
            ...(body.logoUrl !== undefined && { logoUrl: body.logoUrl }),
          },
          select: {
            id: true,
            name: true,
            legalName: true,
            legalEmail: true,
            address: true,
            timezone: true,
            logoUrl: true,
            status: true,
            updatedAt: true,
          },
        });

        // Compose the diff metadata. Only changed fields appear.
        // Values are JSON-serializable strings/nulls per the columns.
        const changes: Record<string, { from: string | null; to: string | null }> = {};
        for (const key of [
          "name",
          "legalName",
          "legalEmail",
          "address",
          "timezone",
          "logoUrl",
        ] as const) {
          if (body[key] === undefined) continue;
          if (before[key] !== updated[key]) {
            changes[key] = {
              from: before[key] ?? null,
              to: updated[key] ?? null,
            };
          }
        }

        if (Object.keys(changes).length > 0) {
          await emitOrgAuditEvent(tx, {
            organizationId: orgId,
            actorUserId: userId,
            eventType: "ORG_UPDATED",
            targetType: "organization",
            targetId: orgId,
            metadata: { changes } as unknown as Prisma.InputJsonValue,
          });
        }

        return updated;
      });

      return reply.code(200).send({
        organizationId: result.id,
        name: result.name,
        legalName: result.legalName,
        legalEmail: result.legalEmail,
        address: result.address,
        timezone: result.timezone,
        logoUrl: result.logoUrl,
        status: result.status,
        updatedAt: result.updatedAt.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/invites
  //
  // Create an invite. Requires ORG_ADMIN+. Cannot invite at a role
  // strictly greater than the actor's own role (so ORG_ADMIN cannot
  // mint an ORG_OWNER invite).
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs/:id/invites",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);
      const body = InviteBody.parse(req.body);
      const inviteRole: OrgRoleValue = body.role ?? "ORG_MEMBER";

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      // Cannot invite at a role strictly greater than the actor's own.
      if (ORG_ROLE_PRECEDENCE[inviteRole] > ORG_ROLE_PRECEDENCE[access.role]) {
        return reply
          .code(403)
          .send({ message: "Cannot invite at a role greater than your own." });
      }

      const result = await prisma.$transaction(async (tx) => {
        // Reject if a non-revoked, non-accepted, non-expired invite
        // already exists for this email in this org.
        const now = new Date();
        const existingPending = await tx.organizationInvite.findFirst({
          where: {
            organizationId: orgId,
            email: body.email,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        });
        if (existingPending) {
          return { kind: "conflict" as const, reason: "pending_invite_exists" };
        }

        // Reject if a user with that email is already an active member.
        const userWithEmail = await tx.user.findFirst({
          where: { email: body.email },
          select: { id: true },
        });
        if (userWithEmail) {
          const alreadyMember = await tx.organizationMembership.findFirst({
            where: { organizationId: orgId, userId: userWithEmail.id },
            select: { id: true },
          });
          if (alreadyMember) {
            return { kind: "conflict" as const, reason: "already_member" };
          }
        }

        // Phase 2.7X Stage 6 — token security:
        //   - generate the raw 32-byte token (returned to the inviter ONCE)
        //   - store ONLY the SHA-256 hash in the DB (`token_hash` column)
        //   - the legacy `token` column is left NULL for new rows;
        //     existing rows (pre-Stage 6) retain their raw value for
        //     rollback compat until the Stage 7 destructive cutover.
        const token = newInviteToken();
        const tokenHash = hashInviteToken(token);
        const expires = inviteExpiresAt();
        const invite = await tx.organizationInvite.create({
          data: {
            organizationId: orgId,
            email: body.email,
            role: inviteRole,
            token: null, // never store the raw token on new rows
            tokenHash,
            invitedByUserId: userId,
            expiresAt: expires,
          },
          select: { id: true, expiresAt: true },
        });

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_MEMBER_INVITED",
          targetType: "organization_invite",
          targetId: invite.id,
          metadata: {
            inviteId: invite.id,
            email: body.email,
            role: inviteRole,
            expiresAt: invite.expiresAt.toISOString(),
            invitedByUserId: userId,
          },
        });

        return {
          kind: "ok" as const,
          inviteId: invite.id,
          expiresAt: invite.expiresAt,
          token,
        };
      });

      if (result.kind === "conflict") {
        return reply.code(409).send({
          message:
            result.reason === "already_member"
              ? "User with that email is already a member."
              : "A pending invite already exists for that email.",
          reason: result.reason,
        });
      }

      // The token is returned ONLY in this immediate response so the
      // operator can build the invite link. It is NEVER returned by
      // any later GET endpoint and NEVER appears in audit metadata.
      return reply.code(201).send({
        inviteId: result.inviteId,
        organizationId: orgId,
        email: body.email,
        role: inviteRole,
        expiresAt: result.expiresAt.toISOString(),
        token: result.token,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/org-invites/:token/accept
  //
  // Accept an invite. The caller (authed) becomes a member of the
  // org at the invited role.
  //
  // Stage 5 hardening:
  //   - Email-match enforcement: when BOTH the invite has an email
  //     AND the caller has an email, they MUST match (case-insensitive
  //     compare after trim). If they don't, return 403 and emit an
  //     ORG_INVITE_ACCEPT_REJECTED audit event (reason="email_mismatch").
  //   - Other rejection paths (expired/revoked/already_accepted/not_found)
  //     also emit ORG_INVITE_ACCEPT_REJECTED so the org audit timeline
  //     surfaces token-enumeration / hijack pressure.
  //
  // Backward compat for guest sessions (no email): the email-match
  // step is SKIPPED when the caller has no email. Possession of the
  // token is the proof. Tested by the Stage 4 e2e suite.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/org-invites/:token/accept",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const token = z
        .string()
        .min(16)
        .max(128)
        .parse((req.params as { token: string }).token);
      const userId = getAuthUserId(req);

      const result = await prisma.$transaction(async (tx) => {
        // Resolve the caller's email up front (so we can include it
        // in any rejection audit event for token-hijack visibility).
        const caller = await tx.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });
        const callerEmail = caller?.email?.trim().toLowerCase() ?? null;

        // Phase 2.7X Stage 6 — lookup by hash, not raw token. The
        // raw `token` column is left intentionally untouched here so
        // the destructive Stage 7 cutover can DROP it without code
        // changes.
        const incomingTokenHash = hashInviteToken(token);
        const invite = await tx.organizationInvite.findUnique({
          where: { tokenHash: incomingTokenHash },
          select: {
            id: true,
            organizationId: true,
            role: true,
            email: true,
            expiresAt: true,
            acceptedAt: true,
            revokedAt: true,
          },
        });

        // Helper: emit a rejection audit row WHEN the org is known.
        // For "not_found" the org is unknown — we cannot scope the
        // event to a real org, so the rejection is unaudited at the
        // org tier (404 is itself the signal).
        const recordRejection = async (
          reason:
            | "email_mismatch"
            | "expired"
            | "revoked"
            | "already_accepted"
            | "not_found",
        ) => {
          if (!invite) return; // no org to scope the event to
          await emitOrgAuditEvent(tx, {
            organizationId: invite.organizationId,
            actorUserId: userId,
            eventType: "ORG_INVITE_ACCEPT_REJECTED",
            targetType: "organization_invite",
            targetId: invite.id,
            metadata: {
              reason,
              attemptedByUserId: userId,
              attemptedByEmail: callerEmail,
              inviteId: invite.id,
            },
          });
        };

        if (!invite) {
          return { kind: "not_found" as const };
        }
        if (invite.revokedAt) {
          await recordRejection("revoked");
          return { kind: "revoked" as const };
        }
        if (invite.acceptedAt) {
          await recordRejection("already_accepted");
          return { kind: "already_accepted" as const };
        }
        if (invite.expiresAt <= new Date()) {
          await recordRejection("expired");
          return { kind: "expired" as const };
        }

        // Stage 5 — email match (only when BOTH sides have emails).
        const inviteEmail = invite.email.trim().toLowerCase();
        if (callerEmail && callerEmail !== inviteEmail) {
          await recordRejection("email_mismatch");
          return { kind: "email_mismatch" as const };
        }

        // Idempotency: if the user is already a member of the org,
        // mark the invite accepted but DON'T create a duplicate
        // membership.
        const existingMembership = await tx.organizationMembership.findFirst({
          where: { organizationId: invite.organizationId, userId },
          select: { id: true, role: true },
        });
        if (!existingMembership) {
          await tx.organizationMembership.create({
            data: {
              organizationId: invite.organizationId,
              userId,
              role: invite.role,
            },
          });
        }

        await tx.organizationInvite.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date() },
        });

        await emitOrgAuditEvent(tx, {
          organizationId: invite.organizationId,
          actorUserId: userId,
          eventType: "ORG_MEMBER_ACCEPTED",
          targetType: "organization_invite",
          targetId: invite.id,
          metadata: {
            inviteId: invite.id,
            role: invite.role,
            acceptedByUserId: userId,
          },
        });

        return {
          kind: "ok" as const,
          organizationId: invite.organizationId,
          role: invite.role,
        };
      });

      if (result.kind === "not_found") {
        return reply.code(404).send({ message: "Invite not found." });
      }
      if (result.kind === "revoked") {
        return reply.code(410).send({ message: "Invite has been revoked." });
      }
      if (result.kind === "already_accepted") {
        return reply.code(410).send({ message: "Invite already accepted." });
      }
      if (result.kind === "expired") {
        return reply.code(410).send({ message: "Invite has expired." });
      }
      if (result.kind === "email_mismatch") {
        return reply
          .code(403)
          .send({ message: "Invite email does not match your account." });
      }

      return reply.code(200).send({
        organizationId: result.organizationId,
        role: result.role,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/invites  (Stage 5)
  //
  // List pending invites for the org. Requires ORG_ADMIN+ — same gate
  // as the create-invite endpoint. The response excludes raw tokens
  // (those were returned ONCE at create time and never read back).
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:id/invites",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const now = new Date();
      const invites = await prisma.organizationInvite.findMany({
        where: {
          organizationId: orgId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: {
          id: true,
          email: true,
          role: true,
          invitedByUserId: true,
          expiresAt: true,
          lastResentAt: true,
          resendCount: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.code(200).send({
        organizationId: orgId,
        summary: { totalPending: invites.length },
        invites: invites.map((i) => ({
          inviteId: i.id,
          email: i.email,
          role: i.role,
          invitedByUserId: i.invitedByUserId,
          expiresAt: i.expiresAt.toISOString(),
          lastResentAt: i.lastResentAt ? i.lastResentAt.toISOString() : null,
          resendCount: i.resendCount,
          createdAt: i.createdAt.toISOString(),
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/orgs/:id/invites/:inviteId  (Stage 5 — revoke)
  //
  // Mark a pending invite as revoked. Requires ORG_ADMIN+. Refuses
  // to revoke an already-accepted invite (409). Idempotent for
  // already-revoked invites (returns 200 with revoked=true).
  // -------------------------------------------------------------------------
  app.delete(
    "/v1/orgs/:id/invites/:inviteId",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const inviteId = UuidParam.parse(
        (req.params as { inviteId: string }).inviteId,
      );
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const result = await prisma.$transaction(async (tx) => {
        const invite = await tx.organizationInvite.findFirst({
          where: { id: inviteId, organizationId: orgId },
          select: {
            id: true,
            email: true,
            role: true,
            acceptedAt: true,
            revokedAt: true,
          },
        });
        if (!invite) return { kind: "not_found" as const };
        if (invite.acceptedAt)
          return { kind: "already_accepted" as const };
        if (invite.revokedAt)
          return {
            kind: "ok" as const,
            inviteId: invite.id,
            email: invite.email,
            role: invite.role,
            wasAlreadyRevoked: true,
          };

        await tx.organizationInvite.update({
          where: { id: invite.id },
          data: { revokedAt: new Date(), revokedByUserId: userId },
        });

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_INVITE_REVOKED",
          targetType: "organization_invite",
          targetId: invite.id,
          metadata: {
            inviteId: invite.id,
            email: invite.email,
            role: invite.role,
            revokedByUserId: userId,
          },
        });

        return {
          kind: "ok" as const,
          inviteId: invite.id,
          email: invite.email,
          role: invite.role,
          wasAlreadyRevoked: false,
        };
      });

      if (result.kind === "not_found") {
        return reply.code(404).send({ message: "Invite not found." });
      }
      if (result.kind === "already_accepted") {
        return reply
          .code(409)
          .send({ message: "Cannot revoke an already-accepted invite." });
      }

      return reply.code(200).send({
        inviteId: result.inviteId,
        revoked: true,
        wasAlreadyRevoked: result.wasAlreadyRevoked,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/invites/:inviteId/resend  (Stage 5 — resend)
  //
  // Extend the expiry window of a pending invite and bump
  // `resendCount`. Returns the SAME token (we never rotate — the
  // recipient already has it). Refuses if the invite is accepted,
  // revoked, or expired (operators should send a fresh invite in
  // that case).
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs/:id/invites/:inviteId/resend",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const inviteId = UuidParam.parse(
        (req.params as { inviteId: string }).inviteId,
      );
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const result = await prisma.$transaction(async (tx) => {
        const invite = await tx.organizationInvite.findFirst({
          where: { id: inviteId, organizationId: orgId },
          select: {
            id: true,
            email: true,
            role: true,
            acceptedAt: true,
            revokedAt: true,
            expiresAt: true,
            resendCount: true,
          },
        });
        if (!invite) return { kind: "not_found" as const };
        if (invite.acceptedAt)
          return { kind: "already_accepted" as const };
        if (invite.revokedAt) return { kind: "revoked" as const };
        if (invite.expiresAt <= new Date())
          return { kind: "expired" as const };

        const newExpires = inviteExpiresAt();
        const updated = await tx.organizationInvite.update({
          where: { id: invite.id },
          data: {
            lastResentAt: new Date(),
            resendCount: { increment: 1 },
            expiresAt: newExpires,
          },
          select: {
            id: true,
            expiresAt: true,
            resendCount: true,
            lastResentAt: true,
          },
        });

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_INVITE_RESENT",
          targetType: "organization_invite",
          targetId: invite.id,
          metadata: {
            inviteId: invite.id,
            email: invite.email,
            role: invite.role,
            newExpiresAt: updated.expiresAt.toISOString(),
            resendCount: updated.resendCount,
          },
        });

        return {
          kind: "ok" as const,
          inviteId: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: updated.expiresAt,
          resendCount: updated.resendCount,
        };
      });

      if (result.kind === "not_found") {
        return reply.code(404).send({ message: "Invite not found." });
      }
      if (result.kind === "already_accepted") {
        return reply
          .code(409)
          .send({ message: "Cannot resend an accepted invite." });
      }
      if (result.kind === "revoked") {
        return reply
          .code(410)
          .send({ message: "Cannot resend a revoked invite." });
      }
      if (result.kind === "expired") {
        return reply
          .code(410)
          .send({ message: "Cannot resend an expired invite. Send a fresh one." });
      }

      return reply.code(200).send({
        inviteId: result.inviteId,
        email: result.email,
        role: result.role,
        expiresAt: result.expiresAt.toISOString(),
        resendCount: result.resendCount,
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/orgs/:id/members/:memberId
  //
  // Change a member's org role. Requires ORG_ADMIN+. Cannot:
  //   - change your own role
  //   - promote to ORG_OWNER unless caller is ORG_OWNER
  //   - demote the last ORG_OWNER
  // -------------------------------------------------------------------------
  app.patch(
    "/v1/orgs/:id/members/:memberId",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const memberId = UuidParam.parse(
        (req.params as { memberId: string }).memberId,
      );
      const userId = getAuthUserId(req);
      const body = RoleChangeBody.parse(req.body);
      const newRole = body.role;

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const result = await prisma.$transaction(async (tx) => {
        const target = await tx.organizationMembership.findFirst({
          where: { id: memberId, organizationId: orgId },
          select: { id: true, userId: true, role: true },
        });
        if (!target) {
          return { kind: "not_found" as const };
        }
        if (target.userId === userId) {
          return { kind: "self_modify_blocked" as const };
        }
        // Only ORG_OWNER can change role TO or FROM ORG_OWNER.
        const involvesOwnerRole =
          target.role === "ORG_OWNER" || newRole === "ORG_OWNER";
        if (involvesOwnerRole && access.role !== "ORG_OWNER") {
          return { kind: "owner_change_requires_owner" as const };
        }
        // Cannot demote the last ORG_OWNER.
        if (target.role === "ORG_OWNER" && newRole !== "ORG_OWNER") {
          const ownerCount = await tx.organizationMembership.count({
            where: { organizationId: orgId, role: "ORG_OWNER" },
          });
          if (ownerCount <= 1) {
            return { kind: "last_owner_protected" as const };
          }
        }

        if (target.role === newRole) {
          return { kind: "noop" as const, membershipId: target.id };
        }

        await tx.organizationMembership.update({
          where: { id: target.id },
          data: { role: newRole },
        });

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_MEMBER_ROLE_CHANGED",
          targetType: "organization_membership",
          targetId: target.id,
          metadata: {
            membershipId: target.id,
            targetUserId: target.userId,
            oldRole: target.role,
            newRole,
          },
        });

        return {
          kind: "ok" as const,
          membershipId: target.id,
          targetUserId: target.userId,
          oldRole: target.role as OrgRoleValue,
          newRole,
        };
      });

      switch (result.kind) {
        case "not_found":
          return reply.code(404).send({ message: "Membership not found." });
        case "self_modify_blocked":
          return reply
            .code(409)
            .send({ message: "Cannot modify your own role." });
        case "owner_change_requires_owner":
          return reply.code(403).send({
            message:
              "Only ORG_OWNER can change a membership to or from ORG_OWNER.",
          });
        case "last_owner_protected":
          return reply
            .code(409)
            .send({ message: "Cannot demote the last ORG_OWNER." });
        case "noop":
          return reply
            .code(200)
            .send({ membershipId: result.membershipId, noop: true });
        case "ok":
          return reply.code(200).send({
            membershipId: result.membershipId,
            targetUserId: result.targetUserId,
            oldRole: result.oldRole,
            newRole: result.newRole,
          });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/orgs/:id/members/:memberId
  //
  // Remove a member. Requires ORG_ADMIN+. Cannot remove yourself.
  // Cannot remove the last ORG_OWNER. Only ORG_OWNER can remove
  // another ORG_OWNER.
  // -------------------------------------------------------------------------
  app.delete(
    "/v1/orgs/:id/members/:memberId",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const memberId = UuidParam.parse(
        (req.params as { memberId: string }).memberId,
      );
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const result = await prisma.$transaction(async (tx) => {
        const target = await tx.organizationMembership.findFirst({
          where: { id: memberId, organizationId: orgId },
          select: { id: true, userId: true, role: true },
        });
        if (!target) {
          return { kind: "not_found" as const };
        }
        if (target.userId === userId) {
          return { kind: "self_remove_blocked" as const };
        }
        if (target.role === "ORG_OWNER" && access.role !== "ORG_OWNER") {
          return { kind: "owner_remove_requires_owner" as const };
        }
        if (target.role === "ORG_OWNER") {
          const ownerCount = await tx.organizationMembership.count({
            where: { organizationId: orgId, role: "ORG_OWNER" },
          });
          if (ownerCount <= 1) {
            return { kind: "last_owner_protected" as const };
          }
        }

        await tx.organizationMembership.delete({ where: { id: target.id } });

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_MEMBER_REMOVED",
          targetType: "organization_membership",
          targetId: target.id,
          metadata: {
            membershipId: target.id,
            targetUserId: target.userId,
            formerRole: target.role,
          },
        });

        return { kind: "ok" as const, membershipId: target.id };
      });

      switch (result.kind) {
        case "not_found":
          return reply.code(404).send({ message: "Membership not found." });
        case "self_remove_blocked":
          return reply
            .code(409)
            .send({ message: "Cannot remove your own membership." });
        case "owner_remove_requires_owner":
          return reply
            .code(403)
            .send({ message: "Only ORG_OWNER can remove an ORG_OWNER." });
        case "last_owner_protected":
          return reply
            .code(409)
            .send({ message: "Cannot remove the last ORG_OWNER." });
        case "ok":
          return reply
            .code(200)
            .send({ membershipId: result.membershipId, removed: true });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/audit-events
  //
  // List org audit events. Requires ORG_AUDITOR+ (rank ≥ 2).
  //
  // Stage 5 — pagination + filtering hardening:
  //   - `?take=<1..200>`   page size, default 50
  //   - `?cursor=<id>`     opaque cursor (the event id from the previous
  //                         page's `nextCursor`). Stable.
  //   - `?eventType=A,B`   comma-separated allowlist of event types.
  //
  // Stable ordering: (createdAt DESC, id DESC). The id is included as
  // a secondary key so two events created in the same millisecond
  // never alternate page boundaries.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:id/audit-events",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const queryShape = z.object({
        take: z.coerce.number().int().min(1).max(200).optional(),
        cursor: z.string().uuid().optional(),
        eventType: z.string().optional(),
      });
      const q = queryShape.parse(req.query);
      const take = q.take ?? 50;
      const eventTypeFilter = q.eventType
        ? q.eventType
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : null;

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_AUDITOR",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      // The cursor encodes the LAST id of the previous page; we
      // skip ahead one row by passing `cursor: { id }` + skip:1.
      // Combined with the stable (createdAt DESC, id DESC) ordering
      // this produces a deterministic walk.
      const events = await prisma.organizationAuditEvent.findMany({
        where: {
          organizationId: orgId,
          ...(eventTypeFilter
            ? { eventType: { in: eventTypeFilter } }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1, // fetch one extra to compute nextCursor without a second round trip
        ...(q.cursor
          ? { cursor: { id: q.cursor }, skip: 1 }
          : {}),
        select: {
          id: true,
          actorUserId: true,
          eventType: true,
          targetType: true,
          targetId: true,
          metadata: true,
          createdAt: true,
        },
      });

      // Denormalize actor identity for operator-readable display.
      const actorIds = Array.from(
        new Set(events.map((e) => e.actorUserId).filter((x): x is string => !!x)),
      );
      const actors = actorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, email: true, displayName: true },
          })
        : [];
      const actorById = new Map(actors.map((a) => [a.id, a]));

      // Stage 5 pagination — pop the (take+1)th row to compute nextCursor.
      let nextCursor: string | null = null;
      const trimmedEvents = events.slice(0, take);
      if (events.length > take) {
        nextCursor = trimmedEvents[trimmedEvents.length - 1]?.id ?? null;
      }

      return reply.code(200).send({
        organizationId: orgId,
        summary: {
          totalEvents: trimmedEvents.length,
          nextCursor,
          appliedTake: take,
          appliedEventTypeFilter: eventTypeFilter,
        },
        events: trimmedEvents.map((e) => {
          const actor = e.actorUserId ? actorById.get(e.actorUserId) : null;
          return {
            id: e.id,
            actorUserId: e.actorUserId,
            actorEmail: actor?.email ?? null,
            actorDisplayName: actor?.displayName ?? null,
            eventType: e.eventType,
            targetType: e.targetType,
            targetId: e.targetId,
            metadata: e.metadata,
            createdAt: e.createdAt.toISOString(),
          };
        }),
      });
    },
  );
}

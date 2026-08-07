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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import {
  checkOrgAccess,
  listOrgAdminSurfaces,
} from "../services/organization/org-access.js";
// P0 remediation (2026-07-21) — admin org-member removal revokes sessions.
import { revokeAllSessionsForUser } from "../services/identity-security/session-revocation.service.js";
// ARCH-004 — governance-membership transitions have ONE orchestrator.
import {
  restoreOrganizationMembership,
  suspendOrganizationMembership,
} from "../services/identity/org-membership-lifecycle.service.js";
// P2 domain remediation (2026-07-21) — canonical membership provisioning
// (governance + explicit workspace assignments).
import {
  // PHASE 3 completion (2026-07-22) — canonical mutation surface.
  massRevokeWorkspaceMemberships,
  removeOrganizationMembership,
  updateOrganizationMembershipRole,
} from "../services/identity/membership-provisioning.service.js";
// Phase 2.7X Stage 4 — audit emitter (writes inside the mutation tx).
import { emitOrgAuditEvent } from "../services/organization/org-audit.service.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  verifyAccountStepUp,
} from "../services/identity-security/account-step-up.service.js";
import { evaluateOrganizationClosurePreflight } from "../services/identity/account-lifecycle-preflight.service.js";
import {
  ACTIVE_ORG_CLOSURE_STATUSES,
  CANCELLABLE_ORG_CLOSURE_STATUSES,
  ORG_CLOSURE_COOLING_OFF_MS,
} from "../services/organization/org-closure.service.js";
// Phase 2 Blocker 1 — brand-new-owner enterprise auto-completion. Runs
// inside the accept tx after the ORG_OWNER membership is created; a no-op
// for every non-enterprise accept (guarded on pendingEnterpriseSeats).
// PHASE 4 §7.5 (2026-07-22) — organization-workspace suspend/resume.
import {
  resumeOrganizationWorkspace,
  suspendOrganizationWorkspace,
} from "../services/workspace/workspace-lifecycle.service.js";
// PHASE 5 §8 (2026-07-22) — canonical invite acceptance (idempotent +
// concurrency-safe claim).
import { acceptOrganizationInvite } from "../services/organization/org-invite-acceptance.service.js";
import { establishOrganizationSessionContext } from "../services/identity/concurrent-session.service.js";
// Macro-Wave A2 — durable invite delivery (outbox + inline first attempt +
// rotation retry). The outbox row is committed in the SAME transaction as
// the invite; the first email attempt runs inline after commit with the
// create-time raw token; the cron-secret sweep endpoint below drives
// worker-scheduled retries (each retry ROTATES the token hash).
import {
  attemptInitialOrgInviteDelivery,
  getOrgInviteDeliveryStates,
  processDueOrgInviteDeliveries,
  recordOrgInviteDeliveryPending,
  resendOrgInviteDelivery,
} from "../services/organization/org-invite-delivery.service.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";

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
  // P2 domain remediation (2026-07-21) — optional explicit WORKSPACE
  // assignments the accept transaction will grant. Governance-only invites
  // omit this (the previous behavior, unchanged).
  workspaceAssignments: z
    .array(
      z.object({
        teamId: z.string().uuid(),
        role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
      }),
    )
    .max(20)
    .optional(),
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
  /**
   * PHASE 12 CORRECTIVE PASS §2 (2026-08-07) — FOUND BY DRIVING, NOT BY
   * READING. A clean 401 was being turned into a 500.
   *
   * The comment that used to sit on the next line said "requireAuth replies on
   * failure; if we reach here auth succeeded", which is not what the code did:
   * `requireAuth` SENDS a 401 and returns normally, so control DID reach here,
   * `requireLegalAcceptance` sent its own reply on top, and Fastify raised
   * FST_ERR_REP_ALREADY_SENT — surfacing to the caller as a 500.
   *
   * It shows up the moment a token stops being valid mid-session, which is
   * exactly what an Organization suspension now causes (it revokes its
   * members' sessions). A client that should have been told "reauthenticate"
   * was instead told "the server broke".
   *
   * `reply.sent` is the honest check: if a reply has already gone out, this
   * composite's job is done.
   */
  if (reply.sent) return;
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
      // PHASE 2 (2026-07-21) — CUSTOMER organizations only. SYSTEM
      // containers (the internal 1:1 backing rows for Personal / Owned
      // workspaces) must NEVER surface as customer Enterprise
      // Organizations on any product surface.
      // ARCH-004 — the caller's Organization list is a list of places they
      // may enter. A suspended or revoked membership must not appear and then
      // refuse on arrival.
      const rows = await prisma.organizationMembership.findMany({
        where: { userId, status: "ACTIVE", organization: { kind: "CUSTOMER" } },
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
              // ARCH-004 — a member count is a SEAT count. Revoked members
              // occupy no seat, so counting them would bill for people who
              // cannot sign in.
              prisma.organizationMembership.groupBy({
                by: ["organizationId"],
                where: { organizationId: { in: orgIds }, status: "ACTIVE" },
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
          // ARCH-004 — seat occupancy, so ACTIVE only.
          prisma.organizationMembership.count({
            where: { organizationId: orgId, status: "ACTIVE" },
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
        // PHASE 12 POINT 4 STEP 1 — the org-admin surfaces this caller may
        // SEE, derived from the same role vocabulary the endpoint gates use.
        // The web shell renders these ids verbatim instead of filtering its
        // own tab bar by comparing `callerRole` (which failed OPEN while the
        // role was loading). Every leaf endpoint keeps its own
        // `checkOrgAccess(minRole)` gate.
        adminSurfaces: listOrgAdminSurfaces(access.role),
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
      // Phase O Stage 3 (Sentry NODE-1D repair):
      //   - `UuidParam.parse(...)` previously threw a ZodError for any
      //     non-UUID `:id` segment; the central error handler emitted
      //     a 500 and Sentry captured it. The right shape is a
      //     bounded 400 with stable `code` + `requestId`.
      //   - Use safeParse + early return; never let z.parse throw.
      const idParse = UuidParam.safeParse(
        (req.params as { id: string }).id,
      );
      if (!idParse.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_ORG_ID",
            message: "Invalid organization id.",
            requestId: req.id,
          },
        });
      }
      const orgId = idParse.data;
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, { orgId, userId });
      if (access.kind !== "ok") {
        return reply.code(403).send({ message: "Forbidden" });
      }

      // ARCH-004 — the ADMINISTRATION roster deliberately shows every
      // membership, including suspended and revoked ones: an administrator
      // cannot restore what the console will not show them. The status travels
      // with each row so the surface can render it, and nothing here grants
      // access — the leaf endpoints gate on `checkOrgAccess`, which is
      // ACTIVE-only.
      const memberships = await prisma.organizationMembership.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          status: true,
          statusChangedAtUtc: true,
          suspendedAtUtc: true,
          suspensionReason: true,
          revokedAtUtc: true,
          revocationReason: true,
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
  // POST /v1/orgs — RETIRED (PHASE 2, 2026-07-21).
  //
  // This was the ambiguous generic "create organization" path: it created
  // an Organization row with NO `kind` (schema default SYSTEM) and made the
  // caller ORG_OWNER — a SYSTEM container masquerading as a customer
  // Enterprise Organization. Under the canonical domain model:
  //
  //   * self-service creation creates a SYSTEM container + OWNED Workspace
  //     (POST /v1/teams — teams.routes.ts);
  //   * CUSTOMER Enterprise Organizations are created ONLY through
  //     authorized Enterprise provisioning
  //     (services/enterprise-provisioning.service.ts — sales-led).
  //
  // The route stays registered so authenticated legacy clients receive a
  // bounded, explanatory denial instead of a confusing 404. The sole web
  // caller (the /organizations "Create organization" modal) was migrated in
  // the same change.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs",
    { preHandler: requireAuthAndLegal },
    async (_req, reply) => {
      return reply.code(403).send({
        error: {
          code: "org_self_service_creation_retired",
          message:
            "Organizations are provisioned with a PROOVRA Enterprise agreement. To work with a team, create a workspace instead.",
        },
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

      // P2 domain remediation (2026-07-21) — every assigned workspace must
      // belong to THIS organization and must not be a personal space.
      // Validated at create time (fail-closed 400) and re-validated at
      // accept time (teams can move between invite creation and accept).
      if (body.workspaceAssignments && body.workspaceAssignments.length > 0) {
        const teamIds = body.workspaceAssignments.map((a) => a.teamId);
        const orgTeams = await prisma.team.findMany({
          where: { id: { in: teamIds }, organizationId: orgId, isPersonal: false },
          select: { id: true },
        });
        if (orgTeams.length !== new Set(teamIds).size) {
          return reply.code(400).send({
            message:
              "Every assigned workspace must belong to this organization.",
            code: "invalid_workspace_assignment",
          });
        }
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
          // ARCH-004 — only an ACTIVE membership is a duplicate. Inviting
          // somebody whose membership was revoked is a legitimate re-invite,
          // and refusing it as "already_member" would strand them: the row
          // survives revocation now, so the old existence check would have
          // made re-invitation impossible.
          const alreadyMember = await tx.organizationMembership.findFirst({
            where: {
              organizationId: orgId,
              userId: userWithEmail.id,
              status: "ACTIVE",
            },
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
            // P2 — explicit workspace assignments (validated above).
            ...(body.workspaceAssignments &&
            body.workspaceAssignments.length > 0
              ? { workspaceAssignments: body.workspaceAssignments }
              : {}),
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

        // Macro-Wave A2 — durable delivery outbox, committed with the
        // invite (a committed invite ALWAYS has a delivery record; a
        // rolled-back invite never leaves an orphan). Ids only — the raw
        // token is never persisted anywhere.
        const { deliveryId } = await recordOrgInviteDeliveryPending(tx, {
          inviteId: invite.id,
          organizationId: orgId,
          email: body.email,
          initiatedByUserId: userId,
        });

        return {
          kind: "ok" as const,
          inviteId: invite.id,
          expiresAt: invite.expiresAt,
          token,
          deliveryId,
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

      // Macro-Wave A2 — inline FIRST delivery attempt, after commit, with
      // the create-time raw token still in memory. Never throws; on
      // failure the row stays PENDING and the worker-driven sweep retries
      // with token rotation.
      const [orgRow, inviterRow] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: orgId },
          select: { name: true },
        }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { displayName: true, email: true },
        }),
      ]);
      const delivery = await attemptInitialOrgInviteDelivery({
        deliveryId: result.deliveryId,
        rawToken: result.token,
        organizationName: orgRow?.name ?? "your organization",
        role: inviteRole,
        inviterDisplay: inviterRow?.displayName || inviterRow?.email || null,
        expiresAt: result.expiresAt,
      });

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
        // Macro-Wave A2 — delivery state (PENDING/SENT/FAILED + attempts).
        delivery,
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

      // PHASE 5 §8 (2026-07-22) — acceptance moved into the canonical
      // service: idempotent same-user replay + guarded atomic claim
      // (concurrency-safe; grants written exactly once). Raw-token
      // handling stays here (Stage 6 hash-lookup contract).
      const result = await acceptOrganizationInvite({
        tokenHash: hashInviteToken(token),
        userId,
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
      if (result.kind === "org_unavailable") {
        // §8.1 — archived/suspended target; same class as revoked/expired
        // (410, no org-existence detail).
        return reply
          .code(410)
          .send({ message: "This organization is not accepting members." });
      }

      // PHASE 10 §2.2 — GOVERNANCE-ONLY SUCCESS. Membership acceptance is
      // durable + idempotent (grants written exactly once by the orchestrator
      // above). Now ATTEMPT to open the Organization session context under the
      // advisory-locked concurrent-session limit. If acceptance succeeded but
      // the limit blocks opening, we return invitationAccepted=true +
      // workspaceOpened=false + reason — the accepted membership STANDS (no
      // silent rollback), and the UI offers a session-management/retry action.
      let workspaceOpened = true;
      let openReason: string | null = null;
      const inviteSessionHash = req.user?.sessionIdHash;
      if (inviteSessionHash) {
        const seat = await establishOrganizationSessionContext(
          { userId, organizationId: result.organizationId, sessionIdHash: inviteSessionHash },
          prisma,
        );
        if (!seat.allowed) {
          workspaceOpened = false;
          openReason =
            seat.reason === "concurrent_session_limit_reached"
              ? "CONCURRENT_SESSION_LIMIT_REACHED"
              : seat.reason;
        }
      }

      // Phase 2 Blocker 1 — when the brand-new-owner enterprise completion
      // ran, surface the new workspace id + the setup-wizard redirect so the
      // frontend lands the owner in /organizations/:id/setup.
      return reply.code(200).send({
        invitationAccepted: true,
        workspaceOpened,
        ...(openReason ? { reason: openReason } : {}),
        organizationId: result.organizationId,
        role: result.role,
        // P2 — explicit workspace grants (empty = governance-only invite).
        assignedWorkspaceIds: result.assignedWorkspaceIds,
        // PHASE 5 §8 — true when this accept was a same-user retry of an
        // already-consumed invite (no new grants were written).
        ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
        ...(result.enterpriseWorkspaceId
          ? { enterpriseWorkspaceId: result.enterpriseWorkspaceId }
          : {}),
        ...(result.setupRedirect ? { setupRedirect: result.setupRedirect } : {}),
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

      // Macro-Wave A2 — delivery observability (PENDING/SENT/FAILED +
      // attempts + bounded lastError). Never contains tokens or URLs.
      const deliveryByInvite = await getOrgInviteDeliveryStates(
        invites.map((i) => i.id),
      );

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
          delivery: deliveryByInvite.get(i.id) ?? null,
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

      // Macro-Wave A2 — an operator resend now ACTUALLY re-delivers: the
      // delivery service rotates the token hash (the previously emailed
      // link dies), emails the fresh accept URL, and records the outcome
      // on the durable delivery row. The fresh URL is returned ONCE to
      // this authorized admin (display-once parity with create) and is
      // never persisted.
      const resent = await resendOrgInviteDelivery({
        inviteId: result.inviteId,
        organizationId: orgId,
        email: result.email,
        actorUserId: userId,
      });

      return reply.code(200).send({
        inviteId: result.inviteId,
        email: result.email,
        role: result.role,
        expiresAt: result.expiresAt.toISOString(),
        resendCount: result.resendCount,
        delivery: resent?.state ?? null,
        acceptUrl: resent?.acceptUrl ?? null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/org-invite-deliveries/process  (Macro-Wave A2 — internal)
  //
  // Cron-secret-guarded sweep trigger for stranded/due PENDING invite
  // deliveries. Called by the worker's interval scheduler (the SAME
  // worker→API machine-auth pattern as /v1/integrations/
  // process-webhook-retries). Each retry attempt atomically claims the
  // row and ROTATES the invite token hash — the raw token exists only in
  // memory for the duration of the send.
  // -------------------------------------------------------------------------
  app.post("/v1/org-invite-deliveries/process", async (req, reply) => {
    const ok = await requireIntegrationCronSecret(req, reply);
    if (!ok) return;
    const body = z
      .object({ batchSize: z.number().int().min(1).max(200).optional() })
      .parse(req.body ?? {});
    const summary = await processDueOrgInviteDeliveries({
      batchSize: body.batchSize,
    });
    return reply.code(200).send({ summary });
  });

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
          // ARCH-004 — a REVOKED owner protects nothing. Counting them
          // would let the last LIVE owner be demoted, leaving the
          // Organization with no one who can administer it.
          const ownerCount = await tx.organizationMembership.count({
            where: { organizationId: orgId, role: "ORG_OWNER", status: "ACTIVE" },
          });
          if (ownerCount <= 1) {
            return { kind: "last_owner_protected" as const };
          }
        }

        if (target.role === newRole) {
          return { kind: "noop" as const, membershipId: target.id };
        }

        // PHASE 3 — canonical orchestrator: manual governance role change.
        await updateOrganizationMembershipRole(tx, {
          organizationMembershipId: target.id,
          role: newRole,
          actorUserId: userId,
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
          // ARCH-004 — as above: only a LIVE owner counts toward the
          // last-owner protection.
          const ownerCount = await tx.organizationMembership.count({
            where: { organizationId: orgId, role: "ORG_OWNER", status: "ACTIVE" },
          });
          if (ownerCount <= 1) {
            return { kind: "last_owner_protected" as const };
          }
        }

        // PHASE 3 — canonical orchestrator: governance removal (provenance closed).
        await removeOrganizationMembership(tx, {
          organizationMembershipId: target.id,
          actorUserId: userId,
        });

        // -------------------------------------------------------------------
        // P0 remediation (2026-07-21) — admin removal must be at least as
        // strong an off-board as self-service /leave. Previously this path
        // deleted ONLY the governance membership, leaving the target's
        // workspace access (TeamMember), active-context pointer, and
        // sessions fully intact.
        //
        // (b) workspace layer — REVOKE (never erase) the target's ACTIVE
        //     memberships on teams OWNED by this organization; personal +
        //     other-org teams are untouched.
        // -------------------------------------------------------------------
        const orgTeams = await tx.team.findMany({
          where: { organizationId: orgId, isPersonal: false },
          select: { id: true },
        });
        const orgTeamIds = orgTeams.map((t) => t.id);
        let workspacesDeactivated = 0;
        if (orgTeamIds.length > 0) {
          // PHASE 3 — canonical mass revocation (provenance closed per member).
          const upd = await massRevokeWorkspaceMemberships(tx, {
            where: { userId: target.userId, teamIds: orgTeamIds },
            actorUserId: userId,
            reason: "organization admin removal",
          });
          workspacesDeactivated = upd.count;
        }

        // (c) active-workspace fallback — clear a now-inaccessible pointer;
        //     platform-context bootstrap restores the personal workspace.
        await tx.user.updateMany({
          where: {
            id: target.userId,
            currentWorkspaceId: { in: orgTeamIds },
          },
          data: { currentWorkspaceId: null },
        });

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
            workspacesDeactivated,
          },
        });

        return {
          kind: "ok" as const,
          membershipId: target.id,
          targetUserId: target.userId,
        };
      });

      // P0 remediation (2026-07-21) — (d) session revocation. Sessions are
      // account-global JWTs; revoking forces a fresh login (the target can
      // immediately log back into their untouched Personal Space). Best-
      // effort AFTER the transaction: access is already denied server-side
      // by the REVOKED memberships even if this write fails.
      if (result.kind === "ok") {
        try {
          await revokeAllSessionsForUser(
            {
              teamId: null,
              userId: result.targetUserId,
              reason: "ORG_MEMBER_REMOVED",
              actorUserId: userId,
            },
            prisma,
          );
        } catch {
          /* deny-list write is best-effort; memberships already REVOKED */
        }
      }

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
  // POST /v1/orgs/:id/members/:memberId/suspend
  // POST /v1/orgs/:id/members/:memberId/restore
  //
  // PHASE 12 CORRECTIVE PASS §2 (ARCH-004, 2026-08-07) — THE REVERSIBLE HALF.
  //
  // Before this, an administrator who wanted to pause somebody's governance
  // access had exactly one option: removal, which was a physical DELETE. So
  // "pause" was performed as "delete and re-invite later", which destroyed the
  // history and produced an invitation the person had to accept again.
  //
  // These two routes are the reversible half the model was missing. Both go
  // through the ONE lifecycle orchestrator, which stamps actor/time/reason,
  // emits the audit event, and fences the transition against a concurrent one
  // — so a simultaneous suspend and restore produces one deterministic winner
  // instead of last-writer-wins.
  //
  // Guarded exactly like the role-change and removal routes: ORG_ADMIN+, no
  // acting on yourself, and an ORG_OWNER may only be acted on by an ORG_OWNER.
  // -------------------------------------------------------------------------
  const LifecycleBody = z.object({
    reason: z.string().min(1).max(400).optional(),
    /**
     * Optimistic concurrency. A console that read the roster and then acted
     * echoes the generation it saw; a stale one loses and is told so, rather
     * than silently overwriting a transition somebody else made in between.
     */
    expectedGeneration: z.number().int().min(0).optional(),
  });

  /**
   * Registered EXPLICITLY, twice, rather than in a loop over the two actions.
   *
   * A loop reads better and produced exactly one problem: the route inventory
   * that keeps the capability map honest scans this file for registration
   * literals, and a template literal gave it
   * `POST /v1/orgs/:id/members/:memberId/` — a path that exists in no
   * router. A route table that cannot be read by the thing auditing it is a
   * route table with a blind spot, and the audit is worth more than the four
   * saved lines.
   */
  const membershipLifecycleHandler =
    (action: "suspend" | "restore") =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const orgId = UuidParam.parse((req.params as { id: string }).id);
        const memberId = UuidParam.parse(
          (req.params as { memberId: string }).memberId,
        );
        const userId = getAuthUserId(req);
        const body = LifecycleBody.parse(req.body ?? {});

        const access = await checkOrgAccess(prisma, {
          orgId,
          userId,
          minRole: "ORG_ADMIN",
        });
        if (access.kind !== "ok") {
          // Same shape the sibling member-administration routes use.
          return reply.code(403).send({ message: "Forbidden" });
        }

        const target = await prisma.organizationMembership.findFirst({
          where: { id: memberId, organizationId: orgId },
          select: { id: true, userId: true, role: true, status: true },
        });
        if (!target) {
          return reply.code(404).send({ message: "Membership not found." });
        }
        if (target.userId === userId) {
          return reply
            .code(409)
            .send({ message: "Cannot change your own membership status." });
        }
        if (target.role === "ORG_OWNER" && access.role !== "ORG_OWNER") {
          return reply
            .code(403)
            .send({ message: "Only ORG_OWNER can act on an ORG_OWNER." });
        }
        // Suspending the last live owner would leave the Organization with
        // nobody able to administer it — the same protection removal has.
        if (action === "suspend" && target.role === "ORG_OWNER") {
          const liveOwners = await prisma.organizationMembership.count({
            where: { organizationId: orgId, role: "ORG_OWNER", status: "ACTIVE" },
          });
          if (liveOwners <= 1) {
            return reply
              .code(409)
              .send({ message: "Cannot suspend the last ORG_OWNER." });
          }
        }

        const outcome =
          action === "suspend"
            ? await suspendOrganizationMembership({
                organizationId: orgId,
                membershipId: target.id,
                actorUserId: userId,
                source: "MANUAL",
                reason: body.reason ?? null,
                ...(body.expectedGeneration !== undefined
                  ? { expectedGeneration: body.expectedGeneration }
                  : {}),
              })
            : await restoreOrganizationMembership({
                organizationId: orgId,
                membershipId: target.id,
                actorUserId: userId,
                source: "MANUAL",
                reason: body.reason ?? null,
                ...(body.expectedGeneration !== undefined
                  ? { expectedGeneration: body.expectedGeneration }
                  : {}),
              });

        if (!outcome.ok) {
          switch (outcome.reason) {
            case "not_found":
              return reply.code(404).send({ message: "Membership not found." });
            case "stale_generation":
              return reply.code(409).send({
                message:
                  "This membership changed while you were looking at it. Reload and try again.",
                code: "STALE_MEMBERSHIP_GENERATION",
                currentGeneration: outcome.currentGeneration,
              });
            case "illegal_transition":
              return reply.code(409).send({
                message: `A ${outcome.from.toLowerCase()} membership cannot be ${action}d.`,
                code: "ILLEGAL_MEMBERSHIP_TRANSITION",
              });
          }
        }

        // A SUSPENDED member's live sessions must stop being useful now, not
        // at token expiry. Best-effort AFTER the durable transition — access is
        // already denied server-side even if this write fails.
        if (action === "suspend") {
          try {
            await revokeAllSessionsForUser(
              {
                teamId: null,
                userId: target.userId,
                // The canonical revocation vocabulary already has this reason; a
                // new ORG_-prefixed twin would be a second name for one fact.
                reason: "MEMBER_SUSPENDED",
                actorUserId: userId,
              },
              prisma,
            );
          } catch {
            /* deny-list write is best-effort; the membership is already SUSPENDED */
          }
        }

        return reply.code(200).send({
          membershipId: target.id,
          status: outcome.status,
          generation: outcome.generation,
          changed: outcome.changed,
        });
      };

  app.post(
    "/v1/orgs/:id/members/:memberId/suspend",
    { preHandler: requireAuthAndLegal },
    membershipLifecycleHandler("suspend"),
  );
  app.post(
    "/v1/orgs/:id/members/:memberId/restore",
    { preHandler: requireAuthAndLegal },
    membershipLifecycleHandler("restore"),
  );

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/leave
  //
  // Self-service leave-organization (2026-07-16, lifecycle Phase 1).
  //
  //   - Any ACTIVE member below ORG_OWNER may leave their own membership.
  //   - ORG_OWNER is BLOCKED (stable code OWNERSHIP_TRANSFER_REQUIRED):
  //     an owner must transfer ownership or close the organization first —
  //     an organization can never be left ownerless.
  //   - One transaction: (a) delete the OrganizationMembership row (the
  //     repo's canonical removal semantics — attribution is preserved in
  //     the immutable org audit event, mirroring the admin-removal route
  //     above); (b) set the caller's TeamMember rows INACTIVE on every
  //     workspace Team belonging to this organization (workspace access
  //     revocation — TeamMember rows are retained INACTIVE, never erased,
  //     so historical actor attribution on evidence/custody stays intact);
  //     (c) clear the caller's currentWorkspaceId if it points at one of
  //     those teams (the platform-context bootstrap then falls back to the
  //     personal workspace on next load — proven recovery path).
  //   - Access/session invalidation: org access is authorized per-request
  //     from OrganizationMembership + ACTIVE TeamMember rows (the JWT
  //     carries no org claims), so revocation is effective immediately on
  //     the next request; account-level sessions are intentionally NOT
  //     revoked (leaving an org does not sign you out of your account).
  //   - Audited twice: ORG_MEMBER_LEFT in the org audit stream (visible to
  //     org admins/owners on the existing audit surface) and an
  //     identity.organization_left platform audit event (visible in the
  //     user's own Account & Security Activity timeline).
  //   - Idempotent-safe: a second call after leaving returns 404
  //     membership_not_found (no destructive re-execution).
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs/:id/leave",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const result = await prisma.$transaction(async (tx) => {
        const membership = await tx.organizationMembership.findFirst({
          where: { organizationId: orgId, userId },
          select: { id: true, role: true },
        });
        if (!membership) {
          return { kind: "not_found" as const };
        }
        if (membership.role === "ORG_OWNER") {
          return { kind: "ownership_transfer_required" as const };
        }

        // (a) governance membership — delete (canonical removal semantics).
        // PHASE 3 — canonical orchestrator: self-leave governance removal.
        await removeOrganizationMembership(tx, {
          organizationMembershipId: membership.id,
          actorUserId: userId,
        });

        // (b) workspace layer — deactivate, never erase. Scoped to teams
        // OWNED by this organization only; personal + other-org teams are
        // untouched.
        const orgTeams = await tx.team.findMany({
          where: { organizationId: orgId, isPersonal: false },
          select: { id: true },
        });
        const orgTeamIds = orgTeams.map((t) => t.id);
        let workspacesDeactivated = 0;
        if (orgTeamIds.length > 0) {
          // TeamMemberStatus has no INACTIVE — REVOKED is the canonical
          // access-revocation state (the platform envelope projects any
          // non-ACTIVE status as an INACTIVE membership).
          // PHASE 3 — canonical mass revocation (provenance closed per member).
          const upd = await massRevokeWorkspaceMemberships(tx, {
            where: { userId, teamIds: orgTeamIds },
            actorUserId: userId,
            reason: "organization self-leave",
          });
          workspacesDeactivated = upd.count;
        }

        // (c) active-workspace fallback — clear a now-inaccessible pointer;
        // the platform-context bootstrap restores the personal workspace.
        const me = await tx.user.findUnique({
          where: { id: userId },
          select: { currentWorkspaceId: true },
        });
        let workspaceFallback = false;
        if (
          me?.currentWorkspaceId &&
          orgTeamIds.includes(me.currentWorkspaceId)
        ) {
          await tx.user.update({
            where: { id: userId },
            data: { currentWorkspaceId: null },
          });
          workspaceFallback = true;
        }

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_MEMBER_LEFT",
          targetType: "organization_membership",
          targetId: membership.id,
          metadata: {
            membershipId: membership.id,
            formerRole: membership.role,
            workspacesDeactivated,
            workspaceFallback,
          },
        });

        return {
          kind: "ok" as const,
          formerRole: membership.role,
          workspacesDeactivated,
          workspaceFallback,
        };
      });

      switch (result.kind) {
        case "not_found":
          return reply
            .code(404)
            .send({ error: { code: "membership_not_found" } });
        case "ownership_transfer_required":
          return reply.code(409).send({
            error: {
              code: "OWNERSHIP_TRANSFER_REQUIRED",
              message:
                "You are the organization owner. Transfer ownership or close the organization before leaving.",
            },
          });
        case "ok": {
          // Personal Account & Security Activity timeline (best-effort;
          // the org audit event above is the durable record).
          await emitTenantAudit({
            action: "identity.organization_left",
            outcome: "success",
            sourceApp: "API",
            actorUserId: userId,
            organizationId: orgId,
            resourceType: "organization",
            resourceId: orgId,
            correlationId: req.id,
            metadata: {
              formerRole: result.formerRole,
              workspacesDeactivated: result.workspacesDeactivated,
            },
          }).catch(() => null);
          return reply.code(200).send({
            left: true,
            formerRole: result.formerRole,
            workspacesDeactivated: result.workspacesDeactivated,
            workspaceFallback: result.workspaceFallback,
          });
        }
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/transfer-ownership   (lifecycle Phase 6, 2026-07-17)
  //
  // ORG_OWNER-only, step-up-gated, ATOMIC ownership transfer:
  //   - target must be an EXISTING member of this org (never an outsider);
  //   - one transaction: target → ORG_OWNER, caller → ORG_ADMIN — the org
  //     is never observable with zero or two owners;
  //   - org-level billing ownership follows the owner when it pointed at
  //     the caller;
  //   - audited in the org stream (ORG_OWNERSHIP_TRANSFERRED) and on BOTH
  //     parties' personal activity timelines.
  // This completes the owner path out of an organization: transfer, then
  // the (now non-owner) caller may use POST /v1/orgs/:id/leave.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs/:id/transfer-ownership",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);
      const body = z
        .object({
          targetUserId: z.string().uuid(),
          stepUp: z
            .object({
              method: z.enum(["password", "mfa"]).optional(),
              currentPassword: z.string().optional(),
              code: z.string().optional(),
            })
            .optional(),
        })
        .parse(req.body ?? {});

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_OWNER",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "owner_required" } });
      }
      if (body.targetUserId === userId) {
        return reply
          .code(400)
          .send({ error: { code: "transfer_to_self" } });
      }

      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "org_ownership_transfer",
        proof: body.stepUp,
      });
      if (!stepUp.ok) {
        return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      }

      const result = await prisma.$transaction(async (tx) => {
        const caller = await tx.organizationMembership.findFirst({
          where: { organizationId: orgId, userId, role: "ORG_OWNER" },
          select: { id: true },
        });
        if (!caller) return { kind: "owner_required" as const };
        const target = await tx.organizationMembership.findFirst({
          where: { organizationId: orgId, userId: body.targetUserId },
          select: { id: true, role: true },
        });
        if (!target) return { kind: "target_not_member" as const };

        // Atomic swap — never zero owners, never two.
        // PHASE 3 — canonical orchestrator: atomic ownership swap (both
        // legs provenance-recorded; the enclosing tx keeps it atomic).
        await updateOrganizationMembershipRole(tx, {
          organizationMembershipId: target.id,
          role: "ORG_OWNER",
          actorUserId: userId,
        });
        await updateOrganizationMembershipRole(tx, {
          organizationMembershipId: caller.id,
          role: "ORG_ADMIN",
          actorUserId: userId,
        });

        // Billing ownership follows the owner when it pointed at the
        // outgoing owner.
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { billingOwnerUserId: true },
        });
        let billingOwnerTransferred = false;
        if (org?.billingOwnerUserId === userId) {
          await tx.organization.update({
            where: { id: orgId },
            data: { billingOwnerUserId: body.targetUserId },
          });
          billingOwnerTransferred = true;
        }

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_OWNERSHIP_TRANSFERRED",
          targetType: "organization_membership",
          targetId: target.id,
          metadata: {
            fromUserId: userId,
            toUserId: body.targetUserId,
            previousTargetRole: target.role,
            billingOwnerTransferred,
          },
        });
        return { kind: "ok" as const, billingOwnerTransferred };
      });

      if (result.kind === "owner_required") {
        return reply.code(403).send({ error: { code: "owner_required" } });
      }
      if (result.kind === "target_not_member") {
        return reply
          .code(404)
          .send({ error: { code: "target_not_member" } });
      }

      // Both parties see the transfer on their own activity timelines.
      for (const [party, role] of [
        [userId, "previous_owner"],
        [body.targetUserId, "new_owner"],
      ] as const) {
        await emitTenantAudit({
          action: "identity.organization_ownership_transferred",
          outcome: "success",
          sourceApp: "API",
          actorUserId: party,
          organizationId: orgId,
          resourceType: "organization",
          resourceId: orgId,
          correlationId: req.id,
          metadata: { role, billingOwnerTransferred: result.billingOwnerTransferred },
        }).catch(() => null);
      }

      return reply.code(200).send({
        transferred: true,
        newOwnerUserId: body.targetUserId,
        billingOwnerTransferred: result.billingOwnerTransferred,
      });
    },
  );

  // -------------------------------------------------------------------------
  // PHASE 4 §7.5 (2026-07-22) — organization-workspace suspend/resume.
  // ORG_ADMIN-scoped, reversible. Effects live in
  // workspace-lifecycle.service.ts: memberships → SUSPENDED with a marker
  // reason (resume reverts exactly those rows), switcher pointers cleared,
  // webhook delivery paused. Evidence/audit untouched.
  // -------------------------------------------------------------------------
  for (const [leg, fn] of [
    ["suspend", suspendOrganizationWorkspace],
    ["resume", resumeOrganizationWorkspace],
  ] as const) {
    app.post(
      `/v1/orgs/:id/workspaces/:teamId/${leg}`,
      { preHandler: requireAuthAndLegal },
      async (req, reply) => {
        const params = z
          .object({ id: z.string().uuid(), teamId: z.string().uuid() })
          .parse(req.params);
        const userId = getAuthUserId(req);
        const access = await checkOrgAccess(prisma, {
          orgId: params.id,
          userId,
          minRole: "ORG_ADMIN",
        });
        if (access.kind !== "ok") {
          return reply.code(403).send({ error: { code: "admin_required" } });
        }
        try {
          const result = await fn({
            teamId: params.teamId,
            actorUserId: userId,
            organizationId: params.id,
          });
          return reply.code(200).send({ [leg]: result });
        } catch (err) {
          const e = err as Error & { statusCode?: number; code?: string };
          if (typeof e.statusCode === "number" && typeof e.code === "string") {
            return reply
              .code(e.statusCode)
              .send({ error: { code: e.code.toLowerCase() } });
          }
          throw err;
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // Organization closure (lifecycle Phase 6, 2026-07-17)
  //
  //   GET  /v1/orgs/:id/closure                     — latest request + live
  //                                                   preflight blockers
  //   POST /v1/orgs/:id/closure                     — request closure
  //   POST /v1/orgs/:id/closure/:requestId/cancel   — cancel in cooling-off
  //
  // ORG_OWNER-only. Typed confirmation phrase validated server-side +
  // step-up. Same asynchronous state machine as account closure: the row
  // enters COOLING_OFF and the closure worker (digest cron) re-checks
  // preflight before PROCESSING. Execution archives — never deletes.
  // -------------------------------------------------------------------------
  const ORG_CLOSURE_CONFIRMATION_PHRASE = "close this organization";
  const ORG_CLOSURE_SELECT = {
    id: true,
    status: true,
    reason: true,
    blockersJson: true,
    requestedAtUtc: true,
    coolingOffEndsAtUtc: true,
    cancelledAtUtc: true,
    completedAtUtc: true,
    failureCode: true,
  } as const;

  app.get(
    "/v1/orgs/:id/closure",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);
      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_OWNER",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "owner_required" } });
      }
      const [latest, preflight] = await Promise.all([
        prisma.organizationClosureRequest.findFirst({
          where: { organizationId: orgId },
          select: ORG_CLOSURE_SELECT,
          orderBy: { requestedAtUtc: "desc" },
        }),
        evaluateOrganizationClosurePreflight(orgId, userId),
      ]);
      return reply.code(200).send({
        request: latest,
        blockers: preflight.blockers,
        confirmationPhrase: ORG_CLOSURE_CONFIRMATION_PHRASE,
        coolingOffDays: Math.round(ORG_CLOSURE_COOLING_OFF_MS / 86_400_000),
      });
    },
  );

  app.post(
    "/v1/orgs/:id/closure",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);
      const body = z
        .object({
          confirmation: z.string().max(120),
          reason: z.string().max(500).optional(),
          stepUp: z
            .object({
              method: z.enum(["password", "mfa"]).optional(),
              currentPassword: z.string().optional(),
              code: z.string().optional(),
            })
            .optional(),
        })
        .parse(req.body ?? {});

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_OWNER",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "owner_required" } });
      }

      // Typed confirmation — validated SERVER-SIDE, never a boolean.
      if (
        body.confirmation.trim().toLowerCase() !==
        ORG_CLOSURE_CONFIRMATION_PHRASE
      ) {
        return reply.code(400).send({
          error: {
            code: "confirmation_mismatch",
            message: `Type "${ORG_CLOSURE_CONFIRMATION_PHRASE}" to confirm.`,
          },
        });
      }

      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "org_closure_request",
        proof: body.stepUp,
      });
      if (!stepUp.ok) {
        return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      }

      const open = await prisma.organizationClosureRequest.findFirst({
        where: {
          organizationId: orgId,
          status: { in: [...ACTIVE_ORG_CLOSURE_STATUSES] },
        },
        select: { id: true },
      });
      if (open) {
        return reply.code(409).send({
          error: {
            code: "closure_request_active",
            message: "A closure request for this organization is already open.",
          },
        });
      }

      const { blockers } = await evaluateOrganizationClosurePreflight(
        orgId,
        userId,
      );
      if (blockers.length > 0) {
        const blocked = await prisma.$transaction(async (tx) => {
          const row = await tx.organizationClosureRequest.create({
            data: {
              organizationId: orgId,
              requestedByUserId: userId,
              status: "BLOCKED",
              reason: body.reason ?? null,
              blockersJson: JSON.stringify(blockers),
            },
            select: { id: true },
          });
          await emitOrgAuditEvent(tx, {
            organizationId: orgId,
            actorUserId: userId,
            eventType: "ORG_CLOSURE_BLOCKED",
            targetType: "organization",
            targetId: orgId,
            metadata: { blockers: blockers.map((b) => b.code) },
          });
          return row;
        });
        await emitTenantAudit({
          action: "identity.organization_closure_blocked",
          outcome: "denied",
          denialReason: "closure_blocked",
          sourceApp: "API",
          actorUserId: userId,
          organizationId: orgId,
          resourceType: "organization_closure_request",
          resourceId: blocked.id,
          correlationId: req.id,
          metadata: { blockers: blockers.map((b) => b.code) },
        }).catch(() => null);
        return reply
          .code(409)
          .send({ error: { code: "closure_blocked" }, blockers });
      }

      const coolingOffEndsAtUtc = new Date(
        Date.now() + ORG_CLOSURE_COOLING_OFF_MS,
      );
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.organizationClosureRequest.create({
          data: {
            organizationId: orgId,
            requestedByUserId: userId,
            status: "COOLING_OFF",
            reason: body.reason ?? null,
            coolingOffEndsAtUtc,
          },
          select: ORG_CLOSURE_SELECT,
        });
        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "ORG_CLOSURE_REQUESTED",
          targetType: "organization",
          targetId: orgId,
          metadata: {
            coolingOffEndsAtUtc: coolingOffEndsAtUtc.toISOString(),
          },
        });
        return row;
      });
      await emitTenantAudit({
        action: "identity.organization_closure_requested",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        organizationId: orgId,
        resourceType: "organization_closure_request",
        resourceId: created.id,
        correlationId: req.id,
        metadata: { coolingOffEndsAtUtc: coolingOffEndsAtUtc.toISOString() },
      }).catch(() => null);
      return reply.code(201).send({ request: created });
    },
  );

  app.post(
    "/v1/orgs/:id/closure/:requestId/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid(), requestId: z.string().uuid() })
        .parse(req.params);
      const userId = getAuthUserId(req);
      const access = await checkOrgAccess(prisma, {
        orgId: params.id,
        userId,
        minRole: "ORG_OWNER",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "owner_required" } });
      }

      const cancelled = await prisma.$transaction(async (tx) => {
        const upd = await tx.organizationClosureRequest.updateMany({
          where: {
            id: params.requestId,
            organizationId: params.id,
            status: { in: [...CANCELLABLE_ORG_CLOSURE_STATUSES] },
          },
          data: { status: "CANCELLED", cancelledAtUtc: new Date() },
        });
        if (upd.count === 0) return false;
        await emitOrgAuditEvent(tx, {
          organizationId: params.id,
          actorUserId: userId,
          eventType: "ORG_CLOSURE_CANCELLED",
          targetType: "organization",
          targetId: params.id,
          metadata: { requestId: params.requestId },
        });
        return true;
      });
      if (!cancelled) {
        const exists = await prisma.organizationClosureRequest.findFirst({
          where: { id: params.requestId, organizationId: params.id },
          select: { id: true },
        });
        if (!exists) {
          return reply.code(404).send({ error: { code: "closure_not_found" } });
        }
        return reply
          .code(409)
          .send({ error: { code: "closure_not_cancellable" } });
      }

      await emitTenantAudit({
        action: "identity.organization_closure_cancelled",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        organizationId: params.id,
        resourceType: "organization_closure_request",
        resourceId: params.requestId,
        correlationId: req.id,
        metadata: {},
      }).catch(() => null);
      const row = await prisma.organizationClosureRequest.findFirst({
        where: { id: params.requestId, organizationId: params.id },
        select: ORG_CLOSURE_SELECT,
      });
      return reply.code(200).send({ request: row });
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

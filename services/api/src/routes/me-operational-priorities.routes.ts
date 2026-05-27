/**
 * Phase A.1C — Account-level operational priorities.
 *
 * GET /v1/me/operational-priorities
 *
 * Returns the small set of "what needs your attention right now"
 * signals that live ABOVE any specific workspace context — the
 * signals the workspace-scoped `/v1/dashboard/command-center` cannot
 * see because it is anchored to one teamId.
 *
 * Visible only to the caller. The body is the caller's perspective on
 * THEIR account; no enumeration of other users' state, no aggregation
 * across organizations the caller is not a member of.
 *
 * Hard rules:
 *
 *   - Authoritative scope = THE CALLER. We never return data scoped
 *     to a different user, even if the caller is an ORG_OWNER. Org-
 *     level governance signals (pending invites for the org, MFA
 *     posture across members, etc.) belong on `/v1/orgs/:id/...`
 *     surfaces and have their own RBAC there.
 *
 *   - No evidence / case / reviewer counts are returned here. Those
 *     remain workspace-scoped. This endpoint is governance + identity
 *     posture only.
 *
 *   - Pending org invites are matched by EMAIL. Stage 5 of Phase 2.7X
 *     made invite acceptance email-matched, so a user with no email
 *     (guest) sees an empty `pendingOrgInvites` array — that is the
 *     correct, non-leaky behavior. Guests cannot accept email-matched
 *     invites until they bind an email.
 *
 *   - The response shape is small and stable; we lock it in tests.
 *     Adding new fields is non-breaking, removing them is breaking.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";

async function requireAuthAndLegal(
  req: FastifyRequest,
  reply: Parameters<typeof requireAuth>[1],
) {
  await requireAuth(req, reply);
  await requireLegalAcceptance(req, reply);
}

export async function meOperationalPrioritiesRoutes(app: FastifyInstance) {
  app.get(
    "/v1/me/operational-priorities",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const now = new Date();

      // -----------------------------------------------------------------
      // Caller identity probe.
      // -----------------------------------------------------------------
      // We need the caller's email to match against open invites. We
      // also surface whether the caller has accepted legal terms — the
      // gate is already passed by `requireAuthAndLegal`, but we report
      // the flag so the dashboard can render an honest "you're fully
      // onboarded" hint.
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          createdAt: true,
        },
      });
      if (!me) {
        return reply.code(401).send({ message: "Unknown caller" });
      }

      // -----------------------------------------------------------------
      // Account-level org context.
      // -----------------------------------------------------------------
      const membershipRows = await prisma.organizationMembership.findMany({
        where: { userId },
        select: {
          role: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      const orgs = membershipRows.map((m) => ({
        organizationId: m.organization.id,
        name: m.organization.name,
        status: m.organization.status,
        role: m.role,
        memberSince: m.createdAt.toISOString(),
      }));

      // -----------------------------------------------------------------
      // Pending org invites addressed to the caller's email.
      //
      // An invite is "actionable" for the caller when:
      //   - the caller has a stable email (non-null) AND
      //   - the invite is unaccepted AND unrevoked AND not expired AND
      //   - the invite's email matches the caller's email (case-insensitive).
      //
      // We deliberately do NOT return invites the caller can VIEW as an
      // admin of the inviting org — those are surfaced on
      // /v1/orgs/:id/invites. This endpoint is the *invitee's*
      // perspective: "what invites am I being asked to accept right now."
      // -----------------------------------------------------------------
      const callerEmail = (me.email ?? "").trim().toLowerCase();
      const pendingOrgInvites = callerEmail
        ? (
            await prisma.organizationInvite.findMany({
              where: {
                email: callerEmail,
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: now },
              },
              select: {
                id: true,
                role: true,
                expiresAt: true,
                createdAt: true,
                organization: {
                  select: { id: true, name: true },
                },
              },
              orderBy: { createdAt: "asc" },
            })
          ).map((r) => ({
            inviteId: r.id,
            organizationId: r.organization.id,
            organizationName: r.organization.name,
            role: r.role,
            expiresAt: r.expiresAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
          }))
        : [];

      // -----------------------------------------------------------------
      // Org-admin governance hotspots (the caller's perspective as an
      // org admin, NOT as an invitee).
      //
      // For each org where the caller has ORG_OWNER / ORG_ADMIN, surface
      // ONE count: pending invites the caller can act on (revoke /
      // resend). This is the same governance signal exposed per-org by
      // /v1/me/orgs.orgs[].pendingInviteCount, but rolled up so the
      // dashboard can render a single "X orgs need invite attention"
      // chip without re-fetching the list.
      // -----------------------------------------------------------------
      const adminOrgIds = membershipRows
        .filter((m) => m.role === "ORG_OWNER" || m.role === "ORG_ADMIN")
        .map((m) => m.organization.id);
      const adminPendingByOrg =
        adminOrgIds.length === 0
          ? []
          : await prisma.organizationInvite.groupBy({
              by: ["organizationId"],
              where: {
                organizationId: { in: adminOrgIds },
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: now },
              },
              _count: { id: true },
            });

      const adminPendingInviteCount = adminPendingByOrg.reduce(
        (sum, r) => sum + r._count.id,
        0,
      );
      const adminOrgsWithPending = adminPendingByOrg.length;

      // -----------------------------------------------------------------
      // Onboarding state.
      // -----------------------------------------------------------------
      // The Phase 38.8 PageRouteGate already gates legal acceptance at
      // the route level. By the time we are here, the user has
      // ACCEPTED legal terms. We still report the flag for completeness.
      //
      // The other onboarding signals:
      //   - hasAnyOrganization: at least one org membership.
      //   - hasEmailIdentity: caller is not a pure guest.
      //   - hasAcceptedAnyInvite: derived from membership rows that did
      //     not include caller as an ORG_OWNER (i.e. created via accept,
      //     not via create).
      // -----------------------------------------------------------------
      const onboarding = {
        legalAccepted: true, // gate already passed
        hasEmailIdentity: callerEmail.length > 0,
        hasAnyOrganization: membershipRows.length > 0,
        hasOwnedOrganization: membershipRows.some(
          (m) => m.role === "ORG_OWNER",
        ),
      };

      // -----------------------------------------------------------------
      // Priority items — a deterministic top-3 list the dashboard can
      // render verbatim. Each item carries an id (for E2E), a label,
      // a one-line operational meaning, an href, and a severity tone.
      // -----------------------------------------------------------------
      const items: Array<{
        id: string;
        label: string;
        meaning: string;
        href: string;
        tone: "info" | "warning" | "high";
      }> = [];

      if (pendingOrgInvites.length > 0) {
        // Highest-priority signal: someone is waiting for you to act.
        const first = pendingOrgInvites[0]!;
        items.push({
          id: "pending_org_invites",
          label: `${pendingOrgInvites.length} organization invite${pendingOrgInvites.length === 1 ? "" : "s"} pending your acceptance`,
          meaning:
            pendingOrgInvites.length === 1
              ? `${first.organizationName} invited you to join as ${first.role}.`
              : `Open Organizations to review and accept.`,
          href: "/organizations",
          tone: "high",
        });
      }
      if (adminPendingInviteCount > 0) {
        items.push({
          id: "admin_pending_invites",
          label: `${adminPendingInviteCount} pending invite${adminPendingInviteCount === 1 ? "" : "s"} across ${adminOrgsWithPending} of your organization${adminOrgsWithPending === 1 ? "" : "s"}`,
          meaning:
            "As an admin you can resend or revoke these from each organization's detail page.",
          href: "/organizations",
          tone: "warning",
        });
      }
      if (!onboarding.hasAnyOrganization) {
        items.push({
          id: "no_organizations",
          label: "You haven't joined an organization yet",
          meaning:
            "Organizations group workspaces for governance, members, and audit. Create one, or accept an invite token, to enable team operations.",
          href: "/organizations",
          tone: "info",
        });
      }
      if (
        onboarding.hasAnyOrganization &&
        !onboarding.hasEmailIdentity
      ) {
        items.push({
          id: "no_email_identity",
          label: "Add an email to your account",
          meaning:
            "Email-matched invites and audit-trail attribution require an email identity. Pure-guest accounts are limited to personal workspace operations.",
          href: "/settings",
          tone: "info",
        });
      }

      // -----------------------------------------------------------------
      // Final envelope.
      // -----------------------------------------------------------------
      return reply.code(200).send({
        generatedAt: now.toISOString(),
        caller: {
          userId: me.id,
          email: me.email,
          displayName: me.displayName,
        },
        summary: {
          totalOrgs: orgs.length,
          pendingOrgInviteCount: pendingOrgInvites.length,
          adminPendingInviteCount,
          adminOrgsWithPending,
          priorityItemCount: items.length,
        },
        onboarding,
        orgs,
        pendingOrgInvites,
        items,
      });
    },
  );
}

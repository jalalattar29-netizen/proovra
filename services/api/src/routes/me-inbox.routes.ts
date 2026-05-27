/**
 * Phase C — Operational Inbox.
 *
 * GET /v1/me/inbox
 *
 * Caller-scoped operational inbox. Returns the unified stream of
 * "things that require this user's attention right now" derived from
 * existing canonical signals. The endpoint is read-only and never
 * creates a new signal — it only aggregates what other systems
 * already own.
 *
 * Signal sources (each one is a REAL backend table, not invented):
 *
 *   1. Pending organization invites addressed to the caller (Phase
 *      2.7X Stage 5 email-matched invites). Reuses the same query
 *      shape as /v1/me/operational-priorities.
 *
 *   2. Admin pending invites — count of open invites in orgs where
 *      the caller is ORG_OWNER / ORG_ADMIN, surfaced as a single
 *      operational item per org (so a 20-invite backlog renders as
 *      one inbox row, not 20).
 *
 *   3. Governance notifications — rows from `GovernanceNotification`
 *      for teams the caller is a member of, where
 *      `acknowledgedAtUtc IS NULL`. These are workspace-scoped
 *      governance signals (legal hold placed, destruction pending,
 *      retention conflict, lifecycle drift, export blocked, etc.)
 *      that already carry severity + dedupe + occurrence counting
 *      server-side. The inbox is the operator-visible surface for
 *      that pre-built pipeline.
 *
 *   4. Onboarding items — derived from membership state (no org yet,
 *      no email identity). Same logic as the priorities endpoint.
 *
 * Hard rules:
 *
 *   - Caller-scoped. We never return inbox items for a different
 *     user, even if the caller is an admin in the same org. Items
 *     are operator-relevant to THIS account.
 *
 *   - Workspace-scoped governance notifications are filtered to
 *     teams the caller is a Team member of. We do NOT surface
 *     notifications for teams the caller has no relationship with,
 *     even when ORG_OWNER of the parent org — the existing
 *     governance notification model is team-scoped by design.
 *
 *   - Read state is INHERENT in source backend state, not tracked
 *     here. An invite is "resolved" when accepted/revoked/expired.
 *     A governance notification is "resolved" when its
 *     `acknowledgedAtUtc` is set. We do NOT introduce a separate
 *     read-state column to avoid the "infinite unread growth" the
 *     brief explicitly forbids.
 *
 *   - No new events emitted; this is a pure read. The underlying
 *     systems own the audit chain.
 *
 *   - No cross-org / cross-workspace data leak. Every query is
 *     scoped to memberships the caller already has.
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

type InboxTone = "info" | "warning" | "high" | "critical";
type InboxCategory =
  | "onboarding"
  | "org_invite"
  | "org_admin"
  | "governance"
  | "review_decision";

type InboxItem = {
  /**
   * Stable, deterministic identifier for this item. Composite of
   * (sourceTable, sourceId). The frontend keys lists on this and an
   * eventual receipt model could read-track on this key.
   */
  id: string;
  category: InboxCategory;
  tone: InboxTone;
  title: string;
  body: string;
  href: string;
  /** ISO timestamp of the most recent occurrence of this item. */
  occurredAt: string;
  /**
   * Optional context for the operator (org name, workspace name).
   * Never PII; only short identifiers + names already visible to the
   * caller.
   */
  context: Record<string, string | number | null>;
};

export async function meInboxRoutes(app: FastifyInstance) {
  app.get(
    "/v1/me/inbox",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const now = new Date();

      // -----------------------------------------------------------------
      // Caller identity probe.
      // -----------------------------------------------------------------
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, displayName: true },
      });
      if (!me) {
        return reply.code(401).send({ message: "Unknown caller" });
      }
      const callerEmail = (me.email ?? "").trim().toLowerCase();

      // -----------------------------------------------------------------
      // Caller's org memberships (for admin-pending-invite rollup).
      // -----------------------------------------------------------------
      const orgMemberships = await prisma.organizationMembership.findMany({
        where: { userId },
        select: {
          role: true,
          organization: {
            select: { id: true, name: true, status: true },
          },
        },
      });
      const adminOrgIds = orgMemberships
        .filter((m) => m.role === "ORG_OWNER" || m.role === "ORG_ADMIN")
        .map((m) => m.organization.id);
      const orgNameById = new Map<string, string>(
        orgMemberships.map((m) => [m.organization.id, m.organization.name]),
      );

      // -----------------------------------------------------------------
      // Caller's team memberships (for governance-notification scope).
      // -----------------------------------------------------------------
      // The team table carries `ownerUserId` for personal teams and
      // explicit TeamMember rows for collaborative teams. To capture
      // both we query TeamMember + the personal-owner fallback.
      const teamMemberships = await prisma.teamMember.findMany({
        where: { userId },
        select: {
          team: { select: { id: true, name: true } },
        },
      });
      const teamIdSet = new Set<string>(
        teamMemberships.map((tm) => tm.team.id),
      );
      // Also include personal teams the caller owns. These may not
      // have a TeamMember row in some seeding paths.
      const ownedPersonalTeams = await prisma.team.findMany({
        where: { ownerUserId: userId },
        select: { id: true, name: true },
      });
      for (const t of ownedPersonalTeams) teamIdSet.add(t.id);
      const teamIds = Array.from(teamIdSet);
      const teamNameById = new Map<string, string>([
        ...teamMemberships.map(
          (tm) => [tm.team.id, tm.team.name] as [string, string],
        ),
        ...ownedPersonalTeams.map((t) => [t.id, t.name] as [string, string]),
      ]);

      // -----------------------------------------------------------------
      // Source 1: pending org invites addressed to the caller.
      // -----------------------------------------------------------------
      const pendingOrgInvites = callerEmail
        ? await prisma.organizationInvite.findMany({
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
              organization: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "asc" },
          })
        : [];

      // -----------------------------------------------------------------
      // Source 2: admin pending-invite rollup (one item per org).
      // -----------------------------------------------------------------
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
              _max: { createdAt: true },
            });

      // -----------------------------------------------------------------
      // Source 3b: Phase B.3 — multi-stage review attention.
      //
      // Two operator-relevant signals for the caller:
      //   (a) workflows in `conflict_detected` state in teams where the
      //       caller is OWNER/ADMIN (i.e. an adjudicator). These need
      //       resolution and only an adjudicator can act.
      //   (b) workflows where the caller submitted the FIRST decision
      //       and the workflow is now in `second_required` state — pure
      //       awareness signal so the caller knows their decision is
      //       pending peer review.
      //
      // Both queries are workspace-scoped via teamIds the caller is a
      // member of. We further filter (a) to teams where the caller's
      // role is OWNER/ADMIN.
      // -----------------------------------------------------------------
      const adminTeamIds = teamMemberships
        .filter((tm) =>
          tm.team
            ? // We need the role; refetch lightweight to avoid widening
              // the earlier query. Cost: one bounded query for callers
              // who happen to have many teams.
              true
            : false,
        )
        .map((tm) => tm.team.id);

      // Caller's per-team role lookup for the adjudicator subset.
      const teamRoles =
        teamIds.length === 0
          ? []
          : await prisma.teamMember.findMany({
              where: {
                userId,
                teamId: { in: teamIds },
              },
              select: { teamId: true, role: true },
            });
      const adjudicatorTeamIds = teamRoles
        .filter((r) => r.role === "OWNER" || r.role === "ADMIN")
        .map((r) => r.teamId);

      // (a) Conflict-detected workflows where caller is adjudicator.
      //
      // A workflow is in conflict_detected when FIRST and SECOND
      // decisions exist AND they differ AND no ADJUDICATION row exists.
      // We do this in one round trip by selecting all workflows with
      // FIRST+SECOND decisions in adjudicator teams and filtering in
      // memory.
      const conflictCandidates =
        adjudicatorTeamIds.length === 0
          ? []
          : await prisma.workflowReviewDecision.findMany({
              where: {
                teamId: { in: adjudicatorTeamIds },
                stage: { in: ["FIRST", "SECOND", "ADJUDICATION"] },
              },
              select: {
                workflowId: true,
                teamId: true,
                stage: true,
                decision: true,
                decidedAt: true,
              },
            });

      type StageMap = Map<
        string,
        {
          teamId: string;
          first?: { decision: string };
          second?: { decision: string; decidedAt: Date };
          adjudication?: boolean;
        }
      >;
      const stagesByWorkflow: StageMap = new Map();
      for (const r of conflictCandidates) {
        const entry = stagesByWorkflow.get(r.workflowId) ?? {
          teamId: r.teamId,
        };
        if (r.stage === "FIRST") entry.first = { decision: r.decision };
        else if (r.stage === "SECOND")
          entry.second = { decision: r.decision, decidedAt: r.decidedAt };
        else if (r.stage === "ADJUDICATION") entry.adjudication = true;
        stagesByWorkflow.set(r.workflowId, entry);
      }
      const conflictWorkflows: Array<{
        workflowId: string;
        teamId: string;
        decidedAt: Date;
      }> = [];
      for (const [workflowId, entry] of stagesByWorkflow) {
        if (
          entry.first &&
          entry.second &&
          !entry.adjudication &&
          entry.first.decision !== entry.second.decision
        ) {
          conflictWorkflows.push({
            workflowId,
            teamId: entry.teamId,
            decidedAt: entry.second.decidedAt,
          });
        }
      }

      // (b) Workflows where caller submitted FIRST and SECOND is still
      // pending. We surface this as awareness only.
      const myFirstDecisions =
        teamIds.length === 0
          ? []
          : await prisma.workflowReviewDecision.findMany({
              where: {
                reviewerUserId: userId,
                stage: "FIRST",
                teamId: { in: teamIds },
              },
              select: {
                workflowId: true,
                teamId: true,
                decidedAt: true,
              },
            });
      // Filter to ones that DON'T yet have a SECOND row.
      const myFirstWorkflowIds = myFirstDecisions.map((d) => d.workflowId);
      const secondsForMyFirsts =
        myFirstWorkflowIds.length === 0
          ? []
          : await prisma.workflowReviewDecision.findMany({
              where: {
                workflowId: { in: myFirstWorkflowIds },
                stage: "SECOND",
              },
              select: { workflowId: true },
            });
      const haveSecond = new Set<string>(
        secondsForMyFirsts.map((s) => s.workflowId),
      );
      const pendingSecondForMe = myFirstDecisions.filter(
        (d) => !haveSecond.has(d.workflowId),
      );

      // -----------------------------------------------------------------
      // Source 3: unacknowledged governance notifications for teams
      // the caller is a member of.
      // -----------------------------------------------------------------
      const governanceRows =
        teamIds.length === 0
          ? []
          : await prisma.governanceNotification.findMany({
              where: {
                teamId: { in: teamIds },
                acknowledgedAtUtc: null,
              },
              select: {
                id: true,
                teamId: true,
                kind: true,
                severity: true,
                lastSeenAtUtc: true,
                occurrenceCount: true,
                metadata: true,
              },
              orderBy: [
                { severity: "desc" },
                { lastSeenAtUtc: "desc" },
              ],
              take: 100,
            });

      // -----------------------------------------------------------------
      // Assemble the unified items array.
      // -----------------------------------------------------------------
      const items: InboxItem[] = [];

      // Onboarding — only when no org membership.
      if (orgMemberships.length === 0) {
        items.push({
          id: "onboarding:no_organizations",
          category: "onboarding",
          tone: "info",
          title: "You haven't joined an organization yet",
          body: "Organizations group workspaces for governance, members, and audit. Create one, or accept an invite token.",
          href: "/organizations",
          occurredAt: now.toISOString(),
          context: {},
        });
      }
      if (orgMemberships.length > 0 && !callerEmail) {
        items.push({
          id: "onboarding:no_email_identity",
          category: "onboarding",
          tone: "info",
          title: "Add an email to your account",
          body: "Email-matched invites and audit-trail attribution require an email identity.",
          href: "/settings",
          occurredAt: now.toISOString(),
          context: {},
        });
      }

      // Pending org invites — one item per invite, addressed to caller.
      for (const inv of pendingOrgInvites) {
        items.push({
          id: `org_invite:${inv.id}`,
          category: "org_invite",
          tone: "high",
          title: `Organization invite waiting: ${inv.organization.name}`,
          body: `You have been invited to join ${inv.organization.name} as ${inv.role}. Accept before ${new Date(
            inv.expiresAt,
          ).toLocaleDateString()}.`,
          href: "/organizations",
          occurredAt: inv.createdAt.toISOString(),
          context: {
            organizationId: inv.organization.id,
            organizationName: inv.organization.name,
            role: inv.role,
            expiresAt: inv.expiresAt.toISOString(),
          },
        });
      }

      // Admin pending invites — one rollup item per org with N pending.
      for (const row of adminPendingByOrg) {
        if (!row.organizationId) continue;
        const count = row._count.id;
        const orgName = orgNameById.get(row.organizationId) ?? "your organization";
        items.push({
          id: `org_admin:${row.organizationId}:pending_invites`,
          category: "org_admin",
          tone: "warning",
          title: `${count} pending invite${count === 1 ? "" : "s"} in ${orgName}`,
          body: `As an admin you can resend or revoke open invites from this organization's detail page.`,
          href: `/organizations/${row.organizationId}`,
          occurredAt: (row._max.createdAt ?? now).toISOString(),
          context: {
            organizationId: row.organizationId,
            organizationName: orgName,
            pendingCount: count,
          },
        });
      }

      // Phase B.3 — review_decision items.
      //
      // (a) Conflict-detected workflows where caller is adjudicator.
      //     High tone — these block workflow resolution and only the
      //     caller's role can act.
      for (const c of conflictWorkflows) {
        items.push({
          id: `review_decision:conflict:${c.workflowId}`,
          category: "review_decision",
          tone: "high",
          title: `Reviewer conflict — adjudication required`,
          body: `Two reviewers disagreed on this workflow. As team OWNER/ADMIN you can resolve it via the multi-stage review panel.`,
          href: `/reviewer-ops/${encodeURIComponent(c.workflowId)}`,
          occurredAt: c.decidedAt.toISOString(),
          context: {
            workflowId: c.workflowId,
            teamId: c.teamId,
            stage: "ADJUDICATION",
          },
        });
      }

      // (b) Workflows where caller submitted FIRST and SECOND is
      //     still pending. Awareness only — info tone.
      for (const d of pendingSecondForMe) {
        items.push({
          id: `review_decision:awaiting_second:${d.workflowId}`,
          category: "review_decision",
          tone: "info",
          title: `Your first-stage decision is awaiting peer review`,
          body: `Independence policy requires a different reviewer to submit the second-stage decision. No action needed from you.`,
          href: `/reviewer-ops/${encodeURIComponent(d.workflowId)}`,
          occurredAt: d.decidedAt.toISOString(),
          context: {
            workflowId: d.workflowId,
            teamId: d.teamId,
            stage: "SECOND_AWAITED",
          },
        });
      }

      // Governance notifications — one item per unacknowledged row.
      for (const g of governanceRows) {
        const teamName = teamNameById.get(g.teamId) ?? "workspace";
        const toneMap: Record<typeof g.severity, InboxTone> = {
          CRITICAL: "critical",
          HIGH: "high",
          WARNING: "warning",
          INFO: "info",
        };
        items.push({
          id: `governance:${g.id}`,
          category: "governance",
          tone: toneMap[g.severity] ?? "info",
          title: `${governanceKindTitle(g.kind)} — ${teamName}`,
          body: governanceKindBody(g.kind, g.occurrenceCount),
          href: governanceKindHref(g.kind),
          occurredAt: g.lastSeenAtUtc.toISOString(),
          context: {
            teamId: g.teamId,
            teamName,
            kind: g.kind,
            severity: g.severity,
            occurrenceCount: g.occurrenceCount,
          },
        });
      }

      // -----------------------------------------------------------------
      // Severity-first ordering.
      // -----------------------------------------------------------------
      const tonePriority: Record<InboxTone, number> = {
        critical: 4,
        high: 3,
        warning: 2,
        info: 1,
      };
      items.sort((a, b) => {
        const sev = tonePriority[b.tone] - tonePriority[a.tone];
        if (sev !== 0) return sev;
        // Same severity → most recent first.
        return b.occurredAt.localeCompare(a.occurredAt);
      });

      // -----------------------------------------------------------------
      // Summary counts.
      // -----------------------------------------------------------------
      const summary = {
        total: items.length,
        byTone: {
          critical: items.filter((i) => i.tone === "critical").length,
          high: items.filter((i) => i.tone === "high").length,
          warning: items.filter((i) => i.tone === "warning").length,
          info: items.filter((i) => i.tone === "info").length,
        },
        byCategory: {
          onboarding: items.filter((i) => i.category === "onboarding").length,
          org_invite: items.filter((i) => i.category === "org_invite").length,
          org_admin: items.filter((i) => i.category === "org_admin").length,
          governance: items.filter((i) => i.category === "governance").length,
          review_decision: items.filter(
            (i) => i.category === "review_decision",
          ).length,
        },
      };

      return reply.code(200).send({
        generatedAt: now.toISOString(),
        caller: {
          userId: me.id,
          email: me.email,
          displayName: me.displayName,
        },
        summary,
        items,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Governance-notification kind → operator-readable copy.
//
// Every kind in `GovernanceNotificationKind` is mapped here. If a new
// kind is added to the schema without a mapping, we fall back to a
// generic readable label — but the test suite asserts every known
// kind has a mapping so the fallback path is a regression signal.
// ---------------------------------------------------------------------------
function governanceKindTitle(kind: string): string {
  switch (kind) {
    case "DESTRUCTION_PENDING":
      return "Evidence destruction pending review";
    case "DESTRUCTION_APPROVED":
      return "Evidence destruction approved";
    case "DESTRUCTION_EXECUTED":
      return "Evidence destruction executed";
    case "DESTRUCTION_BLOCKED":
      return "Evidence destruction blocked";
    case "LEGAL_HOLD_PLACED":
      return "Legal hold placed";
    case "LEGAL_HOLD_RELEASED":
      return "Legal hold released";
    case "RETENTION_CONFLICT":
      return "Retention policy conflict";
    case "RETENTION_EXTENSION_APPLIED":
      return "Retention extension applied";
    case "LIFECYCLE_DRIFT":
      return "Evidence lifecycle drift";
    case "IMMUTABLE_RECONCILIATION_FAILURE":
      return "Object-lock reconciliation failure";
    case "GOVERNANCE_INCIDENT_RAISED":
      return "Governance incident raised";
    case "EXPORT_BLOCKED":
      return "Export blocked by governance";
    default:
      return `Governance event: ${kind.toLowerCase().replace(/_/g, " ")}`;
  }
}

function governanceKindBody(kind: string, occurrenceCount: number): string {
  const occBlurb =
    occurrenceCount > 1 ? ` Seen ${occurrenceCount} times.` : "";
  switch (kind) {
    case "DESTRUCTION_PENDING":
      return `An evidence item is awaiting destruction review.${occBlurb}`;
    case "LEGAL_HOLD_PLACED":
      return `A legal hold has been placed on evidence in this workspace.${occBlurb}`;
    case "RETENTION_CONFLICT":
      return `A retention policy conflict needs governance review.${occBlurb}`;
    case "IMMUTABLE_RECONCILIATION_FAILURE":
      return `Object-lock reconciliation failed for evidence in this workspace.${occBlurb}`;
    case "EXPORT_BLOCKED":
      return `An evidence export was blocked by governance policy.${occBlurb}`;
    default:
      return `A governance event requires acknowledgement.${occBlurb}`;
  }
}

function governanceKindHref(kind: string): string {
  switch (kind) {
    case "DESTRUCTION_PENDING":
    case "DESTRUCTION_APPROVED":
    case "DESTRUCTION_EXECUTED":
    case "DESTRUCTION_BLOCKED":
      return "/governance/destruction";
    case "LEGAL_HOLD_PLACED":
    case "LEGAL_HOLD_RELEASED":
      return "/governance/lifecycle";
    case "RETENTION_CONFLICT":
    case "RETENTION_EXTENSION_APPLIED":
      return "/governance/retention";
    case "EXPORT_BLOCKED":
      return "/governance";
    default:
      return "/governance";
  }
}

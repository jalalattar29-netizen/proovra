import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { liveWorkspaceWhere } from "@proovra/shared-runtime";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";

/**
 * PLATFORM ADMIN — PEOPLE / CUSTOMER DIRECTORY (ADM-028, ADM-006, ADM-016).
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * `/v1/admin/users` was a well-built roster of the WRONG DIMENSION. Its column
 * allow-list is exemplary — no password hash, no MFA secret, a `lastLoginAt`
 * derived from a real analytics event that returns null rather than guessing —
 * but it carried no commercial dimension whatsoever: no plan, no entitlement,
 * no subscription, no provider, no renewal, no personal workspace, no billing
 * ownership, and no per-user detail route.
 *
 * So the console could show a PRO count (in fact two conflicting ones, from two
 * different populations on two different pages) and could not name a single PRO
 * customer. "List our PRO subscribers" required a database query.
 *
 * WHERE COMMERCIAL TRUTH COMES FROM
 * ---------------------------------------------------------------------------
 * `resolveCommercialContext({ type: "PERSONAL_ACCOUNT" })` — the same authority
 * checkout and the billing UI read, including the single 7-day grace rule. It
 * is called on the DETAIL view, where one subject is being examined.
 *
 * The ROSTER cannot call it per row without rebuilding the N+1 that ADM-014
 * exists to remove, so it reports the ENTITLEMENT TIER — the stored account
 * projection, batched — and labels it as exactly that. The distinction is real
 * and is preserved rather than papered over: a user in the grace window is PRO
 * canonically and PAST_DUE at the provider, and an operator filtering the
 * roster is filtering on the tier, not on the composed verdict.
 */

export type AdminPersonRow = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  provider: string;
  platformRole: string | null;
  /** Active `Entitlement.plan` — the ACCOUNT tier projection, not a verdict. */
  accountTier: string | null;
  /**
   * EVERY provider subscription on the account, newest first.
   *
   * Deliberately a list rather than one "primary" row. A first draft of this
   * returned a single subscription chosen by a preference rule, and an executed
   * test caught what that costs: a user holding both a winding-down PRO
   * subscription and a live TEAM one showed whichever the rule happened to
   * favour, so `?pendingCancellation=true` could return a row whose visible
   * subscription said `cancelAtPeriodEnd: false`. A filter that contradicts the
   * row it returned is worse than no filter.
   */
  subscriptions: Array<{
    id: string;
    provider: string;
    plan: string;
    status: string;
    /** ADM-016 — an ACTIVE subscription that is winding down. */
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  }>;
  /**
   * Derived across ALL of the account's subscriptions, so it agrees with the
   * `pendingCancellation` filter by construction rather than by coincidence.
   */
  pendingCancellation: boolean;
  hasLiveSubscription: boolean;
  personalWorkspaceId: string | null;
  ownedWorkspaceCount: number;
  workspaceMembershipsCount: number;
  orgMembershipsCount: number;
  mfaEnrolled: boolean;
  lastLoginAt: string | null;
  /**
   * ADM-028 — WORKSPACE-MEMBERSHIP states, named for what they are.
   *
   * These were previously rendered as "Account suspended" / "Deactivated".
   * They are neither: they are derived from `TeamMember.status` across ALL of a
   * user's memberships, so someone suspended from one workspace and active in
   * five read as suspended platform-wide. `User` models no account-level
   * disable at all, so there is no honest account status to show — and
   * inventing a label for one is how an operator ends up believing an account
   * was disabled when nothing of the kind happened.
   */
  memberships: { active: number; suspended: number; revoked: number };
  country: string | null;
  timezone: string | null;
  /** No per-user risk model exists. Honestly null; never a fabricated score. */
  riskStatus: null;
};

export type AdminPeopleFilters = {
  page: number;
  pageSize: number;
  search?: string;
  /**
   * Restrict to an explicit id set. Used by the DETAIL view so it reuses this
   * one projection instead of building a second — two code paths computing
   * "what tier is this person on" is the defect class this whole remediation is
   * removing, and it would be absurd to reintroduce it here.
   */
  ids?: string[];
  platformRole?: "admin";
  provider?: string;
  /** Filter on the active entitlement tier — this is how "list PRO users" works. */
  tier?: string;
  subscriptionStatus?: string;
  /** ADM-016 — surface the customers who are leaving. */
  pendingCancellation?: boolean;
  organizationId?: string;
  teamId?: string;
};

export type AdminPeopleResult = {
  items: AdminPersonRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export class PersonNotFoundError extends Error {
  constructor() {
    super("USER_NOT_FOUND");
    this.name = "PersonNotFoundError";
  }
}

function buildPeopleWhere(f: AdminPeopleFilters): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];

  if (f.ids) and.push({ id: { in: f.ids } });
  if (f.platformRole) and.push({ platformRole: f.platformRole });
  if (f.provider) and.push({ provider: f.provider as never });

  if (f.search?.trim()) {
    const q = f.search.trim();
    and.push({
      OR: [
        { email: { contains: q, mode: "insensitive" } },
        { displayName: { contains: q, mode: "insensitive" } },
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  // Commercial filters — all pushed into the database (ADM-014's lesson).
  if (f.tier) {
    and.push({ entitlements: { some: { active: true, plan: f.tier as never } } });
  }
  if (f.subscriptionStatus) {
    and.push({
      subscriptions: { some: { status: f.subscriptionStatus as never } },
    });
  }
  if (f.pendingCancellation === true) {
    and.push({
      subscriptions: { some: { status: "ACTIVE", cancelAtPeriodEnd: true } },
    });
  }
  if (f.organizationId) {
    and.push({
      organizationMemberships: { some: { organizationId: f.organizationId } },
    });
  }
  if (f.teamId) {
    and.push({ teamMembers: { some: { teamId: f.teamId } } });
  }

  return and.length === 0 ? {} : and.length === 1 ? and[0]! : { AND: and };
}

export async function listAdminPeople(
  filters: AdminPeopleFilters,
  client: PrismaClient = defaultPrisma,
): Promise<AdminPeopleResult> {
  const page = Math.max(1, filters.page);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize));
  const where = buildPeopleWhere(filters);

  const [total, users] = await Promise.all([
    client.user.count({ where }),
    client.user.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      // Explicit allow-list. NO passwordHash. NO MFA secret material.
      select: {
        id: true,
        email: true,
        displayName: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        provider: true,
        platformRole: true,
        country: true,
        timezone: true,
        _count: {
          select: {
            organizationMemberships: true,
            teamMembers: true,
            mfaFactors: { where: { status: { in: ["ACTIVE", "ENROLLING"] } } },
          },
        },
        teamMembers: { select: { status: true } },
      },
    }),
  ]);

  const ids = users.map((u) => u.id);
  if (ids.length === 0) {
    return { items: [], page, pageSize, total, totalPages: 0 };
  }

  // Five batched rollups for the page. Never one query per row.
  const [entitlements, subscriptions, personalSpaces, ownedCounts, lastLogins] =
    await Promise.all([
      client.entitlement.findMany({
        where: { userId: { in: ids }, active: true },
        select: { userId: true, plan: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      }),
      client.subscription.findMany({
        where: { userId: { in: ids } },
        select: {
          id: true,
          userId: true,
          provider: true,
          plan: true,
          status: true,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      client.team.findMany({
        where: {
          ownerUserId: { in: ids },
          workspaceKind: "PERSONAL",
          ...liveWorkspaceWhere(),
        },
        select: { id: true, ownerUserId: true },
      }),
      client.team.groupBy({
        by: ["ownerUserId"],
        where: {
          ownerUserId: { in: ids },
          workspaceKind: { in: ["OWNED", "ORGANIZATION"] },
          ...liveWorkspaceWhere(),
        },
        _count: { _all: true },
      }),
      client.analyticsEvent.groupBy({
        by: ["userId"],
        where: { userId: { in: ids }, eventType: "login_completed" },
        _max: { createdAt: true },
      }),
    ]);

  const tierByUser = new Map<string, string>();
  for (const e of entitlements) {
    if (!tierByUser.has(e.userId)) tierByUser.set(e.userId, String(e.plan));
  }
  // ALL subscriptions per user. No "primary" is chosen, because there is no
  // rule that picks one correctly for every question an operator might be
  // asking — see the type comment on `subscriptions`.
  const subsByUser = new Map<string, Array<(typeof subscriptions)[number]>>();
  for (const s of subscriptions) {
    const list = subsByUser.get(s.userId) ?? [];
    list.push(s);
    subsByUser.set(s.userId, list);
  }
  const personalByUser = new Map(
    personalSpaces.map((t) => [t.ownerUserId, t.id] as const),
  );
  const ownedByUser = new Map(
    ownedCounts.map((c) => [c.ownerUserId, c._count._all] as const),
  );
  const lastLoginByUser = new Map(
    lastLogins
      .filter((l) => l.userId)
      .map((l) => [l.userId as string, l._max.createdAt] as const),
  );

  return {
    items: users.map((u) => {
      const composed =
        [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null;
      const subs = subsByUser.get(u.id) ?? [];
      const statuses = u.teamMembers.map((m) => String(m.status));
      return {
        id: u.id,
        email: u.email ?? null,
        name: u.displayName ?? composed,
        createdAt: u.createdAt.toISOString(),
        provider: String(u.provider),
        platformRole: u.platformRole ?? null,
        accountTier: tierByUser.get(u.id) ?? null,
        subscriptions: subs.map((s) => ({
          id: s.id,
          provider: String(s.provider),
          plan: String(s.plan),
          status: String(s.status),
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        })),
        pendingCancellation: subs.some(
          (s) => s.status === "ACTIVE" && s.cancelAtPeriodEnd,
        ),
        hasLiveSubscription: subs.some(
          (s) => s.status === "ACTIVE" || s.status === "TRIALING",
        ),
        personalWorkspaceId: personalByUser.get(u.id) ?? null,
        ownedWorkspaceCount: ownedByUser.get(u.id) ?? 0,
        workspaceMembershipsCount: u._count.teamMembers,
        orgMembershipsCount: u._count.organizationMemberships,
        mfaEnrolled: u._count.mfaFactors > 0,
        lastLoginAt: lastLoginByUser.get(u.id)?.toISOString() ?? null,
        memberships: {
          active: statuses.filter((s) => s === "ACTIVE").length,
          suspended: statuses.filter((s) => s === "SUSPENDED").length,
          revoked: statuses.filter((s) => s === "REVOKED").length,
        },
        country: u.country ?? null,
        timezone: u.timezone ?? null,
        riskStatus: null,
      };
    }),
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

export type AdminPersonDetail = AdminPersonRow & {
  /**
   * The CANONICAL account commercial verdict from `resolveCommercialContext`.
   * Distinct from `accountTier` above, which is the stored entitlement row: in
   * the grace window the two legitimately disagree, and an operator deciding
   * whether someone still has access needs the composed answer.
   */
  commercial: {
    plan: string;
    lifecycleState: string;
    paidActive: boolean;
    mutationsAllowed: boolean;
    graceEndsAtUtc: string | null;
    billingOwnerUserId: string | null;
  } | null;
  commercialUnavailableReason: string | null;
  /**
   * The row cap each list below was read under.
   *
   * Sent because the console cannot disclose a cap it cannot see: every list
   * on the person detail page was rendered as though it were complete, so
   * someone with four hundred workspace memberships appeared to have two
   * hundred and a payment history that stops at twenty-five looked like the
   * whole history.
   */
  caps: {
    workspaces: number;
    organizations: number;
    payments: number;
    closure: number;
    dataExport: number;
  };
  /**
   * The evidence-credit WALLET, read through the canonical reader.
   *
   * An operator deciding whether to grant credits has to see what is already
   * there — and `granted` is reported separately from `purchased` because
   * they are different facts: one the customer paid for, one the platform gave
   * them. A single "credits" figure would let a support decision look like a
   * purchase in the very surface used to make the next one.
   */
  wallet: {
    availableCredits: number;
    purchasedCredits: number;
    grantedCredits: number;
    consumedCredits: number;
  } | null;
  workspaces: Array<{
    id: string;
    name: string;
    kind: string;
    lifecycle: "LIVE" | "CLOSED";
    role: string | null;
    memberStatus: string | null;
    isOwner: boolean;
  }>;
  organizations: Array<{
    id: string;
    name: string;
    kind: string;
    role: string;
    status: string;
  }>;
  payments: Array<{
    id: string;
    provider: string;
    amountCents: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  lifecycleRequests: {
    closure: Array<{ id: string; status: string; requestedAtUtc: string }>;
    dataExport: Array<{ id: string; status: string; requestedAtUtc: string }>;
  };
  evidenceCount: number;
};

export async function getAdminPersonDetail(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<AdminPersonDetail> {
  // Reuse the roster projection for this ONE id, so the detail view and the
  // roster can never report a different tier or subscription for the same
  // person.
  const base =
    (await listAdminPeople({ page: 1, pageSize: 1, ids: [userId] }, client))
      .items[0] ?? null;
  if (!base) throw new PersonNotFoundError();

  let commercial: AdminPersonDetail["commercial"] = null;
  let wallet: AdminPersonDetail["wallet"] = null;
  let commercialUnavailableReason: string | null = null;
  try {
    const ctx = await resolveCommercialContext({
      type: "PERSONAL_ACCOUNT",
      userId,
    });
    commercial = {
      plan: String(ctx.plan),
      lifecycleState: ctx.lifecycle.state,
      paidActive: ctx.lifecycle.paidActive,
      mutationsAllowed: ctx.lifecycle.mutationsAllowed,
      graceEndsAtUtc: ctx.lifecycle.graceEndsAtUtc?.toISOString() ?? null,
      billingOwnerUserId: ctx.billingOwnerUserId ?? null,
    };
  } catch {
    commercialUnavailableReason =
      "The canonical commercial context could not be resolved for this account. The stored entitlement tier is shown unchanged; it is not a substitute.";
  }

  try {
    const { readEvidenceCreditWallet } = await import(
      "../billing/evidence-credits.service.js"
    );
    const w = await readEvidenceCreditWallet(userId);
    wallet = {
      availableCredits: w.availableCredits,
      purchasedCredits: w.purchasedCredits,
      grantedCredits: w.grantedCredits,
      consumedCredits: w.consumedCredits,
    };
  } catch {
    // A wallet that cannot be read is reported as absent, never as zero: an
    // operator must not be shown a balance the platform did not confirm.
    wallet = null;
  }

  /**
   * THE ROW CAPS, NAMED AND SENT.
   *
   * Every list below is read under a `take`, and the person detail page
   * rendered all five with no indication of it: someone with four hundred
   * workspace memberships appeared to have two hundred, and a payment history
   * that stops at twenty-five looked like the whole history. A cap the client
   * cannot see is a cap the client cannot disclose.
   */
  const CAPS = {
    workspaces: 200,
    organizations: 100,
    payments: 25,
    closure: 10,
    dataExport: 10,
  } as const;

  const [memberships, orgMemberships, payments, closures, exports, evidenceCount] =
    await Promise.all([
      client.teamMember.findMany({
        where: { userId },
        select: {
          role: true,
          status: true,
          team: {
            select: {
              id: true,
              name: true,
              workspaceKind: true,
              closedAtUtc: true,
              ownerUserId: true,
            },
          },
        },
        take: CAPS.workspaces,
      }),
      client.organizationMembership.findMany({
        where: { userId },
        select: {
          role: true,
          status: true,
          organization: { select: { id: true, name: true, kind: true } },
        },
        take: CAPS.organizations,
      }),
      client.payment.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: CAPS.payments,
        // providerPaymentId DELIBERATELY omitted — it is a provider handle.
        select: {
          id: true,
          provider: true,
          amountCents: true,
          currency: true,
          status: true,
          createdAt: true,
        },
      }),
      // ADM-031 — these models exist and were invisible to Platform Admin.
      client.accountClosureRequest.findMany({
        where: { userId },
        orderBy: { requestedAtUtc: "desc" },
        take: CAPS.closure,
        select: { id: true, status: true, requestedAtUtc: true },
      }),
      client.accountDataExportRequest.findMany({
        where: { userId },
        orderBy: { requestedAtUtc: "desc" },
        take: CAPS.dataExport,
        select: { id: true, status: true, requestedAtUtc: true },
      }),
      client.evidence.count({ where: { ownerUserId: userId, deletedAt: null } }),
    ]);

  return {
    ...base,
    commercial,
    commercialUnavailableReason,
    wallet,
    /** The row caps every list below was read under. See CAPS above. */
    caps: CAPS,
    workspaces: memberships
      .filter((m) => m.team)
      .map((m) => ({
        id: m.team!.id,
        name: m.team!.name,
        kind: String(m.team!.workspaceKind),
        lifecycle: m.team!.closedAtUtc ? ("CLOSED" as const) : ("LIVE" as const),
        role: m.role ? String(m.role) : null,
        memberStatus: m.status ? String(m.status) : null,
        isOwner: m.team!.ownerUserId === userId,
      })),
    organizations: orgMemberships
      .filter((m) => m.organization)
      .map((m) => ({
        id: m.organization!.id,
        name: m.organization!.name,
        kind: String(m.organization!.kind),
        role: String(m.role),
        status: String(m.status),
      })),
    payments: payments.map((p) => ({
      id: p.id,
      provider: String(p.provider),
      amountCents: p.amountCents,
      currency: p.currency,
      status: String(p.status),
      createdAt: p.createdAt.toISOString(),
    })),
    lifecycleRequests: {
      closure: closures.map((c) => ({
        id: c.id,
        status: c.status,
        requestedAtUtc: c.requestedAtUtc.toISOString(),
      })),
      dataExport: exports.map((e) => ({
        id: e.id,
        status: e.status,
        requestedAtUtc: e.requestedAtUtc.toISOString(),
      })),
    },
    evidenceCount,
  };
}


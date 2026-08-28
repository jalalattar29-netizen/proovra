import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  customerOrganizationWhere,
  liveWorkspaceWhere,
  seatConsumingMemberCountArgs,
  workspaceLifecycleWhere,
  type WorkspaceLifecycleFilter,
} from "@proovra/shared-runtime";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";
import { getWorkspaceUsage } from "../workspace-usage.service.js";

/**
 * PLATFORM ADMIN — THE WORKSPACE DIRECTORY (ADM-027).
 *
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * The workspace is this platform's central commercial and tenancy object. It
 * owns the plan, the seats, the storage quota, the evidence, the governance
 * policy, the SSO connection and the incidents — and it was the one entity with
 * no Platform Admin surface at all. There was no `/admin/workspaces`, no
 * detail route, and no endpoint that could answer "which twelve workspaces?".
 * The dashboard's "Workspaces: 12" tile was a terminal number: the operator's
 * only route from it to a record was a manual database query.
 *
 * WHERE THE COMMERCIAL FACTS COME FROM
 * ---------------------------------------------------------------------------
 * `resolveCommercialContext({ type: "WORKSPACE" })` — the SAME authority
 * checkout, navigation and the billing UI read. This surface deliberately does
 * NOT re-derive plan, seats, lifecycle or enterprise coverage from
 * `Team.billingPlan` / `Team.billingStatus`: reproducing that composition here
 * is precisely how the console ended up with four incompatible answers to
 * "what plan is this customer on".
 *
 * The raw `Team.billing*` columns ARE surfaced alongside, under a `raw` key and
 * labelled as the stored projection. That is not a second authority — it is the
 * diagnostic an operator needs when the composed answer and the stored column
 * disagree, which is exactly the situation they are being asked to investigate.
 *
 * COST DISCIPLINE
 * ---------------------------------------------------------------------------
 * The roster does NOT call the resolver per row. `resolveCommercialContext`
 * reads several models and is the right tool for ONE subject; running it across
 * a hundred rows would rebuild the N+1 that ADM-014 exists to remove. The
 * roster therefore shows stored columns (honestly labelled) plus batched
 * counts, and the DETAIL view — one workspace, where an operator is actually
 * deciding something — resolves the canonical context.
 */

export type AdminWorkspaceKind = "PERSONAL" | "OWNED" | "ORGANIZATION";

export type AdminWorkspaceListItem = {
  id: string;
  name: string;
  kind: AdminWorkspaceKind;
  lifecycle: "LIVE" | "CLOSED";
  closedAtUtc: string | null;
  createdAt: string;
  organization: {
    id: string;
    name: string;
    /** SYSTEM = the internal 1:1 container; CUSTOMER = a real customer org. */
    kind: string;
  } | null;
  owner: { userId: string; email: string | null } | null;
  billingOwner: { userId: string; email: string | null } | null;
  /**
   * The STORED workspace commercial projection. Labelled `raw` because it is
   * the column, not the composed verdict — the detail view resolves the
   * canonical context and the two are shown side by side there.
   */
  raw: { billingPlan: string; billingStatus: string; includedSeats: number };
  /** ACTIVE members only — the canonical seat rule (ADM-008). */
  seatsUsed: number;
  evidenceCount: number;
  openIncidents: number;
};

export type AdminWorkspaceListFilters = {
  page: number;
  limit: number;
  search?: string;
  kind?: AdminWorkspaceKind;
  lifecycle?: WorkspaceLifecycleFilter;
  plan?: string;
  billingStatus?: string;
  organizationId?: string;
  /** Restrict to workspaces owned by a CUSTOMER organization. */
  customersOnly?: boolean;
};

export type AdminWorkspaceListResult = {
  items: AdminWorkspaceListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super("WORKSPACE_NOT_FOUND");
    this.name = "WorkspaceNotFoundError";
  }
}

function buildWorkspaceWhere(
  f: AdminWorkspaceListFilters,
): Prisma.TeamWhereInput {
  const and: Prisma.TeamWhereInput[] = [
    workspaceLifecycleWhere(f.lifecycle ?? "LIVE"),
  ];

  if (f.kind) and.push({ workspaceKind: f.kind });
  if (f.plan) and.push({ billingPlan: f.plan as never });
  if (f.billingStatus) and.push({ billingStatus: f.billingStatus as never });
  if (f.organizationId) and.push({ organizationId: f.organizationId });
  // Through the authority, not a literal: "what counts as a customer" must
  // have exactly one definition, or the next place that asks gets a seventh
  // answer. This is the relation form of the same predicate.
  if (f.customersOnly)
    and.push({ organization: { is: customerOrganizationWhere() } });

  if (f.search && f.search.trim()) {
    const q = f.search.trim();
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { organization: { name: { contains: q, mode: "insensitive" } } },
        { owner: { email: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  return and.length === 1 ? and[0]! : { AND: and };
}

export async function listAdminWorkspaces(
  filters: AdminWorkspaceListFilters,
  client: PrismaClient = defaultPrisma,
): Promise<AdminWorkspaceListResult> {
  const page = Math.max(1, filters.page);
  const limit = Math.min(100, Math.max(1, filters.limit));
  const where = buildWorkspaceWhere(filters);

  const [total, rows] = await Promise.all([
    client.team.count({ where }),
    client.team.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        workspaceKind: true,
        closedAtUtc: true,
        createdAt: true,
        billingPlan: true,
        billingStatus: true,
        includedSeats: true,
        organizationId: true,
        organization: { select: { id: true, name: true, kind: true } },
        owner: { select: { id: true, email: true } },
        billingOwner: { select: { id: true, email: true } },
        _count: { select: { members: seatConsumingMemberCountArgs() } },
      },
    }),
  ]);

  const ids = rows.map((r) => r.id);

  // Two batched rollups for the whole page — never one query per row.
  const [evidenceCounts, incidentCounts] = await Promise.all([
    ids.length
      ? client.evidence.groupBy({
          by: ["teamId"],
          where: { teamId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ teamId: string | null; _count: { _all: number } }>),
    ids.length
      ? client.operationalIncident.groupBy({
          by: ["teamId"],
          where: { teamId: { in: ids }, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ teamId: string | null; _count: { _all: number } }>),
  ]);

  const evidenceByTeam = new Map(
    evidenceCounts
      .filter((r) => r.teamId)
      .map((r) => [r.teamId as string, r._count._all] as const),
  );
  const incidentsByTeam = new Map(
    incidentCounts
      .filter((r) => r.teamId)
      .map((r) => [r.teamId as string, r._count._all] as const),
  );

  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.workspaceKind as AdminWorkspaceKind,
      lifecycle: r.closedAtUtc ? ("CLOSED" as const) : ("LIVE" as const),
      closedAtUtc: r.closedAtUtc?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      organization: r.organization
        ? {
            id: r.organization.id,
            name: r.organization.name,
            kind: String(r.organization.kind),
          }
        : null,
      owner: r.owner ? { userId: r.owner.id, email: r.owner.email ?? null } : null,
      billingOwner: r.billingOwner
        ? { userId: r.billingOwner.id, email: r.billingOwner.email ?? null }
        : null,
      raw: {
        billingPlan: String(r.billingPlan),
        billingStatus: String(r.billingStatus),
        includedSeats: r.includedSeats ?? 0,
      },
      seatsUsed: r._count.members,
      evidenceCount: evidenceByTeam.get(r.id) ?? 0,
      openIncidents: incidentsByTeam.get(r.id) ?? 0,
    })),
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

export type AdminWorkspaceDetail = {
  id: string;
  name: string;
  kind: AdminWorkspaceKind;
  lifecycle: "LIVE" | "CLOSED";
  closedAtUtc: string | null;
  createdAt: string;
  workspaceCategory: string | null;
  organization: {
    id: string;
    name: string;
    kind: string;
    status: string;
  } | null;
  owner: { userId: string; email: string | null; displayName: string | null } | null;
  billingOwner: {
    userId: string;
    email: string | null;
    displayName: string | null;
  } | null;
  /**
   * The CANONICAL commercial verdict from `resolveCommercialContext`.
   * Null only when the resolver could not answer (it fails closed rather than
   * guessing); the reason is carried alongside so the UI never shows a blank.
   */
  commercial: {
    plan: string;
    billingShape: string;
    seats: { consumed: number; limit: number; remaining: number };
    lifecycleState: string;
    paidActive: boolean;
    mutationsAllowed: boolean;
    graceEndsAtUtc: string | null;
    enterpriseContract: {
      status: string;
      seatCount: number | null;
      storageGb: number | null;
      endsAtUtc: string | null;
      region: string | null;
      legacyDerived: boolean;
    } | null;
  } | null;
  commercialUnavailableReason: string | null;
  /** The STORED projection, for comparison against the composed verdict. */
  raw: {
    billingPlan: string;
    billingStatus: string;
    includedSeats: number;
    billingActivatedAt: string | null;
    billingCanceledAt: string | null;
  };
  usage: {
    storageBytesUsed: string;
    storageBytesLimit: string;
    storageUsagePercent: number;
    evidenceCount: number;
    isNearStorageLimit: boolean;
    isStorageLimitReached: boolean;
  } | null;
  members: {
    active: number;
    suspended: number;
    revoked: number;
  };
  incidents: {
    open: number;
    acknowledged: number;
  };
  /** Provider subscriptions bound to this workspace (no provider secrets). */
  subscriptions: Array<{
    id: string;
    provider: string;
    plan: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    /** Masked — never the full provider reference. */
    providerSubRefMasked: string;
  }>;
  storageAddons: Array<{
    id: string;
    addonKey: string;
    status: string;
    billingCycle: string;
    amountCents: number | null;
    currency: string | null;
  }>;
  recentActivity: Array<{
    id: string;
    eventType: string;
    actorUserId: string | null;
    createdAt: string;
  }>;
};

/**
 * Mask a provider subscription reference.
 *
 * The full `providerSubId` is a live handle into Stripe/PayPal. An operator
 * needs enough to correlate with a provider dashboard; they do not need — and
 * this console must not distribute — the whole credential-adjacent identifier.
 */
function maskProviderRef(ref: string): string {
  if (ref.length <= 8) return "***";
  return `${ref.slice(0, 4)}…${ref.slice(-4)}`;
}

export async function getAdminWorkspaceDetail(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<AdminWorkspaceDetail> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      name: true,
      workspaceKind: true,
      closedAtUtc: true,
      createdAt: true,
      workspaceCategory: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      billingActivatedAt: true,
      billingCanceledAt: true,
      ownerUserId: true,
      organization: {
        select: { id: true, name: true, kind: true, status: true },
      },
      owner: { select: { id: true, email: true, displayName: true } },
      billingOwner: { select: { id: true, email: true, displayName: true } },
    },
  });
  if (!team) throw new WorkspaceNotFoundError();

  // ---- The CANONICAL commercial verdict ------------------------------------
  // Resolved against the workspace OWNER as requester: this is a platform-admin
  // read of the workspace's own commercial state, not an access decision about
  // the admin. Authorization for this route is the platform-admin gate.
  let commercial: AdminWorkspaceDetail["commercial"] = null;
  let commercialUnavailableReason: string | null = null;
  let usage: AdminWorkspaceDetail["usage"] = null;
  try {
    const ctx = await resolveCommercialContext({
      type: "WORKSPACE",
      teamId: team.id,
      requesterUserId: team.ownerUserId,
    });

    // Usage is resolved from the SAME scope the commercial context produced,
    // so the storage limit shown is the one the plan actually grants rather
    // than a second derivation of it.
    try {
      const u = await getWorkspaceUsage(ctx.scope);
      usage = {
        storageBytesUsed: u.storageBytesUsed.toString(),
        storageBytesLimit: u.storageBytesLimit.toString(),
        storageUsagePercent: u.storageUsagePercent,
        evidenceCount: u.evidenceCount,
        isNearStorageLimit: u.isNearStorageLimit,
        isStorageLimitReached: u.isStorageLimitReached,
      };
    } catch {
      usage = null;
    }

    commercial = {
      plan: String(ctx.plan),
      billingShape: ctx.billingShape,
      seats: {
        consumed: ctx.seats.consumed,
        limit: ctx.seats.limit,
        remaining: ctx.seats.remaining,
      },
      lifecycleState: ctx.lifecycle.state,
      paidActive: ctx.lifecycle.paidActive,
      mutationsAllowed: ctx.lifecycle.mutationsAllowed,
      graceEndsAtUtc: ctx.lifecycle.graceEndsAtUtc?.toISOString() ?? null,
      enterpriseContract: ctx.enterpriseContract
        ? {
            status: ctx.enterpriseContract.status,
            seatCount: ctx.enterpriseContract.seatCount ?? null,
            storageGb: ctx.enterpriseContract.storageGb ?? null,
            endsAtUtc: ctx.enterpriseContract.endsAtUtc?.toISOString() ?? null,
            region: ctx.enterpriseContract.region ?? null,
            legacyDerived: ctx.enterpriseContract.legacyDerived === true,
          }
        : null,
    };
  } catch {
    // Fails closed and says so. A blank plan column that silently meant "the
    // resolver threw" would be the ADM-024 defect in a new place.
    commercialUnavailableReason =
      "The canonical commercial context could not be resolved for this workspace. The stored projection below is shown unchanged; it is not a substitute.";
  }

  const [
    activeMembers,
    suspendedMembers,
    revokedMembers,
    openIncidents,
    ackIncidents,
    subscriptions,
    storageAddons,
    activity,
  ] = await Promise.all([
    client.teamMember.count({ where: { teamId, status: "ACTIVE" } }),
    client.teamMember.count({ where: { teamId, status: "SUSPENDED" } }),
    client.teamMember.count({ where: { teamId, status: "REVOKED" } }),
    client.operationalIncident.count({ where: { teamId, status: "OPEN" } }),
    client.operationalIncident.count({
      where: { teamId, status: "ACKNOWLEDGED" },
    }),
    client.subscription.findMany({
      where: { teamId },
      select: {
        id: true,
        provider: true,
        plan: true,
        status: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: true,
        providerSubId: true,
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    client.workspaceStorageAddon.findMany({
      where: { teamId },
      select: {
        id: true,
        addonKey: true,
        status: true,
        billingCycle: true,
        amountCents: true,
        currency: true,
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    client.teamActivity.findMany({
      where: { teamId },
      select: {
        id: true,
        eventType: true,
        actorUserId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
  ]);

  return {
    id: team.id,
    name: team.name,
    kind: team.workspaceKind as AdminWorkspaceKind,
    lifecycle: team.closedAtUtc ? "CLOSED" : "LIVE",
    closedAtUtc: team.closedAtUtc?.toISOString() ?? null,
    createdAt: team.createdAt.toISOString(),
    workspaceCategory: team.workspaceCategory ?? null,
    organization: team.organization
      ? {
          id: team.organization.id,
          name: team.organization.name,
          kind: String(team.organization.kind),
          status: String(team.organization.status),
        }
      : null,
    owner: team.owner
      ? {
          userId: team.owner.id,
          email: team.owner.email ?? null,
          displayName: team.owner.displayName ?? null,
        }
      : null,
    billingOwner: team.billingOwner
      ? {
          userId: team.billingOwner.id,
          email: team.billingOwner.email ?? null,
          displayName: team.billingOwner.displayName ?? null,
        }
      : null,
    commercial,
    commercialUnavailableReason,
    raw: {
      billingPlan: String(team.billingPlan),
      billingStatus: String(team.billingStatus),
      includedSeats: team.includedSeats ?? 0,
      billingActivatedAt: team.billingActivatedAt?.toISOString() ?? null,
      billingCanceledAt: team.billingCanceledAt?.toISOString() ?? null,
    },
    usage,
    members: {
      active: activeMembers,
      suspended: suspendedMembers,
      revoked: revokedMembers,
    },
    incidents: { open: openIncidents, acknowledged: ackIncidents },
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      provider: String(s.provider),
      plan: String(s.plan),
      status: String(s.status),
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      providerSubRefMasked: maskProviderRef(s.providerSubId),
    })),
    storageAddons: storageAddons.map((a) => ({
      id: a.id,
      addonKey: String(a.addonKey),
      status: String(a.status),
      billingCycle: String(a.billingCycle),
      amountCents: a.amountCents ?? null,
      currency: a.currency ?? null,
    })),
    recentActivity: activity.map((a) => ({
      id: a.id,
      eventType: a.eventType,
      actorUserId: a.actorUserId ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/** Re-exported so route validation and the roster share one vocabulary. */
export { liveWorkspaceWhere };

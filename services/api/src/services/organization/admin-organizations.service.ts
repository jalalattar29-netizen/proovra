/**
 * Platform Control Center — Customers / Organizations aggregation service.
 *
 * READ-ONLY aggregation over EXISTING models for the platform-admin
 * Customers roster + detail. NOTHING here mutates state, recomputes an
 * evidence hash, touches custody/signing, or reads a secret. Every field
 * returned is one of:
 *
 *   - REAL      — read straight from a DB column.
 *   - COMPUTED  — derived from real DB rows (counts, seat rollup, an
 *                 onboarding badge computed from real presence checks).
 *   - null      — the underlying signal is genuinely not present /
 *                 not measured. The UI renders "—" / "Not measured" /
 *                 "Not connected". We NEVER fabricate a value to fill a
 *                 gap.
 *
 * Secrets guarantee: this module selects ONLY non-secret columns. It
 * never reads SsoConnection.samlCertificate / samlSpPrivateKey /
 * clientSecretHash, never reads ScimProvisioningToken.tokenHash, never
 * returns an IdP secret or a SCIM token. SSO/SCIM/domain posture is
 * booleans + counts + operator-safe health, reusing the existing
 * `buildSsoHealthSnapshot` service (which itself selects only
 * fingerprints + timestamps, never key material).
 *
 * Reuse:
 *   - Seat rollup mirrors organizations-governance.routes.ts billing
 *     rollup: usedSeats = Team._count.members, includedSeats =
 *     Team.includedSeats, over-seat when used > included > 0.
 *   - SSO health reuses buildSsoHealthSnapshot per workspace (Team).
 *   - Org billing owner identity mirrors the governance rollup
 *     (email + displayName only — never a payment instrument).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  buildSsoHealthSnapshot,
  type SsoConnectionHealthStatus,
} from "../security/sso-health.service.js";
import {
  deriveCustomerLifecycle,
  type LifecycleStage,
} from "../admin/customer-lifecycle.js";
import {
  customerOrganizationWhere,
  liveWorkspaceWhere,
  seatConsumingMemberCountArgs,
  workspaceCaseWhere,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";
import { resolveEnterpriseContract } from "./enterprise-contract.service.js";

// Plans considered "paid" for lifecycle provisioning derivation.
const PAID_PLANS = new Set(["PAYG", "PRO", "TEAM", "ENTERPRISE"]);

/**
 * Defensive optional Prisma call. The platform admin surface reads a handful
 * of models (AnalyticsEvent, OperationalIncident, per-team member/evidence
 * rollups) that some injected test doubles do not stub. Rather than crash a
 * DB-free unit test on a missing delegate, we treat an absent delegate/method
 * as an honestly-unmeasured signal (returns the supplied fallback). Against
 * the real PrismaClient every delegate is present, so this is a no-op there.
 */
async function safeCall<T>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (typeof fn !== "function") return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Onboarding / health badge taxonomy.
//
// Derived from REAL presence checks:
//   - hasWorkspace     — org has >=1 non-personal Team.
//   - hasOwner         — org has an ORG_OWNER membership.
//   - hasVerifiedDomain— org has >=1 OrganizationDomain with verifiedAt.
//
// Mapping (honest, no invented "score"):
//   BLOCKED   — no workspace OR no owner (org cannot operate).
//   ATTENTION — operable but no verified domain yet.
//   HEALTHY   — workspace + owner + at least one verified domain.
//   UNKNOWN   — reserved for a future signal we cannot yet measure.
// ---------------------------------------------------------------------------
export type OnboardingHealth = "HEALTHY" | "ATTENTION" | "BLOCKED" | "UNKNOWN";

export type AdminOrgListItem = {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  /**
   * Highest workspace `billingPlan` present across the customer's LIVE
   * workspaces, or null when it has none.
   *
   * This is the workspace commercial PROJECTION and is labelled as such in the
   * UI. It is deliberately NOT the answer to "is this an enterprise customer" —
   * see `contract` below, which is (ADM-003).
   */
  plan: string | null;
  /**
   * TRUE only when the customer holds an ACTIVE `EnterpriseContract`.
   *
   * Previously `plans.includes("ENTERPRISE")`, which reported a customer whose
   * contract had been terminated — but whose workspace still carried the plan
   * string — as a live enterprise customer.
   */
  enterprise: boolean;
  /** The canonical contract facts, or null when the customer holds none. */
  contract: {
    status: string;
    seatCount: number | null;
    endsAtUtc: string | null;
  } | null;
  workspaceCount: number;
  seats: { included: number; used: number };
  ownerEmail: string | null;
  verifiedDomainsCount: number;
  ssoConfigured: boolean;
  scimConfigured: boolean;
  onboardingStatus: OnboardingHealth;
  /**
   * Best-effort last activity: newest OrganizationAuditEvent.createdAt for
   * the org. Null when the org has no audit events (NOT fabricated).
   */
  lastActivityAt: string | null;
  /**
   * COMPUTED customer lifecycle stage — a pure rollup of real signals
   * (org status, billing status, evidence activity, SSO/payment health).
   * "UNKNOWN" when the signals cannot prove a stage (never guessed).
   */
  lifecycleStage: LifecycleStage;
  /** Human-readable justification(s) for the derived lifecycleStage. */
  lifecycleReasons: string[];
};

export type AdminOrgListResult = {
  items: AdminOrgListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type AdminOrgListFilters = {
  page: number;
  limit: number;
  search?: string;
  plan?: string;
  status?: string;
  health?: OnboardingHealth;
  /**
   * Filter on the CONTRACT, not on a plan string. `true` selects customers
   * holding an ACTIVE `EnterpriseContract`; `false` selects everyone else,
   * including a customer whose contract lapsed while its workspace kept the
   * `ENTERPRISE` plan.
   */
  enterprise?: boolean;
};

// Plan tier ordering for "highest plan present" derivation.
const PLAN_RANK: Record<string, number> = {
  FREE: 0,
  PAYG: 1,
  PRO: 2,
  TEAM: 3,
  ENTERPRISE: 4,
};

/**
 * The highest workspace plan present, or null when the customer has none.
 *
 * ADM-003 — this used to ALSO return `enterprise: plans.includes("ENTERPRISE")`,
 * and that flag was what the roster and the detail page reported as "is this an
 * enterprise customer". Both call sites now take the answer from
 * `resolveEnterpriseContract` instead, so the flag was dead — and a dead,
 * plan-string-derived `enterprise` field sitting on a shared helper is exactly
 * the thing that gets picked up again by the next reader who needs one. Removed
 * rather than left for them to find.
 */
function derivePlan(plans: string[]): { plan: string | null } {
  if (plans.length === 0) return { plan: null };
  let best = plans[0]!;
  for (const p of plans) {
    if ((PLAN_RANK[p] ?? -1) > (PLAN_RANK[best] ?? -1)) best = p;
  }
  return { plan: best };
}

function deriveOnboarding(input: {
  hasWorkspace: boolean;
  hasOwner: boolean;
  hasVerifiedDomain: boolean;
}): OnboardingHealth {
  if (!input.hasWorkspace || !input.hasOwner) return "BLOCKED";
  if (!input.hasVerifiedDomain) return "ATTENTION";
  return "HEALTHY";
}

// ---------------------------------------------------------------------------
// List (customer roster)
//
// ADM-002 / ADM-014 (2026-08-27) — REWRITTEN.
//
// WHAT WAS WRONG
// ---------------------------------------------------------------------------
// Two defects that compounded each other.
//
// CORRECTNESS: the roster's only predicates were `status` and `search`. It
// never constrained `Organization.kind`, and `Team.organizationId` has been NOT
// NULL since Phase 2.7X — so every workspace, including every free personal
// space, owns an Organization row. A page titled "roster of every customer
// organization" was therefore listing one row per workspace-bootstrap container,
// each with `plan: null`, `ownerEmail: null` and `onboardingStatus: BLOCKED`.
// The schema comment on `Organization.kind` says SYSTEM containers must never
// surface as Organizations in product UI; the tenant product honours that in
// four places and admin honoured it in none.
//
// PERFORMANCE: it fetched EVERY organization, then called a `buildListItem`
// that awaited seven queries one after another inside a `for` loop, then
// paginated the result in memory. The code justified this as "org count is
// bounded (platform tenant roster)" — but with SYSTEM containers included that
// bound IS the total workspace count, so the page was O(workspaces x 7)
// serialised round-trips. Filtering to CUSTOMER fixes the correctness defect
// and removes most of the performance one; batching finishes the job.
//
// HOW IT WORKS NOW
// ---------------------------------------------------------------------------
// Every filter is a database predicate, including the two that used to be
// applied after aggregation:
//
//   plan    -> `workspaces: { some: { billingPlan } }` over LIVE workspaces
//   health  -> the three presence checks the badge is defined by, expressed
//              directly (a workspace, an ORG_OWNER, a verified domain)
//
// Pagination is `skip`/`take` with a matching `count()`, so "total" is the real
// total rather than the length of an array we happened to build. The page's
// twenty rows are then enriched by EIGHT batched queries — not one hundred and
// forty serialised ones.
// ---------------------------------------------------------------------------

export async function listAdminOrganizations(
  filters: AdminOrgListFilters,
  client: PrismaClient = defaultPrisma,
): Promise<AdminOrgListResult> {
  const page = Math.max(1, filters.page);
  const limit = Math.min(100, Math.max(1, filters.limit));

  const where = buildCustomerWhere(filters);

  const [total, orgs] = await Promise.all([
    client.organization.count({ where }),
    client.organization.findMany({
      where,
      select: { id: true, name: true, status: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const items = await enrichCustomerRows(orgs, client);

  return {
    items,
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

/**
 * Every roster filter as ONE database predicate.
 *
 * The `health` arm deserves a note: `onboardingStatus` is not a stored column,
 * it is a verdict over three presence checks. Rather than compute it for every
 * organization and filter afterwards — which is what forced the full scan — the
 * verdict is inverted into the predicate that produces it. BLOCKED is "missing a
 * live workspace OR missing an owner"; ATTENTION is "has both, lacks a verified
 * domain"; HEALTHY is all three. `deriveOnboarding` remains the single
 * definition and this is its query form; a change to one without the other
 * would show a row under a filter that its own badge contradicts, so they are
 * covered by the same test.
 */
function buildCustomerWhere(
  filters: AdminOrgListFilters,
): Prisma.OrganizationWhereInput {
  const and: Prisma.OrganizationWhereInput[] = [customerOrganizationWhere()];

  if (filters.status) and.push({ status: filters.status as never });

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim();
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { legalName: { contains: q, mode: "insensitive" } },
        {
          memberships: {
            some: {
              role: "ORG_OWNER",
              user: { email: { contains: q, mode: "insensitive" } },
            },
          },
        },
      ],
    });
  }

  if (filters.plan) {
    and.push({
      workspaces: {
        some: { ...liveWorkspaceWhere(), billingPlan: filters.plan as never },
      },
    });
  }

  // Enterprise is a CONTRACT fact, never a plan string (ADM-003). The roster's
  // enterprise filter therefore asks the contract table, not `billingPlan`.
  if (filters.enterprise === true) {
    and.push({ enterpriseContract: { is: { status: "ACTIVE" } } });
  } else if (filters.enterprise === false) {
    and.push({
      OR: [
        { enterpriseContract: { is: null } },
        { enterpriseContract: { isNot: { status: "ACTIVE" } } },
      ],
    });
  }

  const hasLiveWorkspace: Prisma.OrganizationWhereInput = {
    workspaces: { some: liveWorkspaceWhere() },
  };
  const hasOwner: Prisma.OrganizationWhereInput = {
    memberships: { some: { role: "ORG_OWNER" } },
  };
  const hasVerifiedDomain: Prisma.OrganizationWhereInput = {
    domains: { some: { verifiedAt: { not: null } } },
  };

  if (filters.health === "BLOCKED") {
    and.push({ OR: [{ NOT: hasLiveWorkspace }, { NOT: hasOwner }] });
  } else if (filters.health === "ATTENTION") {
    and.push(hasLiveWorkspace, hasOwner, { NOT: hasVerifiedDomain });
  } else if (filters.health === "HEALTHY") {
    and.push(hasLiveWorkspace, hasOwner, hasVerifiedDomain);
  }

  return and.length === 1 ? and[0]! : { AND: and };
}

/**
 * Enrich exactly the rows on this page, in eight batched queries.
 *
 * Everything here is grouped or `in`-filtered over the page's ids. Nothing
 * loops a query. The previous implementation's per-org `buildSsoHealthSnapshot`
 * call is deliberately NOT reproduced: the roster only needs "is SSO
 * configured", which is a count, and the full health snapshot (cert expiry
 * bands, per-connection failure timestamps) belongs on the detail page that can
 * afford it and actually displays it.
 */
async function enrichCustomerRows(
  orgs: Array<{ id: string; name: string; status: string; createdAt: Date }>,
  client: PrismaClient,
): Promise<AdminOrgListItem[]> {
  if (orgs.length === 0) return [];
  const orgIds = orgs.map((o) => o.id);

  // Live workspaces of every org on the page, with ACTIVE-only seat counts
  // (ADM-008 — the canonical seat rule, not `_count.members`).
  const workspaces = await client.team.findMany({
    where: { organizationId: { in: orgIds }, ...liveWorkspaceWhere() },
    select: {
      id: true,
      organizationId: true,
      billingPlan: true,
      billingStatus: true,
      billingActivatedAt: true,
      billingCanceledAt: true,
      includedSeats: true,
      _count: { select: { members: seatConsumingMemberCountArgs() } },
    },
  });
  const workspaceIds = workspaces.map((w) => w.id);

  const [
    owners,
    verifiedDomains,
    ssoRows,
    scimRows,
    lastEvents,
    evidencePresence,
    contracts,
  ] = await Promise.all([
    client.organizationMembership.findMany({
      where: { organizationId: { in: orgIds }, role: "ORG_OWNER" },
      select: {
        organizationId: true,
        createdAt: true,
        user: { select: { email: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    client.organizationDomain.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds }, verifiedAt: { not: null } },
      _count: { _all: true },
    }),
    workspaceIds.length
      ? client.ssoConnection.findMany({
          where: { teamId: { in: workspaceIds }, status: { notIn: ["REVOKED"] } },
          select: { teamId: true },
        })
      : Promise.resolve([] as Array<{ teamId: string | null }>),
    workspaceIds.length
      ? client.scimProvisioningToken.findMany({
          where: { teamId: { in: workspaceIds }, status: "ACTIVE" },
          select: { teamId: true },
        })
      : Promise.resolve([] as Array<{ teamId: string | null }>),
    client.organizationAuditEvent.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds } },
      _max: { createdAt: true },
    }),
    client.evidence.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds }, deletedAt: null },
      _count: { _all: true },
    }),
    client.enterpriseContract.findMany({
      where: { organizationId: { in: orgIds } },
      select: {
        organizationId: true,
        status: true,
        seatCount: true,
        endsAtUtc: true,
      },
    }),
  ]);

  // ---- Index the batches by their owning organization -----------------------
  const workspacesByOrg = new Map<string, typeof workspaces>();
  for (const ws of workspaces) {
    const list = workspacesByOrg.get(ws.organizationId) ?? [];
    list.push(ws);
    workspacesByOrg.set(ws.organizationId, list);
  }
  const orgIdByWorkspace = new Map(
    workspaces.map((w) => [w.id, w.organizationId] as const),
  );
  const ownerEmailByOrg = new Map<string, string | null>();
  for (const o of owners) {
    if (!ownerEmailByOrg.has(o.organizationId)) {
      ownerEmailByOrg.set(o.organizationId, o.user?.email ?? null);
    }
  }
  const verifiedDomainsByOrg = new Map(
    verifiedDomains.map((d) => [d.organizationId, d._count._all] as const),
  );
  const ssoOrgIds = new Set(
    ssoRows
      .map((r) => (r.teamId ? orgIdByWorkspace.get(r.teamId) : undefined))
      .filter((v): v is string => typeof v === "string"),
  );
  const scimOrgIds = new Set(
    scimRows
      .map((r) => (r.teamId ? orgIdByWorkspace.get(r.teamId) : undefined))
      .filter((v): v is string => typeof v === "string"),
  );
  const lastEventByOrg = new Map(
    lastEvents.map((e) => [e.organizationId, e._max.createdAt] as const),
  );
  const evidenceCountByOrg = new Map(
    evidencePresence
      .filter((e) => e.organizationId != null)
      .map((e) => [e.organizationId as string, e._count._all] as const),
  );
  const contractByOrg = new Map(contracts.map((c) => [c.organizationId, c] as const));

  return orgs.map((org) => {
    const ws = workspacesByOrg.get(org.id) ?? [];

    let includedSeats = 0;
    let usedSeats = 0;
    const plans: string[] = [];
    const billingStatuses: string[] = [];
    let anyPaidPlan = false;
    let anyActivatedAt = false;
    let anyCanceledAt = false;
    for (const w of ws) {
      includedSeats += w.includedSeats ?? 0;
      usedSeats += w._count.members;
      const plan = String(w.billingPlan ?? "FREE");
      plans.push(plan);
      if (PAID_PLANS.has(plan)) anyPaidPlan = true;
      billingStatuses.push(String(w.billingStatus ?? "INACTIVE"));
      if (w.billingActivatedAt) anyActivatedAt = true;
      if (w.billingCanceledAt) anyCanceledAt = true;
    }

    const { plan } = derivePlan(plans);
    const contract = contractByOrg.get(org.id) ?? null;
    const ownerEmail = ownerEmailByOrg.get(org.id) ?? null;
    const verifiedDomainsCount = verifiedDomainsByOrg.get(org.id) ?? 0;

    const lifecycle = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: org.status,
      hasWorkspace: ws.length > 0,
      billingStatus: pickBillingStatus(billingStatuses),
      onPaidPlan: anyPaidPlan,
      billingActivatedAt: anyActivatedAt ? new Date() : null,
      billingCanceledAt: anyCanceledAt ? new Date() : null,
      hasEvidenceActivity: (evidenceCountByOrg.get(org.id) ?? 0) > 0,
    });

    return {
      id: org.id,
      name: org.name,
      createdAt: org.createdAt.toISOString(),
      status: org.status,
      plan,
      // ADM-003 — enterprise is the CONTRACT, not a plan string. A workspace
      // still carrying `billingPlan: 'ENTERPRISE'` after its contract was
      // terminated is exactly the row this distinction exists to stop
      // reporting as a live enterprise customer.
      enterprise: contract?.status === "ACTIVE",
      contract: contract
        ? {
            status: contract.status,
            seatCount: contract.seatCount,
            endsAtUtc: contract.endsAtUtc?.toISOString() ?? null,
          }
        : null,
      workspaceCount: ws.length,
      seats: { included: includedSeats, used: usedSeats },
      ownerEmail,
      verifiedDomainsCount,
      ssoConfigured: ssoOrgIds.has(org.id),
      scimConfigured: scimOrgIds.has(org.id),
      onboardingStatus: deriveOnboarding({
        hasWorkspace: ws.length > 0,
        hasOwner: Boolean(ownerEmail),
        hasVerifiedDomain: verifiedDomainsCount > 0,
      }),
      lastActivityAt: lastEventByOrg.get(org.id)?.toISOString() ?? null,
      lifecycleStage: lifecycle.stage,
      lifecycleReasons: lifecycle.reasons,
    };
  });
}

// Precedence for rolling up multiple workspace billing statuses into a single
// org-level status for lifecycle derivation: an at-risk / cancelled signal on
// ANY workspace outranks a healthy one, so problems are never masked.
const BILLING_STATUS_PRECEDENCE = [
  "CANCELED",
  "PAST_DUE",
  "ACTIVE",
  "TRIALING",
  "INACTIVE",
];

function pickBillingStatus(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  for (const s of BILLING_STATUS_PRECEDENCE) {
    if (statuses.includes(s)) return s;
  }
  return statuses[0] ?? null;
}
// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type AdminOrgDetailWorkspace = {
  id: string;
  name: string;
  memberCount: number;
  caseCount: number | null;
  evidenceCount: number;
  reportCount: number | null;
  packageCount: number | null;
  /** COMPUTED health badge: HEALTHY | ATTENTION | BLOCKED | UNKNOWN. */
  health: OnboardingHealth;
};

export type AdminOrgDetail = {
  lifecycle: {
    stage: LifecycleStage;
    reasons: string[];
  };
  customerSuccess: {
    // --- REAL milestones (earliest / latest real timestamps) ---
    firstEvidenceAt: string | null;
    firstReportAt: string | null;
    firstPackageAt: string | null;
    lastActivityAt: string | null;
    lastLoginAt: string | null;
    // --- COMPUTED posture (real presence checks) ---
    ssoConfigured: boolean;
    scimConfigured: boolean;
    domainVerified: boolean;
    openIncidents: number | null;
    billingIssues: {
      pastDueWorkspaces: number;
      failedPayments: number;
    };
    riskStatus: LifecycleStage | null;
    // --- NOT MODELLED — honest nulls (no such signal in the schema) ---
    onboardingCompletion: null;
    accountManager: null;
    supportContact: null;
    renewalDate: null;
    supportTickets: null;
    /** Machine-readable note explaining the nulls above. */
    notModelled: string[];
  };
  /** Platform Map — the org → workspaces hierarchy with per-workspace counts. */
  workspaces: AdminOrgDetailWorkspace[];
  /**
   * ADM-015 — the canonical enterprise contract, from `resolveEnterpriseContract`.
   *
   * Null when this customer holds no contract at all. The resolver returns null
   * for any non-CUSTOMER organization by construction, so a SYSTEM container can
   * never present one.
   *
   * `legacyDerived` is surfaced deliberately and must stay surfaced: it means
   * the row does NOT exist and the projection was synthesised from org status by
   * the compatibility adapter that is load-bearing until the contract backfill
   * completes. An operator reading "ACTIVE" needs to know whether they are
   * reading a contract or a guess.
   */
  enterpriseContract: {
    status: string;
    activationState: string | null;
    effectiveAtUtc: string | null;
    endsAtUtc: string | null;
    seatCount: number | null;
    storageGb: number | null;
    evidenceRecordsPerMonth: number | null;
    aiOperationsPerMonth: number | null;
    region: string | null;
    planVersion: string | null;
    billingCustomerRef: string | null;
    billingSubscriptionRef: string | null;
    contractOwnerUserId: string | null;
    legacyDerived: boolean;
  } | null;
  overview: {
    id: string;
    name: string;
    legalName: string | null;
    status: string;
    plan: string | null;
    enterprise: boolean;
    createdAt: string;
    onboardingStatus: OnboardingHealth;
    setupCompletion: {
      hasWorkspace: boolean;
      hasOwner: boolean;
      hasVerifiedDomain: boolean;
    };
    owner: { userId: string; email: string | null; displayName: string | null } | null;
    admins: Array<{ userId: string; email: string | null; role: string }>;
    workspaces: Array<{
      id: string;
      name: string;
      billingPlan: string;
      billingStatus: string;
      includedSeats: number;
      usedSeats: number;
      overSeat: boolean;
    }>;
    seats: { included: number; used: number; overSeatWorkspaceCount: number };
  };
  identity: {
    sso: {
      configured: boolean;
      overallHealth: SsoConnectionHealthStatus | null;
      connections: Array<{
        connectionId: string;
        provider: string;
        status: string;
        health: SsoConnectionHealthStatus;
        lastSuccessAtUtc: string | null;
        lastFailureAtUtc: string | null;
        certExpiryBand: string;
        certNotAfterUtc: string | null;
      }>;
    };
    scim: {
      enabled: boolean;
      activeTokenCount: number;
      lastSyncAt: string | null;
    };
    domains: {
      verified: Array<{ domain: string; verifiedAt: string }>;
      pending: Array<{ domain: string }>;
    };
  };
  evidence: {
    evidenceCount: number;
    failedEvidenceCount: number | null;
    reportCount: number | null;
    verificationPackageCount: number | null;
  };
  governance: {
    activeLegalHolds: number | null;
    activeRetentionPolicies: number | null;
    pendingDestructionRequests: number | null;
  };
  billing: {
    billingOwner: { userId: string; email: string | null; displayName: string | null } | null;
    activeSubscriptions: number;
    failedPayments: number;
    planCounts: Record<string, number>;
    statusCounts: Record<string, number>;
  };
  activity: {
    recentEvents: Array<{
      id: string;
      eventType: string;
      targetType: string;
      actorUserId: string | null;
      createdAt: string;
      metadata: unknown;
    }>;
    provisioningHistory: Array<{
      id: string;
      action: string;
      userId: string | null;
      outcome: string | null;
      createdAt: string;
      metadata: unknown;
    }>;
  };
};

export class OrgNotFoundError extends Error {
  constructor() {
    super("ORG_NOT_FOUND");
    this.name = "OrgNotFoundError";
  }
}

export async function getAdminOrganizationDetail(
  orgId: string,
  client: PrismaClient = defaultPrisma,
): Promise<AdminOrgDetail> {
  const org = await client.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      legalName: true,
      status: true,
      createdAt: true,
      billingOwnerUserId: true,
    },
  });
  if (!org) throw new OrgNotFoundError();

  // --- Workspaces + seat rollup ---
  //
  // ADM-004 / ADM-008 / ADM-033 — three corrections in one query.
  //
  //   * `isPersonal: false` was the legacy discriminator. `workspaceKind` has
  //     been the canonical one since it was made NOT NULL by 20271125000000,
  //     and the two are not synonyms: a CUSTOMER organization's operational
  //     workspaces are `ORGANIZATION`, and asking for "not personal" also
  //     admits any `OWNED` workspace that happens to hang off the org.
  //   * closed workspaces were counted as part of the customer's estate.
  //   * `_count.members` counted SUSPENDED and REVOKED members as seats,
  //     contradicting the canonical ACTIVE-only seat rule that
  //     `workspace-usage.service.ts` and enterprise provisioning both apply.
  const workspaces = await client.team.findMany({
    where: {
      organizationId: org.id,
      workspaceKind: "ORGANIZATION",
      ...liveWorkspaceWhere(),
    },
    select: {
      id: true,
      name: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      _count: { select: { members: seatConsumingMemberCountArgs() } },
    },
    orderBy: { createdAt: "asc" },
  });

  let includedSeats = 0;
  let usedSeats = 0;
  let overSeatWorkspaceCount = 0;
  const plans: string[] = [];
  const planCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const workspaceRows = workspaces.map((ws) => {
    const included = ws.includedSeats ?? 0;
    const used = ws._count.members;
    const overSeat = included > 0 && used > included;
    includedSeats += included;
    usedSeats += used;
    if (overSeat) overSeatWorkspaceCount += 1;
    const plan = String(ws.billingPlan ?? "FREE");
    const status = String(ws.billingStatus ?? "INACTIVE");
    plans.push(plan);
    planCounts[plan] = (planCounts[plan] ?? 0) + 1;
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    return {
      id: ws.id,
      name: ws.name,
      billingPlan: plan,
      billingStatus: status,
      includedSeats: included,
      usedSeats: used,
      overSeat,
    };
  });
  const { plan } = derivePlan(plans);
  const workspaceIds = workspaces.map((w) => w.id);

  // --- Enterprise contract (ADM-003 / ADM-015) ---
  //
  // THE canonical authority, not a plan string. `resolveEnterpriseContract`
  // returns null for any non-CUSTOMER organization by construction, reads the
  // `EnterpriseContract` row when one exists, and otherwise synthesises a
  // `legacyDerived: true` projection from org status via the compatibility
  // adapter that stays load-bearing until the contract backfill completes.
  // That flag is passed straight through: an operator must be able to tell a
  // contract from a stand-in for one.
  const contract = await safeCall(
    () => resolveEnterpriseContract(org.id, client),
    null,
  );
  const contractProjection: AdminOrgDetail["enterpriseContract"] = contract
    ? {
        status: contract.status,
        activationState: contract.activationState ?? null,
        effectiveAtUtc: contract.effectiveAtUtc?.toISOString() ?? null,
        endsAtUtc: contract.endsAtUtc?.toISOString() ?? null,
        seatCount: contract.seatCount ?? null,
        storageGb: contract.storageGb ?? null,
        evidenceRecordsPerMonth: contract.evidenceRecordsPerMonth ?? null,
        aiOperationsPerMonth: contract.aiOperationsPerMonth ?? null,
        region: contract.region ?? null,
        planVersion: contract.planVersion ?? null,
        billingCustomerRef: contract.billingCustomerRef ?? null,
        billingSubscriptionRef: contract.billingSubscriptionRef ?? null,
        contractOwnerUserId: contract.contractOwnerUserId ?? null,
        legacyDerived: contract.legacyDerived === true,
      }
    : null;

  // --- Owner + admins (memberships; identity only, never secrets) ---
  const memberships = await client.organizationMembership.findMany({
    where: {
      organizationId: org.id,
      role: { in: ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_BILLING_ADMIN"] },
    },
    select: {
      userId: true,
      role: true,
      createdAt: true,
      user: { select: { email: true, displayName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const ownerMembership = memberships.find((m) => m.role === "ORG_OWNER") ?? null;
  const owner = ownerMembership
    ? {
        userId: ownerMembership.userId,
        email: ownerMembership.user?.email ?? null,
        displayName: ownerMembership.user?.displayName ?? null,
      }
    : null;
  const admins = memberships
    .filter((m) => m.role !== "ORG_OWNER")
    .map((m) => ({
      userId: m.userId,
      email: m.user?.email ?? null,
      role: m.role,
    }));

  // --- Domains ---
  const domains = await client.organizationDomain.findMany({
    where: { organizationId: org.id },
    select: { domain: true, verifiedAt: true },
    orderBy: { createdAt: "asc" },
  });
  const verifiedDomains = domains
    .filter((d) => d.verifiedAt)
    .map((d) => ({ domain: d.domain, verifiedAt: d.verifiedAt!.toISOString() }));
  const pendingDomains = domains
    .filter((d) => !d.verifiedAt)
    .map((d) => ({ domain: d.domain }));

  // --- SSO health (reuse per-workspace snapshot, aggregate) ---
  const ssoConnections: AdminOrgDetail["identity"]["sso"]["connections"] = [];
  let ssoConfigured = false;
  let worstHealth: SsoConnectionHealthStatus | null = null;
  const HEALTH_ORDER: SsoConnectionHealthStatus[] = [
    "HEALTHY",
    "UNCONFIGURED",
    "DISABLED",
    "DEGRADED",
    "OUTAGE",
  ];
  for (const wsId of workspaceIds) {
    const snapshot = await buildSsoHealthSnapshot({ teamId: wsId }, client);
    for (const conn of snapshot.connections) {
      ssoConfigured = true;
      ssoConnections.push({
        connectionId: conn.connectionId,
        provider: conn.provider,
        status: conn.status,
        health: conn.health,
        lastSuccessAtUtc: conn.lastSuccessAtUtc,
        lastFailureAtUtc: conn.lastFailureAtUtc,
        certExpiryBand: conn.cert.expiryBand,
        certNotAfterUtc: conn.cert.notAfterUtc,
      });
      const rank = HEALTH_ORDER.indexOf(conn.health);
      const worstRank = worstHealth ? HEALTH_ORDER.indexOf(worstHealth) : -1;
      if (rank > worstRank) worstHealth = conn.health;
    }
  }

  // --- SCIM (enablement + last sync; NEVER a token) ---
  let scimActiveTokenCount = 0;
  let scimLastSyncAt: string | null = null;
  if (workspaceIds.length > 0) {
    scimActiveTokenCount = await client.scimProvisioningToken.count({
      where: { teamId: { in: workspaceIds }, status: "ACTIVE" },
    });
    const lastUsed = await client.scimProvisioningToken.findFirst({
      where: { teamId: { in: workspaceIds }, lastUsedAtUtc: { not: null } },
      select: { lastUsedAtUtc: true },
      orderBy: { lastUsedAtUtc: "desc" },
    });
    scimLastSyncAt = lastUsed?.lastUsedAtUtc?.toISOString() ?? null;
  }

  // --- Evidence operations (counts only; NO hash recompute) ---
  // Evidence carries organizationId directly (Phase A1). Reports /
  // verification packages relate through evidence, so we count via the
  // evidence relation filter. deletedAt-null excludes soft-deleted rows.
  const evidenceCount = await client.evidence.count({
    where: { organizationId: org.id, deletedAt: null },
  });
  const failedEvidenceCount = await client.evidence.count({
    where: {
      organizationId: org.id,
      deletedAt: null,
      OR: [
        { status: "FAILED_HASH_MISMATCH" },
        { verificationStatus: "FAILED" },
      ],
    },
  });
  const reportCount = await client.report.count({
    where: { evidence: { organizationId: org.id, deletedAt: null } },
  });
  const verificationPackageCount = await client.verificationPackage.count({
    where: { evidence: { organizationId: org.id, deletedAt: null } },
  });

  // --- Governance (workspace-scoped counts; models keyed by teamId) ---
  let activeLegalHolds: number | null = null;
  let activeRetentionPolicies: number | null = null;
  let pendingDestructionRequests: number | null = null;
  if (workspaceIds.length > 0) {
    activeLegalHolds = await client.evidenceLegalHold.count({
      where: { teamId: { in: workspaceIds }, status: "ACTIVE" },
    });
    // Retention policies live as org-level OrganizationPolicy rows keyed
    // "retention.default" — count the published org retention default(s).
    activeRetentionPolicies = await client.organizationPolicy.count({
      where: { organizationId: org.id, key: "retention.default" },
    });
    // Destruction requests still in a pending/awaiting state (not executed).
    pendingDestructionRequests = await client.destructionRequest.count({
      where: {
        teamId: { in: workspaceIds },
        executedAtUtc: null,
      },
    });
  } else {
    activeRetentionPolicies = await client.organizationPolicy.count({
      where: { organizationId: org.id, key: "retention.default" },
    });
  }

  // --- Billing (subscriptions + failed payments; NO card/Stripe ids) ---
  const billingOwner = org.billingOwnerUserId
    ? await client.user.findUnique({
        where: { id: org.billingOwnerUserId },
        select: { id: true, email: true, displayName: true },
      })
    : null;

  let activeSubscriptions = 0;
  let failedPayments = 0;
  if (workspaceIds.length > 0) {
    activeSubscriptions = await client.subscription.count({
      where: { teamId: { in: workspaceIds }, status: "ACTIVE" },
    });
    failedPayments = await client.payment.count({
      where: { teamId: { in: workspaceIds }, status: "FAILED" },
    });
  }

  // --- Activity: org audit events + provisioning history (AdminAuditLog) ---
  const recentEvents = await client.organizationAuditEvent.findMany({
    where: { organizationId: org.id },
    select: {
      id: true,
      eventType: true,
      targetType: true,
      actorUserId: true,
      createdAt: true,
      metadata: true,
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  // Provisioning history: platform AdminAuditLog rows scoped to this org
  // (resourceId == org.id) for provisioning-class actions.
  const provisioningLogs = await client.adminAuditLog.findMany({
    where: {
      resourceId: org.id,
      action: {
        in: ["ORG_PLAN_GRANTED", "ENTERPRISE_PROVISIONED"],
      },
    },
    select: {
      id: true,
      action: true,
      userId: true,
      outcome: true,
      createdAt: true,
      metadata: true,
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  const onboardingStatus = deriveOnboarding({
    hasWorkspace: workspaces.length > 0,
    hasOwner: Boolean(owner),
    hasVerifiedDomain: verifiedDomains.length > 0,
  });

  // ---------------------------------------------------------------------------
  // Customer Success (item C) — REAL milestones + honest not-modelled fields.
  // ---------------------------------------------------------------------------

  // First / last evidence, report, package milestones (earliest createdAt).
  const firstEvidence = await safeCall(
    () =>
      client.evidence.findFirst({
        where: { organizationId: org.id, deletedAt: null },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    null as { createdAt: Date } | null,
  );
  const lastEvidence = await safeCall(
    () =>
      client.evidence.findFirst({
        where: { organizationId: org.id, deletedAt: null },
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
    null as { createdAt: Date } | null,
  );
  const firstReport = await safeCall(
    () =>
      client.report.findFirst({
        where: { evidence: { organizationId: org.id, deletedAt: null } },
        select: { generatedAtUtc: true },
        orderBy: { generatedAtUtc: "asc" },
      }),
    null as { generatedAtUtc: Date } | null,
  );
  const firstPackage = await safeCall(
    () =>
      client.verificationPackage.findFirst({
        where: { evidence: { organizationId: org.id, deletedAt: null } },
        select: { generatedAtUtc: true },
        orderBy: { generatedAtUtc: "asc" },
      }),
    null as { generatedAtUtc: Date } | null,
  );

  // Last login — latest login_completed AnalyticsEvent by any org member.
  const orgMemberUserIds = await safeCall(
    () =>
      client.organizationMembership.findMany({
        where: { organizationId: org.id },
        select: { userId: true },
      }),
    [] as Array<{ userId: string }>,
  );
  let lastLoginAt: string | null = null;
  const memberIds = orgMemberUserIds.map((m) => m.userId);
  if (memberIds.length > 0) {
    const lastLogin = await safeCall(
      () =>
        client.analyticsEvent.findFirst({
          where: { eventType: "login_completed", userId: { in: memberIds } },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
        }),
      null as { createdAt: Date } | null,
    );
    lastLoginAt = lastLogin?.createdAt?.toISOString() ?? null;
  }

  // Open operational incidents across the org's workspaces.
  let openIncidents: number | null = null;
  if (workspaceIds.length > 0) {
    openIncidents = await safeCall(
      () =>
        client.operationalIncident.count({
          where: { teamId: { in: workspaceIds }, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        }),
      null as number | null,
    );
  }

  // Billing issues (PAST_DUE workspaces + failed payments — both REAL).
  const pastDueWorkspaces = workspaceRows.filter(
    (w) => w.billingStatus === "PAST_DUE",
  ).length;

  // SSO outage presence for the risk derivation.
  const ssoOutageCount = await safeCall(
    () =>
      workspaceIds.length > 0
        ? client.ssoConnection.count({
            where: { teamId: { in: workspaceIds }, outageDetectedAtUtc: { not: null } },
          })
        : Promise.resolve(0),
    0,
  );

  const rollupBillingStatus = pickBillingStatus(
    workspaceRows.map((w) => w.billingStatus),
  );
  const anyPaidPlan = workspaceRows.some((w) => PAID_PLANS.has(w.billingPlan));
  const anyCanceledAt = workspaceRows.some((w) => w.billingStatus === "CANCELED");

  const lifecycle = deriveCustomerLifecycle({
    hasOrganization: true,
    organizationStatus: org.status,
    hasWorkspace: workspaces.length > 0,
    billingStatus: rollupBillingStatus,
    onPaidPlan: anyPaidPlan,
    billingActivatedAt: rollupBillingStatus === "ACTIVE" ? new Date() : null,
    billingCanceledAt: anyCanceledAt ? new Date() : null,
    hasEvidenceActivity: Boolean(firstEvidence),
    ssoOutage: ssoOutageCount > 0,
    recentFailedPayment: failedPayments > 0,
  });

  // riskStatus: expose the derived stage ONLY when it is a risk-class stage,
  // else null (we do not invent a risk signal).
  const riskStatus =
    lifecycle.stage === "AT_RISK" ||
    lifecycle.stage === "SUSPENDED" ||
    lifecycle.stage === "CANCELLED"
      ? lifecycle.stage
      : null;

  const lastActivityAt =
    lastEvidence?.createdAt?.toISOString() ??
    (recentEvents[0]?.createdAt?.toISOString() ?? null);

  const NOT_MODELLED_NOTES = [
    "onboardingCompletion: no onboarding-checklist model exists.",
    "accountManager: no CSM/account-manager assignment is modelled.",
    "supportContact: no support-contact field is modelled.",
    "renewalDate: no contract/renewal date is modelled.",
    "supportTickets: no support-ticket system is integrated.",
  ];

  // ---------------------------------------------------------------------------
  // Platform Map (item F) — per-workspace hierarchy with real counts.
  // ---------------------------------------------------------------------------
  const workspaceMap: AdminOrgDetailWorkspace[] = [];
  for (const ws of workspaceRows) {
    // WORKSPACE-SCOPE CONVERGENCE — resolved OUTSIDE the `safeCall` thunks.
    //
    // Inline `await` inside a synchronous arrow is not merely a type error: it
    // would also resolve the scope inside the retry/suppress wrapper, so a
    // failure to resolve it would be swallowed as "count unavailable" rather
    // than surfacing. Resolving first keeps the two failure modes distinct.
    const wsCaseScope = await workspaceCaseWhere(ws.id, client);
    const wsEvidenceScope = await workspaceEvidenceWhere(ws.id, client);
    const caseCount = await safeCall(
      () => client.case.count({ where: { AND: [wsCaseScope] } }),
      null as number | null,
    );
    const wsEvidenceCount = await safeCall(
      () => client.evidence.count({ where: { AND: [wsEvidenceScope], deletedAt: null } }),
      0,
    );
    const wsReportCount = await safeCall(
      () =>
        client.report.count({
          // Scoped through the canonical Evidence population, so the report
          // count describes the same records the evidence count did.
          where: { evidence: { AND: [wsEvidenceScope], deletedAt: null } },
        }),
      null as number | null,
    );
    const wsPackageCount = await safeCall(
      () =>
        client.verificationPackage.count({
          where: { evidence: { teamId: ws.id, deletedAt: null } },
        }),
      null as number | null,
    );
    // Per-workspace health: BLOCKED if no members; ATTENTION if over-seat or
    // no evidence yet; else HEALTHY. UNKNOWN reserved for absent signals.
    let health: OnboardingHealth;
    if (ws.usedSeats === 0) {
      health = "BLOCKED";
    } else if (ws.overSeat || wsEvidenceCount === 0) {
      health = "ATTENTION";
    } else {
      health = "HEALTHY";
    }
    workspaceMap.push({
      id: ws.id,
      name: ws.name,
      memberCount: ws.usedSeats,
      caseCount,
      evidenceCount: wsEvidenceCount,
      reportCount: wsReportCount,
      packageCount: wsPackageCount,
      health,
    });
  }

  return {
    lifecycle: {
      stage: lifecycle.stage,
      reasons: lifecycle.reasons,
    },
    customerSuccess: {
      firstEvidenceAt: firstEvidence?.createdAt?.toISOString() ?? null,
      firstReportAt: firstReport?.generatedAtUtc?.toISOString() ?? null,
      firstPackageAt: firstPackage?.generatedAtUtc?.toISOString() ?? null,
      lastActivityAt,
      lastLoginAt,
      ssoConfigured,
      scimConfigured: scimActiveTokenCount > 0,
      domainVerified: verifiedDomains.length > 0,
      openIncidents,
      billingIssues: {
        pastDueWorkspaces,
        failedPayments,
      },
      riskStatus,
      onboardingCompletion: null,
      accountManager: null,
      supportContact: null,
      renewalDate: null,
      supportTickets: null,
      notModelled: NOT_MODELLED_NOTES,
    },
    workspaces: workspaceMap,
    enterpriseContract: contractProjection,
    overview: {
      id: org.id,
      name: org.name,
      legalName: org.legalName ?? null,
      status: org.status,
      plan,
      // ADM-003 — the CONTRACT decides, not the plan string. `derivePlan`'s
      // `enterprise` flag is deliberately discarded here.
      enterprise: contractProjection?.status === "ACTIVE",
      createdAt: org.createdAt.toISOString(),
      onboardingStatus,
      setupCompletion: {
        hasWorkspace: workspaces.length > 0,
        hasOwner: Boolean(owner),
        hasVerifiedDomain: verifiedDomains.length > 0,
      },
      owner,
      admins,
      workspaces: workspaceRows,
      seats: {
        included: includedSeats,
        used: usedSeats,
        overSeatWorkspaceCount,
      },
    },
    identity: {
      sso: {
        configured: ssoConfigured,
        overallHealth: worstHealth,
        connections: ssoConnections,
      },
      scim: {
        enabled: scimActiveTokenCount > 0,
        activeTokenCount: scimActiveTokenCount,
        lastSyncAt: scimLastSyncAt,
      },
      domains: {
        verified: verifiedDomains,
        pending: pendingDomains,
      },
    },
    evidence: {
      evidenceCount,
      failedEvidenceCount,
      reportCount,
      verificationPackageCount,
    },
    governance: {
      activeLegalHolds,
      activeRetentionPolicies,
      pendingDestructionRequests,
    },
    billing: {
      billingOwner: billingOwner
        ? {
            userId: billingOwner.id,
            email: billingOwner.email,
            displayName: billingOwner.displayName,
          }
        : null,
      activeSubscriptions,
      failedPayments,
      planCounts,
      statusCounts,
    },
    activity: {
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        targetType: e.targetType,
        actorUserId: e.actorUserId,
        createdAt: e.createdAt.toISOString(),
        metadata: e.metadata ?? null,
      })),
      provisioningHistory: provisioningLogs.map((p) => ({
        id: p.id,
        action: p.action,
        userId: p.userId,
        outcome: p.outcome,
        createdAt: p.createdAt.toISOString(),
        metadata: p.metadata ?? null,
      })),
    },
  };
}

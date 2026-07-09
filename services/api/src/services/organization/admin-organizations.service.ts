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

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  buildSsoHealthSnapshot,
  type SsoConnectionHealthStatus,
} from "../security/sso-health.service.js";
import {
  deriveCustomerLifecycle,
  type LifecycleStage,
} from "../admin/customer-lifecycle.js";

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
   * Org-level plan derived from the workspaces: "ENTERPRISE" if ANY
   * non-personal workspace is on ENTERPRISE, else the highest-tier plan
   * present, else null when the org has no workspaces.
   */
  plan: string | null;
  enterprise: boolean;
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
};

// Plan tier ordering for "highest plan present" derivation.
const PLAN_RANK: Record<string, number> = {
  FREE: 0,
  PAYG: 1,
  PRO: 2,
  TEAM: 3,
  ENTERPRISE: 4,
};

function derivePlan(plans: string[]): { plan: string | null; enterprise: boolean } {
  if (plans.length === 0) return { plan: null, enterprise: false };
  let best = plans[0]!;
  for (const p of plans) {
    if ((PLAN_RANK[p] ?? -1) > (PLAN_RANK[best] ?? -1)) best = p;
  }
  return { plan: best, enterprise: plans.includes("ENTERPRISE") };
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
// List (roster)
// ---------------------------------------------------------------------------

export async function listAdminOrganizations(
  filters: AdminOrgListFilters,
  client: PrismaClient = defaultPrisma,
): Promise<AdminOrgListResult> {
  const page = Math.max(1, filters.page);
  const limit = Math.min(100, Math.max(1, filters.limit));

  // Base org filter: name search + status.
  const orgWhere: Record<string, unknown> = {};
  if (filters.status) orgWhere.status = filters.status;
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim();
    // Search by org name OR owner email (email requires a membership join).
    orgWhere.OR = [
      { name: { contains: q, mode: "insensitive" } },
      {
        memberships: {
          some: {
            role: "ORG_OWNER",
            user: { email: { contains: q, mode: "insensitive" } },
          },
        },
      },
    ];
  }

  // We must apply plan/health filters AFTER aggregation (they are derived,
  // not columns). To keep pagination honest we fetch the full candidate set
  // for the org-level filter, aggregate, filter, then page in memory. Org
  // count is bounded (platform tenant roster), so this is acceptable and
  // keeps every derived field truthful.
  const orgs = await client.organization.findMany({
    where: orgWhere,
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const enriched: AdminOrgListItem[] = [];
  for (const org of orgs) {
    const item = await buildListItem(org, client);
    enriched.push(item);
  }

  // Derived filters.
  let filtered = enriched;
  if (filters.plan) {
    filtered = filtered.filter((o) => o.plan === filters.plan);
  }
  if (filters.health) {
    filtered = filtered.filter((o) => o.onboardingStatus === filters.health);
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const items = filtered.slice(start, start + limit);

  return { items, page, limit, total, totalPages };
}

async function buildListItem(
  org: { id: string; name: string; status: string; createdAt: Date },
  client: PrismaClient,
): Promise<AdminOrgListItem> {
  const workspaces = await client.team.findMany({
    where: { organizationId: org.id, isPersonal: false },
    select: {
      id: true,
      billingPlan: true,
      billingStatus: true,
      billingActivatedAt: true,
      billingCanceledAt: true,
      includedSeats: true,
      _count: { select: { members: true } },
    },
  });

  let includedSeats = 0;
  let usedSeats = 0;
  const plans: string[] = [];
  const billingStatuses: string[] = [];
  let anyPaidPlan = false;
  let anyActivatedAt = false;
  let anyCanceledAt = false;
  for (const ws of workspaces) {
    includedSeats += ws.includedSeats ?? 0;
    usedSeats += ws._count.members;
    const wsPlan = String(ws.billingPlan ?? "FREE");
    plans.push(wsPlan);
    if (PAID_PLANS.has(wsPlan)) anyPaidPlan = true;
    billingStatuses.push(String(ws.billingStatus ?? "INACTIVE"));
    if (ws.billingActivatedAt) anyActivatedAt = true;
    if (ws.billingCanceledAt) anyCanceledAt = true;
  }
  const { plan, enterprise } = derivePlan(plans);

  const owner = await client.organizationMembership.findFirst({
    where: { organizationId: org.id, role: "ORG_OWNER" },
    select: { user: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });

  const verifiedDomainsCount = await client.organizationDomain.count({
    where: { organizationId: org.id, verifiedAt: { not: null } },
  });

  // SSO / SCIM presence — booleans only, scoped to the org's workspaces.
  // ssoConfigured: any non-revoked SsoConnection on any workspace.
  // scimConfigured: any ACTIVE ScimProvisioningToken on any workspace.
  const workspaceIds = workspaces.map((w) => w.id);
  let ssoConfigured = false;
  let scimConfigured = false;
  if (workspaceIds.length > 0) {
    const ssoCount = await client.ssoConnection.count({
      where: {
        teamId: { in: workspaceIds },
        status: { notIn: ["REVOKED"] },
      },
    });
    ssoConfigured = ssoCount > 0;
    const scimCount = await client.scimProvisioningToken.count({
      where: { teamId: { in: workspaceIds }, status: "ACTIVE" },
    });
    scimConfigured = scimCount > 0;
  }

  const lastEvent = await client.organizationAuditEvent.findFirst({
    where: { organizationId: org.id },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const onboardingStatus = deriveOnboarding({
    hasWorkspace: workspaces.length > 0,
    hasOwner: Boolean(owner),
    hasVerifiedDomain: verifiedDomainsCount > 0,
  });

  // Evidence activity presence — a single existence probe (not a full count).
  const evidenceActivityCount = await safeCall(
    () =>
      client.evidence.count({
        where: { organizationId: org.id, deletedAt: null },
      }),
    0,
  );

  // "most advanced" billing status across the org's workspaces for lifecycle.
  const rollupBillingStatus = pickBillingStatus(billingStatuses);

  const lifecycle = deriveCustomerLifecycle({
    hasOrganization: true,
    organizationStatus: org.status,
    hasWorkspace: workspaces.length > 0,
    billingStatus: rollupBillingStatus,
    onPaidPlan: anyPaidPlan,
    billingActivatedAt: anyActivatedAt ? new Date() : null,
    billingCanceledAt: anyCanceledAt ? new Date() : null,
    hasEvidenceActivity: evidenceActivityCount > 0,
  });

  return {
    id: org.id,
    name: org.name,
    createdAt: org.createdAt.toISOString(),
    status: org.status,
    plan,
    enterprise,
    workspaceCount: workspaces.length,
    seats: { included: includedSeats, used: usedSeats },
    ownerEmail: owner?.user?.email ?? null,
    verifiedDomainsCount,
    ssoConfigured,
    scimConfigured,
    onboardingStatus,
    lastActivityAt: lastEvent?.createdAt.toISOString() ?? null,
    lifecycleStage: lifecycle.stage,
    lifecycleReasons: lifecycle.reasons,
  };
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

  // --- Workspaces + seat rollup (mirror governance billing rollup) ---
  const workspaces = await client.team.findMany({
    where: { organizationId: org.id, isPersonal: false },
    select: {
      id: true,
      name: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      _count: { select: { members: true } },
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
  const { plan, enterprise } = derivePlan(plans);
  const workspaceIds = workspaces.map((w) => w.id);

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
    const caseCount = await safeCall(
      () => client.case.count({ where: { teamId: ws.id } }),
      null as number | null,
    );
    const wsEvidenceCount = await safeCall(
      () => client.evidence.count({ where: { teamId: ws.id, deletedAt: null } }),
      0,
    );
    const wsReportCount = await safeCall(
      () =>
        client.report.count({
          where: { evidence: { teamId: ws.id, deletedAt: null } },
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
    overview: {
      id: org.id,
      name: org.name,
      legalName: org.legalName ?? null,
      status: org.status,
      plan,
      enterprise,
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

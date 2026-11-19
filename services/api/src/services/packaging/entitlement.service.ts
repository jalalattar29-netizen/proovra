/**
 * PROOVRA Phase 4B — Entitlement service.
 *
 * Server-side enforcement surface for the product-line / entitlement
 * matrix. Every gated feature and every metered quota funnels through
 * this module so the audit log holds a single canonical story:
 *
 *   * `assertFeatureEntitlement` is the boolean gate for FEATURE-kind
 *     entitlements. Denials emit a POLICY_VIOLATION-equivalent
 *     lifecycle event via the intelligence-activity emitter.
 *   * `assertQuotaEntitlement` enforces QUOTA-kind entitlements by
 *     computing current-period consumption from `entitlement_usage`
 *     and comparing against the granted limit.
 *   * `upsertEntitlementGrant` writes a single grant row and emits an
 *     ENTITLEMENT_GRANTED lifecycle event. Reached only by a platform
 *     operator: `billing.manage` is a customer OWNER's permission, and it
 *     was the only gate, so a customer could grant themselves anything.
 *   * `applyProductLine` materialises every entitlement in a product
 *     line plan in a single transactional pass with `source='PLAN'`.
 *   * An ENTERPRISE workspace with an ACTIVE contract holds the ENTERPRISE
 *     line by right, with nothing stored and no step for the customer: a
 *     stored grant is an operator's exception to that, never the way a sold
 *     feature is switched on (BILLING-001).
 *
 * Hard rules:
 *   * Workspace-anchored — every read and every write is scoped to
 *     `teamId`.
 *   * Bounded reason vocabulary — denial reasons are short snake-case
 *     chips, never raw values, never PII.
 *   * Lifecycle audit must never block the operational path; emit
 *     failures are swallowed by the underlying emitter.
 *   * Defaults are conservative free-tier values so an unprovisioned
 *     team is never accidentally granted enterprise capability.
 */

import type { PrismaClient } from "@prisma/client";
import {
  ENTITLEMENT_KEYS,
  PRODUCT_LINES,
  type EntitlementKey,
  type EntitlementProjection,
  type ProductLine,
} from "@proovra/shared";

import {
  classifyEntitlementPeriod,
  consumeEntitlementMeter,
  decideEntitlementSource,
  entitlementGrantLive,
  entitlementPeriodStart,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { emitLifecycleEvent } from "../intelligence/intelligence-activity.service.js";
import { acquireLease } from "../rate-limit.js";

// ===========================================================================
// Kind classification
// ===========================================================================

type EntitlementKind = "FEATURE" | "QUOTA" | "LIMIT";

function classifyKind(key: EntitlementKey): EntitlementKind {
  if (key.startsWith("FEATURE_")) return "FEATURE";
  if (key.startsWith("QUOTA_")) return "QUOTA";
  return "LIMIT";
}

// ===========================================================================
// DEFAULT_ENTITLEMENTS — free-tier baseline
// ===========================================================================

type EntitlementValue = boolean | number;

// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `QUOTA_EVIDENCE_COUNT` and
// `QUOTA_STORAGE_BYTES` were REMOVED from this engine and from
// `ENTITLEMENT_KEYS`.
//
// They were a SECOND authority over two quantities the commercial plan catalog
// already owns, keyed on PRODUCT LINE rather than on the purchased plan, and
// they disagreed with it on the number AND on the window (a monthly byte
// budget versus cumulative capacity; 100 records a calendar month versus 500 a
// rolling 30 days). Their unprovisioned defaults silently capped every shared
// workspace at 1 GiB and 100 records a month whatever it had bought.
//
// Evidence-record and storage limits now have exactly one authority:
// `PLAN_CAPABILITIES`, enforced by `billing-enforcement.service.ts` and
// `workspace-usage.service.ts`. This engine keeps only the FEATURE and
// non-commercial LIMIT entitlements it is actually the authority for.
//
// Existing `entitlement_grants` rows carrying the removed keys are left in
// place — no historical entitlement record is rewritten — and are simply never
// read again.
//
// WCR-01 (2026-09-07) — THE SWEEP ABOVE WAS INCOMPLETE. Three more keys
// carried the same defect and are removed on the same reasoning:
//
//   QUOTA_USERS          gated `POST /v1/teams/:id/invites` ahead of the
//                        canonical seat authority. Unprovisioned default 3,
//                        counted per CALENDAR MONTH and never decremented, so
//                        a TEAM workspace that bought ten seats could invite
//                        three people a month. Workspace membership capacity
//                        has one authority: `resolveWorkspaceSeatState`.
//
//   QUOTA_REVIEWER_SEATS gated reviewer assignment the same way. Unprovisioned
//                        default 1 per calendar month, counting ASSIGNMENTS
//                        against a number named SEATS — so a workspace whose
//                        plan includes reviewer operations could make one
//                        assignment a month. Reviewer capability has one
//                        authority: `PlanCapabilities.reviewerOperationsIncluded`,
//                        already enforced by `requireReviewerCapable`.
//
//   QUOTA_WORKSPACES     had no enforcement site at all. Dead on arrival, and
//                        the final model sells no additional workspaces, so
//                        there is nothing for it to come back to answer.
//
// A quota whose default refuses what the plan sells is not a safety net; it is
// a second commercial authority that wins by running first.
//
// PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07) — AND SO IS A FEATURE
// FLAG WHOSE DEFAULT REFUSES WHAT THE PLAN SELLS. Four more keys are removed
// here and from ENTITLEMENT_KEYS: FEATURE_EXTERNAL_PORTAL,
// FEATURE_INTELLIGENCE, FEATURE_REVIEWER_WORKSPACE and
// QUOTA_AI_OPERATIONS_PER_MONTH. See the note on ENTITLEMENT_KEYS for what
// each one broke and which canonical authority now answers it.
//
// WHAT THIS ENGINE STILL OWNS, AND LEGITIMATELY: the operational and
// governance FEATURE flags that have NO counterpart in the plan catalog
// (redaction, legal hold, archive tiers, chain transfer, evidence exchange,
// webhooks, destruction governance, delegated admin, department isolation,
// cross-org review, trust center, governance platform, lifecycle dashboard)
// and the non-commercial LIMIT entitlements. For those it is the ONLY
// authority, which is precisely the condition under which a packaging engine
// is sound. The rule is not "packaging is bad"; it is "two answers to one
// commercial question is bad".
export const DEFAULT_ENTITLEMENTS: Record<
  EntitlementKey,
  { kind: EntitlementKind; value: EntitlementValue }
> = {
  FEATURE_REDACTION: { kind: "FEATURE", value: false },
  FEATURE_TRUST_CENTER: { kind: "FEATURE", value: true },
  FEATURE_GOVERNANCE_PLATFORM: { kind: "FEATURE", value: false },
  FEATURE_EVIDENCE_EXCHANGE: { kind: "FEATURE", value: false },
  FEATURE_WEBHOOKS: { kind: "FEATURE", value: false },
  FEATURE_CHAIN_TRANSFER: { kind: "FEATURE", value: false },
  FEATURE_LEGAL_HOLD: { kind: "FEATURE", value: false },
  FEATURE_ARCHIVE_TIERS: { kind: "FEATURE", value: false },
  FEATURE_DESTRUCTION_GOVERNANCE: { kind: "FEATURE", value: false },
  FEATURE_LIFECYCLE_DASHBOARD: { kind: "FEATURE", value: false },
  FEATURE_DELEGATED_ADMIN: { kind: "FEATURE", value: false },
  FEATURE_DEPARTMENT_ISOLATION: { kind: "FEATURE", value: false },
  FEATURE_CROSS_ORG_REVIEW: { kind: "FEATURE", value: false },
  QUOTA_API_REQUESTS_PER_DAY: { kind: "QUOTA", value: 500 },
  QUOTA_WEBHOOK_DELIVERIES_PER_DAY: { kind: "QUOTA", value: 0 },
  QUOTA_EXPORT_PACKAGES_PER_MONTH: { kind: "QUOTA", value: 2 },
  RETENTION_MAX_YEARS: { kind: "LIMIT", value: 1 },
  // A2-11 (Free-user audit, 2026-11-14) — Pricing lists "Integrations & APIs"
  // as not included off Enterprise, so an unprovisioned workspace mints no key.
  // The product lines (3 / 10 / 100) and an ACTIVE Enterprise contract (the
  // ENTERPRISE line's value, through resolveEntitlement) still grant theirs.
  // PRO-G1-14 / DEC-09 (2026-11-18) — it is also read at USE time
  // (`requireApiKey`): while the current value is 0 an issued key is refused
  // with ENTITLEMENT_REQUIRED, unrevoked, and works again once restored.
  INTEGRATION_API_KEYS_MAX: { kind: "LIMIT", value: 0 },
  INTEGRATION_WEBHOOK_ENDPOINTS_MAX: { kind: "LIMIT", value: 0 },
};

// ===========================================================================
// PLAN_LINE_ENTITLEMENTS — product line plan matrix
// ===========================================================================

export const PLAN_LINE_ENTITLEMENTS: Record<
  ProductLine,
  Partial<Record<EntitlementKey, EntitlementValue>>
> = {
  CAPTURE_AND_VERIFY: {
    FEATURE_TRUST_CENTER: true,
    FEATURE_REDACTION: true,
    QUOTA_API_REQUESTS_PER_DAY: 10_000,
    QUOTA_EXPORT_PACKAGES_PER_MONTH: 25,
    RETENTION_MAX_YEARS: 3,
    INTEGRATION_API_KEYS_MAX: 3,
  },
  INVESTIGATIONS: {
    FEATURE_TRUST_CENTER: true,
    FEATURE_REDACTION: true,
    FEATURE_EVIDENCE_EXCHANGE: true,
    FEATURE_WEBHOOKS: true,
    FEATURE_CHAIN_TRANSFER: true,
    // FEATURE_LEGAL_HOLD is NOT granted by a product line (2026-09-08).
    //
    // Legal Hold is an ENTERPRISE capability whose availability is decided by
    // the Enterprise CONTRACT, and `applyProductLine` is not the contract.
    // Granting it here let a non-Enterprise workspace hold the capability
    // because someone applied the INVESTIGATIONS line to it — a second
    // commercial authority answering a question the contract already owns.
    // `resolveEntitlement` now derives this key from plan + contract and
    // ignores stored grants for it entirely.
    FEATURE_ARCHIVE_TIERS: true,
    FEATURE_LIFECYCLE_DASHBOARD: true,
    QUOTA_API_REQUESTS_PER_DAY: 100_000,
    QUOTA_WEBHOOK_DELIVERIES_PER_DAY: 10_000,
    QUOTA_EXPORT_PACKAGES_PER_MONTH: 250,
    RETENTION_MAX_YEARS: 7,
    INTEGRATION_API_KEYS_MAX: 10,
    INTEGRATION_WEBHOOK_ENDPOINTS_MAX: 10,
  },
  ENTERPRISE: {
    FEATURE_TRUST_CENTER: true,
    FEATURE_REDACTION: true,
    FEATURE_GOVERNANCE_PLATFORM: true,
    FEATURE_EVIDENCE_EXCHANGE: true,
    FEATURE_WEBHOOKS: true,
    FEATURE_CHAIN_TRANSFER: true,
    // Not here either — see the INVESTIGATIONS note. Even on the ENTERPRISE
    // line the grant would be a SECOND source of truth beside the contract,
    // and the two could disagree the moment a contract lapsed while the grant
    // row remained.
    FEATURE_ARCHIVE_TIERS: true,
    FEATURE_DESTRUCTION_GOVERNANCE: true,
    FEATURE_LIFECYCLE_DASHBOARD: true,
    FEATURE_DELEGATED_ADMIN: true,
    FEATURE_DEPARTMENT_ISOLATION: true,
    FEATURE_CROSS_ORG_REVIEW: true,
    QUOTA_API_REQUESTS_PER_DAY: 5_000_000,
    QUOTA_WEBHOOK_DELIVERIES_PER_DAY: 1_000_000,
    QUOTA_EXPORT_PACKAGES_PER_MONTH: 10_000,
    RETENTION_MAX_YEARS: 25,
    INTEGRATION_API_KEYS_MAX: 100,
    INTEGRATION_WEBHOOK_ENDPOINTS_MAX: 100,
  },
};

// ===========================================================================
// Period helpers (QUOTA windowing)
// ===========================================================================

// The period clock lives beside the ONE meter writer in
// `@proovra/shared-runtime` (the Worker's package builder meters too, and may
// not import this module). The reader below uses the same pair, so gate and
// meter still read one clock.
const classifyPeriod = (key: EntitlementKey) => classifyEntitlementPeriod(key);
const periodStart = entitlementPeriodStart;

// ===========================================================================
// Internal projection helpers
// ===========================================================================

type GrantRow = {
  id: string;
  key: string;
  kind: string;
  valueBool: boolean | null;
  valueNumber: bigint | null;
  source: string;
  productLine: string | null;
  grantedAtUtc: Date;
  expiresAtUtc: Date | null;
};

function projectGrant(
  key: EntitlementKey,
  row: GrantRow,
): EntitlementProjection {
  const kind = (
    ["FEATURE", "QUOTA", "LIMIT"].includes(row.kind)
      ? row.kind
      : classifyKind(key)
  ) as EntitlementKind;
  const value: boolean | number =
    kind === "FEATURE"
      ? row.valueBool ?? false
      : Number(row.valueNumber ?? 0);
  const source = (
    ["PLAN", "CUSTOM", "PROMO", "DEFAULT"].includes(row.source)
      ? row.source
      : "PLAN"
  ) as EntitlementProjection["source"];
  return {
    key,
    kind,
    value,
    source,
    updatedAtUtc: row.grantedAtUtc.toISOString(),
    expiresAtUtc: row.expiresAtUtc ? row.expiresAtUtc.toISOString() : null,
  };
}

function projectDefault(key: EntitlementKey): EntitlementProjection {
  const def = DEFAULT_ENTITLEMENTS[key];
  return {
    key,
    kind: def.kind,
    value: def.value,
    source: "DEFAULT",
    updatedAtUtc: new Date(0).toISOString(),
    expiresAtUtc: null,
  };
}


// ===========================================================================
// resolveEntitlement
// ===========================================================================

/**
 * ===========================================================================
 * LEGAL HOLD — THE ONE EFFECTIVE COMMERCIAL ANSWER.
 * ===========================================================================
 * Legal Hold is an ENTERPRISE governance capability whose availability is
 * CONTRACT-DRIVEN. Enterprise plan eligibility is not runtime authorization:
 * the catalog says the capability may be sold, the contract says whether THIS
 * customer bought it.
 *
 *     ENTERPRISE plan          — eligibility, necessary and not sufficient
 *         ↓
 *     ACTIVE Enterprise contract that states the term
 *         ↓
 *     FEATURE_LEGAL_HOLD       — the effective entitlement routes consume
 *
 * WHY THIS IS RESOLVED HERE AND NOT AT THE CALL SITES. Every consumer already
 * reads this key through `resolveEntitlement` — the two lifecycle routes, the
 * two governance routes, `capability-status.service` and the UI projection it
 * feeds. Deriving the answer here means all of them get the SAME answer and
 * none of them can hold an opinion of its own. A helper the routes had to
 * remember to call would have been a second authority the day someone forgot.
 *
 * WHY THE STORED GRANT NO LONGER DECIDES IT. `EntitlementGrant` rows are
 * written by `applyProductLine`, which is not the Enterprise contract. Leaving
 * both live would mean a non-Enterprise workspace could hold Legal Hold via a
 * product line while the contract said nothing — two authorities disagreeing
 * about one commercial question, which is the defect this whole area exists to
 * remove. `FEATURE_LEGAL_HOLD` is therefore removed from the product-line
 * matrix, and this function is the only thing that answers for the key.
 *
 * FAIL CLOSED at every step: no workspace, no plan, wrong plan, no contract,
 * non-ACTIVE contract, silent contract, or an engine failure all resolve to
 * NOT ENTITLED. Nothing here reads or mutates a hold — see the note on
 * admission below.
 */
async function resolveLegalHoldEntitlement(
  prisma: PrismaClient,
  teamId: string,
): Promise<EntitlementProjection> {
  const notEntitled: EntitlementProjection = {
    key: "FEATURE_LEGAL_HOLD",
    kind: "FEATURE",
    value: false,
    source: "DEFAULT",
    updatedAtUtc: new Date(0).toISOString(),
    expiresAtUtc: null,
  };
  try {
    const workspace = await prisma.team.findUnique({
      where: { id: teamId },
      select: { ownerUserId: true },
    });
    if (!workspace) return notEntitled;

    const { resolveCommercialContext } = await import(
      "../billing/commercial-context.service.js"
    );
    const ctx = await resolveCommercialContext({
      type: "WORKSPACE",
      teamId,
      requesterUserId: workspace.ownerUserId,
    });
    // ELIGIBILITY. FREE / PAYG / PRO / TEAM do not sell Legal Hold at all, so
    // no contract term could apply to them.
    if (ctx.plan !== "ENTERPRISE") return notEntitled;

    const { resolveEnterpriseContractLimits } = await import(
      "../billing/enterprise-contract-limits.js"
    );
    // ACTIVATION. `resolveEnterpriseContractLimits` fails closed on status
    // before it reads the term, so DRAFT / PENDING_ACTIVATION / SUSPENDED /
    // TERMINATED grant nothing — an expired or suspended agreement stops NEW
    // holds with no extra logic here.
    const limits = resolveEnterpriseContractLimits(ctx.enterpriseContract);
    if (!limits.legalHoldEnabled) return notEntitled;

    return {
      key: "FEATURE_LEGAL_HOLD",
      kind: "FEATURE",
      value: true,
      // The grant comes from the contract, and the projection says so rather
      // than claiming a stored PLAN grant that does not exist.
      source: "CUSTOM",
      updatedAtUtc: new Date(0).toISOString(),
      expiresAtUtc: null,
    };
  } catch {
    // A commercial engine that cannot answer has not said yes.
    return notEntitled;
  }
}

/**
 * Where a workspace stands on the Enterprise line, from the one commercial
 * authority. A plan label alone is not standing: ACTIVE is the only contract
 * state that grants anything (BIL-R05).
 */
type EnterpriseStanding = "NOT_ENTERPRISE" | "CONTRACT_ACTIVE" | "CONTRACT_LAPSED";

/**
 * PRO-R3-07 / DEC-10 (WS-ENT) — the standing, plus whether the workspace's paid
 * subscription has TERMINALLY lapsed (`lifecycle.mutationsAllowed === false`:
 * past due beyond grace, or cancelled). A product-line grant (`source: PLAN`,
 * written by `applyProductLine` for a paying customer) stops answering while
 * the subscription is lapsed; reads of what already exists are the routes'
 * business and are unaffected. A CUSTOM / PROMO exception is bounded by its own
 * expiry instead (DEC-12). The commercial engine is asked once.
 */
type StandingFacts = { standing: EnterpriseStanding; paidLapsed: boolean };

async function resolveStandingFacts(prisma: PrismaClient, teamId: string): Promise<StandingFacts> {
  try {
    const workspace = await prisma.team.findUnique({
      where: { id: teamId },
      select: { ownerUserId: true },
    });
    if (!workspace) return { standing: "NOT_ENTERPRISE", paidLapsed: false };
    const { resolveCommercialContext } = await import(
      "../billing/commercial-context.service.js"
    );
    const ctx = await resolveCommercialContext({
      type: "WORKSPACE",
      teamId,
      requesterUserId: workspace.ownerUserId,
    });
    const paidLapsed = ctx.lifecycle?.mutationsAllowed === false;
    if (ctx.plan !== "ENTERPRISE") return { standing: "NOT_ENTERPRISE", paidLapsed };
    const { resolveEnterpriseContractLimits } = await import(
      "../billing/enterprise-contract-limits.js"
    );
    return {
      standing: resolveEnterpriseContractLimits(ctx.enterpriseContract).contractGovernsCapability
        ? "CONTRACT_ACTIVE"
        : "CONTRACT_LAPSED",
      paidLapsed,
    };
  } catch {
    // A commercial engine that cannot answer has not said yes.
    return { standing: "NOT_ENTERPRISE", paidLapsed: false };
  }
}


export async function resolveEntitlement(input: {
  prisma?: PrismaClient;
  teamId: string;
  key: EntitlementKey;
  /** Resolved once by a caller reading several keys of one workspace. */
  standing?: EnterpriseStanding;
  /** PRO-R3-07 — resolved with `standing` (see `resolveStandingFacts`). */
  paidLapsed?: boolean;
}): Promise<EntitlementProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  /**
   * Legal Hold answers from the contract, never from a stored grant row.
   *
   * This governs ADMISSION to creating a NEW hold and nothing else. An ACTIVE
   * hold placed under any past commercial state keeps protecting its evidence
   * through downgrade, contract expiry, entitlement removal and billing
   * suspension: the destruction formula consults hold rows and takes no
   * commercial input, and release runs through the Legal Hold lifecycle
   * authority. Losing entitlement must never make evidence destructible.
   */
  if (input.key === "FEATURE_LEGAL_HOLD") {
    return resolveLegalHoldEntitlement(prisma, input.teamId);
  }
  const facts: StandingFacts =
    input.standing !== undefined
      ? { standing: input.standing, paidLapsed: input.paidLapsed === true }
      : await resolveStandingFacts(prisma, input.teamId);
  const standing = facts.standing;
  // A lapsed contract grants nothing, including through a stored row.
  if (standing === "CONTRACT_LAPSED") return projectDefault(input.key);
  // RG-13 — the decision (grant / contract / default) is the shared one the
  // Worker's sweeps ask too (`decideEntitlementSource`, shared-runtime).
  const sold = PLAN_LINE_ENTITLEMENTS.ENTERPRISE[input.key];
  try {
    const row = (await prisma.entitlementGrant.findUnique({
      where: { teamId_key: { teamId: input.teamId, key: input.key } },
      select: {
        id: true,
        key: true,
        kind: true,
        valueBool: true,
        valueNumber: true,
        source: true,
        productLine: true,
        grantedAtUtc: true,
        expiresAtUtc: true,
      },
    })) as GrantRow | null;
    // PRO-R3-07 — a product-line grant does not outlive the paid subscription
    // it was applied for (terminal lapse); restoring payment restores it.
    const suspendedByLapse = facts.paidLapsed && row?.source === "PLAN";
    if (
      row &&
      decideEntitlementSource({
        standing,
        grantLive: entitlementGrantLive(row) && !suspendedByLapse,
        contractSellsKey: sold !== undefined,
      }) === "GRANT"
    ) {
      return projectGrant(input.key, row);
    }
  } catch {
    return projectDefault(input.key);
  }
  /*
   * WHAT THE CONTRACT SOLD. Provisioning never applied a product line, so a new
   * Enterprise customer held the free baseline until its owner found a hidden
   * console and granted the features to themselves. An ACTIVE contract is the
   * activation: nothing is stored, so nothing can go stale when it lapses.
   */
  if (
    sold !== undefined &&
    decideEntitlementSource({ standing, grantLive: false, contractSellsKey: true }) === "CONTRACT"
  ) {
    return {
      ...projectDefault(input.key),
      value: sold,
      source: "PLAN",
    };
  }
  return projectDefault(input.key);
}

/**
 * RG-13 — several keys of ONE workspace, with its Enterprise standing resolved
 * once (a per-request caller such as `requireApiKey` reads two keys; resolving
 * the commercial context twice per call is wasted work).
 */
export async function resolveEntitlements<K extends EntitlementKey>(input: {
  prisma?: PrismaClient;
  teamId: string;
  keys: ReadonlyArray<K>;
}): Promise<Record<K, EntitlementProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const { standing, paidLapsed } = await resolveStandingFacts(prisma, input.teamId);
  const out = {} as Record<K, EntitlementProjection>;
  for (const key of input.keys) {
    out[key] = await resolveEntitlement({ prisma, teamId: input.teamId, key, standing, paidLapsed });
  }
  return out;
}

// ===========================================================================
// consumeQuotaEntitlement — per-use QUOTA keys (RG-13 / PRO-G1-04)
// ===========================================================================

/**
 * The per-use QUOTA keys and the one place each is consumed:
 *
 *   QUOTA_API_REQUESTS_PER_DAY        `requireApiKey`, one per authenticated
 *                                     machine request;
 *   QUOTA_WEBHOOK_DELIVERIES_PER_DAY  every webhook delivery CREATED, on all
 *                                     three channels (integration, lifecycle,
 *                                     automation) — retries of one delivery
 *                                     do not consume again.
 *
 * Both were declared, defaulted, sold per product line and displayed, and
 * nothing read or wrote them (PRO-G1-04 / PRO-BL2-04 / PRO-W2-05).
 */
export const PER_USE_QUOTA_KEYS = ["QUOTA_API_REQUESTS_PER_DAY", "QUOTA_WEBHOOK_DELIVERIES_PER_DAY"] as const;
export type PerUseQuotaKey = (typeof PER_USE_QUOTA_KEYS)[number];

/**
 * Admit and record `amount` units of a per-use quota for one workspace, in one
 * atomic statement (`consumeEntitlementMeter`): N concurrent callers at
 * limit - 1 admit exactly one; a refused unit is not recorded. The window is
 * the key's UTC period (`entitlementPeriodStart`), the same clock
 * `assertQuotaEntitlement` reads.
 *
 * No lifecycle denial event is written per refusal: a refused API call is
 * recorded on the credential's usage log and a withheld delivery on its own
 * row, and an event per refusal would flood the activity log at exactly the
 * moment a tenant is over quota.
 */
export async function consumeQuotaEntitlement(input: {
  prisma?: PrismaClient;
  teamId: string;
  key: PerUseQuotaKey;
  amount?: number;
  resolved?: EntitlementProjection;
  now?: Date;
}): Promise<{ ok: true; limit: number; consumed: number | null } | { ok: false; denial: "QUOTA_EXCEEDED"; limit: number }> {
  const prisma = input.prisma ?? defaultPrisma;
  const projection =
    input.resolved ?? (await resolveEntitlement({ prisma, teamId: input.teamId, key: input.key }));
  const limit = typeof projection.value === "number" ? projection.value : 0;
  const result = await consumeEntitlementMeter(prisma as never, {
    teamId: input.teamId,
    key: input.key,
    periodStartUtc: periodStart(classifyPeriod(input.key), input.now ?? new Date()),
    amount: input.amount ?? 1,
    limit,
  });
  if (!result.ok) return { ok: false, denial: "QUOTA_EXCEEDED", limit };
  return { ok: true, limit, consumed: result.consumed };
}

// ===========================================================================
// admitWebhookDelivery — the use-time gate of every webhook channel (RG-13)
// ===========================================================================

export type WebhookDeliveryRefusal = "entitlement_required" | "quota_exceeded" | "admission_unavailable";

/**
 * PRO-G1-14 / PRO-W2-05 / B7B-F05 / DEC-09 — may ONE new webhook delivery be
 * created for this workspace now?
 *
 * Entitlement used to be asked only when an endpoint was created or widened,
 * so endpoints of a workspace that lost FEATURE_WEBHOOKS (a lapsed contract, a
 * removed or expired grant) kept receiving every event, and the daily delivery
 * quota had no reader. Now every channel asks this before it writes a delivery:
 *
 *   - the feature (`featureKey`, FEATURE_WEBHOOKS for the integration and
 *     lifecycle channels; automation passes its own governance key, already
 *     asked by its dispatcher, as null);
 *   - then one unit of QUOTA_WEBHOOK_DELIVERIES_PER_DAY, atomically.
 *
 * The pause is REVERSIBLE: nothing is deactivated, so restoring the
 * entitlement (or the next UTC day) restores delivery. Fails CLOSED: an
 * engine that cannot answer withholds the delivery with a recorded reason.
 */
export async function admitWebhookDelivery(input: {
  prisma?: PrismaClient;
  teamId: string;
  featureKey: "FEATURE_WEBHOOKS" | null;
  /** Resolved once per emission by the caller (several endpoints, one event). */
  cache?: Map<string, EntitlementProjection>;
}): Promise<{ ok: true } | { ok: false; reason: WebhookDeliveryRefusal }> {
  const prisma = input.prisma ?? defaultPrisma;
  try {
    const cache = input.cache ?? new Map<string, EntitlementProjection>();
    if (!cache.has("QUOTA_WEBHOOK_DELIVERIES_PER_DAY")) {
      const keys: EntitlementKey[] = input.featureKey
        ? [input.featureKey, "QUOTA_WEBHOOK_DELIVERIES_PER_DAY"]
        : ["QUOTA_WEBHOOK_DELIVERIES_PER_DAY"];
      const resolved = await resolveEntitlements({ prisma, teamId: input.teamId, keys });
      for (const [k, v] of Object.entries(resolved)) cache.set(k, v as EntitlementProjection);
    }
    if (input.featureKey && cache.get(input.featureKey)?.value !== true) {
      return { ok: false, reason: "entitlement_required" };
    }
    const quota = await consumeQuotaEntitlement({
      prisma,
      teamId: input.teamId,
      key: "QUOTA_WEBHOOK_DELIVERIES_PER_DAY",
      resolved: cache.get("QUOTA_WEBHOOK_DELIVERIES_PER_DAY"),
    });
    if (!quota.ok) return { ok: false, reason: "quota_exceeded" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "admission_unavailable" };
  }
}

// ===========================================================================
// Denial emit helper (POLICY_VIOLATION-equivalent)
// ===========================================================================

/** PRO-BL2-08 — one denial event per (workspace, key, actor) per window. */
const ENTITLEMENT_DENIAL_EVENT_WINDOW_MS = 60 * 60_000;

async function emitDenial(
  prisma: PrismaClient,
  teamId: string,
  key: EntitlementKey,
  actorUserId: string | null | undefined,
  denial: "ENTITLEMENT_REQUIRED" | "QUOTA_EXCEEDED",
): Promise<void> {
  // Map denial family to bounded INTELLIGENCE_LIFECYCLE_CODES members.
  // FEATURE / LIMIT denials -> POLICY_VIOLATION_ENTITLEMENT
  // QUOTA denials          -> POLICY_VIOLATION_QUOTA
  const kind = classifyKind(key);
  const code =
    denial === "QUOTA_EXCEEDED" || kind === "QUOTA"
      ? ("POLICY_VIOLATION_QUOTA" as const)
      : ("POLICY_VIOLATION_ENTITLEMENT" as const);

  // PRO-BL2-08 — a violation ledger records an attempt, not every request that
  // asked: one event per (workspace, key, actor, denial) per window. Repeats
  // inside the window are counted only by the caller's own refusal.
  try {
    const lease = await acquireLease(
      `entitlement-denial:${teamId}:${key}:${actorUserId ?? "-"}:${denial}`,
      ENTITLEMENT_DENIAL_EVENT_WINDOW_MS,
    );
    if (!lease.acquired) return;
  } catch {
    // The store threw outright: record rather than lose the window's only event.
  }

  await emitLifecycleEvent({
    prisma,
    teamId,
    code,
    actorUserId: actorUserId ?? null,
    reason: `entitlement_${denial.toLowerCase()}:${key}`.slice(0, 200),
    targetType: "ENTITLEMENT",
    targetId: key,
    payload: {
      entitlementKey: key,
      denial,
    },
  });
}

// ===========================================================================
// assertFeatureEntitlement
// ===========================================================================

export async function assertFeatureEntitlement(input: {
  prisma?: PrismaClient;
  teamId: string;
  key: EntitlementKey;
  actorUserId?: string | null;
  /**
   * PRO-BL2-08 — false for a READ (a page load, a status probe): asking is not
   * a violation attempt, so nothing is written. Default true (writes).
   */
  record?: boolean;
}): Promise<
  | { ok: true }
  | { ok: false; denial: "ENTITLEMENT_REQUIRED"; requiredEntitlement: EntitlementKey }
> {
  const prisma = input.prisma ?? defaultPrisma;
  const projection = await resolveEntitlement({
    prisma,
    teamId: input.teamId,
    key: input.key,
  });
  if (projection.kind !== "FEATURE") {
    if (input.record !== false) await emitDenial(prisma, input.teamId, input.key, input.actorUserId, "ENTITLEMENT_REQUIRED");
    return {
      ok: false,
      denial: "ENTITLEMENT_REQUIRED",
      requiredEntitlement: input.key,
    };
  }
  if (projection.value === true) return { ok: true };
  if (input.record !== false) await emitDenial(prisma, input.teamId, input.key, input.actorUserId, "ENTITLEMENT_REQUIRED");
  return {
    ok: false,
    denial: "ENTITLEMENT_REQUIRED",
    requiredEntitlement: input.key,
  };
}

// ===========================================================================
// assertQuotaEntitlement
// ===========================================================================

export async function assertQuotaEntitlement(input: {
  prisma?: PrismaClient;
  teamId: string;
  key: EntitlementKey;
  requested: number;
  actorUserId?: string | null;
}): Promise<
  | { ok: true; remaining: number }
  | { ok: false; denial: "QUOTA_EXCEEDED"; limit: number; consumed: number }
> {
  const prisma = input.prisma ?? defaultPrisma;
  // PRO-062 / BILLING-03 — a LIMIT is a ceiling on things that exist now, not a
  // meter. Reading `entitlement_usage` for one compared the limit with a row
  // nothing writes, so INTEGRATION_WEBHOOK_ENDPOINTS_MAX could never trip.
  // LIMIT keys are answered by `assertLimitEntitlementTx` (a live count under
  // a lock, inside the writer's transaction); asking this function is a
  // programming error, refused loudly rather than answered with a zero.
  if (classifyKind(input.key) === "LIMIT") {
    throw new Error(`entitlement_limit_key_not_a_meter:${input.key}`);
  }
  const projection = await resolveEntitlement({
    prisma,
    teamId: input.teamId,
    key: input.key,
  });
  const limit = typeof projection.value === "number" ? projection.value : 0;
  const period = classifyPeriod(input.key);
  const start = periodStart(period);
  let consumed = 0;
  try {
    const row = await prisma.entitlementUsage.findUnique({
      where: {
        teamId_key_periodStartUtc: {
          teamId: input.teamId,
          key: input.key,
          periodStartUtc: start,
        },
      },
      select: { consumed: true },
    });
    consumed = row ? Number(row.consumed) : 0;
  } catch {
    consumed = 0;
  }
  const requested = Math.max(0, Math.floor(input.requested));
  if (consumed + requested > limit) {
    await emitDenial(prisma, input.teamId, input.key, input.actorUserId, "QUOTA_EXCEEDED");
    return { ok: false, denial: "QUOTA_EXCEEDED", limit, consumed };
  }
  return { ok: true, remaining: Math.max(0, limit - consumed - requested) };
}

// ===========================================================================
// assertLimitEntitlementTx — LIMIT keys, by live count (PRO-062)
// ===========================================================================

type LimitTx = Pick<PrismaClient, "$executeRaw" | "lifecycleWebhookEndpoint" | "apiCredential"> & {
  webhookEndpoint?: Pick<PrismaClient["webhookEndpoint"], "count">;
};

/**
 * PRO-G1-05 / B7B-F05 — INTEGRATION_WEBHOOK_ENDPOINTS_MAX is the sold ceiling
 * of webhook endpoints, and the platform has two endpoint families: lifecycle
 * endpoints (`/v1/packaging/webhooks`) and integration endpoints
 * (`/v1/integrations/webhooks`). Only the lifecycle family was counted, so the
 * integration family had no ceiling at all. The ceiling now applies to EACH
 * family on its own live count (option "per family"): no family can exceed
 * what the line sells, and no workspace loses a lifecycle endpoint slot to an
 * integration endpoint it already holds. (Automation destinations keep their
 * own fixed cap, WEBHOOK_MAX_DESTINATIONS_PER_TEAM.)
 */
export type WebhookEndpointFamily = "LIFECYCLE" | "INTEGRATION";

/**
 * What each LIMIT key counts. A key with no counter cannot be enforced, so it
 * is refused (fail closed) rather than compared with nothing.
 */
const LIMIT_LIVE_COUNTERS: Partial<
  Record<EntitlementKey, (tx: LimitTx, teamId: string) => Promise<number>>
> = {
  // The lifecycle webhook endpoints the dispatcher would send to.
  INTEGRATION_WEBHOOK_ENDPOINTS_MAX: (tx, teamId) =>
    tx.lifecycleWebhookEndpoint.count({ where: { teamId, state: "ACTIVE" } }),
  // F-15 (Free-user audit, 2026-11-13) — the integration API keys that can
  // authenticate (`requireApiKey` accepts only ACTIVE credentials). The key was
  // declared, defaulted and sold per product line, and enforced nowhere: any
  // workspace owner (every account owns one) could mint unlimited keys.
  INTEGRATION_API_KEYS_MAX: (tx, teamId) =>
    tx.apiCredential.count({ where: { teamId, status: "ACTIVE" } }),
};

/**
 * Admit `requested` more of a LIMIT-shaped thing, inside the caller's
 * transaction, BEFORE the caller writes it. The per-(workspace, key) advisory
 * lock serialises concurrent creates, so N concurrent requests at limit - 1
 * admit exactly one; the count is of rows that exist, so deactivating one
 * frees its place.
 */
export async function assertLimitEntitlementTx(input: {
  tx: LimitTx;
  prisma?: PrismaClient;
  teamId: string;
  key: EntitlementKey;
  requested: number;
  /**
   * AUD-0017 (TXP-019) — the limit, resolved by the caller BEFORE its
   * transaction (`resolveEntitlement` on the same key and workspace). The
   * limit is the plan's and the contract's, not something the lock protects;
   * resolving it here, after the lock, ran the whole commercial resolution on
   * a second pooled connection while this transaction held one. Omitted, it
   * is resolved here as before.
   */
  resolved?: EntitlementProjection;
  /** INTEGRATION_WEBHOOK_ENDPOINTS_MAX only: which endpoint family to count (default LIFECYCLE). */
  family?: WebhookEndpointFamily;
}): Promise<{ ok: true; limit: number; current: number } | { ok: false; limit: number; current: number }> {
  if (classifyKind(input.key) !== "LIMIT") {
    throw new Error(`entitlement_key_not_a_limit:${input.key}`);
  }
  const integrationFamily =
    input.key === "INTEGRATION_WEBHOOK_ENDPOINTS_MAX" && input.family === "INTEGRATION";
  const counter: ((tx: LimitTx, teamId: string) => Promise<number>) | undefined = integrationFamily
    ? (tx, teamId) => {
        if (!tx.webhookEndpoint) throw new Error("entitlement_limit_counter_unavailable:integration_webhooks");
        return tx.webhookEndpoint.count({ where: { teamId, status: "ACTIVE" } });
      }
    : LIMIT_LIVE_COUNTERS[input.key];
  if (!counter) {
    throw new Error(`entitlement_limit_without_counter:${input.key}`);
  }
  const lockScope = integrationFamily ? `${input.key}:INTEGRATION` : input.key;
  await input.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement-limit:${lockScope}:${input.teamId}`}))`;
  const projection =
    input.resolved ??
    (await resolveEntitlement({
      prisma: input.prisma ?? defaultPrisma,
      teamId: input.teamId,
      key: input.key,
    }));
  const limit = typeof projection.value === "number" ? projection.value : 0;
  const current = await counter(input.tx, input.teamId);
  const requested = Math.max(0, Math.floor(input.requested));
  if (current + requested > limit) return { ok: false, limit, current };
  return { ok: true, limit, current };
}

// ===========================================================================
// recordEntitlementUsage — REMOVED (2026-09-07)
// ===========================================================================
//
// It upserted metered consumption into `entitlement_usage`, and its ONE
// production caller was the AI-operation quota in `media-intelligence`. That
// quota is retired as a duplicate commercial authority, so the writer had
// zero entrypoints — and this repository does not keep unreachable writers:
// `PRESERVED_PLANNED_WRITER` is a REJECTED disposition (see
// `scripts/capability-authority/manifests/writer-preservations.json`).
//
// WHAT THIS EXPOSES, AND DELIBERATELY DOES NOT FIX. Three QUOTA gates remain
// live — `QUOTA_EXPORT_PACKAGES_PER_MONTH`, `INTEGRATION_WEBHOOK_ENDPOINTS_MAX`
// and `LEGAL_HOLD_MAX_ACTIVE` via `assertQuotaEntitlement` — and NONE of them
// ever recorded consumption, before this change or after it. They read a
// counter nothing wrote, so they could not trip. Removing the unused writer
// does not cause that; it stops the mechanism looking wired. Two of the three
// are LIMIT-shaped; this note used to call them "a live count, not a meter"
// and "unaffected", but no code counted anything (PRO-062). They are now
// answered by `assertLimitEntitlementTx`, by live count; the monthly
// export-package meter has its own writer (below).

// ===========================================================================
// recordExportPackageUsage
// ===========================================================================

/**
 * The ONE writer of the export-package monthly meter now lives in
 * `@proovra/shared-runtime` (`billing/export-package-meter.ts`).
 *
 * It moved because a package becomes READY in the Worker's package builder,
 * which may not import this module. While the writer lived here, that READY
 * step recorded no usage, so `QUOTA_EXPORT_PACKAGES_PER_MONTH` could not trip.
 * It still THROWS, and its caller invokes it inside the transaction that
 * performs the conditional READY transition. (The API's `markPackageReady` was
 * removed with its retired route, 2026-09-17.) This module keeps the READER (`assertQuotaEntitlement`) and
 * shares the writer's period clock (imported above).
 */

// ===========================================================================
// upsertEntitlementGrant
// ===========================================================================

export async function upsertEntitlementGrant(input: {
  prisma?: PrismaClient;
  teamId: string;
  key: EntitlementKey;
  value: boolean | number;
  kind: EntitlementKind;
  source?: "PLAN" | "CUSTOM" | "PROMO";
  productLine?: ProductLine | null;
  grantedByUserId: string;
  expiresAtUtc?: Date | null;
}): Promise<{ ok: true; grantId: string }> {
  const prisma = input.prisma ?? defaultPrisma;
  const valueBool = input.kind === "FEATURE" ? Boolean(input.value) : null;
  const valueNumber =
    input.kind === "FEATURE"
      ? null
      : BigInt(Math.max(0, Math.floor(Number(input.value))));
  const source = input.source ?? "PLAN";
  const row = await prisma.entitlementGrant.upsert({
    where: { teamId_key: { teamId: input.teamId, key: input.key } },
    create: {
      teamId: input.teamId,
      key: input.key,
      kind: input.kind,
      valueBool,
      valueNumber,
      source,
      productLine: input.productLine ?? null,
      grantedByUserId: input.grantedByUserId ?? null,
      grantedAtUtc: new Date(),
      expiresAtUtc: input.expiresAtUtc ?? null,
    },
    update: {
      kind: input.kind,
      valueBool,
      valueNumber,
      source,
      productLine: input.productLine ?? null,
      grantedByUserId: input.grantedByUserId ?? null,
      expiresAtUtc: input.expiresAtUtc ?? null,
      grantedAtUtc: new Date(),
    },
    select: { id: true },
  });
  await emitLifecycleEvent({
    prisma,
    teamId: input.teamId,
    code: "ENTITLEMENT_GRANTED" as never,
    actorUserId: input.grantedByUserId,
    reason: `entitlement_granted:${input.key}:${source.toLowerCase()}`.slice(0, 200),
    targetType: "ENTITLEMENT",
    targetId: input.key,
  });
  return { ok: true, grantId: row.id };
}

// ===========================================================================
// listEntitlements
// ===========================================================================

export async function listEntitlements(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<ReadonlyArray<EntitlementProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const { standing, paidLapsed } = await resolveStandingFacts(prisma, input.teamId);
  const out: EntitlementProjection[] = [];
  for (const key of ENTITLEMENT_KEYS) {
    out.push(await resolveEntitlement({ prisma, teamId: input.teamId, key, standing, paidLapsed }));
  }
  return out;
}

// ===========================================================================
// applyProductLine
// ===========================================================================

export async function applyProductLine(input: {
  prisma?: PrismaClient;
  teamId: string;
  line: ProductLine;
  grantedByUserId: string;
  /** PRO-R3-07 / DEC-12 — the operator route always states one. */
  expiresAtUtc?: Date | null;
}): Promise<{ ok: boolean; granted: number }> {
  if (!(PRODUCT_LINES as ReadonlyArray<string>).includes(input.line)) {
    return { ok: false, granted: 0 };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const plan = PLAN_LINE_ENTITLEMENTS[input.line];
  let granted = 0;
  for (const key of Object.keys(plan) as EntitlementKey[]) {
    const raw = plan[key];
    if (raw === undefined) continue;
    const kind = classifyKind(key);
    try {
      await upsertEntitlementGrant({
        prisma,
        teamId: input.teamId,
        key,
        value: raw,
        kind,
        source: "PLAN",
        productLine: input.line,
        grantedByUserId: input.grantedByUserId,
        expiresAtUtc: input.expiresAtUtc ?? null,
      });
      granted += 1;
    } catch {
      /* continue — best-effort plan materialisation */
    }
  }
  return { ok: granted > 0, granted };
}

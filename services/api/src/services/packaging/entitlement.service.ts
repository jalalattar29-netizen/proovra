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
 *     ENTITLEMENT_GRANTED lifecycle event.
 *   * `applyProductLine` materialises every entitlement in a product
 *     line plan in a single transactional pass with `source='PLAN'`.
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

import { prisma as defaultPrisma } from "../../db.js";
import { emitLifecycleEvent } from "../intelligence/intelligence-activity.service.js";

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
  LEGAL_HOLD_MAX_ACTIVE: { kind: "LIMIT", value: 0 },
  INTEGRATION_API_KEYS_MAX: { kind: "LIMIT", value: 1 },
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
    FEATURE_LEGAL_HOLD: true,
    FEATURE_ARCHIVE_TIERS: true,
    FEATURE_LIFECYCLE_DASHBOARD: true,
    QUOTA_API_REQUESTS_PER_DAY: 100_000,
    QUOTA_WEBHOOK_DELIVERIES_PER_DAY: 10_000,
    QUOTA_EXPORT_PACKAGES_PER_MONTH: 250,
    RETENTION_MAX_YEARS: 7,
    LEGAL_HOLD_MAX_ACTIVE: 25,
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
    FEATURE_LEGAL_HOLD: true,
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
    LEGAL_HOLD_MAX_ACTIVE: 1_000,
    INTEGRATION_API_KEYS_MAX: 100,
    INTEGRATION_WEBHOOK_ENDPOINTS_MAX: 100,
  },
};

// ===========================================================================
// Period helpers (QUOTA windowing)
// ===========================================================================

type Period = "DAY" | "MONTH";

function classifyPeriod(key: EntitlementKey): Period {
  if (key.endsWith("PER_DAY")) return "DAY";
  if (key.endsWith("PER_MONTH")) return "MONTH";
  return "MONTH";
}

function periodStart(period: Period, now: Date = new Date()): Date {
  if (period === "DAY") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

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

function isExpired(row: GrantRow, now: Date = new Date()): boolean {
  return row.expiresAtUtc !== null && row.expiresAtUtc.getTime() <= now.getTime();
}

// ===========================================================================
// resolveEntitlement
// ===========================================================================

export async function resolveEntitlement(input: {
  prisma?: PrismaClient;
  teamId: string;
  key: EntitlementKey;
}): Promise<EntitlementProjection> {
  const prisma = input.prisma ?? defaultPrisma;
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
    if (!row || isExpired(row)) return projectDefault(input.key);
    return projectGrant(input.key, row);
  } catch {
    return projectDefault(input.key);
  }
}

// ===========================================================================
// Denial emit helper (POLICY_VIOLATION-equivalent)
// ===========================================================================

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
    await emitDenial(prisma, input.teamId, input.key, input.actorUserId, "ENTITLEMENT_REQUIRED");
    return {
      ok: false,
      denial: "ENTITLEMENT_REQUIRED",
      requiredEntitlement: input.key,
    };
  }
  if (projection.value === true) return { ok: true };
  await emitDenial(prisma, input.teamId, input.key, input.actorUserId, "ENTITLEMENT_REQUIRED");
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
// are LIMIT-shaped (a live count, not a meter) and are unaffected; the
// monthly export-package meter is a real gap, recorded as a backlog line
// rather than closed here, because wiring a new meter is product work and
// not this change.

// ===========================================================================
// recordExportPackageUsage
// ===========================================================================

/**
 * The ONE writer of the export-package monthly meter.
 *
 * `QUOTA_EXPORT_PACKAGES_PER_MONTH` was a live READ authority with no writer:
 * `assertQuotaEntitlement` compared a limit against a counter nothing had ever
 * incremented, so the gate could not trip and the plan's monthly allowance was
 * advertised but never enforced.
 *
 * WHY IT IS KEY-SPECIFIC AND NOT A GENERIC HELPER. The generic
 * `recordEntitlementUsage` was retired on 2026-09-07 with zero consumers, and
 * bringing it back for a single meter would rebuild the thing that let the
 * writer and the gate drift apart in the first place. This function names its
 * key, so there is exactly one place a caller could disagree with the reader
 * about WHICH meter is being written — and it derives the period through the
 * same `classifyPeriod`/`periodStart` pair `assertQuotaEntitlement` uses, so it
 * cannot disagree about WHEN either. Gate and meter read one clock.
 *
 * Metering must never fail the operation it measures: by the time this runs the
 * package exists and the customer has it. A failed write is swallowed, exactly
 * as the retired writer did.
 */
export async function recordExportPackageUsage(input: {
  prisma?: PrismaClient;
  teamId: string;
  amount?: number;
}): Promise<void> {
  const prisma = input.prisma ?? defaultPrisma;
  const key: EntitlementKey = "QUOTA_EXPORT_PACKAGES_PER_MONTH";
  const start = periodStart(classifyPeriod(key));
  const amount = BigInt(Math.max(0, Math.floor(input.amount ?? 1)));
  if (amount === 0n) return;
  try {
    await prisma.entitlementUsage.upsert({
      where: {
        teamId_key_periodStartUtc: {
          teamId: input.teamId,
          key,
          periodStartUtc: start,
        },
      },
      create: {
        teamId: input.teamId,
        key,
        periodStartUtc: start,
        consumed: amount,
      },
      update: { consumed: { increment: amount } },
    });
  } catch {
    /* swallow — metering must never block ops */
  }
}

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
  const out: EntitlementProjection[] = [];
  for (const key of ENTITLEMENT_KEYS) {
    out.push(await resolveEntitlement({ prisma, teamId: input.teamId, key }));
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
      });
      granted += 1;
    } catch {
      /* continue — best-effort plan materialisation */
    }
  }
  return { ok: granted > 0, granted };
}

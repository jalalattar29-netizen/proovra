import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { DomainError } from "../errors.js";
import {
  EVIDENCE_CREDIT_PRODUCT,
  resolveEvidenceOutputEntitlements,
  resolvePersonalEvidenceAdmission,
  type EvidenceFundingSource,
} from "@proovra/shared-billing";
import {
  consumeEvidenceCreditForCompletion,
  type EvidenceCreditClient,
} from "./billing/evidence-credits.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
// §9.7 — the enforcement chokepoint consumes the canonical commercial
// envelope (explicit subjects); this file no longer calls the scope adapter.
import { type WorkspaceScope } from "./workspace-billing.service.js";
import { resolveCommercialContext } from "./billing/commercial-context.service.js";
import {
  resolveEffectiveContractAiCap,
  resolveEffectiveContractEvidenceCap,
} from "./billing/enterprise-contract-limits.js";
import {
  assertWorkspaceStorageAvailable,
  getWorkspaceUsage,
} from "./workspace-usage.service.js";

// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `EntitlementWriter` was
// DELETED. It typed the optional transaction client of
// `consumeWorkspaceCompletionCredits`, whose callers mostly did not pass one —
// which is exactly how the credit spend came to run outside the completion
// transaction. The wallet takes `EvidenceCreditClient` and it is REQUIRED.

/**
 * Canonical entry point used by routes to build a WorkspaceScope for the
 * authenticated requester. `params.ownerUserId` MUST be the requester's
 * userId (sourced from `getAuthUserId(req)` against the verified JWT in
 * `middleware/auth.ts`) — NEVER from a request body, header, or query
 * string. The requester's email is looked up server-side from the
 * `users` table for observability metadata only — NO commercial bypass
 * exists (the email-based limit bypass was REMOVED in the Phase 9 final
 * closure; limits are canonical for every account, internal or customer).
 */
export async function resolveEnforcementScopeForRequester(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkspaceScope> {
  // §9.7 (2026-07-22) — the enforcement chokepoint consumes the CANONICAL
  // COMMERCIAL ENVELOPE with an EXPLICIT subject (workspace-by-persisted-id
  // when a teamId is targeted, else the requester's personal account). The
  // envelope's resolved limits travel on the scope so every assert below
  // reads envelope-interpreted values — this file makes no raw override
  // interpretation.
  const [ctx, requesterUser] = await Promise.all([
    resolveCommercialContext(
      params.teamId
        ? {
            type: "WORKSPACE",
            teamId: params.teamId,
            requesterUserId: params.ownerUserId,
          }
        : { type: "PERSONAL_ACCOUNT", userId: params.ownerUserId },
    ),
    prisma.user.findUnique({
      where: { id: params.ownerUserId },
      select: { email: true },
    }),
  ]);

  return {
    ...ctx.scope,
    commercialLimits: ctx.limits,
    commercialLifecycle: {
      state: ctx.lifecycle.state,
      paidActive: ctx.lifecycle.paidActive,
      mutationsAllowed: ctx.lifecycle.mutationsAllowed,
      graceEndsAtUtc: ctx.lifecycle.graceEndsAtUtc,
    },
    authenticatedUserEmail: requesterUser?.email ?? null,
  };
}

/**
 * §9.5 — the ONE lifecycle gate for paid mutations. Called at the top of
 * every paid-mutation assert: an envelope-resolved lifecycle that denies
 * mutations (bounded grace expired, cancelled past paid-through, ambiguous
 * provider rows, PAST_DUE without a trustworthy clock) fails closed with a
 * stable code. Evidence/custody/legal-hold READ paths never call this.
 */
function assertCommercialLifecycleAllowsPaidMutation(
  scope: WorkspaceScope,
): void {
  const life = scope.commercialLifecycle;
  if (life && !life.mutationsAllowed) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "The workspace's subscription is not in a state that allows new paid operations."
    );
    err.statusCode = 402;
    err.code = "COMMERCIAL_LIFECYCLE_RESTRICTED";
    throw err;
  }
}


const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pricing-hardening evidence-creation gate.
 *
 * Enforcement matrix (canonical source: PLAN_CAPABILITIES):
 *
 *   FREE        — lifetime cap (3). Legacy override honoured if set.
 *   PAYG        — no record cap. Credit-bound.
 *   PRO         — lifetime cap (100). Legacy override honoured if set.
 *   TEAM        — rolling 30-day cap (500) measured against the team's
 *                 non-deleted Evidence.createdAt history. No lifetime cap.
 *   ENTERPRISE  — no record cap (custom; Sales-provisioned).
 *
 * §9.7 — the legacy grandfather override is interpreted EXCLUSIVELY by the
 * canonical envelope (`resolveCommercialContext(...).limits`), attached to
 * the scope at the enforcement chokepoint as `commercialLimits`. When set on
 * a PRO account the envelope substitutes the lifetime cap, grandfathering
 * accounts that already exceeded 100 records at migration time. New creation
 * is blocked above the override, never below; existing records remain
 * accessible. This file never reads the raw override field.
 */
export async function assertWorkspaceAllowsEvidenceCreation(
  scope: WorkspaceScope
) {
  // §9.5 — bounded-lifecycle gate (fail closed when grace expired/cancelled/ambiguous).
  assertCommercialLifecycleAllowsPaidMutation(scope);
  const caps = getPlanCapabilities(scope.plan);

  if (scope.billingShape === "SHARED" && !caps.allowsSharedWorkspace) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Current plan does not include team workspace evidence creation"
    );
    err.statusCode = 409;
    err.code = "TEAM_PLAN_REQUIRED";
    throw err;
  }

  if (scope.billingShape === "SHARED") {
    // Rolling 30-day cap on TEAM workspaces. ENTERPRISE workspaces have
    // null monthly cap and skip the count. The team's `evidence_team_id_created_at_idx`
    // compound index covers this query.
    // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a contracted allowance
    // governs; the catalog default applies only when the contract is silent.
    const monthlyCap = resolveEffectiveContractEvidenceCap({
      plan: scope.plan,
      contract: scope.contractLimits,
    });
    if (monthlyCap === null || monthlyCap <= 0) {
      return;
    }

    if (!scope.teamId) {
      // Defence-in-depth: TEAM scope without teamId is a schema
      // violation; refuse rather than silently allowing.
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "TEAM scope missing teamId"
      );
      err.statusCode = 409;
      err.code = "TEAM_PLAN_REQUIRED";
      throw err;
    }

    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const monthlyCount = await prisma.evidence.count({
      where: {
        teamId: scope.teamId,
        deletedAt: null,
        createdAt: { gte: since },
      },
    });

    if (monthlyCount >= monthlyCap) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "Team monthly evidence-record limit reached"
      );
      err.statusCode = 409;
      err.code = "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED";
      throw err;
    }

    return;
  }

  // PERSONAL scope below.
  //
  // Phase HOME-DATA-OWNERSHIP — personal records are no longer
  // `teamId NULL`-only: new captures stamp the owner's personal Team
  // id, and the backfill migrates legacy NULL rows to it. Count both
  // shapes so plan limits survive the migration. (Evidence has no
  // `team` relation field, so the personal team id is resolved first.)
  const evidenceCount = await countPersonalEvidenceRecords(scope.ownerUserId);

  // §9.7 — the effective lifetime cap is resolved by the CANONICAL ENVELOPE
  // (`resolveCommercialContext(...).limits`, attached at the enforcement
  // chokepoint). This file no longer interprets the raw grandfather
  // override; a scope that did not travel through the envelope gets the
  // plan default (absence of an envelope value is not an override).
  const effectiveLifetimeCap =
    scope.commercialLimits?.effectiveLifetimeRecordCap ?? caps.maxEvidenceRecords;

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE admission decision now
  // lives in one pure policy (`resolvePersonalEvidenceAdmission`,
  // @proovra/shared-billing) and this file supplies its inputs.
  //
  // What it replaces: a hand-rolled branch that asked
  // `caps.paygCreditsRequiredPerCompletion` whether a credit could be spent.
  // On FREE that value is 0, and a real PAYG buyer IS on FREE — no production
  // path ever writes `entitlements.plan = 'PAYG'` — so the credit branch was
  // unreachable and paid credits could never be spent. Credits are a wallet
  // over the plan, not a property of the plan, so the plan no longer decides
  // whether they exist.
  const admission = resolvePersonalEvidenceAdmission({
    plan: scope.plan,
    currentRecordCount: evidenceCount,
    effectiveLifetimeRecordCap: effectiveLifetimeCap,
    availableEvidenceCredits: Math.max(0, scope.credits ?? 0),
  });

  if (admission.allowed) {
    // Admission only. The credit is not spent here — it is spent inside the
    // completion transaction by `consumeEvidenceCreditForCompletion`, so a
    // completion that never succeeds never costs the customer a credit.
    return;
  }

  if (admission.reason === "CREDIT_REQUIRED_NONE_AVAILABLE") {
    // This plan grants no free allowance at all (the grandfathered PAYG
    // resolution row), so the denial is purely "out of credits" and keeps the
    // 402 status those accounts have always received.
    throw new DomainError("Insufficient evidence credits", {
      httpStatus: 402,
      publicCode: "INSUFFICIENT_EVIDENCE_CREDITS",
      publicMessage:
        "You have no evidence credits left. Buy more to record further evidence.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
      metadata: { plan: String(scope.plan), limitKind: "evidence_credits" },
    });
  }

  // Allowance exhausted and no purchased credit available.
  //
  // PHASE 12 — POINT 7 CORRECTIVE PASS (2026-08-05): this is a `DomainError`
  // declaring itself an EXPECTED_DENIAL. It used to be a plain `Error` with
  // `statusCode`/`code` assigned onto it — a shape the central handler does
  // not recognise — so a user hitting the published record cap produced an
  // error-level Sentry issue and a 500 on the wire.
  //
  // 409 CONFLICT is retained deliberately: the request conflicts with the
  // current state of the resource (the workspace is at its record cap), and it
  // is the status the commercial vocabulary already uses for the report,
  // package, intake and cases gates.
  const isFree = scope.plan === prismaPkg.PlanType.FREE;
  throw new DomainError(
    isFree
      ? "Free evidence limit reached"
      : "Evidence record limit reached for current plan",
    {
      httpStatus: 409,
      publicCode: isFree ? "FREE_LIMIT_REACHED" : "EVIDENCE_RECORD_LIMIT_REACHED",
      // BILLING PRODUCTION CLOSURE (2026-08-27) — the phrase "record limit" is
      // restored to the FREE message.
      //
      // The previous pass rewrote it to "You have used the 3 records included
      // in the Free plan", which reads better but dropped the words that
      // `p7.obs.free_limit.denied_as_canonical_4xx_not_captured` pins as the
      // proof that this denial reaches the customer as PRODUCT COPY and not as
      // an internal error. That broke the integration gate, and the honest fix
      // is the copy, not the assertion — nothing the rewrite added is lost
      // here: the number, the reassurance and the remedy all remain.
      publicMessage: isFree
        ? "You have reached the record limit included in the Free plan: 3 records. Existing records remain available — buy evidence credits or upgrade to add more."
        : "You have reached the record limit included in your current plan. Existing records remain available — buy evidence credits or upgrade to add more.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
      metadata: { plan: String(scope.plan), limitKind: "evidence_records" },
    },
  );
}

/**
 * THE personal evidence-record count.
 *
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — extracted so the enforcement
 * gate, the completion-time funding decision and the Billing usage meter all
 * count the same rows. They previously did not: the gate counted
 * `deletedAt: null` while `getWorkspaceUsage` counted
 * `lifecycleState != DESTROYED`, so the meter could read "3 of 3" while the
 * gate still admitted a fourth record.
 *
 * The predicate is the ENFORCEMENT one — a trashed record releases its record
 * slot. (Storage accounting deliberately differs and still counts trashed
 * bytes, because those bytes are really still in the bucket.)
 */
export async function countPersonalEvidenceRecords(
  ownerUserId: string,
  options?: {
    /**
     * BILLING PRODUCTION CLOSURE (2026-08-27) — exclude ONE record from the
     * count.
     *
     * The creation gate and the completion gate ask the same question — "how
     * many records did this account hold BEFORE this one?" — from two
     * different moments. At creation the row does not exist yet, so a plain
     * count already answers it. At completion the row was inserted and
     * COMMITTED by `createEvidence` in an earlier transaction, so a plain
     * count includes the very record being funded and the account appears one
     * record fuller than it is.
     *
     * That off-by-one made the LAST included record of every personal plan
     * unfundable: on FREE the third record evaluated `3 < 3` and demanded a
     * paid credit; with a credit banked it silently spent it on a record the
     * plan already covered, and the fourth was then refused — so a purchased
     * credit bought nothing.
     *
     * Exclusion rather than subtraction: `NOT: { id }` is exact whatever the
     * row's state, needs no proof that the row is currently counted (a trashed
     * or DESTROYED record is not), and cannot underflow.
     */
    excludeEvidenceId?: string | null;
  },
): Promise<number> {
  const personalTeam = await prisma.team.findFirst({
    where: { ownerUserId, isPersonal: true },
    select: { id: true },
  });

  const excludeEvidenceId = options?.excludeEvidenceId ?? null;

  return prisma.evidence.count({
    where: {
      ownerUserId,
      deletedAt: null,
      lifecycleState: { not: "DESTROYED" },
      OR: [
        { teamId: null },
        ...(personalTeam ? [{ teamId: personalTeam.id }] : []),
      ],
      ...(excludeEvidenceId ? { NOT: { id: excludeEvidenceId } } : {}),
    },
  });
}

export async function assertWorkspaceAllowsStorageGrowth(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  return assertWorkspaceStorageAvailable(params);
}

export async function assertWorkspaceAllowsReport(scope: WorkspaceScope) {
  // §9.5 — bounded-lifecycle gate (fail closed when grace expired/cancelled/ambiguous).
  assertCommercialLifecycleAllowsPaidMutation(scope);
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.reportsIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Report generation is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "REPORT_NOT_INCLUDED";
    throw err;
  }
}

/**
 * Secure-intake plan gate (Teams Entitlement Alignment follow-up,
 * 2026-07-15). Intake links + submission requests are excluded from
 * FREE per the published Pricing contract (`intakeIncluded`). This
 * enforces the commercial contract at the CREATION boundary — before
 * any WorkflowIntakeLink / EvidenceRequest row is written — so the
 * `intake_*` Operations Center sources are structurally impossible for
 * plans that exclude intake, not merely hidden in the UI. Same shape
 * as the report/package guards (409 + stable code).
 */
export async function assertWorkspaceAllowsIntake(scope: WorkspaceScope) {
  // §9.5 — bounded-lifecycle gate (fail closed when grace expired/cancelled/ambiguous).
  assertCommercialLifecycleAllowsPaidMutation(scope);
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.intakeIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Secure intake (intake links and submission requests) is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "INTAKE_NOT_INCLUDED";
    throw err;
  }
}

/**
 * PHASE 12 — POINT 7 (2026-08-05): the CASES plan gate.
 *
 * `casesIncluded` was already a catalog field, a published pricing row
 * ("Cases & matters: Not included / Not included / Personal / Team /
 * Org-wide"), a projected `planFeatures` flag the UI hides the surface on, and
 * an input to operational eligibility. It was enforced NOWHERE: `POST
 * /v1/cases` created the row for any authenticated member, so a FREE account's
 * direct request produced a Case with a 201. That is the exact shape of defect
 * the point exists to close — a lock the UI honours and the server does not.
 *
 * Same shape as the report / package / intake guards: 409 with a stable code
 * the client renders remediation from, thrown BEFORE any row is written.
 */
export async function assertWorkspaceAllowsCases(scope: WorkspaceScope) {
  // §9.5 — bounded-lifecycle gate (fail closed when grace expired/cancelled/ambiguous).
  assertCommercialLifecycleAllowsPaidMutation(scope);
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.casesIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Cases and matters are not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "CASES_NOT_INCLUDED";
    throw err;
  }
}

export async function assertWorkspaceAllowsVerificationPackage(
  scope: WorkspaceScope
) {
  // §9.5 — bounded-lifecycle gate (fail closed when grace expired/cancelled/ambiguous).
  assertCommercialLifecycleAllowsPaidMutation(scope);
  const caps = getPlanCapabilities(scope.plan);

  if (!caps.verificationPackageIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Verification package is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "VERIFICATION_PACKAGE_NOT_INCLUDED";
    throw err;
  }
}

export async function assertWorkspaceAllowsReportStorage(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  await assertWorkspaceAllowsReport(params.scope);
  return assertWorkspaceStorageAvailable({
    scope: params.scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });
}

export async function assertWorkspaceAllowsVerificationPackageStorage(params: {
  scope: WorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  await assertWorkspaceAllowsVerificationPackage(params.scope);
  return assertWorkspaceStorageAvailable({
    scope: params.scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });
}

export async function getWorkspaceAvailableStorageBytes(
  scope: WorkspaceScope
): Promise<bigint> {
  const usage = await getWorkspaceUsage(scope);
  return usage.storageBytesRemaining;
}

/**
 * Settle the commercial cost of ONE successfully completed Evidence record and
 * report how it was funded.
 *
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — replaces
 * `consumeWorkspaceCompletionCredits`, which had three defects:
 *
 *   1. It asked `caps.paygCreditsRequiredPerCompletion` whether to charge. On
 *      FREE — where every real credit buyer actually sits — that is 0, so it
 *      never charged and never let a paid credit be spent.
 *   2. It was called from INSIDE the completion transaction but ran against
 *      the GLOBAL prisma client, so the decrement was not part of that
 *      transaction. A completion that rolled back still burned the credit.
 *   3. It had no per-record idempotency, so a retried completion could burn a
 *      second credit for the same Evidence record.
 *
 * MUST be passed the completion's own transaction client. The caller's
 * transaction is the atomic boundary: if the completion rolls back, so does
 * the spend.
 *
 * Returns the funding source, which decides that record's outputs (see
 * `resolveEvidenceOutputEntitlements`) — a credit-funded record earns its
 * report and verification package even on a FREE account, because the
 * entitlement belongs to the paid RECORD and not to the account.
 */
export async function settleEvidenceCompletionFunding(
  params: {
    scope: WorkspaceScope;
    evidenceId: string;
  },
  client: EvidenceCreditClient,
): Promise<{ funding: EvidenceFundingSource }> {
  const { scope } = params;

  // A SHARED workspace is funded by its own subscription; there is no personal
  // wallet behind it and nothing to settle per record.
  if (scope.billingShape === "SHARED") {
    return { funding: "PLAN" };
  }

  // BILLING PRODUCTION CLOSURE (2026-08-27) — a record that has ALREADY paid
  // is settled, and settling it again asks no new commercial question.
  //
  // This check has to come before admission, not after. Admission asks "may
  // this account fund one more record?", and by the time a credit-funded
  // record is retried the answer is legitimately no: the credit it spent is
  // gone and the allowance it exceeded is still exceeded. Running admission
  // first therefore turned every retry of a paid record into a 402 — a
  // completion that had already been paid for could not be re-driven after a
  // transient failure, and a duplicate finalize surfaced as "insufficient
  // credits" to a customer who had bought exactly the right number.
  //
  // The ledger row is the authority, read through the caller's own client so a
  // spend made earlier in this same transaction is visible.
  const settledEntry = await client.evidenceCreditLedgerEntry.findUnique({
    where: { evidenceId: params.evidenceId },
    select: { entryType: true },
  });
  if (settledEntry?.entryType === prismaPkg.EvidenceCreditEntryType.CONSUMPTION) {
    return { funding: "EVIDENCE_CREDIT" };
  }

  const caps = getPlanCapabilities(scope.plan);
  const effectiveLifetimeCap =
    scope.commercialLimits?.effectiveLifetimeRecordCap ?? caps.maxEvidenceRecords;

  // BILLING PRODUCTION CLOSURE (2026-08-27) — the count is taken HERE, and the
  // record being funded is excluded from it.
  //
  // It used to arrive as a `priorRecordCount` parameter the caller computed.
  // The caller computed it with a plain count, taken at a moment when the row
  // already existed and was committed, so it was not "prior" at all — it was
  // the count INCLUDING this record, and the last included record of every
  // personal plan therefore evaluated `cap < cap` and demanded a paid credit.
  //
  // Removing the parameter removes the class of error: there is no number a
  // caller can get wrong, and the admission decision at completion now asks
  // exactly the question the creation gate asks.
  const priorRecordCount = await countPersonalEvidenceRecords(scope.ownerUserId, {
    excludeEvidenceId: params.evidenceId,
  });

  const admission = resolvePersonalEvidenceAdmission({
    plan: scope.plan,
    currentRecordCount: priorRecordCount,
    effectiveLifetimeRecordCap: effectiveLifetimeCap,
    availableEvidenceCredits: Math.max(0, scope.credits ?? 0),
  });

  if (!admission.allowed) {
    throw new DomainError("Insufficient evidence credits", {
      httpStatus: 402,
      publicCode: "INSUFFICIENT_EVIDENCE_CREDITS",
      publicMessage:
        "You have used your included records and have no evidence credits left. Buy more to continue.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
      metadata: { limitKind: "evidence_credits" },
    });
  }

  if (admission.funding !== "EVIDENCE_CREDIT") {
    return { funding: "PLAN" };
  }

  const result = await consumeEvidenceCreditForCompletion(
    { userId: scope.ownerUserId, evidenceId: params.evidenceId },
    client,
  );

  // `alreadyConsumed` is the idempotent-retry path: this record already paid.
  void result;
  return { funding: "EVIDENCE_CREDIT" };
}

/**
 * The outputs ONE Evidence record earns, resolved from its workspace plan and
 * how its completion was funded. Thin host binding over the canonical policy
 * so the API and the worker cannot answer this differently.
 */
export function resolveEvidenceOutputs(input: {
  plan: WorkspaceScope["plan"];
  funding: EvidenceFundingSource;
}) {
  return resolveEvidenceOutputEntitlements({
    plan: input.plan,
    funding: input.funding,
  });
}

/** Credits one completion costs. Re-exported so callers do not re-derive it. */
export const EVIDENCE_CREDITS_PER_COMPLETION =
  EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion;

export async function getWorkspaceBillingSummary(scope: WorkspaceScope) {
  const caps = getPlanCapabilities(scope.plan);
  const usage = await getWorkspaceUsage(scope);

  return {
    scope,
    capabilities: caps,
    usage,
  };
}

// ────────────────────────────────────────────────────────────────────
// Plan-aware AI advisory monthly cap
// ────────────────────────────────────────────────────────────────────

export const AI_USAGE_KEY = "ai_advisory_operations" as const;

export function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Resolve the durable "owning" team id for AI usage accounting. Team
 * workspaces account on the team itself; personal workspaces account on
 * the user's personal Team row (which `ensurePersonalWorkspace` creates
 * for every authenticated user). Returns null if the personal team has
 * not been bootstrapped yet — in that case the cap cannot be enforced
 * durably and the caller must rely on in-memory abuse limits.
 */
async function resolveAiUsageTenantId(
  scope: WorkspaceScope,
): Promise<string | null> {
  if (scope.teamId) return scope.teamId;
  const personalTeam = await prisma.team.findFirst({
    where: { ownerUserId: scope.ownerUserId, isPersonal: true },
    select: { id: true },
  });
  return personalTeam?.id ?? null;
}

/**
 * Throws AI_MONTHLY_LIMIT_REACHED (429) when the active plan's monthly
 * AI advisory cap has been reached. Counts persistent usage out of
 * EntitlementUsage so the cap survives process restarts.
 *
 * `aiAdvisoryMonthlyOperations`:
 *   - 0   = AI disabled at this tier (FREE)
 *   - n>0 = monthly cap
 *   - null = custom / no cap (ENTERPRISE)
 */
export async function assertWorkspaceAllowsAiOperation(
  scope: WorkspaceScope,
): Promise<void> {
  // §9.5 — bounded-lifecycle gate (fail closed when grace expired/cancelled/ambiguous).
  assertCommercialLifecycleAllowsPaidMutation(scope);
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the AI cap is resolved
  // contract-first; reading the catalog into a local here would have left two
  // candidate answers in one function.
  const cap = resolveEffectiveContractAiCap({
    plan: scope.plan,
    contract: scope.contractLimits,
  });

  if (cap === null) return; // ENTERPRISE / custom — no monthly cap.
  if (cap <= 0) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "AI assistance is not included in the current plan",
    );
    err.statusCode = 402;
    err.code = "AI_MONTHLY_LIMIT_REACHED";
    throw err;
  }

  const tenantId = await resolveAiUsageTenantId(scope);
  if (!tenantId) {
    // Personal team hasn't been bootstrapped; allow with daily abuse
    // limits handled by AiCostGuard. New users hit this path at most
    // once before `ensurePersonalWorkspace` creates the team row.
    return;
  }

  const periodStartUtc = startOfCurrentMonthUtc();
  const usage = await prisma.entitlementUsage.findUnique({
    where: {
      teamId_key_periodStartUtc: {
        teamId: tenantId,
        key: AI_USAGE_KEY,
        periodStartUtc,
      },
    },
    select: { consumed: true },
  });

  const consumed = Number(usage?.consumed ?? 0n);
  if (consumed >= cap) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Monthly AI advisory limit reached for current plan",
    );
    err.statusCode = 429;
    err.code = "AI_MONTHLY_LIMIT_REACHED";
    throw err;
  }
}

/**
 * Idempotent upsert that increments the durable AI usage counter for
 * the current UTC month. Call ONLY after a successful AI operation; on
 * upstream failure the consumer's allowance is preserved.
 */
export async function recordWorkspaceAiOperation(
  scope: WorkspaceScope,
): Promise<void> {
  const tenantId = await resolveAiUsageTenantId(scope);
  if (!tenantId) return;

  const periodStartUtc = startOfCurrentMonthUtc();
  await prisma.entitlementUsage.upsert({
    where: {
      teamId_key_periodStartUtc: {
        teamId: tenantId,
        key: AI_USAGE_KEY,
        periodStartUtc,
      },
    },
    create: {
      teamId: tenantId,
      key: AI_USAGE_KEY,
      periodStartUtc,
      consumed: 1n,
    },
    update: {
      consumed: { increment: 1n },
    },
  });
}

export async function getWorkspaceAiUsageThisMonth(
  scope: WorkspaceScope,
): Promise<{ consumed: number; cap: number | null }> {
  // BILLING PRODUCTION CLOSURE (2026-08-27) — the cap comes from the SAME
  // resolver the AI gate enforces with. It used to read the catalog row
  // directly, so an ENTERPRISE contract that stated a monthly AI allowance was
  // enforced at one number and displayed at another.
  const cap = resolveEffectiveContractAiCap({
    plan: scope.plan,
    contract: scope.contractLimits,
  });
  const tenantId = await resolveAiUsageTenantId(scope);
  if (!tenantId) return { consumed: 0, cap };

  const periodStartUtc = startOfCurrentMonthUtc();
  const usage = await prisma.entitlementUsage.findUnique({
    where: {
      teamId_key_periodStartUtc: {
        teamId: tenantId,
        key: AI_USAGE_KEY,
        periodStartUtc,
      },
    },
    select: { consumed: true },
  });

  return { consumed: Number(usage?.consumed ?? 0n), cap };
}

// ────────────────────────────────────────────────────────────────────
// Enterprise feature gate
// ────────────────────────────────────────────────────────────────────

import { planHasEnterpriseFeature } from "./plan-catalog.service.js";
import type { EnterpriseFeatureFlags } from "./plan-catalog.service.js";

/**
 * Throws ENTERPRISE_FEATURE_REQUIRED (402) when the active workspace
 * plan does not include the requested governance feature. Used by SSO/
 * SCIM, MFA admin, legal hold, retention policy, organization audit
 * log, and Object Lock routes.
 */
export function assertWorkspaceAllowsEnterpriseFeature(
  scope: WorkspaceScope,
  feature: keyof EnterpriseFeatureFlags,
): void {
  if (planHasEnterpriseFeature(scope.plan, feature)) return;
  const err: Error & { statusCode?: number; code?: string } = new Error(
    `Feature "${feature}" is included only on Enterprise plans`,
  );
  err.statusCode = 402;
  err.code = "ENTERPRISE_FEATURE_REQUIRED";
  throw err;
}

/**
 * Team-aware Enterprise-feature gate. Resolves the team's effective
 * plan (billingPlan when ACTIVE/PAST_DUE; otherwise the team owner's
 * Entitlement plan) and rejects if the plan does not include the
 * requested feature. Use this on team-scoped routes (retention
 * policies, legal hold, organization audit, etc.) where the gate
 * MUST follow the team's billing plan, not the caller's personal plan.
 */
export async function assertTeamAllowsEnterpriseFeature(
  teamId: string,
  feature: keyof EnterpriseFeatureFlags,
): Promise<void> {
  // PHASE 12 POINT 4 PASS C5 — one subject-correct effective-plan authority.
  //
  // This was a byte-identical copy of the derivation in
  // enterprise-gate-resolvers.service.ts: raw `Team.billingPlan`, falling back
  // to the OWNER's personal entitlement whenever the workspace's billing was
  // not live. Two copies of a commercial rule, both applying an owner-plan
  // fallback the canonical policy forbids for an OWNED/ORGANIZATION
  // workspace — so a lapsed enterprise workspace kept enterprise features on
  // the strength of its owner's personal plan.
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { ownerUserId: true },
  });
  if (!team) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Team not found",
    );
    err.statusCode = 404;
    err.code = "TEAM_NOT_FOUND";
    throw err;
  }
  const ctx = await resolveCommercialContext({
    type: "WORKSPACE",
    teamId,
    requesterUserId: team.ownerUserId,
  });
  const effectivePlan = ctx.plan as prismaPkg.PlanType;
  if (!planHasEnterpriseFeature(effectivePlan, feature)) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      `Feature "${feature}" is included only on Enterprise plans`,
    );
    err.statusCode = 402;
    err.code = "ENTERPRISE_FEATURE_REQUIRED";
    throw err;
  }
}
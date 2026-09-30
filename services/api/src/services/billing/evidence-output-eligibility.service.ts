/**
 * THE record-aware output-eligibility resolver.
 *
 * ---------------------------------------------------------------------------
 * COMMERCIAL + EVIDENCE OUTPUT LIFECYCLE CLOSURE (2026-09-08)
 * ---------------------------------------------------------------------------
 * "May THIS evidence record have a PDF report and a verification package?" is
 * a two-input question and the product had been answering it with one input.
 *
 * `resolveEvidenceOutputEntitlements({ plan, funding })` in
 * @proovra/shared-billing has always been the authority, and it has always
 * taken funding — a credit-funded completion earns the paid outputs even
 * though the account's recurring plan is FREE, because the entitlement belongs
 * to the RECORD. The worker asked it correctly. Everything on the API side
 * asked `getPlanCapabilities(scope.plan).reportsIncluded` instead, which is the
 * plan alone, and the browser then blocked a customer from downloading a report
 * they had paid €5 for.
 *
 * This module is the ONE place the two inputs are loaded and handed to that
 * authority. It adds no policy of its own:
 *
 *   plan     ← `resolveCommercialPlan` with an EXPLICIT subject — the cheap
 *               entry point ON the canonical layer, which delegates the
 *               decision to `resolveWorkspaceEffectivePlan`
 *   funding  ← `resolveEvidenceFunding` (the credit ledger row, the same one
 *               the worker reads through its own thin adapter)
 *
 * A bulk variant exists because list surfaces (Reports, operational counters)
 * need this for a page of records and an N+1 over the ledger is not acceptable
 * on those paths.
 */

import {
  getPlanCapabilities,
  resolveEvidenceOutputEntitlements,
  resolveOutputIssuanceEntitlement,
  type EvidenceFundingSource,
  type OutputIssuanceEntitlement,
  type OutputIssuanceLifecycle,
  type PlanType,
} from "@proovra/shared-billing";
import { readCommercialLifecycle } from "@proovra/shared-runtime";
import type {
  OutputCommercialEligibility,
  OutputIneligibilityReason,
} from "@proovra/shared";

import { prisma } from "../../db.js";
/**
 * THE canonical commercial layer, with an EXPLICIT subject.
 *
 * Not the lower-level scope adapters: Phase 9 converged every production
 * commercial decision onto this layer and pins the bypass count at ZERO,
 * because a second entry point to a commercial decision is how two answers come
 * to exist.
 *
 * `resolveCommercialPlan` is the cheap entry point ON that layer — the same
 * decision the envelope's `plan` field carries, without the usage rollup, the
 * lifecycle verdict or the Enterprise contract this module has no use for.
 * Reaching past the layer to the scope adapter would have been equally cheap
 * and would have reopened the layering the ratchet exists to hold shut.
 *
 * Callers that ALREADY hold a resolved plan pass it in (`plan` below) and this
 * module resolves nothing at all — which is how Evidence Detail, whose
 * projection has an envelope in hand, avoids paying twice.
 */
import { resolveCommercialPlan } from "./commercial-context.service.js";
import {
  resolveEvidenceFunding,
  resolveEvidenceFundingMany,
} from "./evidence-credits.service.js";

/**
 * What one record is entitled to. Deliberately mirrors the shape
 * `resolveEvidenceOutputEntitlements` returns, plus the axis-1 vocabulary the
 * lifecycle projection consumes.
 */
export type EvidenceOutputEligibility = {
  plan: PlanType;
  /** null when the funding ledger could not be read (eligibility then UNRESOLVED). */
  funding: EvidenceFundingSource | null;
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
  /** Axis 1 for the report, in the shared state-machine vocabulary. */
  reportEligibility: OutputCommercialEligibility;
  /** Axis 1 for the verification package. */
  packageEligibility: OutputCommercialEligibility;
  /** Bounded reason, present only when something is NOT_INCLUDED or UNRESOLVED. */
  ineligibilityReason: OutputIneligibilityReason | null;
  /**
   * EVIDENCE OUTPUT LIFECYCLE (2026-09-29) — the ONE issuance decision (plan,
   * funding AND the subscription lifecycle). `reportEligibility` and
   * `packageEligibility` above are derived from it.
   */
  issuance: OutputIssuanceEntitlement;
};

function toEligibility(included: boolean): OutputCommercialEligibility {
  return included ? "ELIGIBLE" : "NOT_INCLUDED";
}

function project(input: {
  plan: PlanType | null;
  /** null = the funding read FAILED: unresolved, never assumed to be PLAN. */
  funding: EvidenceFundingSource | null;
  lifecycle: OutputIssuanceLifecycle;
}): EvidenceOutputEligibility {
  const issuance = resolveOutputIssuanceEntitlement({
    plan: input.plan,
    funding: input.funding,
    lifecycle: input.lifecycle,
  });
  // Public verification is never gated on the subscription (Decision B).
  const publicVerifyIncluded = input.plan
    ? resolveEvidenceOutputEntitlements({ plan: input.plan, funding: input.funding ?? "PLAN" })
        .publicVerifyIncluded
    : true;
  const unresolved = issuance.decision === "UNRESOLVED";
  const eligibilityOf = (included: boolean): OutputCommercialEligibility =>
    unresolved ? "UNRESOLVED" : toEligibility(included);
  const anyExcluded =
    !issuance.reportsIncluded || !issuance.verificationPackageIncluded;
  return {
    plan: input.plan ?? fallbackPlan(),
    funding: input.funding,
    reportsIncluded: issuance.reportsIncluded,
    verificationPackageIncluded: issuance.verificationPackageIncluded,
    publicVerifyIncluded,
    reportEligibility: eligibilityOf(issuance.reportsIncluded),
    packageEligibility: eligibilityOf(issuance.verificationPackageIncluded),
    ineligibilityReason: unresolved
      ? "ENTITLEMENT_UNRESOLVED"
      : !anyExcluded
        ? null
        : issuance.basis === "PAYMENT_LAPSED"
          ? "PAYMENT_LAPSED"
          : issuance.basis === "SUBSCRIPTION_ENDED"
            ? "SUBSCRIPTION_ENDED"
            : "NOT_INCLUDED_IN_PLAN",
    issuance,
  };
}

type ResolvedSubject = {
  plan: PlanType;
  ownerUserId: string;
  teamId: string | null;
  billingShape: string;
};

/**
 * The commercial lifecycle of the subject that owns a record, through the ONE
 * shared reader (the worker reads the same function). `null` when it cannot
 * be read — which the decision turns into UNRESOLVED, never into FREE and
 * never into paid.
 */
async function resolveSubjectLifecycle(
  subject: ResolvedSubject | null,
): Promise<OutputIssuanceLifecycle> {
  if (!subject) return null;
  try {
    const reading = await readCommercialLifecycle(
      prisma,
      subject.billingShape === "SINGLE_OCCUPANT" || !subject.teamId
        ? { kind: "PERSONAL", ownerUserId: subject.ownerUserId, plan: String(subject.plan) }
        : { kind: "WORKSPACE", teamId: subject.teamId, plan: String(subject.plan) },
    );
    return { state: reading.state, providerStatus: reading.providerStatus };
  } catch {
    return null;
  }
}

/**
 * FAIL-CLOSED DEFAULT.
 *
 * A record whose workspace scope cannot be resolved is not silently promoted
 * to entitled. FREE's own catalog row supplies the answer, so the fallback is
 * a real commercial position rather than an invented one — and because the
 * funding ledger is read separately, a credit-funded record survives a scope
 * failure with its paid outputs intact.
 */
function fallbackPlan(): PlanType {
  return "FREE";
}

/**
 * The effective plan for the subject that OWNS a record, through the canonical
 * envelope with an explicit subject.
 *
 * `WORKSPACE` when the record carries one — the commercial subject of a record
 * in a workspace is that workspace, whoever created the row — and
 * `PERSONAL_ACCOUNT` otherwise.
 */
async function resolveSubject(input: {
  ownerUserId?: string | null;
  teamId: string | null;
}): Promise<ResolvedSubject | null> {
  try {
    if (input.teamId) {
      const ctx = await resolveCommercialPlan({
        type: "WORKSPACE",
        teamId: input.teamId,
        requesterUserId: input.ownerUserId ?? "",
      });
      return {
        plan: ctx.plan as PlanType,
        ownerUserId: ctx.ownerUserId,
        teamId: input.teamId,
        billingShape: String(ctx.billingShape),
      };
    }
    if (!input.ownerUserId) return null;
    const ctx = await resolveCommercialPlan({
      type: "PERSONAL_ACCOUNT",
      userId: input.ownerUserId,
    });
    return {
      plan: ctx.plan as PlanType,
      ownerUserId: ctx.ownerUserId,
      teamId: null,
      billingShape: String(ctx.billingShape),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve output eligibility for ONE evidence record.
 *
 * `ownerUserId`/`teamId` are the record's own, never the requester's: the
 * commercial subject of an evidence record is the workspace that holds it.
 */
export async function resolveEvidenceOutputEligibility(input: {
  evidenceId: string;
  ownerUserId: string;
  teamId: string | null;
  /**
   * An ALREADY-RESOLVED effective plan, when the caller has one.
   *
   * The Evidence Detail projection resolves a commercial context for this very
   * record a few lines away; making it resolve a second one would double the
   * cost of the page to learn a number it is already holding. Passing it is not
   * a second authority — it IS the envelope's answer, handed along.
   */
  plan?: PlanType | null;
}): Promise<EvidenceOutputEligibility> {
  const [subject, funding] = await Promise.all([
    resolveSubject({ ownerUserId: input.ownerUserId, teamId: input.teamId }),
    /*
     * A FAILED FUNDING READ IS UNRESOLVED, NOT PLAN (2026-09-29). It used to
     * default to PLAN, so a credit-funded record on a FREE account read
     * "not included" whenever the ledger could not be read — while the worker,
     * reading the same ledger, answered UNRESOLVED and retried. Unknown is
     * neither a paid activation nor a permanent refusal.
     */
    resolveEvidenceFunding(input.evidenceId).catch((): EvidenceFundingSource | null => null),
  ]);
  const plan = input.plan ?? subject?.plan ?? null;
  const lifecycle = await resolveSubjectLifecycle(
    subject && plan ? { ...subject, plan } : null,
  );
  return project({ plan, funding, lifecycle });
}

/**
 * Resolve output eligibility for a PAGE of records that share ONE workspace
 * scope.
 *
 * The scope is resolved once and the ledger read once, because a list surface
 * asking per row is how a projection becomes too slow to use and then gets
 * replaced by a plan-name guess.
 */
export async function resolveEvidenceOutputEligibilityMany(input: {
  evidenceIds: readonly string[];
  /**
   * The workspace OWNER. Optional when `teamId` is set, because the by-team
   * branch of the canonical resolver takes the subject from the
   * workspace row and never consults an owner — a shared workspace's records
   * may belong to many people and the commercial subject is the workspace.
   * Required when `teamId` is null: a personal subject IS its owner.
   */
  ownerUserId?: string | null;
  teamId: string | null;
  /** An already-resolved effective plan. See the single-record variant. */
  plan?: PlanType | null;
}): Promise<Map<string, EvidenceOutputEligibility>> {
  const out = new Map<string, EvidenceOutputEligibility>();
  if (input.evidenceIds.length === 0) return out;

  const [subject, fundingById] = await Promise.all([
    resolveSubject({ ownerUserId: input.ownerUserId, teamId: input.teamId }),
    // A failed read is unresolved for every record (see the single variant).
    resolveEvidenceFundingMany(input.evidenceIds).catch(() => null),
  ]);
  const plan = input.plan ?? subject?.plan ?? null;
  const lifecycle = await resolveSubjectLifecycle(
    subject && plan ? { ...subject, plan } : null,
  );

  for (const evidenceId of input.evidenceIds) {
    out.set(
      evidenceId,
      project({
        plan,
        // No ledger consumption row = PLAN; a failed read = unresolved.
        funding: fundingById === null ? null : (fundingById.get(evidenceId) ?? "PLAN"),
        lifecycle,
      }),
    );
  }
  return out;
}

/**
 * THE COMMERCIAL SUBJECT OF A RECORD, AS A GROUPING KEY.
 *
 * A record's commercial subject is the workspace that holds it, and the owner
 * when it holds none. Two records with the same key resolve to the same plan,
 * so a page of records needs one resolution per DISTINCT key rather than one
 * per row.
 */
function commercialSubjectKey(record: {
  ownerUserId: string;
  teamId: string | null;
}): string {
  return `${record.ownerUserId}::${record.teamId ?? ""}`;
}

/**
 * Resolve output eligibility for a page of records that may span SEVERAL
 * commercial subjects.
 *
 * ---------------------------------------------------------------------------
 * P2-2 CLOSURE (2026-09-10) — WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `resolveEvidenceOutputEligibilityMany` takes ONE subject and applies it to
 * every id, which is exactly right for a workspace-scoped list and exactly
 * wrong for a list that crosses workspaces. The user-scoped Reports fallback
 * (`GET /v1/reports`) returns rows the caller owns OR rows in any workspace
 * they are an active member of, and it resolved all of them against the
 * CALLER'S PERSONAL PLAN. A Free-plan member of a Team workspace was therefore
 * told their Team workspace's records had no report included — the commercial
 * subject of a record is the workspace that holds it, never the person reading
 * the page.
 *
 * The rows carry their own owner and workspace, so the subject is a fact about
 * each row. This groups by it and asks the canonical resolver once per distinct
 * subject: no N+1, and no second commercial calculation.
 */
export async function resolveEvidenceOutputEligibilityByRecord(
  records: ReadonlyArray<{
    id: string;
    ownerUserId: string;
    teamId: string | null;
  }>,
): Promise<Map<string, EvidenceOutputEligibility>> {
  const out = new Map<string, EvidenceOutputEligibility>();
  if (records.length === 0) return out;

  const bySubject = new Map<
    string,
    { ownerUserId: string; teamId: string | null; ids: string[] }
  >();
  for (const record of records) {
    const key = commercialSubjectKey(record);
    const bucket = bySubject.get(key);
    if (bucket) bucket.ids.push(record.id);
    else
      bySubject.set(key, {
        ownerUserId: record.ownerUserId,
        teamId: record.teamId,
        ids: [record.id],
      });
  }

  // Sequential rather than parallel: the number of distinct subjects on one
  // page is small, and a workspace resolution touches the same tables the
  // page's own queries do.
  for (const bucket of bySubject.values()) {
    const resolved = await resolveEvidenceOutputEligibilityMany({
      evidenceIds: bucket.ids,
      ownerUserId: bucket.ownerUserId,
      teamId: bucket.teamId,
    });
    for (const [id, eligibility] of resolved) out.set(id, eligibility);
  }

  return out;
}

/**
 * The evidence ids in `evidenceIds` whose outputs are NOT included.
 *
 * Used by the operational-backlog populations, which must not count a record
 * the product deliberately never generates for. Reads the record rows itself
 * because those callers hold ids, not owners — and the workspace of a record is
 * a fact about the record.
 *
 * Chunked, and fails OPEN (returns an empty set) rather than throwing: an
 * operations counter that cannot resolve eligibility should over-report by the
 * old amount, never crash the surface.
 */
export async function selectNonEntitledEvidenceIds(
  evidenceIds: readonly string[],
): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (evidenceIds.length === 0) return excluded;

  try {
    const rows = await prisma.evidence.findMany({
      where: { id: { in: [...evidenceIds] } },
      select: { id: true, ownerUserId: true, teamId: true },
    });

    /*
     * P2-2 CLOSURE (2026-09-10) — one grouping implementation, not two.
     *
     * This function grouped by commercial subject inline, and the Reports
     * fallback needed the same grouping. Two copies of "what is this record's
     * commercial subject" is how the two come to disagree, so the grouping
     * moved to `resolveEvidenceOutputEligibilityByRecord` above and this reads
     * it.
     */
    const eligibility = await resolveEvidenceOutputEligibilityByRecord(
      rows.map((row) => ({
        id: row.id,
        ownerUserId: row.ownerUserId,
        teamId: row.teamId ?? null,
      })),
    );
    for (const row of rows) {
      if (eligibility.get(row.id)?.reportsIncluded === false)
        excluded.add(row.id);
    }
  } catch {
    return new Set<string>();
  }

  return excluded;
}

/**
 * THE OPERATIONAL-BACKLOG NARROWING, AS A DATABASE PREDICATE.
 *
 * "Signed evidence without a report" is an operational backlog only where a
 * report was ever going to be produced. The counters that feed the Operations
 * surface asked the question with no commercial input at all, so every Free
 * record counted as a pipeline problem — permanently, because nothing was ever
 * enqueued for it — and `pipeline.report_backlog` could reach HIGH or CRITICAL
 * on a workspace whose only property was the plan it had bought.
 *
 * Returns:
 *   `null`  the plan includes the outputs, so the whole population is in scope
 *           and nothing is added to the query.
 *   a where the plan EXCLUDES them, so only records funded by a purchased
 *           evidence credit remain — those genuinely are owed an artifact.
 *
 * Expressed as an id set rather than a relation test because
 * `EvidenceCreditLedgerEntry` carries `evidence_id` as a plain column with no
 * Prisma relation from `Evidence`, and a read filter is not a reason to add a
 * foreign key. The set is small by construction: a plan that excludes reports
 * is a single-occupant plan, so there is one wallet behind it.
 *
 * ET-SEC-20 — decided by THE issuance rule (`resolveOutputIssuanceEntitlement`:
 * plan AND the subscription lifecycle), the one the worker's issuance honours.
 * It asked the plan alone, so a lapsed or cancelled paid workspace counted
 * every record the worker refuses to issue — a backlog that never cleared.
 * Every backlog aggregator (Home counters, Operations probes, incident
 * generator, trust summary, org health, case risk) narrows through this.
 *
 * Fails OPEN (`null`) on any error or an unresolved decision: an operations
 * counter that cannot resolve eligibility should report what it always
 * reported, never crash the surface.
 */
export async function outputEntitledEvidenceWhere(params: {
  ownerUserId?: string | null;
  teamId: string | null;
}): Promise<{ id: { in: string[] } } | null> {
  try {
    const ctx = params.teamId
      ? await resolveCommercialPlan({
          type: "WORKSPACE",
          teamId: params.teamId,
          requesterUserId: params.ownerUserId ?? "",
        })
      : params.ownerUserId
        ? await resolveCommercialPlan({
            type: "PERSONAL_ACCOUNT",
            userId: params.ownerUserId,
          })
        : null;
    if (!ctx) return null;
    const lifecycle = await resolveSubjectLifecycle({
      plan: ctx.plan as PlanType,
      ownerUserId: ctx.ownerUserId,
      teamId: params.teamId,
      billingShape: String(ctx.billingShape),
    });
    const issuance = resolveOutputIssuanceEntitlement({
      plan: ctx.plan as PlanType,
      funding: "PLAN",
      lifecycle,
    });
    // Plan-funded records are owed outputs: the whole population is in scope.
    if (issuance.decision === "ENTITLED") return null;
    if (issuance.decision === "UNRESOLVED") return null;

    const rows = await prisma.evidenceCreditLedgerEntry.findMany({
      where: { userId: ctx.ownerUserId, entryType: "CONSUMPTION" },
      select: { evidenceId: true },
    });
    const ids = rows
      .map((r) => r.evidenceId)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    return { id: { in: ids } };
  } catch {
    return null;
  }
}

/**
 * Does this workspace's PLAN include reports at all, ignoring per-record
 * funding?
 *
 * The narrow question a WORKSPACE-level surface asks — "should this workspace
 * see report features" — as opposed to the per-record question above. Kept here
 * so both readings live beside each other and a caller has to pick one on
 * purpose rather than by reaching for whatever was in scope.
 */
export function planIncludesReports(plan: PlanType): boolean {
  return getPlanCapabilities(plan).reportsIncluded;
}

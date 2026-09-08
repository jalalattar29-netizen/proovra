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
 *   plan     ← `resolveWorkspaceScopeForEvidenceRecord` (the canonical
 *               effective-plan chain: `resolveWorkspaceScopeForUser` →
 *               `getTeamWorkspaceScope`/`getPersonalWorkspaceScope` →
 *               `resolveWorkspaceEffectivePlan`)
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
  type EvidenceFundingSource,
  type PlanType,
} from "@proovra/shared-billing";
import type {
  OutputCommercialEligibility,
  OutputIneligibilityReason,
} from "@proovra/shared";

import { prisma } from "../../db.js";
import { resolveEvidenceWorkspaceScope } from "../workspace-billing.service.js";
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
  funding: EvidenceFundingSource;
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
  /** Axis 1 for the report, in the shared state-machine vocabulary. */
  reportEligibility: OutputCommercialEligibility;
  /** Axis 1 for the verification package. */
  packageEligibility: OutputCommercialEligibility;
  /** Bounded reason, present only when something is NOT_INCLUDED. */
  ineligibilityReason: OutputIneligibilityReason | null;
};

function toEligibility(included: boolean): OutputCommercialEligibility {
  return included ? "ELIGIBLE" : "NOT_INCLUDED";
}

function project(input: {
  plan: PlanType;
  funding: EvidenceFundingSource;
}): EvidenceOutputEligibility {
  const outputs = resolveEvidenceOutputEntitlements({
    plan: input.plan,
    funding: input.funding,
  });
  const anyExcluded =
    !outputs.reportsIncluded || !outputs.verificationPackageIncluded;
  return {
    plan: input.plan,
    funding: input.funding,
    reportsIncluded: outputs.reportsIncluded,
    verificationPackageIncluded: outputs.verificationPackageIncluded,
    publicVerifyIncluded: outputs.publicVerifyIncluded,
    reportEligibility: toEligibility(outputs.reportsIncluded),
    packageEligibility: toEligibility(outputs.verificationPackageIncluded),
    ineligibilityReason: anyExcluded ? "NOT_INCLUDED_IN_PLAN" : null,
  };
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
 * Resolve output eligibility for ONE evidence record.
 *
 * `ownerUserId`/`teamId` are the record's own, never the requester's: the
 * commercial subject of an evidence record is the workspace that holds it.
 */
export async function resolveEvidenceOutputEligibility(input: {
  evidenceId: string;
  ownerUserId: string;
  teamId: string | null;
}): Promise<EvidenceOutputEligibility> {
  const [scope, funding] = await Promise.all([
    resolveEvidenceWorkspaceScope({
      ownerUserId: input.ownerUserId,
      teamId: input.teamId,
    }).catch(() => null),
    resolveEvidenceFunding(input.evidenceId).catch(
      (): EvidenceFundingSource => "PLAN",
    ),
  ]);

  return project({
    plan: (scope?.plan as PlanType | undefined) ?? fallbackPlan(),
    funding,
  });
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
   * branch of `resolveEvidenceWorkspaceScope` resolves the subject from the
   * workspace row and never consults an owner — a shared workspace's records
   * may belong to many people and the commercial subject is the workspace.
   * Required when `teamId` is null: a personal subject IS its owner.
   */
  ownerUserId?: string | null;
  teamId: string | null;
}): Promise<Map<string, EvidenceOutputEligibility>> {
  const out = new Map<string, EvidenceOutputEligibility>();
  if (input.evidenceIds.length === 0) return out;

  const [scope, fundingById] = await Promise.all([
    input.teamId || input.ownerUserId
      ? resolveEvidenceWorkspaceScope({
          ownerUserId: input.ownerUserId ?? "",
          teamId: input.teamId,
        }).catch(() => null)
      : Promise.resolve(null),
    resolveEvidenceFundingMany(input.evidenceIds).catch(
      () => new Map<string, EvidenceFundingSource>(),
    ),
  ]);
  const plan = (scope?.plan as PlanType | undefined) ?? fallbackPlan();

  for (const evidenceId of input.evidenceIds) {
    out.set(
      evidenceId,
      project({ plan, funding: fundingById.get(evidenceId) ?? "PLAN" }),
    );
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

    // One resolution per distinct workspace, not per record.
    const byWorkspace = new Map<
      string,
      { ownerUserId: string; teamId: string | null; ids: string[] }
    >();
    for (const row of rows) {
      const key = `${row.ownerUserId}::${row.teamId ?? ""}`;
      const bucket = byWorkspace.get(key);
      if (bucket) bucket.ids.push(row.id);
      else
        byWorkspace.set(key, {
          ownerUserId: row.ownerUserId,
          teamId: row.teamId ?? null,
          ids: [row.id],
        });
    }

    for (const bucket of byWorkspace.values()) {
      const eligibility = await resolveEvidenceOutputEligibilityMany({
        evidenceIds: bucket.ids,
        ownerUserId: bucket.ownerUserId,
        teamId: bucket.teamId,
      });
      for (const id of bucket.ids) {
        if (eligibility.get(id)?.reportsIncluded === false) excluded.add(id);
      }
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
 * Fails OPEN (`null`) on any error: an operations counter that cannot resolve
 * eligibility should report what it always reported, never crash the surface.
 */
export async function outputEntitledEvidenceWhere(params: {
  ownerUserId?: string | null;
  teamId: string | null;
}): Promise<{ id: { in: string[] } } | null> {
  try {
    const scope = await resolveEvidenceWorkspaceScope({
      ownerUserId: params.ownerUserId ?? "",
      teamId: params.teamId,
    });
    if (getPlanCapabilities(scope.plan as PlanType).reportsIncluded) return null;

    const rows = await prisma.evidenceCreditLedgerEntry.findMany({
      where: { userId: scope.ownerUserId, entryType: "CONSUMPTION" },
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

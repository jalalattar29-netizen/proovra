/**
 * THE WORKER'S OUTPUT ISSUANCE ANSWER (2026-09-29).
 *
 * A thin input adapter, not a second authority: it loads the three inputs —
 * the record's effective plan (this host's scope resolver), how the record's
 * completion was funded (the credit ledger), and the subject's commercial
 * lifecycle (the SHARED reader the API also uses), plus the record's stored
 * funding fact (ET-COM-04) — and hands them to
 * `resolveOutputIssuanceEntitlement` in @proovra/shared-billing.
 *
 * Every worker producer and gate asks this instead of `plan` alone:
 * generation claim, the package completeness guard, the report/package
 * allowance gates, the first-issuance reconciliation and the OTS/TSA paths.
 * Any failure to read an input returns UNRESOLVED — the worker then issues
 * nothing and retries later, instead of guessing (the old guard failed OPEN).
 */
import {
  readOutputEarnedFact,
  resolveOutputIssuanceEntitlement,
  type OutputEarnedFact,
  type OutputIssuanceEntitlement,
  type OutputIssuanceLifecycle,
} from "@proovra/shared-billing";
import { readCommercialLifecycle } from "@proovra/shared-runtime";

import { prisma } from "./db.js";
import {
  resolveEvidenceFundingSource,
  resolveWorkspaceScopeForEvidence,
} from "./workspace-billing.js";

export async function resolveEvidenceOutputIssuance(record: {
  id: string;
  ownerUserId: string;
  teamId: string | null;
}): Promise<OutputIssuanceEntitlement> {
  let funding: "PLAN" | "EVIDENCE_CREDIT" | null = null;
  try {
    funding = await resolveEvidenceFundingSource(record.id);
  } catch {
    funding = null;
  }
  if (funding === "EVIDENCE_CREDIT") {
    return resolveOutputIssuanceEntitlement({ plan: null, funding, lifecycle: null });
  }

  // ET-COM-04 — THE STORED FUNDING FACT. A record that earned its outputs when
  // it was finalized keeps them: a report job queued before the plan lapsed
  // still runs. A failed read is "no fact" — the current lifecycle then
  // decides, which can only be the stricter answer.
  let earned: OutputEarnedFact = null;
  try {
    earned = readOutputEarnedFact(
      await prisma.evidence.findUnique({
        where: { id: record.id },
        select: { outputEarnedPlan: true, outputEarnedBasis: true },
      }),
    );
  } catch {
    earned = null;
  }

  let plan: string | null = null;
  let lifecycle: OutputIssuanceLifecycle = null;
  try {
    const scope = await resolveWorkspaceScopeForEvidence({
      ownerUserId: record.ownerUserId,
      teamId: record.teamId,
    });
    plan = String(scope.plan);
    const reading = await readCommercialLifecycle(
      prisma,
      scope.billingShape === "SINGLE_OCCUPANT" || !scope.teamId
        ? { kind: "PERSONAL", ownerUserId: scope.ownerUserId, plan }
        : { kind: "WORKSPACE", teamId: scope.teamId, plan },
    );
    lifecycle = { state: reading.state, providerStatus: reading.providerStatus };
  } catch {
    lifecycle = null;
  }
  return resolveOutputIssuanceEntitlement({
    plan: plan as Parameters<typeof resolveOutputIssuanceEntitlement>[0]["plan"],
    funding,
    lifecycle,
    earned,
  });
}

/** Thrown when the decision is UNRESOLVED: retry later, issue nothing now. */
export const OUTPUT_ENTITLEMENT_UNRESOLVED = "OUTPUT_ENTITLEMENT_UNRESOLVED";

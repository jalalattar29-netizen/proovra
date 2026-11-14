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
  type WorkerDbClient,
} from "./workspace-billing.js";

/**
 * AUD-0017 (TXP-023/024) — `client` is the connection the inputs are read on:
 * the report and package commit admissions pass their transaction; every other
 * caller keeps the global client. Inside a transaction a failed read aborts it,
 * so the reads after it fail too and the answer is UNRESOLVED (retry).
 */
export async function resolveEvidenceOutputIssuance(
  record: {
    id: string;
    ownerUserId: string;
    teamId: string | null;
  },
  client: WorkerDbClient = prisma,
): Promise<OutputIssuanceEntitlement> {
  let funding: "PLAN" | "EVIDENCE_CREDIT" | null = null;
  try {
    funding = await resolveEvidenceFundingSource(record.id, client);
  } catch {
    funding = null;
  }
  if (funding === "EVIDENCE_CREDIT") {
    return resolveOutputIssuanceEntitlement({ plan: null, funding, lifecycle: null });
  }

  // ET-COM-04 — THE STORED FUNDING FACT. A record that earned its outputs when
  // it was finalized keeps them: a report job queued before the plan lapsed
  // still runs. F-09 (2026-11-13) — a failed read is UNRESOLVED, not "no
  // fact": for a FREE allowance record the fact IS the entitlement, and
  // answering without it settled an entitled record NOT_APPLICABLE.
  let earned: OutputEarnedFact = null;
  let earnedUnreadable = false;
  try {
    earned = readOutputEarnedFact(
      await client.evidence.findUnique({
        where: { id: record.id },
        select: { outputEarnedPlan: true, outputEarnedBasis: true },
      }),
    );
  } catch {
    earned = null;
    earnedUnreadable = true;
  }

  let plan: string | null = null;
  let lifecycle: OutputIssuanceLifecycle = null;
  try {
    const scope = await resolveWorkspaceScopeForEvidence(
      {
        ownerUserId: record.ownerUserId,
        teamId: record.teamId,
      },
      client,
    );
    plan = String(scope.plan);
    const reading = await readCommercialLifecycle(
      client,
      scope.billingShape === "SINGLE_OCCUPANT" || !scope.teamId
        ? { kind: "PERSONAL", ownerUserId: scope.ownerUserId, plan }
        : { kind: "WORKSPACE", teamId: scope.teamId, plan },
    );
    lifecycle = { state: reading.state, providerStatus: reading.providerStatus };
  } catch {
    lifecycle = null;
  }
  return resolveOutputIssuanceEntitlement({
    // An unknown plan is the one resolver's UNRESOLVED answer (retry later).
    plan: earnedUnreadable ? null : (plan as Parameters<typeof resolveOutputIssuanceEntitlement>[0]["plan"]),
    funding,
    lifecycle,
    earned,
  });
}

/** Thrown when the decision is UNRESOLVED: retry later, issue nothing now. */
export const OUTPUT_ENTITLEMENT_UNRESOLVED = "OUTPUT_ENTITLEMENT_UNRESOLVED";

/**
 * THE WORKER'S ENTITLEMENT READING FOR THE OUTPUT-PRODUCER GUARD (2026-10-20).
 * Every worker producer hands this to `createReportGenerationRequest`, which
 * applies the shared `decideOutputProduction`. A failed read is null: the
 * writer creates nothing and answers `entitlement_unresolved`.
 */
export async function workerOutputEntitlement(
  subject: {
    id: string;
    ownerUserId: string;
    teamId: string | null;
  },
  client: WorkerDbClient = prisma,
): Promise<OutputIssuanceEntitlement | null> {
  try {
    return await resolveEvidenceOutputIssuance(subject, client);
  } catch {
    return null;
  }
}

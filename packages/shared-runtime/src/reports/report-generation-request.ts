/**
 * PHASE 12 — POINT 5: the ONE writer of `ReportGenerationRequest` rows.
 *
 * It lives in `shared-runtime` rather than in either service because BOTH
 * produce report generation intent and there must be exactly one authority
 * that decides what a request row means:
 *
 *   * the api, when an authorized route or the evidence-completion fan-out
 *     asks for a report;
 *   * the worker, when the OTS upgrade completes and the report must be
 *     regenerated with the anchored timestamp, and when the lifecycle-recovery
 *     sweep finds evidence that was SIGNED but never reported.
 *
 * Each process passes its own `PrismaClient` — shared-runtime never constructs
 * one — so the two callers share the rule set without sharing a connection.
 *
 * The row is COMMITTED here and the caller enqueues afterwards. A caller that
 * runs this inside an open transaction breaks the durability argument: it
 * would hand out an id whose row a rollback removes.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
// COMMERCIAL SUPERSESSION (2026-09-08) — the SHARED classifier for "this
// terminal reason is one that a change of entitlement makes obsolete". Shared
// so the writer here, the worker's denial path and the customer projection
// cannot each hold their own list.
import { isCommerciallyObsoleteTerminalReason } from "@proovra/shared";

/**
 * Artifact kinds a request may name. Bounded because the processor branches on
 * it, and an unbounded string would let a request select a branch that does
 * not exist.
 */
export const REPORT_ARTIFACT_TYPES = [
  "REPORT",
  "VERIFICATION_PACKAGE",
  "EXCHANGE_PACKAGE",
] as const;
export type ReportArtifactType = (typeof REPORT_ARTIFACT_TYPES)[number];

/**
 * Why generation was asked for. Bounded so the operator projection can group
 * requests without surfacing free text a caller controls.
 */
export const REPORT_GENERATION_PURPOSES = [
  "evidence_completed",
  "operator_regenerate",
  "tsa_repair",
  "lifecycle_recovery",
  "ots_upgrade_completed",
  "queue_legacy_drain",
] as const;
export type ReportGenerationPurpose =
  (typeof REPORT_GENERATION_PURPOSES)[number];

export type CreateReportGenerationRequestInput = {
  evidenceId: string;
  purpose: ReportGenerationPurpose;
  artifactType?: ReportArtifactType;
  /**
   * The authorization OUTCOME, decided by the caller's own gate and persisted
   * here. Never accepted from a queue payload, never inferred.
   */
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
  /** Exactly one of these must be set; a request with no principal is refused. */
  requestedByUserId?: string | null;
  requestedByMachineId?: string | null;
};

export type CreateReportGenerationRequestResult =
  | {
      created: true;
      requestId: string;
      state: string;
      teamId: string;
      /** True when an equivalent request already existed and was reused. */
      deduplicated: boolean;
    }
  | { created: false; reason: string };

/**
 * The key that collapses duplicate intent.
 *
 * It is anchored on the artifact version the request is trying to ADVANCE
 * PAST, which makes it collapsing without being blocking:
 *
 *   * two concurrent completion fan-outs for a record with no report yet both
 *     compute `REPORT:<id>:v0` and produce ONE row;
 *   * two operators clicking regenerate on a record at report v3 both compute
 *     `REPORT:<id>:v3:force` and produce ONE row;
 *   * an operator regenerating AGAIN after that succeeded computes
 *     `REPORT:<id>:v4:force` — genuinely new intent, genuinely a new row.
 *
 * A key without the version would make the second legitimate regenerate a
 * silent no-op. A key with a timestamp would make two concurrent clicks
 * produce two reports. The baseline version is the discriminator that is true.
 */
export function buildReportGenerationIdempotencyKey(input: {
  artifactType: ReportArtifactType;
  evidenceId: string;
  baselineVersion: number;
  forceRegenerate: boolean;
}): string {
  const suffix = input.forceRegenerate ? ":force" : "";
  return `${input.artifactType}:${input.evidenceId}:v${input.baselineVersion}${suffix}`.slice(
    0,
    160,
  );
}

/**
 * Persist one report-generation intent.
 *
 * Never throws. Every failure is a bounded reason so an evidence-completion
 * fan-out cannot be broken by a duplicate-request race.
 */
export async function createReportGenerationRequest(
  prisma: PrismaClient,
  input: CreateReportGenerationRequestInput,
): Promise<CreateReportGenerationRequestResult> {
  const evidenceId = input.evidenceId.trim();
  if (!evidenceId) return { created: false, reason: "evidence_id_required" };

  if (!input.requestedByUserId && !input.requestedByMachineId) {
    // A request with no principal cannot be audited and cannot be authorized
    // after the fact. Refusing here is cheaper than discovering it in the
    // worker, where the only available answer is to fail the job.
    return { created: false, reason: "requester_required" };
  }

  const artifactType: ReportArtifactType = input.artifactType ?? "REPORT";
  const forceRegenerate = input.forceRegenerate === true;

  // ---- Tenancy comes from the evidence row, both now and again at run time --
  const evidence = await prisma.evidence.findFirst({
    where: { id: evidenceId, deletedAt: null },
    select: { id: true, teamId: true },
  });
  if (!evidence) return { created: false, reason: "evidence_not_found" };
  if (!evidence.teamId) {
    // An evidence row with no workspace cannot be scoped, and a request that
    // cannot be scoped must not exist.
    return { created: false, reason: "evidence_workspace_unresolved" };
  }

  // ---- The policy version this decision was made under ---------------------
  // "No row at all" is version 0 — the same convention the governance API
  // reports — so a request created before a workspace's first policy edit does
  // not read as stale the moment that edit lands.
  const policy = await prisma.workspaceGovernancePolicy.findFirst({
    where: { teamId: evidence.teamId },
    select: { version: true },
  });

  const latestReport = await prisma.report.findFirst({
    where: { evidenceId },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const baseKey = buildReportGenerationIdempotencyKey({
    artifactType,
    evidenceId,
    baselineVersion: latestReport?.version ?? 0,
    forceRegenerate,
  });

  /**
   * COMMERCIAL SUPERSESSION (2026-09-08) — THE PERMANENT-LOCKOUT FIX.
   *
   * The key is anchored on the artifact version a request is trying to advance
   * past, which is exactly right while the reason a request fails is technical.
   * It is wrong for the one class of failure that a change of ENTITLEMENT
   * resolves, and that produced a permanent product dead end:
   *
   *   1. a record on a plan without reports gets a request (a recovery sweep,
   *      an OTS follow-up, an operator click);
   *   2. the worker refuses it — `REPORT_NOT_INCLUDED_IN_PLAN`, non-retryable —
   *      and the row goes FAILED_TERMINAL;
   *   3. no report exists, so `baselineVersion` stays 0 forever;
   *   4. the customer upgrades to a plan that DOES include reports;
   *   5. every subsequent request computes the SAME key, collapses onto the
   *      terminal row, and returns `already_terminal`. Operations reported it
   *      to the operator as "Nothing to do — this has already completed."
   *
   * That record could never be given its report by any path in the product.
   *
   * The fix keeps durable idempotency and adds a SUPERSESSION ORDINAL, derived
   * from state already in the database rather than from a clock: two concurrent
   * callers compute the same ordinal and the unique index still elects one
   * winner, while a genuinely new intent after a commercial change gets a
   * genuinely new row. The old row is never rewritten and never deleted — it is
   * the audit record of a refusal that really happened.
   *
   * ONLY commercial terminal reasons supersede. An integrity failure, a policy
   * block or an exhausted technical budget stays terminal, because none of them
   * is resolved by buying something.
   */
  let idempotencyKey = baseKey;
  const priorAtBaseKey = await prisma.reportGenerationRequest.findUnique({
    where: { idempotencyKey: baseKey },
    select: { state: true, terminalReasonCode: true },
  });
  if (
    priorAtBaseKey?.state === "FAILED_TERMINAL" &&
    isCommerciallyObsoleteTerminalReason(priorAtBaseKey.terminalReasonCode)
  ) {
    const supersessions = await prisma.reportGenerationRequest.count({
      where: { evidenceId, artifactType, idempotencyKey: { startsWith: `${baseKey}:s` } },
    });
    idempotencyKey = `${baseKey}:s${supersessions + 1}`.slice(0, 160);
  }

  try {
    const created = await prisma.reportGenerationRequest.create({
      data: {
        teamId: evidence.teamId,
        evidenceId,
        artifactType,
        purpose: input.purpose,
        forceRegenerate,
        regenerateReason: input.regenerateReason?.trim()?.slice(0, 120) || null,
        requestedByUserId: input.requestedByUserId ?? null,
        requestedByMachineId:
          input.requestedByMachineId?.trim()?.slice(0, 64) || null,
        expectedPolicyVersion: policy?.version ?? 0,
        idempotencyKey,
        state: "QUEUED",
      },
      select: { id: true, state: true },
    });
    return {
      created: true,
      requestId: created.id,
      state: created.state,
      teamId: evidence.teamId,
      deduplicated: false,
    };
  } catch (err) {
    // A unique violation on `idempotency_key` is the race resolving itself:
    // the database decides which concurrent caller wins, and the loser reuses
    // the winner's row rather than creating a second one.
    const isUniqueViolation =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if (!isUniqueViolation) {
      return { created: false, reason: "request_persist_failed" };
    }
    const existing = await prisma.reportGenerationRequest.findUnique({
      where: { idempotencyKey },
      select: { id: true, state: true, teamId: true },
    });
    if (!existing) return { created: false, reason: "request_persist_failed" };
    return {
      created: true,
      requestId: existing.id,
      state: existing.state,
      teamId: existing.teamId,
      deduplicated: true,
    };
  }
}

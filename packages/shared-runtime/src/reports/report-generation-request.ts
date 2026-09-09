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
import {
  isCommerciallyObsoleteTerminalReason,
  // RELIABILITY CLOSURE (2026-09-09) — the SHARED classifier for "this blocked
  // terminal names a condition that can end". Shared for the same reason as the
  // commercial one: the writer here, the worker's claim path and the customer
  // projection must not each hold their own list.
  isRecoverableBlockedTerminalReason,
} from "@proovra/shared";

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
      /**
       * True when this row SUPERSEDED an earlier terminal one whose blocker has
       * since gone away. Distinct from `deduplicated`, which says the opposite —
       * that no new row was needed. Callers report the two differently: a
       * supersession is the click that finally worked.
       */
      superseded: boolean;
      /**
       * The terminal reason when `state` is a terminal one, so the caller can
       * tell a still-standing recoverable blocker apart from a dead terminal
       * without re-reading the row it was just handed.
       */
      terminalReasonCode?: string | null;
    }
  | {
      created: false;
      reason: string;
      /**
       * Set when the refusal is "a terminal row already stands here". Carries
       * whether that terminal names a condition that COULD end, so the caller
       * can tell a customer "this is blocked" apart from "this is over".
       */
      terminalState?: string;
      terminalReasonCode?: string | null;
      terminalIsRecoverable?: boolean;
    };

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
  /*
   * ---------------------------------------------------------------------------
   * RELIABILITY CLOSURE (2026-09-09) — THE SAME LOCKOUT, THREE MORE WAYS IN.
   * ---------------------------------------------------------------------------
   * The commercial rule above closed one class and left the identical dead end
   * open for every BLOCKED terminal. `BLOCKED_STALE` and `BLOCKED_POLICY` are
   * terminal states too, they also produce no artifact, so `baselineVersion`
   * also stays 0 — and the three reasons the worker writes there are all
   * conditions that END:
   *
   *   policy_version_changed   a governance policy was edited mid-flight. That
   *                            is a RACE. The next request would have carried
   *                            the new version and simply run.
   *   legal_hold_active        holds are released.
   *   organization_not_active  suspensions are lifted.
   *
   * A workspace admin editing their governance policy at the wrong moment could
   * therefore permanently deny one of their own records a report, with no path
   * out for the customer, the Reports page or the operator console.
   *
   * TWO CONDITIONS, NOT ONE. A reason code records what was true once; it is
   * never permission to act now. So supersession here requires BOTH:
   *
   *   1. the reason is classified recoverable by the shared authority, AND
   *   2. `blockerStillActive()` confirms, against the CURRENT row, that the
   *      blocker has actually gone away.
   *
   * The revalidation predicates are deliberately the SAME reads the worker's
   * claim path performs, so a request this writer mints is one the worker will
   * accept rather than block again a second later.
   */
  /*
   * THE SUPERSESSION HEAD, not the base row.
   *
   * The commercial rule read only the row at `baseKey` and then counted the
   * `:s` rows to pick the next ordinal. That is right the first time and wrong
   * every time after: once `:s1` exists, the base row is still terminal, so a
   * SECOND click computed `:s2` and created a second live request — even while
   * `:s1` was queued and running. Two runnable requests for one record at one
   * baseline is exactly the pair that can race for an artifact version.
   *
   * The decision therefore belongs to the HEAD of the chain — the highest
   * ordinal that exists — because that row is the one describing what is
   * happening now. A non-terminal head means work is already live and the
   * caller collapses onto it.
   */
  const chain = await prisma.reportGenerationRequest.findMany({
    where: {
      evidenceId,
      artifactType,
      OR: [
        { idempotencyKey: baseKey },
        { idempotencyKey: { startsWith: `${baseKey}:s` } },
      ],
    },
    select: { idempotencyKey: true, state: true, terminalReasonCode: true },
  });

  /** `baseKey` is ordinal 0; `baseKey:s<n>` is ordinal n. */
  const ordinalOf = (key: string): number => {
    if (key === baseKey) return 0;
    const suffix = key.slice(baseKey.length + 2); // drop `${baseKey}:s`
    const n = Number.parseInt(suffix, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  let headOrdinal = 0;
  let head: { state: string; terminalReasonCode: string | null } | null = null;
  for (const row of chain) {
    const ordinal = ordinalOf(row.idempotencyKey);
    if (head === null || ordinal >= headOrdinal) {
      headOrdinal = ordinal;
      head = { state: row.state, terminalReasonCode: row.terminalReasonCode };
    }
  }

  let idempotencyKey =
    headOrdinal === 0 ? baseKey : `${baseKey}:s${headOrdinal}`.slice(0, 160);
  let superseded = false;

  const commerciallyObsolete =
    head?.state === "FAILED_TERMINAL" &&
    isCommerciallyObsoleteTerminalReason(head.terminalReasonCode);

  const blockedButRecoverable =
    (head?.state === "BLOCKED_STALE" || head?.state === "BLOCKED_POLICY") &&
    isRecoverableBlockedTerminalReason(head.terminalReasonCode);

  // The second condition, and the one that makes this safe: the reason says the
  // blocker COULD have ended; this read says whether it actually has.
  const blockerCleared =
    blockedButRecoverable &&
    !(await blockerStillActive(prisma, {
      evidenceId,
      teamId: evidence.teamId,
      terminalReasonCode: head!.terminalReasonCode,
    }));

  if (commerciallyObsolete || blockerCleared) {
    idempotencyKey = `${baseKey}:s${headOrdinal + 1}`.slice(0, 160);
    superseded = true;
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
      superseded,
      terminalReasonCode: null,
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
      select: {
        id: true,
        state: true,
        teamId: true,
        terminalReasonCode: true,
      },
    });
    if (!existing) return { created: false, reason: "request_persist_failed" };
    return {
      created: true,
      requestId: existing.id,
      state: existing.state,
      teamId: existing.teamId,
      deduplicated: true,
      // The loser of a supersession race did not create the row, but the row it
      // reuses IS the supersession the caller asked for.
      superseded,
    };
  }
}

/**
 * IS THE BLOCKER THIS TERMINAL ROW NAMES STILL IN FORCE?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A READ AND NOT A RULE
 * ---------------------------------------------------------------------------
 * `isRecoverableBlockedTerminalReason` answers a question about a VOCABULARY —
 * can this kind of blocker end? This answers a question about the WORLD — has
 * this one ended? Supersession needs both, and separating them is what stops a
 * stale reason code from becoming permission to act.
 *
 * Each predicate is deliberately the same read the worker's own claim path
 * performs in `resolveAndClaimReportRequest`. If it were even slightly wider,
 * this writer would mint requests the worker immediately blocks again, and the
 * customer would watch a button do nothing on every press.
 *
 * FAILS CLOSED. Any unknown reason, and any error, answers `true` — the blocker
 * is treated as still active and nothing is superseded. Refusing to supersede
 * leaves the product exactly as it was; superseding wrongly starts work that
 * governance had refused.
 */
async function blockerStillActive(
  prisma: PrismaClient,
  input: {
    evidenceId: string;
    teamId: string;
    terminalReasonCode: string | null;
  },
): Promise<boolean> {
  const code = (input.terminalReasonCode ?? "").trim().toUpperCase();
  try {
    switch (code) {
      /*
       * A STALE POLICY VERSION IS NEVER STILL ACTIVE.
       *
       * The block was "the policy moved under this request", and the new request
       * captures `policy.version` as it is right now — so the condition that
       * blocked the old one cannot, by construction, block the new one for the
       * same reason. If the policy moves again mid-flight the worker will block
       * again, correctly, and that new terminal will itself be recoverable.
       */
      case "POLICY_VERSION_CHANGED":
        return false;

      /*
       * THE SAME PREDICATE THE CLAIM PATH USES. `resolveAndClaimReportRequest`
       * blocks on `EvidenceLegalHold(evidenceId, status: ACTIVE)`, and this asks
       * exactly that. It deliberately does NOT consult case-scoped holds: those
       * govern EXPORT (`checkExportEligibility`), not generation, and widening
       * the rule here would invent a second hold policy.
       */
      case "LEGAL_HOLD_ACTIVE": {
        const hold = await prisma.evidenceLegalHold.findFirst({
          where: { evidenceId: input.evidenceId, status: "ACTIVE" },
          select: { id: true },
        });
        return hold !== null;
      }

      /*
       * Lifecycle lives on the Organization, not the workspace — a Team has no
       * status column of its own. Same resolution the claim path performs.
       */
      case "ORGANIZATION_NOT_ACTIVE": {
        const workspace = await prisma.team.findUnique({
          where: { id: input.teamId },
          select: { organizationId: true },
        });
        if (!workspace) return true;
        const organization = await prisma.organization.findUnique({
          where: { id: workspace.organizationId },
          select: { status: true },
        });
        return !organization || organization.status !== "ACTIVE";
      }

      default:
        // Unclassified. Treat the blocker as still standing.
        return true;
    }
  } catch {
    return true;
  }
}

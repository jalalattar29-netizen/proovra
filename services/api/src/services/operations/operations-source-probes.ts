/**
 * ONE OBSERVATION AUTHORITY PER OPERATIONS SOURCE.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * Discovery asked each source a question, and NOTHING ELSE could ask it again.
 * The report backlog was counted in `scanReportBacklog`, inside the generator,
 * as a local expression — so when an operator pressed Resolve, the server had
 * no way to find out whether the backlog was still there. It accepted the
 * resolution, and the next sweep re-counted, found 26 records still above the
 * threshold, and reopened the condition. For up to one reconciliation interval
 * the workspace displayed a false RESOLVED over a real, unchanged backlog.
 *
 * A second copy of the count in the resolve path would have closed that hole
 * and opened a worse one: two predicates that agree on the day they are
 * written and diverge on the day one of them is corrected.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * The observation, once per source, behind one function. Five callers share
 * it and none of them re-derives it:
 *
 *   * discovery / reconciliation      — is the condition true right now?
 *   * manual-resolution validation    — may this operator close it?
 *   * recovery detection              — should it close itself?
 *   * recurrence detection            — has it come back?
 *   * the current-metric projection    — what number does the row show?
 *
 * Every handler is keyed by the `activityProbeKey` its source DECLARES in
 * `OPERATIONS_SOURCE_LIFECYCLES`. The map is checked exhaustive against that
 * union at compile time, so a source cannot claim SOURCE_TRUTH and then have
 * no observation behind the claim.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 * ---------------------------------------------------------------------------
 * It holds NO policy. Whether a given activity permits a resolution is decided
 * by `decideManualResolution` in the shared authority, from the source's
 * declared `resolutionAuthority`. This module answers one question — what does
 * the source say — and an unreadable source answers UNKNOWN rather than
 * guessing in either direction.
 */

import {
  observeQueueRecentFailures,
  observeWorkerFleetHeartbeat,
  queueNameFromPlatformFingerprint,
} from "./platform-conditions.service.js";
import { parseOtsBudgetExhaustedFingerprint, REVIEW_ESCALATION_TERMINAL } from "@proovra/shared";
import type { PrismaClient, Prisma } from "@prisma/client";

import type { IncidentCategory, IncidentSeverity } from "@proovra/shared";
import {
  isOtsPendingAged,
  // RELIABILITY CLOSURE (2026-09-09) — the never-attempted predicate.
  isOtsInitializationStalled,
  workspaceEvidenceWhere,
  type ActivityProbeKey,
  type ConditionMetricUnit,
  type SourceActivity,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
// COMMERCIAL CLOSURE (2026-09-08) — the ONE narrowing that keeps a commercial
// product decision out of the artifact-backlog conditions.
import { outputEntitledEvidenceWhere } from "../billing/evidence-output-eligibility.service.js";

import { primaryPublishedPackageWhere } from "@proovra/shared-runtime/reports";
// ===========================================================================
// THRESHOLDS — every one is real platform state
//
// They live HERE, with the observation that uses them, rather than in the
// generator. The generator was the only reader while it was the only caller;
// now the resolve path and the metric projection need the same numbers, and a
// threshold defined at one call site is a threshold the other call sites get
// to disagree about.
// ===========================================================================

export const REPORT_BACKLOG_HIGH = 20;
export const REPORT_BACKLOG_CRITICAL = 100;
export const PACKAGE_BACKLOG_HIGH = 20;
export const PACKAGE_BACKLOG_CRITICAL = 100;
export const STALE_REVIEW_HOURS = 72;
export const STALE_REVIEW_HIGH_COUNT = 5;
export const UNSIGNED_FINALIZED_AGED_DAYS = 14;
export const UNSIGNED_FINALIZED_HIGH_COUNT = 5;
export const COORDINATION_STALE_DAYS = 21;
export const COORDINATION_STALE_HIGH_COUNT = 10;

// ===========================================================================
// THE OBSERVATION
// ===========================================================================

/**
 * What ONE probe saw. Bounded: no rows, no provider strings, no SQL.
 *
 * `affectedIds` is deliberately absent. The aggregate sources count
 * populations that can run to five figures, and returning ids from an
 * observation would put an unbounded list on a path that runs on every sweep
 * and on every resolve attempt. The drill-down is a separate, paginated read
 * on the surface that owns the records.
 */
export type SourceObservation = {
  readonly activity: SourceActivity;
  readonly observedAtUtc: Date;
  /** Present for AGGREGATE_THRESHOLD and AGE_THRESHOLD sources. */
  readonly currentValue?: number;
  readonly thresholdValue?: number;
  readonly criticalThresholdValue?: number | null;
  readonly unit?: ConditionMetricUnit;
  /** What the value counts, for the drill-down label. */
  readonly affectedEntityType?: string | null;
  /** True when the underlying read was bounded and the value is a floor. */
  readonly truncated?: boolean;
  /** The severity this value warrants NOW. Recomputed on every observation. */
  readonly severity?: IncidentSeverity;
};

/** What a probe needs to look. Resolved once per sweep by the caller. */
export type ProbeContext = {
  readonly teamId: string;
  /** The condition's own fingerprint. Used only by per-record probes. */
  readonly fingerprint: string;
  readonly client: PrismaClient;
  readonly now: Date;
  /**
   * The canonical workspace evidence scope.
   *
   * Resolved by `workspaceEvidenceWhere`, which widens to the owner's legacy
   * `team_id = NULL` rows for a PERSONAL workspace and keeps a strict filter
   * for a shared team. Never a bare `teamId: null` arm: that would read
   * another owner's records.
   */
  readonly evidenceWhere: Prisma.EvidenceWhereInput;
  /**
   * COMMERCIAL CLOSURE (2026-09-08) — the OUTPUT-ENTITLED narrowing for the two
   * artifact-backlog probes.
   *
   * `pipeline.report_backlog` counted `Evidence(status=SIGNED,
   * latestReportVersion=null)` with no commercial input. On a plan that does
   * not include reports nothing is ever enqueued, so every finalized record
   * counted toward a backlog that could escalate to HIGH at 20 and CRITICAL at
   * 100 — an operational condition raised entirely by a commercial decision the
   * customer made on purpose.
   *
   * `null` means "the plan includes them, count everything", which is the
   * common case and adds nothing to the query. It is resolved once per sweep
   * beside the evidence scope, never per probe.
   */
  readonly outputEntitledWhere: Prisma.EvidenceWhereInput | null;
};

/** Build a probe context, resolving the canonical evidence scope once. */
export async function buildProbeContext(input: {
  teamId: string;
  fingerprint: string;
  client?: PrismaClient;
  now?: Date;
  evidenceWhere?: Prisma.EvidenceWhereInput;
  outputEntitledWhere?: Prisma.EvidenceWhereInput | null;
}): Promise<ProbeContext> {
  const client = input.client ?? defaultPrisma;
  return {
    teamId: input.teamId,
    fingerprint: input.fingerprint,
    client,
    now: input.now ?? new Date(),
    evidenceWhere:
      input.evidenceWhere ?? (await workspaceEvidenceWhere(input.teamId, client)),
    outputEntitledWhere:
      input.outputEntitledWhere !== undefined
        ? input.outputEntitledWhere
        : await outputEntitledEvidenceWhere({ teamId: input.teamId }),
  };
}

// ===========================================================================
// AGGREGATE SOURCES — one declarative spec each
// ===========================================================================

/**
 * How an aggregate source is counted, thresholded and described.
 *
 * The STABLE TITLE is the field that closes the frozen-count defect. Titles
 * used to embed the value — "Report backlog above threshold (26)" — and the
 * writer never rewrote them, so the number was true once and then simply sat
 * there. The value now lives in the metric snapshot, which is refreshed on
 * every observation; the title says what the condition IS and never changes.
 */
type AggregateSpec = {
  readonly probeKey: ActivityProbeKey;
  readonly sourceId: string;
  readonly category: IncidentCategory;
  /** `<prefix>:<teamId>`. The same prefix the lifecycle contract matches on. */
  readonly fingerprintPrefix: string;
  /** Count-free, and therefore never a reason to rewrite the fingerprint. */
  readonly stableTitle: string;
  readonly unit: ConditionMetricUnit;
  readonly affectedEntityType: string | null;
  readonly thresholdValue: number;
  readonly criticalThresholdValue: number | null;
  /** Severity while active and below the escalation value. */
  readonly baseSeverity: IncidentSeverity;
  readonly escalatedSeverity: IncidentSeverity;
  /**
   * `GTE` for counted populations, `GT` for the two age-based sources.
   *
   * Stated rather than normalised because the pre-existing scanners used
   * different comparisons and silently changing one would move a real severity
   * boundary in production for no reason connected to this correction.
   */
  readonly escalationComparison: "GTE" | "GT";
  readonly runbookSlug: string | null;
  /** Operator-safe. Describes the condition; the number comes from the metric. */
  readonly describe: (o: { value: number }) => string;
  readonly count: (
    ctx: ProbeContext,
  ) => Promise<{ value: number; truncated?: boolean }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const AGGREGATE_SPECS: readonly AggregateSpec[] = [
  {
    probeKey: "pipeline.report_backlog_count",
    sourceId: "pipeline.report_backlog",
    category: "REPORT",
    fingerprintPrefix: "dashboard:pipeline:report_backlog",
    stableTitle: "Report generation backlog",
    unit: "records",
    affectedEntityType: "evidence",
    thresholdValue: REPORT_BACKLOG_HIGH,
    criticalThresholdValue: REPORT_BACKLOG_CRITICAL,
    baseSeverity: "HIGH",
    escalatedSeverity: "CRITICAL",
    escalationComparison: "GTE",
    runbookSlug: "report-pipeline",
    describe: () =>
      `Signed evidence records that are entitled to a report in this workspace have none. Source: Evidence(status=SIGNED, latestReportVersion=null), narrowed to records whose plan or funding includes a report. HIGH at ${REPORT_BACKLOG_HIGH}, CRITICAL at ${REPORT_BACKLOG_CRITICAL}.`,
    count: async (ctx) => ({
      value: await ctx.client.evidence.count({
        where: {
          AND: [
            ctx.evidenceWhere,
            ...(ctx.outputEntitledWhere ? [ctx.outputEntitledWhere] : []),
            { status: "SIGNED", latestReportVersion: null },
          ],
        },
      }),
    }),
  },
  {
    probeKey: "pipeline.package_backlog_count",
    sourceId: "pipeline.package_backlog",
    category: "PACKAGE",
    fingerprintPrefix: "dashboard:pipeline:package_backlog",
    stableTitle: "Verification package backlog",
    unit: "records",
    affectedEntityType: "evidence",
    thresholdValue: PACKAGE_BACKLOG_HIGH,
    criticalThresholdValue: PACKAGE_BACKLOG_CRITICAL,
    baseSeverity: "HIGH",
    escalatedSeverity: "CRITICAL",
    escalationComparison: "GTE",
    runbookSlug: "package-pipeline",
    describe: () =>
      `Reported evidence records that are entitled to a verification package have none. Source: Evidence(status=REPORTED, verificationPackageVersion=null), narrowed to records whose plan or funding includes a package. HIGH at ${PACKAGE_BACKLOG_HIGH}, CRITICAL at ${PACKAGE_BACKLOG_CRITICAL}.`,
    count: async (ctx) => ({
      value: await ctx.client.evidence.count({
        where: {
          AND: [
            ctx.evidenceWhere,
            ...(ctx.outputEntitledWhere ? [ctx.outputEntitledWhere] : []),
            { status: "REPORTED", verificationPackageVersion: null },
          ],
        },
      }),
    }),
  },
  {
    probeKey: "pipeline.signed_without_report_aged_count",
    sourceId: "pipeline.signed_without_report_aged",
    category: "GOVERNANCE",
    fingerprintPrefix: "dashboard:integrity:unsigned_aged",
    stableTitle: "Uploaded evidence awaiting signing",
    unit: "records",
    affectedEntityType: "evidence",
    thresholdValue: UNSIGNED_FINALIZED_HIGH_COUNT,
    criticalThresholdValue: UNSIGNED_FINALIZED_HIGH_COUNT * 3,
    baseSeverity: "WARNING",
    escalatedSeverity: "HIGH",
    escalationComparison: "GTE",
    runbookSlug: "signing-pipeline",
    describe: () =>
      `Evidence records are status=UPLOADED, unsigned, and older than ${UNSIGNED_FINALIZED_AGED_DAYS} days. Source: Evidence(status=UPLOADED, createdAt < cutoff). HIGH at ${UNSIGNED_FINALIZED_HIGH_COUNT}.`,
    count: async (ctx) => ({
      value: await ctx.client.evidence.count({
        where: {
          AND: [
            ctx.evidenceWhere,
            {
              status: "UPLOADED",
              createdAt: {
                lt: new Date(
                  ctx.now.getTime() - UNSIGNED_FINALIZED_AGED_DAYS * DAY_MS,
                ),
              },
            },
          ],
        },
      }),
    }),
  },
  {
    probeKey: "review.stale_workflow_count",
    sourceId: "review.stale_workflows",
    category: "WORKER",
    fingerprintPrefix: "dashboard:review:stale_assignments",
    stableTitle: "Stale review workflows",
    unit: "workflows",
    affectedEntityType: "review_workflow",
    thresholdValue: STALE_REVIEW_HIGH_COUNT,
    criticalThresholdValue: STALE_REVIEW_HIGH_COUNT * 3,
    baseSeverity: "WARNING",
    escalatedSeverity: "HIGH",
    escalationComparison: "GTE",
    runbookSlug: "reviewer-ops",
    describe: () =>
      `Assigned, in-review or needs-info review workflows have not been touched in ${STALE_REVIEW_HOURS}h or more. Source: EvidenceReviewWorkflow.updatedAt.`,
    count: async (ctx) => ({
      value: await ctx.client.evidenceReviewWorkflow.count({
        where: {
          // Scoped through the Evidence the workflow belongs to, NOT the
          // workflow's own nullable `team_id`, whose writer stores
          // `params.teamId ?? null`. The relation is `@unique`, so the
          // Evidence row IS the ownership authority here.
          evidence: ctx.evidenceWhere,
          status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          updatedAt: {
            lt: new Date(ctx.now.getTime() - STALE_REVIEW_HOURS * 60 * 60 * 1000),
          },
        },
      }),
    }),
  },
  {
    probeKey: "coordination.stale_backlog_count",
    sourceId: "coordination.backlog_stale",
    category: "GOVERNANCE",
    fingerprintPrefix: "dashboard:coordination:stale_backlog",
    stableTitle: "Coordination backlog",
    unit: "items",
    affectedEntityType: "comment",
    thresholdValue: COORDINATION_STALE_HIGH_COUNT,
    criticalThresholdValue: COORDINATION_STALE_HIGH_COUNT * 3,
    baseSeverity: "WARNING",
    escalatedSeverity: "HIGH",
    escalationComparison: "GTE",
    runbookSlug: "coordination-backlog",
    describe: () =>
      `Reviewer comments, annotations and case comments have been unresolved for more than ${COORDINATION_STALE_DAYS} days.`,
    count: async (ctx) => {
      const cutoff = new Date(ctx.now.getTime() - COORDINATION_STALE_DAYS * DAY_MS);
      // Each read is its own statement, and a failure of any one of them is a
      // failure of the OBSERVATION rather than a smaller number: a partial sum
      // presented as a total is precisely the false all-clear this closure
      // exists to remove. They therefore do NOT `.catch(() => 0)`.
      const [comments, annotations, caseComments] = await Promise.all([
        ctx.client.evidenceReviewerComment.count({
          where: {
            evidence: ctx.evidenceWhere,
            resolvedAtUtc: null,
            createdAt: { lt: cutoff },
          },
        }),
        ctx.client.evidenceAnnotation.count({
          where: {
            evidence: ctx.evidenceWhere,
            resolvedAtUtc: null,
            createdAt: { lt: cutoff },
          },
        }),
        // `CaseComment.team_id` is NOT NULL, so a strict predicate on THAT
        // model is complete and widening it would be a change with no defect
        // behind it.
        ctx.client.caseComment.count({
          where: {
            teamId: ctx.teamId,
            resolvedAtUtc: null,
            createdAt: { lt: cutoff },
          },
        }),
      ]);
      return { value: comments + annotations + caseComments };
    },
  },
  // OPS-001 / OPS-002 / OPS-009 — the retry-storm count, the per-workspace
  // telemetry age and the per-workspace worker heartbeat were REMOVED from
  // workspace discovery. The first counted re-observed conditions, the second
  // measured Home page visits, and the third duplicated one global fact into
  // every workspace. Worker and queue health are now PLATFORM conditions read
  // from their own authorities (platform-conditions.service.ts).
] as const;

const SPEC_BY_PROBE: ReadonlyMap<ActivityProbeKey, AggregateSpec> = new Map(
  AGGREGATE_SPECS.map((s) => [s.probeKey, s]),
);

/** The aggregate specs, in sweep order. Discovery iterates exactly these. */
export function aggregateSpecs(): readonly AggregateSpec[] {
  return AGGREGATE_SPECS;
}

export function aggregateSpecForProbe(
  probeKey: ActivityProbeKey,
): AggregateSpec | null {
  return SPEC_BY_PROBE.get(probeKey) ?? null;
}

/** `<prefix>:<teamId>` — the one place an aggregate fingerprint is built. */
export function aggregateFingerprint(
  spec: AggregateSpec,
  teamId: string,
): string {
  return `${spec.fingerprintPrefix}:${teamId}`;
}

/** The severity a value warrants, recomputed rather than remembered. */
export function severityForAggregate(
  spec: AggregateSpec,
  value: number,
): IncidentSeverity {
  if (spec.criticalThresholdValue == null) return spec.baseSeverity;
  const escalated =
    spec.escalationComparison === "GT"
      ? value > spec.criticalThresholdValue
      : value >= spec.criticalThresholdValue;
  return escalated ? spec.escalatedSeverity : spec.baseSeverity;
}

/**
 * OBSERVE ONE AGGREGATE SOURCE.
 *
 * The single count, and the single comparison against the single threshold.
 * ACTIVE at or above; RECOVERED below; UNKNOWN when the read gave way.
 */
export async function observeAggregate(
  spec: AggregateSpec,
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = {
    observedAtUtc: ctx.now,
    thresholdValue: spec.thresholdValue,
    criticalThresholdValue: spec.criticalThresholdValue,
    unit: spec.unit,
    affectedEntityType: spec.affectedEntityType,
  } as const;
  let counted: { value: number; truncated?: boolean };
  try {
    counted = await spec.count(ctx);
  } catch {
    // The source could not be READ. Not zero, not recovered, not active —
    // unknown, which is a state of its own and fails closed everywhere it is
    // consumed. The error itself is classified and reported by the caller,
    // which holds the workspace and request context this function does not.
    return { ...base, activity: "UNKNOWN" };
  }
  const active = counted.value >= spec.thresholdValue;
  return {
    ...base,
    activity: active ? "ACTIVE" : "RECOVERED",
    currentValue: counted.value,
    truncated: counted.truncated === true,
    severity: severityForAggregate(spec, counted.value),
  };
}

// ===========================================================================
// PER-RECORD SOURCES
// ===========================================================================

/**
 * Observe one evidence-integrity condition from its own record.
 *
 * The SAME column `resolveRecoveredConditions` reads. That is the point: if
 * the sweep would reopen a condition seconds after an operator closed it, the
 * close is refused up front instead of accepted and silently undone.
 *
 * A record that cannot be IDENTIFIED from the fingerprint, or that no longer
 * exists, is NOT_APPLICABLE and not UNKNOWN. The distinction is load-bearing:
 * a deleted record can never be observed active again, so refusing on it would
 * leave the condition permanently unclosable by anyone, which is a stuck queue
 * rather than a safer answer. A read that THREW is UNKNOWN, because the record
 * may well still be failing.
 */
async function observeIntegrity(
  ctx: ProbeContext,
  which: "tsa" | "ots",
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const integrity = await import("./evidence-integrity-conditions.service.js");
    // ET-REC-02 — the Worker's OTS bridge fingerprint (OTS:<id>:GLOBAL_BUDGET_EXHAUSTED)
    // names the same record's OTS failure; parsed here so it can resolve when
    // otsStatus leaves FAILED instead of being NOT_APPLICABLE forever.
    const budgetEvidenceId = which === "ots" ? parseOtsBudgetExhaustedFingerprint(ctx.fingerprint) : null;
    const parts = budgetEvidenceId
      ? { integrityClass: "ots_failure" as const, evidenceId: budgetEvidenceId }
      : integrity.parseIntegrityFingerprint(ctx.fingerprint);
    if (!parts) return { ...base, activity: "NOT_APPLICABLE" };
    // A subject id that cannot name a row is NOT_APPLICABLE, not UNKNOWN.
    if (!identifiableSubject(parts.evidenceId)) {
      return { ...base, activity: "NOT_APPLICABLE" };
    }
    if (
      (which === "tsa" && parts.integrityClass !== "tsa_failure") ||
      (which === "ots" && parts.integrityClass !== "ots_failure")
    ) {
      // The fingerprint names a different integrity class than the probe the
      // contract routed here. Not a state of the record — a routing fact —
      // and it must not resolve anything.
      return { ...base, activity: "UNKNOWN" };
    }
    const record = await ctx.client.evidence.findUnique({
      where: { id: parts.evidenceId },
      select: { tsaStatus: true, otsStatus: true },
    });
    if (!record) return { ...base, activity: "NOT_APPLICABLE" };
    return {
      ...base,
      activity: integrity.isCurrentlyFailing(record, parts.integrityClass)
        ? "ACTIVE"
        : "RECOVERED",
    };
  } catch {
    return { ...base, activity: "UNKNOWN" };
  }
}

/**
 * The subject id a per-record fingerprint names, or null.
 *
 * Every per-record fingerprint in the product is `<class>:<subjectId>` — the
 * integrity classes, the OTS budget bridge (`OTS:<id>:REASON`), the report
 * bridge (`REPORT:<id>:CLASS`), the package gate
 * (`worker_package_gate:<team>:<id>:OUTCOME`), the escalation engine
 * (`review-escalation:<reason>:<workflowId>`) and the IdP outage
 * (`idp-outage:<connectionId>`). Parsed here, once, rather than by five
 * probes each doing their own `split(":")`.
 */
function fingerprintSegment(fingerprint: string, index: number): string | null {
  const parts = fingerprint.split(":");
  const value = parts[index];
  return value && value.length > 0 ? value : null;
}

/**
 * CAN THIS STRING NAME A ROW AT ALL?
 *
 * Every per-record subject — Evidence, SsoConnection, EvidenceReviewWorkflow —
 * has a `uuid` primary key. A fingerprint segment that is not a UUID therefore
 * names NO row that could ever exist, and asking the database about it does not
 * return null: PostgreSQL rejects the comparison and Prisma throws.
 *
 * That distinction is the whole reason this guard exists. A throw would be
 * caught below and answered UNKNOWN — "we could not check" — which is the
 * fail-closed answer and, here, the WRONG one: nothing could ever check it,
 * because the subject is unidentifiable rather than unreachable. The honest
 * answer is NOT_APPLICABLE, and what that permits is then decided by the
 * source's own `notApplicableDisposition` instead of by a driver error.
 *
 * Getting this backwards leaves a condition nobody can ever close: the probe
 * would answer UNKNOWN on every future attempt, for the same reason, forever.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifiableSubject(value: string | null): string | null {
  if (!value) return null;
  return UUID_RE.test(value) ? value : null;
}

/**
 * IS THIS RECORD STILL AN AGED-PENDING OTS PROOF?
 *
 * Reads the record's own `otsStatus`, `otsAnchoredAtUtc` and `createdAt` and
 * hands them to the SHARED predicate — the same one the Worker uses to decide
 * it has spent the global anchoring budget. There is exactly one window in the
 * product, and this is a read of it.
 *
 * IT CONTACTS NOTHING. No calendar server, no TSA authority, no OTS provider.
 * Observing that a proof is aged does not retry it, re-anchor it or touch the
 * Evidence row; the only writes any caller makes from this answer are to
 * OperationalIncident and its satellites.
 */
async function observeOtsPendingAged(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const integrity = await import("./evidence-integrity-conditions.service.js");
    const evidenceId = identifiableSubject(
      integrity.parseOtsPendingAgedFingerprint(ctx.fingerprint),
    );
    if (!evidenceId) return { ...base, activity: "NOT_APPLICABLE" };
    const record = await ctx.client.evidence.findFirst({
      // RELIABILITY CLOSURE (2026-09-09) — bound to the workspace as well as
      // the id, matching every sibling probe in this file.
      //
      // This was a findUnique on the id alone. It was not a leak: the incident
      // whose fingerprint supplies the id is already tenant-scoped, so the row
      // it names is this workspace's row, and the observation returns an
      // activity enum rather than any of the columns it read. The defect was
      // that the safety rested entirely on that upstream fact.
      //
      // The rule this file states about itself is "a fingerprint is not an
      // authorization", and one probe here was trusting one. Binding the
      // predicate costs nothing and makes the rule true everywhere it is
      // claimed, so a future caller that reaches a probe by some other route
      // cannot turn an inconsistency into a leak.
      where: { AND: [{ id: evidenceId }, ctx.evidenceWhere] },
      select: { otsStatus: true, otsAnchoredAtUtc: true, createdAt: true },
    });
    // The record is gone, or is not this workspace's. It can never be observed
    // aged again, so it must stay closable rather than becoming a permanent row
    // nobody can clear.
    if (!record) return { ...base, activity: "NOT_APPLICABLE" };
    return {
      ...base,
      activity: isOtsPendingAged(record, ctx.now) ? "ACTIVE" : "RECOVERED",
    };
  } catch {
    return { ...base, activity: "UNKNOWN" };
  }
}


/**
 * HAS THIS RECORD STILL NOT ENTERED THE OTS LIFECYCLE?
 *
 * The recovery signal for `evidence_integrity.ots_initialization_stalled`, and
 * it is deliberately the weakest possible test: ANY OTS state at all resolves
 * the condition. PENDING resolves it because the record is now the aged-pending
 * condition's business; FAILED resolves it because it is now the ots_failure
 * condition's; ANCHORED and DISABLED resolve it because there is nothing left
 * to want. This source asks one question — did the handoff ever happen — and it
 * must stop asserting itself the moment the answer becomes yes, whatever the
 * answer leads to next.
 *
 * IT CONTACTS NOTHING. No calendar, no queue, no provider. Reading that a
 * record never started does not start it; the only writes any caller makes from
 * this answer are to OperationalIncident and its satellites.
 */
async function observeOtsInitializationStalled(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const integrity = await import("./evidence-integrity-conditions.service.js");
    const evidenceId = identifiableSubject(
      integrity.parseOtsInitializationStalledFingerprint(ctx.fingerprint),
    );
    if (!evidenceId) return { ...base, activity: "NOT_APPLICABLE" };
    const record = await ctx.client.evidence.findFirst({
      // Bound to the workspace as well as the id, matching
      // `observeEvidenceArtifact`: a fingerprint is not an authorization.
      where: { AND: [{ id: evidenceId }, ctx.evidenceWhere] },
      select: {
        otsStatus: true,
        otsProofBase64: true,
        fingerprintCanonicalJson: true,
        createdAt: true,
      },
    });
    // The record is gone, or is not this workspace's. It can never be observed
    // stalled again, so it must stay closable rather than becoming a permanent
    // row nobody can clear.
    if (!record) return { ...base, activity: "NOT_APPLICABLE" };
    return {
      ...base,
      activity: isOtsInitializationStalled(
        {
          otsStatus: record.otsStatus,
          otsProofBase64: record.otsProofBase64,
          fingerprintPresent: record.fingerprintCanonicalJson !== null,
          createdAt: record.createdAt,
        },
        ctx.now,
      )
        ? "ACTIVE"
        : "RECOVERED",
    };
  } catch {
    return { ...base, activity: "UNKNOWN" };
  }
}
/**
 * Does the record the condition names now HAVE the artifact it lacked?
 *
 * The recovery signal for the pipeline bridges.
 *
 * ---------------------------------------------------------------------------
 * EVIDENCE OUTPUT LIFECYCLE (2026-09-29) — TWO DEFECTS CLOSED
 * ---------------------------------------------------------------------------
 *   1. The package probe read fingerprint segment 2. For the package bridge's
 *      own shape, `PACKAGE:<evidenceId>:<class>`, segment 2 is the error
 *      class — never a UUID — so the probe always answered NOT_APPLICABLE,
 *      which made the condition operator-closable while the package was
 *      still missing.
 *   2. Both probes asked "is SOME artifact recorded?" — any
 *      `verificationPackageVersion`, any `latestReportVersion`. A record with
 *      report v7 and only package v2 answered RECOVERED for a missing package
 *      v7, and a failed package-only request filed under the REPORT source
 *      answered RECOVERED because the report existed.
 *
 * The probe now resolves the version the condition is ABOUT and asks whether
 * that artifact exists: a package at that report version, or — for a report
 * condition — that no report issuance is still failing after the latest
 * report.
 */
async function observeEvidenceArtifact(
  ctx: ProbeContext,
  which: "report" | "package",
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const parsed = parseArtifactFingerprint(ctx.fingerprint);
    const evidenceId = identifiableSubject(parsed?.evidenceId ?? null);
    if (!evidenceId || !parsed) return { ...base, activity: "NOT_APPLICABLE" };
    const record = await ctx.client.evidence.findFirst({
      // Bound to the workspace as well as the id: a fingerprint is not an
      // authorization, and a probe that read across tenants would be the one
      // place this closure could leak.
      where: { AND: [{ id: evidenceId }, ctx.evidenceWhere] },
      select: { id: true, latestReportVersion: true },
    });
    if (!record) return { ...base, activity: "NOT_APPLICABLE" };

    // A report-sourced condition whose error class is a PACKAGE failure (rows
    // written before the bridges were separated) is a package condition.
    const target =
      which === "package" || parsed.packageFailureClass ? "package" : "report";

    if (target === "package") {
      const version = parsed.reportVersion ?? record.latestReportVersion;
      if (version == null) return { ...base, activity: "ACTIVE" };
      const pkg = await ctx.client.verificationPackage.findFirst({
        where: primaryPublishedPackageWhere({ evidenceId, version }),
        select: { id: true },
      });
      return { ...base, activity: pkg ? "RECOVERED" : "ACTIVE" };
    }

    if (record.latestReportVersion == null) return { ...base, activity: "ACTIVE" };
    // A report exists. The condition is still active if a REPORT issuance
    // created after that report is live or failed — the failure was about a
    // version that does not exist yet.
    const latestReport = await ctx.client.report.findFirst({
      where: { evidenceId, version: record.latestReportVersion },
      select: { generatedAtUtc: true },
    });
    const pending = await ctx.client.reportGenerationRequest.findFirst({
      where: {
        evidenceId,
        artifactType: "REPORT",
        stage: { not: "REPORT_COMMITTED" },
        state: { in: ["QUEUED", "PROCESSING", "FAILED_RETRYABLE", "FAILED_TERMINAL"] },
        ...(latestReport ? { createdAtUtc: { gt: latestReport.generatedAtUtc } } : {}),
      },
      select: { id: true },
    });
    return { ...base, activity: pending ? "ACTIVE" : "RECOVERED" };
  } catch {
    return { ...base, activity: "UNKNOWN" };
  }
}

/**
 * The record and, when the writer recorded it, the report version a pipeline
 * fingerprint is about. Pure; exported for tests.
 */
/**
 * THE EXACT COMPONENT A REPORT/PACKAGE CONDITION NAMES (2026-09-29) — what an
 * operator inspects and what recovery must target. Read from the condition's
 * own fingerprint; when the row also names a record (`relatedEvidenceId`) the
 * two must agree, or there is no target. Null for any other source.
 */
export function incidentRecordTarget(incident: {
  sourceId: string | null;
  fingerprint: string;
  relatedEvidenceId: string | null;
}): { component: "REPORT" | "VERIFICATION_PACKAGE"; evidenceId: string; reportVersion: number | null } | null {
  if (
    incident.sourceId !== "pipeline.report_generation_failed" &&
    incident.sourceId !== "pipeline.package_generation_failed"
  ) {
    return null;
  }
  const parsed = parseArtifactFingerprint(incident.fingerprint);
  if (!parsed?.evidenceId || !/^[0-9a-f-]{36}$/i.test(parsed.evidenceId)) return null;
  if (incident.relatedEvidenceId && incident.relatedEvidenceId !== parsed.evidenceId) return null;
  return {
    component: parsed.packageFailureClass ? "VERIFICATION_PACKAGE" : "REPORT",
    evidenceId: parsed.evidenceId,
    reportVersion: parsed.reportVersion,
  };
}

export function parseArtifactFingerprint(fingerprint: string): {
  evidenceId: string | null;
  reportVersion: number | null;
  /** True when the error class names a package-only failure. */
  packageFailureClass: boolean;
} | null {
  const parts = fingerprint.split(":");
  const head = parts[0] ?? "";
  if (head === "worker_package_gate") {
    return { evidenceId: parts[2] ?? null, reportVersion: null, packageFailureClass: true };
  }
  if (head === "PACKAGE") {
    const versionSegment = parts[2] ?? "";
    const match = /^v(\d{1,7})$/.exec(versionSegment);
    return {
      evidenceId: parts[1] ?? null,
      reportVersion: match ? Number(match[1]) : null,
      packageFailureClass: true,
    };
  }
  if (head === "REPORT") {
    const cls = (parts[2] ?? "").toUpperCase();
    return {
      evidenceId: parts[1] ?? null,
      reportVersion: null,
      packageFailureClass:
        cls.startsWith("VERIFICATION_PACKAGE_INCOMPLETE") ||
        cls === "VERIFICATION_PACKAGE_STORAGE_REJECTED",
    };
  }
  return null;
}

/**
 * IS THE PACKAGE DENIAL STILL IN FORCE? (OPS-018)
 *
 * `worker_package_gate:<teamId>:<evidenceId>:<outcome>` names one record. The
 * denial is over when the record has a published package at its current
 * report version, or when the canonical eligibility decision — the same
 * `canonicalEvaluatePackageEligibility` the worker's gate runs, read through
 * the governance snapshot — no longer denies it. A read; it builds nothing.
 */
async function observePackageEligibility(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const parsed = parseArtifactFingerprint(ctx.fingerprint);
    const evidenceId = identifiableSubject(parsed?.evidenceId ?? null);
    if (!evidenceId) return { ...base, activity: "NOT_APPLICABLE" };
    const record = await ctx.client.evidence.findFirst({
      where: { AND: [{ id: evidenceId }, ctx.evidenceWhere] },
      select: { id: true, teamId: true, latestReportVersion: true },
    });
    if (!record) return { ...base, activity: "NOT_APPLICABLE" };
    if (record.latestReportVersion != null) {
      const pkg = await ctx.client.verificationPackage.findFirst({
        where: primaryPublishedPackageWhere({ evidenceId, version: record.latestReportVersion }),
        select: { id: true },
      });
      if (pkg) return { ...base, activity: "RECOVERED" };
    }
    if (!record.teamId) return { ...base, activity: "ACTIVE" };
    const { buildGovernanceSnapshot } = await import(
      "../governance-lifecycle/governance-snapshot.service.js"
    );
    const snapshot = await buildGovernanceSnapshot(
      { teamId: record.teamId, evidenceId },
      ctx.client as never,
    );
    return { ...base, activity: snapshot.package.eligible ? "RECOVERED" : "ACTIVE" };
  } catch {
    // UNKNOWN, never RECOVERED: an unreadable governance state is exactly the
    // case the gate fails closed on.
    return { ...base, activity: "UNKNOWN" };
  }
}

/**
 * IS THIS IDENTITY PROVIDER STILL IN OUTAGE?
 *
 * `SsoConnection.outageDetectedAtUtc` is stamped when consecutive callback
 * failures cross the threshold and cleared back to NULL by `noteSsoSuccess` on
 * the first successful callback. That is a genuine canonical recovery signal,
 * and the fingerprint names the connection, so the probe is bound to exactly
 * the subject the condition is about.
 */
async function observeIdpOutage(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const connectionId = identifiableSubject(
      fingerprintSegment(ctx.fingerprint, 1),
    );
    if (!connectionId) return { ...base, activity: "NOT_APPLICABLE" };
    const row = await ctx.client.ssoConnection.findFirst({
      // Workspace-bound: the connection must belong to the workspace whose
      // operator is asking.
      where: { id: connectionId, teamId: ctx.teamId },
      select: { outageDetectedAtUtc: true },
    });
    if (!row) return { ...base, activity: "NOT_APPLICABLE" };
    return {
      ...base,
      activity: row.outageDetectedAtUtc != null ? "ACTIVE" : "RECOVERED",
    };
  } catch {
    return { ...base, activity: "UNKNOWN" };
  }
}

/**
 * IS THE REVIEW ESCALATION STILL OPEN? (OPS-018)
 *
 * `review-escalation:<reason>:<workflowId>` names one escalation reason on one
 * workflow. The escalation's OWN row is the authority: the condition is over
 * when no escalation for that (workflow, reason) remains in a non-terminal
 * status (`REVIEW_ESCALATION_TERMINAL`: RESOLVED, SUPPRESSED), or when the
 * workflow itself has closed. The old probe read only the workflow and called
 * three statuses "open" — so a workflow still ESCALATED, QUEUED or REOPENED
 * read as recovered and its escalation closed while it was still escalated.
 */
const TERMINAL_REVIEW_WORKFLOW_STATUSES = ["CLOSED", "APPROVED_INTERNAL"] as const;

async function observeReviewWorkflowOpen(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const reason = fingerprintSegment(ctx.fingerprint, 1);
    const workflowId = identifiableSubject(
      fingerprintSegment(ctx.fingerprint, 2),
    );
    if (!workflowId || !reason) return { ...base, activity: "NOT_APPLICABLE" };
    const row = await ctx.client.evidenceReviewWorkflow.findFirst({
      // Scoped through the Evidence the workflow belongs to, NOT the
      // workflow's own nullable `team_id` — the same authority the stale-review
      // count uses, for the same reason.
      where: { id: workflowId, evidence: ctx.evidenceWhere },
      select: { status: true },
    });
    if (!row) return { ...base, activity: "NOT_APPLICABLE" };
    if ((TERMINAL_REVIEW_WORKFLOW_STATUSES as readonly string[]).includes(row.status)) {
      return { ...base, activity: "RECOVERED" };
    }
    const openEscalation = await ctx.client.reviewEscalation.findFirst({
      where: {
        workflowId,
        reason,
        status: { notIn: [...REVIEW_ESCALATION_TERMINAL] },
      },
      select: { id: true },
    });
    return { ...base, activity: openEscalation ? "ACTIVE" : "RECOVERED" };
  } catch {
    return { ...base, activity: "UNKNOWN" };
  }
}

/**
 * IS THE IMMUTABLE-STORAGE DRIFT THIS CONDITION NAMES STILL THERE?
 *
 * ---------------------------------------------------------------------------
 * THE AUTHORITY, AND WHY IT IS SAFE TO READ
 * ---------------------------------------------------------------------------
 * `immutable_storage_checks` is APPEND-ONLY and is written by the
 * reconciliation worker on every record it examines, drift or not. Each row
 * carries the team, the evidence, the verdict and the instant. The newest row
 * for one record is therefore a durable statement of what the comparison last
 * found — and reading it is a SELECT.
 *
 * THIS PROBE MAKES NO STORAGE CALL. No head-object, no bucket read, no
 * provider contact, no retention or legal-hold write. It cannot re-run the
 * comparison and does not try; it reads the verdict the reconciler already
 * recorded. An operator who believes the drift is fixed runs the reconciler,
 * and the next sweep closes the condition from that verdict.
 *
 * ---------------------------------------------------------------------------
 * THE FINGERPRINT NAMES A SPECIFIC DRIFT
 * ---------------------------------------------------------------------------
 * `immutable_storage_drift:<OUTCOME>:<evidenceId>` — the outcome is part of
 * the identity, so MISSING_LOCK and RETENTION_MISMATCH on one record are two
 * conditions with two lifecycles. The probe answers about the one it was
 * asked: a newest verdict of some OTHER drift class means the named drift is
 * no longer what the reconciler sees, and the new class has its own condition,
 * opened by the same sweep that recorded the verdict.
 *
 * ---------------------------------------------------------------------------
 * EVERY UNCERTAIN ANSWER FAILS CLOSED
 * ---------------------------------------------------------------------------
 * No check row at all, a probe the storage layer could not answer
 * (STORAGE_UNAVAILABLE), or a read that threw are all UNKNOWN — "we could not
 * check" — and UNKNOWN refuses a manual resolution and resolves nothing. Only
 * a record that no longer exists in the workspace is NOT_APPLICABLE, because a
 * record that is gone can never be observed again and refusing forever would
 * leave a row nobody could ever clear.
 */
const IMMUTABLE_DRIFT_OUTCOMES: readonly string[] = [
  "MISSING_LOCK",
  "RETENTION_MISMATCH",
  "LEGAL_HOLD_MISMATCH",
  "COMPLIANCE_MODE_MISMATCH",
];

/**
 * IS THE STORAGE ADD-ON STILL OWED A CANCELLATION?
 *
 * `billing_dependent_cancellation:<addonId>` names one add-on, and the add-on's
 * own `dependentCancellationState` is the answer. That column reaches
 * CONFIRMED only when a provider CALL succeeded or a provider OBSERVATION
 * proved the cancellation — never because a person decided it had, which is
 * exactly why this condition is SOURCE_TRUTH.
 *
 * A read, never a provider contact: probing must not make a payment API call.
 * The condition is about money leaving a customer's account, so a probe that
 * could itself fail would make the condition look recovered when the provider
 * was merely unreachable.
 */
async function observeDependentCancellation(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const addonId = identifiableSubject(fingerprintSegment(ctx.fingerprint, 1));
    if (!addonId) return { ...base, activity: "NOT_APPLICABLE" };

    // Workspace-bound: the add-on must belong to the workspace whose operator
    // is asking. OPS-003 — a PERSONAL add-on carries `teamId: null` (that is
    // what makes it personal) and is attributed to its owner's Personal Space,
    // exactly as the writer attributes it. The old strict `teamId` equality
    // never matched one, so every personal condition read NOT_APPLICABLE —
    // which turned "may still be charging" into a permitted manual close and
    // meant provider truth could never close it either.
    const personalOwner = await ctx.client.team.findFirst({
      where: { id: ctx.teamId, isPersonal: true },
      select: { ownerUserId: true },
    });
    const row = await ctx.client.workspaceStorageAddon.findFirst({
      where: {
        id: addonId,
        OR: [
          { teamId: ctx.teamId },
          ...(personalOwner ? [{ teamId: null, ownerUserId: personalOwner.ownerUserId }] : []),
        ],
      },
      select: { dependentCancellationState: true },
    });
    if (!row) return { ...base, activity: "NOT_APPLICABLE" };

    const resolved =
      row.dependentCancellationState === "CONFIRMED" ||
      row.dependentCancellationState === "NONE";
    return { ...base, activity: resolved ? "RECOVERED" : "ACTIVE" };
  } catch {
    // UNKNOWN, never RECOVERED. A failed read must not close a condition that
    // is costing the customer money.
    return { ...base, activity: "UNKNOWN" };
  }
}

async function observeImmutableDrift(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    // `immutable_storage_drift:<OUTCOME>:<evidenceId>`
    const namedOutcome = fingerprintSegment(ctx.fingerprint, 1);
    const evidenceId = identifiableSubject(
      fingerprintSegment(ctx.fingerprint, 2),
    );
    if (!evidenceId || !namedOutcome) {
      return { ...base, activity: "NOT_APPLICABLE" };
    }
    // The record must still exist AND belong to this workspace. A fingerprint
    // is not an authorization.
    const record = await ctx.client.evidence.findFirst({
      where: { AND: [{ id: evidenceId }, ctx.evidenceWhere] },
      select: { id: true },
    });
    if (!record) return { ...base, activity: "NOT_APPLICABLE" };

    const latest = await ctx.client.immutableStorageCheck.findFirst({
      where: { evidenceId, teamId: ctx.teamId },
      orderBy: [{ checkedAtUtc: "desc" }, { id: "desc" }],
      select: { outcome: true },
    });
    // The record exists and the reconciler has never reached it — or its rows
    // are gone. Nothing has been observed, so nothing is proven either way.
    if (!latest) return { ...base, activity: "UNKNOWN" };

    const outcome = String(latest.outcome);
    if (outcome === "OK") return { ...base, activity: "RECOVERED" };
    if (outcome === namedOutcome) return { ...base, activity: "ACTIVE" };
    if (IMMUTABLE_DRIFT_OUTCOMES.includes(outcome)) {
      // A DIFFERENT drift class is what the reconciler now sees. The one this
      // condition names is no longer current, and the new one is carried by
      // its own condition rather than by quietly redefining this row.
      return { ...base, activity: "RECOVERED" };
    }
    // STORAGE_UNAVAILABLE, EVIDENCE_NOT_FOUND, or a verdict this build does
    // not know. The comparison did not complete, so it proved nothing.
    return { ...base, activity: "UNKNOWN" };
  } catch {
    return { ...base, activity: "UNKNOWN" };
  }
}

/**
 * IS THIS WORKSPACE'S SEARCH INDEX ACTUALLY UNHEALTHY?
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROBE USED TO READ, AND WHY IT WAS UNSAFE
 * ---------------------------------------------------------------------------
 * The newest terminal `GovernanceReconciliationRun` for the workspace:
 * FAILED or PARTIAL meant ACTIVE, SUCCEEDED meant RECOVERED.
 *
 * SUCCEEDED does not mean the index is healthy. The reconciliation scheduler
 * converges by ENQUEUEING — it finds the drifted rows, schedules a rebuild for
 * each under a deterministic job id, and returns — so the run row closes
 * SUCCEEDED within milliseconds while the index is still empty. The authority
 * that owns those runs documents exactly this, and a purpose-built readiness
 * derivation exists BECAUSE of it.
 *
 * So the old probe auto-resolved an open indexing condition while thousands of
 * rebuilds sat in the queue: a false all-clear produced by the one source that
 * exists to report the opposite. It also under-reported in the other
 * direction — persistent drift with every run succeeding never opened at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT READS NOW
 * ---------------------------------------------------------------------------
 * `deriveSearchReadiness`, through the extracted fact collector: eligible
 * records against indexed records, the removal backlog, the durable run row
 * with its LEASE evaluated, and the queue's own job state for the outstanding
 * records. The rule is not reimplemented here and the facts are not gathered
 * twice — the diagnostics endpoint an operator reads consumes the same module.
 *
 * Every uncertain state answers UNKNOWN, including the two that look like
 * progress: INITIALIZING and PARTIAL mean work is genuinely in flight, which
 * is neither health nor failure, and reading either as recovery is the defect
 * being removed. See `classifySearchReadiness` for the full mapping.
 */
async function observeSearchIndexHealth(
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const base = { observedAtUtc: ctx.now } as const;
  try {
    const health = await import("../search/search-health.service.js");
    const readiness = await health.resolveWorkspaceSearchReadiness(
      // TENANT-BOUND. Every query inside the collector is keyed on this id in
      // its own WHERE clause; there is no widening arm and no post-read filter.
      { teamId: ctx.teamId, now: ctx.now },
      ctx.client,
    );
    switch (health.classifySearchReadiness(readiness.state)) {
      case "HEALTHY":
        return { ...base, activity: "RECOVERED" };
      case "FAILING":
        return { ...base, activity: "ACTIVE" };
      default:
        return { ...base, activity: "UNKNOWN" };
    }
  } catch {
    // The facts could not be read. Not healthy, not failing — unknown, which
    // refuses a manual resolution and resolves nothing.
    return { ...base, activity: "UNKNOWN" };
  }
}

// ===========================================================================
// THE EXHAUSTIVE PROBE MAP
// ===========================================================================

/**
 * One handler per declared probe key.
 *
 * `Record<ActivityProbeKey, ...>` is what makes this exhaustive: adding a key
 * to the union in the lifecycle contract does not compile until a handler
 * exists here, and a source cannot declare SOURCE_TRUTH with a probe key the
 * union does not contain.
 *
 * The map holds IMPLEMENTATIONS and no policy. None of these handlers knows
 * what its answer will be used for.
 */
const PROBE_HANDLERS: Readonly<
  Record<ActivityProbeKey, (ctx: ProbeContext) => Promise<SourceObservation>>
> = Object.freeze({
  // The explicit "this source has no probe" handler. It answers UNKNOWN, and
  // the shared authority is what decides that a source with no probe is never
  // asked in the first place — OPERATOR_DECISION returns before probing and
  // NO_DIRECT_RESOLUTION refuses before probing.
  NONE: async (ctx) => ({ activity: "UNKNOWN", observedAtUtc: ctx.now }),

  "evidence.tsa_status": (ctx) => observeIntegrity(ctx, "tsa"),
  "evidence.ots_status": (ctx) => observeIntegrity(ctx, "ots"),
  // NO LONGER A CLAIM WITH NOTHING BEHIND IT. Discovery opens these now, and
  // this reads the SAME shared window the Worker uses to give up anchoring.
  "evidence.ots_pending_aged": (ctx) => observeOtsPendingAged(ctx),

  // `ots_initialization_stalled:<evidenceId>` — resolved by ANY OTS state.
  "evidence.ots_initialization_stalled": (ctx) =>
    observeOtsInitializationStalled(ctx),

  // `REPORT:<evidenceId>:<errorClass>`, `PACKAGE:<evidenceId>:v<N>:<class>`,
  // legacy `PACKAGE:<evidenceId>:<class>` and
  // `worker_package_gate:<team>:<evidenceId>:<outcome>` — the artifact the
  // failed job did not produce, AT THE VERSION IT WAS FOR, either exists now or
  // does not. See `parseArtifactFingerprint`.
  "evidence.report_present": (ctx) => observeEvidenceArtifact(ctx, "report"),
  "evidence.package_present": (ctx) => observeEvidenceArtifact(ctx, "package"),
  // `worker_package_gate:<team>:<evidenceId>:<outcome>` — a package now, or
  // the canonical eligibility decision no longer denying the record.
  "evidence.package_eligibility": (ctx) => observePackageEligibility(ctx),

  // `idp-outage:<connectionId>` — cleared to NULL by the first success.
  "identity.idp_outage_state": (ctx) => observeIdpOutage(ctx),

  // `review-escalation:<reason>:<workflowId>` — the workflow's own status.
  "review.workflow_open": (ctx) => observeReviewWorkflowOpen(ctx),

  // `immutable_storage_drift:<OUTCOME>:<evidenceId>` — the newest append-only
  // reconciliation verdict for that record. A read, never a storage call.
  // `billing_dependent_cancellation:<addonId>` — the add-on's own obligation
  // state, which only provider truth moves to CONFIRMED.
  "billing.dependent_cancellation_state": (ctx) =>
    observeDependentCancellation(ctx),

  "storage.immutable_reconciliation_state": (ctx) => observeImmutableDrift(ctx),

  // The CANONICAL search-readiness derivation — eligible vs indexed, the
  // removal backlog, the run row's lease, and the queue's own job state. Never
  // a reconciliation run's exit status on its own.
  "search.index_health": (ctx) => observeSearchIndexHealth(ctx),

  "pipeline.report_backlog_count": (ctx) =>
    observeAggregateByKey("pipeline.report_backlog_count", ctx),
  "pipeline.package_backlog_count": (ctx) =>
    observeAggregateByKey("pipeline.package_backlog_count", ctx),
  "pipeline.signed_without_report_aged_count": (ctx) =>
    observeAggregateByKey("pipeline.signed_without_report_aged_count", ctx),
  "review.stale_workflow_count": (ctx) =>
    observeAggregateByKey("review.stale_workflow_count", ctx),
  "coordination.stale_backlog_count": (ctx) =>
    observeAggregateByKey("coordination.stale_backlog_count", ctx),
  // PLATFORM probes. They read the canonical platform authorities — the
  // worker-fleet liveness verdict and the queue inventory — and ignore the
  // workspace in the context, because the facts they answer have none.
  "platform.worker_heartbeat_age": (ctx) => observeWorkerFleetHeartbeat(ctx.now),
  "platform.queue_recent_failures": (ctx) =>
    observeQueueRecentFailures(queueNameFromPlatformFingerprint(ctx.fingerprint), ctx.now),
});

async function observeAggregateByKey(
  probeKey: ActivityProbeKey,
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const spec = aggregateSpecForProbe(probeKey);
  if (!spec) return { activity: "UNKNOWN", observedAtUtc: ctx.now };
  return observeAggregate(spec, ctx);
}

/**
 * ASK A SOURCE WHAT IT SAYS RIGHT NOW.
 *
 * The one entry point. Every caller — discovery, the resolve path, the
 * recovery sweep, the metric projection — comes through here, so there is
 * exactly one predicate per source in the product.
 */
export async function probeSource(
  probeKey: ActivityProbeKey,
  ctx: ProbeContext,
): Promise<SourceObservation> {
  const handler = PROBE_HANDLERS[probeKey];
  if (!handler) return { activity: "UNKNOWN", observedAtUtc: ctx.now };
  try {
    return await handler(ctx);
  } catch {
    return { activity: "UNKNOWN", observedAtUtc: ctx.now };
  }
}

/** Every probe key that has a handler. For the closure gate. */
export function implementedProbeKeys(): ActivityProbeKey[] {
  return Object.keys(PROBE_HANDLERS) as ActivityProbeKey[];
}

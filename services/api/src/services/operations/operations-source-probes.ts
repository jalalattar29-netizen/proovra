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

import type { PrismaClient, Prisma } from "@prisma/client";

import type { IncidentCategory, IncidentSeverity } from "@proovra/shared";
import {
  workspaceEvidenceWhere,
  type ActivityProbeKey,
  type ConditionMetricUnit,
  type SourceActivity,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { workspaceIncidentWhere } from "../observability/incident-scope.js";

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
export const RETRY_STORM_OCCURRENCE_THRESHOLD = 5;
export const TELEMETRY_STALE_MINUTES = 30;
export const WORKER_HEARTBEAT_STALE_MINUTES = 15;
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
};

/** Build a probe context, resolving the canonical evidence scope once. */
export async function buildProbeContext(input: {
  teamId: string;
  fingerprint: string;
  client?: PrismaClient;
  now?: Date;
  evidenceWhere?: Prisma.EvidenceWhereInput;
}): Promise<ProbeContext> {
  const client = input.client ?? defaultPrisma;
  return {
    teamId: input.teamId,
    fingerprint: input.fingerprint,
    client,
    now: input.now ?? new Date(),
    evidenceWhere:
      input.evidenceWhere ?? (await workspaceEvidenceWhere(input.teamId, client)),
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
      `Signed evidence records in this workspace have no generated report. Source: Evidence(status=SIGNED, latestReportVersion=null). HIGH at ${REPORT_BACKLOG_HIGH}, CRITICAL at ${REPORT_BACKLOG_CRITICAL}.`,
    count: async (ctx) => ({
      value: await ctx.client.evidence.count({
        where: {
          AND: [ctx.evidenceWhere, { status: "SIGNED", latestReportVersion: null }],
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
      `Reported evidence records in this workspace have no verification package. Source: Evidence(status=REPORTED, verificationPackageVersion=null). HIGH at ${PACKAGE_BACKLOG_HIGH}, CRITICAL at ${PACKAGE_BACKLOG_CRITICAL}.`,
    count: async (ctx) => ({
      value: await ctx.client.evidence.count({
        where: {
          AND: [
            ctx.evidenceWhere,
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
  {
    probeKey: "queue.retry_storm_count",
    sourceId: "queue.retry_storm",
    category: "WORKER",
    fingerprintPrefix: "dashboard:reliability:retry_storms",
    stableTitle: "Queue retry storm",
    unit: "conditions",
    affectedEntityType: "operational_condition",
    // One re-firing condition is already the storm; three is the escalation.
    thresholdValue: 1,
    criticalThresholdValue: 3,
    baseSeverity: "WARNING",
    escalatedSeverity: "HIGH",
    escalationComparison: "GTE",
    runbookSlug: "retry-storm",
    describe: () =>
      `Active conditions in this workspace are recurring with occurrenceCount >= ${RETRY_STORM_OCCURRENCE_THRESHOLD}. Source: OperationalIncident.occurrenceCount.`,
    count: async (ctx) => ({
      value: await ctx.client.operationalIncident.count({
        where: {
          // The scope discriminator AND the workspace id. A retry storm in a
          // DELETED workspace must not count toward this one's threshold —
          // deleting a workspace rewrites its incidents' team_id to NULL.
          ...workspaceIncidentWhere(ctx.teamId),
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          occurrenceCount: { gte: RETRY_STORM_OCCURRENCE_THRESHOLD },
          // The storm condition must not count ITSELF. Without this a storm
          // that re-fires five times keeps its own threshold met forever and
          // can never recover, which is a condition that is true because it
          // exists.
          NOT: { fingerprint: { startsWith: "dashboard:reliability:retry_storms:" } },
        },
      }),
    }),
  },
  {
    probeKey: "platform.telemetry_age",
    sourceId: "platform.telemetry_stale",
    category: "WORKER",
    fingerprintPrefix: "dashboard:telemetry:queue_stale",
    stableTitle: "Queue telemetry sampler delayed",
    unit: "minutes",
    affectedEntityType: null,
    thresholdValue: TELEMETRY_STALE_MINUTES,
    criticalThresholdValue: TELEMETRY_STALE_MINUTES * 4,
    baseSeverity: "WARNING",
    escalatedSeverity: "HIGH",
    escalationComparison: "GT",
    runbookSlug: "telemetry-sampler",
    describe: () =>
      `The most recent queue telemetry snapshot for this workspace is older than the ${TELEMETRY_STALE_MINUTES}-minute window. The worker remains operational; the sampler may be delayed or paused.`,
    count: async (ctx) => {
      const recent = await ctx.client.queueTelemetrySnapshot.findFirst({
        where: { teamId: ctx.teamId },
        orderBy: { sampledAtUtc: "desc" },
        select: { sampledAtUtc: true },
      });
      // NO ROWS IS NOT STALENESS. A workspace the sampler has never written
      // for has no age to measure, and reporting zero here would make an
      // absent sampler read as a perfectly fresh one.
      if (!recent) return { value: 0 };
      return {
        value: Math.max(
          0,
          Math.round((ctx.now.getTime() - recent.sampledAtUtc.getTime()) / 60_000),
        ),
      };
    },
  },
  {
    probeKey: "platform.worker_heartbeat_age",
    sourceId: "platform.worker_heartbeat_stale",
    category: "WORKER",
    fingerprintPrefix: "dashboard:worker:heartbeat_stale",
    stableTitle: "Worker heartbeat stale",
    unit: "minutes",
    affectedEntityType: null,
    thresholdValue: WORKER_HEARTBEAT_STALE_MINUTES,
    criticalThresholdValue: WORKER_HEARTBEAT_STALE_MINUTES * 4,
    baseSeverity: "HIGH",
    escalatedSeverity: "CRITICAL",
    escalationComparison: "GT",
    runbookSlug: "worker-heartbeat",
    describe: () =>
      `The last persisted worker heartbeat is older than the ${WORKER_HEARTBEAT_STALE_MINUTES}-minute window. The worker process or its database connection may be down.`,
    count: async (ctx) => {
      const recent = await ctx.client.workerTelemetrySnapshot.findFirst({
        where: { workerKind: "WORKER" },
        orderBy: { heartbeatAtUtc: "desc" },
        select: { heartbeatAtUtc: true },
      });
      if (!recent) return { value: 0 };
      return {
        value: Math.max(
          0,
          Math.round((ctx.now.getTime() - recent.heartbeatAtUtc.getTime()) / 60_000),
        ),
      };
    },
  },
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
    const parts = integrity.parseIntegrityFingerprint(ctx.fingerprint);
    if (!parts) return { ...base, activity: "NOT_APPLICABLE" };
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
  // The pending-aged source is registered and currently writes no conditions,
  // so nothing routes here today. It reads the same column its failed sibling
  // does, which is what the contract claims, so the claim is not empty.
  "evidence.ots_pending_age": (ctx) => observeIntegrity(ctx, "ots"),

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
  "queue.retry_storm_count": (ctx) =>
    observeAggregateByKey("queue.retry_storm_count", ctx),
  "platform.telemetry_age": (ctx) =>
    observeAggregateByKey("platform.telemetry_age", ctx),
  "platform.worker_heartbeat_age": (ctx) =>
    observeAggregateByKey("platform.worker_heartbeat_age", ctx),
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

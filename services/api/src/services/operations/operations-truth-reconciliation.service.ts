/**
 * OPERATIONS TRUTH — EXISTING-DATA RECONCILIATION (OPS-001..OPS-036, section 21).
 *
 * The code fixes change what is written from now on. Rows written BEFORE them
 * still say what the old code said: a "telemetry sampler" condition measured
 * from page visits, a "retry storm" counted from re-observations, one worker
 * heartbeat copy per workspace, hourly provider-auth rows, a 403 recorded as a
 * security condition, a Personal record's failure stranded as LEGACY_UNSCOPED,
 * a raw error message as a summary, and resolutions the old predicates granted
 * too early. This module brings those rows in line — and nothing else.
 *
 * WHAT IT IS NOT. It is not a second resolver and holds no domain rule of its
 * own: a condition is closed as recovered only when the canonical probe
 * (`probeConditionActivity` / `sweepSourceTruthRecoveries`) says so; a
 * re-opening follows the shared `decideObservationTransition`; a re-scope
 * uses the canonical `resolveEvidenceWorkspaceId`. Retired and superseded rows
 * are closed with a resolution note saying exactly why.
 *
 * SAFETY. Dry-run by default (reads only, bounded counts — never payloads).
 * Every rule is bounded and pages by id; `truncated` says a rerun is needed.
 * Every rule acts only on rows in the state it repairs, so a rerun finds
 * nothing to do. History is never deleted: every change appends an event.
 * A row that cannot be repaired without provider access is marked
 * `requires_owner_review` (an event), never falsely resolved.
 *
 * Never run this against Production from a development machine. The owner
 * runs it, in the documented order, after the release is deployed.
 */

import * as prismaPkg from "@prisma/client";
import { stampConditionMessage } from "@proovra/shared";
import {
  decideObservationTransition,
  decisionIsReopen,
  lifecycleForSourceId,
  REOPENED_EVENT,
  resolveEvidenceWorkspaceId,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { probeConditionActivity } from "../observability/incident.service.js";
import { classifySecurityEvent } from "../security/security-event.service.js";
import {
  closeRecoveredConditions,
  probeRecoverablePerRecordSourceIds,
} from "./source-truth-recovery.service.js";

type PrismaClient = prismaPkg.PrismaClient;
const S = prismaPkg.IncidentStatus;
const UNRESOLVED = [S.OPEN, S.ACKNOWLEDGED, S.SUPPRESSED];

export const RECONCILIATION_RULES = [
  "retired_false_signals",
  "workspace_heartbeat_copies",
  "provider_auth_superseded_rows",
  "routine_authorization_refusals",
  "legacy_unscoped_rescope",
  "raw_pipeline_messages",
  "source_truth_recovery",
  "premature_recoveries_reopened",
  "billing_owner_review",
  // OPS-13 Phase 3.
  "reclassified_security_signals",
  "stale_idp_outages",
  "retired_unreachable_signals",
  "disabled_immutable_drift",
  "critical_held_conditions_report",
  // 2026-10-14 — the stale upload_stalled bridge row.
  "legacy_upload_stalled_rows",
] as const;
export type ReconciliationRule = (typeof RECONCILIATION_RULES)[number];

export type RuleCounts = {
  /** Rows the rule examined. */
  matched: number;
  /** Rows the rule changed (apply) or would change (dry-run). */
  changed: number;
  /** Rows that cannot be repaired here and were (or would be) flagged. */
  requiresOwnerReview: number;
  /** The bound was reached; rerun to continue. */
  truncated: boolean;
  /** Bounded per-rule breakdown (counts only, never payloads). */
  detail?: Record<string, number>;
};

export type ReconciliationReport = {
  mode: "dry-run" | "apply";
  limitPerRule: number;
  /** The bounded scope this run was restricted to, if any. */
  scope: { teamId: string | null; sourceId: string | null; rules: ReconciliationRule[] | null };
  rules: Record<ReconciliationRule, RuleCounts>;
};

export const REQUIRES_OWNER_REVIEW_EVENT = "requires_owner_review";
const RECONCILED_EVENT = "resolved_by_reconciliation";

const RETIRED_SOURCES = ["queue.retry_storm", "platform.telemetry_stale"];
const RETIRED_PREFIXES = ["dashboard:reliability:retry_storms:", "dashboard:telemetry:queue_stale:"];
const PIPELINE_FAILURE_SOURCES = ["pipeline.report_generation_failed", "pipeline.package_generation_failed"];
const RECORD_BOUND_SOURCES = [
  ...PIPELINE_FAILURE_SOURCES,
  "pipeline.package_generation_denied",
  "evidence_integrity.ots_budget_exhausted",
];
/** Sources whose old predicates could resolve too early (OPS-004 / OPS-019). */
const PREMATURE_RECOVERY_SOURCES = [
  "pipeline.report_generation_failed",
  "evidence_integrity.tsa_failed",
  "evidence_integrity.ots_failed",
];
const CLOSED_CLASS = /^[A-Z][A-Z0-9_]{2,63}$/;
// The fixed safe sentences, from the shared catalogue so the repaired row
// carries the code its words were rendered from (and renders in every locale).
function safeTextFor(code: "ops.pipeline.report_generation_failed.sanitized" | "ops.pipeline.package_generation_failed.sanitized") {
  const stamped = stampConditionMessage({ code, params: {} })!;
  return { code, title: stamped.title, safeSummary: stamped.summary };
}
const SAFE_REPORT_TEXT = safeTextFor("ops.pipeline.report_generation_failed.sanitized");
const SAFE_PACKAGE_TEXT = safeTextFor("ops.pipeline.package_generation_failed.sanitized");

function emptyCounts(): RuleCounts {
  return { matched: 0, changed: 0, requiresOwnerReview: 0, truncated: false };
}

/**
 * Close one unresolved row with a stated reason. History is appended, never
 * rewritten.
 *
 * Every row this is called for is one its source no longer reports — the
 * source was retired, superseded by the one platform condition, or the event
 * was reclassified as routine — so the decision is the SAME shared one a
 * recovered source takes (`SOURCE_RECOVERED`), not a second rule. The write is
 * a compare-and-set on the status read, so a concurrent transition wins.
 */
async function closeWithNote(
  client: PrismaClient,
  row: { id: string },
  note: string,
  now: Date,
  rule?: ReconciliationRule,
): Promise<boolean> {
  const current = await client.operationalIncident.findUnique({ where: { id: row.id }, select: { status: true } });
  if (!current) return false;
  const decision = decideObservationTransition({
    currentStatus: current.status as "OPEN" | "ACKNOWLEDGED" | "SUPPRESSED" | "RESOLVED",
    observation: "SOURCE_RECOVERED",
  });
  if (decision !== "AUTO_RESOLVE_SOURCE_RECOVERY") return false;
  const closed = await client.operationalIncident.updateMany({
    where: { id: row.id, status: current.status },
    data: { status: S.RESOLVED, resolvedAtUtc: now, resolvedByUserId: null, resolutionNote: note },
  });
  if (closed.count === 0) return false;
  await client.operationalIncidentEvent.create({
    data: {
      incidentId: row.id,
      eventType: RECONCILED_EVENT,
      safeMessage: note,
      ...(rule
        ? {
            metadataJson: {
              rule,
              previousStatus: current.status,
            } as prismaPkg.Prisma.InputJsonValue,
          }
        : {}),
    },
  });
  try {
    const { closeSlaCycle } = await import("./incident-sla-cycle.service.js");
    await closeSlaCycle({ incidentId: row.id, reason: "RESOLVED" }, client);
  } catch {
    /* the cycle close is bookkeeping; the resolution stands */
  }
  return true;
}

/** Flag a row for the owner, once: a rerun does not stack the same flag. */
async function flagForOwnerReview(
  client: PrismaClient,
  row: { id: string },
  reason: string,
): Promise<boolean> {
  const latest = await client.operationalIncidentEvent.findFirst({
    where: { incidentId: row.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { eventType: true },
  });
  if (latest?.eventType === REQUIRES_OWNER_REVIEW_EVENT) return false;
  await client.operationalIncidentEvent.create({
    data: { incidentId: row.id, eventType: REQUIRES_OWNER_REVIEW_EVENT, safeMessage: reason },
  });
  return true;
}

/** Page through rows matching `where`, bounded, by id. */
async function pageRows<T extends { id: string }>(
  fetchPage: (afterId: string | null, take: number) => Promise<T[]>,
  limit: number,
  visit: (row: T) => Promise<void>,
): Promise<{ seen: number; truncated: boolean }> {
  let afterId: string | null = null;
  let seen = 0;
  while (seen < limit) {
    const page = await fetchPage(afterId, Math.min(200, limit - seen + 1));
    if (page.length === 0) return { seen, truncated: false };
    for (const row of page) {
      if (seen >= limit) return { seen, truncated: true };
      await visit(row);
      seen += 1;
      afterId = row.id;
    }
    if (page.length < Math.min(200, limit - seen + 1)) return { seen, truncated: false };
  }
  return { seen, truncated: true };
}

const byId = (afterId: string | null) => (afterId ? { id: { gt: afterId } } : {});

/**
 * The sources each rule acts on. A `--source` bound runs only the rules whose
 * set contains it (and narrows multi-source rules to it); `null` means the
 * rule reads across sources by state rather than by source.
 */
const RULE_SOURCES: Readonly<Record<ReconciliationRule, readonly string[] | null>> = {
  retired_false_signals: RETIRED_SOURCES,
  workspace_heartbeat_copies: ["platform.worker_heartbeat_stale"],
  provider_auth_superseded_rows: ["billing.provider_authorization"],
  routine_authorization_refusals: ["identity.security_condition"],
  legacy_unscoped_rescope: RECORD_BOUND_SOURCES,
  raw_pipeline_messages: PIPELINE_FAILURE_SOURCES,
  source_truth_recovery: null,
  premature_recoveries_reopened: PREMATURE_RECOVERY_SOURCES,
  billing_owner_review: ["billing.dependent_cancellation_failed"],
  reclassified_security_signals: ["security.unclassified_signal"],
  stale_idp_outages: ["identity.idp_outage"],
  retired_unreachable_signals: ["pipeline.signed_without_report_aged"],
  disabled_immutable_drift: ["storage.immutable_drift"],
  critical_held_conditions_report: null,
  legacy_upload_stalled_rows: ["intake.delivery_failed"],
};

/** Rules whose rows carry no workspace: a `--team` bound cannot select them. */
const TEAMLESS_RULES: ReadonlySet<ReconciliationRule> = new Set([
  "provider_auth_superseded_rows",
  "legacy_unscoped_rescope",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECURITY_EVENT_MARKER = ":security_event:";
const REAL_DRIFT_OUTCOMES = [
  "MISSING_LOCK",
  "RETENTION_MISMATCH",
  "LEGAL_HOLD_MISMATCH",
  "COMPLIANCE_MODE_MISMATCH",
] as const;

export async function reconcileOperationsTruth(
  input: {
    apply: boolean;
    limitPerRule?: number;
    now?: Date;
    /** Bound every rule to one workspace. */
    teamId?: string | null;
    /** Bound to the rules (and rows) of one source. */
    sourceId?: string | null;
    /** Run only these rules. */
    rules?: readonly ReconciliationRule[] | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ReconciliationReport> {
  const apply = input.apply;
  const limit = Math.max(1, Math.min(input.limitPerRule ?? 1000, 10_000));
  // The time of THIS reconciliation. Every resolution it writes is stamped
  // with it — never a back-dated guess at when the condition "really" ended.
  const now = input.now ?? new Date();
  const rules = Object.fromEntries(RECONCILIATION_RULES.map((r) => [r, emptyCounts()])) as Record<
    ReconciliationRule,
    RuleCounts
  >;
  const tw = input.teamId ? { teamId: input.teamId } : {};
  const runs = (rule: ReconciliationRule): boolean => {
    if (input.rules && input.rules.length > 0 && !input.rules.includes(rule)) return false;
    if (input.teamId && TEAMLESS_RULES.has(rule)) return false;
    const sources = RULE_SOURCES[rule];
    if (input.sourceId && sources !== null && !sources.includes(input.sourceId)) return false;
    return true;
  };
  /** Narrow a rule's source set to the `--source` bound, when one is given. */
  const pick = (sources: readonly string[]): string[] =>
    input.sourceId ? sources.filter((x) => x === input.sourceId) : [...sources];
  const scope = {
    teamId: input.teamId ?? null,
    sourceId: input.sourceId ?? null,
    rules: input.rules && input.rules.length > 0 ? [...input.rules] : null,
  };

  // ---- OPS-001 / OPS-002 — retired false signals --------------------------
  if (runs("retired_false_signals")) {
    const c = rules.retired_false_signals;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            OR: [
              { sourceId: { in: pick(RETIRED_SOURCES) } },
              ...(input.sourceId ? [] : RETIRED_PREFIXES.map((p) => ({ sourceId: null, fingerprint: { startsWith: p } }))),
            ],
            ...byId(afterId),
            ...tw,
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        c.changed += 1;
        if (apply) {
          await closeWithNote(
            client,
            row,
            "Closed by the Operations truth reconciliation: this source was a false signal (it measured page visits or re-observed conditions, not workers or job retries) and has been retired.",
            now,
          );
        }
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-009 — per-workspace copies of the global heartbeat --------------
  if (runs("workspace_heartbeat_copies")) {
    const c = rules.workspace_heartbeat_copies;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            OR: [
              { fingerprint: { startsWith: "dashboard:worker:heartbeat_stale:" } },
              { sourceId: "platform.worker_heartbeat_stale", teamId: { not: null } },
            ],
            ...byId(afterId),
            ...tw,
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        c.changed += 1;
        if (apply) {
          await closeWithNote(
            client,
            row,
            "Closed by the Operations truth reconciliation: worker liveness is one platform condition now, not one copy per workspace.",
            now,
          );
        }
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-027 — provider-auth rows the stable platform condition replaced -
  if (runs("provider_auth_superseded_rows")) {
    const c = rules.provider_auth_superseded_rows;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            sourceId: "billing.provider_authorization",
            NOT: { fingerprint: { startsWith: "billing-provider-auth:" } },
            ...byId(afterId),
            ...tw,
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        c.changed += 1;
        if (apply) {
          await closeWithNote(
            client,
            row,
            "Closed by the Operations truth reconciliation: superseded by the one stable platform condition per payment provider.",
            now,
          );
        }
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-014 — expected 403s recorded as security conditions --------------
  if (runs("routine_authorization_refusals")) {
    const c = rules.routine_authorization_refusals;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            fingerprint: { endsWith: ":security_event:permission_denied" },
            ...byId(afterId),
            ...tw,
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        c.changed += 1;
        if (apply) {
          await closeWithNote(
            client,
            row,
            "Closed by the Operations truth reconciliation: an expected authorization refusal is recorded in the security log, not as a condition.",
            now,
          );
        }
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-015 — Personal record failures stranded as LEGACY_UNSCOPED -------
  if (runs("legacy_unscoped_rescope")) {
    const c = rules.legacy_unscoped_rescope;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            scope: prismaPkg.IncidentScope.LEGACY_UNSCOPED,
            teamId: null,
            relatedEvidenceId: { not: null },
            sourceId: { in: pick(RECORD_BOUND_SOURCES) },
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, fingerprint: true, relatedEvidenceId: true, status: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        const evidence = await client.evidence.findUnique({
          where: { id: row.relatedEvidenceId! },
          select: { teamId: true, ownerUserId: true },
        });
        const workspaceId = evidence ? await resolveEvidenceWorkspaceId(evidence, client) : null;
        if (!workspaceId) {
          // Ownership cannot be proven: never reassigned on a guess.
          c.requiresOwnerReview += 1;
          if (apply) {
            await flagForOwnerReview(
              client,
              row,
              "The Operations truth reconciliation could not prove which workspace owns this record's condition, so it was left unscoped for review.",
            );
          }
          return;
        }
        const existing = await client.operationalIncident.findFirst({
          where: { teamId: workspaceId, fingerprint: row.fingerprint },
          select: { id: true },
        });
        c.changed += 1;
        if (!apply) return;
        if (existing) {
          // The workspace already holds this condition: the legacy copy is a
          // duplicate. It is closed, pointing at the canonical row.
          if (UNRESOLVED.includes(row.status as never)) {
            await closeWithNote(
              client,
              row,
              `Closed by the Operations truth reconciliation: consolidated into condition ${existing.id} in the record's own workspace.`,
              now,
            );
          }
          return;
        }
        await client.operationalIncident.update({
          where: { id: row.id },
          data: { teamId: workspaceId, scope: prismaPkg.IncidentScope.WORKSPACE },
        });
        await client.operationalIncidentEvent.create({
          data: {
            incidentId: row.id,
            eventType: "rescoped_by_reconciliation",
            safeMessage: "Moved by the Operations truth reconciliation into the record owner's own workspace.",
          },
        });
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-016 — raw error text in pipeline identities and summaries --------
  if (runs("raw_pipeline_messages")) {
    const c = rules.raw_pipeline_messages;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            sourceId: { in: pick(PIPELINE_FAILURE_SOURCES) },
            teamId: { not: null },
            ...byId(afterId),
            ...tw,
          },
          select: {
            id: true,
            teamId: true,
            fingerprint: true,
            relatedEvidenceId: true,
            sourceId: true,
            lastSeenAtUtc: true,
            title: true,
            safeSummary: true,
          },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        const parts = row.fingerprint.split(":");
        const versioned = /^v\d+$/.test(parts[2] ?? "");
        const cls = versioned ? (parts[3] ?? "") : (parts[2] ?? "");
        if (CLOSED_CLASS.test(cls)) return;
        const report = row.sourceId === "pipeline.report_generation_failed";
        const safe = report ? SAFE_REPORT_TEXT : SAFE_PACKAGE_TEXT;
        // Already repaired by an earlier pass: nothing to do (idempotent).
        if (row.title === safe.title && row.safeSummary === safe.safeSummary) return;
        c.matched += 1;
        c.changed += 1;
        if (!apply) return;
        // A newer condition for the same record and source supersedes this
        // raw-identity duplicate; otherwise its words are replaced by the
        // fixed sentence and its identity is kept (history stays attached).
        const newer = await client.operationalIncident.findFirst({
          where: {
            teamId: row.teamId,
            sourceId: row.sourceId,
            relatedEvidenceId: row.relatedEvidenceId,
            status: { in: UNRESOLVED },
            id: { not: row.id },
            lastSeenAtUtc: { gte: row.lastSeenAtUtc },
          },
          select: { id: true },
        });
        if (newer) {
          await closeWithNote(
            client,
            row,
            `Closed by the Operations truth reconciliation: a duplicate created only by changing error text; condition ${newer.id} is the record's current one.`,
            now,
          );
          return;
        }
        await client.operationalIncident.update({
          where: { id: row.id },
          data: {
            title: safe.title,
            safeSummary: safe.safeSummary,
            messageCode: safe.code,
            messageParams: {},
          },
        });
        await client.operationalIncidentEvent.create({
          data: {
            incidentId: row.id,
            eventType: "summary_sanitized_by_reconciliation",
            safeMessage: "The condition's text was replaced by its safe description by the Operations truth reconciliation.",
          },
        });
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-003 / OPS-018 / OPS-019 — close what the canonical probe proves --
  //
  // OPS-13 — the dry run used to probe at most 200 rows per (workspace,
  // source) group, so a workspace with more open rows than that reported
  // fewer recoveries than existed; and apply delegated to the sweep, whose
  // continuation is process-local. Rows are now keyset-paged by id across the
  // whole bounded scope. Dry run reports, per source, how many open rows the
  // canonical probe says RECOVERED; apply closes exactly those through the
  // SAME close path the sweep uses (`closeRecoveredConditions`), which
  // re-probes, compare-and-sets on status, writes `resolved_by_domain_truth`
  // and closes the SLA cycle.
  if (runs("source_truth_recovery")) {
    const c = rules.source_truth_recovery;
    const detail: Record<string, number> = {};
    const sources = pick(probeRecoverablePerRecordSourceIds());
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            sourceId: { in: sources },
            teamId: { not: null },
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, status: true, sourceId: true, category: true, fingerprint: true, teamId: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        if (!row.sourceId || !row.teamId) return;
        c.matched += 1;
        detail[`${row.sourceId}:open`] = (detail[`${row.sourceId}:open`] ?? 0) + 1;
        const activity = await probeConditionActivity(
          { sourceId: row.sourceId, category: row.category, fingerprint: row.fingerprint, teamId: row.teamId },
          client,
        );
        if (activity !== "RECOVERED") return;
        detail[`${row.sourceId}:recovered`] = (detail[`${row.sourceId}:recovered`] ?? 0) + 1;
        if (!apply) {
          c.changed += 1;
          return;
        }
        const lifecycle = lifecycleForSourceId(row.sourceId);
        if (!lifecycle) return;
        const teamId = row.teamId;
        const closed = await closeRecoveredConditions([row], {
          lifecycle,
          sourceId: row.sourceId,
          now,
          client,
          workspaceFor: async () => teamId,
        });
        c.changed += closed;
      },
    );
    c.truncated = r.truncated;
    c.detail = detail;
  }

  // ---- OPS-004 / OPS-019 — resolutions the old predicates granted too early -
  if (runs("premature_recoveries_reopened")) {
    const c = rules.premature_recoveries_reopened;
    const since = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: S.RESOLVED,
            resolvedByUserId: null,
            resolvedAtUtc: { gte: since },
            sourceId: { in: pick(PREMATURE_RECOVERY_SOURCES) },
            teamId: { not: null },
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, sourceId: true, category: true, fingerprint: true, teamId: true, severity: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        const activity = await probeConditionActivity(
          { sourceId: row.sourceId, category: row.category, fingerprint: row.fingerprint, teamId: row.teamId! },
          client,
        );
        if (activity !== "ACTIVE") return;
        const decision = decideObservationTransition({
          currentStatus: "RESOLVED",
          observation: "SOURCE_ACTIVE",
          previousResolutionOrigin: "SOURCE_RECOVERY",
        });
        if (!decisionIsReopen(decision)) return;
        c.changed += 1;
        if (!apply) return;
        await client.operationalIncident.update({
          where: { id: row.id },
          data: { status: S.OPEN, resolvedAtUtc: null, resolvedByUserId: null, resolutionNote: null },
        });
        await client.operationalIncidentEvent.create({
          data: {
            incidentId: row.id,
            eventType: REOPENED_EVENT,
            safeMessage:
              "Reopened by the Operations truth reconciliation: the source still reports this condition, so the earlier automatic resolution was premature.",
          },
        });
        try {
          const { openSlaCycle } = await import("./incident-sla-cycle.service.js");
          await openSlaCycle(
            { teamId: row.teamId!, incidentId: row.id, severity: row.severity, startedAtUtc: now },
            client,
          );
        } catch {
          /* bookkeeping */
        }
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-003 — billing rows that cannot be repaired without the provider --
  if (runs("billing_owner_review")) {
    const c = rules.billing_owner_review;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            sourceId: "billing.dependent_cancellation_failed",
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, fingerprint: true, teamId: true, sourceId: true, category: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        const addonId = row.fingerprint.split(":")[1] ?? "";
        const addon = /^[0-9a-f-]{36}$/i.test(addonId)
          ? await client.workspaceStorageAddon.findUnique({ where: { id: addonId }, select: { id: true } })
          : null;
        const activity = row.teamId
          ? await probeConditionActivity(
              { sourceId: row.sourceId, category: row.category, fingerprint: row.fingerprint, teamId: row.teamId },
              client,
            )
          : "UNKNOWN";
        // Gone, or unreadable: only the provider could say the charge stopped.
        if (addon && activity !== "UNKNOWN") return;
        c.requiresOwnerReview += 1;
        if (apply) {
          const flagged = await flagForOwnerReview(
            client,
            row,
            "The add-on behind this billing condition can no longer be read, so whether the charge stopped cannot be proven without the payment provider. Left open for the owner to review.",
          );
          if (flagged) c.changed += 1;
        }
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-13 — unclassified security rows whose event type is now classified
  //
  // `security.unclassified_signal` was the bridge's default: one row per
  // (workspace, event type), NO_DIRECT_RESOLUTION, closable by nobody. Every
  // event type that reaches the bridge is now classified explicitly; a row
  // whose type is routine, dedicated or owned by a real source describes no
  // operational condition and is closed with a note saying so. A row whose
  // type is STILL unrecognised is left exactly as it is (the source is
  // retired and platform-internal, so it is off every tenant surface).
  //
  // A row that a DENIED workspace switch from a non-member wrote into the
  // workspace that was asked for is named as such: the outsider's refusal was
  // never that workspace's condition at all.
  if (runs("reclassified_security_signals")) {
    const c = rules.reclassified_security_signals;
    const detail: Record<string, number> = {};
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            OR: [
              { sourceId: "security.unclassified_signal" },
              { sourceId: null, fingerprint: { startsWith: "worker:security_event:" } },
            ],
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, fingerprint: true, teamId: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        const at = row.fingerprint.lastIndexOf(SECURITY_EVENT_MARKER);
        const eventType = at >= 0 ? row.fingerprint.slice(at + SECURITY_EVENT_MARKER.length) : "";
        const disposition = classifySecurityEvent(eventType);
        if (!eventType || disposition.kind === "UNCLASSIFIED") {
          detail.stillUnclassified = (detail.stillUnclassified ?? 0) + 1;
          return;
        }
        const deniedOutsiderSwitch =
          eventType === "workspace_context_switched" && row.teamId
            ? await wasWrittenByOutsiderDeniedSwitch(client, row.teamId)
            : false;
        if (deniedOutsiderSwitch) detail.deniedOutsiderSwitch = (detail.deniedOutsiderSwitch ?? 0) + 1;
        c.changed += 1;
        if (!apply) return;
        const owner =
          disposition.kind === "ROUTINE"
            ? "it is a routine security-log event, not an operational condition"
            : `its condition is now recorded by the dedicated source ${
                disposition.kind === "DEDICATED" ? disposition.sourceId : disposition.classification.sourceId
              }`;
        const note = deniedOutsiderSwitch
          ? "Closed by the Operations truth reconciliation: this row was created when an account that is not a member of this workspace was REFUSED a switch into it. A refused switch is recorded in the security log of the account that asked; it was never this workspace's operational condition."
          : `Closed by the Operations truth reconciliation: the security event type "${eventType.slice(0, 80)}" was reclassified — ${owner}.`;
        await closeWithNote(client, row, note, now, "reclassified_security_signals");
      },
    );
    c.truncated = r.truncated;
    c.detail = detail;
  }

  // ---- OPS-13 — IdP outage rows for connections taken out of sign-in -------
  //
  // An outage is cleared only by a successful callback, and a revoked or
  // disabled connection never receives one — so its outage row could never
  // close. The condition's subject no longer participates in sign-in (the
  // probe now answers NOT_APPLICABLE, and the source allows closing such a
  // row). A connection that no longer exists at all is closed the same way.
  if (runs("stale_idp_outages")) {
    const c = rules.stale_idp_outages;
    const detail: Record<string, number> = {};
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            teamId: { not: null },
            OR: [
              { sourceId: "identity.idp_outage" },
              { sourceId: null, fingerprint: { startsWith: "idp-outage:" } },
            ],
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, fingerprint: true, teamId: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        const connectionId = row.fingerprint.split(":")[1] ?? "";
        if (!UUID.test(connectionId) || !row.teamId) return;
        const connection = await client.ssoConnection.findFirst({
          where: { id: connectionId, teamId: row.teamId },
          select: { status: true },
        });
        const state = connection ? String(connection.status) : "GONE";
        if (state !== "REVOKED" && state !== "DISABLED" && state !== "GONE") return;
        detail[state] = (detail[state] ?? 0) + 1;
        c.changed += 1;
        if (!apply) return;
        const why =
          state === "GONE"
            ? "the SSO connection no longer exists"
            : `the SSO connection is ${state === "REVOKED" ? "revoked" : "disabled"}`;
        await closeWithNote(
          client,
          row,
          `Closed by the Operations truth reconciliation: ${why}, so it is no longer used for sign-in and its outage can never be observed or cleared.`,
          now,
          "stale_idp_outages",
        );
      },
    );
    c.truncated = r.truncated;
    c.detail = detail;
  }

  // ---- OPS-13 — the retired unreachable signal ------------------------------
  //
  // `pipeline.signed_without_report_aged` counted Evidence(status=UPLOADED),
  // a status no writer sets. Its rows are closed as RETIRED — never as
  // recovered — following the retired_false_signals pattern.
  if (runs("retired_unreachable_signals")) {
    const c = rules.retired_unreachable_signals;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            OR: [
              { sourceId: "pipeline.signed_without_report_aged" },
              { sourceId: null, fingerprint: { startsWith: "dashboard:integrity:unsigned_aged:" } },
            ],
            ...byId(afterId),
            ...tw,
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        c.changed += 1;
        if (apply) {
          await closeWithNote(
            client,
            row,
            "Closed by the Operations truth reconciliation: this source counted uploaded records with a status no part of the product sets, so it could never observe anything, and it has been retired. Signed records still waiting for a report are the report backlog.",
            now,
            "retired_unreachable_signals",
          );
        }
      },
    );
    c.truncated = r.truncated;
  }

  // ---- OPS-13 — drift rows from a reconciler that could not compare ---------
  //
  // `storage.immutable_drift` is DISABLED: production ran the reconciler with
  // no storage probe, so its checks were STORAGE_UNAVAILABLE. A row is closed
  // ONLY when the record's newest check is STORAGE_UNAVAILABLE and NO check
  // for it ever recorded a real drift outcome. Anything that ever observed
  // real drift, or that has no check at all, is left open.
  if (runs("disabled_immutable_drift")) {
    const c = rules.disabled_immutable_drift;
    const detail: Record<string, number> = {};
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            OR: [
              { sourceId: "storage.immutable_drift" },
              { sourceId: null, fingerprint: { startsWith: "immutable_storage_drift:" } },
            ],
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, fingerprint: true, teamId: true, relatedEvidenceId: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        const evidenceId = row.relatedEvidenceId ?? row.fingerprint.split(":")[2] ?? "";
        if (!UUID.test(evidenceId)) {
          detail.leftUnidentifiable = (detail.leftUnidentifiable ?? 0) + 1;
          return;
        }
        const scoped = row.teamId ? { evidenceId, teamId: row.teamId } : { evidenceId };
        const latest = await client.immutableStorageCheck.findFirst({
          where: scoped,
          orderBy: [{ checkedAtUtc: "desc" }, { id: "desc" }],
          select: { outcome: true },
        });
        const realDrift = await client.immutableStorageCheck.count({
          where: { ...scoped, outcome: { in: [...REAL_DRIFT_OUTCOMES] } },
        });
        if (!latest || String(latest.outcome) !== "STORAGE_UNAVAILABLE" || realDrift > 0) {
          detail.leftOpen = (detail.leftOpen ?? 0) + 1;
          return;
        }
        c.changed += 1;
        if (apply) {
          await closeWithNote(
            client,
            row,
            "Closed by the Operations truth reconciliation: the storage reconciler could not reach storage for this record (every check is STORAGE_UNAVAILABLE) and never observed a real drift. The source is disabled until its comparison matches the storage design.",
            now,
            "disabled_immutable_drift",
          );
        }
      },
    );
    c.truncated = r.truncated;
    c.detail = detail;
  }

  // ---- OPS-13 — acknowledged / suppressed CRITICAL rows: REPORT ONLY --------
  //
  // A CRITICAL condition someone acknowledged or suppressed while its source
  // still reports it is a projection question (how it is shown), not a data
  // repair. Nothing is mutated in either mode; the counts say how many there
  // are and how many the canonical probe still observes ACTIVE.
  if (runs("critical_held_conditions_report")) {
    const c = rules.critical_held_conditions_report;
    const detail: Record<string, number> = { sourceActive: 0, notProbeable: 0 };
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: [S.ACKNOWLEDGED, S.SUPPRESSED] },
            severity: prismaPkg.IncidentSeverity.CRITICAL,
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, sourceId: true, category: true, fingerprint: true, teamId: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        const lifecycle = lifecycleForSourceId(row.sourceId);
        if (!row.teamId || !lifecycle || lifecycle.resolutionAuthority !== "SOURCE_TRUTH") {
          detail.notProbeable += 1;
          return;
        }
        const activity = await probeConditionActivity(
          { sourceId: row.sourceId, category: row.category, fingerprint: row.fingerprint, teamId: row.teamId },
          client,
        );
        if (activity === "ACTIVE") detail.sourceActive += 1;
      },
    );
    c.truncated = r.truncated;
    c.detail = detail;
  }

  // ---- 2026-10-14 — the workspace-wide upload_stalled bridge row ------------
  //
  // `upload_stalled` used to be filed as ONE subject-less "Intake delivery
  // failed" condition per workspace, and the first production sweep filed it
  // for upload shadows behind records that had long finalized. The signal is
  // now its own per-upload source (`capture.upload_stalled`), written at the
  // stall and closed by its probe. The old row describes no upload, so it is
  // closed; its history stays. An upload that IS still stalled right now (a
  // live record in its upload phase, session STALLED) is carried over to its
  // own per-upload condition — once: an upload that already has one, open or
  // resolved, is left to it, so a person's resolution is never undone here.
  if (runs("legacy_upload_stalled_rows")) {
    const c = rules.legacy_upload_stalled_rows;
    const detail = { carriedOver: 0 };
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            fingerprint: { endsWith: `${SECURITY_EVENT_MARKER}upload_stalled` },
            ...byId(afterId),
            ...tw,
          },
          select: { id: true, teamId: true },
          orderBy: { id: "asc" },
          take,
        }),
      limit,
      async (row) => {
        c.matched += 1;
        c.changed += 1;
        if (!apply) return;
        if (row.teamId) {
          const stalled = await client.uploadSession.findMany({
            where: {
              teamId: row.teamId,
              status: "STALLED",
              evidence: { deletedAt: null, status: { in: ["CREATED", "UPLOADING", "UPLOADED"] } },
            },
            select: {
              evidenceId: true,
              stalledAtUtc: true,
              lastActivityAtUtc: true,
              evidence: { select: { title: true } },
            },
            orderBy: { evidenceId: "asc" },
            take: 500,
          });
          const { recordUploadStalledCondition } = await import("../reliability/upload-reconciliation.service.js");
          const { getStaleThresholds } = await import("../reliability/upload-limits.service.js");
          const { stalledMinutes } = getStaleThresholds();
          for (const s of stalled) {
            const existing = await client.operationalIncident.findFirst({
              where: { teamId: row.teamId, fingerprint: `upload_stalled:${s.evidenceId}` },
              select: { id: true },
            });
            if (existing) continue;
            await recordUploadStalledCondition(
              {
                teamId: row.teamId,
                evidenceId: s.evidenceId,
                recordTitle: s.evidence.title ?? null,
                minutes: stalledMinutes,
                previousStatus: "STALLED",
                stalledAtUtc: s.stalledAtUtc ?? s.lastActivityAtUtc,
              },
              client,
            );
            detail.carriedOver += 1;
          }
        }
        await closeWithNote(
          client,
          row,
          "Closed by the Operations truth reconciliation: this workspace-wide row named no upload. Stalled uploads are now reported one per upload as \"Upload appears stalled\"; any upload still stalled is listed there.",
          now,
          "legacy_upload_stalled_rows",
        );
      },
    );
    c.truncated = r.truncated;
    c.detail = detail;
  }

  return { mode: apply ? "apply" : "dry-run", limitPerRule: limit, scope, rules };
}

/**
 * Was a `workspace_context_switched` row in this workspace written by an
 * OUTSIDER's refused switch? Read from the security log the old emitter wrote
 * into the TARGET workspace: a refused switch whose actor holds no ACTIVE
 * membership here. Bounded to the newest 50 refusals.
 */
async function wasWrittenByOutsiderDeniedSwitch(
  client: PrismaClient,
  teamId: string,
): Promise<boolean> {
  const events = await client.securityEvent.findMany({
    where: { teamId, eventType: "workspace_context_switched", severity: "WARNING" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { details: true },
    take: 50,
  });
  for (const e of events) {
    const d =
      e.details && typeof e.details === "object" && !Array.isArray(e.details)
        ? (e.details as Record<string, unknown>)
        : null;
    if (!d || d.result !== "denied") continue;
    const actor = typeof d.actorUserId === "string" ? d.actorUserId : null;
    if (!actor || !UUID.test(actor)) continue;
    const membership = await client.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: actor } },
      select: { status: true },
    });
    if (!membership || membership.status !== "ACTIVE") return true;
  }
  return false;
}


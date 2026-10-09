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
import {
  decideObservationTransition,
  decisionIsReopen,
  REOPENED_EVENT,
  resolveEvidenceWorkspaceId,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { probeConditionActivity } from "../observability/incident.service.js";
import {
  probeRecoverablePerRecordSourceIds,
  sweepSourceTruthRecoveries,
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
};

export type ReconciliationReport = {
  mode: "dry-run" | "apply";
  limitPerRule: number;
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
const SAFE_REPORT_TEXT = {
  title: "Report generation failed",
  safeSummary:
    "This record's report could not be generated. The evidence is unaffected. An operator can recover it from Operations; the condition clears only when the report exists.",
};
const SAFE_PACKAGE_TEXT = {
  title: "Verification package generation failed",
  safeSummary:
    "This record's verification package could not be generated. The evidence and its report are unaffected. An operator can recover it from Operations; the condition clears only when the package exists.",
};

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
): Promise<void> {
  const current = await client.operationalIncident.findUnique({ where: { id: row.id }, select: { status: true } });
  if (!current) return;
  const decision = decideObservationTransition({
    currentStatus: current.status as "OPEN" | "ACKNOWLEDGED" | "SUPPRESSED" | "RESOLVED",
    observation: "SOURCE_RECOVERED",
  });
  if (decision !== "AUTO_RESOLVE_SOURCE_RECOVERY") return;
  const closed = await client.operationalIncident.updateMany({
    where: { id: row.id, status: current.status },
    data: { status: S.RESOLVED, resolvedAtUtc: now, resolvedByUserId: null, resolutionNote: note },
  });
  if (closed.count === 0) return;
  await client.operationalIncidentEvent.create({
    data: { incidentId: row.id, eventType: RECONCILED_EVENT, safeMessage: note },
  });
  try {
    const { closeSlaCycle } = await import("./incident-sla-cycle.service.js");
    await closeSlaCycle({ incidentId: row.id, reason: "RESOLVED" }, client);
  } catch {
    /* the cycle close is bookkeeping; the resolution stands */
  }
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

export async function reconcileOperationsTruth(
  input: { apply: boolean; limitPerRule?: number; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<ReconciliationReport> {
  const apply = input.apply;
  const limit = Math.max(1, Math.min(input.limitPerRule ?? 1000, 10_000));
  const now = input.now ?? new Date();
  const rules = Object.fromEntries(RECONCILIATION_RULES.map((r) => [r, emptyCounts()])) as Record<
    ReconciliationRule,
    RuleCounts
  >;

  // ---- OPS-001 / OPS-002 — retired false signals --------------------------
  {
    const c = rules.retired_false_signals;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            OR: [
              { sourceId: { in: RETIRED_SOURCES } },
              ...RETIRED_PREFIXES.map((p) => ({ sourceId: null, fingerprint: { startsWith: p } })),
            ],
            ...byId(afterId),
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
  {
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
  {
    const c = rules.provider_auth_superseded_rows;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            sourceId: "billing.provider_authorization",
            NOT: { fingerprint: { startsWith: "billing-provider-auth:" } },
            ...byId(afterId),
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
  {
    const c = rules.routine_authorization_refusals;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            fingerprint: { endsWith: ":security_event:permission_denied" },
            ...byId(afterId),
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
  {
    const c = rules.legacy_unscoped_rescope;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            scope: prismaPkg.IncidentScope.LEGACY_UNSCOPED,
            teamId: null,
            relatedEvidenceId: { not: null },
            sourceId: { in: RECORD_BOUND_SOURCES },
            ...byId(afterId),
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
  {
    const c = rules.raw_pipeline_messages;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            sourceId: { in: PIPELINE_FAILURE_SOURCES },
            teamId: { not: null },
            ...byId(afterId),
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
          data: { title: safe.title, safeSummary: safe.safeSummary },
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
  {
    const c = rules.source_truth_recovery;
    const sources = probeRecoverablePerRecordSourceIds();
    const groups = await client.operationalIncident.groupBy({
      by: ["teamId", "sourceId"],
      where: { status: { in: UNRESOLVED }, sourceId: { in: sources }, teamId: { not: null } },
      _count: { _all: true },
      orderBy: { teamId: "asc" },
      take: limit,
    });
    c.truncated = groups.length >= limit;
    for (const g of groups) {
      if (!g.teamId || !g.sourceId) continue;
      if (apply) {
        const sweep = await sweepSourceTruthRecoveries({ teamId: g.teamId, sourceId: g.sourceId, now }, client);
        c.matched += sweep.examined;
        c.changed += sweep.resolved;
        if (sweep.truncated) c.truncated = true;
      } else {
        const rows = await client.operationalIncident.findMany({
          where: { teamId: g.teamId, sourceId: g.sourceId, status: { in: UNRESOLVED } },
          select: { sourceId: true, category: true, fingerprint: true, teamId: true },
          take: 200,
        });
        for (const row of rows) {
          c.matched += 1;
          const activity = await probeConditionActivity(
            { sourceId: row.sourceId, category: row.category, fingerprint: row.fingerprint, teamId: row.teamId! },
            client,
          );
          if (activity === "RECOVERED") c.changed += 1;
        }
      }
    }
  }

  // ---- OPS-004 / OPS-019 — resolutions the old predicates granted too early -
  {
    const c = rules.premature_recoveries_reopened;
    const since = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: S.RESOLVED,
            resolvedByUserId: null,
            resolvedAtUtc: { gte: since },
            sourceId: { in: PREMATURE_RECOVERY_SOURCES },
            teamId: { not: null },
            ...byId(afterId),
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
  {
    const c = rules.billing_owner_review;
    const r = await pageRows(
      (afterId, take) =>
        client.operationalIncident.findMany({
          where: {
            status: { in: UNRESOLVED },
            sourceId: "billing.dependent_cancellation_failed",
            ...byId(afterId),
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

  return { mode: apply ? "apply" : "dry-run", limitPerRule: limit, rules };
}

/**
 * Workspace Operations reconciliation — the ONE entry point, and the readiness
 * contract that reads it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Operations discovery ran as a LAZY SIDE EFFECT of building the Home
 * dashboard: `buildCommandCenter` called `generateIncidentsForWorkspace` and
 * swallowed the result. Three consequences, all of them silent:
 *
 *   * A workspace nobody opened was never scanned. Its Operations page showed
 *     no conditions — not because there were none, but because nothing had
 *     ever looked. "Zero" and "unknown" rendered identically.
 *   * The scan was unbounded and unlocked. Two people opening Home at once ran
 *     two full discoveries over the same workspace concurrently.
 *   * A discovery that failed halfway left a PARTIAL set of conditions with no
 *     record that it had failed, so the next reader saw a smaller, confident
 *     number.
 *
 * The fix is not a new framework. `runGovernanceReconciliation` already
 * provides per-(kind, lock_key) exclusion enforced by a partial unique index,
 * a lease that frees a crashed sweep's slot, exception-safe terminal
 * transitions and append-only history. This module is the Operations-shaped
 * face of it — the same choice `search-index-reconciliation.ts` made, and for
 * the same reason: a second run table would be a second lock, and two locks
 * over one workspace exclude nothing.
 *
 * THE BODY IS A CALLBACK, DELIBERATELY
 * ------------------------------------
 * Discovery reads a dozen domain services that live in `services/api`. This
 * package cannot import them, and dragging them here to satisfy a scheduler
 * would be a far larger change than the defect warrants. So the LOCK, the
 * lease, the terminal states and the readiness projection live here — shared,
 * one authority — and the caller supplies the work. Any host that gains a
 * reason to start Operations discovery claims the SAME slot as every other,
 * which is the property that matters.
 */

import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import {
  RUN_LOCK_LEASE_MS,
  runGovernanceReconciliation,
  type ReconciliationLogger,
  type ReconciliationRunContext,
} from "./reconciliation-run.js";

/** The kind under which every Operations discovery run is recorded. */
export const WORKSPACE_OPERATIONS_RUN_KIND =
  prismaPkg.GovernanceReconciliationKind.WORKSPACE_OPERATIONS;

/**
 * The lock identity for one workspace's Operations discovery.
 *
 * Built here rather than at each call site so the scheduler, a page-triggered
 * ensure and an operator-triggered run cannot produce three different keys for
 * one workspace — which would be three locks and therefore no lock.
 */
export function workspaceOperationsLockKey(workspaceId: string): string {
  return `${WORKSPACE_OPERATIONS_RUN_KIND}:${workspaceId}`;
}

// ---------------------------------------------------------------------------
// §8 — the readiness vocabulary.
// ---------------------------------------------------------------------------

/**
 * What is currently known about a workspace's Operations discovery.
 *
 * Every state that is NOT `READY` is a state in which "workspace operations
 * are clear" may not be rendered. That is the whole point of the enum: the
 * absence of conditions is only meaningful when something recently looked for
 * them, succeeded, and covered every source.
 */
export type OperationsReadiness =
  /** No run has ever been recorded for this workspace. */
  | "NEVER_RUN"
  /** A run holds the lock and its lease has not expired. */
  | "RUNNING"
  /** Fresh, complete, every required source succeeded, nothing truncated. */
  | "READY"
  /** Finished, but at least one required source failed or was truncated. */
  | "PARTIAL"
  /** The newest terminal run is older than the freshness window. */
  | "STALE"
  /** The newest run ended FAILED. */
  | "FAILED"
  /** A RUNNING row whose lease has expired: the process that held it is gone. */
  | "STALLED";

/**
 * How old a completed run may be before the picture it produced stops counting
 * as current.
 *
 * Deliberately several times the scheduler's interval. A window tighter than
 * the cadence would mark a perfectly healthy workspace STALE in the gap
 * between two ticks, which trains operators to ignore the state that is
 * supposed to mean something.
 */
export const OPERATIONS_FRESHNESS_WINDOW_MS = 45 * 60 * 1000;

/**
 * The per-source accounting a run records.
 *
 * `required` is the set the workspace's picture DEPENDS on. A source that
 * failed or was truncated makes the picture incomplete no matter how many
 * others succeeded — which is why these are counted rather than summed into a
 * single boolean somebody can round off.
 */
export type OperationsSourceAccounting = {
  requiredSources: string[];
  attemptedSources: string[];
  successfulSources: string[];
  failedSources: string[];
  /** Sources that hit their scan bound. A bounded read is not a complete one. */
  truncatedSources: string[];
  /** True when the run handed follow-on work to a queue and did not finish it. */
  continuationScheduled: boolean;
  /**
   * Per-source outcomes. Exactly one entry per attempted source.
   *
   * The four id lists above are kept because they are already public and read
   * by shipped consumers; this is the field that carries the CAUSE.
   */
  outcomes: OperationsSourceOutcome[];
};

/**
 * WHERE a source stopped. Bounded, and deliberately a closed set: an operator
 * deciding what to do next needs to know which LAYER gave way, and a free-text
 * stage would carry provider wording into a tenant-visible payload.
 */
export type OperationsSourceStage =
  | "READ"
  | "CLASSIFY"
  | "PROJECT"
  | "DEDUPE"
  | "WRITE"
  | "ACCOUNTING"
  | "DEPENDENCY_UNAVAILABLE"
  | "TIMEOUT"
  | "UNKNOWN";

export const OPERATIONS_SOURCE_STAGES: readonly OperationsSourceStage[] =
  Object.freeze([
    "READ",
    "CLASSIFY",
    "PROJECT",
    "DEDUPE",
    "WRITE",
    "ACCOUNTING",
    "DEPENDENCY_UNAVAILABLE",
    "TIMEOUT",
    "UNKNOWN",
  ]);

/** Exactly one of these per ATTEMPTED source. */
export type OperationsSourceOutcomeName =
  | "SUCCEEDED"
  | "FAILED"
  | "TRUNCATED"
  | "NOT_APPLICABLE";

/**
 * One source's result, persisted on the run.
 *
 * THE DEFECT THIS CLOSES. The generator's per-source handler was
 * `} catch { failedSources.push(sourceId); }` — it recorded WHICH source gave
 * way and discarded WHY, so `safeFailureCategory` projected as null and a
 * production workspace could report PARTIAL with no way to learn the cause
 * from the outside. A workspace that cannot say why it is incomplete cannot be
 * repaired without a developer, which is the state this field removes.
 */
export type OperationsSourceOutcome = {
  sourceId: string;
  outcome: OperationsSourceOutcomeName;
  /** Present only on FAILED. */
  stage: OperationsSourceStage | null;
  /** Bounded category from `safeOperationsFailureCategory`. FAILED only. */
  category: string | null;
  /**
   * Whether re-running the sweep could plausibly succeed without an operator
   * changing something first. A missing column is NOT retryable — the next
   * hundred sweeps fail identically — and saying so stops an operator burning
   * an afternoon on a retry button.
   */
  retryable: boolean;
};

export function emptySourceAccounting(): OperationsSourceAccounting {
  return {
    requiredSources: [],
    attemptedSources: [],
    successfulSources: [],
    failedSources: [],
    truncatedSources: [],
    continuationScheduled: false,
    outcomes: [],
  };
}

/**
 * Where the accounting is persisted.
 *
 * A metadata key rather than columns: the run table is shared with the
 * governance families and Search, and six Operations-only columns on it would
 * be a schema change five other kinds must carry and none can use.
 */
export const OPERATIONS_RUN_SOURCES_METADATA_KEY = "operationsSources";

/**
 * Reduce an exception to a bounded category.
 *
 * The run row is read by operators and projected to the browser, so it must
 * never carry a stack, a SQL fragment, a connection string or record content.
 * The categories are coarse on purpose: they say what KIND of thing went
 * wrong, which is what a recovery decision needs.
 */
export function safeOperationsFailureCategory(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const m = message.toLowerCase();
  if (m.includes("timeout") || m.includes("etimedout")) return "timeout";
  if (m.includes("econnrefused") || m.includes("connection")) {
    return "database_unavailable";
  }
  if (m.includes("permission") || m.includes("denied")) return "permission_denied";
  if (m.includes("constraint") || m.includes("unique")) {
    return "constraint_violation";
  }
  if (m.includes("enum") || m.includes("column") || m.includes("relation")) {
    return "schema_mismatch";
  }
  if (m.includes("queue") || m.includes("redis")) return "queue_unavailable";
  return "unexpected_error";
}

// ---------------------------------------------------------------------------
// Running one workspace.
// ---------------------------------------------------------------------------

export type OperationsReconcileOutcome =
  /** This caller held the lock and the body ran. */
  | {
      kind: "ran";
      runId: string;
      recorded: number;
      sources: OperationsSourceAccounting;
    }
  /** Another caller holds the lock. Not an error — the work is in hand. */
  | { kind: "already_running"; runId: string | null }
  /** The body threw. The run row is FAILED with a bounded category. */
  | { kind: "failed"; runId: string; reason: string };

export type OperationsReconcileBodyResult = {
  /** Conditions opened or re-observed. Operator fact; decides no readiness. */
  recorded: number;
  sources: OperationsSourceAccounting;
};

export type OperationsReconcileInput = {
  workspaceId: string;
  /** Who or what asked. Bounded to 32 chars by the run authority. */
  trigger: "scheduler" | "startup" | "api" | "ensure" | "cli";
  triggeredByUserId?: string | null;
  body: (ctx: ReconciliationRunContext) => Promise<OperationsReconcileBodyResult>;
  log?: ReconciliationLogger;
};

/**
 * Run one workspace's Operations discovery under the durable lock.
 *
 * Contention is a NO-OP, not an error: if another caller holds the lock the
 * work is already in hand, and the honest answer to "please reconcile" is that
 * it is being reconciled.
 *
 * A run whose sources did not all succeed is recorded PARTIAL by the wrapper's
 * own `failed` counter, so the terminal state on the row already carries the
 * incompleteness. Readiness re-derives it from the persisted accounting rather
 * than trusting the status alone, because a run can be SUCCEEDED and still
 * have truncated a source.
 */
export async function reconcileWorkspaceOperationalConditions(
  client: PrismaClient,
  input: OperationsReconcileInput,
): Promise<OperationsReconcileOutcome> {
  const lockKey = workspaceOperationsLockKey(input.workspaceId);
  let sources: OperationsSourceAccounting = emptySourceAccounting();
  let recorded = 0;

  const result = await runGovernanceReconciliation<OperationsReconcileBodyResult>(
    client,
    {
      kind: WORKSPACE_OPERATIONS_RUN_KIND,
      trigger: input.trigger,
      teamId: input.workspaceId,
      triggeredByUserId: input.triggeredByUserId ?? null,
      lockKey,
      body: async (ctx) => {
        const bodyResult = await input.body(ctx);
        sources = bodyResult.sources;
        recorded = bodyResult.recorded;
        // Persist what the run actually did, so "completed having found
        // nothing" is a fact on the row rather than an inference from silence.
        ctx.reportProgress({
          scanned: bodyResult.sources.attemptedSources.length,
          created: bodyResult.recorded,
          // A failed source makes the wrapper record PARTIAL rather than
          // SUCCEEDED. That is the terminal state doing its job: a run that
          // could not see one of its sources did not produce a complete
          // picture, and the row must not claim it did.
          // ONLY the required failures decide the run's terminal status.
          //
          // The wrapper records PARTIAL when this is non-zero, and
          // `classifyOperationsReadiness` honours that status before it looks
          // at anything else — so counting an OPTIONAL source here would pin a
          // tenant workspace at PARTIAL for a platform sampler it does not own.
          // The optional failure is still in `failedSources` and still carries
          // its stage and cause in `outcomes`; it simply does not decide
          // whether the picture this workspace depends on is complete.
          failed: bodyResult.sources.failedSources.filter((id) =>
            bodyResult.sources.requiredSources.includes(id),
          ).length,
        });
        ctx.setMetadata(OPERATIONS_RUN_SOURCES_METADATA_KEY, {
          required: bodyResult.sources.requiredSources,
          attempted: bodyResult.sources.attemptedSources,
          successful: bodyResult.sources.successfulSources,
          failed: bodyResult.sources.failedSources,
          truncated: bodyResult.sources.truncatedSources,
          continuationScheduled: bodyResult.sources.continuationScheduled,
          outcomes: bodyResult.sources.outcomes,
        });
        return bodyResult;
      },
    },
    undefined,
    input.log,
  );

  if (result.status === prismaPkg.GovernanceReconciliationStatus.RUNNING) {
    return { kind: "already_running", runId: result.runId || null };
  }
  if (result.status === prismaPkg.GovernanceReconciliationStatus.FAILED) {
    return {
      kind: "failed",
      runId: result.runId,
      reason: result.error
        ? safeOperationsFailureCategory(result.error)
        : "unexpected_error",
    };
  }
  return { kind: "ran", runId: result.runId, recorded, sources };
}

// ---------------------------------------------------------------------------
// §8 — projecting the latest run.
// ---------------------------------------------------------------------------

/**
 * The durable facts readiness needs, and nothing else.
 *
 * No lock key, no row id, no trigger user, no error text — those are either
 * internal or another tenant's business.
 */
export type WorkspaceOperationsRunSnapshot = {
  readiness: OperationsReadiness;
  startedAtUtc: string;
  completedAtUtc: string | null;
  /** When a RUNNING row's claim expires. Null for a terminal run. */
  leaseExpiresAtUtc: string | null;
  /** The instant the sources were observed: a completed run's finish time. */
  sourceSnapshotAtUtc: string | null;
  sources: OperationsSourceAccounting;
  /** Bounded category. Never a stack, never SQL. Null unless FAILED. */
  safeFailureCategory: string | null;
  /** Bounded reason the picture is incomplete; null when it is complete. */
  incompletenessReason: string | null;
  /** The required source ids responsible for the incompleteness. */
  incompleteSourceIds: string[];
  recorded: number;
};

function readSourceAccounting(metadata: unknown): OperationsSourceAccounting {
  const empty = emptySourceAccounting();
  if (metadata == null || typeof metadata !== "object") return empty;
  const bag = (metadata as Record<string, unknown>)[
    OPERATIONS_RUN_SOURCES_METADATA_KEY
  ];
  if (bag == null || typeof bag !== "object") return empty;
  const obj = bag as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    requiredSources: list(obj.required),
    attemptedSources: list(obj.attempted),
    successfulSources: list(obj.successful),
    failedSources: list(obj.failed),
    truncatedSources: list(obj.truncated),
    continuationScheduled: obj.continuationScheduled === true,
    // VALIDATED, not trusted. This bag is JSON on a shared table and older
    // rows predate the field entirely; a decoder that believed whatever it
    // found could project an unbounded provider string into a tenant payload,
    // which is the one thing the bounded category exists to prevent.
    outcomes: readOutcomes(obj.outcomes),
  };
}

function readOutcomes(value: unknown): OperationsSourceOutcome[] {
  if (!Array.isArray(value)) return [];
  const out: OperationsSourceOutcome[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const sourceId = typeof e.sourceId === "string" ? e.sourceId : null;
    const outcome =
      e.outcome === "SUCCEEDED" ||
      e.outcome === "FAILED" ||
      e.outcome === "TRUNCATED" ||
      e.outcome === "NOT_APPLICABLE"
        ? (e.outcome as OperationsSourceOutcomeName)
        : null;
    if (!sourceId || !outcome) continue;
    const stage =
      typeof e.stage === "string" &&
      (OPERATIONS_SOURCE_STAGES as readonly string[]).includes(e.stage)
        ? (e.stage as OperationsSourceStage)
        : null;
    out.push({
      sourceId,
      outcome,
      stage: outcome === "FAILED" ? stage : null,
      category:
        outcome === "FAILED" && typeof e.category === "string"
          ? e.category.slice(0, 64)
          : null,
      retryable: e.retryable === true,
    });
  }
  return out;
}

/**
 * Classify one run row into a readiness state.
 *
 * Exported and pure so the false-clear rules can be tested exhaustively
 * without a database — the table of "which states may assert clear" is the
 * load-bearing part of this whole section, and it should be provable by
 * enumeration rather than by fixture.
 */
/**
 * WHY a run is not a complete picture, in bounded words.
 *
 * Returns null when the run IS complete. Non-null whenever readiness is
 * PARTIAL for a source reason, which is the guarantee the summary depends on:
 * a workspace that says "some checks could not be completed" must be able to
 * say which, and what kind of thing went wrong.
 *
 * The category is the WORST bounded category among the REQUIRED sources that
 * failed — worst meaning the one an operator must act on first. A missing
 * column and a transient timeout call for different actions, and reporting the
 * timeout because it sorted first would send somebody to retry a thing that
 * cannot succeed.
 */
export function operationsIncompleteness(
  sources: OperationsSourceAccounting,
): { reason: string; category: string; sourceIds: string[] } | null {
  const required = new Set(sources.requiredSources);
  const failed = sources.failedSources.filter((id) => required.has(id));
  const truncated = sources.truncatedSources.filter((id) => required.has(id));
  if (failed.length === 0 && truncated.length === 0) {
    const missing = sources.requiredSources.filter(
      (id) => !sources.successfulSources.includes(id),
    );
    if (missing.length === 0) return null;
    return {
      reason: "REQUIRED_SOURCE_NOT_ATTEMPTED",
      category: "not_attempted",
      sourceIds: missing,
    };
  }
  if (failed.length === 0) {
    return {
      reason: "REQUIRED_SOURCE_TRUNCATED",
      category: "scan_bound_reached",
      sourceIds: truncated,
    };
  }
  // Ranked by how much operator action they demand. `schema_mismatch` leads:
  // it is the only one here that no amount of retrying will clear, and it is
  // exactly what production hit.
  const RANK = [
    "schema_mismatch",
    "constraint_violation",
    "permission_denied",
    "database_unavailable",
    "queue_unavailable",
    "timeout",
    "unexpected_error",
  ];
  const byId = new Map(sources.outcomes.map((o) => [o.sourceId, o]));
  const categories = failed
    .map((id) => byId.get(id)?.category ?? null)
    .filter((c): c is string => typeof c === "string");
  const worst =
    RANK.find((c) => categories.includes(c)) ?? categories[0] ?? "unexpected_error";
  return {
    reason: "REQUIRED_SOURCE_FAILED",
    category: worst,
    sourceIds: failed,
  };
}

export function classifyOperationsReadiness(
  row: {
    status: prismaPkg.GovernanceReconciliationStatus;
    startedAtUtc: Date;
    finishedAtUtc: Date | null;
    sources: OperationsSourceAccounting;
  },
  now: Date,
  freshnessWindowMs: number = OPERATIONS_FRESHNESS_WINDOW_MS,
): OperationsReadiness {
  if (row.status === prismaPkg.GovernanceReconciliationStatus.RUNNING) {
    const ageMs = now.getTime() - row.startedAtUtc.getTime();
    // A RUNNING row past its lease is not a run in progress; it is the
    // wreckage of a process that died holding the lock. Reporting it as
    // RUNNING would make a permanently-stuck workspace look permanently busy.
    return ageMs > RUN_LOCK_LEASE_MS ? "STALLED" : "RUNNING";
  }
  if (row.status === prismaPkg.GovernanceReconciliationStatus.FAILED) {
    return "FAILED";
  }

  // Terminal and not failed. Freshness first: a complete picture of two days
  // ago is not a description of now.
  const observedAt = row.finishedAtUtc ?? row.startedAtUtc;
  if (now.getTime() - observedAt.getTime() > freshnessWindowMs) return "STALE";

  // Completeness. PARTIAL status, any failed source, and any truncated source
  // are three different ways of not having seen everything, and all three mean
  // the same thing to a reader: this is a floor, not a total.
  if (row.status === prismaPkg.GovernanceReconciliationStatus.PARTIAL) {
    return "PARTIAL";
  }
  // A failure degrades readiness only when the workspace's picture DEPENDS on
  // that source.
  //
  // WHY THIS IS NOT A LOOSENING. `requiredSources` is the registry's own
  // freshness-participating set, recorded on the run at the time it ran; a
  // source outside it is one this workspace's picture does not depend on.
  // Production showed the cost of conflating the two: `platform.telemetry_stale`
  // — a PLATFORM sampler, not a tenant fact, and deliberately not
  // freshness-participating — failed, and a tenant workspace was reported
  // incomplete because of it. That is a false alarm on a tenant surface for a
  // condition the tenant neither owns nor can act on.
  //
  // The five REQUIRED Evidence/Pipeline sources that failed alongside it stay
  // exactly as they were: still failures, still PARTIAL, still refusing the
  // all-clear. Nothing here reclassifies a required source to make a page
  // green, and an optional source's failure is still recorded in `outcomes`
  // and still listed in `failedSources` — it is visible, it simply does not
  // speak for a picture it was never part of.
  const required = new Set(row.sources.requiredSources);
  const requiredFailed = row.sources.failedSources.filter((id) =>
    required.has(id),
  );
  const requiredTruncated = row.sources.truncatedSources.filter((id) =>
    required.has(id),
  );
  if (requiredFailed.length > 0) return "PARTIAL";
  if (requiredTruncated.length > 0) return "PARTIAL";

  // Every REQUIRED source must have actually succeeded. A run that skipped a
  // required source without recording a failure is still not a complete one,
  // and this is the check that catches a body which forgot to attempt it.
  const succeeded = new Set(row.sources.successfulSources);
  for (const required of row.sources.requiredSources) {
    if (!succeeded.has(required)) return "PARTIAL";
  }
  return "READY";
}

/**
 * The most recent Operations run for ONE workspace.
 *
 * Tenant-bound by `teamId` in the query itself — a caller cannot ask about a
 * workspace it did not name, and the endpoint that calls this has already
 * proven the actor may see that workspace.
 *
 * Returns `null` when no run has ever been recorded. `null` is NEVER_RUN and
 * the caller must treat it as such; it is deliberately not flattened into a
 * synthetic "stale" snapshot, because "we looked and it was old" and "nothing
 * has ever looked" call for different words on the screen.
 */
export async function latestWorkspaceOperationsRun(
  client: PrismaClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<WorkspaceOperationsRunSnapshot | null> {
  const row = await client.governanceReconciliationRun.findFirst({
    where: { teamId: workspaceId, kind: WORKSPACE_OPERATIONS_RUN_KIND },
    orderBy: { startedAtUtc: "desc" },
    select: {
      status: true,
      startedAtUtc: true,
      finishedAtUtc: true,
      errorSummary: true,
      metadata: true,
      createdCount: true,
    },
  });
  if (!row) return null;

  const sources = readSourceAccounting(row.metadata);
  const readiness = classifyOperationsReadiness(
    {
      status: row.status,
      startedAtUtc: row.startedAtUtc,
      finishedAtUtc: row.finishedAtUtc,
      sources,
    },
    now,
  );
  const running =
    row.status === prismaPkg.GovernanceReconciliationStatus.RUNNING;
  const incompleteness = operationsIncompleteness(sources);

  return {
    readiness,
    startedAtUtc: row.startedAtUtc.toISOString(),
    completedAtUtc: row.finishedAtUtc?.toISOString() ?? null,
    leaseExpiresAtUtc: running
      ? new Date(row.startedAtUtc.getTime() + RUN_LOCK_LEASE_MS).toISOString()
      : null,
    sourceSnapshotAtUtc: row.finishedAtUtc?.toISOString() ?? null,
    sources,
    // The stored `errorSummary` is an exception message and must not reach a
    // browser. It is reduced to a bounded category here, at the boundary.
    // A run that FAILED outright carries the run-level cause. A run that
    // merely came back INCOMPLETE used to carry null here, which is how
    // production could say "some checks could not be completed" and offer
    // nothing further — the operator had no way to learn that a required
    // source had hit a schema mismatch. Whenever readiness is PARTIAL because
    // sources gave way, this is now non-null.
    safeFailureCategory:
      row.status === prismaPkg.GovernanceReconciliationStatus.FAILED
        ? safeOperationsFailureCategory(row.errorSummary ?? "")
        : (incompleteness?.category ?? null),
    /** WHY the picture is incomplete, bounded. Null when it is complete. */
    incompletenessReason: incompleteness?.reason ?? null,
    /** WHICH required sources are responsible. Ids only — never contents. */
    incompleteSourceIds: incompleteness?.sourceIds ?? [],
    recorded: row.createdCount,
  };
}

// ---------------------------------------------------------------------------
// §8 — the false-clear contract.
// ---------------------------------------------------------------------------

/**
 * Why a workspace may NOT be described as clear. Bounded, and ordered from
 * most to least specific so the caller renders the most useful sentence.
 */
export type ClearRefusalReason =
  | "NEVER_RUN"
  | "RUNNING"
  | "STALE"
  | "FAILED"
  | "STALLED"
  | "PARTIAL_SOURCES"
  | "TRUNCATED_SOURCE"
  | "INCIDENT_READ_INCOMPLETE"
  | "UNRESOLVED_CONDITIONS";

/**
 * THE gate. "Workspace operations are clear" is permitted only when every one
 * of these holds.
 *
 * Written as a single function, taking every input at once, because the
 * failure mode this guards against is a caller that checks three of the five
 * conditions and forgets the other two. There is nothing to forget if the only
 * way to ask the question is to supply all of them.
 *
 * Note what is NOT sufficient: an incident-table read that succeeded and
 * returned zero rows. Read completeness is not discovery completeness — if
 * nothing has scanned the workspace, the incident table is empty because it is
 * empty, not because the workspace is healthy.
 */
export function mayAssertOperationsClear(input: {
  run: WorkspaceOperationsRunSnapshot | null;
  /** Did the incident projection read complete without hitting its bound? */
  incidentReadComplete: boolean;
  /** Unresolved conditions the projection found. */
  unresolvedCount: number;
}): { clear: true } | { clear: false; reason: ClearRefusalReason } {
  if (!input.run) return { clear: false, reason: "NEVER_RUN" };
  switch (input.run.readiness) {
    case "NEVER_RUN":
      return { clear: false, reason: "NEVER_RUN" };
    case "RUNNING":
      return { clear: false, reason: "RUNNING" };
    case "STALE":
      return { clear: false, reason: "STALE" };
    case "FAILED":
      return { clear: false, reason: "FAILED" };
    case "STALLED":
      return { clear: false, reason: "STALLED" };
    case "PARTIAL":
      return {
        clear: false,
        reason:
          input.run.sources.truncatedSources.length > 0
            ? "TRUNCATED_SOURCE"
            : "PARTIAL_SOURCES",
      };
    case "READY":
      break;
  }
  // Belt and braces: READY is already defined to exclude these, and asserting
  // it here means a future change to the classifier cannot quietly widen what
  // "clear" is allowed to mean.
  if (input.run.sources.truncatedSources.length > 0) {
    return { clear: false, reason: "TRUNCATED_SOURCE" };
  }
  if (input.run.sources.failedSources.length > 0) {
    return { clear: false, reason: "PARTIAL_SOURCES" };
  }
  if (!input.incidentReadComplete) {
    return { clear: false, reason: "INCIDENT_READ_INCOMPLETE" };
  }
  if (input.unresolvedCount > 0) {
    return { clear: false, reason: "UNRESOLVED_CONDITIONS" };
  }
  return { clear: true };
}

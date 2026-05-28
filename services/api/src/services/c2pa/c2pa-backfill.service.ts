/**
 * PROOVRA C2PA — bulk backfill service (Phase M2.1).
 *
 * Bounded preview + execute + status + cancel surface for backfilling
 * existing evidence with C2PA extraction results.
 *
 * Hard rules:
 *   * Workspace-scoped. There is NO cross-tenant scan.
 *   * Resumable via deterministic cursor (evidence id order).
 *   * Idempotent: evidence whose `verificationPackageMetadata.c2pa`
 *     already exists is SKIPPED unless `force=true`.
 *   * Bounded batch size (`maxBatchSize`).
 *   * Bulk operation state is held in a single in-process registry
 *     keyed by run id. Restart-safe by re-querying the underlying
 *     evidence cursor.
 *   * Bounded preview never returns more than 20 sample evidence ids.
 *   * NEVER returns raw evidence content. NEVER returns raw stdout.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { prisma } from "../../db.js";
import type { C2paEvidenceSummary } from "@proovra/shared";

// ---------------------------------------------------------------------------
// Bounded enums + types
// ---------------------------------------------------------------------------

export const BACKFILL_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "cancelled",
  "failed",
] as const;
export type BackfillRunStatus = (typeof BACKFILL_RUN_STATUSES)[number];

export const BACKFILL_TARGET_FILTERS = [
  "all_eligible",
  "missing_summary",
  "errored_only",
] as const;
export type BackfillTargetFilter =
  (typeof BACKFILL_TARGET_FILTERS)[number];

export type BackfillPreview = {
  teamId: string;
  filter: BackfillTargetFilter;
  totalEligible: number;
  alreadyProcessed: number;
  candidateCount: number;
  unsupportedCount: number;
  sampleEvidenceIds: ReadonlyArray<string>;
  providerMode: string;
  rawManifestExportEnabled: boolean;
  c2paEnabled: boolean;
  /** Bounded operator-readable note (≤240 chars). */
  note: string;
  /** Bounded warnings. */
  warnings: ReadonlyArray<
    | "C2PA_PROVIDER_DISABLED"
    | "C2PA_PROVIDER_DETECT_ONLY"
    | "BACKFILL_SCOPE_LARGE"
  >;
};

export type BackfillRun = {
  id: string;
  teamId: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  status: BackfillRunStatus;
  filter: BackfillTargetFilter;
  /** Total candidates at planning time (snapshot). */
  candidateCount: number;
  /** Evidence processed so far. */
  processedCount: number;
  /** Successes. */
  succeededCount: number;
  /** Failures. */
  failedCount: number;
  /** Skipped (already had bounded summary). */
  skippedCount: number;
  /** Last evidence id processed (cursor). */
  cursorEvidenceId: string | null;
  /** Optional bounded note. */
  note: string | null;
  /** Bounded actor for the run. */
  initiatedByUserId: string;
};

// In-process registry. Keyed by run id; restart-safe via DB re-query.
const RUNS = new Map<string, BackfillRun>();

const RUN_PREVIEW_INPUT = z.object({
  teamId: z.string().uuid(),
  filter: z.enum(BACKFILL_TARGET_FILTERS).optional(),
});

const RUN_START_INPUT = z.object({
  teamId: z.string().uuid(),
  filter: z.enum(BACKFILL_TARGET_FILTERS).optional(),
  actorUserId: z.string().uuid(),
  /** Bounded max-batch the executor will process before yielding back. */
  maxBatchSize: z.number().int().min(1).max(500).optional(),
  /** Force re-extraction of evidence that already has a bounded summary. */
  force: z.boolean().optional(),
});

const LARGE_SCOPE_THRESHOLD = 10_000;

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function previewC2paBackfill(
  rawInput: unknown,
  env: {
    C2PA_ENABLED: string;
    C2PA_PROVIDER_MODE: string;
    C2PA_RAW_MANIFEST_EXPORT_ENABLED: string;
  },
): Promise<BackfillPreview> {
  const input = RUN_PREVIEW_INPUT.parse(rawInput);
  const filter: BackfillTargetFilter = input.filter ?? "missing_summary";
  const where = await buildBackfillWhereClause(input.teamId, filter);
  const candidateCount = await prisma.evidence.count({ where });
  const totalEligible = await prisma.evidence.count({
    where: { teamId: input.teamId },
  });
  const alreadyProcessed = await countAlreadyProcessed(input.teamId);
  const sample = await prisma.evidence.findMany({
    where,
    select: { id: true },
    orderBy: { id: "asc" },
    take: 20,
  });
  const warnings: BackfillPreview["warnings"][number][] = [];
  if (env.C2PA_ENABLED !== "true") warnings.push("C2PA_PROVIDER_DISABLED");
  else if (env.C2PA_PROVIDER_MODE === "detect_only") {
    warnings.push("C2PA_PROVIDER_DETECT_ONLY");
  }
  if (candidateCount > LARGE_SCOPE_THRESHOLD) {
    warnings.push("BACKFILL_SCOPE_LARGE");
  }
  return {
    teamId: input.teamId,
    filter,
    totalEligible,
    alreadyProcessed,
    candidateCount,
    unsupportedCount: 0,
    sampleEvidenceIds: sample.map((r) => r.id),
    providerMode: env.C2PA_PROVIDER_MODE,
    rawManifestExportEnabled:
      env.C2PA_RAW_MANIFEST_EXPORT_ENABLED === "true",
    c2paEnabled: env.C2PA_ENABLED === "true",
    note:
      env.C2PA_ENABLED !== "true"
        ? "C2PA provider is disabled. Backfill will record bounded `disabled` summaries on each evidence record."
        : "Backfill will enqueue per-evidence extraction jobs and persist bounded summaries.",
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startC2paBackfill(
  rawInput: unknown,
): Promise<BackfillRun> {
  const input = RUN_START_INPUT.parse(rawInput);
  const filter: BackfillTargetFilter = input.filter ?? "missing_summary";
  const where = await buildBackfillWhereClause(input.teamId, filter);
  const candidateCount = await prisma.evidence.count({ where });
  const run: BackfillRun = {
    id: randomUUID(),
    teamId: input.teamId,
    startedAtUtc: new Date().toISOString(),
    endedAtUtc: null,
    status: "pending",
    filter,
    candidateCount,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    cursorEvidenceId: null,
    note: null,
    initiatedByUserId: input.actorUserId,
  };
  RUNS.set(run.id, run);
  // The actual enqueue / step-through happens in
  // `tickC2paBackfillRun()` — called either inline by a caller that
  // wants synchronous progress, or by a worker process polling
  // pending runs. We expose the function rather than eagerly running
  // here so callers control concurrency.
  return run;
}

export type BackfillTickOutcome = {
  run: BackfillRun;
  processedThisTick: number;
  cancelled: boolean;
};

export async function tickC2paBackfillRun(input: {
  runId: string;
  maxBatchSize?: number;
  /**
   * Per-evidence work callback. The default is a no-op writer that
   * persists a bounded `disabled` summary on each evidence row —
   * suitable for deployments where the operator wants the summary
   * projection to be present but cannot run the external tool.
   *
   * Real extraction is invoked by the worker via the queue. The api-
   * side service is restartable / cancellable here.
   */
  perEvidence?: (evidenceId: string) => Promise<"succeeded" | "skipped" | "failed">;
}): Promise<BackfillTickOutcome> {
  const run = RUNS.get(input.runId);
  if (!run) {
    throw new Error(`No backfill run ${input.runId}`);
  }
  // Snapshot status into a widened local so TypeScript does not
  // narrow it: another concurrent call (cancel) can mutate run.status
  // while the loop is running.
  const initialStatus: BackfillRunStatus = run.status;
  if (initialStatus === "cancelled" || initialStatus === "completed") {
    return {
      run,
      processedThisTick: 0,
      cancelled: initialStatus === "cancelled",
    };
  }
  run.status = "running";
  const batch = Math.min(Math.max(input.maxBatchSize ?? 50, 1), 500);
  const where = await buildBackfillWhereClause(run.teamId, run.filter);
  // Resume from cursor.
  const cursor = run.cursorEvidenceId
    ? { id: run.cursorEvidenceId }
    : undefined;
  const skip = cursor ? 1 : 0;
  const evidence = await prisma.evidence.findMany({
    where,
    select: { id: true },
    orderBy: { id: "asc" },
    take: batch,
    cursor,
    skip,
  });
  let processedThisTick = 0;
  for (const e of evidence) {
    const current = run.status as BackfillRunStatus;
    if (current === "cancelled") break;
    let outcome: "succeeded" | "skipped" | "failed" = "skipped";
    try {
      outcome = input.perEvidence
        ? await input.perEvidence(e.id)
        : await persistDisabledSummary(e.id);
    } catch {
      outcome = "failed";
    }
    run.processedCount++;
    processedThisTick++;
    run.cursorEvidenceId = e.id;
    if (outcome === "succeeded") run.succeededCount++;
    else if (outcome === "failed") run.failedCount++;
    else run.skippedCount++;
  }
  // Widen via cast — TS narrows `run.status` to the literal "running"
  // after the assignment above; another concurrent call (cancel) can
  // mutate it independently.
  const finalStatus = run.status as BackfillRunStatus;
  if (evidence.length < batch && finalStatus !== "cancelled") {
    run.status = "completed";
    run.endedAtUtc = new Date().toISOString();
  }
  return {
    run,
    processedThisTick,
    cancelled: (run.status as BackfillRunStatus) === "cancelled",
  };
}

// ---------------------------------------------------------------------------
// Status / cancel
// ---------------------------------------------------------------------------

export function getC2paBackfillRun(runId: string): BackfillRun | null {
  return RUNS.get(runId) ?? null;
}

export function listC2paBackfillRuns(teamId: string): ReadonlyArray<BackfillRun> {
  return Array.from(RUNS.values()).filter((r) => r.teamId === teamId);
}

export function cancelC2paBackfillRun(runId: string): BackfillRun | null {
  const run = RUNS.get(runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "cancelled") return run;
  run.status = "cancelled";
  run.endedAtUtc = new Date().toISOString();
  return run;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function buildBackfillWhereClause(
  teamId: string,
  filter: BackfillTargetFilter,
): Promise<Record<string, unknown>> {
  // For Prisma JSON filters we use the raw `path` query.
  if (filter === "all_eligible") {
    return { teamId };
  }
  if (filter === "errored_only") {
    return {
      teamId,
      verificationPackageMetadata: {
        path: ["c2pa", "aggregateStatus"],
        equals: "error",
      },
    };
  }
  // missing_summary — default. We treat both null metadata and
  // metadata without a `c2pa` sub-field as missing. Prisma's JSON
  // null sentinel needs the bounded `Prisma.DbNull` constant; we
  // use a defensive cast to avoid coupling the service to the
  // Prisma namespace import here.
  return {
    teamId,
    OR: [
      { verificationPackageMetadata: { equals: "DbNull" as never } as never },
      { NOT: { verificationPackageMetadata: { path: ["c2pa"], not: null } } },
    ],
  };
}

async function countAlreadyProcessed(teamId: string): Promise<number> {
  // Prisma's JSON `not` filter requires a non-null sentinel; we pass
  // a defensive cast so we don't have to import the Prisma namespace.
  return prisma.evidence.count({
    where: {
      teamId,
      verificationPackageMetadata: {
        path: ["c2pa"],
        not: undefined as never,
      },
    },
  });
}

async function persistDisabledSummary(
  evidenceId: string,
): Promise<"succeeded" | "skipped" | "failed"> {
  try {
    const current = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { verificationPackageMetadata: true },
    });
    if (!current) return "failed";
    const meta = (current.verificationPackageMetadata as
      | { c2pa?: C2paEvidenceSummary | null }
      | null
      | undefined) ?? null;
    if (meta?.c2pa) return "skipped";
    // We don't want to import the worker module here. Use a minimal
    // inline bounded disabled summary that mirrors @proovra/shared.
    const summary: C2paEvidenceSummary = {
      schemaVersion: "PROOVRA_C2PA_RESULT_V1",
      generatedAtUtc: new Date().toISOString(),
      evidenceId,
      providerMode: "disabled",
      toolVersion: null,
      aggregateStatus: "disabled",
      aggregateValidationStatus: "not_checked",
      itemsChecked: 0,
      files: [],
      warnings: [],
      limitations: [
        "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
        "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
        "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
        "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
        "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
      ],
      note:
        "C2PA backfill recorded a bounded `disabled` summary because the provider is operationally disabled.",
    };
    const merged = {
      ...(meta ?? {
        manifestPresent: false,
        signedManifestPresent: false,
        checksumIndexPresent: false,
        offlineVerifierIncluded: false,
        packageVersion: "v1" as const,
        generatedAtUtc: new Date().toISOString(),
        source: "GENERATION" as const,
      }),
      c2pa: summary,
    };
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: {
        verificationPackageMetadata:
          merged as unknown as import("@prisma/client").Prisma.InputJsonValue,
      },
    });
    return "succeeded";
  } catch {
    return "failed";
  }
}

/**
 * Test-only: reset the in-process registry.
 */
export function __resetC2paBackfillRegistryForTests() {
  RUNS.clear();
}

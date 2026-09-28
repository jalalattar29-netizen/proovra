/**
 * Phase P2.3 — Queue replay safety matrix.
 *
 * Bounded, single-source matrix that classifies every PROOVRA worker
 * job kind into one of three categories:
 *
 *   * `safe`                 — re-running yields the same effect or a
 *                              no-op. Operator can retry / replay
 *                              without step-up.
 *   * `requires_step_up`     — idempotent overall, but with cost or
 *                              side-effects that warrant operator
 *                              confirmation. Step-up gates the replay.
 *   * `forbidden`            — the job mutates state irreversibly.
 *                              The route layer refuses the replay
 *                              outright with `replay_forbidden`.
 *
 * This file is the canonical contract. The queue inventory service +
 * the routes consume `getJobReplayCategory(queue, jobKind)` so the UI
 * can render the badge and the backend can enforce the gate.
 *
 * Hard rules:
 *   * The list is EXHAUSTIVE — unknown queues / job kinds fall to
 *     `unknown` so the UI can refuse the action and surface the
 *     operator to engineering.
 *   * Categories may only widen (less restrictive → more restrictive)
 *     between releases. Narrowing requires explicit review.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@proovra/shared";

export type ReplayCategory =
  | "safe"
  | "requires_step_up"
  | "forbidden"
  | "unknown";

export type ReplaySafetyEntry = {
  queueName: string;
  jobKind: string;
  category: ReplayCategory;
  rationale: string;
};

/*
 * EVIDENCE OUTPUT LIFECYCLE (2026-09-29) — THE MATRIX SPEAKS THE CANONICAL NAMES.
 *
 * Seven entries named job kinds no producer emits (`GenerateReport`,
 * `ExifExtraction`, `MiSearchIndex`, `GraphDomainSync`, …) — the real names are
 * the `JOB_NAMES` values — so every lookup fell through to `unknown` and the
 * replay of a report job could never succeed. Two queues (`mi-embed`,
 * `redaction-derivative`) were absent, so Operations could neither see nor act
 * on them. And a `report-dlq` entry is a TRIAGE RECORD (`ReportDLQ`), not the
 * original job: "retrying" it re-queued it onto a queue with no worker.
 *
 * Every (queue, job) pair is now written with the shared constants, and a
 * contract test pins the matrix to the canonical registry.
 */
const ENTRIES: ReadonlyArray<ReplaySafetyEntry> = [
  // ---- report queue ----
  {
    queueName: QUEUE_NAMES.REPORT,
    jobKind: JOB_NAMES.GENERATE_REPORT,
    category: "requires_step_up",
    rationale:
      "The job carries only a ReportGenerationRequest id; a replay re-runs the claim, which refuses terminal requests and resumes a committed report at its package. Publication uses single-use keys, so a replay never overwrites an artifact. Step-up because it issues evidentiary documents.",
  },
  {
    queueName: QUEUE_NAMES.REPORT_DLQ,
    jobKind: "ReportDLQ",
    category: "forbidden",
    rationale:
      "A dead-letter entry is a triage record, not the original job; retrying it re-queues it onto a queue with no worker. Recover the record from Operations (Recover / Retry after exhausted failure), which creates an audited request.",
  },
  // ---- evidence-purge queue ----
  {
    queueName: QUEUE_NAMES.EVIDENCE_PURGE,
    jobKind: JOB_NAMES.PURGE_DELETED_EVIDENCE,
    category: "forbidden",
    rationale:
      "Destructive irreversible job. Replay is hard-refused; operators must investigate via the audit center.",
  },
  // ---- ots-upgrade ----
  {
    queueName: QUEUE_NAMES.OTS_UPGRADE,
    jobKind: JOB_NAMES.UPGRADE_OTS,
    category: "requires_step_up",
    rationale:
      "External calendar/blockchain upgrade attempt. It records later proof facts only and never re-issues a report. Safe to re-attempt; step-up gates the operator confirmation.",
  },
  // ---- search-indexing ----
  {
    queueName: QUEUE_NAMES.SEARCH_INDEXING,
    jobKind: JOB_NAMES.REBUILD_SEARCH_DOCUMENT,
    category: "safe",
    rationale: "Append-only upsert against the search index. Idempotent.",
  },
  // ---- media intelligence ----
  {
    queueName: QUEUE_NAMES.MEDIA_INTELLIGENCE,
    jobKind: JOB_NAMES.RUN_MEDIA_INTELLIGENCE,
    category: "safe",
    rationale:
      "Analysis run is read-only over evidence; results upsert an intelligence run row keyed on (evidenceId, runVersion).",
  },
  {
    queueName: QUEUE_NAMES.MEDIA_INTELLIGENCE_DLQ,
    jobKind: JOB_NAMES.RUN_MEDIA_INTELLIGENCE,
    category: "forbidden",
    rationale:
      "No worker consumes the dead-letter queue; a retried entry would sit there. Re-run the analysis from the record instead.",
  },
  // ---- MI subsystem queues ----
  {
    queueName: QUEUE_NAMES.DERIVED_ASSETS,
    jobKind: JOB_NAMES.GENERATE_DERIVED_ASSET,
    category: "safe",
    rationale: "S3 PUT upsert keyed by (evidenceId, assetKind).",
  },
  {
    queueName: QUEUE_NAMES.MI_EXIF,
    jobKind: JOB_NAMES.EXTRACT_EXIF,
    category: "safe",
    rationale: "Read-only EXIF extraction; result upsert.",
  },
  {
    queueName: QUEUE_NAMES.MI_SEARCH_INDEX,
    jobKind: JOB_NAMES.INDEX_MEDIA_INTELLIGENCE,
    category: "safe",
    rationale: "Search-projection upsert. Idempotent.",
  },
  {
    queueName: QUEUE_NAMES.MI_EMBED,
    jobKind: JOB_NAMES.EMBED_SEMANTIC_CHUNKS,
    category: "safe",
    rationale: "Embedding upsert keyed by chunk; idempotent.",
  },
  // ---- redaction ----
  {
    queueName: QUEUE_NAMES.REDACTION_DERIVATIVE,
    jobKind: JOB_NAMES.RENDER_REDACTION_DERIVATIVE,
    category: "requires_step_up",
    rationale:
      "Renders a redacted derivative of evidence content; idempotent per derivative version, but it produces a disclosable copy, so step-up gates it.",
  },
  // ---- graph queues ----
  {
    queueName: QUEUE_NAMES.GRAPH_RECONCILE,
    jobKind: JOB_NAMES.RECONCILE_TEAM_GRAPH,
    category: "safe",
    rationale: "Projection upsert keyed by teamId + projection version.",
  },
  {
    queueName: QUEUE_NAMES.GRAPH_DOMAIN_SYNC,
    jobKind: JOB_NAMES.SYNC_TEAM_GRAPH_DOMAIN,
    category: "safe",
    rationale: "Projection upsert.",
  },
  {
    queueName: QUEUE_NAMES.GRAPH_TIMELINE_SYNC,
    jobKind: JOB_NAMES.SYNC_TEAM_GRAPH_TIMELINE,
    category: "safe",
    rationale: "Projection upsert.",
  },
  {
    queueName: QUEUE_NAMES.GRAPH_SEARCH_PROJECTION,
    jobKind: JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION,
    category: "safe",
    rationale: "Projection upsert.",
  },
  // ---- org health ----
  {
    queueName: QUEUE_NAMES.ORG_HEALTH_REFRESH,
    jobKind: JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION,
    category: "safe",
    rationale: "Bounded upsert keyed by (teamId, sampledAtUtc).",
  },
];

/**
 * Returns the bounded matrix as a list. The route layer + UI both
 * consume this; the list NEVER includes free-form strings.
 */
export function getReplaySafetyMatrix(): ReadonlyArray<ReplaySafetyEntry> {
  return ENTRIES;
}

export function getJobReplayCategory(
  queueName: string,
  jobKind: string,
): ReplayCategory {
  const entry = ENTRIES.find(
    (e) => e.queueName === queueName && e.jobKind === jobKind,
  );
  return entry?.category ?? "unknown";
}

export function getJobReplayRationale(
  queueName: string,
  jobKind: string,
): string | null {
  const entry = ENTRIES.find(
    (e) => e.queueName === queueName && e.jobKind === jobKind,
  );
  return entry?.rationale ?? null;
}

/**
 * Bounded set of queue names the inventory + listing endpoints
 * recognise. Used to validate the `:queueName` path parameter.
 */
export const KNOWN_QUEUE_NAMES: ReadonlyArray<string> = Array.from(
  new Set(ENTRIES.map((e) => e.queueName)),
);

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
const ENTRIES = [
    // ---- report queue ----
    {
        queueName: "report",
        jobKind: "GenerateReport",
        category: "requires_step_up",
        rationale: "Idempotent overall, but the job performs PDF signing + artifact moves. A partial-failure replay is the most risk-bearing path; gate with step-up.",
    },
    {
        queueName: "report",
        jobKind: "PurgeDeletedEvidenceJob",
        category: "forbidden",
        rationale: "Hard-deletes evidence rows + S3 objects. Re-running either no-ops (already gone) or attempts to delete data that has since been re-created. Operator should diagnose, not re-run.",
    },
    {
        queueName: "report-dlq",
        jobKind: "GenerateReport",
        category: "requires_step_up",
        rationale: "Same as `report:GenerateReport`. Replaying from DLQ requires step-up.",
    },
    // ---- evidence-purge queue ----
    {
        queueName: "evidence-purge",
        jobKind: "PurgeDeletedEvidenceJob",
        category: "forbidden",
        rationale: "Destructive irreversible job. Replay is hard-refused; operators must investigate via the audit center.",
    },
    // ---- ots-upgrade ----
    {
        queueName: "ots-upgrade",
        jobKind: "UpgradeOts",
        category: "requires_step_up",
        rationale: "External blockchain anchor attempt. Safe to re-attempt but cumulative cost; step-up gates the operator confirmation.",
    },
    // ---- search-indexing ----
    {
        queueName: "search-indexing",
        jobKind: "RebuildSearchDocument",
        category: "safe",
        rationale: "Append-only upsert against the search index. Idempotent.",
    },
    // ---- media intelligence ----
    {
        queueName: "media-intelligence",
        jobKind: "RunMediaIntelligence",
        category: "safe",
        rationale: "Analysis run is read-only over evidence; results upsert an intelligence run row keyed on (evidenceId, runVersion).",
    },
    {
        queueName: "media-intelligence-dlq",
        jobKind: "RunMediaIntelligence",
        category: "safe",
        rationale: "DLQ replay re-enqueues the upstream analysis job using BullMQ's retry. Same idempotency guarantee as the live queue.",
    },
    // ---- MI subsystem queues ----
    {
        queueName: "mi-derived-assets",
        jobKind: "GenerateDerivedAsset",
        category: "safe",
        rationale: "S3 PUT upsert keyed by (evidenceId, assetKind).",
    },
    {
        queueName: "mi-exif",
        jobKind: "ExifExtraction",
        category: "safe",
        rationale: "Read-only EXIF extraction; result upsert.",
    },
    {
        queueName: "mi-ocr",
        jobKind: "OcrExtraction",
        category: "safe",
        rationale: "Read-only OCR; result upsert.",
    },
    {
        queueName: "mi-transcript",
        jobKind: "TranscriptExtraction",
        category: "safe",
        rationale: "Read-only transcription; result upsert.",
    },
    {
        queueName: "mi-search-index",
        jobKind: "MiSearchIndex",
        category: "safe",
        rationale: "Search-projection upsert. Idempotent.",
    },
    // ---- graph queues ----
    {
        queueName: "graph-reconcile",
        jobKind: "ReconcileTeamGraph",
        category: "safe",
        rationale: "Projection upsert keyed by teamId + projection version.",
    },
    {
        queueName: "graph-domain-sync",
        jobKind: "GraphDomainSync",
        category: "safe",
        rationale: "Projection upsert.",
    },
    {
        queueName: "graph-timeline-sync",
        jobKind: "GraphTimelineSync",
        category: "safe",
        rationale: "Projection upsert.",
    },
    {
        queueName: "graph-search-projection",
        jobKind: "GraphSearchProjection",
        category: "safe",
        rationale: "Projection upsert.",
    },
    // ---- org health ----
    {
        queueName: "org-health-refresh",
        jobKind: "RefreshOrgHealthProjection",
        category: "safe",
        rationale: "Bounded upsert keyed by (teamId, sampledAtUtc).",
    },
];
/**
 * Returns the bounded matrix as a list. The route layer + UI both
 * consume this; the list NEVER includes free-form strings.
 */
export function getReplaySafetyMatrix() {
    return ENTRIES;
}
export function getJobReplayCategory(queueName, jobKind) {
    const entry = ENTRIES.find((e) => e.queueName === queueName && e.jobKind === jobKind);
    return entry?.category ?? "unknown";
}
export function getJobReplayRationale(queueName, jobKind) {
    const entry = ENTRIES.find((e) => e.queueName === queueName && e.jobKind === jobKind);
    return entry?.rationale ?? null;
}
/**
 * Bounded set of queue names the inventory + listing endpoints
 * recognise. Used to validate the `:queueName` path parameter.
 */
export const KNOWN_QUEUE_NAMES = Array.from(new Set(ENTRIES.map((e) => e.queueName)));

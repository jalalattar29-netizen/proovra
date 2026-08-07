/**
 * PHASE 12 — POINT 5: queue and job name authority.
 *
 * Every BullMQ queue and every unit of asynchronous work in PROOVRA is named
 * here, once. A name that is not in this file does not exist: the enqueue
 * helper refuses it, the worker bootstrap cannot bind a processor to it, and
 * the closure gate fails the build if a transport client reintroduces a private
 * literal.
 *
 * ---------------------------------------------------------------------------
 * THE REAL TOPOLOGY (measured from the tree, not assumed)
 * ---------------------------------------------------------------------------
 *   17 BullMQ Queue objects = 15 PROCESSED queues + 2 DLQ sinks
 *   15 job names            = one per processed queue, 1:1
 *   15 worker registrations = one per processed queue, 1:1
 *   18 DB-outbox sweeps     = scheduler + processor pairs
 *                             (17 until ARCH-005 added AutomationDispatchSweep
 *                             on 2026-08-07; see SWEEP_NAMES for why Automation
 *                             is an outbox sweep and not a BullMQ queue)
 *    2 telemetry samplers    (observability heartbeat, queue-health sampler —
 *                             they process no durable work and own no state,
 *                             so they are not Point-5 processors)
 *
 * PHASE 12 POINT 5 — the counts moved from 17 to 15 processed queues when the
 * `mi-ocr` and `mi-transcript` queues were removed. They were a SECOND
 * authority for two capabilities the `media-intelligence` queue already owns
 * (run kinds `extract_ocr_azure` / `extract_transcript_deepgram`, against a
 * durable `MediaIntelligenceRun`), and their processors logged
 * `not_configured_completed` — a false terminal signal for work that never
 * ran. Neither queue has ever received a job: their producers had no caller in
 * any commit, so there is no in-flight payload and no legacy adapter.
 *
 * The two DLQ sinks (`report-dlq`, `media-intelligence-dlq`) are queues with no
 * job name and no worker: failed jobs are moved into them for operator triage.
 * That is why the queue count (19) and the registration count (17) differ, and
 * it is the single reconciliation behind what looked like a missing-coverage
 * gap.
 */

// ===========================================================================
// Families
// ===========================================================================

export const QUEUE_FAMILIES = [
  "redaction",
  "invite_delivery",
  "retention_destruction",
  "reports_packages",
  "webhooks_providers",
  "notifications",
  "evidence_finalization",
  "reconciliation",
  "intelligence_operations",
] as const;

export type QueueFamily = (typeof QUEUE_FAMILIES)[number];

/**
 * How the work reaches its processor.
 *
 * Not every family is BullMQ, and pretending otherwise is how a queue audit
 * misses half the asynchronous surface. Invite delivery, webhook delivery,
 * destruction execution and notification delivery are DB-outbox families: an
 * authorized synchronous path commits a durable row, and a scheduled sweep
 * claims due rows atomically. The integrity requirements are identical —
 * durable authority, atomic claim, idempotent side effect, one terminal writer,
 * a reconciler — so both transports are registered under one contract.
 *
 * `bullmq_dlq` is a sink: a queue that receives failed jobs and has no
 * processor by design.
 */
export type JobTransport = "bullmq" | "bullmq_dlq" | "db_outbox_sweep";

// ===========================================================================
// Queue names
// ===========================================================================

export const QUEUE_NAMES = {
  REDACTION_DERIVATIVE: "redaction-derivative",
  REPORT: "report",
  REPORT_DLQ: "report-dlq",
  EVIDENCE_PURGE: "evidence-purge",
  OTS_UPGRADE: "ots-upgrade",
  SEARCH_INDEXING: "search-indexing",
  MEDIA_INTELLIGENCE: "media-intelligence",
  MEDIA_INTELLIGENCE_DLQ: "media-intelligence-dlq",
  DERIVED_ASSETS: "mi-derived-assets",
  MI_EXIF: "mi-exif",
  MI_SEARCH_INDEX: "mi-search-index",
  MI_EMBED: "mi-embed",
  GRAPH_RECONCILE: "graph-reconcile",
  GRAPH_DOMAIN_SYNC: "graph-domain-sync",
  GRAPH_TIMELINE_SYNC: "graph-timeline-sync",
  GRAPH_SEARCH_PROJECTION: "graph-search-projection",
  ORG_HEALTH_REFRESH: "org-health-refresh",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * The `mi-` prefix means MEDIA intelligence — not machine intelligence.
 *
 * It is recorded here because the abbreviation is genuinely ambiguous and the
 * ambiguity has already cost something: `mi-search-index` and `mi-embed` are
 * search/reconciliation work that happens to be produced by the media-
 * intelligence subsystem, while `mi-exif` and `mi-derived-assets` are
 * extraction work. Reading the prefix as a family assignment would put two
 * reconciliation jobs in the intelligence family.
 *
 * The prefix is retained rather than renamed because a queue name is a
 * PRODUCTION IDENTITY: renaming `mi-exif` strands every job already sitting in
 * Redis under the old key, with no drain path that does not lose work. The
 * family mapping in `registry.ts` carries the meaning instead, and each entry
 * states its reason.
 */
export const MI_PREFIX_MEANING = "media_intelligence" as const;

// ===========================================================================
// Job names
// ===========================================================================

/**
 * BullMQ job names — exactly 15, one per processed queue.
 */
export const JOB_NAMES = {
  RENDER_REDACTION_DERIVATIVE: "RenderRedactionDerivative",
  GENERATE_REPORT: "GenerateReportJob",
  PURGE_DELETED_EVIDENCE: "PurgeDeletedEvidenceJob",
  UPGRADE_OTS: "UpgradeOts",
  REBUILD_SEARCH_DOCUMENT: "RebuildSearchDocument",
  RUN_MEDIA_INTELLIGENCE: "RunMediaIntelligence",
  GENERATE_DERIVED_ASSET: "GenerateDerivedAsset",
  EXTRACT_EXIF: "ExtractExif",
  INDEX_MEDIA_INTELLIGENCE: "IndexMediaIntelligence",
  EMBED_SEMANTIC_CHUNKS: "EmbedSemanticChunks",
  RECONCILE_TEAM_GRAPH: "ReconcileTeamGraph",
  SYNC_TEAM_GRAPH_DOMAIN: "SyncTeamGraphDomain",
  SYNC_TEAM_GRAPH_TIMELINE: "SyncTeamGraphTimeline",
  REFRESH_GRAPH_SEARCH_PROJECTION: "RefreshGraphSearchProjection",
  REFRESH_ORG_HEALTH_PROJECTION: "RefreshOrgHealthProjection",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * DB-outbox sweep names — exactly 17.
 *
 * These are not BullMQ job names and never appear on a queue. They are stable
 * identities for scheduler/processor pairs so the registry, the closure gate
 * and the operator projection can address a sweep the same way they address a
 * job.
 */
export const SWEEP_NAMES = {
  DEMO_FOLLOW_UP: "DemoFollowUpSweep",
  CAPTURE_DRAFT_REAPER: "CaptureDraftReaperSweep",
  ORPHAN_SCAN: "OrphanArtifactScan",
  LIFECYCLE_RECOVERY: "LifecycleRecoverySweep",
  MFA_CHALLENGE_GC: "MfaChallengeGcSweep",
  MFA_RECOVERY_DIGEST: "MfaRecoveryDigestSweep",
  REDACTION_RECONCILER: "RedactionStrandedReconciler",
  RETENTION_RECONCILIATION: "RetentionReconciliationSweep",
  DESTRUCTION_ORCHESTRATOR: "DestructionOrchestratorSweep",
  IMMUTABLE_STORAGE_RECONCILIATION: "ImmutableStorageReconciliationSweep",
  ARCHIVE_AUTO_TRANSITION: "ArchiveAutoTransitionSweep",
  WEBHOOK_DISPATCHER: "WebhookDispatcherSweep",
  EXCHANGE_PACKAGE_BUILDER: "ExchangePackageBuilderSweep",
  REVIEWER_RECONCILIATION: "ReviewerReconciliationSweep",
  ORG_INVITE_DELIVERY: "OrgInviteDeliverySweep",
  SEARCH_INDEX_RECONCILER: "SearchIndexStrandedReconciler",
  INTELLIGENCE_RUN_RECONCILER: "IntelligenceRunStrandedReconciler",
  /**
   * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
   *
   * THE ONE AUTOMATION EXECUTION AUTHORITY.
   *
   * WHY A DB-OUTBOX SWEEP AND NOT A BULLMQ QUEUE
   * -----------------------------------------------------------------------
   * Automation's producer runs INSIDE the source domain transaction: the
   * `AutomationRun` row is committed atomically with the evidence, review or
   * hold change that caused it. That is the whole point — the previous design
   * lost the event whenever the process died between commit and dispatch.
   *
   * A BullMQ enqueue cannot participate in that transaction. Enqueuing before
   * commit produces a job for a change that may roll back; enqueuing after
   * commit reopens the exact crash window this closes. The only way to have
   * both is outbox row + sweep, or outbox row + sweep + a BullMQ "hint" — and
   * the hint is a SECOND execution path for the same row, which is the
   * duplicate-authority shape this programme exists to remove.
   *
   * `db_outbox_sweep` is a first-class transport in this registry precisely
   * for this case; the integrity contract (durable authority, atomic claim,
   * idempotent side effect, one terminal writer, a reconciler) is identical
   * either way, and the topology gate, the registry and the queue-health
   * projection all address a sweep exactly as they address a job.
   */
  AUTOMATION_DISPATCH: "AutomationDispatchSweep",
} as const;

export type SweepName = (typeof SWEEP_NAMES)[keyof typeof SWEEP_NAMES];

/** Any addressable unit of asynchronous work. */
export type WorkName = JobName | SweepName;

export function isKnownQueueName(name: string): name is QueueName {
  return (Object.values(QUEUE_NAMES) as string[]).includes(name);
}

export function isKnownJobName(name: string): name is JobName {
  return (Object.values(JOB_NAMES) as string[]).includes(name);
}

export function isKnownSweepName(name: string): name is SweepName {
  return (Object.values(SWEEP_NAMES) as string[]).includes(name);
}

/**
 * Queues that are DLQ sinks. They have no job name and no worker by design, so
 * the closure gate must not count them as orphaned queues.
 */
export const DLQ_QUEUE_NAMES: ReadonlyArray<QueueName> = [
  QUEUE_NAMES.REPORT_DLQ,
  QUEUE_NAMES.MEDIA_INTELLIGENCE_DLQ,
];

export function isDlqQueueName(name: string): boolean {
  return (DLQ_QUEUE_NAMES as ReadonlyArray<string>).includes(name);
}

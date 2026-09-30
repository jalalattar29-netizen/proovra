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
 *   12 BullMQ Queue objects = 10 PROCESSED queues + 2 DLQ sinks
 *   10 job names            = one per processed queue, 1:1
 *   10 worker registrations = one per processed queue, 1:1
 *   20 DB-outbox sweeps     = scheduler + processor pairs
 *                             (17 until ARCH-005 added AutomationDispatchSweep
 *                             on 2026-08-07, 18 until TrashGraceReconciliationSweep
 *                             on 2026-08-24, 19 until ET-SM-07 added
 *                             IntegrityRecheckSweep on 2026-09-30; see
 *                             SWEEP_NAMES for why Automation is an outbox sweep
 *                             and not a BullMQ queue)
 *    2 telemetry samplers    (observability heartbeat, queue-health sampler —
 *                             they process no durable work and own no state,
 *                             so they are not Point-5 processors)
 *
 * ET-Q-07 (2026-09-30) — the counts moved from 15 to 10 processed queues when
 * FIVE PRODUCERLESS QUEUES WERE RETIRED: `mi-exif`, `mi-search-index`,
 * `graph-domain-sync`, `graph-timeline-sync` and `org-health-refresh`. Each had
 * a registered worker, a registry entry marked CURRENT_RUNTIME, a legacy
 * adapter, an Operations inventory row and a replay policy — and no producer.
 * Their enqueue helpers had zero callers in every commit since they were
 * introduced, so none of them ever received a job: five idle workers, five idle
 * Redis connections, and five rows telling an operator that work was flowing
 * through chains nothing fed. The proof is
 * `docs/evidence/audits/definitive-evidence-lifecycle-remediation/evidence/ET-Q-07-no-producer-proof.txt`.
 *
 * The header above had also drifted on its own: it said 18 sweeps while
 * SWEEP_NAMES held 19. It is recounted here from the constants below.
 *
 * A future feature that needs one of those five must reintroduce it END TO END
 * — producer, consumer, idempotency, retries, reconciliation, DLQ and a runtime
 * proof — not by re-adding a name. `services/worker/test/
 * et-q-07-retired-queues-resurrection-guard.test.ts` fails on the name alone.
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
 * That is why the queue count (12) and the registration count (10) differ, and
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
  MI_EMBED: "mi-embed",
  GRAPH_RECONCILE: "graph-reconcile",
  GRAPH_SEARCH_PROJECTION: "graph-search-projection",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * The `mi-` prefix means MEDIA intelligence — not machine intelligence.
 *
 * It is recorded here because the abbreviation is genuinely ambiguous:
 * `mi-embed` computes embedding vectors for the search subsystem, while
 * `mi-derived-assets` is extraction work on evidence bytes. Reading the prefix
 * as a family assignment would be a guess.
 *
 * The prefix is retained rather than renamed because a queue name is a
 * PRODUCTION IDENTITY: renaming `mi-embed` strands every job already sitting in
 * Redis under the old key, with no drain path that does not lose work. The
 * family mapping in `registry.ts` carries the meaning instead, and each entry
 * states its reason.
 *
 * ET-Q-07 (2026-09-30) — this note used to cite `mi-search-index` and `mi-exif`
 * as its examples. Both were retired with no producer; see the header.
 */
export const MI_PREFIX_MEANING = "media_intelligence" as const;

// ===========================================================================
// Job names
// ===========================================================================

/**
 * BullMQ job names — exactly 10, one per processed queue.
 *
 * ET-Q-07 (2026-09-30) — `ExtractExif`, `IndexMediaIntelligence`,
 * `SyncTeamGraphDomain`, `SyncTeamGraphTimeline` and
 * `RefreshOrgHealthProjection` were removed with their producerless queues.
 */
export const JOB_NAMES = {
  RENDER_REDACTION_DERIVATIVE: "RenderRedactionDerivative",
  GENERATE_REPORT: "GenerateReportJob",
  PURGE_DELETED_EVIDENCE: "PurgeDeletedEvidenceJob",
  UPGRADE_OTS: "UpgradeOts",
  REBUILD_SEARCH_DOCUMENT: "RebuildSearchDocument",
  RUN_MEDIA_INTELLIGENCE: "RunMediaIntelligence",
  GENERATE_DERIVED_ASSET: "GenerateDerivedAsset",
  EMBED_SEMANTIC_CHUNKS: "EmbedSemanticChunks",
  RECONCILE_TEAM_GRAPH: "ReconcileTeamGraph",
  REFRESH_GRAPH_SEARCH_PROJECTION: "RefreshGraphSearchProjection",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * DB-outbox sweep names — exactly 20.
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
   * EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24).
   *
   * The producer the trash lifecycle never had. `deleteScheduledForUtc` was a
   * deadline in a column with no scanner: the only thing that ever revisited a
   * trashed record was the ONE delayed job enqueued at trash time, so a lost
   * enqueue, a drained queue or a trash path that did not enqueue left the
   * record in the trash permanently. This sweep is the recovery path that makes
   * the deadline mean something.
   *
   * It is a db_outbox_sweep for the usual reason: the durable authority is the
   * Evidence row itself (`lifecycle_state = TRASHED` plus its grace deadline),
   * committed by the synchronous lifecycle service, and the sweep claims due
   * rows rather than receiving a message about them.
   */
  TRASH_GRACE_RECONCILER: "TrashGraceReconciliationSweep",
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
  /**
   * ET-SM-07 (2026-09-30) — INTEGRITY RECHECK OF EVERY SIGNED RECORD.
   *
   * The stored original bytes of a record used to be re-hashed in exactly one
   * place: inside report generation, which is commercially gated. A record
   * that never received a report — every record on the free plan — was never
   * re-verified, so storage drift on it stayed invisible. This sweep re-reads
   * each signed record's original object(s) at the recorded VersionId on a
   * cadence, records every attempt, and applies the terminal
   * FAILED_HASH_MISMATCH rejection when the digest no longer matches.
   *
   * WHY A DB-OUTBOX SWEEP AND NOT A BULLMQ QUEUE
   * -----------------------------------------------------------------------
   * There is nothing to enqueue. "This record is due a recheck" is not an
   * event somebody emits; it is a FACT already on the Evidence row — signed,
   * not destroyed, and never checked, checked longer ago than the cadence, or
   * explicitly requested (`integrityRecheckDueWhere`). A queue would need a
   * producer to turn that fact into messages, and a lost message would then
   * need a reconciler to notice the fact was still true — which is this sweep.
   * So the sweep IS the mechanism: it selects due rows, takes a per-record
   * lease with a conditional update, and a tick that never ran is made up by
   * the next one because due-ness never left the database.
   */
  INTEGRITY_RECHECK: "IntegrityRecheckSweep",
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

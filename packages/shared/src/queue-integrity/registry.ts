/**
 * PHASE 12 — POINT 5: the canonical work registry.
 *
 * Every unit of asynchronous work in PROOVRA, mapped to exactly one of the nine
 * families, with its durable authority, producer, processor, registration,
 * claim, idempotency strategy and reconciler.
 *
 * ---------------------------------------------------------------------------
 * CONSERVED SETS
 * ---------------------------------------------------------------------------
 *   10 BullMQ jobs   (one per processed queue, 1:1 with worker registrations)
 *   20 DB sweeps     (scheduler + processor pairs)
 *   ──
 *   30 entries in CANONICAL_WORK_REGISTRY, every one of which processes work.
 *
 * ET-SM-07 (2026-09-30) — 19 -> 20 sweeps and 29 -> 30 entries when
 * `IntegrityRecheckSweep` was registered. See the entry, and the
 * `INTEGRITY_RECHECK` note in `names.ts` for why it is a sweep and not a job.
 *    2 DLQ sinks     (queues with no job and no worker, by design) are declared
 *                    SEPARATELY in DLQ_SINKS and are not registry entries.
 *
 * ET-Q-07 (2026-09-30) — RECOUNTED, because this header had stopped being
 * true on its own before anything was removed: it said "18 DB sweeps" and
 * "35 registry entries; 33 of them process work" while the arrays below held
 * 15 jobs + 19 sweeps = 34 entries, with the 2 DLQ sinks in their own array.
 * Retiring the five producerless queues (`mi-exif`, `mi-search-index`,
 * `graph-domain-sync`, `graph-timeline-sync`, `org-health-refresh`) then took
 * 15 jobs to 10 and 34 entries to 29. The numbers above are counted from the
 * arrays; `phase-12-point5-topology-gate.test.ts` pins the job and queue
 * counts, and `phase-12-point5-queue-integrity-gate.test.ts` holds them to the
 * worker's own declarations as an identity.
 *
 * The same pass found three `reconciler` fields naming a module that did not
 * recover that work, and wrote the three scans that make them true. See
 * RECONCILER_PENDING for the mechanism that would carry a real gap.
 *
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07) — 34 -> 35
 * when `AutomationDispatchSweep` was registered. Automation had a schema, an
 * API and a UI and NO runtime: its dispatcher had zero production callers and
 * its delivery path was an in-process `setImmediate`. It is a sweep rather
 * than a BullMQ job because its producer runs inside the source domain
 * transaction; see the `AUTOMATION_DISPATCH` note in `names.ts`.
 *
 * PHASE 12 POINT 5 — recomputed from the settled tree when `ExtractOcr` and
 * `ExtractTranscript` were removed as duplicate authorities (17 -> 15 BullMQ
 * jobs, 34 -> 32 processing units). See the note where they used to sit.
 *
 * ---------------------------------------------------------------------------
 * CURRENT_RUNTIME vs TARGET_PENDING_IMPLEMENTATION
 * ---------------------------------------------------------------------------
 * Every entry declares which it is. `CURRENT_RUNTIME` means the named producer,
 * processor and registration all exist and run today — the closure gate
 * verifies each path against the filesystem, so a registry entry cannot quietly
 * describe an intention. `TARGET_PENDING_IMPLEMENTATION` marks work that is
 * designed but not built, and the closure gate FAILS while any exists. That is
 * the point: a backlog that does not block closure is not a backlog.
 */

import {
  JOB_NAMES,
  QUEUE_NAMES,
  SWEEP_NAMES,
  type JobTransport,
  type QueueFamily,
  type QueueName,
  type WorkName,
} from "./names.js";
import { CANONICAL_PAYLOAD_SCHEMA_VERSION } from "./payload.js";
import {
  RECOVERY_POLICIES,
  RETRY_POLICIES,
  type RecoveryPolicy,
  type RetryPolicy,
} from "./retry-policy.js";

// ===========================================================================
// Entry shape
// ===========================================================================

export type ImplementationState =
  | "CURRENT_RUNTIME"
  | "TARGET_PENDING_IMPLEMENTATION";

/**
 * How a family guarantees "logically once" despite at-least-once delivery.
 *
 * `deterministic_job_id`      — the queue collapses duplicates by id;
 * `conditional_state_claim`   — `updateMany` with a state precondition;
 * `unique_constraint`         — a DB unique index rejects the second write;
 * `provider_idempotency_key`  — the external provider dedupes;
 * `upsert_by_natural_key`     — the write is naturally idempotent;
 * `advisory_lock`             — a DB advisory lock serialises the scope.
 */
export type IdempotencyStrategy =
  | "deterministic_job_id"
  | "conditional_state_claim"
  | "unique_constraint"
  | "provider_idempotency_key"
  | "upsert_by_natural_key"
  | "advisory_lock";

export type ClaimTransition = {
  from: string;
  to: string;
  mechanism:
    | "conditional_update_many"
    | "row_lock_in_transaction"
    | "unique_execution_constraint"
    | "advisory_lock";
  /** Field carrying the lease/claim timestamp, when the family uses one. */
  leaseField: string | null;
  leaseMs: number | null;
};

export type WorkRegistryEntry = {
  /** Stable identity — a BullMQ job name or a DB sweep name. */
  workName: WorkName;
  family: QueueFamily;
  /** Why this work belongs to that family, in one sentence. */
  familyReason: string;
  transport: JobTransport;
  queueName: QueueName | null;
  implementation: ImplementationState;
  schemaVersion: number;
  /** Prefix for `buildCanonicalJobId`. Unique across BullMQ entries. */
  jobIdPrefix: string | null;
  durableAuthority: {
    /** Prisma model or SQL-owned table that the reference points at. */
    model: string;
    /** How the processor derives the authoritative tenant from that row. */
    tenantSource: string;
    /** Whether the row is created by an authorized synchronous path. */
    createdBySynchronousPath: boolean;
  };
  /** Repo-relative module owning the ONE enqueue/scheduling authority. */
  canonicalProducer: string;
  /** Repo-relative module owning the ONE processor implementation. */
  canonicalProcessor: string;
  /** Where the processor is bound to its transport. */
  workerRegistration: string;
  claim: ClaimTransition | null;
  /** Repo-relative module owning the ONE terminal write. */
  terminalWriter: string;
  idempotency: ReadonlyArray<IdempotencyStrategy>;
  /**
   * Repo-relative module that recovers stranded rows, or `null` when NO module
   * does.
   *
   * ET-Q-07 (2026-09-30) — `null` is not a convenience. This field was a
   * required string, so an entry with no recovery path still had to name
   * SOMETHING, and what it named was the nearest plausible module. That is how
   * three entries came to assert coverage nobody wrote. A `null` here must be
   * matched by an entry in RECONCILER_PENDING (and vice versa); the registry
   * self-check and the closure gates enforce both directions.
   */
  reconciler: string | null;
  retry: RetryPolicy;
  recovery: RecoveryPolicy;
  externalBoundary:
    | "storage"
    | "email"
    | "webhook_http"
    | "ai_provider"
    | "timestamp_authority"
    | null;
  auditFamily: string | null;
  projection: string | null;
};

// ===========================================================================
// Shared module paths
// ===========================================================================

const SHARED_ENQUEUE = "packages/shared/src/queue-integrity/enqueue.ts";
const WORKER_INDEX = "services/worker/src/index.ts";
const SUBSYSTEM = "services/worker/src/subsystem-queue-processors.ts";

// ===========================================================================
// THE 10 BULLMQ JOBS
// ===========================================================================

const BULLMQ_JOBS: ReadonlyArray<WorkRegistryEntry> = [
  // ---- FAMILY 1: REDACTION -------------------------------------------------
  {
    workName: JOB_NAMES.RENDER_REDACTION_DERIVATIVE,
    family: "redaction",
    familyReason:
      "Renders the redacted derivative of an approved redaction version; the entire job is the redaction product.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.REDACTION_DERIVATIVE,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "rd",
    durableAuthority: {
      model: "RedactionDerivative",
      tenantSource: "RedactionDerivative.teamId, cross-checked against version.project.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor:
      "services/worker/src/redaction/redaction-derivative.processor.ts",
    workerRegistration: WORKER_INDEX,
    claim: {
      from: "QUEUED",
      to: "RENDERING",
      mechanism: "conditional_update_many",
      // RedactionDerivative.renderStartedAt — the column the claim writes and the
      // lease (ET-Q-04) reads; renderStartedAtUtc is a legacy column nothing writes.
      leaseField: "renderStartedAt",
      leaseMs: 20 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/redaction/redaction-derivative-writer.ts",
    idempotency: ["deterministic_job_id", "conditional_state_claim"],
    reconciler: WORKER_INDEX,
    retry: RETRY_POLICIES.HEAVY_RENDER,
    recovery: RECOVERY_POLICIES.HEAVY_RENDER,
    externalBoundary: "storage",
    auditFamily: "redaction.derivative",
    projection: "GET /v1/redaction/derivatives/:id",
  },

  // ---- FAMILY 3: RETENTION AND DESTRUCTION ---------------------------------
  {
    workName: JOB_NAMES.PURGE_DELETED_EVIDENCE,
    family: "retention_destruction",
    familyReason:
      "Hard-deletes Evidence rows and their storage objects after the soft-delete grace window; irreversible data destruction.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.EVIDENCE_PURGE,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "evidence-purge",
    durableAuthority: {
      model: "Evidence",
      // ET-Q-07 (2026-09-30) — this said "null fails closed". It does not, and
      // must not: a legacy personal record has `team_id = NULL` and is still
      // owed its purge. The processor reads the row by id and passes
      // `teamId ?? null` to the two authorities that ARE fail-closed — the
      // effective legal-hold evaluator and the destruction-approval resolver
      // (a NULL-team record resolves through its owner). The refusal lives in
      // those, not in a null check on this column.
      tenantSource:
        "Evidence row loaded by id; Evidence.teamId (nullable for legacy personal records) is read from that row and handed to the legal-hold and destruction-approval authorities, which fail closed. A NULL team does not by itself refuse the job",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/processor.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — corrected to the real mechanism. `Evidence` has no QUEUED or
    // PROCESSING state, and no conditional claim existed. What arbitrates is
    // the deterministic job id (one live `evidence-purge:<id>` at a time,
    // held by BullMQ's job lock); the last-line guard is a re-read of
    // `deletedAt` INSIDE the destruction transaction, which turns a loser
    // into a bounded no-op instead of a foreign-key crash.
    claim: {
      from: "deletedAt set",
      to: "row removed",
      mechanism: "row_lock_in_transaction",
      leaseField: null,
      leaseMs: null,
    },
    terminalWriter: "services/worker/src/processor.ts",
    idempotency: ["deterministic_job_id"],
    /*
     * GOVERNANCE CLOSURE (2026-09-09) — CORRECTED TO THE MODULE THAT ACTUALLY
     * RECOVERS THIS WORK.
     *
     * This said `lifecycle-recovery.ts`, which contains no purge code at all —
     * a grep for "purge" in that module returns nothing. The claim was the same
     * class of untruth this field carried for UPGRADE_OTS before it was fixed:
     * a recovery authority asserted for a chain that module cannot see.
     *
     * The recovery is real, it simply lives elsewhere. `trash-grace-reconciler`
     * scans `lifecycleState: "TRASHED"` rows whose `deleteScheduledForUtc` has
     * passed and enqueues the purge; a row stays TRASHED until the purge job
     * actually tombstones it, so a lost enqueue is picked up by the next tick
     * rather than stranding. Nothing is added here — the field is pointed at
     * the owner that was always doing the work.
     */
    reconciler: "services/worker/src/governance/trash-grace-reconciler.ts",
    retry: RETRY_POLICIES.DESTRUCTIVE,
    recovery: RECOVERY_POLICIES.DESTRUCTIVE,
    externalBoundary: "storage",
    auditFamily: "evidence.purge",
    projection: "GET /v1/evidence/:id",
  },

  // ---- FAMILY 4: REPORTS AND PACKAGES --------------------------------------
  {
    workName: JOB_NAMES.GENERATE_REPORT,
    family: "reports_packages",
    familyReason:
      "Generates the signed evidence report PDF artifact; the canonical report product.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.REPORT,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "report",
    durableAuthority: {
      model: "ReportGenerationRequest",
      tenantSource: "ReportGenerationRequest.teamId, cross-checked against Evidence.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/processor.ts",
    workerRegistration: WORKER_INDEX,
    claim: {
      from: "QUEUED",
      to: "PROCESSING",
      mechanism: "conditional_update_many",
      leaseField: "claimedAtUtc",
      leaseMs: 15 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/processor.ts",
    idempotency: [
      "deterministic_job_id",
      "conditional_state_claim",
      "upsert_by_natural_key",
    ],
    // RELIABILITY CLOSURE (2026-09-09) — the field was already right; the
    // MODULE was not.
    //
    // lifecycle-recovery recovered only a FIRST generation, by scanning
    // EVIDENCE for records SIGNED with no Report row. The request-shaped
    // failures — a stranded regeneration, an expired PROCESSING lease, an
    // exhausted attempt ceiling — were covered by `reconcileStrandedReportRequests`,
    // which was written for exactly them and had NO production caller: its
    // only reference was a test that invoked it directly. It now runs inside
    // this sweep, so the claim below is true rather than half true, and there
    // is one authority over "does every record owed a report have scheduled
    // work" instead of two free to disagree.
    reconciler: "services/worker/src/lifecycle-recovery.ts",
    retry: RETRY_POLICIES.ARTIFACT,
    recovery: RECOVERY_POLICIES.ARTIFACT,
    externalBoundary: "storage",
    auditFamily: "report.generation",
    projection: "GET /v1/evidence/:id/report/latest",
  },

  // ---- FAMILY 7: EVIDENCE FINALIZATION -------------------------------------
  {
    workName: JOB_NAMES.UPGRADE_OTS,
    family: "evidence_finalization",
    familyReason:
      "Completes the evidence record's timestamp proof: upgrades the OpenTimestamps attestation from pending to Bitcoin-anchored and appends the resulting custody material. It mutates Evidence integrity state, not derived intelligence, so it finalizes the record rather than analysing it.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.OTS_UPGRADE,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "ots-upgrade",
    durableAuthority: {
      model: "Evidence",
      // ET-Q-07 (2026-09-30) — this said "null fails closed". The processor
      // has no such refusal and needs none: it reads ONE row by id and writes
      // only that row's OTS columns, so there is no tenant scope for a wrong
      // value to widen. `teamId` is selected solely to scope the incident and
      // log context, as `teamId ?? null`. A legacy personal record with a NULL
      // team is anchored like any other — refusing it would leave it
      // permanently unanchored for no safety gain.
      tenantSource:
        "Evidence row loaded by id. The job is not tenant-scoped: it reads and writes only that row's OTS columns. Evidence.teamId (nullable) is read only to scope incident and log context; a NULL team does not refuse the work",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/ots-upgrade.processor.ts",
    workerRegistration: WORKER_INDEX,
    // ET-Q-07 (2026-09-30) — this declared `QUEUED -> PROCESSING`. The OTS
    // status column has neither value (it holds DISABLED / PENDING / ANCHORED /
    // FAILED) and nothing claims a row before working on it. What arbitrates
    // is a COMPARE-AND-SET at the end: `applyOtsTransition` in `ots-state.ts`
    // updates the row only `WHERE` it still holds exactly the OTS facts the
    // decision was computed from (`otsSnapshotWhere`), so of two workers that
    // raced, one write lands and the other matches zero rows and records
    // nothing. There is no lease because there is no in-progress state.
    claim: {
      from: "PENDING",
      to: "ANCHORED / FAILED / PENDING",
      mechanism: "conditional_update_many",
      leaseField: null,
      leaseMs: null,
    },
    terminalWriter: "services/worker/src/ots-state.ts",
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    // RELIABILITY CLOSURE (2026-09-09) — THIS FIELD WAS FALSE. It named
    // lifecycle-recovery, which contains no OTS code whatsoever: a grep for
    // "ots" in that module returns nothing. So the registry asserted a recovery
    // authority for the never-attempted population that did not exist, and the
    // population itself was invisible to Operations because the integrity scan
    // selects only FAILED and the PENDING family. Governance metadata that
    // claims coverage nobody wrote is worse than none.
    // RELIABILITY CLOSURE (2026-09-09) — THIS FIELD WAS FALSE AND IS NOW TRUE.
    //
    // It named lifecycle-recovery, and that module contained no OTS code
    // whatsoever: a grep for "ots" returned nothing. So the registry asserted a
    // recovery authority for the never-attempted population that did not exist,
    // and the population itself was invisible to Operations because the
    // integrity scan selects only FAILED and the PENDING family.
    //
    // The claim was not repointed — the module was made to keep it. Evidence
    // finalization fans out TWO pieces of follow-up work, a report request and
    // OTS anchoring, and this sweep exists to close the commit-to-enqueue
    // window for finalization. It now recovers both, through
    // `ots-initialization-reconciler.ts`, because "a finalized record whose
    // follow-up work never got scheduled" is one responsibility and must not
    // have two authorities.
    reconciler: "services/worker/src/lifecycle-recovery.ts",
    retry: RETRY_POLICIES.TIMESTAMP_AUTHORITY,
    recovery: RECOVERY_POLICIES.ARTIFACT,
    externalBoundary: "timestamp_authority",
    auditFamily: "evidence.ots_upgrade",
    projection: "GET /v1/evidence/:id",
  },

  // ---- FAMILY 8: RECONCILIATION --------------------------------------------
  {
    workName: JOB_NAMES.REBUILD_SEARCH_DOCUMENT,
    family: "reconciliation",
    familyReason:
      "Converges the search projection toward the source rows. It derives nothing new — it re-derives an existing projection — which is reconciliation, not intelligence.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.SEARCH_INDEXING,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "search-index",
    durableAuthority: {
      model: "EvidenceSearchDocument (source entity)",
      tenantSource: "source entity row loaded by id; null teamId fails closed",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/search-indexing.processor.ts",
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: "services/worker/src/search-indexing.processor.ts",
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.PROJECTION,
    recovery: RECOVERY_POLICIES.PROJECTION,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/search",
  },
  // ET-Q-07 (2026-09-30) — `IndexMediaIntelligence` (`mi-search-index`) was
  // REMOVED from this registry with its queue, enqueue helper, processor,
  // worker registration and legacy adapter. It was a thin shim that re-enqueued
  // onto `search-indexing`, and nothing ever enqueued IT: `enqueueMiSearchIndexJob`
  // had zero callers in every commit. Media-intelligence output reaches the
  // search projection through `RebuildSearchDocument` above, which is the one
  // search-document authority and always was.
  {
    workName: JOB_NAMES.RECONCILE_TEAM_GRAPH,
    family: "reconciliation",
    familyReason:
      "Rebuilds the workspace intelligence graph from authoritative rows; a bounded per-workspace reconciliation run.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.GRAPH_RECONCILE,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "graph-reconcile",
    durableAuthority: {
      model: "Team",
      tenantSource: "Team row loaded by id; missing or non-ACTIVE fails closed",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: SUBSYSTEM,
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: SUBSYSTEM,
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    // ET-Q-07 (2026-09-30) — THIS FIELD WAS FALSE. It named
    // `search-index-reconciler.ts`, a module whose only recovery is
    // re-enqueueing EVIDENCE SEARCH DOCUMENTS (`enqueueSearchIndexingJob({
    // kind: "evidence" })`). It never reads a graph table and never enqueues a
    // graph reconcile, so a lost `graph-reconcile` enqueue is recovered by
    // nothing: the graph stays as it was until the next evidence event or an
    // operator's `POST /v1/graph/reconcile` happened to ask again.
    //
    // IT IS TRUE NOW, because the module was made to keep it rather than the
    // field being repointed. `reconcileStrandedGraphProjections` in that file
    // compares `evidence` with `investigation_graph_nodes`: a finalized record
    // with no live EVIDENCE node is a workspace whose graph is owed a rebuild,
    // and it re-enqueues one for each ACTIVE Team (joined through `teams` /
    // `organizations`, the same condition the processor applies) through the
    // canonical producer, under the same job id as the API.
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/intelligence/graph",
  },
  // ET-Q-07 (2026-09-30) — `SyncTeamGraphDomain` (`graph-domain-sync`) and
  // `SyncTeamGraphTimeline` (`graph-timeline-sync`) were REMOVED from this
  // registry with their queues, enqueue helpers, processors, worker
  // registrations and legacy adapters. Both were marked CURRENT_RUNTIME and
  // both had a real processor body — and no producer: `enqueueGraphDomainSyncJob`
  // and `enqueueGraphTimelineSyncJob` had zero callers in every commit, so the
  // per-domain stale sweep and the timeline sync they wrapped never ran in
  // production. The graph is rebuilt by `ReconcileTeamGraph` above, whose
  // builder performs its own stale sweep.
  {
    workName: JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION,
    family: "reconciliation",
    familyReason:
      "Refreshes graph-derived hints on the search projection for a workspace; projection convergence.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.GRAPH_SEARCH_PROJECTION,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "graph-search-projection",
    durableAuthority: {
      model: "Team",
      tenantSource: "Team row loaded by id; missing or non-ACTIVE fails closed",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: SUBSYSTEM,
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: SUBSYSTEM,
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    // ET-Q-07 (2026-09-30) — THIS FIELD WAS FALSE, for the same reason as
    // `ReconcileTeamGraph` above: `search-index-reconciler.ts` compares an
    // Evidence row with its search document and knows nothing about graph
    // signals. This job's only producer is the `graph-reconcile` processor's
    // `onReconciled` hook (best-effort, `.catch(() => null)`), so a lost enqueue
    // was made good only by the NEXT graph reconcile of that workspace — and
    // only for signals that changed within the trigger's sixty-minute window.
    //
    // IT IS TRUE NOW. This job is a fan-out trigger: for one Team it finds the
    // records whose signals changed and enqueues their search rebuild.
    // `reconcileStaleSignalProjections` in that file recovers the EFFECT from
    // the durable fact the trigger reads — a `media_intelligence_signals` row
    // newer than the record's `evidence_search_documents.indexed_at_utc` — and
    // re-enqueues the same rebuild, with no window and no dependence on the
    // trigger having run. The workspace is read from the record's own
    // `team_id`.
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/search",
  },
  // ET-Q-07 (2026-09-30) — `RefreshOrgHealthProjection` (`org-health-refresh`)
  // was REMOVED from this registry with its queue, enqueue helper, processor,
  // worker registration and legacy adapter. `enqueueOrgHealthRefreshJob` had
  // zero callers, so the "refreshed every 30-90s by the worker" the schema
  // comment promised never happened. The projection row is written by the
  // read-time refresh in the api (`command-center.service.ts` ->
  // `refreshOrgHealthProjection` in @proovra/shared-runtime), which is the one
  // writer and is unchanged.

  // ---- FAMILY 9: INTELLIGENCE AND OPERATIONS -------------------------------
  {
    workName: JOB_NAMES.RUN_MEDIA_INTELLIGENCE,
    family: "intelligence_operations",
    familyReason:
      "Runs a media-intelligence extraction (metadata, OCR, transcript, perceptual hash) against evidence bytes, gated by AI policy and spend budget.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.MEDIA_INTELLIGENCE,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "mi-run",
    durableAuthority: {
      model: "MediaIntelligenceRun",
      tenantSource: "MediaIntelligenceRun.teamId, cross-checked against Evidence.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/media-intelligence.processor.ts",
    workerRegistration: WORKER_INDEX,
    // ET-Q-07 (2026-09-30) — this declared `QUEUED -> RUNNING`. A
    // `MediaIntelligenceRun` has neither status. `markRunProcessing`
    // (run-tracker.service.ts) claims with one conditional UPDATE from PENDING
    // or FAILED — or from PROCESSING whose `started_at_utc` is past the lease —
    // to PROCESSING, stamping the lease. The reconciler's sibling entry carried
    // the same two invented names; both now use the ones the column holds.
    claim: {
      from: "PENDING / FAILED",
      to: "PROCESSING",
      mechanism: "conditional_update_many",
      leaseField: "startedAtUtc",
      leaseMs: 20 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/media-intelligence.processor.ts",
    idempotency: ["deterministic_job_id", "conditional_state_claim"],
    reconciler: "services/worker/src/intelligence-run-reconciler.ts",
    retry: RETRY_POLICIES.HEAVY_RENDER,
    recovery: RECOVERY_POLICIES.HEAVY_RENDER,
    externalBoundary: "ai_provider",
    auditFamily: "intelligence.media_run",
    projection: "GET /v1/evidence/:id/media-intelligence",
  },
  // ET-Q-07 (2026-09-30) — `ExtractExif` (`mi-exif`) was REMOVED from this
  // registry with its queue, enqueue helper, dedicated entry point
  // (`processExifQueueJob`), worker registration and legacy adapter.
  // `enqueueExifJob` had zero callers in every commit, so the dedicated queue
  // never carried a job. EXIF extraction is unaffected: it runs — as it always
  // actually did — under `RunMediaIntelligence` above, on run kind
  // `extract_exif`, against a durable `MediaIntelligenceRun`.
  //
  // PHASE 12 POINT 5 — `ExtractOcr` (`mi-ocr`) and `ExtractTranscript`
  // (`mi-transcript`) were REMOVED from this registry, and their queues,
  // producers, processors and worker registrations were deleted.
  //
  // They declared `EvidencePart` as a durable authority they never wrote to,
  // an `ai_provider` boundary they never called and a reconciler that has no
  // way to find their work. What actually ran was a log line —
  // `not_configured_completed` — returned as success. Meanwhile OCR and
  // transcript extraction genuinely run under `RunMediaIntelligence` above,
  // on run kinds `extract_ocr_azure` / `extract_transcript_deepgram`, against
  // a durable `MediaIntelligenceRun` with a claim fence, a budget gate, a
  // terminal writer and `IntelligenceRunStrandedReconciler`.
  //
  // Two authorities per capability is the condition Point 5 exists to remove,
  // and the one that was doing nothing is the one that went. There is exactly
  // ONE OCR authority and ONE transcript authority now.
  {
    workName: JOB_NAMES.GENERATE_DERIVED_ASSET,
    family: "intelligence_operations",
    familyReason:
      "Generates a derived visual asset (thumbnail, preview) from evidence bytes. It writes a NEW object alongside the original and never mutates it, which makes it derivation rather than finalization.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.DERIVED_ASSETS,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "mi-derived",
    durableAuthority: {
      // PHASE 12 POINT 5 correction. This named `MediaIntelligenceRun`, which
      // does not carry the part or the asset kind — so the payload carried
      // them, and the processor believed them. `EvidencePartDerivedAsset` is
      // the row that actually models this work, and its
      // (teamId, evidencePartId, assetKind) unique index is the idempotency
      // the job had been approximating with a job-id convention.
      model: "EvidencePartDerivedAsset",
      tenantSource:
        "EvidencePartDerivedAsset.teamId (row committed by the authorized route after proving the part is in that workspace)",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/derived-assets.processor.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — corrected to the real mechanism. This declared a
    // `conditional_update_many` from PENDING to PENDING with a 20-minute lease
    // on `updatedAtUtc`. No such update exists in the processor and there is no
    // lease: the entry described an intention.
    //
    // What actually arbitrates is three things acting together — one live job
    // per asset (deterministic job id), one row per
    // (teamId, evidencePartId, assetKind) (the unique index), and a
    // TERMINAL-STATUS replay guard that refuses to re-run a settled asset.
    // That guard was itself broken until this pass: it tested for `READY`, a
    // status the DB CHECK forbids, so it never fired.
    claim: {
      from: "PENDING",
      to: "COMPLETED / FAILED / UNSUPPORTED",
      mechanism: "row_lock_in_transaction",
      leaseField: null,
      leaseMs: null,
    },
    terminalWriter: "services/worker/src/derived-assets.processor.ts",
    idempotency: ["deterministic_job_id", "unique_constraint"],
    // ET-Q-07 (2026-09-30) — THIS FIELD WAS FALSE. It named
    // `intelligence-run-reconciler.ts`, whose scans key on
    // `MediaIntelligenceRun` (leases, stranded PENDING runs) and on
    // `EvidenceSemanticChunk.embedding IS NULL`. It never reads
    // `EvidencePartDerivedAsset`, so a derived-asset row whose enqueue was lost
    // stays PENDING forever and the module the registry pointed an operator at
    // could not have found it.
    //
    // IT IS TRUE NOW. `reconcileStrandedDerivedAssets` (step 4 of that module's
    // tick) scans `evidence_part_derived_assets` for rows PENDING past the
    // stranded threshold on live evidence, claims each with a conditional
    // update and re-enqueues it through the canonical producer under the same
    // job id the API uses. A row still PENDING after the recovery ceiling is
    // settled FAILED for an operator rather than retried forever.
    reconciler: "services/worker/src/intelligence-run-reconciler.ts",
    retry: RETRY_POLICIES.HEAVY_RENDER,
    recovery: RECOVERY_POLICIES.HEAVY_RENDER,
    externalBoundary: "storage",
    auditFamily: "evidence.derived_asset",
    projection: "GET /v1/evidence/:id/derived-assets",
  },
  {
    workName: JOB_NAMES.EMBED_SEMANTIC_CHUNKS,
    family: "intelligence_operations",
    familyReason:
      "Computes embedding vectors for semantic chunks via an AI provider under a per-workspace spend budget.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.MI_EMBED,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "mi-embed",
    durableAuthority: {
      model: "EvidenceSemanticChunk",
      tenantSource:
        "EvidenceSemanticChunk.teamId (anchor chunk loaded by id; the batch is then selected from unembedded chunks in that same workspace)",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/mi-embed.processor.ts",
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: "services/worker/src/mi-embed.processor.ts",
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    reconciler: "services/worker/src/intelligence-run-reconciler.ts",
    retry: RETRY_POLICIES.HEAVY_RENDER,
    recovery: RECOVERY_POLICIES.HEAVY_RENDER,
    externalBoundary: "ai_provider",
    auditFamily: "intelligence.embedding_run",
    projection: "GET /v1/search?mode=semantic",
  },
];

// ===========================================================================
// THE 2 DLQ SINKS
// ===========================================================================

export type DlqSink = {
  queueName: QueueName;
  family: QueueFamily;
  /** The queue whose exhausted jobs land here. */
  sourceQueue: QueueName;
  /** Where an operator triages the sink. */
  projection: string;
};

export const DLQ_SINKS: ReadonlyArray<DlqSink> = [
  {
    queueName: QUEUE_NAMES.REPORT_DLQ,
    family: "reports_packages",
    sourceQueue: QUEUE_NAMES.REPORT,
    projection: "GET /v1/operations/queues/report-dlq",
  },
  {
    queueName: QUEUE_NAMES.MEDIA_INTELLIGENCE_DLQ,
    family: "intelligence_operations",
    sourceQueue: QUEUE_NAMES.MEDIA_INTELLIGENCE,
    projection: "GET /v1/operations/queues/media-intelligence-dlq",
  },
];

// ===========================================================================
// THE 20 DB-OUTBOX SWEEPS
// ===========================================================================

const DB_SWEEPS: ReadonlyArray<WorkRegistryEntry> = [
  // ---- FAMILY 1: REDACTION -------------------------------------------------
  {
    workName: SWEEP_NAMES.REDACTION_RECONCILER,
    family: "redaction",
    familyReason:
      "Re-enqueues redaction derivatives left QUEUED when a producer committed the row and then failed to enqueue.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "RedactionDerivative",
      tenantSource: "RedactionDerivative.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: WORKER_INDEX,
    workerRegistration: WORKER_INDEX,
    claim: {
      from: "QUEUED",
      to: "QUEUED",
      mechanism: "conditional_update_many",
      // RedactionDerivative.renderStartedAt — the column the claim writes and the
      // lease (ET-Q-04) reads; renderStartedAtUtc is a legacy column nothing writes.
      leaseField: "renderStartedAt",
      leaseMs: 20 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/redaction/redaction-derivative-writer.ts",
    idempotency: ["deterministic_job_id", "conditional_state_claim"],
    reconciler: WORKER_INDEX,
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.HEAVY_RENDER,
    externalBoundary: null,
    auditFamily: "redaction.derivative",
    projection: "GET /v1/redaction/derivatives",
  },

  // ---- FAMILY 2: INVITE DELIVERY -------------------------------------------
  {
    workName: SWEEP_NAMES.ORG_INVITE_DELIVERY,
    family: "invite_delivery",
    familyReason:
      "Retries due organization-invite email deliveries with token rotation; the invite delivery outbox.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      // Reuse, not rebuild: org-invite delivery rides the existing Phase-8
      // NotificationDelivery outbox, discriminated by
      // eventType = "org_invite_delivery". The row carries only
      // { inviteId, organizationId } — never a token, never an accept URL,
      // because invite tokens exist only as SHA-256 hashes and every retry
      // MINTS A NEW token in memory.
      model: "NotificationDelivery",
      tenantSource:
        "NotificationDelivery.metadata.inviteId -> OrganizationInvite.organizationId",
      createdBySynchronousPath: true,
    },
    canonicalProducer:
      "services/api/src/services/organization/org-invite-delivery.service.ts",
    canonicalProcessor:
      "services/api/src/services/organization/org-invite-delivery.service.ts",
    workerRegistration: "services/worker/src/org-invite-delivery.worker.ts",
    claim: {
      from: "PENDING",
      to: "PENDING",
      mechanism: "conditional_update_many",
      leaseField: "nextAttemptAtUtc",
      leaseMs: 5 * 60 * 1000,
    },
    terminalWriter:
      "services/api/src/services/organization/org-invite-delivery.service.ts",
    idempotency: ["conditional_state_claim", "provider_idempotency_key"],
    reconciler:
      "services/api/src/services/organization/org-invite-delivery.service.ts",
    retry: RETRY_POLICIES.EMAIL_DELIVERY,
    recovery: RECOVERY_POLICIES.EXTERNAL_DELIVERY,
    externalBoundary: "email",
    auditFamily: "identity.invite_delivery",
    projection: "GET /v1/organizations/:id/invites",
  },

  // ---- FAMILY 3: RETENTION AND DESTRUCTION ---------------------------------
  {
    workName: SWEEP_NAMES.DESTRUCTION_ORCHESTRATOR,
    family: "retention_destruction",
    familyReason:
      "Executes approved destruction requests: deletes storage objects and writes the destruction certificate.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "DestructionExecution",
      tenantSource: "DestructionExecution.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer:
      "services/api/src/services/lifecycle/destruction-governance.service.ts",
    canonicalProcessor:
      "services/worker/src/governance/destruction-orchestrator.worker.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — this described an intention until 20271115000000 supplied
    // `destruction_executions_active_review_uniq`. The INSERT is now the
    // claim: one non-terminal execution per review, arbitrated by the index,
    // with `startedAtUtc` as the lease a dead owner's slot is recovered from.
    claim: {
      from: "PLANNED",
      to: "EXECUTING",
      mechanism: "unique_execution_constraint",
      leaseField: "startedAtUtc",
      leaseMs: 30 * 60 * 1000,
    },
    terminalWriter:
      "services/worker/src/governance/destruction-orchestrator.worker.ts",
    idempotency: ["unique_constraint", "conditional_state_claim"],
    // ET-Q-07 (2026-09-30) — this named `retention-reconciliation.worker.ts`,
    // which never reads a `DestructionExecution`: it repairs the REVIEW pointer
    // on evidence (`activeDestructionReviewId`). The recovery of THIS entry's
    // authority — an execution left EXECUTING by a dead owner — is the
    // expired-lease takeover in `claimDestructionExecution`, in the orchestrator
    // itself: a conditional update pinned to the observed `startedAtUtc`.
    reconciler:
      "services/worker/src/governance/destruction-orchestrator.worker.ts",
    retry: RETRY_POLICIES.DESTRUCTIVE,
    recovery: RECOVERY_POLICIES.DESTRUCTIVE,
    externalBoundary: "storage",
    auditFamily: "governance.destruction",
    projection: "GET /v1/governance/destruction-requests",
  },
  {
    workName: SWEEP_NAMES.RETENTION_RECONCILIATION,
    family: "retention_destruction",
    familyReason:
      "Generates retention candidates and recovers stranded destruction executions; the retention side of the destructive lifecycle.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "GovernanceReconciliationRun",
      tenantSource: "GovernanceReconciliationRun.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: "packages/shared-runtime/src/reconciliation-run.ts",
    canonicalProcessor:
      "services/worker/src/governance/retention-reconciliation.worker.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — the run lock is `governance_reconciliation_runs_running_lock_uniq`
    // on (kind, lock_key) WHERE status = 'RUNNING'. The lease is one hour,
    // matching `RUN_LOCK_LEASE_MS`; the module's former "advisory lock" was a
    // comment, never code, so `advisory_lock` is removed from the strategy
    // list rather than left as an aspiration.
    // POINT 5 — corrected AGAIN, and this time against the enum.
    // `GovernanceReconciliationStatus` is RUNNING / SUCCEEDED / FAILED /
    // PARTIAL: there is no QUEUED, so a transition FROM it never happened and
    // never could. `runGovernanceReconciliation` INSERTs the row directly in
    // RUNNING and the partial unique index on (kind, lock_key) WHERE
    // status = 'RUNNING' is what refuses the second caller. The lease is one
    // hour, matching `RUN_LOCK_LEASE_MS`, and recovers a run whose owner died.
    claim: {
      from: "none",
      to: "RUNNING",
      mechanism: "unique_execution_constraint",
      leaseField: "startedAtUtc",
      leaseMs: 60 * 60 * 1000,
    },
    terminalWriter: "packages/shared-runtime/src/reconciliation-run.ts",
    idempotency: ["unique_constraint"],
    reconciler: "packages/shared-runtime/src/reconciliation-run.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: "governance.reconciliation",
    projection: "GET /v1/governance/reconciliation-runs",
  },
  {
    workName: SWEEP_NAMES.TRASH_GRACE_RECONCILER,
    family: "retention_destruction",
    familyReason:
      "Scans trashed evidence whose recovery grace has elapsed and evaluates canonical destruction eligibility; the producer side of the destructive lifecycle.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    // The durable authority is the Evidence row. `lifecycle_state = TRASHED`
    // plus `delete_scheduled_for_utc` IS the work item; the synchronous
    // lifecycle service commits it when a user moves a record to trash. There
    // is no separate outbox table because there is no separate fact.
    durableAuthority: {
      model: "Evidence",
      tenantSource: "Evidence.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer:
      "services/api/src/services/evidence/evidence-lifecycle.service.ts",
    canonicalProcessor:
      "services/worker/src/governance/trash-grace-reconciler.ts",
    workerRegistration: WORKER_INDEX,
    // The sweep itself claims NOTHING and mutates no lifecycle state — that is
    // deliberate, and it is why the claim describes the DESTRUCTION claim it
    // hands off to. Its only mutations are an idempotent destruction-review
    // creation (guarded by `Evidence.activeDestructionReviewId`) and an
    // enqueue. The irreversible claim belongs to the canonical executor:
    // TRASHED -> PENDING_DESTRUCTION with a lease stamp, so a crashed executor
    // is recoverable and two executors cannot both delete the same keys.
    claim: {
      from: "TRASHED",
      to: "PENDING_DESTRUCTION",
      mechanism: "conditional_update_many",
      leaseField: "destructionClaimedAtUtc",
      leaseMs: 30 * 60 * 1000,
    },
    terminalWriter:
      "packages/shared-runtime/src/evidence-destruction/executor.ts",
    idempotency: ["deterministic_job_id", "unique_constraint"],
    reconciler: "services/worker/src/governance/trash-grace-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: "storage",
    auditFamily: "governance.destruction",
    projection: "GET /v1/evidence/:id",
  },
  {
    workName: SWEEP_NAMES.ARCHIVE_AUTO_TRANSITION,
    family: "retention_destruction",
    familyReason:
      "Transitions evidence storage to the archive tier on the retention schedule; a retention lifecycle mutation.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "Evidence",
      tenantSource: "Evidence.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor:
      "services/worker/src/governance/archive-tier-auto-transition.worker.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — corrected to the real mechanism. `Evidence` has no `QUEUED`
    // state and no `startedAtUtc`: the claimed transition never existed. What
    // actually arbitrates is the ArchiveTierTransition row — the INSERT wins
    // or is refused by `archive_tier_transitions_active_evidence_uniq`, which
    // permits one non-terminal transition per record. There is no lease: a
    // transition is terminal (COMPLETED / FAILED) or in flight.
    claim: {
      from: "none",
      to: "PENDING",
      mechanism: "unique_execution_constraint",
      leaseField: null,
      leaseMs: null,
    },
    terminalWriter:
      "services/worker/src/governance/archive-tier-auto-transition.worker.ts",
    idempotency: ["unique_constraint"],
    reconciler:
      "services/worker/src/governance/retention-reconciliation.worker.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: "storage",
    auditFamily: "governance.archive_transition",
    projection: "GET /v1/evidence/:id",
  },
  {
    workName: SWEEP_NAMES.CAPTURE_DRAFT_REAPER,
    family: "retention_destruction",
    familyReason:
      "Expires capture drafts past their expiry, ends direct-capture sessions that outlived theirs and releases the evidence reservations they and abandoned uploads were holding; bounded destruction of abandoned pre-evidence state.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "CaptureSession",
      tenantSource: "CaptureSession.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/capture-reaper.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — corrected to the real mechanism. `CaptureSession` has no
    // QUEUED/RUNNING states and `expiresAtUtc` is the draft's expiry, not a
    // lease. The claim is the conditional UPDATE from DRAFT to EXPIRED; the
    // caller that gets `count === 1` is the one that writes the audit event,
    // which is what stopped two reapers appending two EXPIRED events for one
    // expiry.
    //
    // ET-SM-07 / ET-DC-05 (2026-09-30) — BROUGHT UP TO WHAT THE SWEEP DOES NOW.
    // The scheduler calls ONE function, `runCaptureReaperSweep`: a recorded run
    // (GovernanceReconciliationRun kind CAPTURE_REAPER — one run at a time, with
    // a lease a crashed run frees) that pages two passes. The first is the draft
    // expiry above. The second, `releaseExpiredReservations`, claims a
    // direct-capture session still ACTIVE or INTERRUPTED past its expiry as
    // EXPIRED under the session's advisory lock, and releases the evidence
    // reservation it held — and the reservation of an unsealed record nothing
    // holds open — through the shared reservation authority
    // (`releaseEvidenceReservationTx`). So the claim has three source states,
    // not one, and the same conditional-update mechanism for all of them.
    //
    // `CaptureSession` remains the headline authority: it is what is claimed.
    // The released reservation lives on the Evidence record and is written only
    // through that shared authority, never directly here. The storage keys of a
    // released reservation are deleted best-effort AFTER commit through an
    // injected deleter; the release is the record's truth whatever that delete
    // returns, which is why storage is not declared as this unit's boundary.
    claim: {
      from: "DRAFT / ACTIVE / INTERRUPTED",
      to: "EXPIRED",
      mechanism: "conditional_update_many",
      leaseField: null,
      leaseMs: null,
    },
    terminalWriter: "services/worker/src/capture-reaper.ts",
    idempotency: ["conditional_state_claim"],
    reconciler: "services/worker/src/capture-reaper.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: "capture.draft_expiry",
    projection: "GET /v1/capture/sessions",
  },
  {
    workName: SWEEP_NAMES.MFA_CHALLENGE_GC,
    family: "retention_destruction",
    familyReason:
      "Deletes expired MFA challenge rows; bounded destruction of short-lived security state.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "MfaPendingChallenge",
      tenantSource:
        "MfaPendingChallenge.userId — challenge rows are user-scoped, not workspace-scoped, so there is no tenant to derive and none is accepted",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/mfa-challenge-gc.ts",
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: "services/worker/src/mfa-challenge-gc.ts",
    idempotency: ["upsert_by_natural_key"],
    reconciler: "services/worker/src/mfa-challenge-gc.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/security/mfa",
  },

  // ---- FAMILY 4: REPORTS AND PACKAGES --------------------------------------
  {
    workName: SWEEP_NAMES.EXCHANGE_PACKAGE_BUILDER,
    family: "reports_packages",
    familyReason:
      "Builds queued evidence-exchange packages into signed artifacts; the package side of the artifact family.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "EvidenceExchangePackageBuild",
      tenantSource: "EvidenceExchangePackageBuild.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: "services/worker/src/exchange-package-builder.ts",
    canonicalProcessor: "services/worker/src/exchange-package-builder.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — implemented. The poller's only guard was an in-process `Set`,
    // which is per-process and therefore no guard at all across two worker
    // instances. `claimPackageBuild` is a conditional
    // `ON CONFLICT ... DO UPDATE ... WHERE` against the UNIQUE on package_id,
    // with `started_at_utc` as the lease.
    claim: {
      from: "not BUILDING, or lease expired",
      to: "BUILDING",
      mechanism: "conditional_update_many",
      leaseField: "startedAtUtc",
      // Matches EXCHANGE_BUILD_LEASE_MS. The registry recorded 20 minutes for
      // a lease that did not exist at all.
      leaseMs: 30 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/exchange-package-builder.ts",
    idempotency: ["conditional_state_claim", "unique_constraint"],
    reconciler: "services/worker/src/exchange-package-builder.ts",
    retry: RETRY_POLICIES.ARTIFACT,
    recovery: RECOVERY_POLICIES.ARTIFACT,
    externalBoundary: "storage",
    auditFamily: "exchange.package_build",
    projection: "GET /v1/exchange/packages/:id",
  },

  // ---- FAMILY 5: WEBHOOKS AND PROVIDERS ------------------------------------
  {
    /**
     * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
     *
     * The ONE Automation execution authority. Before it, `AutomationRun` rows
     * were created and executed synchronously inside an API request by a
     * dispatcher with zero production callers, and webhook delivery rode an
     * in-process `setImmediate`. There was no producer, no claim, no fence, no
     * retry that survived a restart and no reconciler.
     *
     * The run row IS the outbox row: `enqueueAutomationTrigger` writes it
     * inside the caller's source transaction, so a rolled-back domain change
     * leaves no run and a committed one can never be lost. Everything after
     * that — claim, execute, retry, dead-letter, reconcile — belongs to this
     * sweep and to nothing else.
     */
    workName: SWEEP_NAMES.AUTOMATION_DISPATCH,
    family: "webhooks_providers",
    familyReason:
      "Claims committed AutomationRun rows under a lease/fence and executes their bounded action, whose external boundary is the signed outbound webhook; retries, dead-letters and reconciles stranded runs.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "AutomationRun",
      // The tenant is never taken from a job payload — there is no payload.
      // The row itself carries `team_id`, written from the source
      // transaction's own already-authorized tenant.
      tenantSource: "AutomationRun.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer:
      "services/api/src/services/automation/automation-outbox.service.ts",
    /**
     * The processor lives API-side and the worker only SCHEDULES it, over the
     * cron-secret machine endpoint — the same worker→API pattern as
     * `OrgInviteDeliverySweep` and `ReviewerReconciliationSweep`, and for the
     * same reason: the seven bounded action handlers reach the notification,
     * reviewer-assignment and comment authorities, which live in the API. A
     * worker-side copy of them would be a second authority for every one.
     */
    canonicalProcessor:
      "services/api/src/services/automation/automation-dispatch-runtime.service.ts",
    workerRegistration: WORKER_INDEX,
    claim: {
      from: "PENDING",
      to: "RUNNING",
      mechanism: "conditional_update_many",
      leaseField: "leaseExpiresAtUtc",
      leaseMs: 5 * 60 * 1000,
    },
    terminalWriter:
      "services/api/src/services/automation/automation-dispatch-runtime.service.ts",
    idempotency: ["conditional_state_claim", "unique_constraint"],
    reconciler:
      "services/api/src/services/automation/automation-dispatch-runtime.service.ts",
    retry: RETRY_POLICIES.EXTERNAL_DELIVERY,
    recovery: RECOVERY_POLICIES.EXTERNAL_DELIVERY,
    externalBoundary: "webhook_http",
    auditFamily: "automation.run_execution",
    projection: "GET /v1/teams/:teamId/automation/runs",
  },
  {
    workName: SWEEP_NAMES.WEBHOOK_DISPATCHER,
    family: "webhooks_providers",
    familyReason:
      "Dispatches pending lifecycle webhook deliveries over signed HTTP with bounded retry and dead-lettering.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "LifecycleWebhookDelivery",
      tenantSource: "LifecycleWebhookDelivery.endpoint.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer:
      "services/api/src/services/packaging/webhooks/webhook-platform.service.ts",
    canonicalProcessor: "services/worker/src/webhook-dispatcher.ts",
    workerRegistration: WORKER_INDEX,
    claim: {
      from: "PENDING",
      to: "DISPATCHING",
      mechanism: "conditional_update_many",
      leaseField: "nextAttemptAtUtc",
      leaseMs: 5 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/webhook-dispatcher.ts",
    idempotency: ["conditional_state_claim", "provider_idempotency_key"],
    reconciler: "services/worker/src/webhook-dispatcher.ts",
    retry: RETRY_POLICIES.EXTERNAL_DELIVERY,
    recovery: RECOVERY_POLICIES.EXTERNAL_DELIVERY,
    externalBoundary: "webhook_http",
    auditFamily: "integrations.webhook_delivery",
    projection: "GET /v1/integrations/webhooks/deliveries",
  },

  // ---- FAMILY 6: NOTIFICATIONS ---------------------------------------------
  {
    workName: SWEEP_NAMES.MFA_RECOVERY_DIGEST,
    family: "notifications",
    familyReason:
      "Emails the periodic MFA-recovery digest to organization security contacts; an outbound notification.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "NotificationDelivery",
      tenantSource: "NotificationDelivery.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/mfa-recovery-digest.ts",
    workerRegistration: WORKER_INDEX,
    // ET-Q-07 (2026-09-30) — this declared `PENDING -> SENDING`.
    // `NotificationDeliveryStatus` has no SENDING. The lease is a conditional
    // `updateMany` that matches a delivery in PENDING or RETRY_SCHEDULED whose
    // `nextAttemptAtUtc` is due, and writes PENDING with `nextAttemptAtUtc`
    // pushed forward by `ATTEMPT_LEASE_MS` (5 min). "In flight" is that future
    // timestamp, not a status.
    claim: {
      from: "PENDING / RETRY_SCHEDULED",
      to: "PENDING",
      mechanism: "conditional_update_many",
      leaseField: "nextAttemptAtUtc",
      leaseMs: 5 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/mfa-recovery-digest.ts",
    idempotency: ["conditional_state_claim", "provider_idempotency_key"],
    reconciler: "services/worker/src/mfa-recovery-digest.ts",
    retry: RETRY_POLICIES.EMAIL_DELIVERY,
    recovery: RECOVERY_POLICIES.EXTERNAL_DELIVERY,
    externalBoundary: "email",
    auditFamily: "notifications.delivery",
    projection: "GET /v1/me/inbox",
  },
  {
    workName: SWEEP_NAMES.DEMO_FOLLOW_UP,
    family: "notifications",
    familyReason:
      "Sends scheduled follow-up emails for demo requests; an outbound notification on a durable schedule.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "DemoRequest",
      tenantSource:
        "DemoRequest is pre-tenant by nature — a prospect has no workspace — so delivery is scoped by the request row itself",
      createdBySynchronousPath: true,
    },
    // POINT 5 — corrected. This is a CROSS-SERVICE sweep: the worker's tick is
    // an HTTP client that POSTs `/v1/admin/demo-requests/follow-up/run`, and
    // the work — the claim, the provider call and the terminal write — happens
    // in the api service behind that route. Naming the worker bootstrap as the
    // processor described where the TIMER lives, not where the sweep runs, and
    // left the real executor unnamed by the registry entirely.
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/api/src/services/demo-follow-up.service.ts",
    workerRegistration: WORKER_INDEX,
    // ET-Q-07 (2026-09-30) — EVERY FIELD OF THIS CLAIM WAS INVENTED. It
    // declared `PENDING -> SENDING` with a 30-minute lease on
    // `followUpSentAtUtc`. `DemoRequest` has no such column, and its
    // `followUpStatus` is ACTIVE / PAUSED / COMPLETED / REPLIED / STOPPED — no
    // PENDING, no SENDING. The real claim (`processDueDemoFollowUps`) is a
    // conditional `updateMany` on a request that is ACTIVE with `nextFollowUpAt`
    // due, which pushes `nextFollowUpAt` forward by `FOLLOW_UP_CLAIM_LEASE_MS`
    // (10 minutes). The status does not change; the future timestamp is the
    // lease, and only the caller that matched one row may send.
    claim: {
      from: "ACTIVE",
      to: "ACTIVE",
      mechanism: "conditional_update_many",
      leaseField: "nextFollowUpAt",
      leaseMs: 10 * 60 * 1000,
    },
    terminalWriter: "services/api/src/services/demo-follow-up.service.ts",
    idempotency: ["conditional_state_claim", "provider_idempotency_key"],
    // ET-Q-07 (2026-09-30) — this named the worker bootstrap. The note above
    // already says why that is wrong for the PROCESSOR — the bootstrap is an
    // HTTP client and a timer — and it is wrong for the reconciler for the same
    // reason: `index.ts` never reads a `DemoRequest`. What recovers a follow-up
    // whose sender died is the lease above expiring, after which the same
    // function selects the request again. That is this module.
    reconciler: "services/api/src/services/demo-follow-up.service.ts",
    retry: RETRY_POLICIES.EMAIL_DELIVERY,
    recovery: RECOVERY_POLICIES.EXTERNAL_DELIVERY,
    externalBoundary: "email",
    auditFamily: "notifications.delivery",
    projection: "GET /v1/admin/demo-requests",
  },

  // ---- FAMILY 7: EVIDENCE FINALIZATION -------------------------------------
  {
    /**
     * ET-SM-07 (2026-09-30) — the scheduled integrity recheck.
     *
     * WHY THIS FAMILY. It was a choice between two, and the family definitions
     * decide it. `reconciliation` is for work that CONVERGES a projection
     * toward an authority and has no terminal state of its own — the storage
     * sibling there, `ImmutableStorageReconciliationSweep`, is described as
     * "convergence, not mutation of evidence". This sweep is the opposite on
     * both counts: what it writes is the Evidence record's own integrity state
     * (the last-checked / last-verified columns and an append-only check
     * history), and it has a terminal outcome — a digest mismatch makes the
     * record FAILED_HASH_MISMATCH and appends a custody event. That is the
     * `evidence_finalization` definition ("mutates Evidence integrity state,
     * not derived intelligence"), the family `UpgradeOts` is in for the same
     * reason: both keep the record's proof of integrity true after signing.
     */
    workName: SWEEP_NAMES.INTEGRITY_RECHECK,
    family: "evidence_finalization",
    familyReason:
      "Re-reads every signed record's original bytes at their recorded object version on a cadence and records what was found on the Evidence record itself; a digest mismatch is terminal (FAILED_HASH_MISMATCH plus a custody event). It maintains the record's integrity state rather than converging a projection.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    // The Evidence row IS the work item: signed, not DESTROYED and not
    // PENDING_DESTRUCTION, and due (never checked, older than the cadence, or
    // requested). There is no outbox table because there is no separate fact.
    // The workspace is read from the row and carried onto each history row; a
    // recheck never rewrites it, and a legacy personal record with a NULL team
    // is checked like any other and recorded with a NULL team.
    durableAuthority: {
      model: "Evidence",
      tenantSource: "Evidence.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/integrity-recheck.ts",
    workerRegistration: WORKER_INDEX,
    // THE CLAIM IS A LEASE, NOT A STATUS CHANGE, and the from/to say exactly
    // that. `claimIntegrityRecheck` is a conditional `updateMany` that matches
    // a record whose status is SIGNED or REPORTED (and which is due and not
    // held) and stamps `integrityRecheckClaimedAtUtc`. The status it matched
    // is the status it leaves: a recheck that VERIFIES changes no status at
    // all. So both sides name the two statuses the claim is restricted to —
    // they are the precondition and the postcondition — and the lease column
    // is what distinguishes "claimed" from "not claimed". The terminal move to
    // FAILED_HASH_MISMATCH on a mismatch belongs to the rejection writer, not
    // to the claim, and is named by `terminalWriter` below.
    //
    // The lease is 30 minutes (`INTEGRITY_RECHECK_CLAIM_LEASE_MS`). VERIFIED
    // and FAILED release it; UNAVAILABLE restarts it, which is the retry
    // backoff for a store that could not be read.
    claim: {
      from: "SIGNED / REPORTED",
      to: "SIGNED / REPORTED",
      mechanism: "conditional_update_many",
      leaseField: "integrityRecheckClaimedAtUtc",
      leaseMs: 30 * 60 * 1000,
    },
    // One module records the attempt and, on a mismatch, calls the rejection
    // (`recordIntegrityObservation`); `rejectEvidenceIntegrity` has no other
    // caller in the recheck path.
    terminalWriter: "services/worker/src/integrity-recheck.ts",
    // The lease claim is the arbiter: of N concurrent checkers one matches the
    // row. The rejection is idempotent on status — a record already
    // FAILED_HASH_MISMATCH is out of the eligible population, so a duplicate
    // observation of the same drift writes one rejection.
    idempotency: ["conditional_state_claim"],
    // It is its own recovery. A claim whose owner died expires after the
    // lease and the record is due again; a tick that never ran is made up by
    // the next, because due-ness is a fact on the row.
    reconciler: "services/worker/src/integrity-recheck.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    // Object storage, READ ONLY: each object is fetched at its recorded
    // VersionId. A store that cannot answer is UNAVAILABLE — never a verdict
    // on the bytes — and the record stays non-terminal and is retried.
    externalBoundary: "storage",
    auditFamily: "evidence.integrity_recheck",
    projection: "GET /public/verify/:id",
  },

  // ---- FAMILY 8: RECONCILIATION --------------------------------------------
  {
    workName: SWEEP_NAMES.LIFECYCLE_RECOVERY,
    family: "reconciliation",
    familyReason:
      "Detects evidence durably SIGNED but with no report job ever queued, and re-enqueues it; the stranded-producer reconciler.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "Evidence",
      tenantSource: "Evidence.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/lifecycle-recovery.ts",
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: "services/worker/src/lifecycle-recovery.ts",
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    reconciler: "services/worker/src/lifecycle-recovery.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/evidence/:id",
  },
  {
    workName: SWEEP_NAMES.ORPHAN_SCAN,
    family: "reconciliation",
    familyReason:
      "Read-only scan reporting dormant drafts, stuck evidence and unconfirmed parts for operator action; reports conflicts without guessing at them.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "Evidence",
      tenantSource: "Evidence.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/orphan-scan.ts",
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: "services/worker/src/orphan-scan.ts",
    idempotency: ["upsert_by_natural_key"],
    reconciler: "services/worker/src/orphan-scan.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/operations/evidence-health",
  },
  {
    workName: SWEEP_NAMES.IMMUTABLE_STORAGE_RECONCILIATION,
    family: "reconciliation",
    familyReason:
      "Reconciles recorded object-lock state against the storage provider's actual state; convergence, not mutation of evidence.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "GovernanceReconciliationRun",
      tenantSource: "GovernanceReconciliationRun.teamId",
      createdBySynchronousPath: true,
    },
    canonicalProducer: "packages/shared-runtime/src/reconciliation-run.ts",
    canonicalProcessor:
      "services/worker/src/governance/immutable-storage-reconciliation.worker.ts",
    workerRegistration: WORKER_INDEX,
    // POINT 5 — the run lock is `governance_reconciliation_runs_running_lock_uniq`
    // on (kind, lock_key) WHERE status = 'RUNNING'. The lease is one hour,
    // matching `RUN_LOCK_LEASE_MS`; the module's former "advisory lock" was a
    // comment, never code, so `advisory_lock` is removed from the strategy
    // list rather than left as an aspiration.
    // POINT 5 — corrected AGAIN, and this time against the enum.
    // `GovernanceReconciliationStatus` is RUNNING / SUCCEEDED / FAILED /
    // PARTIAL: there is no QUEUED, so a transition FROM it never happened and
    // never could. `runGovernanceReconciliation` INSERTs the row directly in
    // RUNNING and the partial unique index on (kind, lock_key) WHERE
    // status = 'RUNNING' is what refuses the second caller. The lease is one
    // hour, matching `RUN_LOCK_LEASE_MS`, and recovers a run whose owner died.
    claim: {
      from: "none",
      to: "RUNNING",
      mechanism: "unique_execution_constraint",
      leaseField: "startedAtUtc",
      leaseMs: 60 * 60 * 1000,
    },
    terminalWriter: "packages/shared-runtime/src/reconciliation-run.ts",
    idempotency: ["unique_constraint"],
    reconciler: "packages/shared-runtime/src/reconciliation-run.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: "storage",
    auditFamily: "governance.reconciliation",
    projection: "GET /v1/governance/reconciliation-runs",
  },
  {
    workName: SWEEP_NAMES.REVIEWER_RECONCILIATION,
    family: "reconciliation",
    familyReason:
      "Reconciles reviewer assignment and workload projections against authoritative review rows.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    // ET-Q-07 (2026-09-30) — this named `Team` and said "Team row loaded by id;
    // missing or non-ACTIVE fails closed". Neither half describes the code. The
    // engine never loads a Team and checks no organization status: the route
    // enumerates the teams that own at least one review workflow, and
    // `runReconcile` reads and repairs `EvidenceReviewWorkflow` rows (SLA
    // state, escalations) scoped by that team id. The workflow row is what is
    // reconciled.
    durableAuthority: {
      model: "EvidenceReviewWorkflow",
      tenantSource:
        "EvidenceReviewWorkflow.teamId — the sweep enumerates teams owning at least one workflow row and scopes every read and write by that team id",
      createdBySynchronousPath: true,
    },
    // POINT 5 — corrected, same reason as `DemoFollowUpSweep`. The worker
    // module named here is an HTTP CLIENT of `/v1/reviewer-ops/reconcile`; it
    // enumerates nothing and writes nothing. The executor is the api-side
    // reviewer-operations engine the route dispatches to, and that is what the
    // entry now names. The worker client remains the registration.
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor:
      "services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts",
    workerRegistration:
      "services/worker/src/reviewer-ops/reviewer-reconciliation.worker.ts",
    claim: null,
    terminalWriter:
      "services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts",
    idempotency: ["upsert_by_natural_key"],
    reconciler:
      "services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/reviewer-ops/workload",
  },

  {
    workName: SWEEP_NAMES.SEARCH_INDEX_RECONCILER,
    family: "reconciliation",
    familyReason:
      "Re-enqueues projection rebuilds for source rows whose search document is missing or older than the source; closes the commit-then-enqueue-failed window.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "Evidence",
      tenantSource: "Evidence.teamId (candidates read from source rows; NULL rows are excluded because they cannot be projected)",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/search-index-reconciler.ts",
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: "services/worker/src/search-index-reconciler.ts",
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.PROJECTION,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/operations/queues",
  },
  {
    workName: SWEEP_NAMES.INTELLIGENCE_RUN_RECONCILER,
    family: "intelligence_operations",
    familyReason:
      "Releases expired PROCESSING leases and re-enqueues stranded PENDING intelligence runs, stranded PENDING derived assets and chunks still owing an embedding; without it a run whose worker died stays PROCESSING forever and every retry no-ops on arrival.",
    transport: "db_outbox_sweep",
    queueName: null,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: null,
    durableAuthority: {
      model: "MediaIntelligenceRun",
      tenantSource: "MediaIntelligenceRun.teamId (candidates read from run rows)",
      createdBySynchronousPath: true,
    },
    canonicalProducer: WORKER_INDEX,
    canonicalProcessor: "services/worker/src/intelligence-run-reconciler.ts",
    workerRegistration: WORKER_INDEX,
    // ET-Q-07 (2026-09-30) — was `RUNNING -> PENDING`; the claimed status is
    // PROCESSING (`MEDIA_INTELLIGENCE_RUN_CLAIMED_STATUS`). No RUNNING exists.
    claim: {
      from: "PROCESSING",
      to: "PENDING",
      mechanism: "conditional_update_many",
      leaseField: "startedAtUtc",
      leaseMs: 20 * 60 * 1000,
    },
    terminalWriter: "services/worker/src/intelligence-run-reconciler.ts",
    idempotency: ["conditional_state_claim", "deterministic_job_id"],
    reconciler: "services/worker/src/intelligence-run-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.HEAVY_RENDER,
    externalBoundary: null,
    auditFamily: "intelligence.media_run",
    projection: "GET /v1/operations/queues",
  },
];

// ===========================================================================
// The registry
// ===========================================================================

export const CANONICAL_WORK_REGISTRY: ReadonlyArray<WorkRegistryEntry> = [
  ...BULLMQ_JOBS,
  ...DB_SWEEPS,
];

/**
 * ET-Q-07 (2026-09-30) — WORK THAT HAS NO RECONCILER, STATED OUT LOUD.
 *
 * `RECONCILER_PENDING` is the name the Point-5 closure gates have always used
 * for this list; until now it existed only as an empty local inside two tests,
 * which made "every unit of work names a reconciler" true by construction of
 * the field type rather than by anything a reconciler did. Three entries
 * satisfied it by naming a module that cannot see their work:
 *
 *   * `ReconcileTeamGraph` and `RefreshGraphSearchProjection` named
 *     `search-index-reconciler.ts`, which re-enqueues evidence search documents
 *     and touches no graph authority;
 *   * `GenerateDerivedAsset` named `intelligence-run-reconciler.ts`, which
 *     never reads `EvidencePartDerivedAsset`.
 *
 * Each was set to `reconciler: null` and listed here while that was the truth.
 *
 * THE LIST IS EMPTY AGAIN, AND THIS TIME IT IS A MEASUREMENT. The three scans
 * were written — two in `search-index-reconciler.ts`, one in
 * `intelligence-run-reconciler.ts` — and each entry names its module again.
 * What changed is what "names a reconciler" is held to: the closure gate now
 * requires the named module's SOURCE to reference the authority model of the
 * work it is given, so the three claims above would fail it if they were put
 * back.
 *
 * The mechanism stays. A unit of work with no recovery path declares
 * `reconciler: null` AND is listed here; the registry self-check enforces both
 * directions and the gates assert this list is `[]`, so a new gap is a red
 * build with a name on it rather than a plausible-looking module path.
 */
export const RECONCILER_PENDING: ReadonlyArray<WorkName> = [];

export function getWorkEntry(workName: string): WorkRegistryEntry | null {
  return (
    CANONICAL_WORK_REGISTRY.find((e) => e.workName === workName) ?? null
  );
}

export function getWorkEntryOrThrow(workName: string): WorkRegistryEntry {
  const entry = getWorkEntry(workName);
  if (!entry) {
    throw new Error(
      `unknown work name "${workName}" — not in CANONICAL_WORK_REGISTRY`,
    );
  }
  return entry;
}

export function getEntriesForFamily(
  family: QueueFamily,
): ReadonlyArray<WorkRegistryEntry> {
  return CANONICAL_WORK_REGISTRY.filter((e) => e.family === family);
}

export function getBullMqEntries(): ReadonlyArray<WorkRegistryEntry> {
  return CANONICAL_WORK_REGISTRY.filter((e) => e.transport === "bullmq");
}

export function getSweepEntries(): ReadonlyArray<WorkRegistryEntry> {
  return CANONICAL_WORK_REGISTRY.filter(
    (e) => e.transport === "db_outbox_sweep",
  );
}

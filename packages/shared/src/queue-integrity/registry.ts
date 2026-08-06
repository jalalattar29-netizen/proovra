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
 *   15 BullMQ jobs   (one per processed queue, 1:1 with worker registrations)
 *    2 DLQ sinks     (queues with no job and no worker, by design)
 *   17 DB sweeps     (scheduler + processor pairs)
 *   ──
 *   34 registry entries; 32 of them process work.
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
  /** Repo-relative module that recovers stranded rows. */
  reconciler: string;
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
// THE 17 BULLMQ JOBS
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
      leaseField: "renderStartedAtUtc",
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
      tenantSource: "Evidence.teamId (loaded by id; null fails closed)",
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
    reconciler: "services/worker/src/lifecycle-recovery.ts",
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
      tenantSource: "Evidence.teamId (loaded by id; null fails closed)",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: "services/worker/src/ots-upgrade.processor.ts",
    workerRegistration: WORKER_INDEX,
    claim: {
      from: "QUEUED",
      to: "PROCESSING",
      mechanism: "conditional_update_many",
      leaseField: null,
      leaseMs: null,
    },
    terminalWriter: "services/worker/src/ots-state.ts",
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
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
  {
    workName: JOB_NAMES.INDEX_MEDIA_INTELLIGENCE,
    family: "reconciliation",
    familyReason:
      "Re-indexes an evidence record's search document after media-intelligence output lands. Produced by the intelligence subsystem but its effect is projection convergence.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.MI_SEARCH_INDEX,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "mi-search-index",
    durableAuthority: {
      model: "Evidence",
      tenantSource: "Evidence.teamId (loaded by id; null fails closed)",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    canonicalProcessor: SUBSYSTEM,
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: SUBSYSTEM,
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.PROJECTION,
    recovery: RECOVERY_POLICIES.PROJECTION,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/search",
  },
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
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/intelligence/graph",
  },
  {
    workName: JOB_NAMES.SYNC_TEAM_GRAPH_DOMAIN,
    family: "reconciliation",
    familyReason:
      "Re-syncs one graph domain for a workspace; a narrowed form of the graph reconcile run.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.GRAPH_DOMAIN_SYNC,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "graph-domain-sync",
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
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/intelligence/graph",
  },
  {
    workName: JOB_NAMES.SYNC_TEAM_GRAPH_TIMELINE,
    family: "reconciliation",
    familyReason:
      "Refreshes the workspace timeline projection; projection convergence.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.GRAPH_TIMELINE_SYNC,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "graph-timeline-sync",
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
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/intelligence/graph",
  },
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
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/search",
  },
  {
    workName: JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION,
    family: "reconciliation",
    familyReason:
      "Recomputes the organization-health projection row from bounded per-workspace counts; projection convergence, not analysis.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.ORG_HEALTH_REFRESH,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "org-health-refresh",
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
    reconciler: "services/worker/src/search-index-reconciler.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: null,
    projection: "GET /v1/organizations/:id/health",
  },

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
    claim: {
      from: "QUEUED",
      to: "RUNNING",
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
  {
    workName: JOB_NAMES.EXTRACT_EXIF,
    family: "intelligence_operations",
    familyReason:
      "EXIF extraction from the bytes of one evidence part. Isolated onto its own queue so a long analyzer run cannot head-of-line block it.",
    transport: "bullmq",
    queueName: QUEUE_NAMES.MI_EXIF,
    implementation: "CURRENT_RUNTIME",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    jobIdPrefix: "mi-exif",
    durableAuthority: {
      // PHASE 12 POINT 5 correction. This entry named `MediaIntelligenceRun`
      // and said the job "shares the media-intelligence processor by design".
      // It did share it — and that was the defect, not the design: ONE
      // function served two queues whose commands meant different things, so
      // its payload had to carry both a run id and a part id and trust
      // whichever was present. The EXIF job addresses the PART whose bytes it
      // reads; the media-intelligence job addresses the RUN row that tracks
      // its lifecycle. Two authorities, two entry points.
      model: "EvidencePart",
      tenantSource: "EvidencePart.evidence.teamId (loaded by id)",
      createdBySynchronousPath: true,
    },
    canonicalProducer: SHARED_ENQUEUE,
    // Its OWN entry point (`processExifQueueJob`), not the shared
    // media-intelligence handler. Binding both queues to one function is what
    // forced the old payload to carry a run id AND a part id.
    canonicalProcessor: "services/worker/src/media-intelligence.processor.ts",
    workerRegistration: WORKER_INDEX,
    claim: null,
    terminalWriter: "services/worker/src/media-intelligence.processor.ts",
    idempotency: ["deterministic_job_id", "upsert_by_natural_key"],
    reconciler: "services/worker/src/intelligence-run-reconciler.ts",
    retry: RETRY_POLICIES.HEAVY_RENDER,
    recovery: RECOVERY_POLICIES.HEAVY_RENDER,
    externalBoundary: null,
    auditFamily: "intelligence.media_run",
    projection: "GET /v1/evidence/:id/media-intelligence",
  },
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
// THE 15 DB-OUTBOX SWEEPS
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
      leaseField: "renderStartedAtUtc",
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
    reconciler:
      "services/worker/src/governance/retention-reconciliation.worker.ts",
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
    canonicalProducer: "services/worker/src/governance/reconciliation-run.ts",
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
    terminalWriter: "services/worker/src/governance/reconciliation-run.ts",
    idempotency: ["unique_constraint"],
    reconciler: "services/worker/src/governance/reconciliation-run.ts",
    retry: RETRY_POLICIES.SWEEP,
    recovery: RECOVERY_POLICIES.SWEEP,
    externalBoundary: null,
    auditFamily: "governance.reconciliation",
    projection: "GET /v1/governance/reconciliation-runs",
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
      "Expires and removes capture drafts past their expiry; bounded destruction of abandoned pre-evidence state.",
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
    claim: {
      from: "DRAFT",
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
    claim: {
      from: "PENDING",
      to: "SENDING",
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
    claim: {
      from: "PENDING",
      to: "SENDING",
      mechanism: "conditional_update_many",
      leaseField: "followUpSentAtUtc",
      leaseMs: 30 * 60 * 1000,
    },
    terminalWriter: "services/api/src/services/demo-follow-up.service.ts",
    idempotency: ["conditional_state_claim", "provider_idempotency_key"],
    reconciler: WORKER_INDEX,
    retry: RETRY_POLICIES.EMAIL_DELIVERY,
    recovery: RECOVERY_POLICIES.EXTERNAL_DELIVERY,
    externalBoundary: "email",
    auditFamily: "notifications.delivery",
    projection: "GET /v1/admin/demo-requests",
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
    canonicalProducer: "services/worker/src/governance/reconciliation-run.ts",
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
    terminalWriter: "services/worker/src/governance/reconciliation-run.ts",
    idempotency: ["unique_constraint"],
    reconciler: "services/worker/src/governance/reconciliation-run.ts",
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
    durableAuthority: {
      model: "Team",
      tenantSource: "Team row loaded by id; missing or non-ACTIVE fails closed",
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
      "Releases expired RUNNING leases and re-enqueues stranded PENDING intelligence runs; without it a run whose worker died stays RUNNING forever and every retry no-ops on arrival.",
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
    claim: {
      from: "RUNNING",
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

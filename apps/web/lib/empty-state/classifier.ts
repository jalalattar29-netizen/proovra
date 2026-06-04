/**
 * Wave 2 Phase 4 — Empty-State Truth Classifier.
 *
 * Pure function. NEVER fetches; NEVER mutates; NEVER throws.
 *
 * Every Investigation surface must call `classifyInvestigationEmptyState`
 * before rendering an empty placeholder. The classifier picks ONE of the
 * 10 codes from the EmptyStateClassification union and returns a
 * verbatim operator-facing reason string. The page then renders
 * `<OperationalEmptyState classification reason ... />` — the page is
 * NOT allowed to hand-pick a code from inline logic.
 *
 * Decision rules (in order):
 *
 *   1. fetchError !== null
 *      → API_ERROR                  (backend unreachable / 5xx / parse failure)
 *   2. permission === 'denied'
 *      → PERMISSION_RESTRICTED      (route gate already filtered; rare edge case)
 *   3. permission === 'wrong_scope'
 *      → WRONG_SCOPE                (page reached but wrong workspace / record id)
 *   4. capabilityStatus.configured === false
 *      → FEATURE_NOT_CONFIGURED     (no provider bound — operator-actionable)
 *   5. capabilityStatus.enabled === false
 *      → CONFIG_DISABLED            (provider exists but workspace turned it off)
 *   6. capabilityStatus.provider === 'none' && capabilityStatus.mode === 'DEFERRED'
 *      → CAPABILITY_UNAVAILABLE     (honest "no producer wired" — e.g. derivatives)
 *   7. diagnostics.workspace shows queued work for this domain
 *      → PIPELINE_PENDING           (background job is in flight)
 *   8. diagnostics shows recent worker failure for this domain
 *      → PIPELINE_FAILED            (queue depth zero but last run failed)
 *   9. otherwise
 *      → TRUE_EMPTY                 (no data, no error, no pipeline activity)
 *
 * The `reason` field uses the capability resolver's PRODUCER_REASON_COPY
 * (Wave 1) verbatim for capability-gated codes, and the diagnostics
 * warnings array (or queue last-error) for pipeline codes.
 *
 * Hard contracts:
 *   * Pure function — no fetches, no setTimeout, no DOM access.
 *   * Returns the SAME ClassifierResult shape for every input.
 *   * Never invents prose — always picks from a bounded copy table.
 *   * Never throws — every defensive branch collapses honestly.
 */

import type { EmptyStateClassification } from "../../components/operational/OperationalEmptyState";

// ---------------------------------------------------------------------------
// Bounded types — kept structural to avoid pulling api / shared-runtime
// types into the web client bundle. The page hydrates these shapes from
// the canonical /v1/intelligence/capabilities and /v1/investigation/
// diagnostics envelopes the orchestrator already returns.
// ---------------------------------------------------------------------------

/**
 * Mirrors `ProducerModeStatus` from
 * packages/shared-runtime/src/media-intelligence/producer-mode.ts
 * (Wave 1). We restate the shape here as a structural type so the web
 * client does not need a direct dep on shared-runtime types — the
 * runtime data is the same JSON envelope.
 */
export interface ProducerModeStatusLike {
  kind: string;
  mode: string;
  enabled: boolean;
  configured: boolean;
  automatic: boolean;
  indexExistingOnly: boolean;
  provider: string;
  reason: string;
  lastRunAt?: string;
  lastError?: string;
}

/**
 * Bounded subset of `InvestigationDiagnostics` from
 * services/api/src/services/investigation-diagnostics.service.ts.
 * We surface only the fields the classifier needs — counts to detect
 * PIPELINE_PENDING and warning strings to detect PIPELINE_FAILED.
 */
export interface InvestigationDiagnosticsLike {
  workspace?: {
    graphNodeCount?: number;
    graphEdgeCount?: number;
    staleGraphNodeCount?: number;
    staleGraphEdgeCount?: number;
    timelineEventCount?: number;
    duplicateExactCount?: number;
    duplicateSimilarityCount?: number;
    duplicateDerivativeCount?: number;
    reviewWorkflowCount?: number;
    escalationCount?: number;
    externalReviewerGrantCount?: number;
    mediaSignalCount?: number;
  };
  queues?: Record<
    string,
    { depth?: number; lastError?: string | null; lastRunAt?: string | null }
  >;
  lastErrors?: Array<{
    source?: string;
    code?: string;
    message?: string;
    occurredAt?: string;
  }>;
  warnings?: string[];
}

export type EmptyStateDomain =
  | "graph"
  | "timeline"
  | "duplicates"
  | "reviewers"
  | "relationships"
  | "overview";

export type ClassifierPermission = "allowed" | "denied" | "wrong_scope";

export interface ClassifierInput {
  /** The page's data envelope (or null on error / pre-fetch). */
  data: unknown;
  /** Captured fetch error (or null when the fetch resolved). */
  fetchError: Error | null;
  /** Permission outcome for the page's data scope. Default: allowed. */
  permission?: ClassifierPermission;
  /**
   * Capability status for the surface (when the page depends on one).
   * Pass the matching ProducerModeStatus entry from
   * /v1/intelligence/capabilities for the relevant kind.
   */
  capabilityStatus?: ProducerModeStatusLike;
  /**
   * Investigation diagnostics envelope (when the operator has
   * permission to fetch it). Pass through verbatim.
   */
  diagnostics?: InvestigationDiagnosticsLike;
}

export interface ClassifierResult {
  classification: EmptyStateClassification;
  reason: string;
}

// ---------------------------------------------------------------------------
// Per-domain queue + workspace-count selectors. Bounded to the queue
// names registered in services/api/src/services/investigation-diagnostics.service.ts.
// ---------------------------------------------------------------------------

const DOMAIN_QUEUE_KEYS: Readonly<Record<EmptyStateDomain, string[]>> = {
  graph: ["graphReconcile", "graphDomainSync", "graphSearchProjection"],
  timeline: ["graphTimelineSync"],
  duplicates: ["mediaIntelligence", "graphReconcile"],
  reviewers: ["mediaIntelligence"],
  relationships: ["graphReconcile", "graphDomainSync"],
  overview: ["graphReconcile", "mediaIntelligence", "searchIndexing"],
};

// ---------------------------------------------------------------------------
// Reason copy. Picked verbatim — pages MUST NOT translate or paraphrase.
// ---------------------------------------------------------------------------

const REASON_COPY = {
  API_ERROR_GENERIC:
    "The investigation service did not respond to the last request. Retry shortly; if the failure persists, open Observability.",
  PERMISSION_DENIED_GENERIC:
    "Your role does not grant access to this data scope. Ask your workspace administrator to assign the required permission.",
  WRONG_SCOPE_GENERIC:
    "This page expects a different workspace or record context. Switch workspace or open the surface from the correct case.",
  PIPELINE_PENDING_GENERIC:
    "Background work is queued for this surface. Results will appear automatically when the next pass completes.",
  PIPELINE_FAILED_GENERIC:
    "The most recent background pass for this surface failed. The platform retries automatically; operator attention is recommended.",
  WORKER_UNAVAILABLE_GENERIC:
    "The processing worker for this surface is currently offline.",
  TRUE_EMPTY_GENERIC:
    "No records of this kind exist in the workspace yet. Capture evidence and open a case — entries appear here as the workspace populates.",
  CAPABILITY_UNAVAILABLE_GENERIC:
    "The capability backing this surface is not wired in this release. See the upcoming Wave for the producer.",
} as const;

// ---------------------------------------------------------------------------
// Public classifier — pure function. Returns the same shape for every input.
// ---------------------------------------------------------------------------

export function classifyInvestigationEmptyState(
  input: ClassifierInput,
  domain: EmptyStateDomain,
): ClassifierResult {
  // Rule 1 — fetch failure dominates. Even if other state would
  // suggest empty, an unreachable backend is honest API_ERROR.
  if (input.fetchError !== null && input.fetchError !== undefined) {
    return {
      classification: "API_ERROR",
      reason: bounded(input.fetchError.message) || REASON_COPY.API_ERROR_GENERIC,
    };
  }

  // Rule 2 — permission denied. The route gate should have caught
  // this; the classifier covers the edge cases where a partial
  // sub-fetch returns 403 but the page itself loaded.
  const permission = input.permission ?? "allowed";
  if (permission === "denied") {
    return {
      classification: "PERMISSION_RESTRICTED",
      reason: REASON_COPY.PERMISSION_DENIED_GENERIC,
    };
  }

  // Rule 3 — wrong scope. Same edge-case bucket as #2 but for
  // workspace/record mismatch.
  if (permission === "wrong_scope") {
    return {
      classification: "WRONG_SCOPE",
      reason: REASON_COPY.WRONG_SCOPE_GENERIC,
    };
  }

  // Rule 4 — capability not configured. The producer-mode resolver
  // (Wave 1) is the canonical truth source. `configured === false`
  // means no provider is bound; we surface the resolver's `reason`
  // verbatim so the operator sees the same string everywhere.
  const cap = input.capabilityStatus;
  if (cap && cap.configured === false) {
    // Wave 1 deferred-producer kinds collapse to CAPABILITY_UNAVAILABLE
    // when their mode is DEFERRED + provider 'none' — covered by
    // Rule 6 below. Other unconfigured capabilities fall here.
    if (!(cap.provider === "none" && cap.mode === "DEFERRED")) {
      return {
        classification: "FEATURE_NOT_CONFIGURED",
        reason: bounded(cap.reason) || REASON_COPY.TRUE_EMPTY_GENERIC,
      };
    }
  }

  // Rule 5 — capability disabled by configuration. The resolver
  // returns `enabled === false` when extraction is turned off on
  // the workspace even though credentials exist.
  if (cap && cap.enabled === false && cap.configured !== false) {
    return {
      classification: "CONFIG_DISABLED",
      reason: bounded(cap.reason) || REASON_COPY.TRUE_EMPTY_GENERIC,
    };
  }

  // Rule 6 — capability unavailable (Wave 1 DEFERRED kinds, e.g.
  // derivative_detection). Honest "no producer wired yet" copy.
  if (cap && cap.provider === "none" && cap.mode === "DEFERRED") {
    return {
      classification: "CAPABILITY_UNAVAILABLE",
      reason: bounded(cap.reason) || REASON_COPY.CAPABILITY_UNAVAILABLE_GENERIC,
    };
  }

  // Rule 7 — pipeline pending. Queue depth > 0 for any queue this
  // domain consumes means a background pass is in flight; results
  // will surface on the next poll cycle.
  const diag = input.diagnostics;
  if (diag) {
    const queueDepth = sumQueueDepth(diag, domain);
    if (queueDepth > 0) {
      return {
        classification: "PIPELINE_PENDING",
        reason:
          formatPipelinePendingReason(queueDepth, domain) ||
          REASON_COPY.PIPELINE_PENDING_GENERIC,
      };
    }

    // Rule 8 — pipeline failed. Last error from any queue this
    // domain consumes OR any of the recent media_intelligence_runs
    // failures whose kind looks related to this domain.
    const failure = pickPipelineFailure(diag, domain);
    if (failure) {
      return {
        classification: "PIPELINE_FAILED",
        reason:
          bounded(failure) ||
          REASON_COPY.PIPELINE_FAILED_GENERIC,
      };
    }

    // Rule 8b — worker unavailable. The diagnostics aggregator
    // emits `queue_inventory_unavailable` when BullMQ/Redis cannot
    // be reached. If the warning is present AND the domain consumes
    // a queue, this is honest WORKER_UNAVAILABLE.
    if (
      Array.isArray(diag.warnings) &&
      diag.warnings.includes("queue_inventory_unavailable") &&
      DOMAIN_QUEUE_KEYS[domain].length > 0
    ) {
      return {
        classification: "WORKER_UNAVAILABLE",
        reason: REASON_COPY.WORKER_UNAVAILABLE_GENERIC,
      };
    }
  }

  // Rule 9 — TRUE_EMPTY. No data, no error, no pipeline activity.
  // Defensive: even if `data` was hand-checked to be an empty array,
  // the catch-all is still TRUE_EMPTY because every other branch is
  // ruled out by this point.
  return {
    classification: "TRUE_EMPTY",
    reason: REASON_COPY.TRUE_EMPTY_GENERIC,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bounded(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  const trimmed = s.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > 400) return `${trimmed.slice(0, 400)}…`;
  return trimmed;
}

function sumQueueDepth(
  diag: InvestigationDiagnosticsLike,
  domain: EmptyStateDomain,
): number {
  if (!diag.queues) return 0;
  let total = 0;
  for (const key of DOMAIN_QUEUE_KEYS[domain]) {
    const row = diag.queues[key];
    if (row && typeof row.depth === "number") {
      total += Math.max(0, row.depth);
    }
  }
  return total;
}

function formatPipelinePendingReason(
  depth: number,
  domain: EmptyStateDomain,
): string {
  const domainLabel = domain === "overview" ? "investigation" : domain;
  return `${depth} background job${depth === 1 ? "" : "s"} pending for ${domainLabel}. Results will appear on the next pass.`;
}

function pickPipelineFailure(
  diag: InvestigationDiagnosticsLike,
  domain: EmptyStateDomain,
): string | null {
  // Prefer per-queue lastError for the domain's queues.
  if (diag.queues) {
    for (const key of DOMAIN_QUEUE_KEYS[domain]) {
      const row = diag.queues[key];
      if (row?.lastError && row.lastError.length > 0) {
        return `Background queue "${key}" reported: ${row.lastError}`;
      }
    }
  }
  // Fall back to the bounded last-errors array.
  if (Array.isArray(diag.lastErrors) && diag.lastErrors.length > 0) {
    const first = diag.lastErrors[0];
    if (first?.message) {
      return `Last background failure (${first.code ?? "unknown"}): ${first.message}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-export the 10-code union so callers can `import { ... } from
// "lib/empty-state/classifier"` without reaching into the operational
// component package. Keeps the surface area minimal.
// ---------------------------------------------------------------------------

export type { EmptyStateClassification } from "../../components/operational/OperationalEmptyState";

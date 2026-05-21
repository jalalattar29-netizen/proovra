/**
 * Phase 32.7 — Canonical operational event contract.
 *
 * Single source of truth for operational telemetry event names that
 * cross subsystem boundaries (worker → api readiness, api →
 * frontend, etc.).
 *
 * Background
 * ----------
 * Operational signals had drifted across the platform: the worker
 * reconcile heartbeat was emitted with `eventType:
 * "reviewer_reconcile_run"` (snake_case wire string), the readiness
 * check originally queried `admin_audit_logs.action =
 * "reviewer_reconcile_run"` (wrong table; fixed in Phase 32.6.5),
 * and per-subsystem counters used yet another snake_case vocabulary
 * (`reviewer_reconcile_run_total`). Future cross-subsystem events
 * risked drifting further.
 *
 * This module canonicalizes the contract:
 *
 *   - Every operational event has a TYPED symbolic name in
 *     SCREAMING_SNAKE_CASE (`WORKER_HEARTBEAT`,
 *     `READINESS_DEGRADED`, etc.). Writers and readers import this
 *     constant instead of inlining literals.
 *
 *   - The mapping from canonical name → wire string (the value
 *     persisted to security_events.eventType / admin_audit_logs.action)
 *     is owned by this module. The wire format is INTENTIONALLY
 *     PRESERVED for backward compatibility with downstream consumers
 *     (dashboards, log queries, audit chain integrity). The canonical
 *     name is a code-level alias; the wire string is the contract.
 *
 *   - The mapping is bounded: adding a new event requires a code
 *     change here AND a code change at the writer/reader call sites.
 *
 * Hard invariants
 * ---------------
 *   - Wire strings MUST NOT change without operator approval AND a
 *     migration plan for downstream queries.
 *   - Canonical names MUST NOT alias each other.
 *   - Readers MUST use `wireStringFor(...)` (or import the constant
 *     directly) rather than inline literals.
 *   - The mapping is one-to-one; one canonical name → exactly one
 *     wire string.
 */

/**
 * Canonical symbolic name for an operational telemetry event.
 *
 * Add new entries here AND in `OPERATIONAL_EVENT_WIRE_STRINGS` below.
 * Both maps are required for a contract entry to be valid.
 */
export const CANONICAL_OPERATIONAL_EVENTS = [
  /**
   * Reviewer reconciliation tick completed. Emitted by the worker
   * at the end of `runReconcile()`. Read by
   * `services/api/src/runtime/runtime-readiness.ts::checkWorkers`
   * to detect a missing-heartbeat situation after the startup
   * grace window.
   */
  "WORKER_HEARTBEAT",
] as const;

export type CanonicalOperationalEvent =
  (typeof CANONICAL_OPERATIONAL_EVENTS)[number];

/**
 * Wire string emitted on the bus / persisted to the audit table.
 *
 * THESE STRINGS ARE PART OF THE PERSISTED CONTRACT. They appear in
 * `security_events.eventType` rows that may be queried by
 * dashboards, audit-chain consumers, or downstream analytics.
 * Changing a value here is a breaking change requiring a migration
 * plan.
 */
export const OPERATIONAL_EVENT_WIRE_STRINGS: Record<
  CanonicalOperationalEvent,
  string
> = {
  WORKER_HEARTBEAT: "reviewer_reconcile_run",
};

/**
 * Resolve a canonical name to its wire string.
 *
 * Used at both the writer call site (worker) and the reader call
 * site (readiness check) so the two sides cannot drift.
 */
export function wireStringFor(name: CanonicalOperationalEvent): string {
  return OPERATIONAL_EVENT_WIRE_STRINGS[name];
}

/**
 * Operational domain hierarchy used by the frontend for
 * degradation isolation.
 *
 * Each readiness subsystem maps to exactly one domain. The frontend
 * `RuntimeStatusBanner` can be scoped to a domain via
 * `forDomains={[...]}`; the banner then ONLY renders when at least
 * one failing subsystem maps to a relevant domain.
 *
 * This prevents the "global UI poisoning" pattern where a degraded
 * worker subsystem makes the entire product UI feel broken — when
 * the failing subsystem has no functional impact on the page the
 * operator is currently viewing.
 *
 * Domains are intentionally coarse — they correspond to product
 * surfaces, not internal modules. Adding a domain requires a code
 * change AND a corresponding entry in the frontend's banner
 * filter.
 */
export const OPERATIONAL_DOMAINS = [
  /**
   * Core evidence pipeline: capture, upload, finalize, verify.
   * Failures here block the primary product flow.
   */
  "core_evidence",
  /**
   * Reviewer ops, escalations, SLA, reconciliation.
   * Failures here affect only the reviewer surfaces.
   */
  "reviewer_ops",
  /**
   * Governance: policy, legal holds, retention, destruction.
   * Failures here block governance pages but NOT evidence pipeline.
   */
  "governance_lifecycle",
  /**
   * Workflow engine: templates, instances, intake links.
   */
  "workflow_engine",
  /**
   * Integrations: API credentials, webhooks.
   */
  "integrations",
  /**
   * Identity: SSO, SCIM, sessions, access reviews.
   */
  "identity",
  /**
   * Operational incidents: alerting, on-call, runbooks.
   */
  "operational_incidents",
  /**
   * Search, OCR, transcripts, FTS, semantic search.
   */
  "search_discovery",
  /**
   * Media intelligence, derived assets, investigation graph.
   */
  "media_intelligence",
  /**
   * Platform observability / metrics / telemetry. A failure here
   * means we cannot OBSERVE other systems; it should NOT imply
   * other systems are themselves broken.
   */
  "platform_telemetry",
] as const;

export type OperationalDomain = (typeof OPERATIONAL_DOMAINS)[number];

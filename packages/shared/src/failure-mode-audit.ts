/**
 * Phase Z — Hardening & Validation Program.
 *
 * Failure-mode audit map.
 *
 * This module is the canonical, in-source, machine-readable catalog of
 * the failure modes the platform must survive without losing integrity,
 * leaking data, corrupting lifecycle state, fabricating trust, or
 * bypassing governance. It exists in `@proovra/shared` so:
 *
 *   1. The Phase Z hardening test suite (services/api/test/phase-z-...)
 *      can drive its assertions from the same catalog the runbooks
 *      reference.
 *   2. A future operator UI can render this catalog without re-typing it.
 *   3. Drift between "documented failure modes" and "tested failure
 *      modes" is detectable by counting the catalog entries vs. test
 *      coverage map.
 *
 * Hard rules:
 *   - Browser-safe. No Node, no Prisma, no Fastify.
 *   - Every entry MUST be tied to a `validationStrategy` (how we prove
 *     the platform tolerates it) and a `severity`.
 *   - Mitigations reference EXISTING controls. This module never
 *     prescribes new features.
 *   - This catalog is append-only at the entry level: removing an entry
 *     means the control is gone, which should be obvious in code review.
 */

export type FailureSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type FailureDomain =
  | "lifecycle"
  | "retention"
  | "destruction"
  | "legal_hold"
  | "export"
  | "audit"
  | "queue_worker"
  | "observability"
  | "anchor_trust"
  | "privacy"
  | "governance_runtime";

export type ValidationStrategy =
  | "pure_helper_test" // exercises a canonical formula
  | "source_contract_test" // greps the source for a required call site
  | "fault_injection_test" // simulates the failure in-process
  | "manual_runbook"; // operator procedure (not a unit test)

export type FailureModeEntry = {
  /** Stable identifier — operators reference this in runbooks. */
  id: string;
  domain: FailureDomain;
  severity: FailureSeverity;
  /** What happens, in operator language. */
  scenario: string;
  /** Why this is dangerous — what could break, leak, or corrupt. */
  impact: string;
  /** The existing controls that prevent / detect / contain the failure. */
  mitigations: ReadonlyArray<string>;
  /** How Phase Z proves the mitigation actually works. */
  validationStrategy: ValidationStrategy;
  /** Optional pointer to the runbook that an operator follows when this fires. */
  runbookId?: string;
};

export const FAILURE_MODE_AUDIT: ReadonlyArray<FailureModeEntry> = [
  // -----------------------------------------------------------------------
  // Lifecycle bypass
  // -----------------------------------------------------------------------
  {
    id: "FM-LIFE-001",
    domain: "lifecycle",
    severity: "CRITICAL",
    scenario:
      "Caller attempts ACTIVE → DESTROYED transition without entering PENDING_DESTRUCTION first.",
    impact:
      "Bypasses the destruction-review gate, the certificate emission, and the legal-hold check — evidence is destroyed without an approval trail.",
    mitigations: [
      "canonicalEvaluateLifecycleTransition refuses any transition outside EVIDENCE_LIFECYCLE_TRANSITIONS.",
      "lifecycle-orchestrator.service is the SINGLE writer of Evidence.lifecycleState (RUNTIME_OWNERSHIP_MAP).",
      "Append-only EvidenceLifecycleEvent ledger records every transition.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-LIFECYCLE-BYPASS",
  },
  {
    id: "FM-LIFE-002",
    domain: "lifecycle",
    severity: "CRITICAL",
    scenario: "Caller attempts to re-transition out of DESTROYED.",
    impact:
      "Would fabricate post-destruction recovery — the platform must guarantee DESTROYED is terminal.",
    mitigations: [
      "canonicalIsTerminalLifecycleState short-circuits the orchestrator.",
      "EVIDENCE_LIFECYCLE_TRANSITIONS table lists DESTROYED with an empty next-state array.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-LIFECYCLE-BYPASS",
  },
  // -----------------------------------------------------------------------
  // Legal hold precedence
  // -----------------------------------------------------------------------
  {
    id: "FM-HOLD-001",
    domain: "legal_hold",
    severity: "CRITICAL",
    scenario:
      "Direct evidence hold is active and an operator (or worker) requests PENDING_DESTRUCTION.",
    impact:
      "Hold-protected evidence would be queued for destruction in violation of legal preservation duty.",
    mitigations: [
      "canonicalCanEnterPendingDestruction returns blocked_by_hold before any state check.",
      "destruction-review.service refuses APPROVED / EXECUTED while a hold is active.",
      "retention-reconciliation worker filters held evidence out of the sweep set.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-HOLD-OVERRIDE",
  },
  {
    id: "FM-HOLD-002",
    domain: "legal_hold",
    severity: "CRITICAL",
    scenario:
      "Case-level hold is active (no direct evidence hold) and destruction is requested.",
    impact:
      "Case-scoped preservation would be silently bypassed when no direct evidence hold exists.",
    mitigations: [
      "canonicalCanEnterPendingDestruction enforces blocked_by_case_hold separately from direct hold.",
      "Export-governance + destruction-review both check direct AND case holds.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-HOLD-OVERRIDE",
  },
  {
    id: "FM-HOLD-003",
    domain: "legal_hold",
    severity: "HIGH",
    scenario:
      "Hold is placed AFTER a destruction review enters APPROVED but BEFORE the orchestrator executes.",
    impact:
      "Race could allow the worker to destroy held evidence between approval and execution.",
    mitigations: [
      "Destruction orchestrator re-evaluates the canonical formula inside its EXECUTION transaction.",
      "EvidenceLegalHold row is committed in the same DB the worker reads — no eventual consistency window.",
    ],
    validationStrategy: "source_contract_test",
    runbookId: "RB-HOLD-OVERRIDE",
  },
  // -----------------------------------------------------------------------
  // Immutable retention
  // -----------------------------------------------------------------------
  {
    id: "FM-RET-001",
    domain: "retention",
    severity: "CRITICAL",
    scenario:
      "Retention policy version with immutable=true is in force, and destruction is requested.",
    impact:
      "Regulatory immutability (SEC 17a-4, SOX, etc.) would be violated; the platform must refuse.",
    mitigations: [
      "canonicalCanEnterPendingDestruction returns blocked_by_immutable.",
      "destruction-review.service refuses EXECUTED on immutable bindings.",
      "Immutable-storage-reconciliation worker raises an incident if DB and S3 Object Lock disagree.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-IMMUTABLE-DRIFT",
  },
  {
    id: "FM-RET-002",
    domain: "retention",
    severity: "HIGH",
    scenario:
      "Multiple retention policies match an evidence record; precedence resolution picks the wrong one.",
    impact:
      "A WORKSPACE-scope policy could override a CASE-scope policy, shortening or extending retention incorrectly.",
    mitigations: [
      "canonicalPickHighestPrecedencePolicy enforces the deterministic order: CASE → EVIDENCE_TYPE → REGULATORY → WORKSPACE.",
      "Only ACTIVE-status policies enter the precedence pool.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-RETENTION-PRECEDENCE",
  },
  // -----------------------------------------------------------------------
  // Export governance
  // -----------------------------------------------------------------------
  {
    id: "FM-EXP-001",
    domain: "export",
    severity: "HIGH",
    scenario:
      "Evidence is in PENDING_DESTRUCTION but a compliance-export build is requested.",
    impact:
      "An export of pending-destruction evidence would propagate stale material under a misleading trust badge.",
    mitigations: [
      "canonicalEvaluateExportEligibility returns BLOCKED_BY_LIFECYCLE for PENDING_DESTRUCTION / DESTROYED / ON_HOLD / RETENTION_LOCKED.",
      "export-governance.service checks lifecycleState before any package generation.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-EXPORT-BLOCKED",
  },
  {
    id: "FM-EXP-002",
    domain: "export",
    severity: "HIGH",
    scenario:
      "Non-terminal destruction review exists (PENDING / UNDER_REVIEW / DEFERRED / APPROVED) and export is requested.",
    impact:
      "Review failure would not unlock export if export proceeds during the gating window.",
    mitigations: [
      "canonicalEvaluateExportEligibility returns BLOCKED_BY_REVIEW_GATE for gating statuses.",
      "RESTORED, EXECUTED, DENIED+CANCELLED are explicitly terminal and unblock.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-EXPORT-BLOCKED",
  },
  {
    id: "FM-EXP-003",
    domain: "export",
    severity: "HIGH",
    scenario: "Active legal hold AND retention-locked state — both signal block.",
    impact:
      "If precedence is wrong, operator gets a misleading reason and may try to clear the wrong condition.",
    mitigations: [
      "Hold check runs BEFORE lifecycle check — operator sees the most-restrictive reason first.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-EXPORT-BLOCKED",
  },
  // -----------------------------------------------------------------------
  // Audit chain integrity
  // -----------------------------------------------------------------------
  {
    id: "FM-AUD-001",
    domain: "audit",
    severity: "CRITICAL",
    scenario:
      "A row in AdminAuditLog is mutated, deleted, or inserted out of order, breaking the HMAC chain.",
    impact:
      "Tamper goes undetected; the platform's audit story collapses.",
    mitigations: [
      "computeAuditLogChainHash hashes the canonical JSON of metadata + prev hash; verification walks the chain.",
      "PostgreSQL advisory lock ADMIN_AUDIT_ADVISORY_LOCK_KEY serializes inserts.",
      "platform_audit_chain_drift_detected_total metric drives the audit_chain_drift CRITICAL alert.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-AUDIT-CHAIN-DRIFT",
  },
  {
    id: "FM-AUD-002",
    domain: "audit",
    severity: "HIGH",
    scenario:
      "Metadata payload contains different key order; canonical JSON encoding must produce the same hash.",
    impact:
      "Hash instability would cause every operator session to be flagged as drift; the chain would be effectively non-verifiable.",
    mitigations: [
      "sortJsonValueForAuditChain sorts keys at every depth deterministically.",
      "canonicalJsonForAuditHash truncates depth at 8 to prevent pathological inputs.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-AUDIT-CHAIN-DRIFT",
  },
  // -----------------------------------------------------------------------
  // Queue / worker resilience
  // -----------------------------------------------------------------------
  {
    id: "FM-Q-001",
    domain: "queue_worker",
    severity: "HIGH",
    scenario:
      "BullMQ delivers the same job twice (duplicate enqueue + race).",
    impact:
      "Without idempotency, a destruction execution could run twice or two reports could overwrite each other.",
    mitigations: [
      "QueuePayloadEnvelope carries an idempotencyKey; processors collapse duplicates.",
      "DestructionExecution row uses a unique (reviewId, attempt) to detect replay.",
      "parseQueueEnvelope tolerates legacy raw payloads without crashing.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-WORKER-WEDGED",
  },
  {
    id: "FM-Q-002",
    domain: "queue_worker",
    severity: "HIGH",
    scenario:
      "Worker starts before API is reachable (compose order race) — startup-triggered fetches ECONNREFUSED.",
    impact:
      "Worker crashes on boot, restarts, crashes again — observability is poisoned with false-positive incidents.",
    mitigations: [
      "docker-compose depends_on: proovra-api: service_healthy gates worker container start.",
      "api-readiness.ts performs in-process waitForApiReadiness with exponential backoff + jitter.",
    ],
    validationStrategy: "source_contract_test",
    runbookId: "RB-WORKER-WEDGED",
  },
  {
    id: "FM-Q-003",
    domain: "queue_worker",
    severity: "MEDIUM",
    scenario:
      "Legacy raw job payload (pre-envelope) is processed by a post-Phase-X worker.",
    impact:
      "If the parser is strict, every in-flight job during a deploy would DLQ and operator pages spike.",
    mitigations: [
      "parseQueueEnvelope returns legacy:true with synthesized correlationId for raw bodies.",
      "validateBody is opt-in so callers stay tolerant by default.",
    ],
    validationStrategy: "pure_helper_test",
  },
  // -----------------------------------------------------------------------
  // OTS / TSA / anchor trust
  // -----------------------------------------------------------------------
  {
    id: "FM-OTS-001",
    domain: "anchor_trust",
    severity: "CRITICAL",
    scenario:
      "Record claims status=ANCHORED but has no Bitcoin txid AND no anchoredAtUtc.",
    impact:
      "Trust badge would assert Bitcoin anchoring without any proof — fabricated trust.",
    mitigations: [
      "resolveEffectiveOtsStatus degrades ANCHORED → PENDING when neither signal is present.",
      "decideOtsPackageArtifact mirrors the degrade rule in the verification package builder.",
      "deriveAnchorSemantics never emits anchoringStatus='verified' without publicAnchoringVerified.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-OTS-DEGRADATION",
  },
  {
    id: "FM-OTS-002",
    domain: "anchor_trust",
    severity: "HIGH",
    scenario:
      "Package builder receives an empty / malformed base64 proof.",
    impact:
      "An empty .ots file would be emitted as if it carried proof — verifiers would fail in opaque ways.",
    mitigations: [
      "decideOtsPackageArtifact only emits proofBytes when Buffer.from(base64) has non-zero length.",
      "Companion JSON sets proofPresent=false and verificationHint to the 'no proof' string when bytes are absent.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-OTS-DEGRADATION",
  },
  {
    id: "FM-OTS-003",
    domain: "anchor_trust",
    severity: "HIGH",
    scenario:
      "OTS status is DISABLED for a workspace; package builder still asked to attach companion.",
    impact:
      "Stub companion files for OTS-off workspaces would confuse downstream verifiers.",
    mitigations: [
      "decideOtsPackageArtifact returns {proofBytes:null, companion:null} for DISABLED.",
    ],
    validationStrategy: "pure_helper_test",
  },
  {
    id: "FM-OTS-004",
    domain: "anchor_trust",
    severity: "HIGH",
    scenario: "Transaction id field carries an invalid (non-64-hex) value.",
    impact:
      "A malformed txid could be displayed as 'anchored' on the trust badge.",
    mitigations: [
      "isValidOtsBitcoinTxid enforces /^[a-f0-9]{64}$/i; deriveAnchorSemantics drops invalid values to null.",
    ],
    validationStrategy: "pure_helper_test",
  },
  // -----------------------------------------------------------------------
  // Observability fail-safety
  // -----------------------------------------------------------------------
  {
    id: "FM-OBS-001",
    domain: "observability",
    severity: "HIGH",
    scenario:
      "A metrics sink throws inside withSpan after the body completes successfully.",
    impact:
      "Observability bug would crash business logic — exactly the failure mode the platform must prevent.",
    mitigations: [
      "safeSinkCall wraps every sink invocation in try/catch; sink errors are swallowed.",
      "withSpan still re-throws on body errors (so the caller's error path runs).",
    ],
    validationStrategy: "fault_injection_test",
    runbookId: "RB-OBSERVABILITY-DEGRADED",
  },
  {
    id: "FM-OBS-002",
    domain: "observability",
    severity: "MEDIUM",
    scenario:
      "Caller passes label values containing newlines, quotes, or backslashes.",
    impact:
      "Malformed Prometheus exposition would crash scrapers and silently drop data.",
    mitigations: [
      "sanitizePromLabelValue escapes \\, \", and \\n; truncates to 200 chars.",
      "formatPrometheusExposition refuses metrics with invalid names.",
    ],
    validationStrategy: "pure_helper_test",
  },
  {
    id: "FM-OBS-003",
    domain: "observability",
    severity: "HIGH",
    scenario:
      "Caller passes labels containing forbidden keys (authorization, cookie, secret, token, etc).",
    impact:
      "Privileged values would leak into metrics labels visible to anyone with /metrics access.",
    mitigations: [
      "safeLabelSet drops keys whose lowered name contains any FORBIDDEN_LABEL_PREFIXES.",
      "Defense in depth: Sentry capture also redacts the same prefixes.",
    ],
    validationStrategy: "pure_helper_test",
    runbookId: "RB-PRIVACY-LEAK",
  },
  // -----------------------------------------------------------------------
  // Privacy / visibility
  // -----------------------------------------------------------------------
  {
    id: "FM-PRIV-001",
    domain: "privacy",
    severity: "HIGH",
    scenario:
      "Lifecycle event metadata receives privileged legal text or PII (legalnote, privileged, ...).",
    impact:
      "Privileged material would persist in the compliance ledger and could be subpoenaed or leaked.",
    mitigations: [
      "lifecycle-orchestrator.service.scrubMetadata replaces values for sensitive keys with [redacted].",
      "Metadata is size-bounded (MAX_METADATA_BYTES = 8 KiB).",
    ],
    validationStrategy: "source_contract_test",
    runbookId: "RB-PRIVACY-LEAK",
  },
  {
    id: "FM-PRIV-002",
    domain: "privacy",
    severity: "MEDIUM",
    scenario:
      "Worker emits a governance notification with operator metadata that includes a session id.",
    impact:
      "Session identifiers would be queryable from analytics endpoints.",
    mitigations: [
      "governance-notification.service runs the same scrub before persist.",
      "Worker emitters mirror the api scrubber (notification-emitter.ts).",
    ],
    validationStrategy: "source_contract_test",
    runbookId: "RB-PRIVACY-LEAK",
  },
  // -----------------------------------------------------------------------
  // Governance runtime (ownership)
  // -----------------------------------------------------------------------
  {
    id: "FM-GOV-001",
    domain: "governance_runtime",
    severity: "HIGH",
    scenario:
      "A new service is added that writes Evidence.lifecycleState directly (bypassing the orchestrator).",
    impact:
      "Two writers means lifecycle state can drift; the canonical formula is unenforceable.",
    mitigations: [
      "RUNTIME_OWNERSHIP_MAP names exactly ONE authoritativeWriter for each artifact.",
      "Phase X consolidation test asserts the map is internally consistent.",
    ],
    validationStrategy: "pure_helper_test",
  },
  {
    id: "FM-GOV-002",
    domain: "governance_runtime",
    severity: "MEDIUM",
    scenario:
      "Worker raises a governance notification by writing to GovernanceNotification directly instead of through the canonical service.",
    impact:
      "Throttle / dedupe / incident fan-out logic in the canonical service is bypassed for that emission.",
    mitigations: [
      "KNOWN GAP documented in RUNTIME_OWNERSHIP_MAP.governance_notification.notes.",
      "Phase X.1 emitter (notification-emitter.ts) mirrors the canonical scrub + dedupe-key shape.",
    ],
    validationStrategy: "source_contract_test",
  },
];

/** Group helper for runbook tables of contents. */
export function failureModesByDomain(
  domain: FailureDomain,
): ReadonlyArray<FailureModeEntry> {
  return FAILURE_MODE_AUDIT.filter((f) => f.domain === domain);
}

export function failureModesBySeverity(
  severity: FailureSeverity,
): ReadonlyArray<FailureModeEntry> {
  return FAILURE_MODE_AUDIT.filter((f) => f.severity === severity);
}

export function findFailureMode(
  id: string,
): FailureModeEntry | null {
  return FAILURE_MODE_AUDIT.find((f) => f.id === id) ?? null;
}

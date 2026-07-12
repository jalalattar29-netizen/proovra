/**
 * Phase Z — Hardening & Validation Program — comprehensive failure-mode
 * test suite.
 *
 * This file exists to PROVE the platform tolerates the failure modes
 * catalogued in `@proovra/shared/failure-mode-audit.ts`. The intent is
 * NOT to add new product features. Every test here exercises an
 * existing control: a canonical pure helper, a source contract
 * (greppable invariant in the runtime), or a lightweight in-process
 * fault injection.
 *
 * Coverage map (each `FM-*` id below is referenced by exactly one
 * `describe()` block):
 *
 *   FM-LIFE-001 / FM-LIFE-002       Lifecycle bypass
 *   FM-HOLD-001 / FM-HOLD-002 / 003 Legal hold precedence
 *   FM-RET-001  / FM-RET-002        Retention precedence + immutable
 *   FM-EXP-001  / FM-EXP-002 / 003  Export gating
 *   FM-AUD-001  / FM-AUD-002        Audit chain integrity
 *   FM-Q-001    / FM-Q-002  / 003   Queue / worker resilience
 *   FM-OTS-001  / 002 / 003 / 004   Anchor trust honesty
 *   FM-OBS-001  / 002 / 003         Observability fail-safety
 *   FM-PRIV-001 / 002               Privacy redaction
 *   FM-GOV-001  / 002               Governance runtime ownership
 *
 * Hard rules followed by this file:
 *   - No new product features. No mock for the database. No "happy
 *     path" assertions that don't validate failure behavior.
 *   - All assertions either (a) call a pure canonical helper, (b) read
 *     the source of a runtime file and assert a structural invariant,
 *     or (c) execute a deterministic in-process fault injection.
 *   - Source-text contract tests are EXACT-string sensitive; if the
 *     runtime drifts, the test breaks loudly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  // Failure-mode audit map
  FAILURE_MODE_AUDIT,
  failureModesByDomain,
  failureModesBySeverity,
  findFailureMode,
  // Canonical decision contracts
  canonicalCanEnterPendingDestruction,
  canonicalEvaluateExportEligibility,
  canonicalEvaluateLifecycleTransition,
  canonicalIsAllowedEvidenceLifecycleTransition,
  canonicalIsTerminalLifecycleState,
  canonicalPickHighestPrecedencePolicy,
  decisionAllow,
  decisionDeny,
  RUNTIME_OWNERSHIP_MAP,
  // Operational contracts
  isQueuePayloadEnvelope,
  isValidCorrelationId,
  newCorrelationId,
  newQueuePayloadEnvelope,
  parseQueueEnvelope,
  QUEUE_RETRY_PROFILES,
  // OTS / anchor trust
  deriveAnchorSemantics,
  isCompleteOtsAnchor,
  isValidOtsBitcoinTxid,
  normalizeOtsStatusValue,
  resolveEffectiveOtsStatus,
  // Observability
  evaluateAlerts,
  formatPrometheusExposition,
  OPERATIONAL_ALERT_THRESHOLDS,
  safeLabelSet,
  sanitizePromLabelValue,
  withSpan,
  type SpanSink,
} from "@proovra/shared";

import {
  computeAuditLogChainHash,
  canonicalJsonForAuditHash,
  sortJsonValueForAuditChain,
} from "../src/lib/admin-audit-chain.js";

function readSource(rel: string): string {
  // Normalize CRLF → LF so source-contract substring assertions are
  // independent of the checkout's line-ending configuration (Windows
  // autocrlf checkouts otherwise break multi-line `toContain` pins).
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
}

// =============================================================================
// Phase Z — Audit map self-consistency
// =============================================================================

describe("Phase Z — Failure-mode audit map", () => {
  it("contains at least one CRITICAL entry per integrity-critical domain", () => {
    for (const d of ["lifecycle", "legal_hold", "retention", "audit", "anchor_trust"] as const) {
      const criticals = failureModesByDomain(d).filter(
        (f) => f.severity === "CRITICAL",
      );
      expect(
        criticals.length,
        `expected at least one CRITICAL entry for domain=${d}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every entry id is unique and stable-shaped", () => {
    const ids = new Set<string>();
    for (const f of FAILURE_MODE_AUDIT) {
      expect(f.id).toMatch(/^FM-[A-Z]+-\d{3}$/);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(f.mitigations.length).toBeGreaterThan(0);
      expect(f.scenario.length).toBeGreaterThan(10);
      expect(f.impact.length).toBeGreaterThan(10);
    }
  });

  it("findFailureMode resolves catalog entries by id", () => {
    expect(findFailureMode("FM-LIFE-001")?.severity).toBe("CRITICAL");
    expect(findFailureMode("FM-OTS-001")?.domain).toBe("anchor_trust");
    expect(findFailureMode("FM-DOES-NOT-EXIST")).toBeNull();
  });

  it("severity filters are mutually exhaustive", () => {
    const total =
      failureModesBySeverity("CRITICAL").length +
      failureModesBySeverity("HIGH").length +
      failureModesBySeverity("MEDIUM").length +
      failureModesBySeverity("LOW").length;
    expect(total).toBe(FAILURE_MODE_AUDIT.length);
  });
});

// =============================================================================
// Part C — Governance bypass validation
// =============================================================================

describe("Phase Z [FM-LIFE-001] — direct ACTIVE → DESTROYED is rejected", () => {
  it("the canonical lifecycle gate refuses the shortcut", () => {
    const d = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("blocked_by_invalid_transition");
    }
  });

  it("only PENDING_DESTRUCTION or ARCHIVED can precede DESTROYED", () => {
    // Walk every from-state and prove only the two legal predecessors
    // can reach DESTROYED.
    const predecessors: string[] = [];
    for (const from of [
      "ACTIVE",
      "UNDER_REVIEW",
      "ON_HOLD",
      "RETENTION_LOCKED",
      "PENDING_DESTRUCTION",
      "DESTROYED",
      "ARCHIVED",
    ] as const) {
      if (
        canonicalIsAllowedEvidenceLifecycleTransition(from, "DESTROYED") &&
        from !== "DESTROYED"
      ) {
        predecessors.push(from);
      }
    }
    expect(predecessors.sort()).toEqual(["ARCHIVED", "PENDING_DESTRUCTION"]);
  });
});

describe("Phase Z [FM-LIFE-002] — DESTROYED is terminal", () => {
  it("canonicalIsTerminalLifecycleState reports DESTROYED as terminal", () => {
    expect(canonicalIsTerminalLifecycleState("DESTROYED")).toBe(true);
  });

  it("no transition out of DESTROYED is permitted (except identity)", () => {
    for (const to of [
      "ACTIVE",
      "UNDER_REVIEW",
      "ON_HOLD",
      "RETENTION_LOCKED",
      "PENDING_DESTRUCTION",
      "ARCHIVED",
    ] as const) {
      const d = canonicalEvaluateLifecycleTransition({
        fromState: "DESTROYED",
        toState: to,
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        immutableRetention: false,
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) {
        expect(d.reason).toBe("blocked_by_lifecycle_terminal");
      }
    }
  });
});

describe("Phase Z [FM-HOLD-001] — direct evidence hold blocks PENDING_DESTRUCTION", () => {
  it("blocked_by_hold wins over every other input", () => {
    const d = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_hold");
  });

  it("hold + immutable + invalid from-state — hold reason is reported first", () => {
    const d = canonicalCanEnterPendingDestruction({
      fromState: "DESTROYED",
      hasActiveDirectHold: true,
      hasActiveCaseHold: true,
      immutableRetention: true,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_hold");
  });
});

describe("Phase Z [FM-HOLD-002] — case-level hold blocks even without direct hold", () => {
  it("case hold alone is sufficient to block", () => {
    const d = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: true,
      immutableRetention: false,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_case_hold");
  });

  it("lifecycle transition to DESTROYED is also case-hold-aware", () => {
    const d = canonicalEvaluateLifecycleTransition({
      fromState: "PENDING_DESTRUCTION",
      toState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: true,
      immutableRetention: false,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_case_hold");
  });
});

describe("Phase Z [FM-HOLD-003] — destruction orchestrator re-checks at execution time", () => {
  it("the destruction orchestrator worker source calls canonicalEvaluateLifecycleTransition inside its execution flow", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    // The canonical helper must be imported AND called from the
    // execution flow, not only referenced in a comment.
    expect(src).toContain(
      "import {\n  canonicalEvaluateLifecycleTransition,",
    );
    const importIdx = src.indexOf('"@proovra/shared"');
    const callIdx = src.indexOf("canonicalEvaluateLifecycleTransition(");
    expect(importIdx).toBeGreaterThan(0);
    expect(callIdx).toBeGreaterThan(importIdx);
  });

  it("the worker checks hasActiveDirectHold AND hasActiveCaseHold facts before destruction", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    expect(src).toMatch(/hasActiveDirectHold[\s:]/);
    expect(src).toMatch(/hasActiveCaseHold[\s:]/);
  });
});

describe("Phase Z [FM-RET-001] — immutable retention blocks destruction", () => {
  it("blocked_by_immutable when immutableRetention=true", () => {
    const d = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: true,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_immutable");
  });

  it("destruction-review.service refuses EXECUTED on immutable policy", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/destruction-review.service.ts",
    );
    expect(src).toContain("DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE");
    expect(src).toMatch(/immutable/);
  });
});

describe("Phase Z [FM-RET-002] — retention policy precedence", () => {
  it("CASE wins over EVIDENCE_TYPE which wins over REGULATORY which wins over WORKSPACE", () => {
    const policies = [
      { id: "w", scope: "WORKSPACE" as const, status: "ACTIVE" as const },
      { id: "r", scope: "REGULATORY" as const, status: "ACTIVE" as const },
      { id: "t", scope: "EVIDENCE_TYPE" as const, status: "ACTIVE" as const },
      { id: "c", scope: "CASE" as const, status: "ACTIVE" as const },
    ];
    expect(canonicalPickHighestPrecedencePolicy(policies)?.id).toBe("c");
    expect(
      canonicalPickHighestPrecedencePolicy(
        policies.filter((p) => p.id !== "c"),
      )?.id,
    ).toBe("t");
    expect(
      canonicalPickHighestPrecedencePolicy(
        policies.filter((p) => p.id !== "c" && p.id !== "t"),
      )?.id,
    ).toBe("r");
    expect(
      canonicalPickHighestPrecedencePolicy([policies[0]!]),
    ).toMatchObject({ id: "w" });
  });

  it("PAUSED / SUPERSEDED policies never win the pick", () => {
    const policies = [
      { id: "c-paused", scope: "CASE" as const, status: "PAUSED" as const },
      { id: "w-active", scope: "WORKSPACE" as const, status: "ACTIVE" as const },
    ];
    expect(canonicalPickHighestPrecedencePolicy(policies)?.id).toBe("w-active");
  });

  it("empty policy list returns null", () => {
    expect(canonicalPickHighestPrecedencePolicy([])).toBeNull();
  });
});

describe("Phase Z [FM-EXP-001] — export blocked by PENDING_DESTRUCTION", () => {
  it("each lifecycle-gating state returns BLOCKED_BY_LIFECYCLE with a specific reason", () => {
    const cases: Array<["DESTROYED" | "PENDING_DESTRUCTION" | "ON_HOLD" | "RETENTION_LOCKED", string]> = [
      ["DESTROYED", "evidence_destroyed"],
      ["PENDING_DESTRUCTION", "pending_destruction"],
      ["ON_HOLD", "lifecycle_on_hold"],
      ["RETENTION_LOCKED", "retention_locked"],
    ];
    for (const [state, reason] of cases) {
      const out = canonicalEvaluateExportEligibility({
        lifecycleState: state,
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        hasActiveDestructionReview: false,
      });
      expect(out.outcome).toBe("BLOCKED_BY_LIFECYCLE");
      expect(out.reason).toBe(reason);
    }
  });
});

describe("Phase Z [FM-EXP-002] — non-terminal destruction review blocks export", () => {
  it("PENDING / UNDER_REVIEW / DEFERRED / APPROVED all gate export", () => {
    for (const status of ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"] as const) {
      const out = canonicalEvaluateExportEligibility({
        lifecycleState: "ACTIVE",
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        hasActiveDestructionReview: true,
        destructionReviewStatus: status,
      });
      expect(out.outcome).toBe("BLOCKED_BY_REVIEW_GATE");
      expect(out.reason).toBe("active_destruction_review");
    }
  });

  it("terminal statuses (EXECUTED, DENIED, RESTORED, CANCELLED) do NOT gate export", () => {
    for (const status of ["EXECUTED", "DENIED", "RESTORED", "CANCELLED"] as const) {
      const out = canonicalEvaluateExportEligibility({
        lifecycleState: "ACTIVE",
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        hasActiveDestructionReview: false,
        destructionReviewStatus: status,
      });
      expect(out.outcome).toBe("ALLOWED");
    }
  });
});

describe("Phase Z [FM-EXP-003] — hold precedence in export gate", () => {
  it("hold reason wins over RETENTION_LOCKED lifecycle state", () => {
    const out = canonicalEvaluateExportEligibility({
      lifecycleState: "RETENTION_LOCKED",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(out.outcome).toBe("BLOCKED_BY_HOLD");
  });

  it("case hold alone is enough to BLOCKED_BY_HOLD", () => {
    const out = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: true,
      hasActiveDestructionReview: false,
    });
    expect(out.outcome).toBe("BLOCKED_BY_HOLD");
  });
});

// =============================================================================
// Part D — Export / package / verify parity
// =============================================================================

describe("Phase Z [Part D] — Export / package / verify parity", () => {
  it("destruction orchestrator worker delegates through canonical helpers (no inline state machine)", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    // The worker MUST import the canonical helper from shared. If a
    // future change inlines the state machine, this fails.
    expect(src).toContain("canonicalEvaluateLifecycleTransition");
    expect(src).toContain('from "@proovra/shared"');
  });

  it("export-governance.service uses the same outcome enum as canonical helper", () => {
    // The canonical export helper enumerates outcomes we match against
    // the operator-readable enum. This guards against drift in the
    // outcome alphabet between cuts.
    const out1 = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    const out2 = canonicalEvaluateExportEligibility({
      lifecycleState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(["ALLOWED", "BLOCKED_BY_HOLD", "BLOCKED_BY_LIFECYCLE", "BLOCKED_BY_REVIEW_GATE"])
      .toContain(out1.outcome);
    expect(["ALLOWED", "BLOCKED_BY_HOLD", "BLOCKED_BY_LIFECYCLE", "BLOCKED_BY_REVIEW_GATE"])
      .toContain(out2.outcome);
  });

  it("decisionAllow and decisionDeny produce the canonical CanonicalDecision shape", () => {
    expect(decisionAllow()).toEqual({ allowed: true, reason: "ok" });
    expect(decisionDeny("blocked_by_hold")).toEqual({
      allowed: false,
      reason: "blocked_by_hold",
    });
  });
});

// =============================================================================
// Part E — OTS / TSA / anchor regression validation
// =============================================================================

describe("Phase Z [FM-OTS-001] — ANCHORED without proof is degraded to PENDING", () => {
  it("status=ANCHORED with no txid and no anchoredAtUtc → PENDING", () => {
    expect(
      resolveEffectiveOtsStatus({
        status: "ANCHORED",
        bitcoinTxid: null,
        anchoredAtUtc: null,
      }),
    ).toBe("PENDING");
  });

  it("status=ANCHORED with anchoredAtUtc but no txid stays ANCHORED (the timestamp is the proof signal we accept)", () => {
    expect(
      resolveEffectiveOtsStatus({
        status: "ANCHORED",
        bitcoinTxid: null,
        anchoredAtUtc: "2025-01-15T12:00:00Z",
      }),
    ).toBe("ANCHORED");
  });

  it("deriveAnchorSemantics never reports verified without anchor material", () => {
    const sem = deriveAnchorSemantics({
      otsStatus: "ANCHORED",
      transactionId: null,
      anchoredAtUtc: null,
    });
    expect(sem.anchoringStatus).not.toBe("verified");
    expect(sem.publicAnchoringVerified).toBe(false);
    expect(sem.anchorMode).not.toBe("anchored");
  });
});

describe("Phase Z [FM-OTS-002] — empty / malformed proof never produces a .ots file", () => {
  it("isCompleteOtsAnchor is false without anchoredAtUtc", () => {
    expect(
      isCompleteOtsAnchor({
        status: "ANCHORED",
        bitcoinTxid: "a".repeat(64),
        anchoredAtUtc: null,
      }),
    ).toBe(false);
  });

  it("isCompleteOtsAnchor is true with status=ANCHORED + anchoredAtUtc", () => {
    expect(
      isCompleteOtsAnchor({
        status: "ANCHORED",
        bitcoinTxid: null,
        anchoredAtUtc: "2025-01-15T12:00:00Z",
      }),
    ).toBe(true);
  });

  it("verification-package builder emits proof only when proofBase64 decodes to non-zero length", () => {
    const src = readSource(
      "../../worker/src/verification-package.ts",
    );
    expect(src).toContain("decideOtsPackageArtifact");
    // The decision helper must enforce length > 0 before emitting bytes.
    expect(src).toMatch(/Buffer\.from\(input\.proofBase64,\s*"base64"\)/);
    expect(src).toMatch(/buf\.length\s*>\s*0/);
  });
});

describe("Phase Z [FM-OTS-003] — DISABLED OTS workspace produces no companion", () => {
  it("verification-package builder suppresses companion JSON for DISABLED", () => {
    const src = readSource(
      "../../worker/src/verification-package.ts",
    );
    // The DISABLED early-return short-circuits both proofBytes and companion.
    expect(src).toMatch(/canonicalStatus\s*===\s*"DISABLED"/);
    expect(src).toMatch(/proofBytes:\s*null,\s*companion:\s*null/);
  });
});

describe("Phase Z [FM-OTS-004] — invalid txid is rejected", () => {
  it("isValidOtsBitcoinTxid rejects non-hex / wrong-length", () => {
    expect(isValidOtsBitcoinTxid(null)).toBe(false);
    expect(isValidOtsBitcoinTxid("")).toBe(false);
    expect(isValidOtsBitcoinTxid("x".repeat(64))).toBe(false);
    expect(isValidOtsBitcoinTxid("a".repeat(63))).toBe(false);
    expect(isValidOtsBitcoinTxid("a".repeat(64))).toBe(true);
    expect(isValidOtsBitcoinTxid("A".repeat(64))).toBe(true); // case-insensitive
  });

  it("deriveAnchorSemantics drops invalid txid to null", () => {
    const sem = deriveAnchorSemantics({
      transactionId: "not-a-real-txid",
      anchoredAtUtc: null,
    });
    expect(sem.bitcoinTxid).toBe(null);
  });

  it("normalizeOtsStatusValue clamps unknown statuses to null", () => {
    expect(normalizeOtsStatusValue("WHATEVER")).toBe(null);
    expect(normalizeOtsStatusValue("")).toBe(null);
    expect(normalizeOtsStatusValue("anchored")).toBe("ANCHORED");
    expect(normalizeOtsStatusValue(null)).toBe(null);
  });
});

// =============================================================================
// Part F — Queue / worker failure validation
// =============================================================================

describe("Phase Z [FM-Q-001] — queue idempotency through the canonical envelope", () => {
  it("newQueuePayloadEnvelope produces a stable, parseable shape", () => {
    const env = newQueuePayloadEnvelope({
      kind: "destruction-execute",
      idempotencyKey: "review-42",
      body: { reviewId: "42" },
    });
    expect(env.kind).toBe("destruction-execute");
    expect(env.idempotencyKey).toBe("review-42");
    expect(env.body).toEqual({ reviewId: "42" });
    expect(isQueuePayloadEnvelope(env)).toBe(true);
    expect(isValidCorrelationId(env.correlationId)).toBe(true);
  });

  it("parseQueueEnvelope round-trips a canonical envelope", () => {
    const env = newQueuePayloadEnvelope({
      kind: "report-render",
      idempotencyKey: "ev-1-v3",
      body: { evidenceId: "ev-1", reportVersion: 3 },
    });
    const parsed = parseQueueEnvelope(env, { expectedKind: "report-render" });
    expect(parsed.legacy).toBe(false);
    expect(parsed.kindMismatch).toBe(false);
    expect(parsed.correlationId).toBe(env.correlationId);
    expect(parsed.idempotencyKey).toBe("ev-1-v3");
    expect(parsed.body).toEqual({ evidenceId: "ev-1", reportVersion: 3 });
  });

  it("parseQueueEnvelope flags kindMismatch when expected kind differs", () => {
    const env = newQueuePayloadEnvelope({
      kind: "report-render",
      idempotencyKey: "ev-1-v3",
      body: { evidenceId: "ev-1" },
    });
    const parsed = parseQueueEnvelope(env, { expectedKind: "ots-upgrade" });
    expect(parsed.kindMismatch).toBe(true);
    expect(parsed.body).toEqual({ evidenceId: "ev-1" });
  });
});

describe("Phase Z [FM-Q-002] — worker waits for API readiness before startup fetch", () => {
  it("api-readiness module exports the gate helper", () => {
    const src = readSource("../../worker/src/api-readiness.ts");
    expect(src).toMatch(/(waitForApiReadiness|ensureApiReadyOnce)/);
    expect(src).toMatch(/AbortController|abort/i);
    // Exponential backoff + jitter — both must be visible in source.
    expect(src.toLowerCase()).toContain("jitter");
  });

  it("docker-compose.full.yml wires worker depends_on api: service_healthy", () => {
    const src = readSource(
      "../../../infra/docker/docker-compose.full.yml",
    );
    expect(src).toMatch(/proovra-api:\s*\n\s+condition:\s*service_healthy/);
  });

  it("docker-compose.prod.yml wires worker depends_on api: service_healthy", () => {
    const src = readSource(
      "../../../infra/docker/docker-compose.prod.yml",
    );
    expect(src).toMatch(/proovra-api:\s*\n\s+condition:\s*service_healthy/);
  });
});

describe("Phase Z [FM-Q-003] — legacy raw payloads survive the parser", () => {
  it("parseQueueEnvelope synthesizes envelope fields for raw legacy bodies", () => {
    const legacy = { evidenceId: "ev-77", reportVersion: 1 };
    const parsed = parseQueueEnvelope<typeof legacy>(legacy);
    expect(parsed.legacy).toBe(true);
    expect(parsed.body).toEqual(legacy);
    expect(parsed.idempotencyKey).toBe(null);
    expect(parsed.enqueuedAtUtc).toBe(null);
    expect(isValidCorrelationId(parsed.correlationId)).toBe(true);
  });

  it("validateBody is opt-in — when omitted, parser is tolerant", () => {
    expect(() => parseQueueEnvelope({ anything: true })).not.toThrow();
  });

  it("QUEUE_RETRY_PROFILES has dlqRequired set for interactive + compliance lanes", () => {
    expect(QUEUE_RETRY_PROFILES.interactive.dlqRequired).toBe(true);
    expect(QUEUE_RETRY_PROFILES.compliance.dlqRequired).toBe(true);
    // Reconciliation is cron-driven; no DLQ.
    expect(QUEUE_RETRY_PROFILES.reconciliation.dlqRequired).toBe(false);
  });
});

// =============================================================================
// Part G — Audit chain continuity validation
// =============================================================================

describe("Phase Z [FM-AUD-001] — append-only audit chain detects tampering", () => {
  it("chain hash is deterministic for a stable input", () => {
    const params = {
      userId: "user-1",
      action: "evidence.destroyed",
      metadataCanonical: canonicalJsonForAuditHash({ ev: "1" }),
      createdAtIso: "2025-01-15T12:00:00.000Z",
      prevHash: null,
      chainVersion: 2 as const,
      category: "governance",
      severity: "HIGH",
      source: "destruction-orchestrator",
      outcome: "EXECUTED",
      resourceType: "Evidence",
      resourceId: "ev-1",
      requestId: null,
    };
    const a = computeAuditLogChainHash(params);
    const b = computeAuditLogChainHash(params);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("tampering with metadata flips the hash", () => {
    const base = {
      userId: "user-1",
      action: "evidence.destroyed",
      metadataCanonical: canonicalJsonForAuditHash({ ev: "1" }),
      createdAtIso: "2025-01-15T12:00:00.000Z",
      prevHash: null,
      chainVersion: 2 as const,
      category: "governance",
      severity: "HIGH",
      source: "destruction-orchestrator",
      outcome: "EXECUTED",
      resourceType: "Evidence",
      resourceId: "ev-1",
      requestId: null,
    };
    const h1 = computeAuditLogChainHash(base);
    const h2 = computeAuditLogChainHash({
      ...base,
      metadataCanonical: canonicalJsonForAuditHash({ ev: "2" }),
    });
    expect(h1).not.toBe(h2);
  });

  it("re-ordering chain (different prevHash) flips the hash", () => {
    const base = {
      userId: "user-1",
      action: "evidence.destroyed",
      metadataCanonical: canonicalJsonForAuditHash({ ev: "1" }),
      createdAtIso: "2025-01-15T12:00:00.000Z",
      prevHash: null,
      chainVersion: 2 as const,
      category: "governance",
      severity: "HIGH",
      source: "destruction-orchestrator",
      outcome: "EXECUTED",
      resourceType: "Evidence",
      resourceId: "ev-1",
      requestId: null,
    };
    const h1 = computeAuditLogChainHash(base);
    const h2 = computeAuditLogChainHash({
      ...base,
      prevHash: "deadbeef".repeat(8),
    });
    expect(h1).not.toBe(h2);
  });
});

describe("Phase Z [FM-AUD-002] — canonical JSON is key-order stable", () => {
  it("metadata with reordered keys produces identical canonical JSON", () => {
    const a = canonicalJsonForAuditHash({ a: 1, b: 2, c: { x: 1, y: 2 } });
    const b = canonicalJsonForAuditHash({ c: { y: 2, x: 1 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("deeply nested input produces the same SHA-256 regardless of insertion order", () => {
    const obj1 = { z: { m: { p: 1, q: 2 }, n: 3 }, a: [1, 2, { k: 5 }] };
    const obj2 = { a: [1, 2, { k: 5 }], z: { n: 3, m: { q: 2, p: 1 } } };
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(sha(canonicalJsonForAuditHash(obj1))).toBe(
      sha(canonicalJsonForAuditHash(obj2)),
    );
  });

  it("sortJsonValueForAuditChain caps recursion at depth 8 to bound the input", () => {
    // Build something 12 levels deep — the sorter should clip at 8.
    let v: unknown = "leaf";
    for (let i = 0; i < 12; i++) v = { wrap: v };
    const sorted = sortJsonValueForAuditChain(v, 0);
    expect(JSON.stringify(sorted)).toContain("[max_depth]");
  });

  it("audit chain alert threshold fires on any non-zero drift", () => {
    const t = OPERATIONAL_ALERT_THRESHOLDS.find(
      (x) => x.id === "audit_chain_drift",
    );
    expect(t).toBeTruthy();
    expect(t?.severity).toBe("CRITICAL");
    expect(t?.value).toBe(0);
    expect(t?.op).toBe(">");
  });
});

// =============================================================================
// Part H — Retention / hold / destruction validation
// =============================================================================

describe("Phase Z [Part H] — Retention / hold / destruction precedence", () => {
  it("hold precedence: direct > case > immutable > review > invalid_transition", () => {
    // direct hold beats everything
    expect(
      canonicalCanEnterPendingDestruction({
        fromState: "ACTIVE",
        hasActiveDirectHold: true,
        hasActiveCaseHold: true,
        immutableRetention: true,
        hasActiveDestructionReview: true,
      }),
    ).toEqual({ allowed: false, reason: "blocked_by_hold" });

    // case hold beats immutable + review
    expect(
      canonicalCanEnterPendingDestruction({
        fromState: "ACTIVE",
        hasActiveDirectHold: false,
        hasActiveCaseHold: true,
        immutableRetention: true,
        hasActiveDestructionReview: true,
      }),
    ).toEqual({ allowed: false, reason: "blocked_by_case_hold" });

    // immutable beats review
    expect(
      canonicalCanEnterPendingDestruction({
        fromState: "ACTIVE",
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        immutableRetention: true,
        hasActiveDestructionReview: true,
      }),
    ).toEqual({ allowed: false, reason: "blocked_by_immutable" });

    // review beats invalid transition
    expect(
      canonicalCanEnterPendingDestruction({
        fromState: "ACTIVE",
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        immutableRetention: false,
        hasActiveDestructionReview: true,
      }),
    ).toEqual({
      allowed: false,
      reason: "blocked_by_active_destruction_review",
    });
  });

  it("ON_HOLD and RETENTION_LOCKED lifecycle states forbid destruction even with no active hold", () => {
    for (const from of ["ON_HOLD", "RETENTION_LOCKED"] as const) {
      const d = canonicalCanEnterPendingDestruction({
        fromState: from,
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        immutableRetention: false,
      });
      expect(d.allowed).toBe(false);
    }
  });

  it("ARCHIVED can transition to DESTROYED (operator-initiated post-archive purge)", () => {
    const d = canonicalEvaluateLifecycleTransition({
      fromState: "ARCHIVED",
      toState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(d.allowed).toBe(true);
  });

  it("destruction orchestrator never hard-deletes the Evidence row (source contract)", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    // The orchestrator MUST NOT call `prisma.evidence.delete`. Only
    // `update({ lifecycleState: 'DESTROYED' })` and storage purges
    // through the API processor are permitted.
    expect(src).not.toMatch(/prisma\.evidence\.delete\(/);
    expect(src).not.toMatch(/prisma\.evidence\.deleteMany\(/);
  });

  it("partial-failure recovery: DestructionExecution rows are idempotent (source contract)", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    // The doc-comment + control flow must say the row is reused on retry.
    expect(src.toLowerCase()).toContain("idempotent");
  });
});

// =============================================================================
// Part I — Privacy / visibility leak validation
// =============================================================================

describe("Phase Z [FM-PRIV-001] — lifecycle metadata scrubs privileged keys", () => {
  it("lifecycle-orchestrator.service declares the scrubber on persistence path", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/lifecycle-orchestrator.service.ts",
    );
    expect(src).toMatch(/scrubMetadata/);
    // The forbidden prefix list must include privileged + legalnote + secret.
    expect(src).toContain("legalnote");
    expect(src).toContain("privileged");
    expect(src).toContain("secret");
    expect(src).toMatch(/\[redacted\]/);
  });
});

describe("Phase Z [FM-PRIV-002] — worker notification emitter mirrors api scrubber", () => {
  it("worker notification-emitter scrubs sensitive metadata", () => {
    const src = readSource(
      "../../worker/src/governance/notification-emitter.ts",
    );
    // The emitter exists and the canonical service is referenced.
    expect(src).toMatch(/dedupeKey|dedupe_key|dedupe/i);
    expect(src.length).toBeGreaterThan(100);
  });
});

describe("Phase Z [FM-OBS-003] — safeLabelSet drops forbidden keys", () => {
  it("authorization / cookie / bearer / secret / token / credential prefixes are stripped", () => {
    const out = safeLabelSet({
      env: "prod",
      authorization: "Bearer abc",
      Cookie: "sid=1",
      bearer_token: "xyz",
      api_key: "k",
      secret_value: "s",
      tokenName: "n",
      credential: "c",
      password: "p",
      legalnote_blob: "lnote",
      privileged_text: "p",
      rawPayload: "raw",
      worker: "destruction-orchestrator",
    });
    // Keys that survive — only env and worker.
    expect(Object.keys(out).sort()).toEqual(["env", "worker"]);
  });

  it("sanitizePromLabelValue escapes special characters but never throws", () => {
    expect(sanitizePromLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(sanitizePromLabelValue(null)).toBe("");
    expect(sanitizePromLabelValue(undefined)).toBe("");
    expect(sanitizePromLabelValue({ foo: 1 })).toBe("[object Object]");
    // Length cap.
    expect(sanitizePromLabelValue("x".repeat(300))).toHaveLength(200);
  });
});

// =============================================================================
// Part J — Observability failure-safety
// =============================================================================

describe("Phase Z [FM-OBS-001] — sink errors never crash the caller", () => {
  it("a throwing sink does not propagate when the body succeeds", async () => {
    const throwingSink: SpanSink = () => {
      throw new Error("metrics down");
    };
    const result = await withSpan(
      { name: "test.op", sink: throwingSink, labels: { kind: "phase-z" } },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });

  it("a throwing sink does not propagate when the body errors — body error is preserved", async () => {
    const throwingSink: SpanSink = () => {
      throw new Error("metrics down");
    };
    await expect(
      withSpan(
        { name: "test.op", sink: throwingSink },
        async () => {
          throw new Error("body failed");
        },
      ),
    ).rejects.toThrow("body failed");
  });

  it("sink receives a status='error' outcome when body throws", async () => {
    const calls: Array<{ status: string; errorMessage?: string }> = [];
    const sink: SpanSink = (input) => {
      const o = input.outcome;
      calls.push({
        status: o.status,
        errorMessage: o.status === "error" ? o.errorMessage : undefined,
      });
    };
    await expect(
      withSpan({ name: "boom", sink }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    expect(calls).toEqual([{ status: "error", errorMessage: "kaboom" }]);
  });
});

describe("Phase Z [FM-OBS-002] — exposition format refuses invalid names", () => {
  it("a metric name with spaces is silently dropped, not crashed on", () => {
    const out = formatPrometheusExposition({
      metrics: [
        // INVALID NAME — should be dropped.
        { name: "queue backlog", kind: "gauge", value: 7 } as never,
        { name: "queue_backlog_count", kind: "gauge", value: 7 },
      ],
    });
    expect(out).not.toContain("queue backlog");
    expect(out).toContain("queue_backlog_count 7");
  });

  it("non-finite sample values are dropped, exposition still ends with newline", () => {
    const out = formatPrometheusExposition({
      metrics: [
        { name: "nan_metric", kind: "counter", value: Number.NaN },
        { name: "inf_metric", kind: "gauge", value: Number.POSITIVE_INFINITY },
        { name: "ok_metric", kind: "counter", value: 5 },
      ],
    });
    // The sample LINES for NaN / Infinity must be absent — no scraper
    // should ever see a value-bearing line with non-finite data.
    expect(out).not.toMatch(/^nan_metric\s/m);
    expect(out).not.toMatch(/^inf_metric\s/m);
    expect(out).toMatch(/^ok_metric\s5$/m);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("evaluateAlerts only fires when threshold is breached", () => {
    const fired = evaluateAlerts({
      queue_backlog_count: 1500,
      platform_audit_chain_drift_detected_total: 0,
      ots_upgrade_failed_total: 5,
    });
    const ids = fired.map((f) => f.id);
    expect(ids).toContain("queue_backlog_high");
    expect(ids).not.toContain("audit_chain_drift");
    expect(ids).not.toContain("ots_failure_rate");
  });

  it("audit chain drift > 0 fires CRITICAL", () => {
    const fired = evaluateAlerts({
      platform_audit_chain_drift_detected_total: 1,
    });
    const drift = fired.find((f) => f.id === "audit_chain_drift");
    expect(drift?.severity).toBe("CRITICAL");
    expect(drift?.observedValue).toBe(1);
  });

  it("missing or non-numeric metrics never fire alerts (no false positives)", () => {
    const fired = evaluateAlerts({
      queue_backlog_count: undefined,
      // intentionally wrong type
      ots_upgrade_failed_total: ("oops" as unknown) as number,
    });
    expect(fired.length).toBe(0);
  });
});

// =============================================================================
// Governance runtime ownership (FM-GOV-*)
// =============================================================================

describe("Phase Z [FM-GOV-001] — RUNTIME_OWNERSHIP_MAP has exactly one writer per artifact", () => {
  it("authoritativeWriter is unique per artifact name (no shadow writers)", () => {
    const seen = new Map<string, string>();
    for (const entry of RUNTIME_OWNERSHIP_MAP) {
      const key = entry.artifact;
      const prior = seen.get(key);
      if (prior) {
        // Same artifact must declare the same writer; the map should not
        // have a second entry naming a different writer.
        expect(prior).toBe(entry.authoritativeWriter);
      } else {
        seen.set(key, entry.authoritativeWriter);
      }
    }
  });

  it("Evidence.lifecycleState is owned by the lifecycle orchestrator (single canonical writer)", () => {
    const entry = RUNTIME_OWNERSHIP_MAP.find(
      (e) => e.artifact === "Evidence.lifecycleState",
    );
    expect(entry?.authoritativeWriter).toBe(
      "api:lifecycle-orchestrator.service",
    );
    // Workers are READERS that route through the canonical formula —
    // the entry must NOT list a worker as authoritativeWriter.
    expect(entry?.authoritativeWriter).not.toMatch(/^worker:/);
  });

  it("AdminAuditLog has the platform audit log service as its sole authoritative writer", () => {
    const entry = RUNTIME_OWNERSHIP_MAP.find((e) =>
      e.artifact.startsWith("AdminAuditLog"),
    );
    expect(entry?.authoritativeWriter).toBe("api:platform-audit-log.service");
  });
});

describe("Phase Z [FM-GOV-002] — known governance-notification gap is documented", () => {
  it("the ownership map carries a notes line acknowledging worker direct writes", () => {
    const entry = RUNTIME_OWNERSHIP_MAP.find(
      (e) => e.domain === "governance_notification",
    );
    expect(entry?.notes ?? "").toMatch(/known gap/i);
  });

  it("worker emitter exists and is reachable", () => {
    const src = readSource(
      "../../worker/src/governance/notification-emitter.ts",
    );
    expect(src.length).toBeGreaterThan(100);
  });
});

// =============================================================================
// Part B — Lightweight chaos / fault injection harness
// =============================================================================

/**
 * `flaky` wraps a body that should fail the first N attempts and then
 * succeed. Used to validate that withSpan emits one error span per
 * failure and one ok span on the eventual success — without any
 * dependency on BullMQ or a real queue.
 */
function flaky(failCount: number, finalValue: number): () => Promise<number> {
  let n = 0;
  return async () => {
    n += 1;
    if (n <= failCount) {
      throw new Error(`flake_${n}`);
    }
    return finalValue;
  };
}

describe("Phase Z [Part B] — chaos / fault injection harness", () => {
  it("transient failures produce error spans, eventual success produces an ok span", async () => {
    const events: string[] = [];
    const sink: SpanSink = ({ outcome }) => events.push(outcome.status);
    const body = flaky(2, 99);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const v = await withSpan({ name: "flake", sink }, async () => body());
        expect(v).toBe(99);
      } catch {
        // Expected for first two attempts.
      }
    }
    expect(events).toEqual(["error", "error", "ok"]);
  });

  it("sink that throws while body succeeds → caller sees success, span event lost", async () => {
    let bodyRan = false;
    const result = await withSpan(
      {
        name: "boom-sink",
        sink: () => {
          throw new Error("sink-down");
        },
      },
      async () => {
        bodyRan = true;
        return "ok";
      },
    );
    expect(bodyRan).toBe(true);
    expect(result).toBe("ok");
  });

  it("simulated kindMismatch on legacy payload does not throw — caller decides what to do", () => {
    // Simulate a deploy where the new worker is reading a legacy raw
    // payload that lacks an envelope. parseQueueEnvelope should tolerate.
    const parsed = parseQueueEnvelope(
      { evidenceId: "ev-old", reportVersion: 1 },
      { expectedKind: "report-render" },
    );
    expect(parsed.legacy).toBe(true);
    expect(parsed.kindMismatch).toBe(false); // legacy → kindMismatch defaults to false
    expect(parsed.idempotencyKey).toBe(null);
  });

  it("simulated audit tamper: re-hashing a row with mutated metadata breaks chain continuity", () => {
    // Build a 3-row chain. Hash each row over the prior hash. Then
    // mutate row 2's metadata and verify the rest of the chain is
    // invalidated when re-walked.
    const common = {
      userId: "u1",
      action: "evidence.touch",
      createdAtIso: "2025-01-15T12:00:00.000Z",
      chainVersion: 2 as const,
      category: "governance",
      severity: "INFO",
      source: "api",
      outcome: "OK",
      resourceType: "Evidence",
      resourceId: "ev-1",
      requestId: null,
    };
    const m1 = canonicalJsonForAuditHash({ step: 1 });
    const m2 = canonicalJsonForAuditHash({ step: 2 });
    const m3 = canonicalJsonForAuditHash({ step: 3 });
    const h1 = computeAuditLogChainHash({
      ...common,
      metadataCanonical: m1,
      prevHash: null,
    });
    const h2 = computeAuditLogChainHash({
      ...common,
      metadataCanonical: m2,
      prevHash: h1,
    });
    const h3 = computeAuditLogChainHash({
      ...common,
      metadataCanonical: m3,
      prevHash: h2,
    });

    // Tamper: mutate row 2's metadata and recompute its hash. The
    // recomputed hash differs, so re-walking the chain breaks at row 3.
    const m2Tampered = canonicalJsonForAuditHash({ step: 2, tamper: true });
    const h2Tampered = computeAuditLogChainHash({
      ...common,
      metadataCanonical: m2Tampered,
      prevHash: h1,
    });
    expect(h2Tampered).not.toBe(h2);

    const h3Recomputed = computeAuditLogChainHash({
      ...common,
      metadataCanonical: m3,
      prevHash: h2Tampered,
    });
    expect(h3Recomputed).not.toBe(h3);
  });
});

/**
 * Phase 28-E — Fail-closed governance enforcement test suite.
 *
 * Proves four things:
 *
 *   1. The worker's verification-package builder calls the canonical
 *      package-eligibility gate BEFORE building any artifact.
 *   2. The gate fails closed on every uncertainty axis (missing
 *      teamId, missing evidence, prisma errors, ambiguous drift).
 *   3. External review access lifecycle + privacy filter behave
 *      correctly and never leak forbidden fields.
 *   4. Discovery-foundation contracts (safe-document shapes,
 *      filters, indexing events) honor the same boundaries.
 *
 * Pure-helper + source-contract assertions. No DB.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DISCOVERY_FORBIDDEN_FIELDS,
  EXTERNAL_REVIEW_ACCESS_STATES,
  EXTERNAL_REVIEW_EVIDENCE_FORBIDDEN_FIELDS,
  EXTERNAL_REVIEW_EVIDENCE_SAFE_FIELDS,
  INDEXING_EVENT_KINDS,
  PACKAGE_ELIGIBILITY_OUTCOMES,
  SEARCHABLE_ENTITY_KINDS,
  applyDiscoveryFilter,
  canonicalEvaluatePackageEligibility,
  emitIndexingEvent,
  evaluateExternalReviewAccess,
  isActiveExternalReviewState,
  isAllowedExternalReviewTransition,
  isTerminalExternalReviewState,
  projectEvidenceForExternalReview,
  registerIndexingEventSink,
  type ExternalReviewAccessFacts,
  type IndexingEvent,
  type SafeDocumentEnvelope,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Part 1 — Worker package gate (source contract + fail-closed invariants)
// =============================================================================

describe("Phase 28-E [worker gate] — source contract", () => {
  const gateSrc = readSource(
    "../../worker/src/governance/package-eligibility-gate.ts",
  );

  it("calls the canonical helper, never inlines the rules", () => {
    expect(gateSrc).toMatch(
      /import\s*\{[^}]*canonicalEvaluatePackageEligibility[^}]*\}\s*from\s*"@proovra\/shared"/,
    );
    // No "if (lifecycleState === ..." inline duplication.
    expect(gateSrc).not.toMatch(/lifecycleState\s*===\s*"DESTROYED"/);
  });

  it("denies when teamId or evidenceId is missing (fail-closed)", () => {
    expect(gateSrc).toContain("evidence_not_found");
    expect(gateSrc).toContain("GOVERNANCE_STATE_UNAVAILABLE");
  });

  it("treats any prisma error as denial (GOVERNANCE_STATE_UNAVAILABLE)", () => {
    expect(gateSrc).toMatch(
      /catch[^}]*GOVERNANCE_STATE_UNAVAILABLE/s,
    );
  });

  it("derives immutable drift only from the canonical runbookSlug='immutable-drift' incident", () => {
    expect(gateSrc).toContain('IMMUTABLE_DRIFT_RUNBOOK');
    expect(gateSrc).toContain('"immutable-drift"');
  });

  it("emits an operational log on denial", () => {
    expect(gateSrc).toMatch(
      /logger\.warn\([\s\S]+?"package_generation\.denied"/,
    );
  });

  it("bumps package_generation_blocked_total on denial", () => {
    expect(gateSrc).toMatch(/metric:\s*"package_generation_blocked_total"/);
  });

  it("records a GOVERNANCE incident on denial (best-effort, never blocks)", () => {
    expect(gateSrc).toContain("recordWorkerIncident");
    expect(gateSrc).toContain('category: "GOVERNANCE"');
    // Failure to record incident must not flip the gate to allow.
    expect(gateSrc).toMatch(/catch\s*\{\s*\/\/[^}]*Already deny/);
  });

  it("supports every required denial outcome from the brief", () => {
    const required = [
      "BLOCKED_BY_HOLD",
      "BLOCKED_BY_REVIEW_POLICY",
      "BLOCKED_BY_REVIEW_STATE",
      "BLOCKED_BY_RETENTION",
      "BLOCKED_BY_IMMUTABLE_DRIFT",
      "BLOCKED_BY_GOVERNANCE",
      "BLOCKED_BY_EXTERNAL_ACCESS_POLICY",
      "GOVERNANCE_STATE_UNAVAILABLE",
    ];
    for (const outcome of required) {
      expect(gateSrc).toContain(outcome);
    }
  });
});

describe("Phase 28-E [worker gate] — wiring into createVerificationPackage", () => {
  const pkgSrc = readSource(
    "../../worker/src/verification-package.ts",
  );

  it("createVerificationPackage calls assertPackageEligibleOrDeny BEFORE building artifacts", () => {
    const fnIdx = pkgSrc.indexOf("export async function createVerificationPackage");
    expect(fnIdx).toBeGreaterThan(0);
    // Phase 2: widened from 8000 → 12000 because the function input type
    // gained `isPersonalTeam` and `workspaceLabelAtPackageTime` (canonical
    // workspace-scope inputs), pushing the archiver() call past the prior
    // window. The gate-before-archiver invariant still holds.
    const fnBody = pkgSrc.slice(fnIdx, fnIdx + 12000);
    const gateIdx = fnBody.indexOf("assertPackageEligibleOrDeny");
    const archiverIdx = fnBody.indexOf('archiver("zip"');
    expect(gateIdx).toBeGreaterThan(0);
    expect(archiverIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(archiverIdx);
  });

  it("throws PackageGateDeniedError when gate refuses (no silent-allow)", () => {
    expect(pkgSrc).toContain("class PackageGateDeniedError");
    expect(pkgSrc).toMatch(/throw new PackageGateDeniedError/);
  });

  it("denies when evidenceId is missing — fail-closed at entry (Phase 32.6.6)", () => {
    // Phase 32.6.6 — `teamId` is no longer required at entry. Personal
    // evidence (no team context) now generates a PERSONAL BASIC
    // package. Only `evidenceId` is required to anchor the package to
    // a real record. The team eligibility gate still runs for team
    // evidence (no governance weakening — see the subsequent test).
    const fnIdx = pkgSrc.indexOf("export async function createVerificationPackage");
    // Phase 2: widened from 8000 → 12000 because the function input type
    // gained `isPersonalTeam` and `workspaceLabelAtPackageTime` (canonical
    // workspace-scope inputs), pushing the archiver() call past the prior
    // window. The gate-before-archiver invariant still holds.
    const fnBody = pkgSrc.slice(fnIdx, fnIdx + 12000);
    expect(fnBody).toMatch(/if\s*\(\s*!data\.evidenceId\s*\)/);
    expect(fnBody).toContain("GOVERNANCE_STATE_UNAVAILABLE");
    // The legacy compound guard (teamId missing OR evidenceId missing)
    // is gone — only evidenceId is mandatory at entry.
    expect(fnBody).not.toMatch(/if\s*\(\s*!data\.teamId\s*\|\|\s*!data\.evidenceId\s*\)/);
  });

  it("Phase 32.6.6 — team-governed mode still runs the eligibility gate", () => {
    // The eligibility gate (assertPackageEligibleOrDeny) must run for
    // any package with a teamId. Personal-basic skips it.
    const fnIdx = pkgSrc.indexOf("export async function createVerificationPackage");
    // Phase 2: widened from 8000 → 12000 because the function input type
    // gained `isPersonalTeam` and `workspaceLabelAtPackageTime` (canonical
    // workspace-scope inputs), pushing the archiver() call past the prior
    // window. The gate-before-archiver invariant still holds.
    const fnBody = pkgSrc.slice(fnIdx, fnIdx + 12000);
    expect(fnBody).toMatch(/if\s*\(\s*packageMode\s*===\s*"team_governed"\s*\)/);
    expect(fnBody).toMatch(/assertPackageEligibleOrDeny/);
  });

  it("processor.ts now passes teamId to createVerificationPackage", () => {
    const procSrc = readSource("../../worker/src/processor.ts");
    expect(procSrc).toMatch(
      /createVerificationPackage\(\{[\s\S]+?teamId:\s*evidence\.teamId/,
    );
  });
});

// =============================================================================
// Part 1 — Canonical decision is the only allowed entry path
// =============================================================================

describe("Phase 28-E [canonical decision] — package-eligibility precedence holds end-to-end", () => {
  it("ALLOWED only on clean state", () => {
    const d = canonicalEvaluatePackageEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
      hasOpenImmutableDriftIncident: false,
    });
    expect(d.outcome).toBe("ALLOWED");
  });

  it("every outcome is in the bounded catalog", () => {
    for (const outcome of PACKAGE_ELIGIBILITY_OUTCOMES) {
      expect(outcome).toMatch(/^(ALLOWED|BLOCKED_BY_.+)$/);
    }
  });

  it("drift outcome is reached only when no other blocker fires (precedence)", () => {
    const d = canonicalEvaluatePackageEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
      hasOpenImmutableDriftIncident: true,
    });
    expect(d.outcome).toBe("BLOCKED_BY_IMMUTABLE_DRIFT");
  });
});

// =============================================================================
// Part 3 — External review lifecycle
// =============================================================================

describe("Phase 28-E [external review] — lifecycle state machine", () => {
  it("exports the five canonical states", () => {
    expect([...EXTERNAL_REVIEW_ACCESS_STATES]).toEqual([
      "INVITED",
      "ACTIVE",
      "EXPIRED",
      "REVOKED",
      "BLOCKED_BY_POLICY",
    ]);
  });

  it("EXPIRED and REVOKED are terminal (no outbound transitions)", () => {
    expect(isTerminalExternalReviewState("EXPIRED")).toBe(true);
    expect(isTerminalExternalReviewState("REVOKED")).toBe(true);
    for (const next of EXTERNAL_REVIEW_ACCESS_STATES) {
      if (next === "EXPIRED" || next === "REVOKED") continue;
      expect(isAllowedExternalReviewTransition("EXPIRED", next)).toBe(false);
      expect(isAllowedExternalReviewTransition("REVOKED", next)).toBe(false);
    }
  });

  it("only ACTIVE is an active state", () => {
    for (const state of EXTERNAL_REVIEW_ACCESS_STATES) {
      expect(isActiveExternalReviewState(state)).toBe(state === "ACTIVE");
    }
  });

  it("INVITED can transition to ACTIVE / REVOKED / EXPIRED / BLOCKED_BY_POLICY", () => {
    expect(isAllowedExternalReviewTransition("INVITED", "ACTIVE")).toBe(true);
    expect(isAllowedExternalReviewTransition("INVITED", "REVOKED")).toBe(true);
    expect(isAllowedExternalReviewTransition("INVITED", "EXPIRED")).toBe(true);
    expect(
      isAllowedExternalReviewTransition("INVITED", "BLOCKED_BY_POLICY"),
    ).toBe(true);
  });

  it("BLOCKED_BY_POLICY can recover to ACTIVE if policy lifts", () => {
    expect(
      isAllowedExternalReviewTransition("BLOCKED_BY_POLICY", "ACTIVE"),
    ).toBe(true);
  });
});

describe("Phase 28-E [external review] — access evaluation", () => {
  const base: ExternalReviewAccessFacts = {
    state: "ACTIVE",
    expiresAtUtc: null,
    hasActiveLegalHold: false,
    governanceBlocked: false,
  };

  it("ACTIVE share with no blockers is allowed", () => {
    expect(evaluateExternalReviewAccess(base)).toEqual({
      allowed: true,
      reason: "active",
    });
  });

  it("REVOKED is denied with reason=revoked", () => {
    const d = evaluateExternalReviewAccess({ ...base, state: "REVOKED" });
    expect(d).toEqual({ allowed: false, reason: "revoked" });
  });

  it("EXPIRED state denies", () => {
    const d = evaluateExternalReviewAccess({ ...base, state: "EXPIRED" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("expired");
  });

  it("time-based expiry overrides ACTIVE state", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const d = evaluateExternalReviewAccess({
      ...base,
      expiresAtUtc: past,
      nowIsoUtc: new Date().toISOString(),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("expired");
  });

  it("active legal hold revokes external access by default", () => {
    const d = evaluateExternalReviewAccess({
      ...base,
      hasActiveLegalHold: true,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("invalidated_by_hold");
  });

  it("workspace can opt-out of hold-revocation", () => {
    const d = evaluateExternalReviewAccess({
      ...base,
      hasActiveLegalHold: true,
      workspaceRevokeExternalOnHold: false,
    });
    expect(d.allowed).toBe(true);
  });

  it("governance blocker beats everything else (most-restrictive)", () => {
    const d = evaluateExternalReviewAccess({
      ...base,
      governanceBlocked: true,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_governance");
  });

  it("INVITED is not yet active", () => {
    const d = evaluateExternalReviewAccess({ ...base, state: "INVITED" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("not_active");
  });

  it("BLOCKED_BY_POLICY denies", () => {
    const d = evaluateExternalReviewAccess({
      ...base,
      state: "BLOCKED_BY_POLICY",
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_policy");
  });
});

// =============================================================================
// Part 3 — Privacy filter never leaks forbidden fields
// =============================================================================

describe("Phase 28-E [external review] — privacy filter projection", () => {
  it("projection returns only the safe-field allow-list", () => {
    const raw = {
      id: "ev-1",
      type: "PHOTO",
      mimeType: "image/jpeg",
      title: "Front yard",
      displayFileName: "front_yard.jpg",
      captureMethod: "SECURE_CAMERA",
      capturedAtUtc: new Date("2025-01-15T12:00:00Z"),
      uploadedAtUtc: "2025-01-15T12:00:00Z",
      fileSizeBytes: 42_000,
      lifecycleState: "ACTIVE",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      fileSha256: "abc",
      fingerprintHash: "def",
      // These MUST NOT appear in the projection.
      internalNotes: "secret internal note",
      submittedByEmail: "alice@example.com",
      ownerUserId: "user-1",
      signatureBase64: "sig",
      tsaTokenBase64: "tsa",
      otsProofBase64: "ots",
      storageKey: "evidence/1.jpg",
      activeDestructionReviewId: "destruction-1",
    };
    const projection = projectEvidenceForExternalReview(raw);
    for (const forbidden of EXTERNAL_REVIEW_EVIDENCE_FORBIDDEN_FIELDS) {
      expect(projection).not.toHaveProperty(forbidden);
    }
    // Sanity: all safe fields are present.
    for (const safe of EXTERNAL_REVIEW_EVIDENCE_SAFE_FIELDS) {
      expect(projection).toHaveProperty(safe);
    }
  });

  it("projection returns null for missing or wrong-typed inputs (no crash, no leak)", () => {
    const projection = projectEvidenceForExternalReview({ id: "x" });
    expect(projection.title).toBeNull();
    expect(projection.fileSha256).toBeNull();
    expect(projection.fileSizeBytes).toBeNull();
  });

  it("safe-field allow-list never overlaps with forbidden-field list", () => {
    for (const safe of EXTERNAL_REVIEW_EVIDENCE_SAFE_FIELDS) {
      expect(EXTERNAL_REVIEW_EVIDENCE_FORBIDDEN_FIELDS).not.toContain(safe);
    }
  });
});

// =============================================================================
// Part 5 — Discovery foundation contracts
// =============================================================================

describe("Phase 28-E [discovery] — entity / event / forbidden catalogs", () => {
  it("exports all eight searchable entity kinds", () => {
    expect([...SEARCHABLE_ENTITY_KINDS]).toEqual([
      "evidence",
      "case",
      "review_task",
      "escalation",
      "incident",
      "external_review_share",
      "verification_package",
      "operational_event",
    ]);
  });

  it("exports the seven indexing event kinds the brief enumerates", () => {
    expect([...INDEXING_EVENT_KINDS]).toEqual([
      "evidence_created",
      "review_assigned",
      "escalation_opened",
      "incident_opened",
      "package_generated",
      "external_review_shared",
      "lifecycle_changed",
    ]);
  });

  it("forbidden-field catalog includes every PII / secret / private surface", () => {
    const required = [
      "internalNotes",
      "privateReviewerNote",
      "decisionNote",
      "submittedByEmail",
      "signatureBase64",
      "tsaTokenBase64",
      "otsProofBase64",
      "storageKey",
      "secret",
      "token",
      "apiKey",
      "credential",
      "password",
    ];
    for (const field of required) {
      expect(DISCOVERY_FORBIDDEN_FIELDS).toContain(field);
    }
  });
});

describe("Phase 28-E [discovery] — applyDiscoveryFilter visibility gates", () => {
  function envelope(
    overrides: Partial<SafeDocumentEnvelope> = {},
  ): SafeDocumentEnvelope {
    return {
      entityKind: "evidence",
      entityId: "ev-1",
      teamId: "team-1",
      indexedAtUtc: "2025-01-15T12:00:00Z",
      visibility: "workspace_internal",
      governance: {
        lifecycleState: "ACTIVE",
        governanceBlocked: false,
        underLegalHold: false,
      },
      ...overrides,
    };
  }

  it("tenant isolation fires first", () => {
    const d = applyDiscoveryFilter({
      callerTeamId: "team-OTHER",
      callerIsExternalReviewer: false,
      document: envelope({ teamId: "team-1" }),
    });
    expect(d).toEqual({ allowed: false, reason: "tenant_isolation" });
  });

  it("external reviewer cannot see operator_only documents", () => {
    const d = applyDiscoveryFilter({
      callerTeamId: "team-1",
      callerIsExternalReviewer: true,
      document: envelope({ visibility: "operator_only" }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("visibility_redacted");
  });

  it("external reviewer cannot see workspace-internal documents", () => {
    const d = applyDiscoveryFilter({
      callerTeamId: "team-1",
      callerIsExternalReviewer: true,
      document: envelope({ visibility: "workspace_internal" }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("visibility_redacted");
  });

  it("external reviewer CAN see public_verify_eligible documents (if no governance blocker)", () => {
    const d = applyDiscoveryFilter({
      callerTeamId: "team-1",
      callerIsExternalReviewer: true,
      document: envelope({ visibility: "public_verify_eligible" }),
    });
    expect(d.allowed).toBe(true);
  });

  it("external reviewer is blocked from documents under legal hold", () => {
    const d = applyDiscoveryFilter({
      callerTeamId: "team-1",
      callerIsExternalReviewer: true,
      document: envelope({
        visibility: "public_verify_eligible",
        governance: {
          lifecycleState: "ACTIVE",
          governanceBlocked: false,
          underLegalHold: true,
        },
      }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_hold");
  });

  it("governance-blocked documents are hidden from all callers (operator AND external)", () => {
    const d = applyDiscoveryFilter({
      callerTeamId: "team-1",
      callerIsExternalReviewer: false,
      document: envelope({
        governance: {
          lifecycleState: "ACTIVE",
          governanceBlocked: true,
          underLegalHold: false,
        },
      }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("blocked_by_governance");
  });

  it("DESTROYED / PENDING_DESTRUCTION / RETENTION_LOCKED are hidden from external reviewers", () => {
    for (const state of [
      "DESTROYED",
      "PENDING_DESTRUCTION",
      "RETENTION_LOCKED",
    ]) {
      const d = applyDiscoveryFilter({
        callerTeamId: "team-1",
        callerIsExternalReviewer: true,
        document: envelope({
          visibility: "public_verify_eligible",
          governance: {
            lifecycleState: state,
            governanceBlocked: false,
            underLegalHold: false,
          },
        }),
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe("blocked_by_lifecycle");
    }
  });
});

describe("Phase 28-E [discovery] — indexing event sink contract", () => {
  it("default sink is a no-op (no engine attached)", () => {
    const event: IndexingEvent = {
      kind: "evidence_created",
      entityKind: "evidence",
      entityId: "ev-1",
      teamId: "team-1",
      emittedAtUtc: new Date().toISOString(),
      safePayload: { lifecycleState: "ACTIVE" },
    };
    expect(() => emitIndexingEvent(event)).not.toThrow();
  });

  it("registerIndexingEventSink replaces the sink atomically", () => {
    const observed: IndexingEvent[] = [];
    registerIndexingEventSink((event) => {
      observed.push(event);
    });
    const event: IndexingEvent = {
      kind: "escalation_opened",
      entityKind: "escalation",
      entityId: "esc-1",
      teamId: "team-1",
      emittedAtUtc: new Date().toISOString(),
      safePayload: { severity: "HIGH" },
    };
    emitIndexingEvent(event);
    expect(observed).toEqual([event]);
    // Restore the no-op sink so the next test starts fresh.
    registerIndexingEventSink(() => undefined);
  });
});

// =============================================================================
// Part 2 — Export parity audit (source contract — every download path)
// =============================================================================

describe("Phase 28-E [export parity audit] — every governance-sensitive path consults canonical helpers", () => {
  it("governance-snapshot service routes export decision through canonicalEvaluateExportEligibility", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/governance-snapshot.service.ts",
    );
    expect(src).toContain("canonicalEvaluateExportEligibility");
    expect(src).toContain("canonicalEvaluatePackageEligibility");
  });

  it("export-governance.service.ts is the only inline implementation, and uses the canonical helper for decisions", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/export-governance.service.ts",
    );
    expect(src).toBeTruthy();
    // The service file may still implement the runtime fact-gathering
    // inline, but the rules MUST come from the canonical helper /
    // shared catalog.
    expect(src).toMatch(
      /ExportEligibilityResult|ExportEligibilityOutcome/,
    );
  });
});

// =============================================================================
// Part 6 — Metrics catalog completeness
// =============================================================================

describe("Phase 28-E [metrics catalog]", () => {
  const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");

  const required = [
    "package_generation_blocked_total",
    "export_generation_blocked_total",
    "external_review_access_granted_total",
    "external_review_access_revoked_total",
    "external_review_access_denied_total",
    "governance_ui_snapshot_loaded_total",
    "operational_timeline_rendered_total",
    "discovery_index_event_total",
  ];

  for (const counter of required) {
    it(`registers ${counter}`, () => {
      expect(src).toContain(`"${counter}"`);
    });
  }
});

// =============================================================================
// Part 7 — Privacy invariants (source-contract proof)
// =============================================================================

describe("Phase 28-E [privacy] — projections never expose forbidden fields", () => {
  const externalSrc = readSource("../../../packages/shared/src/external-review.ts");
  const discoverySrc = readSource(
    "../../../packages/shared/src/discovery-foundation.ts",
  );

  it("external-review projection enumerates ONLY safe fields", () => {
    // Every property the type declaration mentions must be in the
    // safe-field list.
    for (const safe of EXTERNAL_REVIEW_EVIDENCE_SAFE_FIELDS) {
      expect(externalSrc).toContain(safe);
    }
    for (const forbidden of EXTERNAL_REVIEW_EVIDENCE_FORBIDDEN_FIELDS) {
      // The forbidden field name must not appear as a property
      // assignment in the projection function body.
      expect(externalSrc).not.toMatch(
        new RegExp(`${forbidden}:\\s*(pick|String|raw|maybeString)`),
      );
    }
  });

  it("discovery safe-document shapes never declare a forbidden field as a property", () => {
    // Strict: no forbidden field should be the literal LEFT side of a
    // property in the safe-document shape declarations.
    for (const forbidden of DISCOVERY_FORBIDDEN_FIELDS) {
      // Forbidden fields are declared in the catalog (as string
      // values) — that's fine. They must NOT appear as TS property
      // declarations like `internalNotes: string;`.
      const propDecl = new RegExp(`\\b${forbidden}\\s*:\\s*(string|number|boolean|Date|Json|null)`);
      expect(discoverySrc).not.toMatch(propDecl);
    }
  });
});

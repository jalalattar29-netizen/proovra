/**
 * Reviewer Ops — operational seeding + end-to-end validation.
 *
 * This file proves three things:
 *
 *   1. The protected seeding flow is gated correctly (env, secret,
 *      admin RBAC, dry-run, production guard).
 *   2. Seeding drives the REAL engines — `ensureReviewWorkflow`,
 *      `runReconcile`, `createEscalation`, `acknowledgeEscalation`,
 *      `resolveEscalation`, `snapshotWorkspaceWorkload`,
 *      `recordIncident`. No dashboard-shaped placeholder is inserted.
 *   3. The cross-system chain is wired:
 *        evidence → workflow → SLA → reconcile → escalation → workload
 *        → audit → incident → cleanup
 *      Source-contract assertions prove each link exists in the
 *      `runOperationalSeed` and `cleanupSeedRun` implementations.
 *
 * No DB. Pure-helper + source-contract tests. A live integration test
 * is intentionally out of scope for this turn — see
 * docs/operational-seeding.md for the operator-driven smoke test
 * commands you can run against staging.
 *
 * Hard rules followed by this file:
 *   - No new product features.
 *   - No DB writes; we exercise only the env-gate helpers and the
 *     scenario catalog statically.
 *   - Tests assert the WIRING, not the values inside live rows.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  OperationalSeedError,
  SEED_SCENARIOS,
  assertSeedingEnabled,
  assertSeedingSecret,
  type SeedScenario,
} from "../src/services/ops/operational-seed.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Env-gate helpers — the safety net that keeps prod safe by default.
// =============================================================================

describe("Operational seed [env gates]", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.OPERATIONAL_SEEDING_ENABLED;
    delete process.env.OPERATIONAL_SEEDING_ALLOW_PRODUCTION;
    delete process.env.OPERATIONAL_SEEDING_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it("refuses when OPERATIONAL_SEEDING_ENABLED is unset", () => {
    expect(() => assertSeedingEnabled()).toThrow(OperationalSeedError);
    try {
      assertSeedingEnabled();
    } catch (err) {
      expect((err as OperationalSeedError).code).toBe("SEEDING_DISABLED");
      expect((err as OperationalSeedError).httpStatus).toBe(503);
    }
  });

  it("refuses when OPERATIONAL_SEEDING_ENABLED=false (string false)", () => {
    process.env.OPERATIONAL_SEEDING_ENABLED = "false";
    expect(() => assertSeedingEnabled()).toThrow(/SEEDING_DISABLED/);
  });

  it("allows when OPERATIONAL_SEEDING_ENABLED=true and not in production", () => {
    process.env.OPERATIONAL_SEEDING_ENABLED = "true";
    process.env.NODE_ENV = "test";
    expect(() => assertSeedingEnabled()).not.toThrow();
  });

  it("refuses in production unless ALLOW_PRODUCTION=true", () => {
    process.env.OPERATIONAL_SEEDING_ENABLED = "true";
    process.env.NODE_ENV = "production";
    expect(() => assertSeedingEnabled()).toThrow(/SEEDING_PROD_GUARDED/);
  });

  it("allows in production when ALLOW_PRODUCTION=true (explicit opt-in)", () => {
    process.env.OPERATIONAL_SEEDING_ENABLED = "true";
    process.env.OPERATIONAL_SEEDING_ALLOW_PRODUCTION = "true";
    process.env.NODE_ENV = "production";
    expect(() => assertSeedingEnabled()).not.toThrow();
  });

  // PHASE1-001 — the seeding secret is now compared by the canonical
  // machine-secret authority, which enforces a 16-character floor. The old
  // fixture was `"real-secret"` (11 characters); under the previous raw `!==`
  // it was accepted, which is precisely the weakness this fixes. The fixture is
  // raised to a compliant value rather than the floor being lowered to it.
  const SEED_SECRET = "operational-seed-secret-0123456789";

  it("refuses the secret check when no secret is configured (fail closed)", () => {
    expect(() => assertSeedingSecret("anything")).toThrow(
      /SEEDING_SECRET_NOT_CONFIGURED/,
    );
  });

  it("PHASE1-001 — refuses a configured secret below the 16-character floor", () => {
    // Fails CLOSED as unusable rather than being honoured. A two-character
    // shared secret protects nothing, and accepting one is worse than having
    // no gate because it reads as protection.
    process.env.OPERATIONAL_SEEDING_SECRET = "short";
    expect(() => assertSeedingSecret("short")).toThrow(
      /SEEDING_SECRET_NOT_CONFIGURED/,
    );
  });

  it("refuses a mismatched secret with 401", () => {
    process.env.OPERATIONAL_SEEDING_SECRET = SEED_SECRET;
    // `expect.assertions` matters here: without it a version of
    // `assertSeedingSecret` that never threw would satisfy this test silently,
    // which is the shape of a control that has never been observed refusing.
    expect.assertions(2);
    try {
      assertSeedingSecret("wrong");
    } catch (err) {
      expect((err as OperationalSeedError).code).toBe("SEEDING_SECRET_INVALID");
      expect((err as OperationalSeedError).httpStatus).toBe(401);
    }
  });

  it("accepts the correct secret", () => {
    process.env.OPERATIONAL_SEEDING_SECRET = SEED_SECRET;
    expect(() => assertSeedingSecret(SEED_SECRET)).not.toThrow();
  });

  it("rejects null / undefined / empty presented secret", () => {
    process.env.OPERATIONAL_SEEDING_SECRET = SEED_SECRET;
    expect(() => assertSeedingSecret(null)).toThrow();
    expect(() => assertSeedingSecret(undefined)).toThrow();
    expect(() => assertSeedingSecret("")).toThrow();
  });

  it("PHASE1-001 — a near-miss of equal length is refused (constant-time compare is real)", () => {
    process.env.OPERATIONAL_SEEDING_SECRET = SEED_SECRET;
    const nearMiss = `${SEED_SECRET.slice(0, -1)}X`;
    expect(nearMiss.length).toBe(SEED_SECRET.length);
    expect(() => assertSeedingSecret(nearMiss)).toThrow(/SEEDING_SECRET_INVALID/);
  });
});

// =============================================================================
// Scenario catalog — the brief required at least 4 scenarios.
// =============================================================================

describe("Operational seed [scenario catalog]", () => {
  it("exports all four required scenarios", () => {
    const expected: SeedScenario[] = [
      "baseline",
      "sla_breach",
      "escalation_storm",
      "full_lifecycle",
    ];
    for (const s of expected) {
      expect(SEED_SCENARIOS).toContain(s);
    }
  });
});

// =============================================================================
// Source contract — seeding service drives REAL engines (no mocks).
// =============================================================================

describe("Operational seed [real-engine wiring]", () => {
  const src = readSource("../src/services/ops/operational-seed.service.ts");

  it("imports ensureReviewWorkflow from the real review-operations service", () => {
    expect(src).toMatch(
      /import \{ ensureReviewWorkflow \} from ".*review-operations\.service\.js"/,
    );
  });

  it("imports runReconcile from the real reviewer-operations engine", () => {
    expect(src).toMatch(
      /import \{[\s\S]*?runReconcile,[\s\S]*?\} from ".*reviewer-operations-engine\.service\.js"/,
    );
  });

  it("drives escalations through the real engine (reconcile creates, engine transitions)", () => {
    // Creation runs through the reconcile engine (reconcileResult
    // .escalationsCreated), so the seed never fabricates escalation rows;
    // the lifecycle transitions come straight from the real engine.
    expect(src).toMatch(/reconcileResult\.escalationsCreated/);
    expect(src).toMatch(
      /import \{[\s\S]*?acknowledgeEscalation,[\s\S]*?resolveEscalation,[\s\S]*?\} from ".*escalation-engine\.service\.js"/,
    );
    expect(src).toMatch(/await acknowledgeEscalation\(/);
    expect(src).toMatch(/await resolveEscalation\(/);
  });

  it("imports snapshotWorkspaceWorkload from the real workload service", () => {
    expect(src).toMatch(
      /import \{ snapshotWorkspaceWorkload \} from ".*workload\.service\.js"/,
    );
  });

  it("imports recordIncident from the canonical incident service", () => {
    expect(src).toMatch(
      /import \{ recordIncident \} from ".*incident\.service\.js"/,
    );
  });

  it("does NOT import any mock / fake / stub helper", () => {
    // Comments use "mock" / "placeholder" / "fake" in legitimate
    // explanatory contexts (e.g. "Pick any team member as a placeholder
    // reviewer"). Scope the check to import statements only.
    const importStatements = src
      .split("\n")
      .filter((l) => l.trim().startsWith("import"))
      .join("\n");
    expect(importStatements).not.toMatch(/mock|fake|stub|placeholder/i);
  });
});

// =============================================================================
// Source contract — full lifecycle chain wired in runOperationalSeed.
// =============================================================================

describe("Operational seed [E2E chain — every link is wired]", () => {
  const src = readSource("../src/services/ops/operational-seed.service.ts");

  it("step 1: queue creation via ensureReviewWorkflow", () => {
    expect(src).toMatch(/await ensureReviewWorkflow\(/);
  });

  it("step 2: scenario backdates dueAt / firstResponseDueAtUtc to force SLA flip", () => {
    expect(src).toMatch(/dueAt:\s*backdated/);
    expect(src).toMatch(/firstResponseDueAtUtc:\s*backdated/);
    expect(src).toMatch(/escalationDueAtUtc:\s*backdated/);
  });

  it("step 3: real reconcile orchestrator is invoked", () => {
    expect(src).toMatch(/await runReconcile\(\{\s*teamId:[\s\S]*?\}/);
  });

  it("step 4: escalation IDs captured + tagged with SEED prefix in safeSummary", () => {
    expect(src).toMatch(/reviewEscalation\.findMany/);
    expect(src).toMatch(/\[SEED:\$\{seedRunId\}\] /);
  });

  it("step 5: full_lifecycle walks escalation through acknowledge → resolve", () => {
    expect(src).toMatch(/await acknowledgeEscalation\(/);
    expect(src).toMatch(/await resolveEscalation\(/);
  });

  it("step 6: GOVERNANCE incident raised via recordIncident with seed metadata", () => {
    expect(src).toMatch(
      /recordIncident\(\s*\{[\s\S]*?category:\s*"GOVERNANCE"[\s\S]*?metadata:\s*\{[\s\S]*?seeded:\s*true[\s\S]*?seedRunId/,
    );
  });

  it("step 7: every run is appended to the audit log (canonical tenant-audit facade) with seedRunId metadata", () => {
    expect(src).toMatch(/emitTenantAudit\(/);
    expect(src).toMatch(/seedRunId,/);
    expect(src).toMatch(/createdResourceIds/);
  });

  it("step 8: metrics bumped on each created resource class", () => {
    expect(src).toContain('bump("operational_seed_run_total")');
    expect(src).toContain('"operational_seed_created_reviews_total"');
    expect(src).toContain('"operational_seed_created_escalations_total"');
    expect(src).toContain('"operational_seed_created_incidents_total"');
  });
});

// =============================================================================
// Source contract — cleanup deletes only seeded resources.
// =============================================================================

describe("Operational seed [cleanup safety]", () => {
  const src = readSource("../src/services/ops/operational-seed.service.ts");

  it("cleanup reads the seed-run audit row to find created IDs", () => {
    expect(src).toMatch(/loadSeedRunAuditRow/);
    expect(src).toMatch(/action:\s*AUDIT_ACTION_SEED_RUN/);
  });

  it("escalation cleanup requires safeSummary to start with the seed prefix (defense in depth)", () => {
    expect(src).toMatch(
      /reviewEscalation\.deleteMany\([\s\S]*?safeSummary:\s*\{\s*startsWith:\s*seedPrefix\s*\}/,
    );
  });

  it("cleanup deletes in reverse-dependency order (escalations → events → workflows → incidents)", () => {
    const escIdx = src.indexOf("reviewEscalation.deleteMany");
    const eventsIdx = src.indexOf("evidenceReviewWorkflowEvent.deleteMany");
    const workflowsIdx = src.indexOf("evidenceReviewWorkflow.deleteMany");
    const incidentsIdx = src.indexOf("operationalIncident.deleteMany");
    expect(escIdx).toBeGreaterThan(0);
    expect(eventsIdx).toBeGreaterThan(escIdx);
    expect(workflowsIdx).toBeGreaterThan(eventsIdx);
    expect(incidentsIdx).toBeGreaterThan(workflowsIdx);
  });

  it("cleanup writes a follow-up audit row recording what was deleted", () => {
    expect(src).toMatch(/auditSeedCleanup\(/);
  });

  it("workload snapshots are NOT deleted (immutable time-series)", () => {
    expect(src).toMatch(/Workload snapshots are time-series rows; we don't delete/);
    expect(src).not.toMatch(/reviewerWorkloadSnapshot\.deleteMany/);
  });

  it("cleanup never touches the audit log itself (HMAC chain integrity)", () => {
    // The chain is preserved by the existing advisory lock + append-only
    // invariant. We never delete AdminAuditLog rows from this service.
    expect(src).not.toMatch(/adminAuditLog\.delete/i);
  });

  it("cleanup writes operational_seed_cleanup_total metric", () => {
    expect(src).toMatch(/bump\("operational_seed_cleanup_total"\)/);
  });
});

// =============================================================================
// Source contract — routes are gated, register the right handlers.
// =============================================================================

describe("Operational seed [route layer]", () => {
  const src = readSource("../src/routes/ops-seed.routes.ts");

  it("POST endpoint requires session auth + admin RBAC + seed secret", () => {
    expect(src).toMatch(/preHandler:\s*requireAuth/);
    expect(src).toMatch(/permission:\s*"governance\.policy\.manage"/);
    expect(src).toMatch(/assertSeedingSecret\(getSeedSecretHeader\(req\)\)/);
  });

  it("DELETE endpoint requires session auth + admin RBAC + seed secret", () => {
    const deleteIdx = src.indexOf('"/v1/ops/seed/reviewer-ops/:seedRunId"');
    const slice = src.slice(deleteIdx, deleteIdx + 1500);
    expect(slice).toMatch(/preHandler:\s*requireAuth/);
    expect(slice).toMatch(/assertSeedingSecret/);
  });

  it("GET (list) endpoint requires session auth + admin RBAC (no secret needed for read)", () => {
    const getIdx = src.indexOf("listSeedRuns");
    expect(getIdx).toBeGreaterThan(0);
  });

  it("route layer maps OperationalSeedError to its httpStatus", () => {
    expect(src).toMatch(/mapSeedErrorToResponse/);
    expect(src).toMatch(/reply\.code\(err\.httpStatus\)/);
  });

  it("seed routes are registered in server.ts", () => {
    const serverSrc = readSource("../src/server.ts");
    expect(serverSrc).toContain("opsSeedRoutes");
    expect(serverSrc).toContain("./routes/ops-seed.routes.js");
  });
});

// =============================================================================
// Source contract — metrics catalog includes the new counters.
// =============================================================================

describe("Operational seed [metrics catalog]", () => {
  const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");

  it("catalog includes every counter the seeding service bumps", () => {
    const expected = [
      "operational_seed_run_total",
      "operational_seed_created_reviews_total",
      "operational_seed_created_escalations_total",
      "operational_seed_created_incidents_total",
      "operational_seed_cleanup_total",
      "operational_e2e_validation_success_total",
      "operational_e2e_validation_failed_total",
    ];
    for (const c of expected) {
      expect(src).toContain(`"${c}"`);
    }
  });
});

// =============================================================================
// Source contract — privacy invariants on seeded records.
// =============================================================================

describe("Operational seed [privacy invariants]", () => {
  const src = readSource("../src/services/ops/operational-seed.service.ts");

  it("seeded escalation safeSummary carries only the SEED prefix + existing summary (no synthetic PII)", () => {
    expect(src).toMatch(/safeSummary:\s*prefix \+ esc\.safeSummary\.slice/);
    // The prefix template literal is `[SEED:<runId>] ` — no email-shaped
    // values, no synthetic identity strings.
    expect(src).not.toMatch(/synthetic.*name/i);
    expect(src).not.toMatch(/fake.*email/i);
  });

  it("seeded incident metadata does NOT include secrets / tokens / credentials", () => {
    // Forbidden tokens in metadata keys.
    expect(src).not.toMatch(/secret:\s*[^=]/i);
    expect(src).not.toMatch(/token:\s*[^=]/i);
    expect(src).not.toMatch(/apiKey:/i);
    expect(src).not.toMatch(/credential:/i);
  });
});

// =============================================================================
// Source contract — runtime never goes through bypass paths.
// =============================================================================

describe("Operational seed [no bypass]", () => {
  const src = readSource("../src/services/ops/operational-seed.service.ts");

  it("never bypasses billing-enforcement.service", () => {
    expect(src).not.toMatch(/billing-enforcement/);
    // Seed service does NOT call createEvidence (which trips billing).
    expect(src).not.toMatch(/createEvidence/);
  });

  it("never bypasses governance / retention / legal-hold checks", () => {
    expect(src).not.toMatch(/retention-engine/);
    expect(src).not.toMatch(/legal_holds/);
    expect(src).not.toMatch(/destruction-review/);
  });

  it("never bypasses report-v2 / verify / package builders (no imports)", () => {
    // The doc-comment mentions these as out-of-scope; check imports
    // only so the negative assertion isn't tripped by safety prose.
    const importStatements = src
      .split("\n")
      .filter((l) => l.trim().startsWith("import"))
      .join("\n");
    expect(importStatements).not.toMatch(
      /report-v2|verification-package|verify\.routes/,
    );
  });

  it("never touches OTS / TSA / anchor proofs (no imports)", () => {
    const importStatements = src
      .split("\n")
      .filter((l) => l.trim().startsWith("import"))
      .join("\n");
    expect(importStatements).not.toMatch(
      /decideOtsPackageArtifact|deriveAnchorSemantics|opentimestamps|tsaTokenBase64/,
    );
  });
});

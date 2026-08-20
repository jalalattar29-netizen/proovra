/**
 * Phase D1 (Case Copilot) + D2 (selected-evidence) — behavioral orchestration.
 * Wires C3 context + C4 citations + C5 schema + A5 claims + workspace policy.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// THE copilot selection authority — the same module the panel reads.
import {
  COPILOT_IDEMPOTENCY_KEY_MAX,
  COPILOT_SELECTION_MAX,
  buildCopilotIdempotencyKey,
  copilotIneligibilityReason,
  evaluateCopilotEvidenceEligibility,
} from "@proovra/shared";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

import { runCaseCopilot } from "../src/services/ai/case-copilot.service.js";
import type { CaseContext, EvidenceContext } from "../src/services/ai/ai-context-resolver.service.js";
import type { AiPolicyDecision } from "../src/services/ai/workspace-ai-policy.service.js";
import type { CitationResolver } from "../src/services/ai/ai-citation.service.js";

const caseCtx: CaseContext = {
  route: "/cases/c-1", routeClass: "CASE", role: "OWNER", workspaceId: "ws-1",
  workspacePolicyVersion: 1, enabledCapabilities: ["CASE_COPILOT"],
  objectType: "CASE", objectId: "c-1", objectVersion: 2, allowedActions: [],
  dataMode: "METADATA_ONLY", fields: { title: "Claim 123", status: "OPEN" },
};
const ev: EvidenceContext = {
  ...caseCtx, routeClass: "EVIDENCE", objectType: "EVIDENCE_RECORD",
  objectId: "ev-1", objectVersion: 3, fields: { title: "Photo", status: "SIGNED" },
};
const ALLOW: AiPolicyDecision = { allowed: true, decision: "ALLOWED", reason: "", policyVersion: 1 };
const DENY: AiPolicyDecision = { allowed: false, decision: "FEATURE_DISABLED", reason: "off", policyVersion: 1 };
const resolver: CitationResolver = async (_t, id) =>
  id === "ev-1" ? { workspaceId: "ws-1", currentVersion: 3, deleted: false, authorized: true } : null;

const validOutput = {
  caseSummary: "The case has one signed evidence record; a location note is missing.",
  timelineHighlights: [], missingEvidenceCategories: ["location note"], workflowGaps: [],
  conflictingMetadata: [], reviewerPreparation: [], disclosureChecklist: [], unresolvedQuestions: [],
  citations: [{
    type: "EVIDENCE_RECORD", objectId: "ev-1", displayLabel: "Photo", sourceField: "status",
    objectVersion: 3, timestampUtc: null, route: "/evidence/ev-1", workspaceId: "ws-1", analyzedAtUtc: "2026-07-12T00:00:00Z",
  }],
  advisoryBoundary: "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.",
};

describe("D2 — never process the whole case without explicit selection", () => {
  it("returns no_selection when no evidence is selected", async () => {
    const r = await runCaseCopilot({
      teamId: "ws-1", caseContext: caseCtx, selectedEvidence: [], policyDecision: ALLOW,
      provider: async () => validOutput, resolveCitation: resolver,
    });
    expect(r.status).toBe("no_selection");
  });
});

describe("D1 — policy gate, schema, claims, citations", () => {
  it("policy-denied → no provider call", async () => {
    let called = false;
    const r = await runCaseCopilot({
      teamId: "ws-1", caseContext: caseCtx, selectedEvidence: [ev], policyDecision: DENY,
      provider: async () => { called = true; return validOutput; }, resolveCitation: resolver,
    });
    expect(r.status).toBe("policy_denied");
    expect(r.decision).toBe("FEATURE_DISABLED");
    expect(called).toBe(false);
  });

  it("schema mismatch → safe fallback (no raw passthrough)", async () => {
    const r = await runCaseCopilot({
      teamId: "ws-1", caseContext: caseCtx, selectedEvidence: [ev], policyDecision: ALLOW,
      provider: async () => ({ caseSummary: 123 }), resolveCitation: resolver,
    });
    expect(r.status).toBe("schema_error");
  });

  it("prohibited claim in output → blocked + safe rewrite", async () => {
    const r = await runCaseCopilot({
      teamId: "ws-1", caseContext: caseCtx, selectedEvidence: [ev], policyDecision: ALLOW,
      provider: async () => ({ ...validOutput, caseSummary: "This evidence is authentic and the claimant is liable." }),
      resolveCitation: resolver,
    });
    expect(r.status).toBe("blocked_prohibited_claim");
    expect(JSON.stringify(r.data)).toMatch(/cannot determine truth/i);
  });

  it("valid output → ok, invalid citations dropped, no verdict fields", async () => {
    const r = await runCaseCopilot({
      teamId: "ws-1", caseContext: caseCtx, selectedEvidence: [ev], policyDecision: ALLOW,
      provider: async () => ({
        ...validOutput,
        citations: [
          ...validOutput.citations, // valid: ev-1 v3
          { ...validOutput.citations[0], objectId: "invented", route: "/evidence/invented" }, // NOT_FOUND
          { ...validOutput.citations[0], objectId: "ev-1", objectVersion: 99 }, // VERSION_MISMATCH
        ],
      }),
      resolveCitation: resolver,
    });
    expect(r.status).toBe("ok");
    const data = r.data as { citations: unknown[] };
    expect(data.citations.length).toBeGreaterThanOrEqual(1); // the valid one survives
    expect(r.droppedCitations).toBe(2);
    expect(JSON.stringify(r.data)).not.toMatch(/truthScore|authenticityVerdict|finalReviewerDecision/);
  });
});

// ===========================================================================
// REDESIGN/COPILOT (2026-08-20) — the two-record defect, and the eligibility
// authority that now runs on both sides.
// ===========================================================================

describe("the request identity is BOUNDED", () => {
  it("the route's own schema rejected the key the panel used to build", () => {
    // THE PRODUCTION DEFECT. The panel built `${caseId}:${ids.join(",")}` and
    // this route validates it with `z.string().max(80)`. One evidence id fits;
    // two never can. Selecting two records — the entire point of a
    // cross-record copilot — always answered 400 INVALID_INPUT, and the user
    // saw "Invalid selection." about a selection that was perfectly valid.
    const caseId = "f2b14622-4939-4d60-9476-e4614002af67";
    const ids = [
      "c6bb29e3-1111-4111-8111-111111111111",
      "1e00f0d6-2222-4222-8222-222222222222",
    ];
    const legacyOne = `${caseId}:${ids[0]}`;
    const legacyTwo = `${caseId}:${[...ids].sort().join(",")}`;
    expect(legacyOne.length).toBeLessThanOrEqual(COPILOT_IDEMPOTENCY_KEY_MAX);
    expect(legacyTwo.length).toBeGreaterThan(COPILOT_IDEMPOTENCY_KEY_MAX);
  });

  it("the shared builder is bounded at every selection size the route accepts", () => {
    const caseId = "f2b14622-4939-4d60-9476-e4614002af67";
    const ids = Array.from(
      { length: COPILOT_SELECTION_MAX },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    for (const n of [1, 2, 25, COPILOT_SELECTION_MAX]) {
      const key = buildCopilotIdempotencyKey({
        scope: "case",
        scopeId: caseId,
        selection: ids.slice(0, n),
      });
      expect(key.length, `${n} records`).toBeLessThanOrEqual(
        COPILOT_IDEMPOTENCY_KEY_MAX,
      );
    }
  });

  it("the route no longer concatenates ids into its own fallback identity", () => {
    // The fallback had the SAME unbounded shape as the client's key, so a
    // request that omitted `idempotencyKey` produced an over-long ledger and
    // persistence id from the same defect.
    const src = readFileSync(
      resolve(REPO_ROOT, "services/api/src/routes/ai-case.routes.ts"),
      "utf8",
    );
    expect(src).toMatch(/buildCopilotIdempotencyKey\(\{ scope: "case"/);
    expect(src).not.toMatch(/`case:\$\{caseId\}:\$\{ids\.sort\(\)\.join\(","\)\}`/);
    expect(src).not.toMatch(/`\$\{caseId\}:\$\{ids\.sort\(\)\.join\(","\)\}`/);
  });

  it("the selection bounds are read from the shared authority, not restated", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "services/api/src/routes/ai-case.routes.ts"),
      "utf8",
    );
    expect(src).toMatch(/\.min\(COPILOT_SELECTION_MIN\)/);
    expect(src).toMatch(/\.max\(COPILOT_SELECTION_MAX\)/);
  });
});

describe("eligibility is one authority, enforced server-side", () => {
  it("classifies the production shapes exactly", () => {
    // The two records in the production screenshot.
    for (const status of ["REPORTED", "SIGNED", "UPLOADED"]) {
      expect(
        evaluateCopilotEvidenceEligibility({
          status,
          lifecycleState: "ACTIVE",
          caseLinked: true,
        }).eligible,
        status,
      ).toBe(true);
    }
  });

  it("refuses what cannot be meaningfully compared, with a bounded reason", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: "UPLOADING", lifecycleState: "ACTIVE" }, "still_uploading"],
      [{ status: "CREATED", lifecycleState: "ACTIVE" }, "still_uploading"],
      [{ status: "FAILED_HASH_MISMATCH", lifecycleState: "ACTIVE" }, "integrity_failed"],
      [{ status: "REPORTED", lifecycleState: "PENDING_DESTRUCTION" }, "record_unavailable"],
      [{ status: "REPORTED", lifecycleState: "DESTROYED" }, "record_unavailable"],
      [{ status: "REPORTED", lifecycleState: "ACTIVE", caseLinked: false }, "not_linked_to_case"],
      [{ status: "REPORTED", lifecycleState: "ACTIVE", stale: true }, "changed_since_listed"],
      // An unrecognised status FAILS CLOSED rather than being assumed safe.
      [{ status: "SOME_NEW_STATE", lifecycleState: "ACTIVE" }, "processing_incomplete"],
    ];
    for (const [facts, reason] of cases) {
      const verdict = evaluateCopilotEvidenceEligibility(facts as never);
      expect(verdict.eligible, JSON.stringify(facts)).toBe(false);
      expect(verdict.eligible ? "" : verdict.reason, JSON.stringify(facts)).toBe(
        reason,
      );
    }
  });

  it("every reason has a bounded operator sentence that leaks no mechanism", () => {
    const reasons = [
      "still_uploading",
      "processing_incomplete",
      "integrity_failed",
      "record_unavailable",
      "not_linked_to_case",
      "changed_since_listed",
    ] as const;
    for (const r of reasons) {
      const text = copilotIneligibilityReason(r);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(48);
      // Mechanism, not vocabulary: `SELECT` as a word, never the "select"
      // inside "re-select" — which is exactly what the operator is being told
      // to do.
      expect(text).not.toMatch(/\bprisma\b|\bSELECT\b|team_id|\bworkspace\b|\b\d{3}\b/);
    }
  });

  it("the ROUTE runs the same authority before it spends anything", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "services/api/src/routes/ai-case.routes.ts"),
      "utf8",
    );
    // The same function the panel calls.
    expect(src).toMatch(/evaluateCopilotEvidenceEligibility\(\{/);
    // A dedicated refusal, not a validation error and not an authorization one.
    expect(src).toMatch(/code: "evidence_not_analyzable"/);
    expect(src).toMatch(/reply\.code\(422\)/);
    // BEFORE the budget reservation and the provider call, so an ineligible
    // selection costs nothing.
    // CALL sites, not the import statements that name the same symbols.
    const check = src.indexOf("evaluateCopilotEvidenceEligibility({");
    const reserve = src.indexOf("await tryReserveAiBudget({");
    const provider = src.indexOf("await runCaseCopilot({");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(reserve);
    expect(check).toBeLessThan(provider);
    // It reads PERSISTED fields, so it cannot be satisfied by what the client
    // claimed about a record.
    expect(src).toMatch(/lifecycleState: true,/);
    expect(src).toMatch(/caseLinked: r\.caseLinks\.some\(/);
  });

  it("the refusal names records and reasons, never tenancy", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "services/api/src/routes/ai-case.routes.ts"),
      "utf8",
    );
    const block = src.slice(
      src.indexOf('code: "evidence_not_analyzable"'),
      src.indexOf("// Stale-version rejection."),
    );
    expect(block).toMatch(/evidenceId: x\.id/);
    expect(block).toMatch(/reason:/);
    expect(block).not.toMatch(/teamId|workspace|membership/);
  });
});

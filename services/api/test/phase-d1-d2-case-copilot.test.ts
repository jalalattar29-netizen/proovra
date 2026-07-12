/**
 * Phase D1 (Case Copilot) + D2 (selected-evidence) — behavioral orchestration.
 * Wires C3 context + C4 citations + C5 schema + A5 claims + workspace policy.
 */
import { describe, expect, it } from "vitest";

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

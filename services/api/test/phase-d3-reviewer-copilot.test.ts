/**
 * Phase D3/D4/D6 — Reviewer Copilot orchestrator (behavioral).
 */
import { describe, expect, it } from "vitest";

import { runReviewerCopilot } from "../src/services/ai/reviewer-copilot.service.js";
import type { ReviewerContext, EvidenceContext } from "../src/services/ai/ai-context-resolver.service.js";
import type { AiPolicyDecision } from "../src/services/ai/workspace-ai-policy.service.js";
import type { CitationResolver } from "../src/services/ai/ai-citation.service.js";

const rc: ReviewerContext = {
  route: "/review/r-1", routeClass: "REVIEWER", role: "OWNER", workspaceId: "ws-1",
  workspacePolicyVersion: 1, enabledCapabilities: ["REVIEWER_COPILOT"], objectType: "REVIEW_WORKFLOW",
  objectId: "r-1", objectVersion: null, allowedActions: [], dataMode: "METADATA_ONLY", fields: { status: "IN_REVIEW" },
};
const ev: EvidenceContext = { ...rc, routeClass: "EVIDENCE", objectType: "EVIDENCE_RECORD", objectId: "ev-1", objectVersion: 3, fields: { title: "Photo", status: "SIGNED" } };
const ALLOW: AiPolicyDecision = { allowed: true, decision: "ALLOWED", reason: "", policyVersion: 1 };
const DENY: AiPolicyDecision = { allowed: false, decision: "FEATURE_DISABLED", reason: "", policyVersion: 1 };
const resolver: CitationResolver = async (_t, id) => id === "ev-1" ? { workspaceId: "ws-1", currentVersion: 3, deleted: false, authorized: true } : null;
const boundary = "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.";
const valid = {
  reviewBrief: "One signed record; a location note is missing.", criteriaObservations: [], missingContext: ["location note"],
  custodyObservations: [], verificationSignalObservations: [], unresolvedQuestions: [], conflictingMetadata: [],
  suggestedChecklist: [], escalationPreparation: [],
  citations: [{ type: "EVIDENCE_RECORD", objectId: "ev-1", displayLabel: "Photo", route: "/evidence/ev-1", objectVersion: 3 }],
  advisoryBoundary: boundary,
};

describe("D3 — reviewer copilot orchestration", () => {
  it("no selection → no_selection", async () => {
    const r = await runReviewerCopilot({ teamId: "ws-1", reviewerContext: rc, selectedEvidence: [], selectionRevisions: {}, criteriaVersion: "v1", policyDecision: ALLOW, provider: async () => valid, resolveCitation: resolver });
    expect(r.status).toBe("no_selection");
  });
  it("policy-denied → no provider call", async () => {
    let called = false;
    const r = await runReviewerCopilot({ teamId: "ws-1", reviewerContext: rc, selectedEvidence: [ev], selectionRevisions: {}, criteriaVersion: "v1", policyDecision: DENY, provider: async () => { called = true; return valid; }, resolveCitation: resolver });
    expect(r.status).toBe("policy_denied"); expect(called).toBe(false);
  });
  it("prohibited claim → blocked; no final-decision field", async () => {
    const r = await runReviewerCopilot({ teamId: "ws-1", reviewerContext: rc, selectedEvidence: [ev], selectionRevisions: {}, criteriaVersion: "v1", policyDecision: ALLOW, provider: async () => ({ ...valid, reviewBrief: "The claimant is liable and this is authentic." }), resolveCitation: resolver });
    expect(r.status).toBe("blocked_prohibited_claim");
    expect(JSON.stringify(r.data)).not.toMatch(/finalReviewerDecision|finalDecision/);
  });
  it("valid → ok, invalid citation dropped, criteriaVersion tracked", async () => {
    const r = await runReviewerCopilot({ teamId: "ws-1", reviewerContext: rc, selectedEvidence: [ev], selectionRevisions: {}, criteriaVersion: "v2", policyDecision: ALLOW,
      provider: async () => ({ ...valid, citations: [...valid.citations, { ...valid.citations[0], objectId: "invented", route: "/evidence/invented" }] }), resolveCitation: resolver });
    expect(r.status).toBe("ok");
    expect(r.droppedCitations).toBe(1);
    expect(r.versionMeta.criteriaVersion).toBe("v2");
  });
});

/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G4A-PLAN-AI (unit).
 *
 * The pure halves of the group: the plan catalog's per-capability AI
 * eligibility, the capture fallback's status (B6-F-21) and the legal-gate
 * exemption of one's own batch cancel (B6-F-50). The live behaviour is in
 * free-audit-g4a-plan-ai.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { planIncludesAiCapability, ALL_AI_CAPABILITIES } from "@proovra/shared-billing";

import { AiCaptureService } from "../src/services/ai/ai-capture.service.js";
import { legalAcceptanceRequiredFor } from "../src/middleware/legal-acceptance-gate.js";

describe("free-audit 0ea0 — API-G4A-PLAN-AI (unit)", () => {
  it("B6-F-22 — FREE and PAYG carry the AI trial capabilities only; PRO and above every capability", () => {
    for (const plan of ["FREE", "PAYG"] as const) {
      expect(planIncludesAiCapability(plan, "SUPPORT_CHAT")).toBe(true);
      expect(planIncludesAiCapability(plan, "CAPTURE_ASSISTANCE")).toBe(true);
      expect(planIncludesAiCapability(plan, "EVIDENCE_CATEGORIZATION")).toBe(true);
      for (const paid of ["SEMANTIC_SEARCH", "CONTENT_INTELLIGENCE", "REVIEWER_COPILOT", "CASE_COPILOT"] as const) {
        expect(planIncludesAiCapability(plan, paid), `${plan} ${paid}`).toBe(false);
      }
    }
    for (const plan of ["PRO", "TEAM", "ENTERPRISE"] as const) {
      for (const cap of ALL_AI_CAPABILITIES) expect(planIncludesAiCapability(plan, cap), `${plan} ${cap}`).toBe(true);
    }
  });

  it("B6-F-21 — a provider failure is reported under the provider's status, with the deterministic review kept", async () => {
    const provider = {
      run: async () => ({
        status: "error" as const,
        summary: "Provider unavailable.",
        warnings: [],
        suggestions: [],
        flags: [],
        legalDisclaimer: "advisory",
      }),
    };
    const guard = { canAnalyzeCapture: () => ({ allowed: true }), recordCaptureAnalysis: () => undefined };
    const svc = new AiCaptureService(provider as never, guard as never);
    const result = await svc.analyzeSession("user-1", {
      collectionPlan: { id: "p1", name: "Plan", description: "d", locationRequirement: "optional", steps: [] },
      planMode: "FLEXIBLE",
      useLocation: false,
      items: [{ id: "i1", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 }],
    });
    expect(result.status).toBe("error");
    expect(result.suggestions.join(" ")).toContain("Finish & Sign");
  });

  it("B6-F-50 — cancelling one's own batch is legal-gate exempt; creating one is not", () => {
    expect(legalAcceptanceRequiredFor("POST", "/v1/batch-analysis/:id/cancel", {})).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", "/v1/batch-analysis", {})).toBe(true);
  });
});

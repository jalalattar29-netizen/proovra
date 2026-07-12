/**
 * Phase P3 — every Settings AI toggle has a real backend/worker consumer.
 * Anti-regression: a toggle with no consumer is a defect.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const MEDIA = src("../../../services/api/src/services/intelligence/media-intelligence.service.ts");
const WORKER = src("../../../services/worker/src/mi-embed.processor.ts");
const EVALUATOR = src("../../../services/api/src/services/ai/workspace-ai-policy.service.ts");
const AI_ROUTES = src("../../../services/api/src/routes/ai.routes.ts");
const EV_ROUTES = src("../../../services/api/src/routes/evidence.routes.ts");
const CASE_ROUTES = src("../../../services/api/src/routes/ai-case.routes.ts");
const REV_ROUTES = src("../../../services/api/src/routes/ai-reviewer.routes.ts");
const SEM = src("../../../services/api/src/services/intelligence/semantic.service.ts");

describe("P3 — toggle → consumer matrix", () => {
  const MATRIX: Array<{ toggle: string; consumers: Array<[string, string]> }> = [
    { toggle: "aiEnabled", consumers: [["evaluator", EVALUATOR], ["media", MEDIA], ["worker", WORKER]] },
    { toggle: "supportChatEnabled", consumers: [["evaluator", EVALUATOR]] },
    { toggle: "captureAssistanceEnabled", consumers: [["evaluator", EVALUATOR]] },
    { toggle: "evidenceCategorizationEnabled", consumers: [["evaluator", EVALUATOR]] },
    { toggle: "semanticSearchEnabled", consumers: [["evaluator", EVALUATOR], ["worker", WORKER]] },
    { toggle: "contentIntelligenceEnabled", consumers: [["media", MEDIA]] },
    { toggle: "reviewerCopilotEnabled", consumers: [["evaluator", EVALUATOR]] },
    { toggle: "caseCopilotEnabled", consumers: [["evaluator", EVALUATOR]] },
    { toggle: "rawContentProcessingAllowed", consumers: [["media", MEDIA]] },
    { toggle: "ocrAllowed", consumers: [["media", MEDIA]] },
    { toggle: "transcriptionAllowed", consumers: [["media", MEDIA]] },
    { toggle: "embeddingsAllowed", consumers: [["worker", WORKER]] },
  ];
  for (const { toggle, consumers } of MATRIX) {
    it(`${toggle} is consumed by ${consumers.map(([n]) => n).join("+")}`, () => {
      for (const [, source] of consumers) {
        expect(source).toContain(toggle);
      }
    });
  }
  it("route features call the canonical evaluator", () => {
    for (const [name, source] of [["ai", AI_ROUTES], ["evidence", EV_ROUTES], ["case", CASE_ROUTES], ["reviewer", REV_ROUTES], ["semantic", SEM]] as const) {
      expect(source, name).toContain("evaluateWorkspaceAiPolicy");
    }
  });
  it("media path denies OCR/transcription/raw-content via bounded codes", () => {
    for (const code of ["CONTENT_INTELLIGENCE_DISABLED", "RAW_CONTENT_NOT_ALLOWED", "OCR_NOT_ALLOWED", "TRANSCRIPTION_NOT_ALLOWED", "WORKSPACE_DISABLED"]) {
      expect(MEDIA).toContain(code);
    }
  });
});

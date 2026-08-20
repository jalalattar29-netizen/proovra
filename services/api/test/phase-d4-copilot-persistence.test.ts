/**
 * Phase D4 — Copilot run persistence (behavioral without live DB).
 * Proves: persistence failure never blocks the advisory response, version
 * constants are pinned, and no raw-prompt field exists on the model.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COPILOT_PROMPT_VERSION,
  SYSTEM_POLICY_VERSION,
  CONTEXT_SCHEMA_VERSION,
  persistCopilotRun,
} from "../src/services/ai/ai-copilot-run-store.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");

describe("D4 — versions pinned", () => {
  it("prompt/system/context versions are semver", () => {
    for (const v of [COPILOT_PROMPT_VERSION, SYSTEM_POLICY_VERSION, CONTEXT_SCHEMA_VERSION]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("D4 — persistence never blocks the response", () => {
  it("returns null instead of throwing when the DB is unavailable", async () => {
    const r = await persistCopilotRun({
      workspaceId: "00000000-0000-0000-0000-000000000000",
      userId: "00000000-0000-0000-0000-000000000000",
      feature: "CASE_COPILOT",
      requestId: `t-${Math.floor(performance.now())}`,
      model: "gpt-4.1-mini",
      workspacePolicyVersion: 1,
      processingMode: "METADATA_ONLY",
      selectedObjectRevisions: [],
      status: "ok",
    });
    expect(r).toBeNull(); // no DB in test env → graceful null, no throw
  });
});

describe("D4 — model stores bounded advisory data only", () => {
  it("AiCopilotRun has no raw-prompt / evidence-bytes / secret columns", () => {
    const model = SCHEMA.slice(SCHEMA.indexOf("model AiCopilotRun"), SCHEMA.indexOf("model AiCopilotObservationReview"));
    expect(model).not.toMatch(/rawPrompt|promptText|evidenceBytes|fileBytes|secret|apiKey/i);
    expect(model).toMatch(/boundedResultJson/);
    expect(model).toMatch(/validatedCitationsJson/);
    expect(model).toMatch(/request_id/);
  });
  it("observation review preserves original text as HASH, bounded edit", () => {
    const model = SCHEMA.slice(SCHEMA.indexOf("model AiCopilotObservationReview"));
    expect(model).toMatch(/originalTextHash/);
    expect(model).toMatch(/@db\.VarChar\(600\)/);
    expect(model).not.toMatch(/originalText\s+String\s+@map/);
  });
});

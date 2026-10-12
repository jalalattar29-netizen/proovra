/**
 * MEDIA INTELLIGENCE REFUSES WHEN ITS POLICIES CANNOT BE READ.
 *
 * `runProviderOperation` asks two policy questions before any provider call:
 *   1. the workspace AI policy (`resolveWorkspaceAiPolicy`) — the customer's
 *      own AI / OCR / transcription / raw-content opt-outs;
 *   2. the governance INTELLIGENCE policy (`evaluateIntelligencePolicy`) —
 *      disallowedProviders / disallowedOperations / minConfidenceBand.
 *
 * Both used to `.catch(() => null)` and carry on, so a read failure skipped
 * every deny and the provider was called. A read failure is now a refusal
 * (decision BLOCK) and the provider is never dispatched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  wsPolicyFails: false,
  usage: [] as Array<{ decision: string; failureReason: string | null }>,
  allowanceCalls: 0,
}));

const OPEN_POLICY = {
  aiEnabled: true,
  supportChatEnabled: true,
  captureAssistanceEnabled: true,
  evidenceCategorizationEnabled: true,
  semanticSearchEnabled: true,
  contentIntelligenceEnabled: true,
  reviewerCopilotEnabled: true,
  caseCopilotEnabled: true,
  rawContentProcessingAllowed: true,
  ocrAllowed: true,
  transcriptionAllowed: true,
  embeddingsAllowed: true,
  allowedRoles: [],
  policyVersion: 1,
  fromRow: true,
};

vi.mock("../src/services/ai/workspace-ai-policy.service.js", () => ({
  resolveWorkspaceAiPolicy: async () => {
    if (H.wsPolicyFails) throw new Error("INFRA_FAILURE:workspaceAiPolicy.findUnique");
    return OPEN_POLICY;
  },
}));
vi.mock("../src/services/intelligence/provider-usage.service.js", () => ({
  recordProviderUsage: async (u: { decision: string; failureReason?: string | null }) => {
    H.usage.push({ decision: u.decision, failureReason: u.failureReason ?? null });
  },
}));
vi.mock("../src/services/intelligence/intelligence-activity.service.js", () => ({
  emitLifecycleEvent: async () => undefined,
}));
vi.mock("../src/services/billing-enforcement.service.js", () => ({
  evaluateWorkspaceAiOperation: async () => {
    H.allowanceCalls += 1;
    return { allowed: false, denial: "AI_NOT_INCLUDED" };
  },
  recordWorkspaceAiOperation: async () => undefined,
}));

const { runProviderOperation } = await import(
  "../src/services/intelligence/media-intelligence.service.js"
);
const { registerAdapter, __clearAdapterRegistryForTests } = await import(
  "../src/services/intelligence/providers/provider-adapter.js"
);

const extractEntities = vi.fn(async () => ({ ok: true, records: [], entities: [] }));

function prismaStub(policyReadFails: boolean) {
  return {
    governancePolicyAssignment: {
      findMany: async () => {
        if (policyReadFails) throw new Error("INFRA_FAILURE:governancePolicyAssignment.findMany");
        return [];
      },
    },
    governancePolicyAudit: { create: async () => ({ id: "audit-1" }) },
    mediaIntelligenceRecord: { findFirst: async () => null },
  } as never;
}

const run = (policyReadFails: boolean) =>
  runProviderOperation({
    prisma: prismaStub(policyReadFails),
    teamId: "team-1",
    evidenceId: "ev-1",
    provider: "OPENAI_ENTITY_EXTRACTION",
    operation: "EXTRACT_ENTITIES",
    text: "hello",
  } as never);

beforeEach(() => {
  H.wsPolicyFails = false;
  H.usage.length = 0;
  H.allowanceCalls = 0;
  extractEntities.mockClear();
  __clearAdapterRegistryForTests();
  registerAdapter({
    provider: "OPENAI_ENTITY_EXTRACTION",
    supportedOperations: ["EXTRACT_ENTITIES"],
    probe: () => ({ provider: "OPENAI_ENTITY_EXTRACTION", state: "READY" }) as never,
    extractEntities: extractEntities as never,
  } as never);
});

describe("policy read failure → refused, no provider call", () => {
  it("workspace AI policy read fails → BLOCK workspace_ai_policy_unavailable", async () => {
    H.wsPolicyFails = true;
    const res = await run(false);
    expect(res).toEqual({ ok: false, decision: "BLOCK", reason: "workspace_ai_policy_unavailable" });
    expect(extractEntities).not.toHaveBeenCalled();
    expect(H.allowanceCalls).toBe(0);
  });

  it("governance INTELLIGENCE policy read fails → BLOCK intelligence_policy_unavailable, recorded as a refusal", async () => {
    const res = await run(true);
    expect(res).toEqual({ ok: false, decision: "BLOCK", reason: "intelligence_policy_unavailable" });
    expect(extractEntities).not.toHaveBeenCalled();
    expect(H.allowanceCalls).toBe(0);
    expect(H.usage).toEqual([{ decision: "BLOCK", failureReason: "intelligence_policy_unavailable" }]);
  });

  it("both policies readable and empty → proceeds past the policy gates (control)", async () => {
    const res = await run(false);
    // The next gate (commercial allowance, stubbed to deny) is reached.
    expect(H.allowanceCalls).toBe(1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).not.toMatch(/policy_unavailable/);
  });
});

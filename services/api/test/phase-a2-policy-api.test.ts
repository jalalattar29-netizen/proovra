/**
 * Phase A2 (policy API) + A1 remainder (capability disclosure) — behavioral.
 *
 * Covers the pure runtime-status computations and the invariant that a stub is
 * never presented as operational and copilots are PREVIEW/PLANNED, independent
 * of environment configuration.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_AI_POLICY,
  type ResolvedWorkspaceAiPolicy,
} from "../src/services/ai/workspace-ai-policy.service.js";
import {
  computeAdvisoryCapabilityStatus,
  computeEmbeddingsCapabilityStatus,
  computeSubprocessorCapabilityStatus,
  resolveAiCapabilityDisclosure,
} from "../src/services/ai/ai-capability-disclosure.service.js";

function pol(overrides: Partial<ResolvedWorkspaceAiPolicy> = {}): ResolvedWorkspaceAiPolicy {
  return { ...DEFAULT_WORKSPACE_AI_POLICY, ...overrides };
}

describe("A1 remainder — advisory capability status is runtime-derived", () => {
  const base = { globalAiEnabled: true, openaiConfigured: true, policy: pol() };

  it("platform disabled → DISABLED_BY_PLATFORM_CONFIGURATION", () => {
    expect(
      computeAdvisoryCapabilityStatus(true, { ...base, globalAiEnabled: false }),
    ).toBe("DISABLED_BY_PLATFORM_CONFIGURATION");
  });
  it("provider absent → NOT_CONFIGURED", () => {
    expect(
      computeAdvisoryCapabilityStatus(true, { ...base, openaiConfigured: false }),
    ).toBe("NOT_CONFIGURED");
  });
  it("workspace master off → DISABLED_BY_WORKSPACE_POLICY", () => {
    expect(
      computeAdvisoryCapabilityStatus(true, { ...base, policy: pol({ aiEnabled: false }) }),
    ).toBe("DISABLED_BY_WORKSPACE_POLICY");
  });
  it("feature off → DISABLED_BY_WORKSPACE_POLICY", () => {
    expect(computeAdvisoryCapabilityStatus(false, base)).toBe(
      "DISABLED_BY_WORKSPACE_POLICY",
    );
  });
  it("all green → ENABLED_FOR_THIS_WORKSPACE", () => {
    expect(computeAdvisoryCapabilityStatus(true, base)).toBe(
      "ENABLED_FOR_THIS_WORKSPACE",
    );
  });
});

describe("A1 remainder — embeddings + subprocessor status", () => {
  const emb = {
    globalAiEnabled: true,
    openaiConfigured: true,
    semanticGloballyEnabled: true,
    semanticOutboundEnabled: true,
    policy: pol({ semanticSearchEnabled: true }),
  };
  it("embeddings enabled only when all gates + workspace opt-in true", () => {
    expect(computeEmbeddingsCapabilityStatus(emb)).toBe("ENABLED_FOR_THIS_WORKSPACE");
  });
  it("embeddings outbound off → DISABLED_BY_PLATFORM_CONFIGURATION", () => {
    expect(
      computeEmbeddingsCapabilityStatus({ ...emb, semanticOutboundEnabled: false }),
    ).toBe("DISABLED_BY_PLATFORM_CONFIGURATION");
  });
  it("embeddings workspace opt-out → DISABLED_BY_WORKSPACE_POLICY", () => {
    expect(
      computeEmbeddingsCapabilityStatus({ ...emb, policy: pol({ semanticSearchEnabled: false }) }),
    ).toBe("DISABLED_BY_WORKSPACE_POLICY");
  });
  it("subprocessor: key present + content off → CONFIGURED (not falsely enabled)", () => {
    expect(computeSubprocessorCapabilityStatus(true, false)).toBe("CONFIGURED");
  });
  it("subprocessor: key present + content on → ENABLED_FOR_THIS_WORKSPACE", () => {
    expect(computeSubprocessorCapabilityStatus(true, true)).toBe("ENABLED_FOR_THIS_WORKSPACE");
  });
  it("subprocessor: no key → NOT_CONFIGURED", () => {
    expect(computeSubprocessorCapabilityStatus(false, true)).toBe("NOT_CONFIGURED");
  });
});

describe("A1 remainder — disclosure never presents a stub as live", () => {
  it("MI entity/summary = STUB, copilots DERIVED (policy-off default), local = AVAILABLE", async () => {
    // POINT 7 CORRECTIVE PASS — the premise, set HERE.
    //
    // `DISABLED_BY_WORKSPACE_POLICY` is only distinguishable from
    // `DISABLED_BY_PLATFORM_CONFIGURATION` when the PLATFORM is configured, and
    // this suite used to get that from the machine's real `OPENAI_API_KEY`
    // arriving through `dotenv` — a test passing because a production
    // credential happened to be in scope. It cannot come from the global test
    // environment either: OCR and transcript extraction fall back to OpenAI,
    // so a global fake breaks the Point-5 unconfigured-provider suite. A
    // per-suite premise belongs in the suite.
    const previousKey = process.env.OPENAI_API_KEY;
    const previousEnabled = process.env.OPENAI_AI_ENABLED;
    process.env.OPENAI_API_KEY = "sk-point7-suite-local-fake";
    process.env.OPENAI_AI_ENABLED = "true";
    try {
    const caps = await resolveAiCapabilityDisclosure(null);
    const byName = (n: string) => caps.find((c) => c.capability.includes(n));

    expect(byName("entity-extraction")?.operationalStatus).toBe("STUB_NOT_OPERATIONAL");
    // Phase P2 — Reviewer/Case Copilot are LIVE routes; their status is
    // DERIVED from platform config + workspace policy, never hardcoded
    // PREVIEW/PLANNED. With no workspace (null) the fail-closed safe
    // defaults report DISABLED_BY_WORKSPACE_POLICY — honest, not "live".
    expect(byName("Reviewer Copilot")?.operationalStatus).toBe("DISABLED_BY_WORKSPACE_POLICY");
    expect(byName("Case Copilot")?.operationalStatus).toBe("DISABLED_BY_WORKSPACE_POLICY");
    expect(byName("Reviewer Copilot")?.workspacePolicyState).toBe("DISABLED");
    expect(byName("Local EXIF")?.operationalStatus).toBe("AVAILABLE");

    // Every capability resolves to a bounded status.
    const VALID = new Set([
      "AVAILABLE", "CONFIGURED", "ENABLED_FOR_THIS_WORKSPACE",
      "DISABLED_BY_WORKSPACE_POLICY", "DISABLED_BY_PLATFORM_CONFIGURATION",
      "NOT_CONFIGURED", "PREVIEW", "PLANNED", "STUB_NOT_OPERATIONAL", "RETIRED",
    ]);
    for (const c of caps) expect(VALID.has(c.operationalStatus)).toBe(true);
    // No raw-content capability defaults ON.
    for (const c of caps) if (c.rawContent) expect(c.defaultState).toBe("OFF");
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousEnabled === undefined) delete process.env.OPENAI_AI_ENABLED;
      else process.env.OPENAI_AI_ENABLED = previousEnabled;
    }
  });
});

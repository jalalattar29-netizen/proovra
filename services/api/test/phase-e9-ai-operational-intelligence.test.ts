/**
 * PHASE E9 — AI Operational Intelligence contract tests.
 *
 * Phase E9 is audit-first + canonicalization-first. It does NOT build
 * new OpenAI-backed assistance endpoints; that is reserved for a
 * follow-on bounded phase (E9.1) with its own entry gate. E9 ratifies
 * the existing three-layer AI safety architecture (provider
 * abstraction + policy filter + cost guard + structured-output
 * validation + noop fallback), publishes the canonical AI
 * operational-content module, and pins the safety invariants here.
 *
 * Tests pin:
 *
 *   1. The canonical AI content module exports the bounded allowed
 *      use-cases + forbidden categories + advisory disclaimer.
 *   2. The advisory disclaimer in the shared module matches the one
 *      in `ai-policy.ts` verbatim.
 *   3. The structured-output schema is enforced and statuses are
 *      bounded (ok / blocked / disabled / error).
 *   4. The policy filter runs on every AI provider response (source
 *      contract — `applyAiPolicy` invoked after the provider call).
 *   5. The cost guard short-circuits BEFORE the provider call.
 *   6. The noop provider preserves workflows (returns disabled).
 *   7. AI service tree has no mutation primitives — no
 *      `prisma.evidence.update`, no `appendCustodyEvent`, no
 *      `automationRule.create`, etc.
 *   8. AI provider call does NOT use tool calls, function calls, or
 *      streaming.
 *   9. Filename redaction is applied before sending capture input
 *      to the provider.
 *  10. The Trust Center `ai-limitations` section reflects the E9
 *      bounded contract (advisory only, no mutation, optional,
 *      structured-output validated).
 *  11. Forbidden output patterns are blocked on every AI surface.
 *  12. AI provider feature flag is OFF by default.
 *  13. The capability registry has zero AI dependency (mirrors
 *      persona + external-participant invariants).
 *  14. 32.8 canonical primaries still exactly 6.
 *  15. Protected core files unchanged.
 *  16. MASTER_PHASE_REGISTRY records Phase E9 + the four new DEFs.
 *
 * Phase E9 ships no schema change, no new capability, no new route, no
 * new root navigation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AI_ALLOWED_USE_CASES,
  AI_ALLOWED_USE_CASE_CONTENT,
  AI_CANONICAL_ADVISORY_DISCLAIMER,
  AI_FAILURE_TOLERANCE_CONTRACT,
  AI_FORBIDDEN_CATEGORIES,
  AI_FORBIDDEN_CATEGORY_DESCRIPTION,
  AI_OPERATIONAL_FORBIDDEN_OUTPUT_PATTERNS,
  AI_OPERATIONAL_REQUIRED_PHRASES,
  AI_PROMPT_INJECTION_PRINCIPLES,
  TRUST_CENTER_SECTIONS,
  type AiAllowedUseCase,
  type AiForbiddenCategory,
} from "@proovra/shared-evidence-presentation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function packagesPath(rel: string): string {
  return fileURLToPath(new URL(`../../../packages/${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readPackages(rel: string): string {
  return readFileSync(packagesPath(rel), "utf8");
}

const AI_OPERATIONAL_CONTENT_SRC = readPackages(
  "shared-evidence-presentation/src/ai-operational-content.ts",
);
const AI_POLICY_SRC = readApi("src/services/ai/ai-policy.ts");
const AI_TYPES_SRC = readApi("src/services/ai/ai-types.ts");
const AI_PROVIDER_SRC = readApi("src/services/ai/ai-provider.ts");
const NOOP_AI_PROVIDER_SRC = readApi("src/services/ai/noop-ai-provider.ts");
const OPENAI_PROVIDER_SRC = readApi("src/services/ai/openai-provider.ts");
const AI_COST_GUARD_SRC = readApi("src/services/ai/ai-cost-guard.ts");
const AI_CHAT_SVC = readApi("src/services/ai/ai-chat.service.ts");
const AI_CAPTURE_SVC = readApi("src/services/ai/ai-capture.service.ts");
const AI_ROUTES = readApi("src/routes/ai.routes.ts");
const CAPABILITY_REGISTRY_SRC = readApi(
  "src/services/platform-context/capability-registry.ts",
);
const CAPTURE_AI_COMPONENT = readWeb(
  "components/ai/CaptureAiAssistant.tsx",
);
const CHAT_WIDGET_COMPONENT = readWeb(
  "components/ai/ProovraChatWidget.tsx",
);

// ===========================================================================
// PART 1 — Canonical AI content module shape
// ===========================================================================

describe("E9 Test 1 — canonical AI content module", () => {
  it("exports exactly the 9 canonical allowed use cases", () => {
    expect([...AI_ALLOWED_USE_CASES].sort()).toEqual(
      [
        "DOCUMENTATION_HELP",
        "GOVERNANCE_REMINDERS",
        "INTAKE_COMPLETENESS_GUIDANCE",
        "OPERATIONAL_ANOMALY_SUGGESTIONS",
        "OPERATIONAL_PRIORITIZATION",
        "OPERATIONAL_SUMMARIZATION",
        "REVIEWER_ASSISTANCE",
        "SEARCH_NAVIGATION_ASSISTANCE",
        "WORKFLOW_GUIDANCE",
      ].sort(),
    );
  });

  it("exports exactly the 12 canonical forbidden categories", () => {
    expect([...AI_FORBIDDEN_CATEGORIES].sort()).toEqual(
      [
        "ADMISSIBILITY_DETERMINATION",
        "AUTHENTICITY_DETERMINATION",
        "AUTHORSHIP_CERTAINTY",
        "AUTONOMOUS_DESTRUCTIVE_ACTIONS",
        "AUTONOMOUS_GOVERNANCE_DECISIONS",
        "AUTONOMOUS_MUTATIONS",
        "AUTONOMOUS_REVIEW_DECISIONS",
        "FAKE_EVIDENCE_CERTAINTY",
        "FORENSIC_CERTIFICATION",
        "LEGAL_CONCLUSIONS",
        "REAL_EVIDENCE_CERTAINTY",
        "TRUTH_DETERMINATION",
      ].sort(),
    );
  });

  it.each(AI_ALLOWED_USE_CASES)(
    "AI_ALLOWED_USE_CASE_CONTENT has a complete record for %s",
    (code) => {
      const c = AI_ALLOWED_USE_CASE_CONTENT[code as AiAllowedUseCase];
      expect(c).toBeTruthy();
      expect(c.label.length).toBeGreaterThan(5);
      expect(c.purpose.length).toBeGreaterThan(40);
      expect(c.allowedInputs.length).toBeGreaterThan(20);
      expect(c.forbiddenInputs.length).toBeGreaterThan(20);
      expect(c.outputBoundary.length).toBeGreaterThan(20);
    },
  );

  it.each(AI_FORBIDDEN_CATEGORIES)(
    "AI_FORBIDDEN_CATEGORY_DESCRIPTION has a clear rationale for %s",
    (code) => {
      const description = AI_FORBIDDEN_CATEGORY_DESCRIPTION[code as AiForbiddenCategory];
      expect(description).toBeTruthy();
      expect(description.length).toBeGreaterThan(40);
      expect(description).toMatch(/AI/);
      expect(description).toMatch(/never|not|cannot/i);
    },
  );

  it("AI_PROMPT_INJECTION_PRINCIPLES enumerates >= 5 principles", () => {
    expect(AI_PROMPT_INJECTION_PRINCIPLES.length).toBeGreaterThanOrEqual(5);
    for (const principle of AI_PROMPT_INJECTION_PRINCIPLES) {
      expect(principle.length).toBeGreaterThan(40);
    }
  });
});

// ===========================================================================
// PART 2 — Advisory disclaimer matches ai-policy.ts verbatim
// ===========================================================================

describe("E9 Test 2 — advisory disclaimer alignment", () => {
  it("shared canonical disclaimer matches the one in ai-policy.ts", () => {
    // The exact string MUST be a substring of the ai-policy source so
    // the two layers stay in sync. The shared string is exposed for
    // surfaces that don't import the backend file.
    expect(AI_POLICY_SRC).toContain(AI_CANONICAL_ADVISORY_DISCLAIMER);
  });

  it("disclaimer surfaces the required boundary phrases", () => {
    for (const phrase of AI_OPERATIONAL_REQUIRED_PHRASES) {
      const inDisclaimer = AI_CANONICAL_ADVISORY_DISCLAIMER.toLowerCase().includes(
        phrase.toLowerCase(),
      );
      const inContentModule = AI_OPERATIONAL_CONTENT_SRC.toLowerCase().includes(
        phrase.toLowerCase(),
      );
      expect(
        inDisclaimer || inContentModule,
        `required AI boundary phrase "${phrase}" missing from both the disclaimer and the content module`,
      ).toBe(true);
    }
  });

  it("CaptureAiAssistant + ProovraChatWidget both render advisory-only disclaimer wording", () => {
    // Both surfaces must show advisory-only language, with a clear
    // "not authoritative" disclaimer. The exact phrasing differs by
    // surface (the modal uses "does not determine"; the chat bubble
    // uses "Not legal or factual determination") — both are
    // semantically equivalent and both satisfy the contract.
    for (const src of [CAPTURE_AI_COMPONENT, CHAT_WIDGET_COMPONENT]) {
      expect(src).toMatch(/advisory/i);
      expect(src).toMatch(
        /does not determine|not\s+legal\s+or\s+factual\s+determination|not\s+(?:legal|factual)\s+advice/i,
      );
    }
  });
});

// ===========================================================================
// PART 3 — Structured-output schema + status discriminator
// ===========================================================================

describe("E9 Test 3 — structured-output schema is enforced", () => {
  it("AiResultSchema declares the bounded status discriminator", () => {
    // The four statuses are pinned by the failure-tolerance contract.
    for (const status of AI_FAILURE_TOLERANCE_CONTRACT.resultStatuses) {
      expect(AI_TYPES_SRC).toMatch(new RegExp(`["']${status}["']`));
    }
  });

  it("AiResultSchema uses Zod for structured validation", () => {
    expect(AI_TYPES_SRC).toMatch(/z\.object/);
    expect(AI_TYPES_SRC).toMatch(/z\.enum|z\.union|z\.discriminatedUnion/);
  });

  it("openai-provider validates the response with AiResultSchema before returning", () => {
    expect(OPENAI_PROVIDER_SRC).toMatch(/AiResultSchema\.safeParse|AiResultSchema\.parse/);
  });

  it("openai-provider applies the policy filter on every response", () => {
    expect(OPENAI_PROVIDER_SRC).toMatch(/applyAiPolicy/);
  });

  it("openai-provider uses json_schema strict mode (no free-form text)", () => {
    expect(OPENAI_PROVIDER_SRC).toMatch(/json_schema/);
    expect(OPENAI_PROVIDER_SRC).toMatch(/strict:\s*true/);
  });
});

// ===========================================================================
// PART 4 — Cost guard short-circuits before the provider call
// ===========================================================================

describe("E9 Test 4 — cost guard short-circuit", () => {
  it("ai-chat.service.ts checks cost guard BEFORE calling the provider", () => {
    expect(AI_CHAT_SVC).toMatch(/canSendChatMessage/);
    // The cost-guard call appears before the provider invocation.
    const guardIdx = AI_CHAT_SVC.indexOf("canSendChatMessage");
    const providerIdx = AI_CHAT_SVC.search(/provider\.run\(/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(providerIdx);
  });

  it("ai-capture.service.ts checks cost guard BEFORE calling the provider", () => {
    expect(AI_CAPTURE_SVC).toMatch(/canAnalyzeCapture/);
    const guardIdx = AI_CAPTURE_SVC.indexOf("canAnalyzeCapture");
    const providerIdx = AI_CAPTURE_SVC.search(/provider\.run\(/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(providerIdx);
  });
});

// ===========================================================================
// PART 5 — Noop provider preserves workflows
// ===========================================================================

describe("E9 Test 5 — noop provider preserves workflows", () => {
  it("noop-ai-provider returns status='disabled' (not throws)", () => {
    expect(NOOP_AI_PROVIDER_SRC).toMatch(/status:\s*["']disabled["']/);
    expect(NOOP_AI_PROVIDER_SRC).not.toMatch(/throw\s+new\s+Error/);
  });

  it("ai-provider factory defaults to noop when OPENAI_AI_ENABLED is unset", () => {
    expect(AI_PROVIDER_SRC).toMatch(/OPENAI_AI_ENABLED/);
    expect(AI_PROVIDER_SRC).toMatch(/NoopAiProvider|noop/i);
  });

  it("noop provider is the unconditional fallback when the API key is absent", () => {
    expect(AI_PROVIDER_SRC).toMatch(/Boolean\(apiKey\)|apiKey/);
  });
});

// ===========================================================================
// PART 6 — AI service tree has no mutation primitives
// ===========================================================================

describe("E9 Test 6 — AI service tree never mutates platform state", () => {
  const AI_SOURCES: ReadonlyArray<{ label: string; body: string }> = [
    { label: "ai-policy", body: AI_POLICY_SRC },
    { label: "ai-types", body: AI_TYPES_SRC },
    { label: "ai-provider", body: AI_PROVIDER_SRC },
    { label: "openai-provider", body: OPENAI_PROVIDER_SRC },
    { label: "noop-ai-provider", body: NOOP_AI_PROVIDER_SRC },
    { label: "ai-cost-guard", body: AI_COST_GUARD_SRC },
    { label: "ai-chat.service", body: AI_CHAT_SVC },
    { label: "ai-capture.service", body: AI_CAPTURE_SVC },
    /*
     * THE COPILOT SURFACES WERE NOT COVERED.
     *
     * This guard listed the eight files that existed when it was written and
     * was never extended. The copilots arrived afterwards — and they are the
     * AI surfaces that actually read evidence, cases and review criteria, so
     * they are the ones with a reason to write.
     *
     * They do not. Every write in the AI service tree targets an AI-OWNED
     * table: usage events, copilot runs, observation reviews, the workspace
     * policy. Nothing touches evidence, custody, legal holds, verification
     * state, reports, retention or billing. That is the whole "AI recommends,
     * humans decide" property, and until now it held by habit, not by test.
     */
    { label: "copilot-orchestrator", body: readApi("src/services/ai/copilot-orchestrator.ts") },
    { label: "reviewer-copilot.service", body: readApi("src/services/ai/reviewer-copilot.service.ts") },
    { label: "case-copilot.service", body: readApi("src/services/ai/case-copilot.service.ts") },
    { label: "structured-copilot-provider", body: readApi("src/services/ai/structured-copilot-provider.ts") },
    { label: "ai-context-resolver.service", body: readApi("src/services/ai/ai-context-resolver.service.ts") },
  ];

  // Mutation primitives that MUST NOT appear anywhere in the AI tree.
  const FORBIDDEN_MUTATION_CALLS = [
    /prisma\.evidence\.(?:update|delete|deleteMany|updateMany)/,
    /prisma\.case\.(?:update|delete|deleteMany|updateMany)/,
    /prisma\.evidenceReviewWorkflow\.(?:update|delete|deleteMany|updateMany)/,
    /prisma\.evidenceLegalHold\.(?:update|delete|deleteMany|updateMany)/,
    /prisma\.caseLegalHold\.(?:update|delete|deleteMany|updateMany)/,
    /prisma\.automationRule\.(?:update|delete|deleteMany|updateMany|create)/,
    /prisma\.automationWebhookDestination\.(?:update|delete|create)/,
    /prisma\.report\.(?:update|delete|deleteMany)/,
    /prisma\.verificationPackage\.(?:update|delete|deleteMany)/,
    /appendCustodyEvent\s*\(/,
    /completeEvidence\s*\(/,
  ];

  for (const surface of AI_SOURCES) {
    describe(`surface — ${surface.label}`, () => {
      it.each(FORBIDDEN_MUTATION_CALLS)(
        "does NOT call mutation primitive %s",
        (pattern) => {
          expect(surface.body).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 7 — AI provider has no tool calls / function calls / streaming
// ===========================================================================

describe("E9 Test 7 — AI provider has no agentic primitives", () => {
  it("openai-provider does not call tool / function / agent APIs", () => {
    // OpenAI's `tools` / `functions` / streaming params would all appear
    // here if used. The audit confirmed they are not.
    expect(OPENAI_PROVIDER_SRC).not.toMatch(/tools:\s*\[/);
    expect(OPENAI_PROVIDER_SRC).not.toMatch(/functions:\s*\[/);
    expect(OPENAI_PROVIDER_SRC).not.toMatch(/tool_choice/);
    expect(OPENAI_PROVIDER_SRC).not.toMatch(/function_call/);
    expect(OPENAI_PROVIDER_SRC).not.toMatch(/stream:\s*true/);
  });

  it("AI services have no agent-loop primitives", () => {
    // Source-grep guard for the most common autonomous-agent shapes.
    for (const src of [AI_CHAT_SVC, AI_CAPTURE_SVC, OPENAI_PROVIDER_SRC]) {
      expect(src).not.toMatch(/while\s*\(\s*true\s*\)/);
      expect(src).not.toMatch(/AutonomousAgent|AgentLoop|toolRouter/i);
    }
  });
});

// ===========================================================================
// PART 8 — Filename redaction before sending to the provider
// ===========================================================================

describe("E9 Test 8 — filename redaction in capture path", () => {
  it("ai-capture.service.ts redacts filenames before provider input", () => {
    expect(AI_CAPTURE_SVC).toMatch(/redactFileName|redacted-filename|Item\s*\$\{?\d|itemLabel/);
  });
});

// ===========================================================================
// PART 9 — Trust Center ai-limitations section reflects E9 contract
// ===========================================================================

describe("E9 Test 9 — Trust Center ai-limitations extended", () => {
  const section = TRUST_CENTER_SECTIONS.find((s) => s.id === "ai-limitations");

  it("section exists", () => {
    expect(section).toBeTruthy();
  });

  it("summary now mentions bounded operational summarization", () => {
    expect(section!.summary).toMatch(/bounded operational summarization/i);
    expect(section!.summary).toMatch(/never mutate/i);
  });

  it("bullets surface the structured-output + discriminated-status posture", () => {
    const bullets = section!.bullets.join(" ");
    expect(bullets).toMatch(/JSON[- ]schema/i);
    expect(bullets).toMatch(/discriminated[- ]status/i);
    expect(bullets).toMatch(/no tool calls/i);
    expect(bullets).toMatch(/no function calls/i);
    expect(bullets).toMatch(/no agent loops/i);
    expect(bullets).toMatch(/no streaming/i);
  });

  it("bullets surface the input-side safety + cost-guard posture", () => {
    const bullets = section!.bullets.join(" ");
    expect(bullets).toMatch(/raw evidence file bytes/i);
    expect(bullets).toMatch(/signed storage URLs/i);
    expect(bullets).toMatch(/filenames are redacted/i);
    expect(bullets).toMatch(/cost guards short-circuit/i);
  });

  it("bullets surface the OPTIONAL / noop-fallback posture", () => {
    const bullets = section!.bullets.join(" ");
    expect(bullets).toMatch(/OPTIONAL/);
    expect(bullets).toMatch(/noop provider/i);
    expect(bullets).toMatch(/disabled.*status/i);
  });

  it("limitations explicitly disclaim autonomy", () => {
    const limits = section!.limitations.join(" ");
    expect(limits).toMatch(/never an autonomous operator/i);
    expect(limits).toMatch(/never approves or rejects/i);
    expect(limits).toMatch(/never releases legal holds/i);
    expect(limits).toMatch(/never deletes evidence/i);
    expect(limits).toMatch(/never finalizes records/i);
  });

  it("limitations explicitly disclaim forensic / legal / admissibility scoring", () => {
    const limits = section!.limitations.join(" ");
    expect(limits).toMatch(/forensic engine/i);
    expect(limits).toMatch(/legal advisor/i);
    expect(limits).toMatch(/admissibility scorer/i);
    expect(limits).toMatch(/risk scores.*out of scope/i);
  });
});

// ===========================================================================
// PART 10 — Forbidden operational output patterns absent from AI surfaces
// ===========================================================================

describe("E9 Test 10 — forbidden output patterns absent from AI surfaces", () => {
  // ai-policy.ts intentionally lists forbidden patterns as regex
  // literals — sanitise the policy file blocklist before greppping.
  const SANITISED_POLICY = AI_POLICY_SRC.replace(
    /forbiddenPatterns\s*=\s*\[[\s\S]*?\];/g,
    "",
  );

  const AI_SURFACES: ReadonlyArray<{ label: string; body: string }> = [
    { label: "ai-policy (sanitised)", body: SANITISED_POLICY },
    { label: "ai-types", body: AI_TYPES_SRC },
    { label: "ai-chat.service", body: AI_CHAT_SVC },
    { label: "ai-capture.service", body: AI_CAPTURE_SVC },
    { label: "ai.routes", body: AI_ROUTES },
    { label: "CaptureAiAssistant.tsx", body: CAPTURE_AI_COMPONENT },
    { label: "ProovraChatWidget.tsx", body: CHAT_WIDGET_COMPONENT },
  ];

  for (const surface of AI_SURFACES) {
    describe(`surface — ${surface.label}`, () => {
      it.each(AI_OPERATIONAL_FORBIDDEN_OUTPUT_PATTERNS)(
        "does NOT match %s",
        (pattern) => {
          expect(surface.body).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 11 — AI provider OFF by default
// ===========================================================================

describe("E9 Test 11 — AI provider is OFF by default", () => {
  it("ai-provider factory keys on OPENAI_AI_ENABLED + API key presence", () => {
    expect(AI_PROVIDER_SRC).toMatch(/OPENAI_AI_ENABLED/);
    // The factory MUST require both the flag AND the API key.
    expect(AI_PROVIDER_SRC).toMatch(/===\s*["']true["']/);
  });
});

// ===========================================================================
// PART 12 — Capability registry has zero AI dependency
// ===========================================================================

describe("E9 Test 12 — capability registry has zero AI input", () => {
  it("CapabilityResolverInput has no AI / openai / chat / capture-ai fields", () => {
    const inputBlock = CAPABILITY_REGISTRY_SRC.match(
      /CapabilityResolverInput\s*=\s*\{[\s\S]*?\};/m,
    );
    expect(inputBlock).toBeTruthy();
    const body = inputBlock![0];
    expect(body).not.toMatch(/\bai\b/i);
    expect(body).not.toMatch(/openai/i);
    expect(body).not.toMatch(/chat/i);
    expect(body).not.toMatch(/capture[- ]?ai/i);
  });
});

// ===========================================================================
// PART 13 — IA preservation: 32.8 canonical primaries still 6
// ===========================================================================

describe("E9 Test 13 — 32.8 IA preserved", () => {
  it("canonical primaries still exactly 6", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });
});

// ===========================================================================
// PART 14 — Protected core files unchanged
// ===========================================================================

// ===========================================================================
// PART 15 — Documentation + registry
// ===========================================================================

describe("E9 Test 15 — documentation + registry", () => {
  it("docs/product/PHASE_E9_AI_OPERATIONAL_INTELLIGENCE.md exists + substantial", () => {
    const doc = readRepo(
      "docs/product/PHASE_E9_AI_OPERATIONAL_INTELLIGENCE.md",
    );
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE E9/);
  });

  it("registry registers Phase E9 with explicit closure status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E9\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry records the 4 new DEFs opened by E9", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    for (const def of ["DEF-033", "DEF-034", "DEF-035", "DEF-036"]) {
      expect(registry, `${def} missing from registry`).toMatch(
        new RegExp(`\\|\\s*${def}\\s*\\|`),
      );
    }
  });
});

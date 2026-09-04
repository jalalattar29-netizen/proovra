/**
 * FINAL ENTERPRISE HARDENING SPRINT (F-1 … F-8) — behavioral + contract proofs.
 *
 * F-1  Chat / Capture / Categorization go through the CANONICAL durable
 *      ledger (tryReserveAiBudget → provider → reconcile / release); the
 *      legacy AiCostGuard remains ONLY as a documented burst heuristic.
 * F-2  Operations Intelligence uses the same ledger.
 * F-3  Suggested-action registry contains ONLY actions with a real executor
 *      or navigation target; the removed package actions are rejected.
 * F-6  German ASCII transliterations (ae/oe/ue/ss) classify identically to
 *      their umlaut forms — default-deny intact, zero false allow.
 * F-8  The local-fallback adapters emit honest LOCAL_* provider labels and
 *      the value-rename migration is prepared (guarded, idempotent SQL).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

import { classifyChatScope } from "../src/services/ai/chat-scope-classifier.service.js";
import {
  SUGGESTABLE_ACTIONS,
  buildSuggestedAction,
  ForbiddenAiActionError,
} from "../src/services/ai/ai-suggested-action.service.js";
import { AiChatService } from "../src/services/ai/ai-chat.service.js";
import { AiCostGuard } from "../src/services/ai/ai-cost-guard.js";
import type { AiProvider } from "../src/services/ai/ai-provider.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
}

// ===========================================================================
// F-6 — German transliteration hardening.
// ===========================================================================
describe("F-6 — German ASCII transliterations classify like umlaut forms", () => {
  const CASES: Array<[string, boolean, string?]> = [
    // [input, expectRefuse, expectedScope?]
    ["Ist dieses Dokument gefälscht?", true, "PROHIBITED_AUTHENTICITY_REQUEST"],
    ["Ist dieses Dokument gefaelscht?", true, "PROHIBITED_AUTHENTICITY_REQUEST"],
    ["ist das glaubwürdig", true, "PROHIBITED_FRAUD_LIABILITY_INTENT_REQUEST"],
    ["ist das glaubwuerdig", true, "PROHIBITED_FRAUD_LIABILITY_INTENT_REQUEST"],
    ["zulässig vor gericht?", true, "PROHIBITED_TRUTH_REQUEST"],
    ["zulaessig vor gericht?", true, "PROHIBITED_TRUTH_REQUEST"],
    // Transliterated ALLOW intent still allows (prüfung → pruefung).
    ["zeige mir die pruefung der beweise", false, "REVIEW_OPERATIONS"],
    ["zeige mir die prüfung der beweise", false, "REVIEW_OPERATIONS"],
    // Default-deny floor unchanged: off-domain transliterated German refuses.
    ["schreib mir eine geschichte ueber den urlaub", true],
  ];
  for (const [input, expectRefuse, expectedScope] of CASES) {
    it(`"${input}" → refuse=${expectRefuse}${expectedScope ? ` (${expectedScope})` : ""}`, () => {
      const r = classifyChatScope(input);
      expect(r.refuse).toBe(expectRefuse);
      if (expectedScope) expect(r.scope).toBe(expectedScope);
    });
  }

  it("transliterated German still gets the LOCALIZED German refusal", () => {
    const r = classifyChatScope("Ist dieses Dokument gefaelscht?");
    expect(r.language).toBe("de");
    expect(r.refusalMessage ?? "").toContain("PROOVRA");
  });
});

// ===========================================================================
// F-1 — chat preflight: deterministic short-circuits never need the ledger.
// ===========================================================================
describe("F-1 — AiChatService.preflight owns every pre-provider short-circuit", () => {
  const provider: AiProvider = {
    run: vi.fn(async () => {
      throw new Error("provider must not be called in preflight tests");
    }),
  } as unknown as AiProvider;
  const svc = new AiChatService(provider, new AiCostGuard());
  const payload = (text: string) => ({
    messages: [{ role: "user" as const, content: text }],
    pageContext: { title: "Evidence", path: "/evidence/x" },
  });

  it("off-domain question → deterministic refusal, provider untouched", () => {
    const pre = svc.preflight("u1", payload("write me a business plan") as never);
    expect(pre).not.toBeNull();
    expect(pre?.status).toBe("ok");
    expect(pre?.summary ?? "").toMatch(/PROOVRA/);
    expect((provider.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  /*
   * "How does the chain of custody work?" used to return null here, sending it
   * down the provider path. It is now answered from the grounded product
   * bundle, which is the intended behaviour — the answer is a fixed property of
   * the product and needs no model.
   *
   * The contract this test guards is that preflight returns null for anything
   * it cannot answer itself, so the route reserves budget before a real
   * provider call. Both halves are asserted.
   */
  it("in-domain question the bundle cannot answer → null (provider path; route reserves budget FIRST)", () => {
    const pre = svc.preflight("u1", payload("Can you summarize my evidence metadata?") as never);
    expect(pre).toBeNull();
  });

  it("in-domain question the bundle CAN answer → answered without the provider", () => {
    const pre = svc.preflight("u1", payload("How does the chain of custody work?") as never);
    expect(pre).not.toBeNull();
    expect(pre!.status).toBe("ok");
  });

  it("analyzeChat still delegates through preflight (no duplicated logic)", async () => {
    const result = await svc.analyzeChat("u1", payload("what is the weather today") as never);
    expect(result.summary).toMatch(/PROOVRA/);
    expect((provider.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// F-1 / F-2 — ledger wiring source contracts (route-level).
// ===========================================================================
describe("F-1/F-2 — every provider-calling AI route reserves on the durable ledger", () => {
  const CONTRACTS: Array<{ file: string; feature: string }> = [
    { file: "../src/routes/ai.routes.ts", feature: "SUPPORT_CHAT" },
    { file: "../src/routes/ai.routes.ts", feature: "CAPTURE_ASSISTANCE" },
    { file: "../src/routes/evidence.routes.ts", feature: "EVIDENCE_CATEGORIZATION" },
    // OPERATIONS_INTELLIGENCE was the sixth. Its route file was DELETED by the
    // Operations redesign, so there is no longer a provider-calling route to
    // hold to the ledger contract. OPERATIONS REDESIGN (2026-08-23) — the six-button Operations Intelligence panel was the ONLY consumer of POST /v1/ai/operations/summary. Every button ran the same deterministic workspace snapshot through a language model and returned a paraphrase of counts already rendered on the page, spending an AI operation per press, with no validated citations and no action the operator could take from the answer.
    { file: "../src/routes/ai-evidence.routes.ts", feature: "EVIDENCE_COPILOT" },
    { file: "../src/routes/ai-case.routes.ts", feature: "CASE_COPILOT" },
    { file: "../src/routes/ai-reviewer.routes.ts", feature: "REVIEWER_COPILOT" },
  ];
  for (const { file, feature } of CONTRACTS) {
    it(`${feature} route calls tryReserveAiBudget + reconcile/release`, () => {
      const src = readSource(file);
      expect(src).toContain("tryReserveAiBudget");
      /*
       * The label may be a literal OR a named constant.
       *
       * The evidence copilot now reserves with `feature:
       * EVIDENCE_COPILOT_OPERATION`, because that route is the one place in the
       * product where the operation label and the governing policy switch
       * differ — it records EVIDENCE_COPILOT and is gated by
       * EVIDENCE_CATEGORIZATION. Deriving both from one constant is what stops
       * the gate and the ledger naming different things; see
       * `ai-operation-registry.ts`.
       *
       * What this contract is about is that the route reserves durably under
       * its own feature identity, and that identity still has to APPEAR in the
       * file either way — so the check is widened, not weakened.
       * `ai-operation-identity.test.ts` pins the constant's value.
       */
      expect(
        src.includes(`feature: "${feature}"`) ||
          new RegExp(`feature: [A-Z_]*${feature}[A-Z_]*\\b`).test(src),
        `${file} must reserve under ${feature}`,
      ).toBe(true);
      expect(src).toContain("reconcileAiUsage");
      expect(src).toContain("releaseAiReservation");
    });
  }

  it("the demoted AiCostGuard documents its burst-heuristic-only role", () => {
    const src = readSource("../src/services/ai/ai-cost-guard.ts");
    expect(src).toContain("BURST HEURISTIC");
    expect(src).toContain("ai-usage-ledger.service.ts");
  });

  it("no route defines a second budget/reservation implementation (zero duplication)", () => {
    for (const { file } of CONTRACTS) {
      const src = readSource(file);
      // The ONLY reservation entry point is the canonical ledger import.
      expect(src).not.toMatch(/function\s+(tryReserve|reserveAiBudget|reconcileAiUsage)/);
    }
  });
});

// ===========================================================================
// F-3 — action registry contains ONLY real actions.
// ===========================================================================
describe("F-3 — suggested-action registry has no fake/declared-only actions", () => {
  it("registry is exactly the four proven actions", () => {
    expect([...SUGGESTABLE_ACTIONS].sort()).toEqual([
      "GENERATE_REPORT",
      "OPEN_MISSING_METADATA",
      "OPEN_REVIEWER_ASSIGNMENT",
      "RETRY_ELIGIBLE_REPORT",
    ]);
  });

  it("the removed package actions are rejected like any non-allowlisted action", () => {
    const meta = { promptVersion: "1", modelVersion: "m", contextSchemaVersion: "1", outputSchemaVersion: "1" };
    for (const removed of ["GENERATE_VERIFICATION_PACKAGE", "RETRY_ELIGIBLE_PACKAGE"]) {
      expect(() => buildSuggestedAction({
        actionType: removed, displayLabel: "x", reason: "y",
        affectedObject: { type: "EVIDENCE_RECORD", id: "ev-1", version: 1 },
        proposedChange: {}, requiredPermission: "p", citations: [], versionMeta: meta,
      })).toThrow(ForbiddenAiActionError);
    }
  });

  it("OPEN_REVIEWER_ASSIGNMENT is server-derived in the evidence route and rendered in the UI", () => {
    const route = readSource("../src/routes/ai-evidence.routes.ts");
    expect(route).toContain('"OPEN_REVIEWER_ASSIGNMENT"');
    expect(route).toContain("evidenceReviewWorkflow");
    const panel = readSource("../../../apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx");
    expect(panel).toContain("OPEN_REVIEWER_ASSIGNMENT");
  });
});

// ===========================================================================
// F-8 — honest provider labels + prepared value-rename migration.
// ===========================================================================
describe("F-8 — LOCAL_* provider labels + prepared migration", () => {
  it("adapters emit LOCAL_* (never the misleading OPENAI_* labels) going forward", () => {
    const src = readSource("../src/services/intelligence/providers/openai-adapter.ts");
    expect(src).toContain('PROVIDER_ENTITY: MediaIntelligenceProvider = "LOCAL_ENTITY_EXTRACTION"');
    expect(src).toContain('PROVIDER_SUMMARY: MediaIntelligenceProvider = "LOCAL_DOCUMENT_SUMMARY"');
  });

  it("value-rename migration is prepared: guarded, scoped, idempotent, no DDL", () => {
    const sql = readSource("../prisma/migrations/20270915000000_mi_provider_local_value_rename/migration.sql");
    expect(sql).toContain("to_regclass");
    expect(sql).toContain("WHERE provider = 'OPENAI_ENTITY_EXTRACTION'");
    expect(sql).toContain("WHERE provider = 'OPENAI_DOCUMENT_SUMMARY'");
    // Scan executable SQL only (the safety-profile comment names the
    // destructive keywords it forbids).
    const executable = sql.replace(/^\s*--.*$/gm, "");
    expect(executable).not.toMatch(/\b(DROP|TRUNCATE|DELETE|ALTER)\b/i);
    // Every UPDATE is value-scoped — no unscoped UPDATE exists.
    const updates = sql.match(/UPDATE [\s\S]*?;/g) ?? [];
    expect(updates.length).toBe(4);
    for (const u of updates) expect(u).toMatch(/WHERE provider = 'OPENAI_/);
  });

  it("readers stay compatible with legacy rows until the migration executes", () => {
    const svc = readSource("../src/services/intelligence/media-intelligence.service.ts");
    expect(svc).toContain('case "LOCAL_ENTITY_EXTRACTION"');
    expect(svc).toContain('case "OPENAI_ENTITY_EXTRACTION"');
  });
});

/**
 * ONE FEATURE IDENTITY, END TO END.
 *
 * The audit found that `/v1/ai/evidence/:id/copilot` recorded its usage as
 * `EVIDENCE_COPILOT` while its policy gate evaluated `EVIDENCE_CATEGORIZATION`.
 * Read from the usage ledger, the evidence copilot appeared to be governed by a
 * switch that does not exist.
 *
 * It was never a budget bypass — daily and monthly limits are per WORKSPACE
 * (`aiUsageDaily` is keyed `workspaceId_dayUtc`, with no feature dimension), so
 * the label has never taken part in a limit decision. It was an attribution and
 * legibility defect, and these tests pin the fix: the label stays precise, the
 * switch stays correct, and the link between them is a table rather than a
 * convention repeated at each call site.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AI_OPERATION_POLICY_FEATURE,
  operationsGovernedBy,
  policyFeatureForOperation,
  type AiOperation,
} from "../src/services/ai/ai-operation-registry.js";
import {
  DEFAULT_WORKSPACE_AI_POLICY,
  decideAiPolicy,
} from "../src/services/ai/workspace-ai-policy.service.js";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_ROUTES = readFileSync(
  resolve(API_ROOT, "src/routes/ai-evidence.routes.ts"),
  "utf8",
);

describe("AI operation → policy feature registry", () => {
  it("every operation names a switch that actually exists", () => {
    // The seven policy features, from the evaluator's own default policy —
    // read rather than retyped, so this cannot pass against a stale list.
    const realFeatures = new Set([
      "SUPPORT_CHAT",
      "CAPTURE_ASSISTANCE",
      "EVIDENCE_CATEGORIZATION",
      "SEMANTIC_SEARCH",
      "CONTENT_INTELLIGENCE",
      "REVIEWER_COPILOT",
      "CASE_COPILOT",
    ]);
    for (const [op, feature] of Object.entries(AI_OPERATION_POLICY_FEATURE)) {
      expect(realFeatures.has(feature), `${op} → ${feature} is not a policy feature`).toBe(
        true,
      );
    }
  });

  it("the evidence copilot is governed by evidence categorisation", () => {
    // The one divergence in the product, now explicit instead of implicit.
    expect(policyFeatureForOperation("EVIDENCE_COPILOT")).toBe("EVIDENCE_CATEGORIZATION");
  });

  it("every other operation is governed by its own name", () => {
    for (const op of Object.keys(AI_OPERATION_POLICY_FEATURE) as AiOperation[]) {
      if (op === "EVIDENCE_COPILOT") continue;
      expect(policyFeatureForOperation(op), op).toBe(op);
    }
  });

  it("both evidence operations answer to one switch", () => {
    expect(operationsGovernedBy("EVIDENCE_CATEGORIZATION").sort()).toEqual([
      "EVIDENCE_CATEGORIZATION",
      "EVIDENCE_COPILOT",
    ]);
  });
});

describe("the evidence copilot route uses the registry", () => {
  it("does not spell a policy feature at the gate", () => {
    /*
     * A source assertion, deliberately — the defect being prevented IS a
     * literal written at a call site. Behaviour tests cannot see the
     * difference between deriving the switch and hardcoding the same value;
     * only the source can.
     */
    expect(EVIDENCE_ROUTES).toContain("policyFeatureForOperation(EVIDENCE_COPILOT_OPERATION)");
    expect(
      EVIDENCE_ROUTES,
      "the gate must derive its switch, not name one",
    ).not.toContain('feature: "EVIDENCE_CATEGORIZATION"');
  });

  it("budget and run row use the same constant as the gate", () => {
    // Three call sites, one identifier: if the ledger and the run row could
    // drift from the gate, the attribution defect would simply move.
    const uses = EVIDENCE_ROUTES.match(/feature: EVIDENCE_COPILOT_OPERATION/g) ?? [];
    expect(uses.length).toBe(2); // budget reserve + copilot run row
    expect(EVIDENCE_ROUTES).not.toContain('feature: "EVIDENCE_COPILOT"');
  });

  it("the recorded label is still the precise operation, not the switch", () => {
    // The fix must NOT rename persisted values: `EVIDENCE_COPILOT` and
    // `EVIDENCE_CATEGORIZATION` are different operations with different
    // providers, models and costs, and the ledger has to keep telling them
    // apart. A "tidy-up" that merged them would destroy real information.
    expect(EVIDENCE_ROUTES).toContain('EVIDENCE_COPILOT_OPERATION = "EVIDENCE_COPILOT"');
  });
});

describe("fail-closed behaviour is unchanged", () => {
  const base = {
    policy: DEFAULT_WORKSPACE_AI_POLICY,
    dataClass: "METADATA" as const,
    globalAiEnabled: true,
    providerConfigured: true,
    planAllowed: true,
  };

  it("disabling evidence categorisation disables the evidence copilot too", () => {
    const d = decideAiPolicy({
      ...base,
      policy: { ...DEFAULT_WORKSPACE_AI_POLICY, evidenceCategorizationEnabled: false },
      feature: policyFeatureForOperation("EVIDENCE_COPILOT"),
    });
    expect(d.allowed).toBe(false);
    expect(d.decision).toBe("FEATURE_DISABLED");
  });

  it("a workspace opt-out still denies it", () => {
    const d = decideAiPolicy({
      ...base,
      policy: { ...DEFAULT_WORKSPACE_AI_POLICY, aiEnabled: false },
      feature: policyFeatureForOperation("EVIDENCE_COPILOT"),
    });
    expect(d.allowed).toBe(false);
    expect(d.decision).toBe("WORKSPACE_DISABLED");
  });

  it("the registry did not quietly enable anything", () => {
    // The mapping must not become a back door: an operation whose switch is
    // off in the default policy must still be off through the registry.
    for (const op of ["CASE_COPILOT", "REVIEWER_COPILOT"] as const) {
      const d = decideAiPolicy({ ...base, feature: policyFeatureForOperation(op) });
      expect(d.allowed, op).toBe(false);
      expect(d.decision, op).toBe("FEATURE_DISABLED");
    }
  });
});

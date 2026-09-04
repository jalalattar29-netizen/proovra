/**
 * THE STATUS SETTINGS IS ALLOWED TO SHOW.
 *
 * Settings → AI used to render the workspace policy row alone — the switches an
 * administrator had set — and nothing about whether the platform could serve
 * AI. On a deployment with no provider configured it showed "enabled", with
 * green toggles, while every request in the product returned unavailable.
 *
 * These tests pin the two properties that fix costs: the status is the
 * EVALUATOR's answer rather than a re-derivation, and it never carries an
 * internal decision code outward.
 */

import { describe, expect, it } from "vitest";

import {
  projectAiAssistance,
  type AiAssistanceStatus,
} from "../src/services/ai/ai-assistance-projection.js";
import {
  DEFAULT_WORKSPACE_AI_POLICY,
  decideAiPolicy,
  type ResolvedWorkspaceAiPolicy,
} from "../src/services/ai/workspace-ai-policy.service.js";

const policy = (over: Partial<ResolvedWorkspaceAiPolicy> = {}): ResolvedWorkspaceAiPolicy => ({
  ...DEFAULT_WORKSPACE_AI_POLICY,
  ...over,
});

/** Runs the REAL evaluator, then projects — never a hand-built decision. */
function project(input: {
  policy?: ResolvedWorkspaceAiPolicy;
  globalAiEnabled?: boolean;
  providerConfigured?: boolean;
  planAllowed?: boolean;
  userRole?: string | null;
}) {
  const p = input.policy ?? policy();
  const decision = decideAiPolicy({
    policy: p,
    feature: "SUPPORT_CHAT",
    dataClass: "METADATA",
    globalAiEnabled: input.globalAiEnabled ?? true,
    providerConfigured: input.providerConfigured ?? true,
    planAllowed: input.planAllowed ?? true,
    userRole: input.userRole ?? null,
  });
  return projectAiAssistance(decision, p);
}

describe("AI assistance projection", () => {
  it("reports available only when the evaluator allows it", () => {
    const r = project({});
    expect(r.status).toBe("AVAILABLE");
    expect(r.available).toBe(true);
    expect(r.enabled).toBe(true);
  });

  it("a platform gap reads as unavailable, not as enabled", () => {
    // The exact defect: workspace switch ON, platform cannot serve.
    for (const gap of [{ globalAiEnabled: false }, { providerConfigured: false }]) {
      const r = project(gap);
      expect(r.status).toBe("TEMPORARILY_UNAVAILABLE");
      expect(r.available, "a platform gap is never available").toBe(false);
      // The workspace's own switch is still reported truthfully, so the UI can
      // tell an admin their setting is right and the platform is not serving.
      expect(r.enabled).toBe(true);
    }
  });

  it("never distinguishes WHICH operator gap it is", () => {
    // Telling a customer whether a flag is off or a key is absent discloses the
    // deployment's state to anyone with an account, and they cannot act on it.
    expect(project({ globalAiEnabled: false })).toEqual(
      project({ providerConfigured: false }),
    );
  });

  it("a workspace opt-out reads as disabled, not as unavailable", () => {
    const r = project({ policy: policy({ aiEnabled: false }) });
    expect(r.status).toBe("DISABLED_FOR_WORKSPACE");
    expect(r.enabled).toBe(false);
  });

  it("a feature switch off is a workspace decision too", () => {
    expect(project({ policy: policy({ supportChatEnabled: false }) }).status).toBe(
      "DISABLED_FOR_WORKSPACE",
    );
  });

  it("plan and role denials are told apart from each other", () => {
    expect(project({ planAllowed: false }).status).toBe("NOT_INCLUDED_IN_PLAN");
    expect(
      project({ policy: policy({ allowedRoles: ["OWNER"] }), userRole: "VIEWER" }).status,
    ).toBe("NOT_PERMITTED_FOR_ROLE");
  });

  it("every status is one of the bounded user-safe values", () => {
    const allowed: AiAssistanceStatus[] = [
      "AVAILABLE",
      "DISABLED_FOR_WORKSPACE",
      "NOT_INCLUDED_IN_PLAN",
      "NOT_PERMITTED_FOR_ROLE",
      "TEMPORARILY_UNAVAILABLE",
    ];
    const cases = [
      project({}),
      project({ globalAiEnabled: false }),
      project({ providerConfigured: false }),
      project({ policy: policy({ aiEnabled: false }) }),
      project({ policy: policy({ supportChatEnabled: false }) }),
      project({ planAllowed: false }),
      project({ policy: policy({ allowedRoles: ["OWNER"] }), userRole: "VIEWER" }),
    ];
    for (const c of cases) expect(allowed).toContain(c.status);
  });

  it("leaks no decision code, variable name or provider name", () => {
    const serialized = JSON.stringify([
      project({}),
      project({ globalAiEnabled: false }),
      project({ providerConfigured: false }),
      project({ policy: policy({ aiEnabled: false }) }),
      project({ planAllowed: false }),
    ]);
    for (const forbidden of [
      "GLOBAL_DISABLED",
      "PROVIDER_NOT_CONFIGURED",
      "WORKSPACE_DISABLED",
      "FEATURE_DISABLED",
      "PLAN_NOT_ENTITLED",
      "ROLE_NOT_PERMITTED",
      "DATA_CLASS_NOT_ALLOWED",
      "OPENAI",
      "policyVersion",
      "reason",
    ]) {
      expect(serialized, `leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("an unrecognised denial fails toward unavailable, never toward a promise", () => {
    const r = projectAiAssistance(
      {
        allowed: false,
        decision: "SOMETHING_ADDED_LATER" as never,
        reason: "internal",
        policyVersion: 1,
      },
      policy(),
    );
    expect(r.status).toBe("TEMPORARILY_UNAVAILABLE");
    expect(r.available).toBe(false);
  });
});

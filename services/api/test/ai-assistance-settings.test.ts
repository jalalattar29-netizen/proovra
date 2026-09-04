/**
 * WHAT A MEMBER MAY READ, AND WHAT THEY MUST NOT GAIN BY READING IT.
 *
 * A VIEWER could not open Settings → AI at all: the privileged envelope
 * requires `intelligence.read`, which VIEWER does not hold. The fix could not
 * be to grant it — that permission gates twenty-six endpoints including
 * executive metrics, provider budgets and reviewer quality scores.
 *
 * So the narrow read below sits behind `governance.policy.read`, which every
 * membership role already holds. These tests pin the two halves that makes it
 * safe: the shape carries no machinery, and reading it confers no authority.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { roleHasPermission } from "@proovra/shared";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = readFileSync(
  resolve(API_ROOT, "src/routes/workspace-ai-policy.routes.ts"),
  "utf8",
);
const SERVICE = readFileSync(
  resolve(API_ROOT, "src/services/ai/ai-assistance-settings.service.ts"),
  "utf8",
);

/**
 * Strip comments before asserting on code.
 *
 * The first version of the shape assertion failed on the word "capability"
 * inside a docstring explaining what the shape deliberately omits — the
 * comment describing the rule tripped the rule. Assertions about code should
 * read code.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the member-safe AI status read", () => {
  it("is gated on a permission every membership role already holds", () => {
    for (const role of ["OWNER", "ADMIN", "REVIEWER", "CONTRIBUTOR", "VIEWER"] as const) {
      expect(
        roleHasPermission(role, "governance.policy.read"),
        `${role} must be able to read the policies that govern it`,
      ).toBe(true);
    }
  });

  it("does NOT require the broad intelligence permission", () => {
    // The whole point. `intelligence.read` gates executive metrics, provider
    // budgets, provider health and reviewer quality — none of which becoming
    // visible is an acceptable price for showing an AI status.
    expect(roleHasPermission("VIEWER", "intelligence.read")).toBe(false);
    const idx = ROUTES.indexOf("app.get(\n    AI_ASSISTANCE_STATUS_PATH");
    expect(idx, "the status route must be registered").toBeGreaterThan(0);
    /*
     * Bounded by the NEXT route, not by a character count.
     *
     * A fixed window ran past this handler into the privileged envelope below
     * it, which legitimately requires `intelligence.read` — so the assertion
     * failed on a different route's correct code. The same fixed-window trap
     * the A3 hardening test had.
     */
    const end = ROUTES.indexOf("app.get(", idx + 10);
    expect(end).toBeGreaterThan(idx);
    const handler = ROUTES.slice(idx, end);
    expect(handler).toContain('"governance.policy.read"');
    expect(handler).not.toContain('"intelligence.read"');
  });

  it("did not lower the privileged envelope's own permission", () => {
    // The admin envelope returns the full policy row, the capability
    // disclosure with its internal statuses, and who last modified it. It must
    // keep requiring the stronger permission.
    expect(ROUTES).toContain('requireMember(req, reply, query.teamId, "intelligence.read")');
  });

  it("the write gate is unchanged and stronger than either read", () => {
    expect(ROUTES).toContain('"intelligence.policy.manage"');
    expect(roleHasPermission("VIEWER", "intelligence.policy.manage")).toBe(false);
    expect(roleHasPermission("CONTRIBUTOR", "intelligence.policy.manage")).toBe(false);
    expect(roleHasPermission("ADMIN", "intelligence.policy.manage")).toBe(true);
  });

  it("says nothing about authority, and reads no membership to decide it", () => {
    /*
     * A first version resolved `editable` here by reading the caller's
     * `teamMember` row. The authorization-closure gate flagged it, correctly:
     * a raw membership read inside a service is indistinguishable from an
     * authorization decision taken outside the canonical primitive.
     *
     * It was also redundant. Whether this user may change the policy is
     * already server-projected as `SETTINGS_MANAGE`, granted to exactly the
     * membership the PUT route enforces. Answering the same question from a
     * second source is how two answers start to disagree.
     */
    const code = codeOnly(SERVICE);
    expect(code, "no membership read in a service").not.toMatch(/prisma\.teamMember/);
    expect(code, "authority is not this module's to decide").not.toContain("editable");
    expect(code).not.toMatch(/role\s*===\s*["'](ADMIN|OWNER)["']/);
  });

  it("is registered under the post-rewrite path so it is reachable", () => {
    /*
     * `workspace-alias.plugin.ts` rewrites every `/v1/workspaces…` URL to
     * `/v1/teams…` BEFORE routing. A route registered under `/v1/workspaces`
     * is therefore unreachable — the FINAL-005 defect that left this whole
     * section dead in production once already.
     */
    expect(ROUTES).toContain('AI_ASSISTANCE_STATUS_PATH = "/v1/teams/ai-assistance-status"');
  });

  it("exposes no policy machinery in its response shape", () => {
    // Asserted against the response type, so adding a field means changing a
    // contract rather than quietly widening one.
    const code = codeOnly(SERVICE);
    const shape = code.slice(
      code.indexOf("export type AiAssistanceSettings"),
      code.indexOf("const FEATURES"),
    );
    for (const forbidden of [
      "policyVersion",
      "lastModifiedBy",
      "hasExplicitPolicy",
      "capabilities",
      "costUsdMicros",
      "provider",
      "model",
      "reason",
    ]) {
      expect(shape, `response shape must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("names features in product language, never policy or operation keys", () => {
    const code = codeOnly(SERVICE);
    const featureBlock = code.slice(
      code.indexOf("const FEATURES"),
      code.indexOf("export async function buildAiAssistanceSettings"),
    );
    // The switch names appear as the mapping's right-hand side, which is
    // internal. What must never appear is an operation/budget identifier.
    for (const key of ["EVIDENCE_COPILOT", "SUPPORT_CHAT", "CASE_COPILOT", "REVIEWER_COPILOT"]) {
      expect(featureBlock, `feature table must not surface ${key}`).not.toContain(key);
    }
    for (const label of ["Evidence assistance", "Reviewer preparation", "AI review"]) {
      expect(featureBlock).toContain(label);
    }
  });

  it("a feature that cannot run is never reported as enabled", () => {
    // Platform unavailability outranks a workspace switch: a capability that is
    // switched on but cannot run is not "enabled" to the person reading it.
    const build = SERVICE.slice(SERVICE.indexOf("const features: AiAssistanceFeature[]"));
    const unavailableIdx = build.indexOf('"UNAVAILABLE"');
    const enabledIdx = build.indexOf('state: on ?');
    expect(unavailableIdx).toBeGreaterThan(0);
    expect(enabledIdx).toBeGreaterThan(unavailableIdx);
  });
});

/**
 * "NOT INCLUDED" IS NOT "YOU USED IT ALL UP".
 *
 * A FREE account's very FIRST AI message came back as "You have reached the
 * maximum AI usage limit" — a limit it never had. The plan carries no AI
 * allowance at all, and the enforcement layer reported that state under the
 * exhaustion code.
 *
 * The response was internally contradictory and had been for as long as the
 * branch existed: HTTP 402 (the canonical "not included") and the message
 * "AI assistance is not included in the current plan", carried by
 * `code: "AI_MONTHLY_LIMIT_REACHED"`. The UI keys on the code.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  COLLABORATION_TEAM_BILLING_ERROR_CODES,
  COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS,
} from "@proovra/shared";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENFORCEMENT = readFileSync(
  resolve(API_ROOT, "src/services/billing-enforcement.service.ts"),
  "utf8",
);
const AI_ROUTES = readFileSync(resolve(API_ROOT, "src/routes/ai.routes.ts"), "utf8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("AI plan entitlement semantics", () => {
  it("the canonical table carries a distinct not-included code", () => {
    expect(COLLABORATION_TEAM_BILLING_ERROR_CODES).toContain("AI_NOT_INCLUDED");
    expect(COLLABORATION_TEAM_BILLING_ERROR_CODES).toContain("AI_MONTHLY_LIMIT_REACHED");
  });

  it("follows the table's own documented status rule", () => {
    /*
     * The header of that file states it: 402 means the plan does not include
     * the capability, 409/429 mean it is included and at cap. The table
     * already applied it to teams — TEAM_INVITES_NOT_INCLUDED (402) beside
     * TEAM_LIMIT_REACHED (409) — and AI was the one capability that skipped
     * it.
     */
    expect(COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS.AI_NOT_INCLUDED).toBe(402);
    expect(COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS.AI_MONTHLY_LIMIT_REACHED).toBe(429);
  });

  it("a plan with no allowance reports NOT INCLUDED, not exhausted", () => {
    const code = codeOnly(ENFORCEMENT);
    const capBranch = code.slice(
      code.indexOf("if (cap <= 0)"),
      code.indexOf("const tenantId = await resolveAiUsageTenantId"),
    );
    expect(capBranch).toContain('"AI_NOT_INCLUDED"');
    expect(
      capBranch,
      "the no-allowance branch must not carry the exhaustion code",
    ).not.toContain("AI_MONTHLY_LIMIT_REACHED");
  });

  it("a genuinely exhausted allowance still reports the limit", () => {
    const code = codeOnly(ENFORCEMENT);
    const exhausted = code.slice(code.indexOf("if (consumed >= cap)"));
    expect(exhausted).toContain('"AI_MONTHLY_LIMIT_REACHED"');
    expect(exhausted).toContain("429");
  });

  it("the two states are told apart by code, not only by status", () => {
    // They already differed by status (402 vs 429) and still shared one code,
    // which is exactly why the UI could not tell them apart.
    const code = codeOnly(ENFORCEMENT);
    const notIncluded = code.indexOf('"AI_NOT_INCLUDED"');
    const exhausted = code.indexOf('"AI_MONTHLY_LIMIT_REACHED"');
    expect(notIncluded).toBeGreaterThan(0);
    expect(exhausted).toBeGreaterThan(0);
    expect(notIncluded).not.toBe(exhausted);
  });
});

describe("deterministic answers and the monthly plan cap", () => {
  it("a local answer does not consume a monthly AI operation", () => {
    /*
     * The durable cost ledger already excluded deterministic short-circuits by
     * design — the Phase F-1 note says they "never reserve durable budget".
     * The plan-cap counter did not: a grounded product answer returns
     * status "ok", so "how do I capture evidence?", answered from knowledge
     * compiled into the build with no outbound call, spent one of the month's
     * AI operations. Two counters, one honouring the intent and one not.
     */
    const code = codeOnly(AI_ROUTES);
    /*
     * Scoped to the CHAT handler. The capture handler
     * (/v1/ai/capture/analyze-session) has no deterministic short-circuit —
     * it always reserves on the ledger and always calls the provider — so its
     * unconditional `status === "ok"` charge is correct and must stay.
     */
    const chatStart = code.indexOf('"/v1/ai/chat"');
    const chatEnd = code.indexOf('"/v1/ai/capture/analyze-session"');
    expect(chatStart).toBeGreaterThan(0);
    expect(chatEnd).toBeGreaterThan(chatStart);
    const chat = code.slice(chatStart, chatEnd);

    expect(chat).toContain('if (result.status === "ok" && !preflight)');
    expect(
      chat,
      "the unconditional form would charge for a local answer",
    ).not.toMatch(/if \(result\.status === "ok"\) \{\s*try \{\s*await recordWorkspaceAiOperation/);
  });

  it("the ledger still excludes them too, so both counters agree", () => {
    const code = codeOnly(AI_ROUTES);
    const preflightIdx = code.indexOf("const preflight = aiChatService.preflight");
    const reserveIdx = code.indexOf("tryReserveAiBudget", preflightIdx);
    const elseIdx = code.indexOf("} else {", preflightIdx);
    // The reservation happens in the else branch — the provider path only.
    expect(elseIdx).toBeGreaterThan(preflightIdx);
    expect(reserveIdx).toBeGreaterThan(elseIdx);
  });
});

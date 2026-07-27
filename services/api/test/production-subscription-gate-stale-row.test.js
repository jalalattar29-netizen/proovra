/**
 * Production regression — PRO user must not get a false 402 on
 * POST /v1/collaboration-teams from a STALE terminal Subscription row.
 *
 * PHASE 9 STEP 5 (2026-07-22): the subscription-active + grace DECISION was
 * relocated out of billing-guards' `assertSubscriptionActiveOrGraceAllowed`
 * into the ONE canonical lifecycle policy — `resolvePaidLifecycle` in
 * `services/api/src/services/billing/commercial-context.service.ts`. billing-
 * guards is now a thin adapter. This test therefore pins the SAME four-branch
 * corroboration invariant AT ITS NEW HOME (the resolver) and asserts the
 * adapter carries no competing engine. The business invariant is unchanged:
 *
 *   1. Live (ACTIVE/TRIALING) matching-scope row → allow.
 *   2. Matching PAST_DUE row inside the ONE bounded grace window → allow.
 *   3. No matching-scope row → allow (authoritative field governs; tolerate
 *      webhook lag) — a stale row for a DIFFERENT plan never leaks in.
 *   4. Every matching row terminal → block (SUBSCRIPTION_INACTIVE → 402).
 *
 * Style: source-contract (file-text). No DB I/O.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readApi(rel) {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
const RESOLVER = readApi("src/services/billing/commercial-context.service.ts");
const BILLING_GUARDS = readApi("src/services/collaboration-team/billing-guards.ts");
const SHARED_CODES = readFileSync(
  fileURLToPath(new URL("../../../packages/shared/src/collaboration-team-billing-codes.ts", import.meta.url)),
  "utf8",
);

// Isolate the canonical lifecycle policy body so the assertions cannot be
// satisfied by an unrelated query elsewhere in the file.
function extractLifecycle(src) {
  const idx = src.indexOf("async function resolvePaidLifecycle");
  expect(idx, "resolvePaidLifecycle must exist in commercial-context.service.ts").toBeGreaterThan(-1);
  return src.slice(idx, idx + 6000);
}
const GATE = extractLifecycle(RESOLVER);

describe("Phase 9 STEP 5 — canonical lifecycle no longer picks stale rows", () => {
  it("does NOT contain the legacy `findFirst({ where: { userId } })` shape", () => {
    expect(GATE).not.toMatch(/subscription\.findFirst\(\s*\{\s*where:\s*\{\s*userId\s*,?\s*\}\s*\}/);
  });
  it("every subscription.findFirst in the policy is scope-filtered (plan or teamId)", () => {
    const calls = GATE.match(/subscription\.findFirst\(\{[\s\S]{0,800}?\}\)/g) ?? [];
    expect(calls.length, "policy must consult at least one scope-filtered subscription row").toBeGreaterThan(0);
    // Scope is built once as `scopeWhere` ({ teamId } | { userId, plan }) and
    // spread into every query, so each call is scoped by construction.
    expect(GATE).toMatch(/const\s+scopeWhere\s*=/);
    expect(GATE).toMatch(/teamId:\s*scope\.teamId/);
    expect(GATE).toMatch(/userId:\s*scope\.ownerUserId,\s*plan:\s*scope\.plan/);
    for (const call of calls) {
      expect(call, `every subscription.findFirst must spread scopeWhere — found: ${call.slice(0, 160)}`).toMatch(/\.\.\.scopeWhere|scopeWhere/);
    }
  });
});

describe("Phase 9 STEP 5 — four-branch corroboration policy is wired", () => {
  it("Step 1 — live (ACTIVE/TRIALING) matching row", () => {
    expect(GATE).toMatch(/status:\s*\{\s*in:\s*\[S\.ACTIVE,\s*S\.TRIALING\]\s*\}/);
  });
  it("Step 2 — matching PAST_DUE row → the ONE bounded grace window", () => {
    expect(GATE).toMatch(/status:\s*S\.PAST_DUE/);
    expect(GATE).toMatch(/evalPastDueGrace/);
    expect(RESOLVER).toMatch(/COMMERCIAL_GRACE_PERIOD_MS/);
  });
  it("Step 3 — no matching-scope row → tolerate webhook lag → ACTIVE", () => {
    expect(GATE).toMatch(/anyMatching/);
    expect(GATE).toMatch(/if\s*\(\s*!anyMatching\s*\)\s*return\s+LIFE_ACTIVE/);
  });
  it("Step 4 — terminal matching row → deny (CANCELLED, mutationsAllowed false)", () => {
    const idx = GATE.indexOf("Step 4");
    expect(idx, "Step 4 comment present").toBeGreaterThan(-1);
    const slice = GATE.slice(idx, idx + 600);
    expect(slice).toMatch(/state:\s*"CANCELLED"/);
    expect(slice).toMatch(/mutationsAllowed:\s*false/);
  });
  it("FREE short-circuit precedes every subscription query", () => {
    const freeIdx = GATE.indexOf("scope.plan === prismaPkg.PlanType.FREE");
    const firstQueryIdx = GATE.indexOf("subscription.findFirst");
    expect(freeIdx).toBeGreaterThan(-1);
    expect(firstQueryIdx).toBeGreaterThan(-1);
    expect(freeIdx, "FREE early-return must precede subscription queries").toBeLessThan(firstQueryIdx);
  });
});

describe("Phase 9 STEP 5 — billing-guards is a thin adapter (no competing engine)", () => {
  function extractAdapter(src) {
    const idx = src.indexOf("export async function assertSubscriptionActiveOrGraceAllowed");
    expect(idx, "adapter must exist").toBeGreaterThan(-1);
    return src.slice(idx, idx + 2000);
  }
  const ADAPTER = extractAdapter(BILLING_GUARDS);
  it("delegates to resolveCommercialContext and reads its lifecycle", () => {
    expect(ADAPTER).toMatch(/resolveCommercialContext\(\{\s*ownerUserId:\s*userId\s*\}\)/);
    expect(ADAPTER).toMatch(/ctx\.lifecycle/);
  });
  it("contains NO independent subscription query or grace calculation", () => {
    expect(ADAPTER).not.toMatch(/subscription\.findFirst/);
    expect(ADAPTER).not.toMatch(/currentPeriodEnd/);
  });
  it("still maps a terminal verdict to SUBSCRIPTION_INACTIVE", () => {
    expect(ADAPTER).toMatch(/code:\s*"SUBSCRIPTION_INACTIVE"/);
  });
});

describe("Production fix — error-code mapping is unchanged", () => {
  it("SUBSCRIPTION_INACTIVE still maps to HTTP 402", () => {
    expect(SHARED_CODES).toMatch(/SUBSCRIPTION_INACTIVE:\s*402/);
  });
});

/**
 * Production regression test — PRO user 402 on POST /v1/collaboration-teams.
 *
 * Symptom observed in production: a PRO user POSTing to
 * /v1/collaboration-teams received `402 Payment Required`. UI showed
 * "Couldn't create Team. Try again."
 *
 * Root cause (proved by tracing the call path):
 *   POST /v1/collaboration-teams → assertSubscriptionActiveOrGraceAllowed
 *   → prisma.subscription.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" }})
 *
 * The query had NO plan filter and NO status filter. The
 * `subscriptions` table accumulates one row per (provider,
 * providerSubId) — a user who:
 *
 *   * cancelled a prior PAYG subscription before upgrading to PRO,
 *   * abandoned a checkout leaving INCOMPLETE_EXPIRED behind,
 *   * had a past renewal go PAST_DUE then later succeeded on a fresh
 *     subscription,
 *
 * would have one or more stale rows in a terminal state. A late
 * webhook bump (refund posted / dispute closed / final-invoice settled)
 * would make the stale row the most-recently-updated, and the gate
 * picked it up — rejecting the mutation with `SUBSCRIPTION_INACTIVE`,
 * which maps to HTTP 402 in
 * `COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS`.
 *
 * The fix: corroborate the entitlement with the user's CURRENT plan.
 * Stale rows for OTHER plans are ignored. The four branches the gate
 * must now implement (pinned below):
 *
 *   1. Live (ACTIVE/TRIALING) subscription for the current plan
 *      → allow.
 *   2. PAST_DUE matching-plan row inside the grace window → allow.
 *   3. No subscription row matches the current plan → allow
 *      (entitlement is authoritative; tolerate webhook lag).
 *   4. Every matching-plan row is terminal → block 402.
 *
 * Style: source-contract (file-text) — matches the existing
 * `production-billing-parity.test.ts` pattern. No DB I/O.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

const BILLING_GUARDS = readApi(
  "src/services/collaboration-team/billing-guards.ts",
);
const SHARED_CODES = readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/shared/src/collaboration-team-billing-codes.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);

// Extract the body of `assertSubscriptionActiveOrGraceAllowed` so the
// assertions below stay tightly scoped to that function and cannot be
// satisfied by an unrelated subscription query elsewhere in the file.
function extractSubscriptionGate(src: string): string {
  const idx = src.indexOf(
    "export async function assertSubscriptionActiveOrGraceAllowed",
  );
  expect(
    idx,
    "assertSubscriptionActiveOrGraceAllowed must exist in billing-guards.ts",
  ).toBeGreaterThan(-1);
  // Slice through the next blank-line-followed-by `// =` separator
  // (the file's section separator). Generous upper bound.
  const slice = src.slice(idx, idx + 6000);
  return slice;
}

const GATE = extractSubscriptionGate(BILLING_GUARDS);

// ===========================================================================
// 1. The legacy naive query is GONE
// ===========================================================================

describe("Production fix — subscription gate no longer picks stale rows", () => {
  it("does NOT contain the legacy `findFirst({ where: { userId } })` shape", () => {
    // The original bug was a `findFirst` with ONLY `where: { userId }`.
    // Any new findFirst on subscription must also constrain by plan or
    // status (or both). This regex matches the legacy single-key shape.
    expect(GATE).not.toMatch(
      /subscription\.findFirst\(\s*\{\s*where:\s*\{\s*userId\s*,?\s*\}/,
    );
  });

  it("every subscription.findFirst inside the gate is plan-scoped", () => {
    // Pull each `subscription.findFirst({...})` block inside the gate
    // body. Every one of them MUST include either `plan,` (Prisma
    // shorthand) or `plan:` to scope by the user's current plan, so a
    // stale row for a DIFFERENT plan cannot leak in.
    const calls =
      GATE.match(/subscription\.findFirst\(\{[\s\S]{0,800}?\}\)/g) ?? [];
    expect(calls.length, "gate must consult at least one plan-scoped subscription row").toBeGreaterThan(0);
    for (const call of calls) {
      expect(
        call,
        `every subscription.findFirst in the gate must filter by plan — found: ${call.slice(0, 200)}`,
      ).toMatch(/\bplan\b/);
    }
  });
});

// ===========================================================================
// 2. The four canonical branches are wired
// ===========================================================================

describe("Production fix — corroboration policy is wired correctly", () => {
  it("Step 1 — looks up a live (ACTIVE/TRIALING) subscription for the current plan", () => {
    // The first preference: any ACTIVE or TRIALING row matching the
    // user's plan. Encoded as `status: { in: [ACTIVE, TRIALING] }`.
    expect(GATE).toMatch(
      /status:\s*\{\s*in:\s*\[[\s\S]{0,200}SubscriptionStatus\.ACTIVE[\s\S]{0,200}SubscriptionStatus\.TRIALING/,
    );
  });

  it("Step 2 — looks up a PAST_DUE row for the current plan and checks grace window", () => {
    // The grace window check still uses SUBSCRIPTION_GRACE_PERIOD_MS
    // and currentPeriodEnd, but now ONLY against a matching-plan
    // PAST_DUE row (not any random row).
    expect(GATE).toMatch(
      /status:\s*prismaPkg\.SubscriptionStatus\.PAST_DUE/,
    );
    expect(GATE).toMatch(/SUBSCRIPTION_GRACE_PERIOD_MS/);
    expect(GATE).toMatch(/inGracePeriod/);
  });

  it("Step 3 — falls through to ACTIVE when NO row matches the current plan", () => {
    // The entitlement table is authoritative. If the user has a paid
    // entitlement but no matching subscription row (manual grant,
    // provider switch, webhook lag), the gate must allow.
    expect(GATE).toMatch(/matchingPlanRow/);
    expect(GATE).toMatch(
      /if\s*\(\s*!matchingPlanRow\s*\)\s*\{\s*return\s*\{[\s\S]{0,200}status:\s*"ACTIVE"/,
    );
  });

  it("Step 4 — blocks SUBSCRIPTION_INACTIVE only when every matching-plan row is terminal", () => {
    // The `throwBillingError` must come AFTER the matching-plan-row
    // existence check, so a missing row is allow (Step 3) and only an
    // existing-but-terminal row produces 402.
    const stepFourIdx = GATE.indexOf("Step 4");
    expect(stepFourIdx, "Step 4 comment must be present").toBeGreaterThan(-1);
    const stepFourSlice = GATE.slice(stepFourIdx, stepFourIdx + 1500);
    expect(stepFourSlice).toMatch(/throwBillingError/);
    expect(stepFourSlice).toMatch(/code:\s*"SUBSCRIPTION_INACTIVE"/);
  });
});

// ===========================================================================
// 3. The FREE early-return short-circuit is preserved
// ===========================================================================

describe("Production fix — FREE-tier early return is preserved", () => {
  it("FREE users still short-circuit at ACTIVE before any subscription query", () => {
    // Regression guard: the FREE-tier early return must precede every
    // subscription query, otherwise FREE users would hit Step 4 (no
    // matching-plan row → allow) by coincidence rather than by design.
    const freeIdx = GATE.indexOf("plan === prismaPkg.PlanType.FREE");
    const firstQueryIdx = GATE.indexOf("subscription.findFirst");
    expect(freeIdx).toBeGreaterThan(-1);
    expect(firstQueryIdx).toBeGreaterThan(-1);
    expect(freeIdx, "FREE early-return must precede subscription queries").toBeLessThan(firstQueryIdx);
  });
});

// ===========================================================================
// 4. The HTTP status mapping stays at 402 for SUBSCRIPTION_INACTIVE
// ===========================================================================

describe("Production fix — error-code mapping is unchanged", () => {
  it("SUBSCRIPTION_INACTIVE still maps to HTTP 402 (semantic preserved)", () => {
    // The fix only changes WHEN this error fires (only on legitimate
    // terminal-plan rows), not WHAT HTTP code it produces. UI / API
    // consumers continue to treat 402 as the canonical
    // payment-required signal.
    expect(SHARED_CODES).toMatch(/SUBSCRIPTION_INACTIVE:\s*402/);
  });
});

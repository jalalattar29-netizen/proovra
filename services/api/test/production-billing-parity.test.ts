/**
 * Production billing-parity regression test.
 *
 * Pins the source-of-truth fix for the production issue where a PRO user
 * was getting `402 TEAM_LIMIT_REACHED` from `POST /v1/collaboration-teams`
 * while the UI badge displayed "FREE plan: 0 of 1 teams used".
 *
 * Root cause: the platform-context envelope builder queried
 * `Entitlement.findFirst({ where: { userId } })` (no `active` filter),
 * while the canonical billing guard
 * (`services/api/src/services/collaboration-team/billing-guards.ts` →
 * `resolveUserPlan`) queried `Entitlement.findFirst({ where: { userId,
 * active: true } })`. When a user had a SUPERSEDED FREE row and a live
 * PRO row, the envelope returned the wrong plan to the UI.
 *
 * This test enforces that BOTH consumers use the SAME filter shape so
 * they cannot drift again.
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

const PLATFORM_CTX = readApi(
  "src/services/platform-context/platform-context.service.ts",
);
const BILLING_GUARDS = readApi(
  "src/services/collaboration-team/billing-guards.ts",
);

describe("Production fix — entitlement plan resolution parity", () => {
  it("billing-guards.ts does not read Entitlement itself — it resolves the canonical envelope", () => {
    // The active-entitlement filter has ONE home. A guard that repeats the
    // query is a guard that can repeat it wrongly; the 2025 production
    // mismatch ("FREE plan: 0 of 1 teams used" for PRO users) was exactly a
    // second copy of this read drifting from the first.
    expect(BILLING_GUARDS).not.toMatch(/entitlement\.findFirst/);
    expect(BILLING_GUARDS).toMatch(/resolveCommercialContext/);

    // …and the envelope's own reader still applies the filter.
    const ensure = readApi("src/services/billing.service.ts");
    expect(ensure).toMatch(
      /entitlement\.findFirst\(\{[\s\S]*?where:\s*\{[\s\S]*?userId[\s\S]*?active:\s*true/,
    );
  });

  it("platform-context.service.ts resolves the workspace plan through the canonical resolver", () => {
    /*
     * COMMERCIAL TRUTH CLOSURE (2026-09-08) — the PROPERTY this protects is
     * unchanged; the mechanism that guarantees it is stronger.
     *
     * The 2025 production mismatch — PRO users seeing "FREE plan: 0 of 1 teams
     * used" — happened because platform context ran its OWN entitlement query
     * beside the authoritative guard's, and the two picked different rows. The
     * fix at the time was to copy the guard's filter into the second query, and
     * this assertion pinned that copy.
     *
     * Copying a filter between two implementations is the defect one iteration
     * later, and this file's own title says so: PARITY. The overlay is gone.
     * The workspace plan is now resolved by `resolveCommercialPlan` — the canonical layer's cheap entry point, the one
     * public authority, so there is no second query whose filter could drift —
     * which is a stronger guarantee than the two agreeing by hand.
     *
     * The `active: true` requirement did not disappear: it lives inside the
     * canonical chain (`ensureEntitlement`), and the account-plan read below is
     * still pinned directly.
     */
    expect(PLATFORM_CTX).toMatch(/resolveCommercialPlan\(\{[\s\S]{0,200}type:\s*"WORKSPACE"/);
    // And no second, private plan overlay came back.
    const entitlementReads = PLATFORM_CTX.match(/entitlement\.findFirst\(/g) ?? [];
    expect(entitlementReads).toHaveLength(1);
  });

  it("platform-context.service.ts account-plan read uses active:true", () => {
    // `envelope.account.accountPlan` is the UI's fallback when the
    // personal-space plan is null. It must also use the active filter
    // so the UI badge never lies about the plan tier.
    const accountBranch = PLATFORM_CTX.match(
      /accountPlan[\s\S]{0,400}?entitlement\.findFirst\([\s\S]{0,400}?\}\)/,
    );
    expect(accountBranch).toBeTruthy();
    expect(accountBranch![0]).toMatch(/active:\s*true/);
  });

  it("platform-context.service.ts has NO entitlement query without an active filter", () => {
    // Tighten the contract — every entitlement.findFirst in the envelope
    // builder must scope to active rows. Add new branches here if a
    // future phase legitimately needs a non-active read (e.g., audit
    // history), then qualify the regex.
    const queries = PLATFORM_CTX.match(
      /entitlement\.findFirst\(\{[\s\S]{0,400}?\}\)/g,
    ) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q, "every envelope entitlement read must filter active:true").toMatch(
        /active:\s*true/,
      );
    }
  });
});

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
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
const PLATFORM_CTX = readApi("src/services/platform-context/platform-context.service.ts");
const BILLING_GUARDS = readApi("src/services/collaboration-team/billing-guards.ts");
describe("Production fix — entitlement plan resolution parity", () => {
    it("billing-guards.ts queries Entitlement with active:true (canonical source of truth)", () => {
        // The authoritative `resolveUserPlan` helper must always read only
        // active entitlements.
        expect(BILLING_GUARDS).toMatch(/entitlement\.findFirst\(\{[\s\S]*?where:\s*\{[\s\S]*?userId[\s\S]*?active:\s*true/);
    });
    it("platform-context.service.ts personal-workspace plan read uses active:true", () => {
        // The PERSONAL workspace plan overlay must apply the SAME filter as
        // the authoritative guard. Drift here caused the 2025 production
        // mismatch where PRO users saw "FREE plan: 0 of 1 teams used".
        const personalBranch = PLATFORM_CTX.match(/workspace\.scope === "PERSONAL"[\s\S]{0,1500}?entitlement\.findFirst\([\s\S]{0,400}?\}\)/);
        expect(personalBranch).toBeTruthy();
        expect(personalBranch[0]).toMatch(/active:\s*true/);
    });
    it("platform-context.service.ts account-plan read uses active:true", () => {
        // `envelope.account.accountPlan` is the UI's fallback when the
        // personal-space plan is null. It must also use the active filter
        // so the UI badge never lies about the plan tier.
        const accountBranch = PLATFORM_CTX.match(/accountPlan[\s\S]{0,400}?entitlement\.findFirst\([\s\S]{0,400}?\}\)/);
        expect(accountBranch).toBeTruthy();
        expect(accountBranch[0]).toMatch(/active:\s*true/);
    });
    it("platform-context.service.ts has NO entitlement query without an active filter", () => {
        // Tighten the contract — every entitlement.findFirst in the envelope
        // builder must scope to active rows. Add new branches here if a
        // future phase legitimately needs a non-active read (e.g., audit
        // history), then qualify the regex.
        const queries = PLATFORM_CTX.match(/entitlement\.findFirst\(\{[\s\S]{0,400}?\}\)/g) ?? [];
        expect(queries.length).toBeGreaterThan(0);
        for (const q of queries) {
            expect(q, "every envelope entitlement read must filter active:true").toMatch(/active:\s*true/);
        }
    });
});

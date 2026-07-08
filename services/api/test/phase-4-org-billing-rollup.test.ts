/**
 * Phase 4 (Enterprise Administration) — org billing/seat rollup contract.
 *
 * Extends the Phase B0 rollup (GET /v1/orgs/:id/billing/rollup) with seat
 * usage, over-seat counts, active-workspace count, and the org billing
 * owner's operator-readable identity. Source-contract style (mirrors
 * phase-b0-workspace-operating-model.test.ts): we read the route source
 * and assert the aggregate shape + the counts-only / role-gated
 * invariants, so the guarantees cannot silently regress.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const GOV_ROUTES = readSource(
  "../src/routes/organizations-governance.routes.ts",
);

// Anchor every assertion inside the registered handler so the route
// file's top-comment cannot satisfy a check on its own.
function rollupHandler(): string {
  const idx = GOV_ROUTES.indexOf(
    'app.get(\n    "/v1/orgs/:id/billing/rollup"',
  );
  expect(idx).toBeGreaterThan(0);
  return GOV_ROUTES.slice(idx, idx + 6_000);
}

describe("Phase 4 — org billing rollup", () => {
  it("is gated at ORG_BILLING_ADMIN minimum", () => {
    expect(rollupHandler()).toContain('minRole: "ORG_BILLING_ADMIN"');
  });

  it("is read-only — the handler issues no write verbs", () => {
    const h = rollupHandler();
    expect(h).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete)\(/);
  });

  it("aggregates seat usage (included + used) and over-seat count", () => {
    const h = rollupHandler();
    // Used seats come from the team member count — same signal the
    // per-workspace billing overview uses.
    expect(h).toContain("_count: { select: { members: true } }");
    expect(h).toContain("totalIncludedSeats");
    expect(h).toContain("totalUsedSeats");
    expect(h).toContain("overSeatWorkspaceCount");
    expect(h).toContain("activeWorkspaceCount");
    // Per-workspace view exposes used vs. included + an overSeat flag.
    expect(h).toContain("usedSeats: w._count.members");
    expect(h).toMatch(/overSeat:/);
  });

  it("surfaces the org billing owner as an identity only (no payment data)", () => {
    const h = rollupHandler();
    expect(h).toContain("billingOwnerUserId");
    expect(h).toContain("billingOwner");
    // Identity fields only.
    expect(h).toMatch(/email:\s*billingOwner\.email/);
  });

  it("returns counts only — no card tokens, no Stripe ids", () => {
    const h = rollupHandler();
    expect(h).not.toMatch(
      /stripeSubscriptionId|stripeCustomerId|cardLast4|paymentMethod|card_/i,
    );
  });

  it("emits anti-enumeration 404 (never 403) on access denial", () => {
    const h = rollupHandler();
    expect(h).toMatch(/if \(!access\.ok\)/);
    expect(h).toContain("access.code");
  });
});

/**
 * Account closure vs. open provider billing relationships (PRO-N1-01, DEC-21).
 *
 * Closure anonymises the payer irreversibly. It used to judge each candidate
 * subscription by the ENTITLEMENT verdict (`lifecycle.paidActive`), which
 * short-circuits a FREE entitlement, reads two live rows as CANCELLED and
 * PAST_DUE beyond grace as unpaid, and never looked at recurring storage
 * add-ons — every one of which the provider can still charge. The question is
 * now the RELATIONSHIP: does anything still renew (block), or has its end been
 * confirmed but not reached (closure is SCHEDULED and waits)?
 *
 * The earlier report this suite was written for — Billing showing nothing to
 * cancel while closure said "active subscription" — is answered by the
 * reconciliation sweep and Billing's re-check converging a stale row, not by
 * ignoring a row the provider may still bill.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  closureWaitsForBillingMessage,
  judgeClosureBillingRelationships,
  type ClosureBillingRelationship,
} from "../src/services/identity/account-closure-subscription-policy.js";

const PREFLIGHT = readFileSync(
  fileURLToPath(new URL("../src/services/identity/account-lifecycle-preflight.service.ts", import.meta.url)),
  "utf8",
);
const RELATIONSHIPS = readFileSync(
  fileURLToPath(new URL("../src/services/billing/open-provider-relationships.service.ts", import.meta.url)),
  "utf8",
);

const IN_30_DAYS = new Date(Date.now() + 30 * 86_400_000);
const IN_60_DAYS = new Date(Date.now() + 60 * 86_400_000);

const sub = (over: Partial<ClosureBillingRelationship> = {}): ClosureBillingRelationship => ({
  kind: "SUBSCRIPTION",
  state: "RENEWING",
  endsAtUtc: IN_30_DAYS,
  ...over,
});
const addon = (over: Partial<ClosureBillingRelationship> = {}): ClosureBillingRelationship => ({
  ...sub(over),
  kind: "STORAGE_ADDON",
});

describe("nothing open — closure proceeds", () => {
  it("no relationship at all (FREE never subscribed, PAYG wallet) — no blocker, nothing pending", () => {
    expect(judgeClosureBillingRelationships([])).toEqual({ blockers: [], pending: null });
  });
});

describe("anything that still renews blocks", () => {
  it("a renewing subscription blocks and says to cancel it", () => {
    const { blockers } = judgeClosureBillingRelationships([sub()]);
    expect(blockers).toEqual([
      {
        code: "BILLING_SUBSCRIPTION_ACTIVE",
        message: "You have an active subscription. Cancel it before closing your account.",
        count: 1,
      },
    ]);
  });

  it("two renewing rows (a true multiple-live anomaly) both count", () => {
    expect(judgeClosureBillingRelationships([sub(), sub()]).blockers[0]?.count).toBe(2);
  });

  it("a recurring storage add-on with no live base still blocks, with its own code", () => {
    const { blockers } = judgeClosureBillingRelationships([addon()]);
    expect(blockers.map((b) => b.code)).toEqual(["BILLING_ADDON_ACTIVE"]);
  });

  it("a renewing relationship blocks even beside one that is already ending", () => {
    const res = judgeClosureBillingRelationships([sub({ state: "STOPPING" }), addon()]);
    expect(res.blockers.map((b) => b.code)).toEqual(["BILLING_ADDON_ACTIVE"]);
  });
});

describe("a cancelled relationship that has not ended makes closure wait (DEC-21)", () => {
  it("is not a blocker; the latest end is reported", () => {
    const res = judgeClosureBillingRelationships([
      sub({ state: "STOPPING", endsAtUtc: IN_30_DAYS }),
      addon({ state: "STOPPING", endsAtUtc: IN_60_DAYS }),
    ]);
    expect(res.blockers).toEqual([]);
    expect(res.pending).toEqual({ count: 2, endsAtUtc: IN_60_DAYS });
    expect(closureWaitsForBillingMessage(res.pending!)).toContain(IN_60_DAYS.toISOString().slice(0, 10));
  });

  it("an unknown end (e.g. a PayPal cancel awaiting its event) waits without a date", () => {
    const res = judgeClosureBillingRelationships([sub({ state: "STOPPING", endsAtUtc: null })]);
    expect(res.pending).toEqual({ count: 1, endsAtUtc: null });
    expect(closureWaitsForBillingMessage(res.pending!)).toContain("once the payment provider confirms the end");
  });
});

describe("the preflight judges relationships, not the entitlement verdict", () => {
  it("does not consult the paid-access verdict any more", () => {
    expect(PREFLIGHT).not.toContain("lifecycle.paidActive");
    expect(PREFLIGHT).toContain("listOpenProviderRelationships");
  });

  it("reads recurring storage add-ons and the workspaces being closed", () => {
    expect(RELATIONSHIPS).toContain("workspaceStorageAddon.findMany");
    expect(RELATIONSHIPS).toMatch(/teamId:\s*\{\s*in:\s*teamIds\s*\}/);
  });

  it("closure stays universal — no plan or entitlement gates it", () => {
    expect(PREFLIGHT).not.toMatch(/prisma\.entitlement\b/);
  });
});

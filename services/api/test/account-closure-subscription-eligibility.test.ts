/**
 * Account closure vs. the commercial authority — they must agree.
 *
 * REPORTED: an account Billing showed as FREE opened Settings → Privacy & data
 * → Close account and was told "You have an active subscription. Cancel it
 * before closing your account", with a "Go to Billing" action that led to a
 * page offering nothing to cancel.
 *
 * The preflight was asking the database for any row belonging to the user with
 * a status in (ACTIVE, TRIALING, PAST_DUE) and treating a hit as proof of a
 * live billing relationship. That query is not the canonical question. It has
 * no `teamId` scope, so a WORKSPACE subscription counted against its
 * purchaser's personal closure; it never consults lifecycle, so a stale row a
 * webhook never closed counted forever; and it never asks the authority that
 * `/billing` itself renders, which short-circuits a FREE scope before it looks
 * at a subscription row at all.
 *
 * The verdict now comes from `resolveCommercialContext(...).lifecycle
 * .paidActive`. These tests drive the decision over every state the brief
 * names, and the last one pins the consistency invariant itself.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildSubscriptionClosureBlocker,
  type ClosureSubscriptionCandidate,
} from "../src/services/identity/account-closure-subscription-policy.js";

const PREFLIGHT = readFileSync(
  fileURLToPath(
    new URL(
      "../src/services/identity/account-lifecycle-preflight.service.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);

const IN_30_DAYS = new Date(Date.now() + 30 * 86_400_000);

/** A row the canonical authority scored as NOT live for its subject. */
function dead(
  over: Partial<ClosureSubscriptionCandidate> = {},
): ClosureSubscriptionCandidate {
  return {
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    paidActiveForSubject: false,
    ...over,
  };
}

/** A row the canonical authority scored as LIVE for its subject. */
function live(
  over: Partial<ClosureSubscriptionCandidate> = {},
): ClosureSubscriptionCandidate {
  return { ...dead(over), paidActiveForSubject: true };
}

describe("a FREE account has nothing to cancel", () => {
  it("A. FREE, never subscribed — no candidate rows, no blocker", () => {
    expect(buildSubscriptionClosureBlocker([])).toBeNull();
  });

  it("B. FREE with a historical cancelled subscription — no blocker", () => {
    // The row still exists and may still read ACTIVE in the table; the
    // canonical authority scores the FREE scope as INACTIVE, and that is what
    // decides. This is the reported bug.
    expect(buildSubscriptionClosureBlocker([dead()])).toBeNull();
  });

  it("E. an expired subscription does not block", () => {
    expect(
      buildSubscriptionClosureBlocker([
        dead({ currentPeriodEnd: new Date("2020-01-01T00:00:00.000Z") }),
      ]),
    ).toBeNull();
  });

  it("a stale row whose grace has elapsed does not block", () => {
    // PAST_DUE beyond its bounded grace is PAST_DUE_EXPIRED to the canonical
    // policy: not paid, not active. The old query counted it as active.
    expect(buildSubscriptionClosureBlocker([dead(), dead()])).toBeNull();
  });

  it("F. PAYG with no recurring subscription — a wallet is not a subscription", () => {
    // Credits are not a recurring relationship, so PAYG reaches closure with
    // no candidate row at all and nothing to cancel.
    expect(buildSubscriptionClosureBlocker([])).toBeNull();
  });
});

describe("a live subscription still blocks", () => {
  it("C. an active paid subscription blocks, and says to cancel it", () => {
    const blocker = buildSubscriptionClosureBlocker([live()]);
    expect(blocker?.code).toBe("BILLING_SUBSCRIPTION_ACTIVE");
    expect(blocker?.message).toBe(
      "You have an active subscription. Cancel it before closing your account.",
    );
    expect(blocker?.count).toBe(1);
  });

  it("D. cancel-at-period-end blocks until the period ends, and does not ask again", () => {
    // Access runs to the paid period's end, so it blocks — but telling someone
    // to cancel what they have already cancelled is the most frustrating kind
    // of wrong, so the copy changes instead.
    const blocker = buildSubscriptionClosureBlocker([
      live({ cancelAtPeriodEnd: true, currentPeriodEnd: IN_30_DAYS }),
    ]);
    expect(blocker?.code).toBe("BILLING_SUBSCRIPTION_ACTIVE");
    expect(blocker?.message).toContain("already cancelled and ends on");
    expect(blocker?.message).toContain(IN_30_DAYS.toISOString().slice(0, 10));
    expect(blocker?.message).not.toContain("Cancel it before");
  });

  it("D. cancel-at-period-end with no known end date still says to wait", () => {
    const blocker = buildSubscriptionClosureBlocker([
      live({ cancelAtPeriodEnd: true, currentPeriodEnd: null }),
    ]);
    expect(blocker?.message).toContain("ends at the end of the paid period");
  });

  it("G. a live workspace subscription blocks, and is counted once per live row", () => {
    const blocker = buildSubscriptionClosureBlocker([live(), live()]);
    expect(blocker?.count).toBe(2);
  });

  it("one live row among dead ones still blocks, and the dead ones are not counted", () => {
    const blocker = buildSubscriptionClosureBlocker([dead(), live(), dead()]);
    expect(blocker?.count).toBe(1);
    expect(blocker?.message).toBe(
      "You have an active subscription. Cancel it before closing your account.",
    );
  });

  it("a mix of cancelling and not-cancelling asks for the cancellation", () => {
    // "All of them are already cancelled" is the only case that may say so.
    const blocker = buildSubscriptionClosureBlocker([
      live({ cancelAtPeriodEnd: true, currentPeriodEnd: IN_30_DAYS }),
      live({ cancelAtPeriodEnd: false }),
    ]);
    expect(blocker?.message).toBe(
      "You have an active subscription. Cancel it before closing your account.",
    );
  });
});

describe("closure and Billing read ONE commercial authority", () => {
  it("the verdict comes from resolveCommercialContext, not a second calculator", () => {
    expect(PREFLIGHT).toContain("resolveCommercialContext");
    expect(PREFLIGHT).toContain("lifecycle.paidActive");
  });

  it("the preflight derives no commercial state of its own", () => {
    // A second calculator is how the two drifted apart in the first place.
    expect(PREFLIGHT).not.toMatch(/getPlanCapabilities\(/);
    expect(PREFLIGHT).not.toMatch(/isWorkspaceSubscriptionActive\(/);
    expect(PREFLIGHT).not.toMatch(/resolvePaidLifecycle\(/);
    // …and it does not re-implement grace or period arithmetic. The only date
    // it touches is the one it PRINTS in the message.
    expect(PREFLIGHT).not.toMatch(/GRACE|graceEndsAtUtc/);
  });

  it("a subscription row alone never decides — the subject's verdict does", () => {
    // The guard against the exact regression: were `paidActiveForSubject`
    // ignored and row presence used again, this would emit a blocker.
    const rowsThatLookLive = [
      dead({ cancelAtPeriodEnd: false, currentPeriodEnd: IN_30_DAYS }),
      dead({ cancelAtPeriodEnd: true, currentPeriodEnd: IN_30_DAYS }),
    ];
    expect(buildSubscriptionClosureBlocker(rowsThatLookLive)).toBeNull();
  });

  it("the candidate query carries the row's SUBJECT", () => {
    // Without `teamId` a workspace's subscription is charged against its
    // purchaser's personal closure — the canonical Billing projection reads a
    // PERSONAL subscription as `{ userId, teamId: null }`.
    expect(PREFLIGHT).toMatch(/select:\s*\{[\s\S]*?teamId:\s*true/);
  });

  it("closure stays universal — no plan or entitlement gates it", () => {
    // Unchanged invariant: closure is not a paid feature. The fix makes it
    // MORE available, never less.
    expect(PREFLIGHT).not.toMatch(/prisma\.entitlement\b/);
  });
});

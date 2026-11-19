/**
 * PRO-N1-13 (WS-BILL) — the shell banner about the person's OWN paid plan.
 *
 * It renders only what the API's `account.billingSignal` says (the canonical
 * lifecycle verdict), links to Billing, and renders NOTHING against an API
 * that predates the field (the web deploys before the API).
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const ctx = vi.hoisted(() => ({ envelope: null as unknown }));
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ envelope: ctx.envelope }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { BillingAttentionBanner } from "../../components/app-shell-v2/BillingAttentionBanner";

const banner = () => document.querySelector<HTMLElement>("[data-billing-attention-banner]");
const show = (billingSignal: unknown) => {
  ctx.envelope = { account: { accountPlan: "PRO", ...(billingSignal === undefined ? {} : { billingSignal }) } };
  return render(<BillingAttentionBanner />);
};

describe("PRO-N1-13 — shell billing attention banner", () => {
  afterEach(() => {
    cleanup();
    ctx.envelope = null;
  });

  it("an older API (no billingSignal), a null signal and a missing envelope render nothing", () => {
    show(undefined);
    expect(banner()).toBeNull();
    cleanup();
    show(null);
    expect(banner()).toBeNull();
    cleanup();
    ctx.envelope = null;
    render(<BillingAttentionBanner />);
    expect(banner()).toBeNull();
  });

  it("a failed payment in grace is dated and links to Billing", () => {
    show({ state: "PAST_DUE", graceEndsAtUtc: "2026-12-08T00:00:00.000Z", endsAtUtc: null });
    const el = banner()!;
    expect(el.getAttribute("data-billing-state")).toBe("PAST_DUE");
    expect(el.textContent).toMatch(/Payment overdue/);
    expect(el.textContent).toMatch(/continues until .*2026/);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/billing");
  });

  it("grace over, lapsed and cancelling each say what is true, never 'renews'", () => {
    show({ state: "PAST_DUE_EXPIRED", graceEndsAtUtc: null, endsAtUtc: null });
    expect(banner()!.textContent).toMatch(/grace period has ended, so paid actions are paused/);
    cleanup();
    show({ state: "LAPSED", graceEndsAtUtc: null, endsAtUtc: null });
    expect(banner()!.textContent).toMatch(/no longer active/);
    cleanup();
    show({ state: "CANCELLING", graceEndsAtUtc: null, endsAtUtc: "2026-12-01T00:00:00.000Z" });
    expect(banner()!.textContent).toMatch(/was cancelled and ends on .*2026/);
    expect(banner()!.textContent).not.toMatch(/renews/i);
  });
});

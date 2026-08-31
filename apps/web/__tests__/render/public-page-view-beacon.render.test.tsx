/**
 * The public page-view beacon, rendered.
 *
 * The source-level suite (`__tests__/public-page-view-beacon.test.ts`) pins the
 * allowlist and the sanitizer. This one runs the component and asserts what
 * actually leaves the browser, because the two failures this fix addresses were
 * both invisible to a source read:
 *
 *   - the emitted name was rejected by the API with a 422, and
 *   - under `reactStrictMode` the claim/cancel/skip sequence meant a beacon
 *     that reads as "fires once" fired NEVER in development.
 *
 * CONSENT IS NOT FAKED HERE. The real `lib/consent` module is driven through
 * its canonical writer and the real `trackEvent` runs; only `apiFetch` — the
 * network boundary — is replaced, so the consent gate under test is the one
 * that ships.
 */

import React from "react";
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSENT_VERSION, saveConsentState } from "../../lib/consent";

let pathname = "/pricing";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

const apiFetch = vi.fn(
  async (_path: string, _init?: { body?: string }) => ({}) as unknown,
);
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, init?: { body?: string }) => apiFetch(path, init),
}));
vi.mock("../../lib/sentry", () => ({ initSentry: () => {} }));

import PublicPageView from "../../components/analytics/PublicPageView";

function setConsent(analytics: boolean): void {
  saveConsentState({
    necessary: true,
    preferences: false,
    analytics,
    marketing: false,
    consentVersion: CONSENT_VERSION,
  });
}

/** The `/v1/analytics/track` calls made so far, decoded. */
function trackCalls(): Array<Record<string, unknown>> {
  return apiFetch.mock.calls
    .filter((call) => call[0] === "/v1/analytics/track")
    .map((call) => JSON.parse(call[1]?.body ?? "{}") as Record<string, unknown>);
}

async function settle(): Promise<void> {
  // The beacon dynamically imports the analytics module before sending.
  await vi.waitFor(() => {
    expect(apiFetch.mock.calls.length >= 0).toBe(true);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  apiFetch.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pathname = "/pricing";
});

afterEach(() => {
  cleanup();
});

describe("consent decides whether anything is sent", () => {
  it("sends nothing when consent has never been recorded", async () => {
    render(<PublicPageView />);
    await settle();
    expect(trackCalls()).toHaveLength(0);
  });

  it("sends nothing on necessary-only", async () => {
    setConsent(false);
    render(<PublicPageView />);
    await settle();
    expect(trackCalls()).toHaveLength(0);
  });

  it("sends one page_view once analytics consent is granted", async () => {
    setConsent(true);
    render(<PublicPageView />);
    await settle();

    const calls = trackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.eventType).toBe("page_view");
    expect(calls[0]!.path).toBe("/pricing");
  });

  it("stops sending after consent is revoked", async () => {
    setConsent(true);
    const view = render(<PublicPageView />);
    await settle();
    expect(trackCalls()).toHaveLength(1);

    setConsent(false);
    apiFetch.mockClear();

    pathname = "/platform";
    view.rerender(<PublicPageView />);
    await settle();
    expect(trackCalls()).toHaveLength(0);
  });

  it("resumes when consent is restored", async () => {
    setConsent(false);
    const view = render(<PublicPageView />);
    await settle();
    expect(trackCalls()).toHaveLength(0);

    setConsent(true);
    pathname = "/trust";
    view.rerender(<PublicPageView />);
    await settle();

    const calls = trackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/trust");
  });
});

describe("one page view per logical navigation", () => {
  it("emits exactly once under StrictMode's mount/cleanup/remount", async () => {
    setConsent(true);
    render(
      <React.StrictMode>
        <PublicPageView />
      </React.StrictMode>,
    );
    await settle();

    // Before the claim/release fix this was 0, not 2: the first pass claimed
    // the path then cancelled, and the remount skipped its own claim.
    expect(trackCalls()).toHaveLength(1);
  });

  it("does not re-emit when the same path re-renders", async () => {
    setConsent(true);
    const view = render(<PublicPageView />);
    await settle();
    expect(trackCalls()).toHaveLength(1);

    view.rerender(<PublicPageView />);
    await settle();
    expect(trackCalls()).toHaveLength(1);
  });

  it("emits once per client-side navigation", async () => {
    setConsent(true);
    const view = render(<PublicPageView />);
    await settle();

    pathname = "/platform";
    view.rerender(<PublicPageView />);
    await settle();

    pathname = "/faq";
    view.rerender(<PublicPageView />);
    await settle();

    expect(trackCalls().map((c) => c.path)).toEqual([
      "/pricing",
      "/platform",
      "/faq",
    ]);
  });
});

describe("what the beacon refuses to send", () => {
  it("emits nothing for sensitive token routes", async () => {
    setConsent(true);
    for (const path of ["/verify/tok.en.sig", "/share/abc", "/auth/callback"]) {
      cleanup();
      apiFetch.mockClear();
      pathname = path;
      render(<PublicPageView />);
      await settle();
      expect(trackCalls(), `${path} must not be sent`).toHaveLength(0);
    }
  });

  it("emits nothing for authenticated app surfaces", async () => {
    setConsent(true);
    for (const path of ["/home", "/evidence/abc", "/settings", "/admin"]) {
      cleanup();
      apiFetch.mockClear();
      pathname = path;
      render(<PublicPageView />);
      await settle();
      expect(trackCalls(), `${path} must not be sent`).toHaveLength(0);
    }
  });

  it("forwards only the sanitized path — never a query string or hash", async () => {
    setConsent(true);
    pathname = "/pricing?ref=secret-token&utm=x#section";
    render(<PublicPageView />);
    await settle();

    const calls = trackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/pricing");
    expect(JSON.stringify(calls[0])).not.toContain("secret-token");
  });
});

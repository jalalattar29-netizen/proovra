/**
 * AUD-28 (2026-10-20) — AN ENDED SHARE LINK OR A RATE LIMIT IS NOT A FAILURE.
 *
 * Characterization (before): the API's 410 (a revoked, expired or used-up
 * share link) and 429 (rate limit) rendered "Verification Failed" with a
 * "Try Again" button, and each one was reported to Sentry. They are expected
 * answers: the page now states them in plain words, and nothing is reported.
 * A real failure (500) still reads as one, and is still reported.
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN = "pvs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let failure: { statusCode: number; code?: string; message: string } = { statusCode: 410, message: "gone" };
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: TOKEN }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/verify/${TOKEN}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../app/providers", () => ({
  useLocale: () => ({ locale: "en", setLocale: () => undefined, t: (k: string) => k }),
  useOptionalLocale: () => "en",
}));
vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(async () => {
    throw Object.assign(new Error(failure.message), failure);
  }),
}));
vi.mock("../../lib/sentry", () => sentry);

// Static imports: the page's module graph loads during collection, which has
// no per-test timeout. Imported inside the first test, its cold load counted
// against that test's 5s budget and overran it when the whole render suite
// shares the transform server; the timed-out test's late render then leaked
// into the next test ("multiple elements").
import VerifyPage from "../../app/verify/[token]/page";
import { ToastProvider } from "../../components/ui";

async function mountPage() {
  render(
    <ToastProvider>
      <VerifyPage />
    </ToastProvider>,
  );
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("Public Verify — ended links and rate limits (AUD-28)", () => {
  afterEach(() => {
    cleanup();
    sentry.captureException.mockClear();
  });

  it("410: the link is no longer active — neutral, no Sentry event", async () => {
    failure = { statusCode: 410, code: "VERIFICATION_LINK_REVOKED", message: "This verification link has been revoked." };
    await mountPage();
    const notice = await screen.findByTestId("verify-link-notice");
    expect(notice.getAttribute("data-notice")).toBe("LINK_ENDED");
    expect(notice.textContent).toContain("no longer active");
    expect(screen.queryByText("Verification Failed")).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("429: too many checks — neutral, no Sentry event", async () => {
    failure = { statusCode: 429, message: "Too Many Requests" };
    await mountPage();
    expect((await screen.findByTestId("verify-link-notice")).getAttribute("data-notice")).toBe("RATE_LIMITED");
    expect(screen.queryByText("Verification Failed")).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("a real failure still reads as one and is still reported", async () => {
    failure = { statusCode: 500, message: "boom" };
    await mountPage();
    expect(await screen.findByText("Verification Failed")).toBeTruthy();
    expect(sentry.captureException).toHaveBeenCalled();
  });
});

/**
 * F-11 (2026-11-13) — AN UNKNOWN VERIFICATION REFERENCE IS NOT A FAILURE.
 *
 * Characterization (before): the API's ordinary 404 ("Evidence not found",
 * the same answer for every reference it will not show) rendered "Verification
 * Failed" with a "Try Again" button and was reported to Sentry. It now reads as
 * a neutral not-found notice and nothing is reported; a real failure (500)
 * still reads as one. Driven through the REAL apiFetch over a stubbed fetch
 * with the API's actual flat body.
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN = "pvr_AAAAAAAAAAAAAAAAAAAAAAAAAAA";
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
vi.mock("../../lib/sentry", () => sentry);

// Static imports (see verify-link-notice.render.test.tsx for why).
import VerifyPage from "../../app/verify/[token]/page";
import { ToastProvider } from "../../components/ui";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

async function mountPage() {
  render(
    <ToastProvider>
      <VerifyPage />
    </ToastProvider>,
  );
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("Public Verify — an unknown reference (F-11)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sentry.captureException.mockClear();
  });

  it("404: a neutral not-found notice, no 'Verification Failed', no Sentry event", async () => {
    respond(404, { message: "Evidence not found" });
    await mountPage();
    const notice = await screen.findByTestId("verify-link-notice");
    expect(notice.getAttribute("data-notice")).toBe("NOT_FOUND");
    expect(notice.textContent).toContain("No verification record found for this link");
    expect(screen.queryByText("Verification Failed")).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("a real failure still reads as one and is still reported", async () => {
    respond(500, { message: "boom" });
    await mountPage();
    expect(await screen.findByText("Verification Failed")).toBeTruthy();
    expect(sentry.captureException).toHaveBeenCalled();
  });
});

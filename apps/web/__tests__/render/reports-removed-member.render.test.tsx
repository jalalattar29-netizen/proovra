/**
 * A2-23 (free-user audit round 3) — a removed, expired or suspended member who
 * opens Reports gets the access-denied state, not a generic fault.
 *
 * The workspace route answers the anti-enumeration 404; the page's bootstrap
 * fallback (the user-scoped list) is refused too. Before the fix the page fell
 * through to "Unable to load artifacts." Driven through the REAL apiFetch over
 * a stubbed fetch (apiFetch raises ApiError only for a nested error.code).
 */
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reports",
  useParams: () => ({}),
}));
vi.mock("../../app/providers", () => ({ useOptionalLocale: () => "en" }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePlatformContext: () => ({ state: { name: "READY" } }),
  useWorkspaceId: () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("../../components/contextual-help/ContextualHelp", () => ({ ContextualHelp: () => null }));

import { ReportsIndex } from "../../components/reports-experience/ReportsIndex";

const calls: string[] = [];
function serve(status: number, body: unknown) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("A2-23: Reports for a caller the workspace refuses", () => {
  it("a 404 on both the workspace list and the user-scoped fallback renders the access-denied state", async () => {
    serve(404, { error: { code: "not_found" } });
    const view = render(<ReportsIndex />);
    await waitFor(() =>
      expect(view.container.querySelector("[data-reports-auth-error='permission_denied']")).toBeTruthy(),
    );
    expect(view.container.textContent).not.toContain("Unable to load artifacts");
    // Both doors were asked: the workspace list, then the user-scoped fallback.
    expect(calls.some((u) => u.includes("/v1/reports/artifacts"))).toBe(true);
    expect(calls.some((u) => u.includes("/v1/reports?teamId="))).toBe(true);
  });

  it("control: a server fault stays the generic unavailable state", async () => {
    serve(500, { error: { code: "internal_error" } });
    const view = render(<ReportsIndex />);
    await waitFor(() => expect(view.container.textContent).toMatch(/unable to load|something went wrong|try again/i));
    expect(view.container.querySelector("[data-reports-auth-error]")).toBeNull();
  });
});

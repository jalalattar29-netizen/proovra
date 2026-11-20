/**
 * M738 — an organization report CSV that hit the row cap says so ONLY through
 * the `x-report-truncated` / `x-report-row-cap` response headers (the CSV body
 * keeps its shape for spreadsheet / SIEM consumers). The reports page used to
 * promise "the file says when older events were left out" while no code read
 * those headers. Now the download path reads them and tells the user, and the
 * card copy promises nothing the file does not do.
 *
 * Real `apiFetch` over a stubbed network.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "org-1" }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui-legacy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useToast: () => ({ addToast: () => {} }),
}));

import OrganizationAdminReportsPage from "../../app/(app)/organizations/[id]/admin/reports/page";

let csvHeaders: Record<string, string> = {};
const fetchMock = vi.fn();

beforeEach(() => {
  csvHeaders = {};
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (/\/v1\/orgs\/org-1\/reports\//.test(u)) {
      return new Response("occurredAtUtc,action\n", {
        status: 200,
        headers: { "content-type": "text/csv; charset=utf-8", ...csvHeaders },
      });
    }
    if (/\/v1\/orgs\/org-1$/.test(u)) {
      return new Response(JSON.stringify({ organizationId: "org-1", callerRole: "ORG_AUDITOR" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no object URLs; the page only hands the blob to an anchor.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:report";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("M738 — report truncation reaches the user", () => {
  it("a capped download tells the user that older rows were left out, with the cap", async () => {
    csvHeaders = { "x-report-truncated": "true", "x-report-row-cap": "5000" };
    render(<OrganizationAdminReportsPage />);
    fireEvent.click(await screen.findByTestId("report-download-download-audit"));

    const notice = await screen.findByTestId("report-truncated-download-audit");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toMatch(/most recent 5,000 rows/);
    expect(notice.textContent).toMatch(/older .* left out/i);
    // Only the report that was capped carries the notice.
    expect(screen.queryByTestId("report-truncated-audit")).toBeNull();
  });

  it("a complete download (or an API that hides the headers) shows no truncation notice", async () => {
    render(<OrganizationAdminReportsPage />);
    fireEvent.click(await screen.findByTestId("report-download-download-audit"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => /download-audit\.csv$/.test(String(u)))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId("report-download-download-audit").hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByTestId("report-truncated-download-audit")).toBeNull();
  });

  it("the card copy no longer claims the file itself says when rows were left out", async () => {
    render(<OrganizationAdminReportsPage />);
    const card = await screen.findByTestId("report-card-download-audit");
    expect(card.textContent).not.toMatch(/the file says/i);
    expect(card.textContent).toMatch(/most recent 5,000 rows/);
  });
});

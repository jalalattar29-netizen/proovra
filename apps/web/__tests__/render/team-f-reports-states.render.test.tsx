/**
 * Team remediation stage F — /reports pagination and error states (T-146,
 * T-147; audit JRN-08 j, k). The REAL apiFetch over a stubbed `fetch`.
 *
 *   - T-146: with an empty workspace list and a two-page user-scoped list,
 *     "Next" handed the user-scoped cursor to /v1/reports/artifacts, whose
 *     empty answer fell back to the user-scoped FIRST page: page 2 repeated
 *     page 1.
 *   - T-147: a summary 500 and a failed user-scoped fallback were swallowed.
 */
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const EMPTY_ARTIFACTS = {
  generatedAt: "2026-11-24T00:00:00.000Z",
  workspace: { id: "11111111-1111-4111-8111-111111111111", role: "OWNER" },
  sections: {
    summary: { status: "unavailable", data: null },
    artifacts: { status: "ok", items: [], nextCursor: null, total: 0 },
  },
};
function userRow(n: number) {
  return {
    evidenceId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    teamId: null, title: `User report ${n}`, displayFileName: null, originalFileName: null, mimeType: null,
    type: "PHOTO", status: "REPORTED", caseId: null, caseTitle: null, intakeCustomerId: null,
    createdAt: "2026-11-20T00:00:00.000Z", reportLifecycle: "READY", packageLifecycle: "READY",
    report: { available: true, version: 1, generatedAtUtc: "2026-11-20T00:00:00.000Z" },
    package: { available: true, version: 1, generatedAtUtc: "2026-11-20T00:00:00.000Z" },
  };
}

let calls: string[];
let summaryAnswer: { status: number; body: unknown };
let userAnswer: (url: string) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  summaryAnswer = { status: 200, body: EMPTY_ARTIFACTS };
  userAnswer = (url) =>
    url.includes("cursor=page2")
      ? { status: 200, body: { items: [userRow(3)], nextCursor: null } }
      : { status: 200, body: { items: [userRow(1), userRow(2)], nextCursor: "page2" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      let out: { status: number; body: unknown } = { status: 200, body: EMPTY_ARTIFACTS };
      if (url.includes("/v1/reports/artifacts") && url.includes("limit=1")) out = summaryAnswer;
      else if (url.includes("/v1/reports?")) out = userAnswer(url);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

describe("/reports — stage F", () => {
  it("T-146: page 2 of the user-scoped fallback is that list's page 2, never page 1 again", async () => {
    const view = render(<ReportsIndex />);
    await waitFor(() => expect(view.container.textContent).toContain("User report 1"));
    const next = Array.from(view.container.querySelectorAll("button")).find((b) => /next/i.test(b.textContent ?? "")) as HTMLButtonElement;
    expect(next).toBeTruthy();
    await act(async () => {
      fireEvent.click(next);
    });
    await flush();
    await waitFor(() => expect(view.container.textContent).toContain("User report 3"));
    expect(view.container.textContent).not.toContain("User report 1");
    // The user-scoped cursor went back to the user-scoped list.
    expect(calls.some((u) => u.includes("/v1/reports?") && u.includes("cursor=page2"))).toBe(true);
    expect(calls.some((u) => u.includes("/v1/reports/artifacts") && u.includes("cursor=page2"))).toBe(false);
  });

  it("T-147: a summary 500 is an alert with Retry, and Retry re-reads it", async () => {
    summaryAnswer = { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } };
    userAnswer = () => ({ status: 200, body: { items: [], nextCursor: null } });
    const view = render(<ReportsIndex />);
    await waitFor(() => expect(view.container.querySelector("[data-reports-summary-failed='true']")).not.toBeNull());
    expect(view.container.querySelector("[data-reports-summary-failed='true']")?.getAttribute("role")).toBe("alert");
    const summaryCalls = () => calls.filter((u) => u.includes("/v1/reports/artifacts") && u.includes("limit=1")).length;
    const before = summaryCalls();
    await act(async () => {
      (view.container.querySelector("[data-reports-summary-retry]") as HTMLElement).click();
    });
    await flush();
    expect(summaryCalls()).toBe(before + 1);
  });

  it("T-147: a failed user-scoped fallback read is said, not shown as an empty list", async () => {
    userAnswer = () => ({ status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } });
    const view = render(<ReportsIndex />);
    await waitFor(() => expect(view.container.querySelector("[data-reports-fallback-failed]")).not.toBeNull());
    expect(view.container.querySelector("[data-reports-fallback-failed]")?.getAttribute("role")).toBe("alert");
  });
});

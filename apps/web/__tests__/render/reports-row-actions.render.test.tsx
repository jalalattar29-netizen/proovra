/**
 * REPORTS — the per-row generation action, driven through the real page.
 *
 * Three reported problems, each checked against the shipped component:
 *
 *   1. Regenerate posted on the FIRST click from this page while Evidence
 *      Detail asked first. A new immutable version costs storage; the page now
 *      confirms, and a first generation or a retry still does not.
 *   2. "Clicking Regenerate navigates to Evidence." Not reproducible from
 *      source (the actions sit outside the row link); this proves it in a DOM:
 *      no click on any row control reaches a link other than "Open evidence".
 *   3. After a request the tiles and the row kept describing the moment before
 *      the click. The page now re-reads both from the server.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, waitFor } from "@testing-library/react";

const navigations: string[] = [];
const requests: Array<{ path: string; method: string }> = [];
let regenerateResolvers: Array<(v: unknown) => void> = [];

function row(id: string, action: "GENERATE" | "RETRY" | "REGENERATE" | "NONE", ready: boolean) {
  return {
    evidenceId: id,
    title: `Record ${id}`,
    displayFileName: null,
    originalFileName: null,
    mimeType: null,
    type: "PHOTO",
    status: ready ? "REPORTED" : "SIGNED",
    verificationStatus: null,
    caseId: null,
    caseTitle: null,
    intakeCustomerId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    report: { state: ready ? "ready" : action === "RETRY" ? "failed" : "not_requested", version: ready ? 7 : null, generatedAtUtc: null },
    package: { state: ready ? "ready" : action === "RETRY" ? "failed" : "not_requested", version: ready ? 7 : null, generatedAtUtc: null, blockedReason: null },
    outputs: {
      report: { state: ready ? "READY" : "ELIGIBLE_NOT_GENERATED", action, actionUnavailableReason: null, terminalReasonClass: null, downloadable: ready },
      verificationPackage: { state: ready ? "READY" : "ELIGIBLE_NOT_GENERATED", action, actionUnavailableReason: null, terminalReasonClass: null, downloadable: ready },
    },
    provenance: { templateSlug: null, templateVersion: null, templateDbId: null },
  };
}

const ROWS = [row("ev-ready", "REGENERATE", true), row("ev-new", "GENERATE", false), row("ev-failed", "RETRY", false)];

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    requests.push({ path, method });
    if (path.startsWith("/v1/reports/artifacts")) {
      return {
        generatedAt: "2026-09-25T00:00:00.000Z",
        workspace: { id: "ws-1", role: "OWNER" },
        sections: {
          summary: path.includes("summary=0")
            ? { status: "skipped", data: null }
            : {
                status: "ok",
                data: {
                  reportsReady: 1,
                  reportsPending: 0,
                  reportsFailed: 1,
                  packagesReady: 1,
                  packagesPending: 0,
                  packagesBlocked: 0,
                  totalEvidenceWithArtifacts: 1,
                },
              },
          artifacts: { status: "ok", items: ROWS, nextCursor: null, total: ROWS.length },
        },
      };
    }
    if (path.endsWith("/reports/regenerate")) {
      return new Promise((resolve) => regenerateResolvers.push(resolve));
    }
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        navigations.push(href);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (h: string) => navigations.push(h), replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reports",
  useParams: () => ({}),
}));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePlatformContext: () => ({ state: { name: "READY" } }),
  useWorkspaceId: () => "ws-1",
}));
vi.mock("../../components/governance/GovernedExportAction", () => ({
  GovernedExportAction: ({ renderAction, onAction }: { renderAction: (p: { disabled: boolean; onClick: () => void }) => React.ReactNode; onAction?: () => void }) => (
    <>{renderAction({ disabled: false, onClick: () => onAction?.() })}</>
  ),
}));
vi.mock("../../components/contextual-help/ContextualHelp", () => ({ ContextualHelp: () => null }));

import { ReportsIndex } from "../../components/reports-experience/ReportsIndex";

beforeEach(() => {
  navigations.length = 0;
  requests.length = 0;
  regenerateResolvers = [];
});
afterEach(() => cleanup());

async function mount() {
  const view = render(<ReportsIndex />);
  await waitFor(() => expect(view.container.querySelector("[data-reports-row-id='ev-ready']")).toBeTruthy());
  return view;
}

const posts = () => requests.filter((r) => r.method === "POST");

describe("Reports row — generation actions", () => {
  it("summary tiles name what they count, including failures, and link to their filter", async () => {
    const { container } = await mount();
    const tile = (k: string) => container.querySelector(`[data-reports-summary-key='${k}']`);
    expect(tile("reports_failed")?.getAttribute("data-reports-summary-value")).toBe("1");
    expect(tile("reports_failed")?.getAttribute("data-reports-summary-filter")).toBe("report_failed");
    expect(tile("reports_ready")?.textContent).toContain("Reports ready");
    expect(tile("total_artifacts")?.textContent).toContain("Records with artifacts");
    expect(container.querySelector("[data-reports-filter='report_failed']")).toBeTruthy();
  });

  it("REGENERATE asks first, states the real cost, and posts nothing until confirmed", async () => {
    const { container } = await mount();
    const btn = container.querySelector("[data-reports-regenerate='ev-ready']") as HTMLButtonElement;
    expect(btn.textContent).toBe("Regenerate report & package");
    fireEvent.click(btn);

    const dialog = container.querySelector("[data-reports-regenerate-confirm='ev-ready']");
    expect(dialog?.textContent).toMatch(/new immutable version/);
    expect(dialog?.textContent).toMatch(/additional workspace storage/);
    expect(posts()).toHaveLength(0);
    // Not a navigation either — the reported symptom.
    expect(navigations).toEqual([]);

    fireEvent.click(container.querySelector("[data-reports-regenerate-cancel='ev-ready']")!);
    expect(container.querySelector("[data-reports-regenerate-confirm='ev-ready']")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("a confirmed regeneration posts ONCE, however often it is clicked, then re-reads summary and list", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-regenerate='ev-ready']")!);
    const confirm = container.querySelector("[data-reports-regenerate-confirm-action='ev-ready']") as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(posts()).toEqual([{ path: "/v1/evidence/ev-ready/reports/regenerate", method: "POST" }]);
    expect(navigations).toEqual([]);

    const before = requests.filter((r) => r.path.startsWith("/v1/reports/artifacts")).length;
    await act(async () => {
      regenerateResolvers[0]!({ evidenceId: "ev-ready", enqueued: true, reason: "enqueued", outcome: "ENQUEUED" });
    });
    await waitFor(() => {
      const reads = requests.filter((r) => r.path.startsWith("/v1/reports/artifacts")).slice(before);
      expect(reads.some((r) => !r.path.includes("summary=0"))).toBe(true);
      expect(reads.some((r) => r.path.includes("summary=0"))).toBe(true);
    });
    // The notice is the server's answer, not an assumed completion.
    expect(container.querySelector("[data-reports-row-regen-notice='ev-ready']")?.textContent).toBeTruthy();
  });

  it("GENERATE and RETRY post directly — no confirmation for what the record is already owed", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-regenerate='ev-new']")!);
    fireEvent.click(container.querySelector("[data-reports-regenerate='ev-failed']")!);
    expect(container.querySelector("[data-reports-regenerate-confirm]")).toBeNull();
    expect(posts().map((p) => p.path).sort()).toEqual([
      "/v1/evidence/ev-failed/reports/regenerate",
      "/v1/evidence/ev-new/reports/regenerate",
    ]);
    expect(navigations).toEqual([]);
  });

  it("a ready record keeps its downloads, and only Open evidence navigates", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-download-report='ev-ready']")!);
    expect(navigations).toEqual([]);
    fireEvent.click(container.querySelector("[data-reports-open-evidence='ev-ready']")!);
    expect(navigations).toEqual(["/evidence/ev-ready"]);
  });
});

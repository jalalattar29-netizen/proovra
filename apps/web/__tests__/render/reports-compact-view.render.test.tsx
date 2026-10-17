/**
 * REPORTS & ARTIFACTS — the compact operations view (2026-10-16), driven
 * through the real page.
 *
 *   1. At most SIX metrics; each is a button that applies exactly its filter,
 *      and the list it opens has the metric's count.
 *   2. Four visible status choices + an Advanced filters disclosure + sort —
 *      not a wall of chips; dimensions compose into one request.
 *   3. Deep links: a legacy `?lifecycle=` lands on its dimension, an unknown
 *      value falls back, the URL is rewritten in canonical form.
 *   4. Empty states: first use, filtered-to-nothing (with Clear filters), and
 *      records with no current artifact.
 *   5. A current success with a superseded failure reads Ready, never failed;
 *      danger is only a genuine failure this reader can act on.
 *   6. Role: a viewer gets the reason, not a dead button.
 *   7. EN / DE / AR (RTL), no raw codes, keyboard and screen-reader semantics,
 *      and one responsive DOM.
 */

import React from "react";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

const requests: string[] = [];
const replaced: string[] = [];
const navigations: string[] = [];
let search = "";
let locale = "en";
let listFor: (path: string) => { items: unknown[]; total: number } = () => ({ items: [], total: 0 });
let summary: Record<string, number> | null = null;

type Out = { state: string; action: string; actionUnavailableReason: string | null; operation?: string | null };
function row(
  id: string,
  o: {
    status: string;
    reason: string;
    report: string;
    pkg: string;
    reportOut: Out;
    pkgOut: Out;
    verification?: string | null;
  },
) {
  return {
    evidenceId: id,
    teamId: "ws-1",
    title: `Record ${id}`,
    displayFileName: null,
    originalFileName: null,
    mimeType: "image/jpeg",
    type: "PHOTO",
    status: "REPORTED",
    verificationStatus: o.verification ?? "RECORDED_INTEGRITY_VERIFIED",
    caseId: null,
    caseTitle: null,
    intakeCustomerId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    report: { state: o.report, updateFailed: false, version: o.report === "ready" ? 2 : null, generatedAtUtc: o.report === "ready" ? "2026-10-02T00:00:00.000Z" : null },
    package: { state: o.pkg, version: o.pkg === "ready" ? 2 : null, generatedAtUtc: null, blockedReason: null },
    outputs: {
      report: { terminalReasonClass: null, terminalReasonCode: null, downloadable: o.report === "ready", operation: null, ...o.reportOut },
      verificationPackage: { terminalReasonClass: null, terminalReasonCode: null, downloadable: o.pkg === "ready", operation: null, latestAvailableVersion: null, ...o.pkgOut },
      newVersion: { action: "NONE", reason: "NOT_REQUIRED" },
      pollIntervalMs: null,
    },
    deliverable: { status: o.status, reason: o.reason },
  };
}
const NOT_REQUIRED: Out = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED" };

/** A record whose earlier attempt failed, superseded by its newer report. */
const SUPERSEDED = row("ev-superseded", { status: "READY", reason: "COMPLETE", report: "ready", pkg: "ready", reportOut: NOT_REQUIRED, pkgOut: NOT_REQUIRED });
const FAILED = row("ev-failed", {
  status: "NEEDS_ATTENTION",
  reason: "REPORT_FAILED",
  report: "failed",
  pkg: "failed",
  reportOut: { state: "RETRYABLE_FAILURE", action: "RETRY", actionUnavailableReason: null, operation: "RETRY_REQUEST" },
  pkgOut: { state: "RETRYABLE_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
});
const FAILED_FOR_VIEWER = row("ev-failed-viewer", {
  status: "NEEDS_ATTENTION",
  reason: "REPORT_FAILED",
  report: "failed",
  pkg: "failed",
  reportOut: { state: "RETRYABLE_FAILURE", action: "NONE", actionUnavailableReason: "PERMISSION_DENIED" },
  pkgOut: { state: "RETRYABLE_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
});
const QUEUED = row("ev-queued", {
  status: "IN_PROGRESS",
  reason: "GENERATING",
  report: "pending",
  pkg: "pending",
  reportOut: { state: "QUEUED", action: "NONE", actionUnavailableReason: "IN_PROGRESS" },
  pkgOut: { state: "QUEUED", action: "NONE", actionUnavailableReason: "IN_PROGRESS" },
});
const NOT_INCLUDED = row("ev-free", {
  status: "NOT_AVAILABLE",
  reason: "NOT_INCLUDED",
  report: "unavailable",
  pkg: "unavailable",
  reportOut: { state: "NOT_INCLUDED", action: "NONE", actionUnavailableReason: "NOT_INCLUDED" },
  pkgOut: { state: "NOT_INCLUDED", action: "NONE", actionUnavailableReason: "NOT_INCLUDED" },
  verification: null,
});

const FULL_SUMMARY = {
  reportsReady: 1,
  reportsPending: 1,
  reportsFailed: 1,
  reportsUpdateFailed: 0,
  reportsBlocked: 0,
  packagesReady: 1,
  packagesPending: 1,
  packagesBlocked: 0,
  packagesFailed: 1,
  reportsNotIssued: 0,
  reportsAwaitingFirstIssuance: 0,
  packagesMissingForLatestReport: 0,
  outputsEntitlementUnavailable: 0,
  totalEvidenceWithArtifacts: 1,
  totalArtifactVersions: 2,
  recordsReady: 1,
  recordsInProgress: 1,
  recordsNeedingAttention: 1,
  recordsIncomplete: 0,
  recordsNotAvailable: 0,
  recordsTotal: 3,
};

/** A server whose status filter returns exactly the rows of that status. */
const statusServer = (rows: Array<ReturnType<typeof row>>) => (path: string) => {
  const status = new URLSearchParams(path.split("?")[1]).get("status");
  const items = status ? rows.filter((r) => r.deliverable.status === status.toUpperCase()) : rows;
  return { items, total: items.length };
};

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    requests.push(path);
    if (path.startsWith("/v1/reports/artifacts")) {
      const isSummary = !path.includes("summary=0");
      const list = listFor(path);
      return {
        generatedAt: "2026-10-16T00:00:00.000Z",
        workspace: { id: "ws-1", role: "OWNER" },
        sections: {
          summary: isSummary && summary ? { status: "ok", data: summary } : { status: isSummary ? "unavailable" : "skipped", data: null },
          artifacts: { status: "ok", items: list.items, nextCursor: null, total: list.total },
        },
      };
    }
    if (path.startsWith("/v1/reports?")) return { items: [], nextCursor: null };
    if (init?.method === "POST") return { outcome: "ENQUEUED" };
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
  useRouter: () => ({ push: (h: string) => navigations.push(h), replace: (h: string) => replaced.push(h), back: () => {} }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/reports",
  useParams: () => ({}),
}));
vi.mock("../../app/providers", () => ({ useOptionalLocale: () => locale }));
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
  requests.length = 0;
  replaced.length = 0;
  navigations.length = 0;
  search = "";
  locale = "en";
  summary = FULL_SUMMARY;
  listFor = statusServer([SUPERSEDED, FAILED, QUEUED]);
});
afterEach(() => cleanup());

async function mount(wrapper?: (n: React.ReactNode) => React.ReactNode) {
  const view = render(<>{wrapper ? wrapper(<ReportsIndex />) : <ReportsIndex />}</>);
  await waitFor(() => expect(view.container.querySelector("[data-reports-list]")).toBeTruthy());
  await waitFor(() => expect(view.container.querySelector("[data-reports-summary-grid]")).toBeTruthy());
  return view;
}
const listRequests = () => requests.filter((r) => r.startsWith("/v1/reports/artifacts") && r.includes("summary=0"));
const lastList = () => new URLSearchParams(listRequests().at(-1)!.split("?")[1]);
/** Visible words, without the parts a screen shows only as data. */
const words = (el: Element) => el.textContent ?? "";
/** Choose an option in a shared AppListbox (the app's canonical select). */
async function pick(container: HTMLElement, hook: string, label: string) {
  const trigger = container.querySelector(`${hook} [role='combobox']`) as HTMLButtonElement;
  expect(trigger, `${hook} must be a shared AppListbox`).toBeTruthy();
  fireEvent.click(trigger);
  const option = await waitFor(() => {
    const o = Array.from(document.querySelectorAll("[role='option']")).find((el) => el.textContent?.trim() === label);
    expect(o, `option "${label}"`).toBeTruthy();
    return o as HTMLElement;
  });
  fireEvent.click(option);
}

describe("Reports — compact summary", () => {
  it("shows EXACTLY four metrics in order, in their canonical semantic tones, each with a definition, nothing counted twice", async () => {
    const { container } = await mount();
    const tiles = container.querySelectorAll("[data-reports-summary-key]");
    expect(tiles.length).toBe(4);
    expect(Array.from(tiles).map((t) => [t.getAttribute("data-reports-summary-key"), t.getAttribute("data-app-metric-tone"), t.querySelector(".app-metric-card__label")?.textContent])).toEqual([
      ["records", "info", "All records"],
      ["in_progress", "accent", "In progress"],
      ["needs_attention", "warning", "Needs attention"],
      ["incomplete", "danger", "Incomplete"],
    ]);
    // The redundant cards are gone.
    expect(container.querySelector("[data-reports-summary-key='reports_ready']")).toBeNull();
    expect(container.querySelector("[data-reports-summary-key='packages_ready']")).toBeNull();
    const value = (k: string) => Number(container.querySelector(`[data-reports-summary-key='${k}']`)!.getAttribute("data-reports-summary-value"));
    // The record statuses shown add up to no more than the total.
    expect(value("in_progress") + value("needs_attention") + value("incomplete")).toBeLessThanOrEqual(value("records"));
    for (const t of Array.from(tiles)) {
      expect(t.tagName).toBe("BUTTON");
      const describedBy = t.getAttribute("aria-describedby")!;
      expect(container.querySelector(`[id='${describedBy}']`)?.textContent?.length).toBeGreaterThan(10);
      expect(t.getAttribute("aria-label")).toMatch(/Show these records/);
    }
    // The remaining counters are ONE disclosure, closed by default.
    const details = container.querySelector("details[data-reports-breakdown]") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it("a metric applies exactly its filter, and the list it opens has the metric's count", async () => {
    const { container } = await mount();
    const tile = container.querySelector("[data-reports-summary-key='needs_attention']") as HTMLButtonElement;
    expect(tile.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(tile);
    await waitFor(() => expect(lastList().get("status")).toBe("needs_attention"));
    expect(lastList().get("lifecycle")).toBe("all");
    await waitFor(() =>
      expect(container.querySelector("[data-reports-list]")?.textContent).toContain(
        `Evidence records · ${tile.getAttribute("data-reports-summary-value")}`,
      ),
    );
    expect(container.querySelectorAll("[data-reports-row-id]").length).toBe(Number(tile.getAttribute("data-reports-summary-value")));
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    // The URL says the same thing.
    await waitFor(() => expect(replaced.at(-1)).toBe("/reports?status=needs_attention"));
  });
});

describe("Reports — filters", () => {
  it("four visible status choices, an Advanced filters disclosure and a sort — not a chip wall", async () => {
    const { container } = await mount();
    const group = container.querySelector("[data-reports-status-selector]")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.querySelectorAll("button").length).toBe(4);
    expect(Array.from(group.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "All",
      "Ready",
      "In progress",
      "Needs attention",
    ]);
    const toggle = container.querySelector("[data-reports-advanced-toggle]") as HTMLButtonElement;
    const panel = container.querySelector("[data-reports-advanced-panel]") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    // Sort is the shared AppListbox (combobox + listbox), not a native select.
    expect(container.querySelector("[data-reports-sort] [role='combobox']")?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(container.querySelector("select")).toBeNull();
    // The search is the shared search field.
    expect(container.querySelector(".app-search-field input[data-reports-search-input]")).toBeTruthy();
  });

  it("ONE filter state: a summary card and the status segments always agree", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-summary-key='in_progress']")!);
    await waitFor(() => expect(lastList().get("status")).toBe("in_progress"));
    expect(container.querySelector("[data-reports-status-filter='in_progress']")!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(container.querySelector("[data-reports-status-filter='needs_attention']")!);
    await waitFor(() => expect(lastList().get("status")).toBe("needs_attention"));
    expect(container.querySelector("[data-reports-summary-key='needs_attention']")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-reports-summary-key='in_progress']")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("primary and advanced dimensions compose into ONE request, and each active one can be removed", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-status-filter='needs_attention']")!);
    fireEvent.click(container.querySelector("[data-reports-advanced-toggle]")!);
    await pick(container, "[data-reports-advanced-report]", "Failed");
    await pick(container, "[data-reports-advanced-package]", "Failed");
    await pick(container, "[data-reports-sort]", "Oldest captured first");
    await waitFor(() => {
      const q = lastList();
      expect(q.get("status")).toBe("needs_attention");
      expect(q.get("lifecycle")).toBe("report_failed,package_failed");
      expect(q.get("sort")).toBe("oldest");
    });
    expect(container.querySelector("[data-reports-advanced-count]")?.textContent).toBe("2 active");
    fireEvent.click(container.querySelector("[data-reports-active-filter='report']")!);
    await waitFor(() => expect(lastList().get("lifecycle")).toBe("package_failed"));
  });

  it("a legacy ?lifecycle= deep link lands on its dimension and the URL is rewritten canonically", async () => {
    search = "lifecycle=report_awaiting_issuance";
    const { container } = await mount();
    expect(listRequests()[0]).toContain("lifecycle=report_awaiting_issuance");
    expect(container.querySelector("[data-reports-advanced-panel]")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector("[data-reports-active-filter='report']")?.textContent).toContain("First report not yet issued");
    await waitFor(() => expect(replaced.at(-1)).toBe("/reports?report=report_awaiting_issuance"));
  });

  it("an Operations / bookmark link with stale or invalid values falls back safely", async () => {
    search = "status=FAILED_TERMINAL&report=retry_budget_exhausted&sort=sideways&q=Joint";
    await mount();
    const q = new URLSearchParams(listRequests()[0]!.split("?")[1]);
    expect(q.get("status")).toBeNull();
    expect(q.get("lifecycle")).toBe("all");
    expect(q.get("sort")).toBeNull();
    expect(q.get("search")).toBe("Joint");
    await waitFor(() => expect(replaced.at(-1)).toBe("/reports?q=Joint"));
  });
});

describe("Reports — empty states", () => {
  it("first use: no records at all says so, with the way to start", async () => {
    listFor = () => ({ items: [], total: 0 });
    summary = { ...FULL_SUMMARY, reportsReady: 0, packagesReady: 0, recordsReady: 0, recordsInProgress: 0, recordsNeedingAttention: 0, recordsTotal: 0, totalEvidenceWithArtifacts: 0, totalArtifactVersions: 0 };
    const { container } = await mount();
    await waitFor(() => expect(container.querySelector("[data-reports-empty-kind='no_data']")).toBeTruthy());
    expect(container.textContent).toContain("No reports yet");
    expect(container.querySelector("[data-reports-empty-state-cta]")?.getAttribute("href")).toBe("/evidence");
  });

  it("filtered to nothing: says the FILTERS matched nothing, and Clear filters brings the list back", async () => {
    const { container } = await mount();
    listFor = () => ({ items: [], total: 0 });
    fireEvent.click(container.querySelector("[data-reports-status-filter='in_progress']")!);
    await waitFor(() => expect(container.querySelector("[data-reports-empty-kind='no_match']")).toBeTruthy());
    expect(container.textContent).toContain("No records match these filters");
    expect(container.textContent).not.toContain("No reports yet");
    listFor = statusServer([SUPERSEDED, FAILED, QUEUED]);
    fireEvent.click(container.querySelector("[data-reports-empty-clear]")!);
    await waitFor(() => expect(container.querySelectorAll("[data-reports-row-id]").length).toBe(3));
    expect(lastList().get("status")).toBeNull();
  });

  it("records without any current artifact explain themselves instead of reading empty or failed", async () => {
    listFor = () => ({ items: [NOT_INCLUDED], total: 1 });
    summary = { ...FULL_SUMMARY, reportsReady: 0, packagesReady: 0, totalEvidenceWithArtifacts: 0, recordsReady: 0, recordsInProgress: 0, recordsNeedingAttention: 0, recordsNotAvailable: 1, recordsTotal: 1 };
    const { container } = await mount();
    await waitFor(() => expect(container.querySelector("[data-reports-no-artifacts]")).toBeTruthy());
    const r = container.querySelector("[data-reports-row-id='ev-free']")!;
    expect(r.textContent).toContain("Not included in the current plan");
    expect(r.querySelector("[data-tone='red']")).toBeNull();
  });
});

describe("Reports — row truth and actions", () => {
  it("a current success beside a superseded failure reads Ready — no failure tone, no failure words", async () => {
    const { container } = await mount();
    const r = container.querySelector("[data-reports-row-id='ev-superseded']")!;
    expect(r.querySelector("[data-reports-row-status-badge]")?.textContent).toBe("Ready");
    expect(r.querySelector("[data-tone='red']")).toBeNull();
    expect(words(r)).not.toMatch(/fail/i);
    // A genuine, actionable failure is the ONLY danger.
    const f = container.querySelector("[data-reports-row-id='ev-failed']")!;
    expect(f.querySelector("[data-reports-row-status-badge]")?.getAttribute("data-tone")).toBe("red");
    expect(f.querySelector("[data-reports-regenerate='ev-failed']")?.textContent).toBe("Retry report");
    // In progress is neutral.
    const q = container.querySelector("[data-reports-row-id='ev-queued']")!;
    expect(q.querySelector("[data-reports-row-status-badge]")?.getAttribute("data-tone")).toBe("slate");
  });

  it("the Production shapes: a failed package beside a ready v7 report, and an escalated failure, read as needs attention — truthfully", async () => {
    const pkgFailed = row("ev-pkg-failed", {
      status: "NEEDS_ATTENTION",
      reason: "PACKAGE_FAILED",
      report: "ready",
      pkg: "failed",
      reportOut: NOT_REQUIRED,
      pkgOut: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "ESCALATED_TO_OPERATOR" },
    });
    pkgFailed.report.version = 7;
    pkgFailed.outputs.verificationPackage.latestAvailableVersion = 2 as never;
    listFor = () => ({ items: [pkgFailed], total: 1 });
    const { container } = await mount();
    const r = await waitFor(() => {
      const el = container.querySelector("[data-reports-row-id='ev-pkg-failed']");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(r.querySelector("[data-reports-row-status-badge]")?.textContent).toBe("Needs attention");
    expect(r.querySelector("[data-reports-row-reason='PACKAGE_FAILED']")?.textContent).toBe("Verification package failed");
    // The report stays downloadable at its own version; the older package is
    // named as certifying an EARLIER report, never as the latest one's proof.
    expect(r.querySelector("[data-reports-report-state='ready']")?.textContent).toBe("Ready · v7");
    expect(r.querySelector("[data-reports-download-report]")).toBeTruthy();
    expect(r.querySelector("[data-reports-download-package]")).toBeNull();
    expect(r.querySelector("[data-reports-historical-package-version='2']")?.textContent).toMatch(/earlier report, not the latest/);
    // Escalated: no dead Retry, the reason instead, and no danger tone for a
    // failure this reader cannot act on.
    expect(r.querySelector("[data-reports-regenerate]")).toBeNull();
    expect(r.querySelector("[data-reports-action-withheld='ESCALATED_TO_OPERATOR']")?.textContent).toBe("Escalated to operators");
    expect(r.querySelector("[data-reports-row-status-badge]")?.getAttribute("data-tone")).toBe("amber");
  });

  it("owner/admin/member rows carry the server's verb; a viewer's row states why there is none", async () => {
    listFor = () => ({ items: [FAILED, FAILED_FOR_VIEWER], total: 2 });
    const { container } = await mount();
    await waitFor(() => expect(container.querySelector("[data-reports-row-id='ev-failed-viewer']")).toBeTruthy());
    expect(container.querySelector("[data-reports-regenerate='ev-failed']")).toBeTruthy();
    const viewer = container.querySelector("[data-reports-row-id='ev-failed-viewer']")!;
    expect(viewer.querySelector("[data-reports-regenerate]")).toBeNull();
    expect(viewer.querySelector("[data-reports-action-withheld='PERMISSION_DENIED']")).toBeTruthy();
    // Without a verb the failure is not presented as the reader's to fix.
    expect(viewer.querySelector("[data-reports-row-status-badge]")?.getAttribute("data-tone")).toBe("amber");
  });

  it("downloads stay visible; secondary actions are in a labelled, keyboard-operable overflow menu", async () => {
    const { container } = await mount();
    const r = container.querySelector("[data-reports-row-id='ev-superseded']")!;
    // A compact one-line action: short visible words, the full accessible name.
    const dl = r.querySelector("[data-reports-download-report]") as HTMLButtonElement;
    expect(dl.getAttribute("aria-label")).toBe("Download Report PDF");
    expect(dl.textContent).toBe("Report PDF");
    expect(dl.tagName).toBe("BUTTON");
    expect((r.querySelector("[data-reports-download-package]") as HTMLElement).getAttribute("aria-label")).toBe("Download Verification Package ZIP");
    expect(r.querySelector("[data-reports-download-package]")).toBeTruthy();
    const trigger = r.querySelector("[data-reports-row-menu-trigger]") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-label")).toBe("More actions for Record ev-superseded");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await waitFor(() => {
      const m = document.querySelector("[data-reports-row-menu-panel]");
      expect(m).toBeTruthy();
      return m!;
    });
    const open = within(menu as HTMLElement).getByText("Open evidence");
    fireEvent.click(open);
    expect(navigations).toEqual(["/evidence/ev-superseded"]);
  });
});

describe("Reports — language, direction, semantics, layout", () => {
  const RAW = /\b[A-Z]{2,}_[A-Z_]{2,}\b|\b[a-z]+_[a-z_]+\b/;

  for (const [lang, heading, status] of [
    ["en", "Operational summary", "Needs attention"],
    ["de", "Betriebsübersicht", "Handlungsbedarf"],
    ["ar", "الملخص التشغيلي", "تحتاج إلى متابعة"],
  ] as const) {
    it(`${lang}: renders the page in its language with no raw code anywhere`, async () => {
      locale = lang;
      const { container } = await mount((n) => <div dir={lang === "ar" ? "rtl" : "ltr"}>{n}</div>);
      expect(container.textContent).toContain(heading);
      expect(container.querySelector("[data-reports-row-id='ev-failed'] [data-reports-row-status-badge]")?.textContent).toBe(status);
      expect(container.textContent).not.toMatch(RAW);
      for (const el of Array.from(container.querySelectorAll("[aria-label]"))) {
        expect(el.getAttribute("aria-label")).not.toMatch(RAW);
      }
    });
  }

  it("is a real table with column headers, and every cell carries its label for the stacked narrow layout", async () => {
    const { container } = await mount();
    const table = container.querySelector("table[data-reports-list-items]")!;
    expect(table.querySelectorAll("thead th[scope='col']").length).toBe(7);
    // ONE DOM for both layouts — each row once, never a hidden duplicate.
    expect(container.querySelectorAll("[data-reports-row-id='ev-failed']").length).toBe(1);
    const cells = container.querySelectorAll("[data-reports-row-id='ev-failed'] .rpt-cell__label");
    expect(Array.from(cells).map((c) => c.textContent)).toEqual([
      "Status",
      "Report",
      "Package",
      "Original evidence",
      "Captured",
    ]);
    const css = readFileSync(`${process.cwd()}/components/reports-experience/reports.css`, "utf8");
    // Stacks by its CONTAINER's width (the page column), never the viewport —
    // a viewport query stacked the table on an ordinary laptop.
    expect(css).toMatch(/\.rpt-records \{\s*container-type: inline-size;/);
    expect(css).toMatch(/@container rpt-records \(max-width: 860px\) \{[\s\S]*\.rpt-table tr,[\s\S]*display: block;/);
    expect(css).not.toMatch(/@media \(max-width: 960px\)/);
    // One line of actions per table row.
    expect(css).toMatch(/\.rpt-row__actions \{[^}]*flex-wrap: nowrap;/);
    expect(css).toMatch(/\.rpt-cell__label \{\s*display: none;/);
    // Logical offsets only, so the page mirrors in RTL.
    expect(css).not.toMatch(/(?:margin|padding)-(?:left|right)|\bleft:|\bright:/);
  });

  it("a background refresh announces nothing", async () => {
    const { container } = await mount();
    expect(container.querySelectorAll("[aria-live]").length).toBe(0);
    expect(container.querySelectorAll("[role='status'], [role='alert']").length).toBe(0);
  });
});

/**
 * REPORTS — the per-row output actions, driven through the real page.
 *
 * 2026-09-26 — the verbs are PER OUTPUT and the server's:
 *
 *   1. A report whose package is missing offers "Recover package" on the
 *      package, posts intent RECOVER, and asks nothing — the record is owed it.
 *      There is no "Regenerate report & package" on any row.
 *   2. A complete record offers no generation verb. "Create new version" is
 *      optional and secondary: behind the row's overflow menu, confirmed with
 *      the current and next version, what is kept and the storage ESTIMATE
 *      (read from the record's own status), and posted once with an
 *      idempotency key that is reused only while the request is unanswered.
 *   3. Escalated work shows why nothing is offered instead of a dead Retry.
 *   4. A declined request shows the server's reason.
 *   5. A row with live work re-reads the list at the server's interval.
 *   6. No row control navigates except "Open evidence".
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, waitFor } from "@testing-library/react";

const navigations: string[] = [];
const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
let regenerateResolvers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
let rowPollIntervalMs: number | null = null;

type OutputOver = {
  state: string;
  action: string;
  actionUnavailableReason: string | null;
  operation?: string | null;
};

function row(
  id: string,
  opts: {
    ready: boolean;
    report: OutputOver;
    pkg: OutputOver;
    newVersion?: { action: string; reason: string | null };
    legacy?: "failed" | "not_requested";
  },
) {
  const legacy = opts.ready ? "ready" : (opts.legacy ?? "not_requested");
  return {
    evidenceId: id,
    title: `Record ${id}`,
    displayFileName: null,
    originalFileName: null,
    mimeType: null,
    type: "PHOTO",
    status: opts.ready ? "REPORTED" : "SIGNED",
    verificationStatus: null,
    caseId: null,
    caseTitle: null,
    intakeCustomerId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    report: { state: legacy, version: opts.ready ? 7 : null, generatedAtUtc: null },
    package: {
      state: opts.pkg.state === "READY" ? "ready" : legacy === "ready" ? "not_requested" : legacy,
      version: opts.pkg.state === "READY" ? 7 : null,
      generatedAtUtc: null,
      blockedReason: null,
    },
    outputs: {
      report: { terminalReasonClass: null, downloadable: opts.ready, operation: null, ...opts.report },
      verificationPackage: {
        terminalReasonClass: null,
        downloadable: opts.pkg.state === "READY",
        operation: null,
        ...opts.pkg,
      },
      newVersion: opts.newVersion ?? { action: "NONE", reason: "PAIR_INCOMPLETE" },
      pollIntervalMs: null as number | null,
    },
    provenance: { templateSlug: null, templateVersion: null, templateDbId: null },
  };
}

const NOT_REQUIRED = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED" };
const ROWS = () => {
  const rows = [
    row("ev-ready", {
      ready: true,
      report: NOT_REQUIRED,
      pkg: NOT_REQUIRED,
      newVersion: { action: "CREATE_NEW_VERSION", reason: null },
    }),
    row("ev-new", {
      ready: false,
      report: { state: "ELIGIBLE_NOT_GENERATED", action: "GENERATE", actionUnavailableReason: null, operation: "FULL_GENERATION" },
      pkg: { state: "ELIGIBLE_NOT_GENERATED", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
    }),
    row("ev-failed", {
      ready: false,
      legacy: "failed",
      report: { state: "RETRYABLE_FAILURE", action: "RETRY", actionUnavailableReason: null, operation: "RETRY_REQUEST" },
      pkg: { state: "RETRYABLE_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
    }),
    row("ev-pkg", {
      ready: true,
      report: NOT_REQUIRED,
      pkg: { state: "ELIGIBLE_NOT_GENERATED", action: "RECOVER", actionUnavailableReason: null, operation: "PACKAGE_RECOVERY" },
    }),
    row("ev-esc", {
      ready: false,
      legacy: "failed",
      report: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "ESCALATED_TO_OPERATOR" },
      pkg: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
    }),
  ];
  rows[3]!.outputs.pollIntervalMs = rowPollIntervalMs;
  return rows;
};

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requests.push({ path, method, body: init?.body ? JSON.parse(init.body) : null });
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
          artifacts: { status: "ok", items: ROWS(), nextCursor: null, total: ROWS().length },
        },
      };
    }
    if (path.endsWith("/reports/regenerate")) {
      return new Promise((resolve, reject) => regenerateResolvers.push({ resolve, reject }));
    }
    if (path.endsWith("/artifacts/status")) {
      // The record's own status carries the full offer: versions and estimate.
      return {
        outputs: {
          newVersion: {
            action: "CREATE_NEW_VERSION",
            reason: null,
            currentVersion: 7,
            nextVersion: 8,
            estimate: {
              estimatedBytes: String(5 * 1024 * 1024),
              basis: "PREVIOUS_PAIR",
              storageBytesUsed: String(200 * 1024 * 1024),
              storageBytesLimit: String(1024 * 1024 * 1024),
            },
          },
        },
      };
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
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

beforeEach(() => {
  navigations.length = 0;
  requests.length = 0;
  regenerateResolvers = [];
  rowPollIntervalMs = null;
});
afterEach(() => cleanup());

async function mount() {
  // The confirmation provider is mounted app-wide by app/providers.tsx.
  const view = render(
    <ConfirmActionProvider>
      <ReportsIndex />
    </ConfirmActionProvider>,
  );
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

  it("each output shows the server's own verb; a missing package reads Recover package and posts RECOVER", async () => {
    const { container } = await mount();
    const btn = (id: string) =>
      container.querySelector(`[data-reports-regenerate='${id}']`) as HTMLButtonElement | null;
    expect(btn("ev-pkg")?.textContent).toBe("Recover package");
    expect(btn("ev-pkg")?.getAttribute("data-reports-output")).toBe("verificationPackage");
    expect(btn("ev-new")?.textContent).toBe("Generate report & package");
    expect(btn("ev-failed")?.textContent).toBe("Retry report");
    // A complete record offers no generation verb, and nothing says Regenerate.
    expect(btn("ev-ready")).toBeNull();
    expect(container.textContent).not.toMatch(/Regenerate/);

    fireEvent.click(btn("ev-pkg")!);
    expect(posts()).toEqual([
      { path: "/v1/evidence/ev-pkg/reports/regenerate", method: "POST", body: { intent: "RECOVER" } },
    ]);
    expect(container.querySelector("[data-confirm-action-modal]")).toBeNull();
    expect(navigations).toEqual([]);
  });

  it("GENERATE and RETRY post directly with their intent — no confirmation for what the record is owed", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-regenerate='ev-new']")!);
    fireEvent.click(container.querySelector("[data-reports-regenerate='ev-failed']")!);
    expect(container.querySelector("[data-confirm-action-modal]")).toBeNull();
    expect(posts().map((p) => [p.path, p.body])).toEqual([
      ["/v1/evidence/ev-new/reports/regenerate", { intent: "GENERATE" }],
      ["/v1/evidence/ev-failed/reports/regenerate", { intent: "RETRY" }],
    ]);
    expect(navigations).toEqual([]);
  });

  it("escalated work states why nothing is offered, instead of a Retry that cannot work", async () => {
    const { container } = await mount();
    expect(container.querySelector("[data-reports-regenerate='ev-esc']")).toBeNull();
    const badge = container.querySelector("[data-reports-action-withheld='ESCALATED_TO_OPERATOR']");
    expect(badge?.textContent).toBe("Escalated to operators");
    expect(badge?.getAttribute("title")).toMatch(/operators/);
  });

  async function openNewVersion(container: HTMLElement) {
    const trigger = container.querySelector(
      "[data-testid='reports-new-version-ev-ready']",
    ) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    const item = await waitFor(() => {
      const el = document.querySelector("[data-reports-row-row-action='create-new-version']");
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    expect(item.textContent).toContain("Create new version");
    fireEvent.click(item);
    return waitFor(() => {
      const modal = document.querySelector("[data-confirm-action-modal]");
      expect(modal).toBeTruthy();
      return modal as HTMLElement;
    });
  }

  it("Create new version is behind the overflow menu and states versions, retention and the estimate before posting", async () => {
    const { container } = await mount();
    const modal = await openNewVersion(container);
    // The offer is read from the record's own status, not assumed by the row.
    expect(requests.some((r) => r.path === "/v1/evidence/ev-ready/artifacts/status")).toBe(true);
    const text = modal.textContent ?? "";
    expect(text).toContain("Create version 8?");
    expect(text).toContain("Creates report version 8 and its verification package, alongside version 7.");
    expect(text).toContain("Earlier versions are kept unchanged");
    expect(text).toMatch(/Estimated additional storage: about 5\.0 MB/);
    expect(text).toContain("Workspace storage now: 200 MB used of 1.0 GB.");
    expect(text).toContain("No evidence credit is charged.");
    expect(posts()).toHaveLength(0);

    fireEvent.click(modal.querySelector("[data-confirm-action-cancel='true']")!);
    await waitFor(() => expect(document.querySelector("[data-confirm-action-modal]")).toBeNull());
    expect(posts()).toHaveLength(0);
    expect(navigations).toEqual([]);
  });

  it("a confirmed new version posts ONCE with its idempotency key, then re-reads summary and list", async () => {
    const { container } = await mount();
    const modal = await openNewVersion(container);
    const confirm = modal.querySelector("[data-confirm-action-submit='true']") as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [post] = posts();
    expect(post!.path).toBe("/v1/evidence/ev-ready/reports/regenerate");
    expect(post!.body?.intent).toBe("NEW_VERSION");
    expect(String(post!.body?.clientRequestKey)).toMatch(/^nv-[A-Za-z0-9._:-]{6,}$/);

    const before = requests.filter((r) => r.path.startsWith("/v1/reports/artifacts")).length;
    await act(async () => {
      regenerateResolvers[0]!.resolve({ evidenceId: "ev-ready", enqueued: true, outcome: "ENQUEUED", message: "Creating version 8." });
    });
    await waitFor(() => {
      const reads = requests.filter((r) => r.path.startsWith("/v1/reports/artifacts")).slice(before);
      expect(reads.some((r) => !r.path.includes("summary=0"))).toBe(true);
      expect(reads.some((r) => r.path.includes("summary=0"))).toBe(true);
    });
    expect(container.querySelector("[data-reports-row-regen-notice='ev-ready']")?.textContent).toBe("Creating version 8.");
  });

  it("an unanswered new-version request is retried with the SAME key; an answered one mints a new key", async () => {
    const { container } = await mount();
    let modal = await openNewVersion(container);
    fireEvent.click(modal.querySelector("[data-confirm-action-submit='true']")!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await act(async () => {
      regenerateResolvers[0]!.reject(Object.assign(new Error("offline"), { statusCode: 0 }));
    });
    await waitFor(() => expect(container.querySelector("[data-reports-row-error='ev-ready']")).toBeTruthy());

    modal = await openNewVersion(container);
    fireEvent.click(modal.querySelector("[data-confirm-action-submit='true']")!);
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.body?.clientRequestKey).toBe(posts()[0]!.body?.clientRequestKey);
    await act(async () => {
      regenerateResolvers[1]!.resolve({ outcome: "REPLAYED", enqueued: false, message: "Already received." });
    });

    modal = await openNewVersion(container);
    fireEvent.click(modal.querySelector("[data-confirm-action-submit='true']")!);
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]!.body?.clientRequestKey).not.toBe(posts()[0]!.body?.clientRequestKey);
  });

  it("a declined request shows the server's reason, and the row re-reads its state", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-regenerate='ev-pkg']")!);
    const before = requests.filter((r) => r.path.startsWith("/v1/reports/artifacts")).length;
    await act(async () => {
      regenerateResolvers[0]!.reject(
        Object.assign(new Error("The stored report could not be verified, so it will not be reused."), {
          statusCode: 409,
          code: "OUTPUT_ACTION_UNAVAILABLE",
        }),
      );
    });
    await waitFor(() =>
      expect(container.querySelector("[data-reports-row-error='ev-pkg']")?.textContent).toBe(
        "The stored report could not be verified, so it will not be reused.",
      ),
    );
    await waitFor(() =>
      expect(requests.filter((r) => r.path.startsWith("/v1/reports/artifacts")).length).toBeGreaterThan(before),
    );
  });

  it("a row with live work re-reads the list at the server's interval, and stops when none is live", async () => {
    rowPollIntervalMs = 40;
    const { container } = await mount();
    expect(container).toBeTruthy();
    const listReads = () =>
      requests.filter((r) => r.path.startsWith("/v1/reports/artifacts") && r.path.includes("summary=0")).length;
    const first = listReads();
    await waitFor(() => expect(listReads()).toBeGreaterThan(first + 1), { timeout: 2000 });
    rowPollIntervalMs = null;
    await waitFor(() => {
      const n = listReads();
      return new Promise<void>((resolve, reject) =>
        setTimeout(() => (listReads() === n ? resolve() : reject(new Error("still polling"))), 150),
      );
    }, { timeout: 2000 });
  });

  it("a ready record keeps its downloads, and only Open evidence navigates", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-reports-download-report='ev-ready']")!);
    expect(navigations).toEqual([]);
    fireEvent.click(container.querySelector("[data-reports-open-evidence='ev-ready']")!);
    expect(navigations).toEqual(["/evidence/ev-ready"]);
  });
});

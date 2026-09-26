/**
 * EVIDENCE DETAIL / ARTIFACTS — the per-output actions, rendered from the
 * server's projection (2026-09-26).
 *
 *   * A report whose verification package is missing shows a package panel
 *     that says what recovery does (the stored report, no new version) and
 *     offers "Recover verification package", which posts intent RECOVER.
 *   * A complete record offers no generation verb; "Create new version" is in
 *     the overflow menu, confirmed with versions, retention and the estimate.
 *   * A new version in flight says so while the current one stays available.
 *   * Escalated work says why nothing is offered.
 *   * Nothing here is decided locally: every case is a different projection.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../lib/api", () => ({
  apiFetch: async () => ({}),
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
// The export-governance preflight is its own surface with its own tests.
vi.mock("../../components/governance/GovernedExportAction", () => ({
  GovernedExportAction: ({ renderAction }: { renderAction: (p: { disabled: boolean; onClick: () => void }) => React.ReactNode }) => (
    <>{renderAction({ disabled: false, onClick: () => {} })}</>
  ),
}));

import { EvidenceArtifactsTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab";
import type { EvidenceDetailCtx } from "../../app/(app)/evidence/[id]/_tabs/_lib";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

type Out = {
  state: string;
  action: string;
  actionUnavailableReason: string | null;
  operation?: string | null;
  version?: number | null;
  latestAvailableVersion?: number | null;
  attemptCount?: number | null;
};

const output = (o: Out) => ({
  eligibility: "ELIGIBLE",
  ineligibilityReason: null,
  notApplicableReason: null,
  generation: "SUCCEEDED",
  terminalReasonClass: o.state === "TERMINAL_FAILURE" ? "TECHNICAL" : null,
  terminalReasonCode: null,
  attemptCount: o.attemptCount ?? 1,
  requestedAtUtc: null,
  completedAtUtc: null,
  availability: o.state === "READY" ? "READY" : "NO_ARTIFACT",
  operation: null,
  version: null,
  latestAvailableVersion: null,
  ...o,
});

function workspace(outputs: {
  report: Out;
  pkg: Out;
  newVersion?: Record<string, unknown>;
}) {
  const reportReady = outputs.report.state === "READY";
  const pkgReady = outputs.pkg.state === "READY";
  return {
    evidence: { teamId: "team-1" },
    publicVerificationSummary: {
      views: 0,
      reportDownloadCount: 0,
      verificationPackageDownloadCount: 0,
      lastPublicViewAt: null,
      analyticsAvailable: false,
      disabledReason: null,
    },
    artifactVersions: { history: undefined },
    artifactStatus: {
      outputs: {
        report: output(outputs.report),
        verificationPackage: output(outputs.pkg),
        newVersion: outputs.newVersion ?? {
          action: "NONE",
          reason: "PAIR_INCOMPLETE",
          currentVersion: null,
          nextVersion: null,
          estimate: null,
        },
        pollIntervalMs: null,
      },
      report: { available: reportReady },
      verificationPackage: { available: pkgReady, blocked: false, blockedReason: null },
    },
  };
}

function mount(ws: ReturnType<typeof workspace>) {
  const calls: Array<{ kind: "generate" | "newVersion"; arg: unknown }> = [];
  const ctx = {
    workspace: ws,
    evidenceId: "ev-1",
    publicVerificationState: null,
    shareUrl: null,
    stalePending: false,
    setStalePending: () => {},
    setPollStartedAt: () => {},
    loadWorkspace: () => {},
    downloadReport: () => {},
    downloadVerificationPackage: () => {},
    downloadReportVersion: () => {},
    downloadVerificationPackageVersion: () => {},
    generateOutputs: (intent?: string) => {
      calls.push({ kind: "generate", arg: intent });
    },
    generateOutputsBusy: false,
    createNewVersion: async (key: string) => {
      calls.push({ kind: "newVersion", arg: key });
      return "answered" as const;
    },
  } as unknown as EvidenceDetailCtx;
  const view = render(
    <ConfirmActionProvider>
      <EvidenceArtifactsTab ctx={ctx} />
    </ConfirmActionProvider>,
  );
  return { ...view, calls };
}

const NOT_REQUIRED: Out = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: 3, latestAvailableVersion: 3 };

afterEach(() => cleanup());

describe("Evidence Artifacts — per-output actions", () => {
  it("a missing package is RECOVERED from the stored report: its own panel, its own verb, intent RECOVER", () => {
    const { container, calls } = mount(
      workspace({
        report: NOT_REQUIRED,
        pkg: {
          state: "ELIGIBLE_NOT_GENERATED",
          action: "RECOVER",
          actionUnavailableReason: null,
          operation: "PACKAGE_RECOVERY",
          latestAvailableVersion: 2,
        },
      }),
    );
    const panel = container.querySelector("[data-evidence-section='package-recovery']");
    expect(panel?.textContent).toContain("The verification package for report version 3 is missing");
    expect(panel?.textContent).toMatch(/from the stored report bytes — it does not create a new report\s+version/);
    expect(panel?.textContent).toContain("The earlier package (version 2) stays downloadable");
    const btn = panel?.querySelector("[data-evidence-action='generate-outputs']") as HTMLButtonElement;
    expect(btn.textContent).toBe("Recover verification package");
    expect(btn.getAttribute("data-evidence-output")).toBe("verificationPackage");
    expect(container.textContent).not.toMatch(/Regenerate/);
    fireEvent.click(btn);
    expect(calls).toEqual([{ kind: "generate", arg: "RECOVER" }]);
  });

  it("a failed package recovery is retried as a recovery", () => {
    const { container, calls } = mount(
      workspace({
        report: NOT_REQUIRED,
        pkg: {
          state: "RETRYABLE_FAILURE",
          action: "RETRY",
          actionUnavailableReason: null,
          operation: "PACKAGE_RECOVERY",
          attemptCount: 2,
        },
      }),
    );
    const panel = container.querySelector("[data-evidence-section='package-recovery']");
    expect(panel?.textContent).toContain("Recovering the verification package failed");
    expect(panel?.textContent).toContain("(attempt 2)");
    const btn = panel?.querySelector("[data-evidence-action='generate-outputs']") as HTMLButtonElement;
    expect(btn.textContent).toBe("Retry package recovery");
    fireEvent.click(btn);
    expect(calls).toEqual([{ kind: "generate", arg: "RETRY" }]);
  });

  it("an exhausted package recovery offers no Retry and routes to operators", () => {
    const { container } = mount(
      workspace({
        report: NOT_REQUIRED,
        pkg: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "ESCALATED_TO_OPERATOR" },
      }),
    );
    const panel = container.querySelector("[data-evidence-section='package-recovery']");
    expect(panel?.textContent).toContain("The verification package could not be recovered");
    expect(panel?.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
    expect(
      panel?.querySelector("[data-evidence-action-unavailable='ESCALATED_TO_OPERATOR']")?.textContent,
    ).toMatch(/reported to your workspace operators/);
  });

  it("a package recovery in flight says the report is not changed", () => {
    const { container } = mount(
      workspace({
        report: NOT_REQUIRED,
        pkg: { state: "GENERATING", action: "NONE", actionUnavailableReason: "IN_PROGRESS" },
      }),
    );
    const panel = container.querySelector("[data-evidence-section='package-recovery-in-flight']");
    expect(panel?.textContent).toContain("Recovering the verification package for report version 3…");
    expect(panel?.textContent).toContain("The report is not changed and no new version is created.");
  });

  it("a report with no package yet: the package follows the report's own action", () => {
    const { container, calls } = mount(
      workspace({
        report: { state: "ELIGIBLE_NOT_GENERATED", action: "GENERATE", actionUnavailableReason: null, operation: "FULL_GENERATION" },
        pkg: { state: "ELIGIBLE_NOT_GENERATED", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
      }),
    );
    expect(container.querySelector("[data-evidence-section^='package-recovery']")).toBeNull();
    const btns = container.querySelectorAll("[data-evidence-action='generate-outputs']");
    expect(btns).toHaveLength(1);
    expect(btns[0]!.textContent).toBe("Generate report & verification package");
    fireEvent.click(btns[0]!);
    expect(calls).toEqual([{ kind: "generate", arg: "GENERATE" }]);
  });

  it("an escalated report states why there is no Retry, instead of the generic class sentence", () => {
    const { container } = mount(
      workspace({
        report: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "ESCALATED_TO_OPERATOR" },
        pkg: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
      }),
    );
    const panel = container.querySelector("[data-evidence-section='reports-terminal-failure']");
    expect(panel?.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
    expect(panel?.textContent).toMatch(/Automatic retries were exhausted/);
    expect(panel?.textContent).not.toMatch(/Support can investigate/);
  });

  it("a complete record offers no verb; Create new version is in the overflow and confirmed with versions and the estimate", async () => {
    const { container, calls } = mount(
      workspace({
        report: NOT_REQUIRED,
        pkg: NOT_REQUIRED,
        newVersion: {
          action: "CREATE_NEW_VERSION",
          reason: null,
          currentVersion: 3,
          nextVersion: 4,
          estimate: {
            estimatedBytes: String(12 * 1024 * 1024),
            basis: "ORIGINAL_EVIDENCE",
            storageBytesUsed: null,
            storageBytesLimit: null,
          },
        },
      }),
    );
    expect(container.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
    fireEvent.click(container.querySelector("[data-testid='evidence-new-version']")!);
    const item = await waitFor(() => {
      const el = document.querySelector("[data-evidence-output-row-action='create-new-version']");
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    fireEvent.click(item);
    const modal = await waitFor(() => {
      const el = document.querySelector("[data-confirm-action-modal]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const text = modal.textContent ?? "";
    expect(text).toContain("Create version 4?");
    expect(text).toContain("Creates report version 4 and its verification package, alongside version 3.");
    expect(text).toContain("Earlier versions are kept unchanged and stay downloadable.");
    expect(text).toContain("Estimated additional storage: about 12 MB (based on the original evidence");
    expect(calls).toEqual([]);
    fireEvent.click(modal.querySelector("[data-confirm-action-submit='true']")!);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.kind).toBe("newVersion");
    expect(String(calls[0]!.arg)).toMatch(/^nv-/);
  });

  it("a new version in flight says so; the current version stays and no action is offered", () => {
    const { container } = mount(
      workspace({
        report: NOT_REQUIRED,
        pkg: NOT_REQUIRED,
        newVersion: { action: "NONE", reason: "IN_PROGRESS", currentVersion: 3, nextVersion: 4, estimate: null },
      }),
    );
    const panel = container.querySelector("[data-evidence-section='reports-new-version-in-flight']");
    expect(panel?.textContent).toContain("Creating version 4…");
    expect(panel?.textContent).toContain("The current version stays available");
    expect(container.querySelector("[data-testid='evidence-new-version']")).toBeNull();
    expect(container.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
  });

  it("a complete record without a new-version offer renders no action row at all", () => {
    const { container } = mount(workspace({ report: NOT_REQUIRED, pkg: NOT_REQUIRED }));
    expect(container.querySelector("[data-evidence-section='reports-ready-actions']")).toBeNull();
    expect(container.querySelector("[data-evidence-section^='package-recovery']")).toBeNull();
  });
});

/**
 * EVIDENCE DETAIL / ARTIFACTS — the per-output actions, rendered from the
 * server's projection (2026-09-26).
 *
 *   * A report whose verification package is missing shows a package panel
 *     that says what recovery does (the stored report, no new version) and
 *     offers "Recover verification package", which posts intent RECOVER.
 *   * A complete record offers no generation verb; "Generate updated report" is
 *     a direct action, confirmed in a dialog bound to the server's signed offer.
 *   * A new version in flight says so while the current one stays available.
 *   * Escalated work says why nothing is offered.
 *   * Nothing here is decided locally: every case is a different projection.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

// RGA-02 — the new-version action revalidates the offer at Confirm via
// apiFetch('/artifacts/status'). A controllable impl lets a case return the
// current (or an advanced) offer.
const api = vi.hoisted(() => ({
  impl: async (_path: string): Promise<unknown> => ({}),
}));
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string) => api.impl(path),
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
// The tenant service status, as the shell would have read it. Null (healthy /
// not read) unless a case sets it.
let serviceStatus: unknown = null;
vi.mock("../../lib/useServiceStatus", () => ({
  useServiceStatus: () => ({ status: serviceStatus, error: false, settled: true }),
}));
// The export-governance preflight is its own surface with its own tests.
vi.mock("../../components/governance/GovernedExportAction", () => ({
  GovernedExportAction: ({ renderAction }: { renderAction: (p: { disabled: boolean; onClick: () => void }) => React.ReactNode }) => (
    <>{renderAction({ disabled: false, onClick: () => {} })}</>
  ),
}));

import { EvidenceArtifactsTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab";
import type { EvidenceDetailCtx } from "../../app/(app)/evidence/[id]/_tabs/_lib";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { ToastProvider } from "../../components/ui";

type Out = {
  state: string;
  action: string;
  actionUnavailableReason: string | null;
  operation?: string | null;
  version?: number | null;
  latestAvailableVersion?: number | null;
  attemptCount?: number | null;
  terminalReasonCode?: string | null;
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
    createNewVersion: async (submission: unknown) => {
      calls.push({ kind: "newVersion", arg: submission });
      return { kind: "accepted" as const, requestId: "req-1", message: "Accepted." };
    },
  } as unknown as EvidenceDetailCtx;
  const view = render(
    // The tab also mounts the public-verification-links panel, which reports
    // its own outcomes through the app toast — present on every real page.
    <ToastProvider>
      <ConfirmActionProvider>
        <EvidenceArtifactsTab ctx={ctx} />
      </ConfirmActionProvider>
    </ToastProvider>,
  );
  return { ...view, calls };
}

const NOT_REQUIRED: Out = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: 3, latestAvailableVersion: 3 };

afterEach(() => {
  cleanup();
  serviceStatus = null;
  api.impl = async () => ({});
});

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

  it("an UNREADABLE ORIGINAL stops recovery with its own operator-visible sentence — never 'retries were exhausted'", () => {
    const { container } = mount(
      workspace({
        report: NOT_REQUIRED,
        pkg: {
          state: "TERMINAL_FAILURE",
          action: "NONE",
          actionUnavailableReason: "ESCALATED_TO_OPERATOR",
          terminalReasonCode: "EVIDENCE_ORIGINAL_NOT_FOUND",
        },
      }),
    );
    const panel = container.querySelector("[data-evidence-section='package-recovery']");
    expect(panel?.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
    const text = panel?.textContent ?? "";
    expect(text).toContain("The signed original cannot currently be read from storage.");
    expect(text).toContain("No report or package was built from replacement bytes.");
    expect(text).toContain("sent for operator review");
    expect(text).not.toMatch(/retries were exhausted/i);
    expect(container.textContent).not.toMatch(/destroyed|tamper|integrity check failed/i);
    expect(container.textContent).not.toMatch(/Recover|Retry/);
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

  it("a complete record offers 'Generate updated report' as a DIRECT action; the dialog needs a valid reason and submits the SIGNED offer it showed", async () => {
    const offer = {
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
    };
    const signed = {
      revision: "ofr1.shown.sig",
      createdAtUtc: "2026-10-06T10:00:00.000Z",
      expiresAtUtc: "2026-10-06T10:15:00.000Z",
      operation: "NEW_VERSION",
      targetVersion: 4,
      reasonRequired: true,
      creditEffect: { kind: "NONE" },
      storageEffect: { estimatedBytes: String(12 * 1024 * 1024), fitsStorage: true, storageBytesUsed: null, storageBytesLimit: null },
    };
    // The dialog re-reads the authoritative offer when it opens.
    api.impl = async () => ({ outputs: { newVersion: offer, offer: signed, freshness: null } });
    const { container, calls } = mount(
      workspace({ report: NOT_REQUIRED, pkg: NOT_REQUIRED, newVersion: offer }),
    );
    expect(container.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
    const action = container.querySelector("[data-testid='evidence-new-version']") as HTMLButtonElement;
    expect(action.tagName).toBe("BUTTON");
    expect(action.textContent).toMatch(/generate updated report/i);
    fireEvent.click(action);
    const dialog = await waitFor(() => {
      const el = document.querySelector("[data-testid='updated-report-dialog']");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await waitFor(() => expect(dialog.getAttribute("aria-busy")).toBeNull());
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain("Generate report v4");
    expect(dialog.querySelector("[data-testid='updated-report-current']")?.textContent).toBe("v3");
    expect(dialog.querySelector("[data-testid='updated-report-credit']")?.textContent).toBe("No evidence credit is used.");
    expect(dialog.querySelector("[data-testid='updated-report-storage']")?.textContent).toContain("about 12 MB");
    expect(dialog.textContent).toContain("Report v3 and its verification package stay exactly as they are");
    expect(dialog.textContent).toContain("A matching verification package v4 will certify report v4.");
    expect(dialog.textContent).toContain("The original evidence and its recorded timestamps are not modified.");
    const submit = dialog.querySelector("[data-testid='updated-report-confirm']") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(dialog.querySelector("[data-testid='updated-report-reason']")!, {
      target: { value: "Document the later anchor" },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.kind).toBe("newVersion");
    const arg = calls[0]!.arg as { clientRequestKey: string; reason: string; offerRevision: string };
    expect(arg.clientRequestKey).toMatch(/^nv-/);
    expect(arg.reason).toBe("Document the later anchor");
    expect(arg.offerRevision).toBe("ofr1.shown.sig");
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

describe("Evidence Artifacts — a generation incident is stated once", () => {
  const degraded = () => {
    serviceStatus = {
      status: "DEGRADED",
      capabilities: {
        uploads: "HEALTHY",
        artifactGeneration: "DEGRADED",
        downloads: "HEALTHY",
        search: "HEALTHY",
        reviewAutomation: "HEALTHY",
      },
    };
  };
  const notices = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("[data-service-notice='artifactGeneration']"));
  const newVersionOffer = {
    action: "CREATE_NEW_VERSION",
    reason: null,
    currentVersion: 3,
    nextVersion: 4,
    estimate: null,
  };
  const readyReport: Out = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: 3, latestAvailableVersion: 3 };
  const recoverablePackage: Out = {
    state: "ELIGIBLE_NOT_GENERATED",
    action: "RECOVER",
    actionUnavailableReason: null,
    operation: "PACKAGE_RECOVERY",
    version: null,
    latestAvailableVersion: null,
  };

  it("a new-version offer AND a package recovery on one tab: one notice, beside the report's action", () => {
    degraded();
    const { container } = mount(workspace({ report: readyReport, pkg: recoverablePackage, newVersion: newVersionOffer }));
    // Both controls are there…
    expect(container.querySelector("[data-evidence-section='reports-ready-actions']")).not.toBeNull();
    expect(container.querySelector("[data-evidence-action='generate-outputs']")).not.toBeNull();
    // …and the incident is said once, in the first of them.
    const found = notices(container);
    expect(found.length).toBe(1);
    expect(found[0]!.closest("[data-evidence-section='reports-ready-actions']")).not.toBeNull();
  });

  it("only the package needs recovering: the notice is beside the package's action", () => {
    degraded();
    const { container } = mount(workspace({ report: readyReport, pkg: recoverablePackage }));
    const found = notices(container);
    expect(found.length).toBe(1);
    expect(found[0]!.closest("[data-evidence-section='reports-ready-actions']")).toBeNull();
    expect(found[0]!.parentElement!.querySelector("[data-evidence-action='generate-outputs']")).not.toBeNull();
  });

  it("a new version in flight shows no report notice, so the package panel states it", () => {
    degraded();
    const { container } = mount(
      workspace({
        report: readyReport,
        pkg: recoverablePackage,
        newVersion: { action: "NONE", reason: "IN_PROGRESS", currentVersion: 3, nextVersion: 4, estimate: null },
      }),
    );
    expect(container.querySelector("[data-evidence-section='reports-new-version-in-flight']")).not.toBeNull();
    expect(notices(container).length).toBe(1);
  });

  it("nothing to generate: no notice at all, whatever the service status", () => {
    degraded();
    const { container } = mount(
      workspace({ report: readyReport, pkg: { ...readyReport } }),
    );
    expect(notices(container).length).toBe(0);
  });

  it("a healthy service says nothing beside either action", () => {
    const { container } = mount(workspace({ report: readyReport, pkg: recoverablePackage, newVersion: newVersionOffer }));
    expect(notices(container).length).toBe(0);
  });
});

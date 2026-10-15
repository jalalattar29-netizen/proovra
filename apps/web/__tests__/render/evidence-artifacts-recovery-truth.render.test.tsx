/**
 * EVIDENCE DETAIL / ARTIFACTS — recovery truth (2026-10-12).
 *
 *   * NOT INCLUDED is said for its actual reason, with a payment destination
 *     only where paying resolves it: Billing for a lapsed or ended
 *     subscription, Pricing for an output the plan excludes, nothing for an
 *     unresolved answer. No "this workspace's plan" wording on any record.
 *   * A first report awaiting confirmed payment offers no Generate.
 *   * A stored file the server answered 410 for is stated persistently, as an
 *     escalation with no recovery verb, and only while it is about the
 *     CURRENT artifact.
 *   * The hook records that 410 from a real download (no storage probe).
 *   * A busy request disables the control; an escalated terminal stays still.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, renderHook } from "@testing-library/react";

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
vi.mock("../../lib/useServiceStatus", () => ({
  useServiceStatus: () => ({ status: null, error: false, settled: true }),
}));
vi.mock("../../components/governance/GovernedExportAction", () => ({
  GovernedExportAction: ({ renderAction }: { renderAction: (p: { disabled: boolean; onClick: () => void }) => React.ReactNode }) => (
    <>{renderAction({ disabled: false, onClick: () => {} })}</>
  ),
}));

import { EvidenceArtifactsTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab";
import { useEvidenceArtifactActions } from "../../app/(app)/evidence/[id]/_hooks/useEvidenceArtifactActions";
import type { EvidenceDetailCtx } from "../../app/(app)/evidence/[id]/_tabs/_lib";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { ToastProvider } from "../../components/ui";

type Out = {
  state: string;
  action: string;
  actionUnavailableReason: string | null;
  eligibility?: string;
  ineligibilityReason?: string | null;
  terminalReasonCode?: string | null;
  version?: number | null;
};

const output = (o: Out) => ({
  eligibility: "ELIGIBLE",
  ineligibilityReason: null,
  notApplicableReason: null,
  generation: "NOT_REQUESTED",
  terminalReasonClass: o.state === "TERMINAL_FAILURE" ? "TECHNICAL" : null,
  terminalReasonCode: null,
  attemptCount: 1,
  requestedAtUtc: null,
  completedAtUtc: null,
  availability: o.state === "READY" ? "READY" : "NO_ARTIFACT",
  operation: null,
  version: null,
  latestAvailableVersion: null,
  ...o,
});

const REPORT_AT = "2026-10-01T10:00:00.000Z";

function workspace(report: Out, pkg: Out) {
  const reportReady = report.state === "READY";
  const pkgReady = pkg.state === "READY";
  return {
    evidence: { teamId: null },
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
        report: output(report),
        verificationPackage: output(pkg),
        newVersion: { action: "NONE", reason: "PAIR_INCOMPLETE", currentVersion: null, nextVersion: null, estimate: null },
        pollIntervalMs: null,
      },
      report: reportReady
        ? { available: true, version: 1, generatedAtUtc: REPORT_AT }
        : { available: false, version: null, generatedAtUtc: null },
      verificationPackage: pkgReady
        ? { available: true, version: 1, generatedAtUtc: REPORT_AT, blocked: false, blockedReason: null }
        : { available: false, version: null, generatedAtUtc: null, blocked: false, blockedReason: null },
    },
  };
}

function mount(ws: ReturnType<typeof workspace>, extra: Partial<EvidenceDetailCtx> = {}) {
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
    generateOutputs: () => {},
    generateOutputsBusy: false,
    createNewVersion: async () => ({ kind: "accepted" as const, requestId: "r", message: "ok" }),
    outputAttention: null,
    openArtifacts: () => {},
    openUpdatedReport: () => {},
    ...extra,
  } as unknown as EvidenceDetailCtx;
  return render(
    <ToastProvider>
      <ConfirmActionProvider>
        <EvidenceArtifactsTab ctx={ctx} />
      </ConfirmActionProvider>
    </ToastProvider>,
  );
}

const NOT_INCLUDED = (ineligibilityReason: string): [Out, Out] => [
  { state: "NOT_INCLUDED", action: "NONE", actionUnavailableReason: "NOT_INCLUDED", eligibility: "NOT_INCLUDED", ineligibilityReason },
  { state: "NOT_INCLUDED", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT", eligibility: "NOT_INCLUDED", ineligibilityReason },
];

const READY: Out = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: 1 };

afterEach(() => cleanup());

describe("NOT_INCLUDED says its actual reason", () => {
  it("excluded by the plan: Pricing, never Billing, never workspace wording", () => {
    const { container } = mount(workspace(...NOT_INCLUDED("NOT_INCLUDED_IN_PLAN")));
    const panel = container.querySelector("[data-evidence-section='reports-plan-gated']")!;
    expect(panel.textContent).toContain("The plan that covers this record does not include");
    expect(panel.querySelector("a[data-evidence-link='pricing']")?.getAttribute("href")).toBe("/pricing");
    expect(panel.querySelector("a[data-evidence-link='billing']")).toBeNull();
    expect(container.textContent).not.toMatch(/this workspace's (current )?plan/i);
  });

  it.each(["PAYMENT_LAPSED", "SUBSCRIPTION_ENDED"])("%s: Billing, never Pricing", (reason) => {
    const { container } = mount(workspace(...NOT_INCLUDED(reason)));
    const panel = container.querySelector("[data-evidence-section='reports-plan-gated']")!;
    expect(panel.getAttribute("data-evidence-ineligibility-reason")).toBe(reason);
    expect(panel.querySelector("a[data-evidence-link='billing']")?.getAttribute("href")).toBe("/billing");
    expect(panel.querySelector("a[data-evidence-link='pricing']")).toBeNull();
    expect(panel.textContent).toMatch(reason === "PAYMENT_LAPSED" ? /payment has lapsed/ : /subscription has ended/);
  });

  it("an unresolved answer links nowhere", () => {
    const { container } = mount(workspace(...NOT_INCLUDED("ENTITLEMENT_UNRESOLVED")));
    const panel = container.querySelector("[data-evidence-section='reports-plan-gated']")!;
    expect(panel.querySelector("a")).toBeNull();
  });
});

describe("a first report awaiting confirmed payment", () => {
  it("offers no Generate and says why", () => {
    const { container } = mount(
      workspace(
        { state: "ELIGIBLE_NOT_GENERATED", action: "NONE", actionUnavailableReason: "AWAITING_CONFIRMED_PAYMENT" },
        { state: "ELIGIBLE_NOT_GENERATED", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
      ),
    );
    const panel = container.querySelector("[data-evidence-section='reports-awaiting-confirmed-payment']")!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toMatch(/payment is confirmed/);
    expect(container.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
    expect(container.querySelector("[data-evidence-section='reports-eligible-not-generated']")).toBeNull();
    expect(panel.querySelector("a[data-evidence-link='billing']")?.getAttribute("href")).toBe("/billing");
  });
});

describe("a stored file the server could not find", () => {
  const after = Date.parse(REPORT_AT) + 60_000;

  it("is stated persistently, with no recovery verb", () => {
    const { container } = mount(workspace(READY, READY), {
      missingStoredArtifacts: { report: { at: after, version: null }, verificationPackage: null },
    });
    const banners = container.querySelectorAll("[data-evidence-section='artifact-object-missing']");
    expect(banners).toHaveLength(1);
    expect(banners[0]!.getAttribute("data-evidence-output")).toBe("report");
    expect(banners[0]!.textContent).toContain("The report file is missing (version 1)");
    expect(banners[0]!.textContent).toMatch(/never regenerated in place/);
    expect(banners[0]!.querySelector("button")).toBeNull();
  });

  it("a named version banner shows only while it is the current version", () => {
    const current = mount(workspace(READY, READY), {
      missingStoredArtifacts: { report: null, verificationPackage: { at: after, version: 1 } },
    });
    expect(current.container.querySelectorAll("[data-evidence-section='artifact-object-missing']")).toHaveLength(1);
    cleanup();
    const older = mount(workspace(READY, READY), {
      missingStoredArtifacts: { report: { at: after, version: 0 }, verificationPackage: null },
    });
    expect(older.container.querySelector("[data-evidence-section='artifact-object-missing']")).toBeNull();
  });

  it("is withdrawn once a newer artifact has landed", () => {
    const { container } = mount(workspace(READY, READY), {
      missingStoredArtifacts: { report: { at: Date.parse(REPORT_AT) - 60_000, version: null }, verificationPackage: null },
    });
    expect(container.querySelector("[data-evidence-section='artifact-object-missing']")).toBeNull();
  });

  it("nothing is shown without a 410 answer", () => {
    const { container } = mount(workspace(READY, READY));
    expect(container.querySelector("[data-evidence-section='artifact-object-missing']")).toBeNull();
  });
});

describe("the hook learns the 410 from a real download", () => {
  const hook = () =>
    renderHook(() =>
      useEvidenceArtifactActions({ evidenceId: "ev-1", addToast: () => {}, reloadWorkspace: () => {} }),
    );

  it("records report_artifact_missing on the latest report download", async () => {
    api.impl = async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410, code: "report_artifact_missing" });
    };
    const { result } = hook();
    expect(result.current.missingStoredArtifacts).toEqual({ report: null, verificationPackage: null });
    await act(async () => {
      await result.current.downloadReport();
    });
    expect(result.current.missingStoredArtifacts.report?.version).toBeNull();
    expect(result.current.missingStoredArtifacts.verificationPackage).toBeNull();
  });

  it("records the version for a versioned package download", async () => {
    api.impl = async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410, code: "verification_package_artifact_missing" });
    };
    const { result } = hook();
    await act(async () => {
      await result.current.downloadVerificationPackageVersion(3);
    });
    expect(result.current.missingStoredArtifacts.verificationPackage?.version).toBe(3);
  });

  it("ignores every other refusal", async () => {
    api.impl = async () => {
      throw Object.assign(new Error("held"), { statusCode: 409, code: "legal_hold_active" });
    };
    const { result } = hook();
    await act(async () => {
      await result.current.downloadReport();
    });
    expect(result.current.missingStoredArtifacts).toEqual({ report: null, verificationPackage: null });
  });

  it("a declined 409 with no reason is read by its outcome, not as a version conflict", async () => {
    const toasts: string[] = [];
    api.impl = async () => {
      throw Object.assign(new Error("declined"), {
        statusCode: 409,
        code: "OUTPUT_ACTION_UNAVAILABLE",
        details: { reason: null, outcome: "NOT_INCLUDED" },
      });
    };
    const { result } = renderHook(() =>
      useEvidenceArtifactActions({ evidenceId: "ev-1", addToast: (m) => toasts.push(m), reloadWorkspace: () => {} }),
    );
    await act(async () => {
      await result.current.generateOutputs("GENERATE", "report");
    });
    expect(toasts.join(" ")).toContain("Not included for this record");
    expect(toasts.join(" ")).not.toContain("A newer version already exists");
  });
});

describe("controls stay honest", () => {
  it("a busy request disables the offered control", () => {
    const { container } = mount(
      workspace(
        { state: "RETRYABLE_FAILURE", action: "RETRY", actionUnavailableReason: null },
        { state: "RETRYABLE_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
      ),
      { generateOutputsBusy: true },
    );
    const btn = container.querySelector("[data-evidence-action='generate-outputs']") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Retrying…");
  });

  it("an escalated terminal offers no Retry", () => {
    const { container } = mount(
      workspace(
        { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "ESCALATED_TO_OPERATOR" },
        { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
      ),
    );
    expect(container.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
    expect(container.textContent).not.toMatch(/Retry report generation/);
  });
});

describe("AUD-011 — the status projection says a stored file is gone (no download needed)", () => {
  const MISSING: Out = { state: "ARTIFACT_MISSING", action: "RECOVER", actionUnavailableReason: null, version: 1 };

  it("states it persistently and offers ONE new verified version to a caller who may issue outputs", () => {
    const calls: Array<[string, string]> = [];
    const ws = workspace(MISSING, { state: "READY", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT", version: 1 });
    (ws.artifactStatus.outputs.report as { operation: string | null }).operation = "NEW_VERSION";
    (ws.artifactStatus.outputs.report as { availability: string }).availability = "MISSING";
    const { container } = mount(ws, { generateOutputs: (a: string, k: string) => void calls.push([a, k]) } as never);
    const panel = container.querySelector("[data-evidence-section='reports-artifact-missing']")!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain("The stored file of report version 1 is unavailable");
    expect(panel.textContent).toMatch(/never regenerated in place/);
    const button = panel.querySelector("[data-evidence-action='generate-outputs']") as HTMLButtonElement;
    expect(button.textContent).toBe("Issue a new verified version");
    expect(button.getAttribute("data-evidence-operation")).toBe("NEW_VERSION");
    act(() => button.click());
    expect(calls).toEqual([["RECOVER", "report"]]);
  });

  it("a caller who may not issue outputs is told, with no button", () => {
    const ws = workspace(
      { state: "ARTIFACT_MISSING", action: "NONE", actionUnavailableReason: "PERMISSION_DENIED", version: 1 },
      { state: "READY", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT", version: 1 },
    );
    const { container } = mount(ws);
    const panel = container.querySelector("[data-evidence-section='reports-artifact-missing']")!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector("[data-evidence-action='generate-outputs']")).toBeNull();
  });
});

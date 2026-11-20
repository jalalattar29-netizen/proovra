/**
 * PRO-R3-06 / DEC-10 — after the redaction entitlement lapses, existing
 * projects open READ-ONLY: the redacted copy can still be downloaded and
 * quarantined, and nothing that starts or advances work is offered. An
 * entitled workspace keeps every control. Real `apiFetch` over a stubbed
 * network (the reads the API keeps open after a lapse, redaction.routes `gate`).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ctx = vi.hoisted(() => ({ redactionIncluded: false as boolean | undefined }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, use: (p: { value: unknown }) => p.value };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../../lib/platform-context", async (importOriginal) => {
  const envelope = () => ({ user: { id: "u-admin" }, planFeatures: { redactionIncluded: ctx.redactionIncluded } });
  return {
    ...(await importOriginal<typeof import("../../lib/platform-context")>()),
    useTeamId: () => "11111111-1111-4111-8111-111111111111",
    useTenantGuard: () => ({ stamp: () => 0, isStale: () => false, generation: 0 }),
    useOptionalPlatformContext: () => ({ envelope: envelope(), activeWorkspaceId: "w1" }),
    usePlatformContext: () => ({ envelope: envelope(), activeWorkspaceId: "w1" }),
    useWorkspaceContextSafety: () => ({ runGuarded: async (fn: () => Promise<unknown>) => fn() }),
  };
});
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  useStepUpAction: () => ({ runStepUpAction: async (fn: () => Promise<unknown>) => fn() }),
  StepUpModal: () => null,
}));
vi.mock("../../components/redaction/ImageRedactionViewer", () => ({ ImageRedactionViewer: () => null }));
vi.mock("../../components/redaction/PdfRedactionViewer", () => ({ PdfRedactionViewer: () => null }));
vi.mock("../../components/redaction/VideoRedactionViewer", () => ({ VideoRedactionViewer: () => null }));
vi.mock("../../components/redaction/VideoReviewWorkspace", () => ({ VideoReviewWorkspace: () => null }));
vi.mock("../../components/redaction/DetectionReviewPanel", () => ({
  DetectionReviewPanel: ({ versionLocked }: { versionLocked: boolean }) => (
    <div data-testid="detection-panel" data-locked={String(versionLocked)} />
  ),
}));
vi.mock("../../components/redaction/DetectionManifestPanel", () => ({ DetectionManifestPanel: () => null }));
vi.mock("../../components/redaction/RegionListPanel", () => ({ RegionListPanel: () => null }));
vi.mock("../../components/redaction/RedactionActivityPanel", () => ({ RedactionActivityPanel: () => null }));

import RedactionProjectPage from "../../app/(app)/redaction/[projectId]/page";
import RedactionProjectsPage from "../../app/(app)/redaction/page";

const projectId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const derivativeId = "66666666-6666-4666-8666-666666666666";

function project(versionState: string) {
  return {
    id: projectId, evidenceId: "ev-1", artifactKind: "IMAGE", title: "Bodycam still", state: "OPEN",
    publishedVersion: null, limitations: [],
    versions: [{
      id: versionId, versionOrdinal: 1, state: versionState, authoredByUserId: "u-author",
      createdAtUtc: "2026-02-01T00:00:00.000Z", submittedAtUtc: null, approvedAtUtc: null, publishedAtUtc: null,
      rationale: null, regionCount: 0, regions: [], acceptedDetectionCount: 0, rejectedDetectionCount: 0,
      approvals: [], derivative: { id: derivativeId, state: "READY", kind: "IMAGE", fileSha256: null, failureReason: null },
    }],
  };
}
function resolved<T>(value: T) {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

let versionState = "APPROVED";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  ctx.redactionIncluded = false;
  versionState = "APPROVED";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith(`/v1/redaction/projects/${projectId}`) && method === "GET") return json(200, { project: project(versionState) });
    if (u.endsWith(`/v1/redaction/derivatives/${derivativeId}/download-url`)) return json(200, { downloadUrl: "https://files.example/redacted.png" });
    if (u.endsWith("/v1/redaction/projects") && method === "GET")
      return json(200, { projects: [{ id: projectId, evidenceId: "ev-1", artifactKind: "IMAGE", title: "Bodycam still", state: "OPEN", createdAtUtc: "2026-02-01T00:00:00.000Z", versionCount: 1 }] });
    if (u.endsWith("/v1/redaction/workspace/summary"))
      return json(200, { summary: { pendingDecisionCount: 0, awaitingApprovalCount: 0, approvedPendingDerivativeCount: 0, publishedCount: 0, rejectedCount: 0 } });
    if (u.endsWith("/v1/redaction/providers/health")) return json(403, { denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_REDACTION" });
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("open", vi.fn(() => ({ location: { href: "" }, close: vi.fn(), opener: null })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const writes = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit)?.method ?? "GET") !== "GET");

describe("PRO-R3-06 redaction after the entitlement lapses", () => {
  it("an existing project opens read-only with download and quarantine", async () => {
    render(<RedactionProjectPage params={resolved({ projectId })} />);
    await screen.findByText("Redaction is no longer included in this workspace's plan");
    // New work is not offered.
    expect(screen.queryByRole("button", { name: /New version/ })).toBeNull();
    for (const name of ["Submit for approval", "Approve", "Request changes", "Reject", "Publish", "Request redacted copy"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByTestId("detection-panel").getAttribute("data-locked")).toBe("true");
    // Reads, the download and the protective quarantine stay.
    expect(screen.getByRole("button", { name: "Quarantine redacted copy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download redacted copy" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith(`/v1/redaction/derivatives/${derivativeId}/download-url`))).toBe(true),
    );
    expect(writes()).toHaveLength(0);
  });

  it("a DRAFT version is shown locked while the entitlement is lapsed", async () => {
    versionState = "DRAFT";
    render(<RedactionProjectPage params={resolved({ projectId })} />);
    await screen.findByText("Redaction is no longer included in this workspace's plan");
    expect(screen.getByTestId("detection-panel").getAttribute("data-locked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Submit for approval" })).toBeNull();
  });

  it("an entitled workspace keeps every authoring control", async () => {
    ctx.redactionIncluded = true;
    versionState = "DRAFT";
    render(<RedactionProjectPage params={resolved({ projectId })} />);
    await screen.findByRole("button", { name: /New version/ });
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeTruthy();
    expect(screen.getByTestId("detection-panel").getAttribute("data-locked")).toBe("false");
    expect(screen.queryByText("Redaction is no longer included in this workspace's plan")).toBeNull();
  });

  it("the project list stays readable and does not offer opening a new project", async () => {
    render(<RedactionProjectsPage />);
    await screen.findByText("Redaction is no longer included in this workspace's plan");
    await screen.findByText("Bodycam still");
    expect(screen.queryByRole("button", { name: /Open project|Open redaction project/i })).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const m = { fetch: vi.fn(), confirm: vi.fn(), generation: 0, guard: null as unknown, quarantined: false };
  m.guard = {
    stamp: () => m.generation,
    isStale: (captured: number) => captured !== m.generation,
    generation: 0,
  };
  return m;
});
// The render harness runs React 18, which has no `use`; the page only reads
// an already-resolved params promise, so read its settled value.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, use: (p: { value: unknown }) => p.value };
});
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../lib/platform-context", () => ({
  useTeamId: () => "team-1",
  useTenantGuard: () => mocks.guard,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
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
vi.mock("../../components/redaction/DetectionReviewPanel", () => ({ DetectionReviewPanel: () => null }));
vi.mock("../../components/redaction/DetectionManifestPanel", () => ({ DetectionManifestPanel: () => null }));
vi.mock("../../components/redaction/RegionListPanel", () => ({ RegionListPanel: () => null }));
vi.mock("../../components/redaction/RedactionActivityPanel", () => ({ RedactionActivityPanel: () => null }));

import RedactionProjectPage from "../../app/(app)/redaction/[projectId]/page";

const projectId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const derivativeId = "33333333-3333-4333-8333-333333333333";
const projectUrl = `/v1/redaction/projects/${projectId}`;
const quarantineUrl = `/v1/redaction/derivatives/${derivativeId}/quarantine`;
const SUCCESS = "Redacted copy quarantined. The saved project shows it as quarantined.";

function project(derivativeState: string) {
  return {
    schemaVersion: "x", generatedAtUtc: "2026-02-02T00:00:00.000Z", id: projectId, evidenceId: "ev-1",
    artifactKind: "IMAGE", title: "Bodycam still", state: "OPEN", publishedVersion: null, limitations: [],
    versions: [{
      id: versionId, versionOrdinal: 1, state: "APPROVED", authoredByUserId: "author",
      createdAtUtc: "2026-02-01T00:00:00.000Z", submittedAtUtc: null, approvedAtUtc: null, publishedAtUtc: null,
      rationale: null, regionCount: 0, regions: [], acceptedDetectionCount: 0, rejectedDetectionCount: 0,
      approvals: [], derivative: { id: derivativeId, state: derivativeState, kind: "IMAGE", fileSha256: null, failureReason: null },
    }],
  };
}
function resolved<T>(value: T) {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}
function writes() {
  return mocks.fetch.mock.calls.filter(([path, init]) => path === quarantineUrl && init?.method === "POST");
}

beforeEach(() => {
  mocks.quarantined = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === quarantineUrl && init?.method === "POST") { mocks.quarantined = true; return { derivativeId, quarantined: true }; }
    if (path === projectUrl) return { project: project(mocks.quarantined ? "QUARANTINED" : "READY") };
    return {};
  });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

async function openForm() {
  render(<RedactionProjectPage params={resolved({ projectId })} />);
  const toggle = await screen.findByRole("button", { name: "Quarantine redacted copy" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
  const field = screen.getByLabelText(/Reason for quarantine/);
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.contains(field)).toBe(true);
  return { toggle, field: field as HTMLTextAreaElement };
}

describe("redaction derivative quarantine", () => {
  it("focuses the reason, explains the disabled submit, confirms, sends the reason and announces only after the reread", async () => {
    const { field } = await openForm();
    await waitFor(() => expect(document.activeElement).toBe(field));
    const submit = screen.getByRole("button", { name: "Quarantine copy" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(submit.getAttribute("data-disabled-reason")).toBe("Enter the reason for quarantining this copy.");
    fireEvent.change(field, { target: { value: "x".repeat(121) } });
    expect(submit.getAttribute("data-disabled-reason")).toBe("Keep the reason to 120 characters or fewer.");
    fireEvent.change(field, { target: { value: "  Source hash mismatch  " } });
    fireEvent.click(submit);
    await screen.findByText(SUCCESS);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Quarantine this redacted copy?", tone: "danger" }));
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ reason: "Source hash mismatch" });
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([path, init]) => path === quarantineUrl && init?.method === "POST");
    expect(calls.slice(write + 1).some(([path]) => path === projectUrl)).toBe(true);
    // The reread copy is quarantined: no re-quarantine, no download.
    expect(screen.queryByRole("button", { name: "Quarantine redacted copy" })).toBeNull();
    expect(screen.getByText(/This copy is quarantined/)).toBeTruthy();
    expect(screen.queryByText("Download redacted copy")).toBeNull();
  });

  it("cancelling the confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    const { field } = await openForm();
    fireEvent.change(field, { target: { value: "Integrity unknown" } });
    fireEvent.click(screen.getByRole("button", { name: "Quarantine copy" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Quarantine copy" }).hasAttribute("disabled")).toBe(false));
    expect(writes()).toHaveLength(0);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("cancelling the form restores focus to its toggle and sends nothing", async () => {
    const { toggle } = await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Reason for quarantine/)).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(writes()).toHaveLength(0);
  });

  it("renders the administrator refusal without claiming success", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === quarantineUrl && init?.method === "POST") throw { statusCode: 403, code: "NOT_PERMITTED" };
      if (path === projectUrl) return { project: project("READY") };
      return {};
    });
    const { field } = await openForm();
    fireEvent.change(field, { target: { value: "Integrity unknown" } });
    fireEvent.click(screen.getByRole("button", { name: "Quarantine copy" }));
    const alert = await screen.findByText("Only redaction administrators can quarantine a redacted copy.");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("does not announce success when the reread still shows a usable copy", async () => {
    mocks.fetch.mockImplementation(async (path: string) => (path === projectUrl ? { project: project("READY") } : {}));
    const { field } = await openForm();
    fireEvent.change(field, { target: { value: "Integrity unknown" } });
    fireEvent.click(screen.getByRole("button", { name: "Quarantine copy" }));
    await screen.findByText(/does not show the copy as quarantined yet/);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("does not announce success when the reread fails", async () => {
    let posted = false;
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === quarantineUrl) { posted = true; return {}; }
      if (path === projectUrl && posted) throw { statusCode: 503 };
      if (path === projectUrl) return { project: project("READY") };
      return {};
    });
    const { field } = await openForm();
    fireEvent.change(field, { target: { value: "Integrity unknown" } });
    fireEvent.click(screen.getByRole("button", { name: "Quarantine copy" }));
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });
});

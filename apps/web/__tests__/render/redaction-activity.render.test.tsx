import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const m = { fetch: vi.fn(), confirm: vi.fn(), generation: 0, guard: null as unknown };
  // A stable guard object, as the real memoised hook returns.
  m.guard = {
    stamp: () => m.generation,
    isStale: (captured: number) => captured !== m.generation,
    generation: 0,
  };
  return m;
});
// The render harness runs React 18, which has no `use`; the page only
// reads an already-resolved params promise, so read its settled value.
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
  useStepUpAction: () => ({ runStepUpAction: async (fn: (h?: Record<string, string>) => Promise<unknown>) => fn() }),
  StepUpModal: () => null,
}));

vi.mock("../../components/redaction/ImageRedactionViewer", () => ({ ImageRedactionViewer: () => null }));
vi.mock("../../components/redaction/PdfRedactionViewer", () => ({ PdfRedactionViewer: () => null }));
vi.mock("../../components/redaction/VideoRedactionViewer", () => ({ VideoRedactionViewer: () => null }));
vi.mock("../../components/redaction/VideoReviewWorkspace", () => ({ VideoReviewWorkspace: () => null }));
vi.mock("../../components/redaction/DetectionReviewPanel", () => ({ DetectionReviewPanel: () => null }));
vi.mock("../../components/redaction/DetectionManifestPanel", () => ({ DetectionManifestPanel: () => null }));
vi.mock("../../components/redaction/RegionListPanel", () => ({ RegionListPanel: () => null }));

import { RedactionActivityPanel } from "../../components/redaction/RedactionActivityPanel";
import RedactionProjectPage from "../../app/(app)/redaction/[projectId]/page";

const projectId = "11111111-1111-4111-8111-111111111111";
const v1 = "22222222-2222-4222-8222-222222222221";
const v2 = "22222222-2222-4222-8222-222222222222";
const versions = [{ id: v2, versionOrdinal: 2 }, { id: v1, versionOrdinal: 1 }];
const activityUrl = `/v1/redaction/projects/${projectId}/activity`;
const rows = [
  { id: "a2", code: "VERSION_SUBMITTED", versionId: v2, actorUserId: "actor-user-id", occurredAtUtc: "2026-02-02T10:00:00.000Z" },
  { id: "a1", code: "PROJECT_OPENED", versionId: null, actorUserId: null, occurredAtUtc: "2026-02-01T10:00:00.000Z" },
];
function version(id: string, ordinal: number, state = "DRAFT") {
  return {
    id, versionOrdinal: ordinal, state, authoredByUserId: "author", createdAtUtc: "2026-02-01T00:00:00.000Z",
    submittedAtUtc: null, approvedAtUtc: null, publishedAtUtc: null, rationale: null, regionCount: 0, regions: [],
    acceptedDetectionCount: 0, rejectedDetectionCount: 0, approvals: [], derivative: null,
  };
}
const project = {
  schemaVersion: "x", generatedAtUtc: "2026-02-02T00:00:00.000Z", id: projectId, evidenceId: "ev-1",
  artifactKind: "IMAGE", title: "Bodycam still", state: "OPEN", publishedVersion: null,
  versions: [version(v2, 2), version(v1, 1)], limitations: [],
};
function resolved<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

beforeEach(() => {
  mocks.generation = 0;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === activityUrl) return { activity: rows };
    if (path === `/v1/redaction/projects/${projectId}`) return { project };
    return {};
  });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

function activityCalls() {
  return mocks.fetch.mock.calls.filter(([path]) => path === activityUrl).length;
}

describe("redaction project activity timeline", () => {
  it("renders newest-first rows with labels, version ordinals and actor as secondary detail", async () => {
    render(<RedactionActivityPanel projectId={projectId} versions={versions} selectedVersionId={v2} revision={0} />);
    const list = await screen.findByRole("list");
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Version v2");
    expect(items[0].textContent).not.toContain("VERSION_SUBMITTED");
    expect(items[0].querySelector("code[data-identifier]")?.textContent).toBe("actor-user-id");
    expect(items[1].textContent).toContain("Project");
    expect(items[1].textContent).toContain("Recorded by the system");
  });

  it("filters to the selected version", async () => {
    render(<RedactionActivityPanel projectId={projectId} versions={versions} selectedVersionId={v1} revision={0} />);
    await screen.findByRole("list");
    fireEvent.click(screen.getByLabelText("Only version v1"));
    await screen.findByText("No activity is recorded for this version yet.");
  });

  it("never renders a refused read as empty", async () => {
    mocks.fetch.mockRejectedValue({ statusCode: 403 });
    render(<RedactionActivityPanel projectId={projectId} versions={versions} selectedVersionId={null} revision={0} />);
    await screen.findByText(/do not have access to this project/);
    expect(screen.queryByText(/No activity is recorded/)).toBeNull();
  });

  it("never renders a failed read as empty", async () => {
    mocks.fetch.mockRejectedValue({ statusCode: 503 });
    render(<RedactionActivityPanel projectId={projectId} versions={versions} selectedVersionId={null} revision={0} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/503/);
    expect(screen.queryByText(/No activity is recorded/)).toBeNull();
  });

  it("shows a successful empty timeline truthfully", async () => {
    mocks.fetch.mockResolvedValue({ activity: [] });
    render(<RedactionActivityPanel projectId={projectId} versions={versions} selectedVersionId={null} revision={0} />);
    await screen.findByText("No activity is recorded for this project yet.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a response that lands after a workspace switch", async () => {
    let resolveOld!: (v: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    render(<RedactionActivityPanel projectId={projectId} versions={versions} selectedVersionId={null} revision={0} />);
    mocks.generation = 1;
    await act(async () => { resolveOld({ activity: rows }); });
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("the project page mounts the timeline and rereads it after a page mutation", async () => {
    render(<RedactionProjectPage params={resolved({ projectId })} />);
    await screen.findByRole("heading", { name: "Activity timeline" });
    await waitFor(() => expect(activityCalls()).toBe(1));
    fireEvent.click(screen.getByText("Submit for approval"));
    await waitFor(() => expect(activityCalls()).toBe(2));
    const submit = mocks.fetch.mock.calls.findIndex(([path, init]) => path === `/v1/redaction/versions/${v2}/submit` && init?.method === "POST");
    const paths = mocks.fetch.mock.calls.map((call) => call[0] as string);
    const reread = paths.lastIndexOf(activityUrl);
    expect(submit).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(submit);
  });

  it("the project page reports a failed first load instead of loading forever", async () => {
    mocks.fetch.mockRejectedValue({ statusCode: 404 });
    render(<RedactionProjectPage params={resolved({ projectId })} />);
    await screen.findByText(/This redaction project could not be loaded/);
  });
});

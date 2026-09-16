import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportSnapshotsPanel } from "../../components/governance-experience/ExportSnapshotsPanel";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { id, evidenceId: null, createdAt: "2026-01-01T00:00:00.000Z", createdByUserId: "recorded-actor", snapshotKind: "AUDIT_EXPORT", lifecycleState: "ACTIVE", snapshotHash: "fixture-hash", exportEligibilityOutcome: "ALLOWED", exportEligibilityReason: "no_active_hold", activeHoldIds: [], governanceIncidentIds: [], retentionPolicyVersionId: null };
function page(snapshots = [snapshot], nextCursor: string | null = null) { return { snapshots, nextCursor, creation: { allowed: true, reason: null } }; }
function defaultReply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST") return { snapshot };
  if (path.includes("/verify?")) return { valid: true };
  if (path.includes("/" + id + "?")) return { snapshot };
  return page();
}
beforeEach(() => { mocks.fetch.mockReset(); mocks.fetch.mockImplementation(async (path, init) => defaultReply(path, init)); mocks.confirm.mockReset(); mocks.confirm.mockResolvedValue(true); });
afterEach(cleanup);
async function ready() { await screen.findByRole("button", { name: "View snapshot " + id }); }

describe("export snapshot operator workflow", () => {
  it("records after confirmation and rereads the saved ID before announcing success", async () => {
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Record snapshot" }));
    await screen.findByText("Snapshot recorded and reread from the saved record.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Record export snapshot?" }));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(JSON.parse(calls[write][1].body)).toEqual({ teamId, snapshotKind: "AUDIT_EXPORT", evidenceId: null });
    expect(calls.slice(write + 1).some(([path]) => path === "/v1/governance/export-snapshots/" + id + "?teamId=" + teamId)).toBe(true);
    expect(await screen.findByText("recorded-actor")).toBeTruthy();
    expect(calls[write][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Record snapshot" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record snapshot" }).hasAttribute("disabled")).toBe(false));
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("explains server-denied creation without inferring a role", async () => {
    mocks.fetch.mockResolvedValue({ ...page(), creation: { allowed: false, reason: "Request export access from your workspace administrator." } });
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    const button = screen.getByRole("button", { name: "Record snapshot" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Request export access from your workspace administrator.");
  });
  it("validates evidence IDs and submits the selected purpose and evidence", async () => {
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.change(screen.getByLabelText("Evidence ID (optional)"), { target: { value: "wrong" } });
    expect(screen.getByRole("button", { name: "Record snapshot" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Evidence ID (optional)"), { target: { value: id } });
    fireEvent.change(screen.getByLabelText("Snapshot purpose"), { target: { value: "EVIDENCE_PACKAGE" } });
    fireEvent.click(screen.getByRole("button", { name: "Record snapshot" }));
    await screen.findByText("Snapshot recorded and reread from the saved record.");
    const write = mocks.fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(write![1].body)).toEqual({ teamId, snapshotKind: "EVIDENCE_PACKAGE", evidenceId: id });
  });
  it("never calls a refused list empty", async () => {
    mocks.fetch.mockRejectedValue({ statusCode: 403 });
    render(<ExportSnapshotsPanel teamId={teamId} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("No snapshots match these filters.")).toBeNull();
    expect(screen.getByRole("button", { name: "Record snapshot" }).hasAttribute("disabled")).toBe(true);
  });
  it("shows a successful empty list truthfully", async () => {
    mocks.fetch.mockResolvedValue(page([]));
    render(<ExportSnapshotsPanel teamId={teamId} />);
    await screen.findByText("No snapshots match these filters.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("uses the server cursor and resets it when filters change", async () => {
    mocks.fetch.mockImplementation(async (path: string) => page([snapshot], new URL(path, "http://localhost").searchParams.has("cursor") ? null : "server-cursor"));
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2"); await ready();
    expect(mocks.fetch.mock.calls.at(-1)![0]).toContain("cursor=server-cursor");
    fireEvent.change(screen.getByLabelText("Filter by purpose"), { target: { value: "COMPLIANCE_BUNDLE" } });
    await screen.findByText("Page 1"); await ready();
    const query = new URL(mocks.fetch.mock.calls.at(-1)![0], "http://localhost").searchParams;
    expect(query.get("snapshotKind")).toBe("COMPLIANCE_BUNDLE");
    expect(query.has("cursor")).toBe(false);
  });
  it("ignores a stale response after changing a filter", async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(page([]));
    render(<ExportSnapshotsPanel teamId={teamId} />);
    fireEvent.change(screen.getByLabelText("Filter by purpose"), { target: { value: "COMPLIANCE_BUNDLE" } });
    await screen.findByText("No snapshots match these filters.");
    await act(async () => { resolveOld(page()); });
    expect(screen.queryByRole("button", { name: "View snapshot " + id })).toBeNull();
  });
  it("drops the previous workspace detail and its pending response on switch", async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.fetch.mockImplementation(async (path: string) => path.includes("/" + id + "?") ? new Promise(resolve => { resolveOld = resolve; }) : page());
    const view = render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "View snapshot " + id }));
    await screen.findByText("Loading snapshot details…");
    view.rerender(<ExportSnapshotsPanel teamId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />);
    await act(async () => { resolveOld({ snapshot }); });
    expect(screen.queryByRole("region", { name: "Snapshot details" })).toBeNull();
  });
  it("reports creation refusal without claiming success", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => { if (init?.method === "POST") throw { statusCode: 403 }; return defaultReply(path, init); });
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Record snapshot" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Snapshot recorded and reread from the saved record.")).toBeNull();
  });
  it("does not claim confirmed success when the durable reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => { if (path.includes("/" + id + "?")) throw { statusCode: 503 }; return defaultReply(path, init); });
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Record snapshot" }));
    await screen.findByText("Snapshot recorded, but its saved details could not be reloaded. Refresh the snapshot before creating another.");
    expect(screen.queryByText("Snapshot recorded and reread from the saved record.")).toBeNull();
    expect(screen.getByRole("button", { name: "Record snapshot" }).hasAttribute("disabled")).toBe(true);
  });
  it.each([true, false])("renders the authoritative integrity result: %s", async (valid) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => path.includes("/verify?") ? { valid } : defaultReply(path, init));
    render(<ExportSnapshotsPanel teamId={teamId} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "View snapshot " + id }));
    fireEvent.click(await screen.findByRole("button", { name: "Verify integrity" }));
    await screen.findByText(valid ? /Integrity verified:/ : /Integrity check failed:/);
  });
});

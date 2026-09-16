import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const me = "99999999-9999-4999-8999-999999999991";
const other = "99999999-9999-4999-8999-999999999992";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  confirm: vi.fn(),
  envelope: { account: { userId: "99999999-9999-4999-8999-999999999991" } },
  assignee: null as string | null,
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpaceId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  usePlatformContext: () => ({ envelope: mocks.envelope }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import QcPage from "../../app/(app)/review/qc/page";

const sampleId = "11111111-1111-4111-8111-111111111111";
const workflowId = "22222222-2222-4222-8222-222222222222";
const samplesUrl = `/v1/reviewer/qc/samples?limit=100&teamId=${teamId}`;
const mineUrl = `/v1/reviewer/qc/samples?limit=100&mine=true&teamId=${teamId}`;
const assignUrl = `/v1/reviewer/qc/samples/${sampleId}/assign?teamId=${teamId}`;
const SUCCESS = "QC reviewer assigned. The saved sample shows the new assignee.";
let capabilities = ["review.assign", "review.qc.verdict"];

function sample(qcReviewerUserId: string | null) {
  return { id: sampleId, workflowId, state: qcReviewerUserId ? "ASSIGNED" : "SAMPLED", verdict: null, failureReason: null, sampledAtUtc: "2026-02-01T00:00:00.000Z", qcReviewerUserId };
}
function assignWrites() {
  return mocks.fetch.mock.calls.filter(([path, init]) => path === assignUrl && init?.method === "POST");
}

beforeEach(() => {
  capabilities = ["review.assign", "review.qc.verdict"];
  mocks.assignee = null;
  mocks.envelope = { account: { userId: me } };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/v1/reviewer/workspace")) return { workspace: { capabilities } };
    if (path.startsWith("/v1/reviewer-ops/assignable-reviewers")) {
      return { reviewers: [{ userId: me, displayName: "Dana Reviewer" }, { userId: other, displayName: "Sam Checker" }] };
    }
    if (path === assignUrl && init?.method === "POST") { mocks.assignee = JSON.parse(String(init.body)).qcReviewerUserId; return { ok: true }; }
    if (path === samplesUrl) return { samples: [sample(mocks.assignee)] };
    if (path === mineUrl) return { samples: mocks.assignee === me ? [sample(me)] : [] };
    return { ok: true };
  });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

function verdictButton(label: string) {
  return screen.getByRole("button", { name: `${label} verdict` });
}
async function openAssign(name = "Assign QC reviewer") {
  render(<QcPage />);
  const toggle = await screen.findByRole("button", { name });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const select = await screen.findByLabelText("QC reviewer");
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.contains(select)).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(select));
  return { toggle, select };
}

describe("QC sample assignment", () => {
  it("explains that an unassigned sample cannot take a verdict", async () => {
    render(<QcPage />);
    await screen.findByRole("button", { name: "Assign QC reviewer" });
    for (const label of ["Pass", "Fail", "Partial"]) {
      const button = verdictButton(label);
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("data-disabled-reason")).toBe("Assign a QC reviewer before recording a verdict.");
    }
    expect(within(document.querySelector("[data-qc-assignee]") as HTMLElement).getByText("Unassigned")).toBeTruthy();
  });

  it("assigns the chosen member, rereads the samples, and enables verdicts for the assignee", async () => {
    const { select } = await openAssign();
    const submit = screen.getByRole("button", { name: "Assign" });
    expect(submit.getAttribute("data-disabled-reason")).toBe("Choose a reviewer.");
    fireEvent.change(select, { target: { value: me } });
    fireEvent.click(submit);
    await screen.findByText(SUCCESS);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(assignWrites()).toHaveLength(1);
    expect(JSON.parse(assignWrites()[0][1].body)).toEqual({ qcReviewerUserId: me });
    const paths = mocks.fetch.mock.calls.map((c) => c[0] as string);
    expect(paths.lastIndexOf(samplesUrl)).toBeGreaterThan(paths.indexOf(assignUrl));
    expect((document.querySelector("[data-qc-assignee]") as HTMLElement).textContent).toBe("You");
    expect(verdictButton("Pass").hasAttribute("disabled")).toBe(false);
    expect(screen.queryByLabelText("QC reviewer")).toBeNull();
  });

  it("keeps verdicts disabled with a reason when someone else is assigned", async () => {
    mocks.assignee = other;
    render(<QcPage />);
    await screen.findByRole("button", { name: "Reassign QC reviewer" });
    await waitFor(() => expect((document.querySelector("[data-qc-assignee]") as HTMLElement).textContent).toBe("Sam Checker"));
    expect(verdictButton("Pass").getAttribute("data-disabled-reason")).toBe("Only the assigned QC reviewer can record this verdict.");
  });

  it("confirms a reassignment, and cancelling it makes no write", async () => {
    mocks.assignee = other;
    mocks.confirm.mockResolvedValue(false);
    const { select } = await openAssign("Reassign QC reviewer");
    fireEvent.change(select, { target: { value: me } });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Reassign this QC sample?" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Assign" }).hasAttribute("disabled")).toBe(false));
    expect(assignWrites()).toHaveLength(0);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("cancelling the form restores focus and sends nothing", async () => {
    const { toggle } = await openAssign();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("QC reviewer")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(assignWrites()).toHaveLength(0);
  });

  it("explains why a reviewer without assign rights cannot assign", async () => {
    capabilities = ["review.qc.verdict"];
    render(<QcPage />);
    const toggle = await screen.findByRole("button", { name: "Assign QC reviewer" });
    await waitFor(() => expect(toggle.getAttribute("data-disabled-reason")).toBe("Only reviewers who can assign reviews can assign QC samples."));
    expect(mocks.fetch.mock.calls.some(([p]) => String(p).startsWith("/v1/reviewer-ops/assignable-reviewers"))).toBe(false);
  });

  it.each([
    ["NOT_PERMITTED", 409, "That person is not an active member of this workspace. Choose another reviewer."],
    ["QC_VERDICT_INVALID", 409, "This sample already has a verdict, so it can no longer be assigned. The list has been refreshed."],
    ["NOT_PERMITTED", 403, "Only reviewers who can assign reviews can assign QC samples."],
  ])("maps %s (%s) to operator language without claiming success", async (code, statusCode, text) => {
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === assignUrl) throw { statusCode, code };
      return base(path, init);
    });
    const { select } = await openAssign();
    fireEvent.change(select, { target: { value: other } });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect((await screen.findByText(text)).getAttribute("role")).toBe("alert");
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("does not announce success when the reread does not show the assignee", async () => {
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === assignUrl) return { ok: true };
      return base(path, init);
    });
    const { select } = await openAssign();
    fireEvent.change(select, { target: { value: other } });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await screen.findByText(/does not show it yet/);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("filters to samples assigned to me", async () => {
    render(<QcPage />);
    await screen.findByRole("button", { name: "Assign QC reviewer" });
    fireEvent.click(screen.getByLabelText("Only samples assigned to me"));
    await screen.findByText("No QC samples are assigned to you.");
    expect(mocks.fetch.mock.calls.some(([p]) => p === mineUrl)).toBe(true);
  });

  it("never renders a refused or failed sample read as empty", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/reviewer/workspace")) return { workspace: { capabilities } };
      if (path.startsWith("/v1/reviewer-ops")) return { reviewers: [] };
      throw { statusCode: 403 };
    });
    render(<QcPage />);
    await screen.findByText("You do not have access to QC samples in this workspace.");
    expect(screen.queryByText("No QC samples are available in this workspace yet.")).toBeNull();
    expect(screen.queryByText("Pending (0)")).toBeNull();
  });
});

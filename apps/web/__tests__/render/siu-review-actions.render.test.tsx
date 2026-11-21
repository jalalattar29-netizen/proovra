/**
 * PRO-CENZ-01 — the SIU reviewer actions on the investigation profile
 * (EP-1082 map a record, EP-1083 checklist status, EP-1084 mark evidence gap,
 * EP-1085 request follow-up, EP-1086 follow-up status).
 *
 * The real SiuPanel over the REAL apiFetch and a stubbed network. The actions
 * are offered only when the profile read says `viewer.canWrite` (the write
 * routes' own gate); a reader who may not write sees the server's reason; a
 * refusal is said and the profile re-read.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { chooseListbox } from "./_listbox";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { SiuPanel } from "../../app/(app)/cases/components/SiuPanel";

const CASE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TEAM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BASE = `/v1/cases/${CASE}/siu-profile`;
const EV1 = "e1eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const EV2 = "e2eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FU = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function profile(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    caseId: CASE,
    teamId: TEAM,
    createdAtUtc: "2026-11-20T00:00:00.000Z",
    updatedAtUtc: "2026-11-20T00:00:00.000Z",
    claimType: "auto",
    investigationStatus: "collecting",
    claimNumber: null,
    policyReference: null,
    incidentDate: null,
    incidentLocation: null,
    lossDescription: null,
    assignedAdjusterUserId: null,
    assignedSIUReviewerUserId: null,
    claimantName: null,
    claimantContact: null,
    privacyGatedFieldsExposed: false,
    intakeTemplateId: null,
    checklist: [
      { itemId: "scene_overview", label: "Scene overview", required: true, status: "missing", mappedEvidenceIds: [EV1], note: null },
      { itemId: "police_report", label: "Police report", required: true, status: "missing", mappedEvidenceIds: [], note: null },
    ],
    reviewIndicators: [],
    followUps: [],
    ...over,
  };
}

const writer = { canWrite: true, disabledCode: null, disabledReason: null };

type Call = { path: string; method: string; body: Record<string, unknown> | null };
let calls: Call[];
let routes: Record<string, (call: Call) => Response | Promise<Response>>;

beforeEach(() => {
  calls = [];
  routes = {
    [`GET /v1/cases/${CASE}/siu-exports`]: () => json(200, { exports: [] }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] as string;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const call = { path, method, body };
      calls.push(call);
      const handler = routes[`${method} ${path}`];
      return handler ? handler(call) : json(404, { error: { code: "not_found" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const options = [
  { id: EV1, label: "Bumper photo" },
  { id: EV2, label: "Dashcam clip" },
];

function mount() {
  return render(<SiuPanel caseId={CASE} teamId={TEAM} evidenceOptions={options} />);
}

async function openItem(container: HTMLElement, itemId: string) {
  fireEvent.click(container.querySelector(`[data-testid="siu-item-act-${itemId}"]`) as HTMLButtonElement);
  await settle();
}

describe("SIU reviewer actions — offered to a writer, by the server's projection", () => {
  it("EP-1083: a status change posts the bounded body and shows the server's profile", async () => {
    routes[`GET ${BASE}`] = () => json(200, { profile: profile(), viewer: writer });
    routes[`POST ${BASE}/checklist/police_report/status`] = (c) =>
      json(200, {
        profile: profile({
          checklist: [
            profile().checklist[0],
            { ...profile().checklist[1], status: c.body?.status, note: c.body?.note },
          ],
        }),
      });
    const { container } = mount();
    await settle();
    expect(screen.getByRole("columnheader", { name: "Action" })).toBeTruthy();
    await openItem(container, "police_report");

    chooseListbox(container.querySelector('[data-testid="siu-item-status"]'), "waived");
    fireEvent.change(screen.getByLabelText("Status note"), { target: { value: "Not applicable: no police attended" } });
    fireEvent.click(container.querySelector('[data-testid="siu-item-status-save"]') as HTMLButtonElement);
    await settle();

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ status: "waived", note: "Not applicable: no police attended" });
    const rows = Array.from(container.querySelectorAll('[data-testid="siu-checklist"] tbody tr'));
    expect(rows[1]!.textContent).toContain("Waived");
    expect(screen.getByText("Status saved.")).toBeTruthy();
  });

  it("EP-1082: only records of the case not yet mapped are offered, and the mapping posts the record id", async () => {
    routes[`GET ${BASE}`] = () => json(200, { profile: profile(), viewer: writer });
    routes[`POST ${BASE}/checklist/scene_overview/map-evidence`] = () =>
      json(200, {
        profile: profile({
          checklist: [{ ...profile().checklist[0], status: "mapped", mappedEvidenceIds: [EV1, EV2] }, profile().checklist[1]],
        }),
      });
    const { container } = mount();
    await settle();
    await openItem(container, "scene_overview");
    // EV1 is already mapped to this item: only EV2 is offered.
    const trigger = container.querySelector('[data-testid="siu-item-map-evidence"]') as HTMLElement;
    expect(trigger.textContent).toContain("Dashcam clip");
    fireEvent.click(container.querySelector('[data-testid="siu-item-map-submit"]') as HTMLButtonElement);
    await settle();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ evidenceId: EV2 });
    const firstRow = container.querySelector('[data-testid="siu-checklist"] tbody tr') as HTMLElement;
    expect(firstRow.textContent).toContain("Mapped");
    expect(firstRow.textContent).toContain("2");
    // Every record is now mapped: nothing more to offer.
    expect(container.querySelector('[data-testid="siu-item-map-none"]')?.textContent).toContain("already mapped");
  });

  it("EP-1082: with no record of the case open to the reader, mapping says to link one first", async () => {
    routes[`GET ${BASE}`] = () => json(200, { profile: profile(), viewer: writer });
    const { container } = render(<SiuPanel caseId={CASE} teamId={TEAM} />);
    await settle();
    await openItem(container, "police_report");
    expect(container.querySelector('[data-testid="siu-item-map-none"]')?.textContent).toContain("Link a record to the case first");
    expect(container.querySelector('[data-testid="siu-item-map-submit"]')).toBeNull();
  });

  it("EP-1084: Mark evidence gap records a MISSING_REQUIRED_EVIDENCE indicator, listed as a signal", async () => {
    routes[`GET ${BASE}`] = () => json(200, { profile: profile(), viewer: writer });
    routes[`POST ${BASE}/indicators`] = (c) =>
      json(200, {
        profile: profile({
          reviewIndicators: [
            { code: c.body?.code, explanation: c.body?.explanation, evidenceId: null, observedAtUtc: "2026-11-21T00:00:00.000Z", severity: c.body?.severity },
          ],
        }),
      });
    const { container } = mount();
    await settle();
    expect(container.querySelector('[data-testid="siu-indicators-empty"]')).not.toBeNull();
    await openItem(container, "police_report");
    expect((screen.getByLabelText("What is missing") as HTMLInputElement).value).toBe("Required evidence is missing: Police report");
    chooseListbox(container.querySelector('[data-testid="siu-item-gap-severity"]'), "block_export");
    fireEvent.click(container.querySelector('[data-testid="siu-item-gap-submit"]') as HTMLButtonElement);
    await settle();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      code: "MISSING_REQUIRED_EVIDENCE",
      explanation: "Required evidence is missing: Police report",
      severity: "block_export",
    });
    const list = container.querySelector('[data-testid="siu-indicators"]')?.textContent ?? "";
    expect(list).toContain("Required evidence is missing: Police report");
    expect(list).toContain("Block export");
    expect(container.querySelector('[data-testid="siu-indicators-empty"]')).toBeNull();
  });

  it("EP-1085 then EP-1086: a follow-up is requested, listed, and moved to received with the returned record", async () => {
    let followUps: unknown[] = [];
    routes[`GET ${BASE}`] = () => json(200, { profile: profile({ followUps }), viewer: writer });
    routes[`POST ${BASE}/follow-ups`] = (c) => {
      const created = {
        id: FU,
        checklistItemId: c.body?.checklistItemId,
        status: "open",
        dueByUtc: c.body?.dueByUtc,
        requestedAtUtc: "2026-11-21T00:00:00.000Z",
        note: c.body?.note,
        intakeLinkId: null,
        receivedAtUtc: null,
        returnedEvidenceIds: [],
      };
      followUps = [created];
      return json(200, { followUp: created });
    };
    routes[`POST ${BASE}/follow-ups/${FU}/status`] = (c) => {
      followUps = [{ ...(followUps[0] as object), status: c.body?.status, returnedEvidenceIds: [c.body?.receivedEvidenceId] }];
      return json(200, { followUp: followUps[0] });
    };
    const { container } = mount();
    await settle();
    expect(container.querySelector('[data-testid="siu-follow-ups-empty"]')).not.toBeNull();
    await openItem(container, "police_report");
    fireEvent.change(screen.getByLabelText("Due by"), { target: { value: "2026-12-01" } });
    fireEvent.change(screen.getByLabelText("Follow-up note"), { target: { value: "Ask the claimant" } });
    fireEvent.click(container.querySelector('[data-testid="siu-item-follow-up-submit"]') as HTMLButtonElement);
    await settle();
    expect(calls.find((c) => c.path === `${BASE}/follow-ups`)?.body).toEqual({
      checklistItemId: "police_report",
      dueByUtc: "2026-12-01T12:00:00.000Z",
      note: "Ask the claimant",
    });
    const rowEl = container.querySelector('[data-testid="siu-follow-up-row"]') as HTMLElement;
    expect(rowEl.textContent).toContain("Police report");
    expect(rowEl.textContent).toContain("Open");

    chooseListbox(rowEl.querySelector('[data-testid="siu-follow-up-status-select"]'), "received");
    chooseListbox(rowEl.querySelector('[data-testid="siu-follow-up-received"]'), EV2);
    fireEvent.click(rowEl.querySelector('[data-testid="siu-follow-up-save"]') as HTMLButtonElement);
    await settle();
    expect(calls.find((c) => c.path === `${BASE}/follow-ups/${FU}/status`)?.body).toEqual({
      status: "received",
      receivedEvidenceId: EV2,
    });
    const after = container.querySelector('[data-testid="siu-follow-up-row"]') as HTMLElement;
    expect(after.querySelector('[data-testid="siu-follow-up-status"]')?.textContent).toBe("Received");
    expect(after.textContent).toContain("1 record(s) returned");
  });
});

describe("SIU reviewer actions — withheld and refused", () => {
  it("a reader the server says may not write gets no action, and its reason", async () => {
    routes[`GET ${BASE}`] = () =>
      json(200, {
        profile: profile({
          followUps: [
            { id: FU, checklistItemId: "police_report", status: "open", dueByUtc: null, requestedAtUtc: "2026-11-21T00:00:00.000Z", note: null, intakeLinkId: null, receivedAtUtc: null, returnedEvidenceIds: [] },
          ],
        }),
        viewer: {
          canWrite: false,
          disabledCode: "permission",
          disabledReason: "Your role can read this investigation profile but not change it.",
        },
      });
    const { container } = mount();
    await settle();
    expect(container.querySelector('[data-testid="siu-read-only"]')?.textContent).toContain("Your role can read");
    expect(container.querySelector('[data-testid^="siu-item-act-"]')).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Action" })).toBeNull();
    // The follow-up is listed, without a status control.
    expect(container.querySelector('[data-testid="siu-follow-up-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="siu-follow-up-status-select"]')).toBeNull();
  });

  it("a workspace that stopped being an Enterprise organization keeps the read and is told why it cannot write", async () => {
    routes[`GET ${BASE}`] = () =>
      json(200, {
        profile: profile(),
        viewer: {
          canWrite: false,
          disabledCode: "enterprise_required",
          disabledReason: "Investigation and SIU tools are part of an Enterprise organization workspace.",
        },
      });
    const { container } = mount();
    await settle();
    const note = container.querySelector('[data-testid="siu-read-only"]') as HTMLElement;
    expect(note.getAttribute("data-disabled-code")).toBe("enterprise_required");
    expect(note.textContent).toContain("Enterprise organization workspace");
    expect(container.querySelector('[data-testid^="siu-item-act-"]')).toBeNull();
  });

  it("an older API that projects no viewer offers no action (fail closed)", async () => {
    routes[`GET ${BASE}`] = () => json(200, { profile: profile() });
    const { container } = mount();
    await settle();
    expect(container.querySelector('[data-testid="siu-checklist"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="siu-item-act-"]')).toBeNull();
  });

  it("a flat Enterprise refusal (not an ApiError) is said in words and the profile re-read", async () => {
    let gets = 0;
    routes[`GET ${BASE}`] = () => {
      gets += 1;
      return json(200, { profile: profile(), viewer: writer });
    };
    routes[`POST ${BASE}/checklist/police_report/status`] = () =>
      json(403, {
        denial: "ENTITLEMENT_REQUIRED",
        requirement: "ENTERPRISE_ORGANIZATION_WORKSPACE",
        message: "Investigation and SIU tools are part of an Enterprise organization workspace.",
      });
    const { container } = mount();
    await settle();
    await openItem(container, "police_report");
    chooseListbox(container.querySelector('[data-testid="siu-item-status"]'), "submitted");
    fireEvent.click(container.querySelector('[data-testid="siu-item-status-save"]') as HTMLButtonElement);
    await settle();
    expect(container.querySelector('[data-testid="siu-item-error"]')?.textContent).toBe(
      "Investigation and SIU tools are part of an Enterprise organization workspace. Nothing was changed.",
    );
    expect(gets).toBe(2);
  });

  it("a nested role refusal and a record no longer open map to their own sentences", async () => {
    routes[`GET ${BASE}`] = () => json(200, { profile: profile(), viewer: writer });
    routes[`POST ${BASE}/indicators`] = () =>
      json(403, { error: { code: "permission_denied", reason: "case_mutation_denied" } });
    routes[`POST ${BASE}/checklist/police_report/map-evidence`] = () => json(404, { error: { code: "not_found" } });
    const { container } = mount();
    await settle();
    await openItem(container, "police_report");
    fireEvent.click(container.querySelector('[data-testid="siu-item-gap-submit"]') as HTMLButtonElement);
    await settle();
    expect(container.querySelector('[data-testid="siu-item-error"]')?.textContent).toContain("Your role can read");
    fireEvent.click(container.querySelector('[data-testid="siu-item-map-submit"]') as HTMLButtonElement);
    await settle();
    expect(container.querySelector('[data-testid="siu-item-error"]')?.textContent).toBe(
      "That item or record is no longer available to you. Nothing was changed.",
    );
  });

  it("no profile yet: the empty state, and no reviewer action", async () => {
    routes[`GET ${BASE}`] = () => json(404, { error: { code: "siu_profile_not_found" } });
    const { container } = mount();
    await settle();
    expect(container.querySelector('[data-testid="siu-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="siu-item-act-"]')).toBeNull();
  });
});

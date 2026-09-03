/**
 * ADMIN CONTROL PLANE — commercial-request mutations, driven for real.
 *
 * Mounts the REAL admin pages (no page code is reimplemented here) and proves
 * the mutation behaviour of the commercial queues end to end: the control is
 * discoverable, a consequential click asks FIRST and names its subject, cancel
 * sends nothing, confirm sends exactly one request with the exact body the
 * shared transition table prescribes, success is announced only after the
 * server answers (and the page re-reads rather than guessing), a failure
 * surfaces without a success indicator, a stale 409 reloads, and a disallowed
 * transition is simply not offered.
 *
 * Pages under proof:
 *   app/(app)/admin/contact-sales/page.tsx
 *   app/(app)/admin/contact-sales/[id]/page.tsx
 *   app/(app)/admin/demo-requests/page.tsx
 *
 * Mutations under proof:
 *   "PATCH /v1/admin/contact-sales/:id"
 *   "PATCH /v1/admin/demo-requests/:id"
 *   "POST /v1/admin/demo-requests/:id/route"
 *   "POST /v1/admin/demo-requests/:id/follow-up/send"
 *   "POST /v1/admin/demo-requests/follow-up/run"
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = unknown;

let requestLog: Array<{ path: string; method: string; body?: string }> = [];

/** Contact-sales list, detail read and PATCH. */
let csListReply: () => Reply = () => ({});
let csDetailReply: () => Reply = () => ({});
let csPatchReply: () => Reply = () => ({});

/** Demo-request list, detail read, PATCH, route, follow-up send / run. */
let drListReply: () => Reply = () => ({});
let drDetailReply: () => Reply = () => ({});
let drPatchReply: () => Reply = () => ({});
let drRouteReply: () => Reply = () => ({});
let drSendReply: () => Reply = () => ({});
let drRunReply: () => Reply = () => ({});

/**
 * A rejection shaped exactly like the one `apiFetch` throws: a real Error
 * carrying `statusCode`. Built by a function rather than a class so it is not
 * in the temporal dead zone when Vitest hoists the `vi.mock` factory.
 */
function apiFailure(statusCode: number): Error {
  const err = new Error("request failed") as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** The same rejection, carrying the server's canonical error CODE. */
function apiCodeFailure(statusCode: number, code: string): Error {
  const err = apiFailure(statusCode) as Error & { code: string };
  err.code = code;
  return err;
}

/** A reply the test resolves by hand, so "pending" is an observable state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The [id] page reads its params with React 19's `use(promise)`. The render
 * harness resolves React 18.3, where `use` does not exist, so the page would
 * crash on an API that production (React 19 under Next 15) provides. Polyfill
 * ONLY the fulfilled-thenable fast path — the exact semantics `use` applies to
 * the params promise this file passes — and keep everything else real.
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const use =
    (actual.use as ((p: unknown) => unknown) | undefined) ??
    ((thenable: unknown) => {
      const t = thenable as { status?: string; value?: unknown };
      if (t && t.status === "fulfilled") return t.value;
      throw thenable;
    });
  const base = (actual.default ?? actual) as Record<string, unknown>;
  return { ...actual, use, default: { ...base, use } };
});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method, body: init?.body });
    const pick = (r: Reply) => {
      if (r instanceof Error) throw r;
      return r; // a Promise reply is awaited by the caller — the deferred seam
    };
    if (path.startsWith("/v1/admin/contact-sales?")) return pick(csListReply());
    if (path.startsWith("/v1/admin/contact-sales/")) {
      return pick(method === "PATCH" ? csPatchReply() : csDetailReply());
    }
    if (path === "/v1/admin/demo-requests/follow-up/run") {
      return pick(drRunReply());
    }
    if (/^\/v1\/admin\/demo-requests\/[^/?]+\/route$/.test(path)) {
      return pick(drRouteReply());
    }
    if (/^\/v1\/admin\/demo-requests\/[^/?]+\/follow-up\/send$/.test(path)) {
      return pick(drSendReply());
    }
    if (path.startsWith("/v1/admin/demo-requests?")) return pick(drListReply());
    if (path.startsWith("/v1/admin/demo-requests/")) {
      return pick(method === "PATCH" ? drPatchReply() : drDetailReply());
    }
    throw new Error(`unrouted request in test: ${method} ${path}`);
  },
  apiBaseUrl: () => "https://api.test.invalid",
  readApiToken: () => null,
  setApiToken: () => {},
  ApiError: class ApiError extends Error {},
}));

let currentSearch = "";
let replaced: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => {
      replaced.push(href);
    },
    back: () => {},
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/admin/demo-requests",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// The [id] page wraps itself in the canonical route gate. The gate's access
// resolution is not what this file proves, so it renders its children.
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import AdminContactSalesPage from "../../app/(app)/admin/contact-sales/page";
import AdminContactSalesDetailPage from "../../app/(app)/admin/contact-sales/[id]/page";
import AdminDemoRequestsPage from "../../app/(app)/admin/demo-requests/page";

// ---------------------------------------------------------------------------
// Fixtures — minimal but shaped by the pages' own contracts
// ---------------------------------------------------------------------------

const CS_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
const DR_ID = "22222222-bbbb-4bbb-8bbb-222222222222";

function csItem(over: Record<string, unknown> = {}) {
  return {
    id: CS_ID,
    fullName: "Dana Whitfield",
    workEmail: "dana@northgate.example",
    organization: "Northgate Insurance",
    jobTitle: null,
    country: null,
    teamSize: null,
    discussionTopic: "Evidence custody",
    stage: "Evaluating",
    deploymentTimeline: null,
    estimatedUsers: null,
    sourcePage: null,
    sourcePath: null,
    status: "NEW",
    priority: "NORMAL",
    isSpam: false,
    emailSentAt: null,
    reviewedAt: null,
    reviewedByUserId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

function csDetails(over: Record<string, unknown> = {}) {
  return {
    ...csItem(),
    currentChallenge: "We need admissible screenshots.",
    additionalDetails: null,
    source: null,
    referrer: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    webhookSentAt: null,
    notes: null,
    ipAddress: null,
    userAgent: null,
    ...over,
  };
}

const CS_SUMMARY = {
  NEW: 1,
  REVIEWED: 0,
  CONTACTED: 0,
  QUALIFIED: 0,
  REJECTED: 0,
  ARCHIVED: 0,
};

function csList(items: unknown[]) {
  return { ok: true, data: { items, total: items.length, summary: CS_SUMMARY } };
}

function drItem(over: Record<string, unknown> = {}) {
  return {
    id: DR_ID,
    fullName: "Priya Raman",
    workEmail: "priya@harbor.example",
    organization: "Harbor Mutual",
    jobTitle: null,
    country: null,
    teamSize: null,
    source: null,
    sourcePath: null,
    status: "NEW",
    priority: "NORMAL",
    leadQuality: null,
    leadTrack: null,
    recommendedAction: null,
    routingTarget: null,
    routingReason: null,
    followUpStatus: "ACTIVE",
    followUpStep: 1,
    nextFollowUpAt: null,
    lastFollowUpSentAt: null,
    spamScore: 0,
    isSpam: false,
    emailSentAt: null,
    autoReplySentAt: null,
    reviewedAt: null,
    reviewedByUserId: null,
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    ...over,
  };
}

function drDetails(over: Record<string, unknown> = {}) {
  return {
    ...drItem(),
    useCase: "Insurance claim intake",
    message: null,
    referrer: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    responseSlaHours: null,
    qualificationScore: null,
    qualificationReasons: null,
    routedAt: null,
    routedByUserId: null,
    lastFollowUpTemplateKey: null,
    followUpStoppedAt: null,
    spamReasons: null,
    webhookSentAt: null,
    notes: null,
    ipAddress: null,
    userAgent: null,
    ...over,
  };
}

const DR_SUMMARY = {
  NEW: 1,
  REVIEWED: 0,
  CONTACTED: 0,
  QUALIFIED: 0,
  REJECTED: 0,
  ARCHIVED: 0,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll(sel));

const successToasts = () =>
  qa('[data-proovra-toast][data-severity="success"]');
const errorToasts = () => qa('[data-proovra-toast][data-severity="error"]');
const toastText = () =>
  qa("[data-proovra-toast]")
    .map((t) => t.textContent ?? "")
    .join(" | ");

const gets = () => requestLog.filter((r) => r.method === "GET");
const patches = () => requestLog.filter((r) => r.method === "PATCH");
const posts = () => requestLog.filter((r) => r.method === "POST");
const writes = () => requestLog.filter((r) => r.method !== "GET");

const dialog = (testId: string) =>
  q(`[data-confirm-action-modal="${testId}"]`) as HTMLElement | null;

async function click(el: Element | null) {
  expect(el, "expected the control to exist").not.toBeNull();
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}

async function confirmDialog(testId: string) {
  const d = dialog(testId);
  expect(d, `dialog ${testId} should be open`).not.toBeNull();
  await click(d!.querySelector("[data-confirm-action-submit]"));
}

async function cancelDialog(testId: string) {
  const d = dialog(testId);
  expect(d, `dialog ${testId} should be open`).not.toBeNull();
  await click(d!.querySelector("[data-confirm-action-cancel]"));
}

/**
 * React 19 `use(params)` reads a fulfilled thenable synchronously via its
 * status fields; a plain resolved Promise would suspend the first render.
 */
function resolvedParams<T extends object>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & {
    status?: string;
    value?: T;
  };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

function mountWithProviders(node: React.ReactElement) {
  cleanup();
  const utils = render(
    <ToastProvider>
      <ConfirmActionProvider>{node}</ConfirmActionProvider>
    </ToastProvider>,
  );
  return utils;
}

async function mountContactSalesList() {
  mountWithProviders(<AdminContactSalesPage />);
  await settle();
}

async function mountContactSalesDetail(id = CS_ID) {
  mountWithProviders(
    <AdminContactSalesDetailPage params={resolvedParams({ id })} />,
  );
  await settle();
}

async function mountDemoRequests() {
  mountWithProviders(<AdminDemoRequestsPage />);
  await settle();
}

/** Open the inline details panel for the fixture demo request. */
async function openDemoDetails() {
  await click(screen.getByRole("button", { name: "Priya Raman" }));
}

beforeEach(() => {
  requestLog = [];
  replaced = [];
  currentSearch = "";
  csListReply = () => csList([csItem()]);
  csDetailReply = () => ({ ok: true, data: csDetails() });
  csPatchReply = () => ({ ok: true, data: csDetails({ status: "REJECTED" }) });
  drListReply = () => ({ items: [drItem()], summary: DR_SUMMARY });
  drDetailReply = () => ({ item: drDetails() });
  drPatchReply = () => ({ ok: true });
  drRouteReply = () => ({ ok: true });
  drSendReply = () => ({ ok: true });
  drRunReply = () => ({ result: { processed: 2, sent: 2, failed: 0 } });
});

// ===========================================================================
// PATCH /v1/admin/contact-sales/:id — the detail route
// ===========================================================================

describe("Contact Sales detail — PATCH /v1/admin/contact-sales/:id", () => {
  it("offers only the transitions the shared table allows (ARCHIVED offers only Reviewed)", async () => {
    csDetailReply = () => ({ ok: true, data: csDetails({ status: "ARCHIVED" }) });
    await mountContactSalesDetail();

    expect(q('[data-testid="contact-sales-status-reviewed"]')).not.toBeNull();
    for (const denied of ["new", "contacted", "qualified", "rejected", "archived"]) {
      expect(
        q(`[data-testid="contact-sales-status-${denied}"]`),
        `ARCHIVED must not offer ${denied}`,
      ).toBeNull();
    }
  });

  it("a NEW inquiry is not offered Qualified — qualification requires triage first", async () => {
    await mountContactSalesDetail();
    expect(q('[data-testid="contact-sales-status-qualified"]')).toBeNull();
    expect(q('[data-testid="contact-sales-status-reviewed"]')).not.toBeNull();
    expect(q('[data-testid="contact-sales-status-rejected"]')).not.toBeNull();
  });

  it("a consequential move asks BEFORE any request, and the dialog names the inquiry", async () => {
    await mountContactSalesDetail();
    await click(q('[data-testid="contact-sales-status-rejected"]'));

    const d = dialog("commercial-status-rejected");
    expect(d).not.toBeNull();
    expect(d!.getAttribute("role")).toBe("dialog");
    // explainsScope — the subject is named: who, which organization.
    const body = d!.textContent ?? "";
    expect(body).toContain("Dana Whitfield");
    expect(body).toContain("Northgate Insurance");
    expect(body).toContain("New → Rejected");
    // No mutation has been sent while the question is open.
    expect(writes()).toHaveLength(0);
  });

  it("cancel sends nothing, ever", async () => {
    await mountContactSalesDetail();
    await click(q('[data-testid="contact-sales-status-rejected"]'));
    await cancelDialog("commercial-status-rejected");
    expect(writes()).toHaveLength(0);
    expect(dialog("commercial-status-rejected")).toBeNull();
  });

  it("confirm sends exactly ONE PATCH with { status, expectedStatus }", async () => {
    await mountContactSalesDetail();
    await click(q('[data-testid="contact-sales-status-rejected"]'));
    await confirmDialog("commercial-status-rejected");

    expect(patches()).toHaveLength(1);
    expect(writes()).toHaveLength(1);
    expect(patches()[0].path).toBe(`/v1/admin/contact-sales/${CS_ID}`);
    expect(JSON.parse(patches()[0].body as string)).toEqual({
      status: "REJECTED",
      expectedStatus: "NEW",
    });
  });

  it("a routine move (NEW → REVIEWED) runs on the click alone — no dialog", async () => {
    csPatchReply = () => ({ ok: true, data: csDetails({ status: "REVIEWED" }) });
    await mountContactSalesDetail();
    await click(q('[data-testid="contact-sales-status-reviewed"]'));

    expect(q('[role="dialog"]')).toBeNull();
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(patches()[0].body as string)).toEqual({
      status: "REVIEWED",
      expectedStatus: "NEW",
    });
  });

  it("success is announced only after the server resolves — noOptimisticSuccess", async () => {
    const gate = deferred<unknown>();
    csPatchReply = () => gate.promise;
    await mountContactSalesDetail();
    await click(q('[data-testid="contact-sales-status-rejected"]'));
    await confirmDialog("commercial-status-rejected");

    // The request is in flight; nothing claims success yet.
    expect(patches()).toHaveLength(1);
    expect(successToasts()).toHaveLength(0);
    // The page still shows the status the server last confirmed.
    expect(document.body.textContent).not.toContain("Status updated");

    gate.resolve({ ok: true, data: csDetails({ status: "REJECTED" }) });
    await settle();

    expect(successToasts().length).toBeGreaterThan(0);
    expect(toastText()).toContain("Status updated to Rejected");
  });

  it("a 500 surfaces an error, shows no success, and leaves the record as it was", async () => {
    csPatchReply = () => apiFailure(500);
    await mountContactSalesDetail();
    await click(q('[data-testid="contact-sales-status-rejected"]'));
    await confirmDialog("commercial-status-rejected");

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(successToasts()).toHaveLength(0);
    // failureLeavesStateCorrect — the buttons still offer NEW's transitions,
    // so the local record was not moved.
    expect(q('[data-testid="contact-sales-status-reviewed"]')).not.toBeNull();
    expect(q('[data-testid="contact-sales-status-rejected"]')).not.toBeNull();
    // And the raw provider words never reach the operator.
    expect(document.body.textContent).not.toContain("request failed");
  });

  it('a 409 "stale_status" shows the stale toast and reloads the record', async () => {
    csPatchReply = () => apiCodeFailure(409, "stale_status");
    await mountContactSalesDetail();
    const readsBefore = gets().length;
    await click(q('[data-testid="contact-sales-status-rejected"]'));
    await confirmDialog("commercial-status-rejected");

    expect(toastText()).toContain(
      "This inquiry was changed by another operator. The current status is shown now — nothing was overwritten.",
    );
    expect(successToasts()).toHaveLength(0);
    // The refusal re-reads the record rather than trusting the local copy.
    expect(gets().length).toBeGreaterThan(readsBefore);
  });

  it('a 409 "transition_not_allowed" shows the not-allowed toast and reloads', async () => {
    csPatchReply = () => apiCodeFailure(409, "transition_not_allowed");
    await mountContactSalesDetail();
    const readsBefore = gets().length;
    await click(q('[data-testid="contact-sales-status-rejected"]'));
    await confirmDialog("commercial-status-rejected");

    expect(toastText()).toContain(
      "That status change is not allowed from the inquiry's current status.",
    );
    expect(gets().length).toBeGreaterThan(readsBefore);
  });
});

// ===========================================================================
// PATCH /v1/admin/contact-sales/:id — from the list page's quick view
// ===========================================================================

describe("Contact Sales list — the quick view drives the same PATCH", () => {
  async function openQuickView() {
    await mountContactSalesList();
    await click(screen.getByRole("button", { name: "Quick view" }));
  }

  it("the quick view derives its buttons from the shared table too", async () => {
    csDetailReply = () => ({ ok: true, data: csDetails({ status: "ARCHIVED" }) });
    await openQuickView();
    expect(q('[data-testid="contact-sales-status-reviewed"]')).not.toBeNull();
    expect(q('[data-testid="contact-sales-status-rejected"]')).toBeNull();
    expect(q('[data-testid="contact-sales-status-new"]')).toBeNull();
  });

  it("confirm PATCHes once with { status, expectedStatus }, then re-reads the list before announcing", async () => {
    const gate = deferred<unknown>();
    csPatchReply = () => gate.promise;
    await openQuickView();
    const listReadsBefore = gets().filter((r) =>
      r.path.startsWith("/v1/admin/contact-sales?"),
    ).length;

    await click(q('[data-testid="contact-sales-status-archived"]'));
    const d = dialog("commercial-status-archived");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Dana Whitfield");
    await confirmDialog("commercial-status-archived");

    expect(patches()).toHaveLength(1);
    expect(patches()[0].path).toBe(`/v1/admin/contact-sales/${CS_ID}`);
    expect(JSON.parse(patches()[0].body as string)).toEqual({
      status: "ARCHIVED",
      expectedStatus: "NEW",
    });
    // In flight: no success claim, no refresh yet.
    expect(successToasts()).toHaveLength(0);

    csListReply = () => csList([csItem({ status: "ARCHIVED" })]);
    gate.resolve({ ok: true, data: csDetails({ status: "ARCHIVED" }) });
    await settle();

    // refreshFromServer — the list was re-read after the mutation resolved.
    const listReadsAfter = gets().filter((r) =>
      r.path.startsWith("/v1/admin/contact-sales?"),
    ).length;
    expect(listReadsAfter).toBeGreaterThan(listReadsBefore);
    expect(toastText()).toContain("Status updated to Archived");
  });

  it("cancel from the quick view sends nothing", async () => {
    await openQuickView();
    await click(q('[data-testid="contact-sales-status-rejected"]'));
    await cancelDialog("commercial-status-rejected");
    expect(writes()).toHaveLength(0);
  });
});

// ===========================================================================
// PATCH /v1/admin/demo-requests/:id — saveCurrent
// ===========================================================================

describe("Demo Requests — PATCH /v1/admin/demo-requests/:id", () => {
  const reviewStatusSelect = () =>
    screen.getAllByLabelText("Status")[1] as HTMLSelectElement;

  it("a disallowed transition is refused LOCALLY — a sentence, no dialog, no request", async () => {
    drListReply = () => ({
      items: [drItem({ status: "ARCHIVED" })],
      summary: DR_SUMMARY,
    });
    drDetailReply = () => ({ item: drDetails({ status: "ARCHIVED" }) });
    await mountDemoRequests();
    await openDemoDetails();

    await act(async () => {
      fireEvent.change(reviewStatusSelect(), { target: { value: "CONTACTED" } });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));

    expect(q('[role="dialog"]')).toBeNull();
    expect(writes()).toHaveLength(0);
    expect(toastText()).toContain(
      "A demo request cannot move from ARCHIVED to CONTACTED",
    );
    expect(toastText()).toContain("REVIEWED");
  });

  it("a consequential move confirms first, naming the request, with nothing sent", async () => {
    await mountDemoRequests();
    await openDemoDetails();

    await act(async () => {
      fireEvent.change(reviewStatusSelect(), { target: { value: "REJECTED" } });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));

    const d = dialog("commercial-status-rejected");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Priya Raman");
    expect(d!.textContent).toContain("Harbor Mutual");
    expect(writes()).toHaveLength(0);
  });

  it("cancel sends nothing", async () => {
    await mountDemoRequests();
    await openDemoDetails();
    await act(async () => {
      fireEvent.change(reviewStatusSelect(), { target: { value: "REJECTED" } });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));
    await cancelDialog("commercial-status-rejected");
    expect(writes()).toHaveLength(0);
  });

  it("confirm sends exactly ONE PATCH carrying expectedStatus and the edit form", async () => {
    await mountDemoRequests();
    await openDemoDetails();
    await act(async () => {
      fireEvent.change(reviewStatusSelect(), { target: { value: "REJECTED" } });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));
    await confirmDialog("commercial-status-rejected");

    expect(writes()).toHaveLength(1);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].path).toBe(`/v1/admin/demo-requests/${DR_ID}`);
    expect(JSON.parse(patches()[0].body as string)).toEqual({
      status: "REJECTED",
      expectedStatus: "NEW",
      priority: "NORMAL",
      followUpStatus: "ACTIVE",
      notes: "",
      nextFollowUpAt: null,
    });
  });

  it("stopping follow-up (no status move) confirms first and names the recipient", async () => {
    await mountDemoRequests();
    await openDemoDetails();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Follow-up status"), {
        target: { value: "STOPPED" },
      });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));

    const d = dialog("demo-request-stop-follow-up");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("priya@harbor.example");
    expect(d!.textContent).toContain("Priya Raman");
    expect(writes()).toHaveLength(0);

    await cancelDialog("demo-request-stop-follow-up");
    expect(writes()).toHaveLength(0);
  });

  it("success is announced only after the response resolves, then the page re-reads", async () => {
    const gate = deferred<unknown>();
    drPatchReply = () => gate.promise;
    await mountDemoRequests();
    await openDemoDetails();
    const readsBefore = gets().length;

    await act(async () => {
      fireEvent.change(reviewStatusSelect(), { target: { value: "REJECTED" } });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));
    await confirmDialog("commercial-status-rejected");

    expect(patches()).toHaveLength(1);
    expect(successToasts()).toHaveLength(0);

    drListReply = () => ({
      items: [drItem({ status: "REJECTED" })],
      summary: { ...DR_SUMMARY, NEW: 0, REJECTED: 1 },
    });
    drDetailReply = () => ({ item: drDetails({ status: "REJECTED" }) });
    gate.resolve({ ok: true });
    await settle();

    expect(toastText()).toContain("Demo request updated.");
    // refreshFromServer — both the list and the record were re-read.
    expect(gets().length).toBeGreaterThan(readsBefore);
  });

  it('a 409 "stale_status" shows the stale toast and reloads list + record', async () => {
    drPatchReply = () => apiCodeFailure(409, "stale_status");
    await mountDemoRequests();
    await openDemoDetails();
    const readsBefore = gets().length;

    await act(async () => {
      fireEvent.change(reviewStatusSelect(), { target: { value: "REJECTED" } });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));
    await confirmDialog("commercial-status-rejected");

    expect(toastText()).toContain(
      "This demo request was changed by another operator. The current status is shown now — nothing was overwritten.",
    );
    expect(successToasts()).toHaveLength(0);
    expect(gets().length).toBeGreaterThan(readsBefore);
  });

  it("a 500 surfaces an error and claims no success", async () => {
    drPatchReply = () => apiFailure(500);
    await mountDemoRequests();
    await openDemoDetails();

    await act(async () => {
      fireEvent.change(reviewStatusSelect(), { target: { value: "REJECTED" } });
    });
    await click(screen.getByRole("button", { name: "Save changes" }));
    await confirmDialog("commercial-status-rejected");

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(successToasts()).toHaveLength(0);
    expect(toastText()).not.toContain("Demo request updated.");
    expect(document.body.textContent).not.toContain("request failed");
  });
});

// ===========================================================================
// POST /v1/admin/demo-requests/:id/route — saveRouting
// ===========================================================================

describe("Demo Requests — POST /v1/admin/demo-requests/:id/route", () => {
  async function chooseTarget() {
    await mountDemoRequests();
    await openDemoDetails();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Routing target"), {
        target: { value: "MANUAL_SALES" },
      });
    });
  }

  it("asks first, naming the request and the track, before any request", async () => {
    await chooseTarget();
    await click(screen.getByRole("button", { name: "Save routing" }));

    const d = dialog("demo-request-route");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Priya Raman");
    expect(d!.textContent).toContain("manual sales");
    expect(writes()).toHaveLength(0);
  });

  it("cancel sends nothing", async () => {
    await chooseTarget();
    await click(screen.getByRole("button", { name: "Save routing" }));
    await cancelDialog("demo-request-route");
    expect(writes()).toHaveLength(0);
  });

  it("confirm sends exactly ONE POST with the routing body, and success waits for the server", async () => {
    const gate = deferred<unknown>();
    drRouteReply = () => gate.promise;
    await chooseTarget();
    await click(screen.getByRole("button", { name: "Save routing" }));
    await confirmDialog("demo-request-route");

    expect(writes()).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/v1/admin/demo-requests/${DR_ID}/route`);
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      routingTarget: "MANUAL_SALES",
      routingReason: null,
    });
    expect(successToasts()).toHaveLength(0);

    gate.resolve({ ok: true });
    await settle();
    expect(toastText()).toContain("Routing updated.");
  });

  it("a 500 keeps the failure path — error toast, no success", async () => {
    drRouteReply = () => apiFailure(500);
    await chooseTarget();
    await click(screen.getByRole("button", { name: "Save routing" }));
    await confirmDialog("demo-request-route");

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(toastText()).not.toContain("Routing updated.");
  });
});

// ===========================================================================
// POST /v1/admin/demo-requests/:id/follow-up/send — sendFollowUp
// ===========================================================================

describe("Demo Requests — POST /v1/admin/demo-requests/:id/follow-up/send", () => {
  it("asks first — an external email is named to its recipient — with nothing sent", async () => {
    await mountDemoRequests();
    await openDemoDetails();
    await click(screen.getByRole("button", { name: "Send Step 2" }));

    const d = dialog("demo-request-follow-up-send");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Send follow-up step 2 now?");
    expect(d!.textContent).toContain("priya@harbor.example");
    expect(writes()).toHaveLength(0);
  });

  it("cancel sends no email request", async () => {
    await mountDemoRequests();
    await openDemoDetails();
    await click(screen.getByRole("button", { name: "Send Step 2" }));
    await cancelDialog("demo-request-follow-up-send");
    expect(writes()).toHaveLength(0);
  });

  it("confirm posts once with { step }, and success waits for the response then re-reads", async () => {
    const gate = deferred<unknown>();
    drSendReply = () => gate.promise;
    await mountDemoRequests();
    await openDemoDetails();
    const readsBefore = gets().length;

    await click(screen.getByRole("button", { name: "Send Step 2" }));
    await confirmDialog("demo-request-follow-up-send");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe(
      `/v1/admin/demo-requests/${DR_ID}/follow-up/send`,
    );
    expect(JSON.parse(posts()[0].body as string)).toEqual({ step: 2 });
    expect(successToasts()).toHaveLength(0);

    gate.resolve({ ok: true });
    await settle();
    expect(toastText()).toContain("Follow-up step 2 sent.");
    expect(gets().length).toBeGreaterThan(readsBefore);
  });

  it('"Send Next" carries an empty body — the server picks the step', async () => {
    await mountDemoRequests();
    await openDemoDetails();
    await click(screen.getByRole("button", { name: "Send Next" }));
    const d = dialog("demo-request-follow-up-send");
    expect(d!.textContent).toContain("Send the next follow-up now?");
    await confirmDialog("demo-request-follow-up-send");
    expect(JSON.parse(posts()[0].body as string)).toEqual({});
  });

  it("a 500 surfaces an error with no success indicator", async () => {
    drSendReply = () => apiFailure(500);
    await mountDemoRequests();
    await openDemoDetails();
    await click(screen.getByRole("button", { name: "Send Step 2" }));
    await confirmDialog("demo-request-follow-up-send");

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(toastText()).not.toContain("sent.");
  });
});

// ===========================================================================
// POST /v1/admin/demo-requests/follow-up/run — runDueFollowUps
// ===========================================================================

describe("Demo Requests — POST /v1/admin/demo-requests/follow-up/run", () => {
  it("asks first and states the bound; cancel runs nothing", async () => {
    await mountDemoRequests();
    await click(screen.getByRole("button", { name: "Run Due Follow-ups" }));

    const d = dialog("demo-request-follow-up-run");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Up to 25 demo requests");
    expect(writes()).toHaveLength(0);

    await cancelDialog("demo-request-follow-up-run");
    expect(writes()).toHaveLength(0);
  });

  it("confirm posts once with { limit: 25 } and reports the server's own tally afterwards", async () => {
    const gate = deferred<unknown>();
    drRunReply = () => gate.promise;
    await mountDemoRequests();
    const readsBefore = gets().length;

    await click(screen.getByRole("button", { name: "Run Due Follow-ups" }));
    await confirmDialog("demo-request-follow-up-run");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe("/v1/admin/demo-requests/follow-up/run");
    expect(JSON.parse(posts()[0].body as string)).toEqual({ limit: 25 });
    expect(successToasts()).toHaveLength(0);

    gate.resolve({ result: { processed: 3, sent: 2, failed: 1 } });
    await settle();
    // The tally is the server's; a failed send keeps the error severity.
    expect(toastText()).toContain("Processed 3, sent 2, failed 1.");
    expect(gets().length).toBeGreaterThan(readsBefore);
  });

  it("a clean run announces success and re-reads the list", async () => {
    await mountDemoRequests();
    await click(screen.getByRole("button", { name: "Run Due Follow-ups" }));
    await confirmDialog("demo-request-follow-up-run");
    expect(toastText()).toContain("Processed 2, sent 2, failed 0.");
    expect(successToasts().length).toBeGreaterThan(0);
  });

  it("a 500 surfaces an error and no tally", async () => {
    drRunReply = () => apiFailure(500);
    await mountDemoRequests();
    await click(screen.getByRole("button", { name: "Run Due Follow-ups" }));
    await confirmDialog("demo-request-follow-up-run");

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(toastText()).not.toContain("Processed");
  });
});

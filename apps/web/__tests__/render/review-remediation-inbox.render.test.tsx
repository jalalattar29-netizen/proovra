/**
 * Review remediation 2026-11-27 — the Inbox (BEHAVIOUR-SPEC §8, §9).
 *
 *   F-10 / F-30  view navigation: a wrapping row of view links at ≥ 1024 px,
 *                one labelled "View" menu below; an unknown `?view=` is
 *                replaced by the default view; the bulk hint only with rows;
 *                the filter says it filters the loaded rows.
 *   F-28         "More views" / filter placeholder contrast tokens (CSS).
 *   F-23         the Review page reserves the assistant launcher's clearance.
 *   F-34 / F-37  every bulk call reports counts and per-item reasons; failed
 *                rows stay selected; Retry re-sends only them; an all-failed
 *                batch is an alert; "Set assessment tag" reports the same way.
 *   F-35 / F-36  Save view hidden without the capability; a duplicate name
 *                keeps the form open with specific copy.
 *
 * Real components, the real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/review",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import ReviewPage from "../../app/(app)/review/page";
import { setActiveWorkspaceId } from "../../lib/api";
import { recordReference } from "../../lib/short-id";
import { inboxViewGroupsFor, inboxViewParamIsUnknown } from "../../lib/reviewer-workspace/inbox-views";

const WS = "77777777-7777-4777-8777-777777777777";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WF1 = "11111111-2222-4333-8444-555555555555";
const WF2 = "11111111-2222-4333-8444-666666666666";
const EV1 = "99999999-8888-4777-8666-555555555555";
const EV2 = "99999999-8888-4777-8666-666666666666";

function row(id: string, evidenceId: string) {
  return {
    workflowId: id,
    evidenceId,
    teamId: WS,
    lifecycleState: "IN_REVIEW",
    assignedToUserId: null,
    priority: "NORMAL",
    slaRollupState: "HEALTHY",
    legacy: { id, stage: "FIRST_REVIEW", dueAt: "2026-12-01T10:00:00.000Z" },
  };
}

let rows: unknown[] = [];
let savedViews: unknown[] = [];
let bulkAnswers: Array<{ status: number; body: unknown }> = [];
let decideAnswers: Array<{ status: number; body: unknown }> = [];
let savedViewPost: { status: number; body: unknown } = { status: 201, body: { view: {} } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are asserted field by field
const calls: Array<{ method: string; path: string; body: any }> = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  nav.search = "";
  nav.push.mockReset();
  nav.replace.mockReset();
  rows = [row(WF1, EV1), row(WF2, EV2)];
  savedViews = [];
  bulkAnswers = [];
  decideAnswers = [];
  savedViewPost = { status: 201, body: { view: {} } };
  calls.length = 0;
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith("/v1/reviewer-ops/queue-intelligence")) return json(200, { projections: [], degradations: [] });
    if (path.startsWith("/v1/reviewer-ops/queue?")) return json(200, { rows, nextCursor: null });
    if (path.startsWith("/v1/reviewer-ops/qc/pending-count")) return json(200, { pendingCount: 0 });
    if (path.startsWith("/v1/reviewer-ops/reviews/bulk")) {
      const next = bulkAnswers.shift() ?? { status: 200, body: { total: 0, succeeded: 0, failed: 0, items: [] } };
      return json(next.status, next.body);
    }
    if (path.startsWith("/v1/reviewer/bulk/decide")) {
      const next = decideAnswers.shift() ?? { status: 200, body: { total: 0, succeeded: 0, failed: 0, items: [] } };
      return json(next.status, next.body);
    }
    if (path.startsWith("/v1/reviewer-ops/saved-views")) {
      if (method === "POST") return json(savedViewPost.status, savedViewPost.body);
      return json(200, { views: savedViews });
    }
    return json(404, { error: { code: "not_found" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

type Role = "OWNER" | "VIEWER";
function envelope(role: Role) {
  const owner = role === "OWNER";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {
      DASHBOARD_VIEW: true,
      EVIDENCE_VIEW: true,
      REVIEWER_OPS_VIEW: true,
      SLA_VIEW: true,
      ESCALATIONS_VIEW: true,
      SETTINGS_VIEW: true,
      ...(owner ? { REVIEWER_OPS_ACT: true, REVIEW_ASSIGN: true, BULK_ACTIONS: true, EVIDENCE_MANAGE: true } : {}),
    },
    diagnostics: { requestId: `review-remediation-${role}` },
    user: { id: ME, email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL", membership: { role } },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: owner ? "Owner" : "VIEWER" },
    personalSpace: { id: WS, status: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    account: { accountPlan: "TEAM", accountStatus: "active", userId: ME },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: {
      reviewerOperationsIncluded: true,
      reviewQueuesIncluded: true,
      externalReviewIncluded: true,
      intakeIncluded: true,
      professionalSurfacesIncluded: true,
    },
  };
}

async function settle() {
  for (let i = 0; i < 16; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mount(role: Role = "OWNER") {
  render(
    <PlatformContextProvider testEnvelope={envelope(role) as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <ReviewPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
}

function mockWidth(width: number) {
  (window as { matchMedia?: unknown }).matchMedia = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    };
  };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const checked = (id: string) => ($(`[data-inbox-row-checkbox="${id}"]`) as HTMLInputElement).checked;
async function click(sel: string | HTMLElement) {
  const el = typeof sel === "string" ? $(sel) : sel;
  expect(el, String(sel)).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
  await settle();
}
const bulkPosts = () => calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/reviewer-ops/reviews/bulk"));
const decidePosts = () => calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/reviewer/bulk/decide"));

const CSS = readFileSync(resolve(__dirname, "../../components/reviewer-experience/review-surfaces.css"), "utf8");
function ruleBody(selectorStart: string): string {
  const i = CSS.indexOf(selectorStart);
  expect(i, selectorStart).toBeGreaterThanOrEqual(0);
  return CSS.slice(CSS.indexOf("{", i) + 1, CSS.indexOf("}", i));
}

// ---------------------------------------------------------------------------
describe("F-10 — view navigation", () => {
  it("≥ 1024 px: a wrapping row of view links (aria-current on the active one) and More views in the same group; the View menu is hidden", async () => {
    mockWidth(1440);
    nav.search = "view=OVERDUE";
    await mount();
    const navEl = $("[data-inbox-views]")!;
    expect(navEl.getAttribute("data-inbox-view-layout")).toBe("row");
    const rowGroup = navEl.querySelector(".review-view-nav__row") as HTMLElement;
    expect(rowGroup.hidden).toBe(false);
    expect(rowGroup.querySelector("[data-inbox-more-views]")).not.toBeNull();
    const current = Array.from(navEl.querySelectorAll('[data-inbox-view-tabs] [aria-current="page"]'));
    expect(current.map((c) => c.getAttribute("data-inbox-view-tab"))).toEqual(["OVERDUE"]);
    expect((navEl.querySelector(".review-view-nav__menu") as HTMLElement).hidden).toBe(true);
  });

  it("a secondary view that is current reads as the selected value of More views, not its placeholder", async () => {
    mockWidth(1440);
    nav.search = "view=LEGAL_HOLD";
    await mount();
    const more = $("[data-inbox-more-views]")!;
    expect(more.getAttribute("data-inbox-more-views-active")).toBe("true");
    expect(more.getAttribute("data-placeholder")).toBe("false");
    expect(more.textContent).toContain("Legal hold");
  });

  it("< 1024 px: one labelled View control listing every view, grouped; the link row is hidden", async () => {
    mockWidth(390);
    await mount();
    const navEl = $("[data-inbox-views]")!;
    expect(navEl.getAttribute("data-inbox-view-layout")).toBe("menu");
    expect((navEl.querySelector(".review-view-nav__row") as HTMLElement).hidden).toBe(true);
    const trigger = $("[data-inbox-view-menu]")!;
    const labelId = trigger.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)!.textContent).toBe("View");
    expect(trigger.textContent).toContain("Assigned to me");
    await click(trigger);
    const options = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.getAttribute("data-value"));
    const all = inboxViewGroupsFor(true).flatMap((g) => g.views);
    expect(options).toEqual(all);
    expect(new Set(all).size).toBe(14);
    expect(inboxViewGroupsFor(true).map((g) => g.label)).toEqual(["Mine", "Team", "Attention", "Second review", "More"]);
    await click(document.querySelector('[role="option"][data-value="ESCALATED"]') as HTMLElement);
    expect(nav.push).toHaveBeenCalledWith("/review?view=ESCALATED");
  });

  it("CSS contract: the view and hub rows wrap — no horizontal scroll, no mask; the breakpoint is 1024 px", () => {
    const tabs = ruleBody(".review-hub-tabs,\n.review-view-tabs {");
    expect(tabs).toMatch(/flex-wrap:\s*wrap/);
    expect(tabs).toMatch(/overflow:\s*visible/);
    expect(tabs).toMatch(/mask-image:\s*none/);
    expect(tabs).not.toMatch(/overflow-x:\s*auto/);
    expect(CSS).toMatch(/@media \(min-width: 1024px\) \{\s*\.review-view-nav__menu \{ display: none; \}/);
    expect(CSS).toMatch(/@media \(max-width: 1023\.98px\) \{\s*\.review-view-nav__row \{ display: none; \}/);
    expect(CSS).not.toMatch(/scroll-snap-type/);
  });

  it("F-28: More views and the filter placeholder use the 4.5:1 secondary ink, never the placeholder ink", () => {
    const body = ruleBody('.review-view-nav .app-listbox__trigger[data-placeholder="true"]');
    expect(body).toMatch(/color:\s*var\(--app-ink-secondary\)/);
    expect(CSS).toMatch(/\.review-inbox__filter \.app-input::placeholder \{\s*color: var\(--app-ink-secondary\)/);
  });

  it("F-23: the Review page reserves launcher + edge + gap, and wins over PageShell's inline padding", async () => {
    const body = ruleBody(".review-launcher-clearance {");
    expect(body).toMatch(/--review-launcher-clearance:\s*calc\(3rem \+ 1\.5rem \+ 1rem/);
    expect(body).toMatch(/padding-block-end:\s*var\(--review-launcher-clearance\) !important/);
    expect(CSS).toMatch(/@media \(max-width: 768px\) \{\s*\.review-launcher-clearance \{\s*--review-launcher-clearance: calc\(3rem \+ 1\.5rem \+ 1\.5rem/);
    await mount();
    expect($("[data-review-inbox]")!.classList.contains("review-launcher-clearance")).toBe(true);
  });
});

describe("F-30 — URL, hint and filter scope", () => {
  it("an unknown ?view= is replaced by the default Inbox URL", async () => {
    expect(inboxViewParamIsUnknown(new URLSearchParams("view=BOGUS"))).toBe(true);
    expect(inboxViewParamIsUnknown(new URLSearchParams("view=OVERDUE"))).toBe(false);
    expect(inboxViewParamIsUnknown(new URLSearchParams("queue=OVERDUE"))).toBe(false);
    expect(inboxViewParamIsUnknown(new URLSearchParams(""))).toBe(false);
    nav.search = "view=BOGUS";
    await mount();
    expect(nav.replace).toHaveBeenCalledWith("/review");
  });

  it("a known view is never replaced", async () => {
    nav.search = "view=OVERDUE";
    await mount();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("the bulk hint shows only with rows; the filter says it filters the loaded reviews", async () => {
    await mount();
    expect($("[data-reviewer-bulk-hint]")).not.toBeNull();
    const filter = $("[data-inbox-filter]") as HTMLInputElement;
    expect(filter.placeholder).toBe("Filter loaded reviews (press /)");
    cleanup();
    rows = [];
    await mount();
    expect($("[data-reviewer-bulk-hint]")).toBeNull();
  });
});

describe("F-34 — bulk results", () => {
  async function selectBoth() {
    await click(`[data-inbox-row-checkbox="${WF1}"]`);
    await click(`[data-inbox-row-checkbox="${WF2}"]`);
    expect($("[data-reviewer-bulk-actions-bar]")!.getAttribute("data-reviewer-bulk-selection-count")).toBe("2");
  }

  it("200 all ok: 'N updated' in the live region and the selection is empty", async () => {
    bulkAnswers = [
      { status: 200, body: { total: 2, succeeded: 2, failed: 0, items: [{ workflowId: WF1, ok: true }, { workflowId: WF2, ok: true }] } },
    ];
    await mount();
    await selectBoth();
    await click('[data-reviewer-bulk-action="PRIORITY_HIGH"]');
    const status = $("[data-reviewer-bulk-status]")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Mark high: 2 updated");
    expect(checked(WF1)).toBe(false);
    expect(checked(WF2)).toBe(false);
    expect($("[data-reviewer-bulk-all-failed]")).toBeNull();
    expect($("[data-reviewer-bulk-retry-failed]")).toBeNull();
  });

  it("207 partial: counts, the failed row named with its reason, failed stays selected, Retry re-sends ONLY the failed id", async () => {
    bulkAnswers = [
      {
        status: 207,
        body: {
          total: 2,
          succeeded: 1,
          failed: 1,
          items: [
            { workflowId: WF1, ok: true },
            { workflowId: WF2, ok: false, errorCode: "REVIEW_STAGE_TRANSITION_INVALID", message: "The review is closed." },
          ],
        },
      },
      { status: 200, body: { total: 1, succeeded: 1, failed: 0, items: [{ workflowId: WF2, ok: true }] } },
    ];
    await mount();
    await selectBoth();
    await click('[data-reviewer-bulk-action="PRIORITY_HIGH"]');
    expect($("[data-reviewer-bulk-status]")!.textContent).toBe("Mark high: 1 updated · 1 not changed");
    const failed = $(`[data-reviewer-bulk-failed-workflow="${WF2}"]`)!;
    expect(failed.textContent).toBe(`${recordReference("Evidence", EV2)}: The review is closed.`);
    expect(checked(WF1)).toBe(false);
    expect(checked(WF2)).toBe(true);
    expect($("[data-reviewer-bulk-actions-bar]")!.getAttribute("data-reviewer-bulk-selection-count")).toBe("1");

    await click("[data-reviewer-bulk-retry-failed]");
    const posts = bulkPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toMatchObject({ action: "PRIORITY_HIGH", workflowIds: [WF2], teamId: WS });
    expect($("[data-reviewer-bulk-status]")!.textContent).toBe("Mark high: 1 updated");
    expect(checked(WF2)).toBe(false);
  });

  it("all failed: an alert that nothing was changed — never a success line — and every row stays selected", async () => {
    bulkAnswers = [
      {
        status: 207,
        body: {
          total: 2,
          succeeded: 0,
          failed: 2,
          items: [
            { workflowId: WF1, ok: false, errorCode: "REVIEW_PERMISSION_DENIED", message: "Your role cannot change this review." },
            { workflowId: WF2, ok: false, errorCode: "REVIEW_PERMISSION_DENIED", message: "Your role cannot change this review." },
          ],
        },
      },
    ];
    await mount();
    await selectBoth();
    await click('[data-reviewer-bulk-action="PRIORITY_URGENT"]');
    const alert = $("[data-reviewer-bulk-all-failed]")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("Nothing was changed: Your role cannot change this review.");
    expect($("[data-reviewer-bulk-status]")!.textContent).toBe("");
    expect(document.body.textContent).not.toMatch(/\d+ updated/);
    expect(checked(WF1)).toBe(true);
    expect(checked(WF2)).toBe(true);
    expect($("[data-reviewer-bulk-retry-failed]")!.textContent).toBe("Retry failed (2)");
  });

  it("a 400 REVIEW_NOTE_REQUIRED and a 403 read as specific refusals; the selection is kept", async () => {
    bulkAnswers = [{ status: 403, body: { error: { code: "REVIEW_PERMISSION_DENIED" } } }];
    await mount();
    await selectBoth();
    await click('[data-reviewer-bulk-action="PRIORITY_HIGH"]');
    expect($("[data-reviewer-bulk-error]")!.textContent).toBe(
      "Nothing was changed: your role cannot do this bulk action in this workspace.",
    );
    expect(checked(WF1)).toBe(true);
    bulkAnswers = [{ status: 400, body: { error: { code: "REVIEW_NOTE_REQUIRED", message: "A note is required." } } }];
    await click('[data-reviewer-bulk-action="PRIORITY_HIGH"]');
    expect($("[data-reviewer-bulk-error]")!.textContent).toMatch(/^Nothing was changed: this action needs a short note/);
  });

  it("Set assessment tag: relabelled with its help, reports per item, Retry re-sends only the failed id with the same tag", async () => {
    decideAnswers = [
      {
        status: 207,
        body: {
          ok: true,
          total: 2,
          succeeded: 1,
          failed: 1,
          recordsDecision: false,
          items: [
            { workflowId: WF1, ok: true },
            { workflowId: WF2, ok: false, errorCode: "SCHEMA_NOT_FOUND", message: "No coding schema is bound to this review." },
          ],
          outcomes: [],
        },
      },
      { status: 207, body: { ok: false, total: 1, succeeded: 0, failed: 1, items: [{ workflowId: WF2, ok: false, errorCode: "SCHEMA_NOT_FOUND", message: "No coding schema is bound to this review." }] } },
    ];
    await mount();
    await selectBoth();
    const apply = $("[data-inbox-bulk-tag-apply]") as HTMLButtonElement;
    expect(apply.textContent).toBe("Set assessment tag");
    expect($("[data-inbox-bulk-tag-help]")!.textContent).toBe(
      "Tags the coded assessment only — it does not record a review decision.",
    );
    await click("[data-inbox-bulk-tag-select]");
    await click(document.querySelector('[role="option"][data-value="REJECT"]') as HTMLElement);
    await click("[data-inbox-bulk-tag-apply]");
    await click("[data-inbox-bulk-confirm]");
    expect(decidePosts()[0]!.body).toMatchObject({ verdict: "REJECT", workflowIds: [WF1, WF2] });
    expect($("[data-reviewer-bulk-status]")!.textContent).toBe(
      "Set assessment tag (Tag: proposed reject): 1 updated · 1 not changed",
    );
    expect($(`[data-reviewer-bulk-failed-workflow="${WF2}"]`)!.textContent).toContain("No coding schema is bound to this review.");
    expect(checked(WF1)).toBe(false);
    expect(checked(WF2)).toBe(true);

    await click("[data-reviewer-bulk-retry-failed]");
    expect(decidePosts()).toHaveLength(2);
    expect(decidePosts()[1]!.body).toMatchObject({ verdict: "REJECT", workflowIds: [WF2] });
    // The retried batch failed entirely: an alert, never a success line.
    expect($("[data-reviewer-bulk-all-failed]")!.textContent).toBe(
      "Nothing was changed: No coding schema is bound to this review.",
    );
    expect(checked(WF2)).toBe(true);
  });

  it("selection hygiene: a row hidden by the filter leaves the selection and the count", async () => {
    await mount();
    await selectBoth();
    await act(async () => {
      fireEvent.change($("[data-inbox-filter]")!, { target: { value: recordReference("Evidence", EV1) } });
    });
    await settle();
    expect($(`[data-inbox-row-checkbox="${WF2}"]`)).toBeNull();
    expect($("[data-reviewer-bulk-actions-bar]")!.getAttribute("data-reviewer-bulk-selection-count")).toBe("1");
  });

  it("selection hygiene: a failed id that disappeared after the refresh is pruned (count = selected visible rows)", async () => {
    bulkAnswers = [
      {
        status: 207,
        body: {
          total: 2,
          succeeded: 1,
          failed: 1,
          items: [
            { workflowId: WF1, ok: true },
            { workflowId: WF2, ok: false, errorCode: "REVIEW_ITEM_FAILED", message: "Not changed." },
          ],
        },
      },
    ];
    await mount();
    await selectBoth();
    // The reload after the call no longer carries WF2 (closed elsewhere).
    rows = [row(WF1, EV1)];
    await click('[data-reviewer-bulk-action="PRIORITY_HIGH"]');
    expect($(`[data-inbox-row-checkbox="${WF2}"]`)).toBeNull();
    expect(checked(WF1)).toBe(false);
    expect($("[data-reviewer-bulk-actions-bar]")).toBeNull();
    // The outcome stays readable after the selection emptied.
    expect($("[data-reviewer-bulk-status]")!.textContent).toBe("Mark high: 1 updated · 1 not changed");
  });
});

describe("F-35 / F-36 — saved views", () => {
  it("a duplicate name keeps the form open with the typed name and says so", async () => {
    savedViewPost = { status: 409, body: { error: { code: "duplicate_saved_view" } } };
    await mount();
    await click("[data-reviewer-saved-view-create]");
    const input = $("[data-reviewer-saved-view-name]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Morning triage" } });
    });
    await act(async () => {
      fireEvent.submit($("[data-reviewer-saved-view-form]")!);
    });
    await settle();
    expect($("[data-reviewer-saved-view-error]")!.textContent).toBe(
      "A view named “Morning triage” already exists. Choose another name.",
    );
    expect($("[data-reviewer-saved-view-form]")).not.toBeNull();
    expect(($("[data-reviewer-saved-view-name]") as HTMLInputElement).value).toBe("Morning triage");
  });

  it("a Viewer is offered no Save, and Delete only on their own views", async () => {
    savedViews = [
      { id: "v-own", name: "Mine", queueType: "OVERDUE", createdByUserId: ME, visibility: "PRIVATE" },
      { id: "v-team", name: "Team", queueType: "OVERDUE", createdByUserId: PEER, visibility: "TEAM" },
      { id: "v-legacy", name: "Legacy", queueType: "OVERDUE", createdByUserId: null, visibility: "TEAM" },
    ];
    await mount("VIEWER");
    expect($("[data-reviewer-saved-views-panel]")).not.toBeNull();
    expect($("[data-reviewer-saved-view-create]")).toBeNull();
    expect($('[data-reviewer-saved-view-delete="v-own"]')).not.toBeNull();
    expect($('[data-reviewer-saved-view-delete="v-team"]')).toBeNull();
    expect($('[data-reviewer-saved-view-delete="v-legacy"]')).toBeNull();
  });

  it("an Owner is offered Save", async () => {
    await mount("OWNER");
    expect($("[data-reviewer-saved-view-create]")).not.toBeNull();
  });
});

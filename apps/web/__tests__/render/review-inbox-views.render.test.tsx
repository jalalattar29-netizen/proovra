/**
 * Stage D (team remediation) — THE ONE REVIEW INBOX (`/review`).
 *
 *   T-065  `?view=` and the highlighted view always agree; the Inbox tab is the
 *          active hub tab; the legacy `?queue=` still opens its view.
 *   T-066  no evidence-request panel in the Inbox (it lives on Requests).
 *   T-067  a failed load or a plan refusal shows the alert and Retry only —
 *          never the confirmed-empty copy.
 *   T-068  the QC line appears only with pending samples; a refusal shows no link.
 *   T-069  one "Needs attention because …" sentence, no uppercase enum, a
 *          Warning escalation in amber (not red).
 *   T-070 / T-071  Normal priority says nothing; statuses are plain text.
 *   T-074  a row opens the Review page carrying the view.
 *   T-080  no Copilot QC panel in the Inbox.
 *   T-082  bulk coded values are tags, never bare decision verbs.
 *   T-086  the assignee is the server's identity (masked e-mail), never an id.
 *   T-088  the table opts into the ≤ 900 px card layout; the view row WRAPS
 *          (F-10, 2026-11-27: review-remediation-inbox.render.test.tsx).
 *   T-094  the help lists exactly the keys the Inbox registered.
 *   T-095  the first paint makes no console-aggregator call and few reads.
 *   T-096  Due is the governing deadline from the SLA rollup.
 *
 * Real components, the real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: () => {}, back: () => {} }),
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
import { formatUserDate } from "../../lib/date";
import { INBOX_KEYMAP } from "../../lib/reviewer-workspace/review-keymap";
import { reviewStringScanViolations } from "./_review-string-scan";

const WS = "77777777-7777-4777-8777-777777777777";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WF1 = "11111111-2222-4333-8444-555555555555";
const WF2 = "11111111-2222-4333-8444-666666666666";
const EV1 = "99999999-8888-4777-8666-555555555555";
const EV2 = "99999999-8888-4777-8666-666666666666";
const LEGACY_DUE = "2026-12-01T10:00:00.000Z";
const GOVERNING_DUE = "2026-11-11T10:00:00.000Z";

function row(id: string, evidenceId: string, over: Record<string, unknown> = {}) {
  return {
    workflowId: id,
    evidenceId,
    teamId: WS,
    lifecycleState: "IN_REVIEW",
    assignedToUserId: null,
    priority: "NORMAL",
    slaRollupState: "HEALTHY",
    legacy: { id, stage: "FIRST_REVIEW", dueAt: LEGACY_DUE },
    ...over,
  };
}

let rows: unknown[] = [];
let queueStatus = 200;
let queueBody: unknown = null;
let qcPending: { status: number; count: number } = { status: 200, count: 0 };
let intelligence: unknown[] = [];
const calls: Array<{ method: string; path: string; body: unknown }> = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  nav.search = "";
  nav.push.mockReset();
  rows = [row(WF1, EV1), row(WF2, EV2, { assignedToUserId: PEER, assignee: { displayName: null, maskedEmail: "p***@example.com" } })];
  queueStatus = 200;
  queueBody = null;
  qcPending = { status: 200, count: 0 };
  intelligence = [];
  calls.length = 0;
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith("/v1/reviewer-ops/queue-intelligence")) {
      return json(200, { projections: intelligence, degradations: [] });
    }
    if (path.startsWith("/v1/reviewer-ops/queue?")) {
      return json(queueStatus, queueBody ?? { rows, nextCursor: null });
    }
    if (path.startsWith("/v1/reviewer-ops/qc/pending-count")) {
      return qcPending.status === 200
        ? json(200, { pendingCount: qcPending.count })
        : json(qcPending.status, { error: { code: "REVIEW_PERMISSION_DENIED" } });
    }
    if (path.startsWith("/v1/reviewer-ops/saved-views")) return json(200, { views: [] });
    if (path.startsWith("/v1/reviewer-ops/assignable-reviewers")) {
      return json(200, { reviewers: [{ userId: PEER, displayName: null, maskedEmail: "p***@example.com", role: "MEMBER", status: "ACTIVE" }] });
    }
    return json(404, { error: { code: "not_found" } });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

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
    diagnostics: { requestId: `review-inbox-${role}` },
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
  for (let i = 0; i < 14; i += 1) {
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

const queueCalls = () => calls.filter((c) => c.path.startsWith("/v1/reviewer-ops/queue?"));

describe("T-065 / T-092 — one Inbox; the URL view and the highlighted view agree", () => {
  it("?view=MY_REVIEWS highlights 'Assigned to me' and the Inbox hub tab, and asks for that slice", async () => {
    nav.search = "view=MY_REVIEWS";
    await mount();
    const current = document.querySelector('[data-inbox-view-tabs] [aria-current="page"]') as HTMLElement;
    expect(current.getAttribute("data-inbox-view-tab")).toBe("MY_REVIEWS");
    expect(current.textContent).toBe("Assigned to me");
    const hub = document.querySelector('[data-review-hub-tab][aria-current="page"]') as HTMLElement;
    expect(hub.getAttribute("data-review-hub-tab")).toBe("inbox");
    expect(hub.textContent).toBe("Inbox");
    expect(queueCalls()[0]!.path).toContain("queue=MY_REVIEWS");
    // One navigation level: no Queues tab, no Monitoring sub-row.
    expect(document.querySelector('[data-review-hub-tab="queues"]')).toBeNull();
    expect(document.querySelector("[data-review-hub-subnav]")).toBeNull();
  });

  it("the legacy ?queue=OVERDUE opens the Overdue view (and only it is highlighted)", async () => {
    nav.search = "queue=OVERDUE";
    await mount();
    const current = Array.from(document.querySelectorAll('[data-inbox-view-tabs] [aria-current="page"]'));
    expect(current.map((c) => c.getAttribute("data-inbox-view-tab"))).toEqual(["OVERDUE"]);
    expect(queueCalls()[0]!.path).toContain("queue=OVERDUE");
  });

  it("every view tab links to /review?view=…, and the default view is the plain /review", async () => {
    await mount();
    const tabs = Array.from(document.querySelectorAll("[data-inbox-view-tab]")) as HTMLAnchorElement[];
    const hrefs = Object.fromEntries(tabs.map((t) => [t.getAttribute("data-inbox-view-tab"), t.getAttribute("href")]));
    expect(hrefs.MY_REVIEWS).toBe("/review");
    expect(hrefs.UNASSIGNED).toBe("/review?view=UNASSIGNED");
    expect(hrefs.AWAITING_ADJUDICATION).toBe("/review?view=AWAITING_ADJUDICATION");
    expect(hrefs.ALL_OPEN).toBe("/review?view=ALL_OPEN");
    // T-092 — one label per view. Round 2: an owner (REVIEW_ASSIGN) is offered
    // "All open reviews" first.
    expect(tabs.map((t) => t.textContent)).toEqual([
      "All open reviews",
      "Assigned to me",
      "Unassigned",
      "Overdue",
      "Due soon",
      "Escalated",
      "Awaiting second review",
      "Conflicts",
    ]);
    expect(document.body.textContent).not.toMatch(/My reviews|Assigned \(mine\)|Open my queue/);
  });
});

describe("round 2 — All open reviews", () => {
  it("is asked of the queue route as ALL_OPEN when chosen", async () => {
    nav.search = "view=ALL_OPEN";
    await mount();
    const current = document.querySelector('[data-inbox-view-tabs] [aria-current="page"]') as HTMLElement;
    expect(current.getAttribute("data-inbox-view-tab")).toBe("ALL_OPEN");
    expect(current.textContent).toBe("All open reviews");
    expect(queueCalls()[0]!.path).toContain("queue=ALL_OPEN");
  });

  it("is never offered to a member who cannot act on others' reviews", async () => {
    await mount("VIEWER");
    expect(document.querySelector('[data-inbox-view-tab="ALL_OPEN"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/All open reviews/);
  });
});

describe("T-066 / T-080 — the Inbox lists review workflows only", () => {
  it("renders no evidence-request panel and no Copilot QC panel", async () => {
    await mount();
    expect(document.querySelector("[data-evidence-request-queue]")).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/v1/review/queue"))).toBe(false);
    expect(calls.some((c) => c.path.startsWith("/v1/ai/qc/samples"))).toBe(false);
    expect(screen.queryByText(/AI QC sampling/i)).toBeNull();
    // The first row of reviews is the first panel after the views.
    expect(document.querySelector("[data-inbox-table]")).not.toBeNull();
  });
});

describe("T-067 — a failed load is never a confirmed-empty view", () => {
  it("a 500 shows the alert and Retry, and no empty-state copy", async () => {
    nav.search = "view=MY_REVIEWS";
    queueStatus = 500;
    queueBody = { error: { code: "INTERNAL", message: "boom" } };
    await mount();
    const alert = document.querySelector("[data-inbox-load-error]") as HTMLElement;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("No reviews are assigned to you.");
    expect(document.querySelector("[data-inbox-empty]")).toBeNull();
    expect(document.querySelector("[data-inbox-table]")).toBeNull();
    // Retry reads the view again; a confirmed empty answer is then empty.
    queueStatus = 200;
    rows = [];
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await settle();
    expect(document.querySelector('[data-inbox-empty="MY_REVIEWS"]')!.textContent).toContain("No reviews are assigned to you.");
  });

  it("a plan refusal reads as the plan, not as an empty view", async () => {
    queueStatus = 403;
    queueBody = { error: { code: "ENTITLEMENT_REQUIRED", message: "plan" } };
    await mount();
    expect(document.querySelector("[data-inbox-load-error]")).not.toBeNull();
    expect(document.querySelector("[data-inbox-empty]")).toBeNull();
  });
});

describe("T-068 — the QC line", () => {
  it("is absent when nothing is pending", async () => {
    qcPending = { status: 200, count: 0 };
    await mount();
    expect(document.querySelector("[data-inbox-qc-line]")).toBeNull();
    expect(screen.queryByText(/No QC samples are awaiting verdict/)).toBeNull();
  });

  it("is one line with a link when samples are pending", async () => {
    qcPending = { status: 200, count: 3 };
    await mount();
    const line = document.querySelector("[data-inbox-qc-line]") as HTMLElement;
    expect(line.textContent).toContain("3 quality-control samples are waiting for a verdict");
    expect((line.querySelector("a") as HTMLAnchorElement).getAttribute("href")).toBe("/review/qc");
  });

  it("a refused count offers no link", async () => {
    qcPending = { status: 403, count: 0 };
    await mount();
    expect(document.querySelector("[data-inbox-qc-line]")).toBeNull();
    expect(document.querySelector("[data-inbox-qc-link]")).toBeNull();
  });
});

describe("T-069 / T-070 / T-071 / T-096 — the row's status, attention and due date", () => {
  it("an overdue row with a Warning escalation: one sentence, no uppercase enum, the escalation in amber, Due is the governing deadline", async () => {
    rows = [row(WF1, EV1, { lifecycleState: "ESCALATED" })];
    intelligence = [
      {
        workflowId: WF1,
        evidenceId: EV1,
        status: "ESCALATED",
        priority: { band: "ATTENTION", score: 60 },
        stuckState: { isStuck: false, topSeverity: "INFO" },
        reviewerPressure: null,
        governanceBlockers: { legalHold: true, immutableDrift: false, packageBlocked: true, exportBlocked: true, retentionExpired: false },
        slaState: { status: "OVERDUE", signal: "OVERDUE", dueAtUtc: GOVERNING_DUE, breachedAtUtc: GOVERNING_DUE },
        escalationState: { activeEscalationId: "e-1", severity: "WARNING", activeCount: 2 },
        queueAging: { createdAtUtc: GOVERNING_DUE, daysOpen: 3, agedFrom: "assigned", lastReviewerTouchAtUtc: null },
      },
    ];
    await mount();
    const tr = document.querySelector(`tr[data-inbox-row="${WF1}"]`) as HTMLElement;
    const attention = tr.querySelector("[data-inbox-attention]") as HTMLElement;
    expect(attention.textContent).toMatch(/^Needs attention because overdue \d+ d · Escalation: Warning \(2 active\) · Legal hold$/);
    // No band enum, no uppercase token anywhere in the status cell.
    const status = tr.querySelector('[data-review-cell="status"]') as HTMLElement;
    expect(status.textContent).not.toMatch(/\b[A-Z]{2,}(_[A-Z]+)*\b/);
    expect(status.textContent).not.toContain("ATTENTION");
    // The lifecycle word is not repeated beside the escalation sentence.
    expect(status.querySelector("[data-inbox-row-status]")).toBeNull();
    // Severity-correct colour: Warning is amber, never red; legal hold said once.
    const esc = attention.querySelector('[data-inbox-attention-reason="escalation"]') as HTMLElement;
    expect(esc.getAttribute("data-tone")).toBe("amber");
    expect(attention.querySelector('[data-inbox-attention-reason="sla"]')!.getAttribute("data-tone")).toBe("red");
    expect(attention.textContent!.match(/Legal hold|Export blocked|Packaging blocked/g)).toEqual(["Legal hold"]);
    // T-071 — plain text: the canonical no-capsule class, not a Badge.
    for (const el of Array.from(status.querySelectorAll("[data-tone]"))) {
      expect(el.classList.contains("app-status-text")).toBe(true);
    }
    // T-096 — Due is the governing deadline, not legacy.dueAt.
    expect(tr.querySelector("[data-inbox-row-due]")!.textContent).toBe(formatUserDate(GOVERNING_DUE));
  });

  it("Normal priority says nothing; High is an amber word; the status is plain text", async () => {
    rows = [row(WF1, EV1, { priority: "NORMAL" }), row(WF2, EV2, { priority: "HIGH" })];
    await mount();
    expect(document.querySelector(`tr[data-inbox-row="${WF1}"] [data-inbox-row-priority]`)).toBeNull();
    const high = document.querySelector(`tr[data-inbox-row="${WF2}"] [data-inbox-row-priority]`) as HTMLElement;
    expect(high.textContent).toBe("High priority");
    expect(high.getAttribute("data-tone")).toBe("amber");
    const status = document.querySelector(`tr[data-inbox-row="${WF1}"] [data-inbox-row-status]`) as HTMLElement;
    expect(status.textContent).toBe("In review");
    expect(status.className).toBe("app-status-text");
  });
});

describe("T-074 / T-086 / T-088 — rows", () => {
  it("columns are Evidence · Status · Due · Assignee; the row opens the Review page carrying the view", async () => {
    nav.search = "view=UNASSIGNED";
    await mount();
    const heads = Array.from(document.querySelectorAll("[data-inbox-table] thead th")).map((th) => th.textContent?.trim());
    expect(heads.filter(Boolean).filter((h) => h !== "Actions")).toEqual(["Evidence", "Status", "Due", "Assignee"]);
    expect(heads).not.toContain("Workflow");
    const open = document.querySelector(`[data-inbox-row-open="${WF1}"]`) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(`/reviewer-ops/${WF1}?from=inbox&view=UNASSIGNED`);
  });

  it("the assignee is the server's identity — a masked e-mail, never an id fragment or 'Reviewer ref'", async () => {
    await mount();
    expect(document.querySelector(`[data-inbox-row-assignee="${WF2}"]`)!.textContent).toBe("p***@example.com");
    expect(document.querySelector(`[data-inbox-row-assignee="${WF1}"]`)!.textContent).toBe("Unassigned");
    expect(document.body.textContent).not.toMatch(/Reviewer ref|bbbbbbbb/);
  });

  it("the table opts into the ≤ 900 px card layout and every row action is marked", async () => {
    await mount();
    const table = document.querySelector("[data-inbox-table]") as HTMLElement;
    expect(table.classList.contains("review-cards-900")).toBe(true);
    expect(document.querySelectorAll("[data-row-action]").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-inbox-view-tabs]")!.classList.contains("review-view-tabs")).toBe(true);
  });

  it("Assign on an unassigned row picks a reviewer and posts the audited single-assign route", async () => {
    await mount();
    fireEvent.click(document.querySelector(`[data-inbox-row-assign="${WF1}"]`)!);
    await settle();
    const dialog = await screen.findByRole("dialog");
    // T-086 — the picker names the member as the queue does (masked e-mail).
    const pickerRow = dialog.querySelector(`[data-reviewer-picker-row="${PEER}"]`) as HTMLElement;
    expect(within(pickerRow).getByText("p***@example.com")).toBeTruthy();
    expect(pickerRow.textContent).not.toMatch(/Reviewer ref|Unnamed reviewer|bbbbbbbb/);
    fireEvent.click(pickerRow.querySelector("[data-reviewer-picker-select]")!);
    await settle();
    const post = calls.find((c) => c.method === "POST" && c.path === `/v1/reviewer-ops/reviews/${WF1}/assign`);
    expect(post?.body).toEqual({ teamId: WS, assignedToUserId: PEER, note: null });
  });

  it("a Viewer gets Open only: no checkboxes, no Assign, no bulk tags", async () => {
    await mount("VIEWER");
    expect(document.querySelector("[data-inbox-row-assign]")).toBeNull();
    expect(document.querySelector("[data-inbox-row-checkbox]")).toBeNull();
    expect(document.querySelector("[data-inbox-bulk-tag-group]")).toBeNull();
    expect(document.querySelector(`[data-inbox-row-open="${WF1}"]`)).not.toBeNull();
  });
});

describe("T-082 — bulk coded values are tags", () => {
  it("no bare decision verb in the bulk options", async () => {
    await mount();
    fireEvent.click(document.querySelector(`[data-inbox-row-checkbox="${WF1}"]`)!);
    await settle();
    const trigger = document.querySelector("[data-inbox-bulk-tag-select]") as HTMLElement;
    fireEvent.click(trigger);
    const options = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? "");
    expect(options.length).toBe(4);
    for (const label of options) {
      expect(label.startsWith("Tag: ")).toBe(true);
      expect(label).not.toMatch(/^(Approve|Reject|Escalate|Needs info)$/);
    }
    expect(options).toContain("Tag: proposed reject");
  });
});

describe("T-094 / T-095 — keys and fan-out", () => {
  it("the help lists exactly the registered keys; J moves the selection; Enter opens with the view", async () => {
    nav.search = "view=OVERDUE";
    await mount();
    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const keys = Array.from(dialog.querySelectorAll("[data-reviewer-shortcut-key]")).map((k) => k.getAttribute("data-reviewer-shortcut-key"));
    expect(keys).toEqual([...INBOX_KEYMAP.map((b) => b.display), "Esc"]);
    expect(keys).not.toContain("E");
    expect(keys).not.toContain("M");
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    fireEvent.keyDown(window, { key: "?" });
    await settle();
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(nav.push).toHaveBeenLastCalledWith(`/reviewer-ops/${WF2}?from=inbox&view=OVERDUE`);
  });

  it("the first paint reads the view, its signals, saved views and the QC count — no console aggregator", async () => {
    await mount();
    const v1 = calls.filter((c) => c.path.startsWith("/v1/") && !c.path.startsWith("/v1/me/") && !c.path.startsWith("/v1/platform"));
    expect(v1.some((c) => c.path.startsWith("/v1/reviewer-ops/console"))).toBe(false);
    expect(v1.length).toBeLessThanOrEqual(6);
    // Load more scores only the appended rows.
  });

  it("Load more asks the signals for the new rows only", async () => {
    queueBody = { rows: [row(WF1, EV1)], nextCursor: WF1 };
    intelligence = [];
    await mount();
    queueBody = { rows: [row(WF2, EV2)], nextCursor: null };
    fireEvent.click(document.querySelector("[data-inbox-load-more]")!);
    await settle();
    const scored = calls.filter((c) => c.path.startsWith("/v1/reviewer-ops/queue-intelligence")).map((c) => (c.body as { workflowIds: string[] }).workflowIds);
    expect(scored).toEqual([[WF1], [WF2]]);
  });
});

describe("canonical controls (ported from the retired Queues row-shape test)", () => {
  it("every button carries a canonical class; rows offer Open + at most one secondary", async () => {
    await mount();
    for (const b of Array.from(document.querySelectorAll("[data-review-inbox] button"))) {
      expect(b.className, b.outerHTML.slice(0, 120)).toMatch(/\b(app-primary-action|app-secondary-action|app-ghost-action|app-danger-action|app-tab|app-listbox__trigger|app-checkbox)\b/);
    }
    for (const tr of Array.from(document.querySelectorAll("tr[data-inbox-row]"))) {
      const actions = tr.querySelectorAll('[data-review-cell="actions"] [data-row-action]');
      expect(actions.length).toBeGreaterThanOrEqual(1);
      expect(actions.length).toBeLessThanOrEqual(2);
      expect(actions[0]!.textContent).toBe("Open");
    }
  });
});

describe("T-065 — the handoff slices are Inbox views", () => {
  it("?view=AWAITING_SECOND_REVIEW loads that slice and says so when it is confirmed empty", async () => {
    nav.search = "view=AWAITING_SECOND_REVIEW";
    rows = [];
    await mount();
    expect(queueCalls()[0]!.path).toContain("queue=AWAITING_SECOND_REVIEW");
    expect(document.querySelector("[data-inbox-empty=\"AWAITING_SECOND_REVIEW\"]")!.textContent).toContain(
      "No reviews are waiting for an independent second reviewer.",
    );
  });

  it("the Conflicts view names challenged decisions apart (T-081)", async () => {
    nav.search = "view=AWAITING_ADJUDICATION";
    await mount();
    const hint = document.querySelector("[data-inbox-conflicts-hint]") as HTMLElement;
    expect(hint.textContent).toMatch(/first and second reviews reached different outcomes/);
    expect(hint.querySelector("[data-inbox-challenged-link]")!.getAttribute("href")).toBe("/review/disagreements");
  });
});

describe("T-084 — the Inbox string scan", () => {
  it("no raw enum, code or id fragment reaches the screen, even for an escalated, attention-band row", async () => {
    rows = [
      row(WF1, EV1, { lifecycleState: "ESCALATED", priority: "URGENT" }),
      row(WF2, EV2, { lifecycleState: "IN_REVIEW", assignedToUserId: PEER, assignee: null }),
    ];
    intelligence = [
      {
        workflowId: WF1,
        evidenceId: EV1,
        status: "ESCALATED",
        priority: { band: "ATTENTION", score: 60 },
        stuckState: { isStuck: true, topSeverity: "WARNING" },
        reviewerPressure: "overloaded",
        governanceBlockers: { legalHold: false, immutableDrift: false, packageBlocked: true, exportBlocked: true, retentionExpired: false },
        slaState: { status: "BREACHED", signal: "OVERDUE", dueAtUtc: GOVERNING_DUE, breachedAtUtc: GOVERNING_DUE },
        escalationState: { activeEscalationId: "e-1", severity: "WARNING", activeCount: 1 },
        queueAging: { createdAtUtc: GOVERNING_DUE, daysOpen: 3, agedFrom: "assigned", lastReviewerTouchAtUtc: null },
      },
    ];
    qcPending = { status: 200, count: 2 };
    await mount();
    const text = (document.querySelector("[data-review-inbox]") as HTMLElement).textContent ?? "";
    expect(reviewStringScanViolations(text)).toEqual([]);
  });
});

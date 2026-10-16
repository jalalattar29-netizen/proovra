/**
 * The Notifications page: All / Unread / Read, and read is a STATE.
 *
 * The server half (persistence, the read axis, mentions, counts, pagination,
 * tenant and role scope) is proven against live PostgreSQL + Redis in
 * `services/api/test/inbox-notification-lifecycle.integration.test.ts`. This
 * covers what lives here: what the page asks for, what it renders for each
 * state, and that no raw internal code reaches the reader.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/notifications",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../../lib/platform-context", () => ({
  useOrganizations: () => [],
  usePersonalSpace: () => ({ id: "ws-1" }),
  useActiveSpace: () => ({ type: "PERSONAL", id: "ws-1" }),
  useCan: () => false,
  usePlatformContext: () => ({ envelope: null }),
}));

vi.mock("../../lib/notifications/useOperationsUiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/notifications/useOperationsUiContext")>();
  return {
    ...actual,
    useOperationsUiContext: () =>
      actual.deriveOperationsUiContext({
        activeSpaceType: "PERSONAL",
        activeSpaceId: "ws-1",
        personalSpaceId: "ws-1",
        organizations: [],
        hasGovernanceCapability: false,
      }),
  };
});

type Row = {
  itemKey: string;
  category: string;
  tone: "info" | "warning" | "high" | "critical";
  title: string;
  href: string;
  isRead: boolean;
  /** Notification history: the condition behind it has cleared. */
  resolvedAt?: string;
};

let rows: Row[] = [];
let incompleteSources: string[] = [];
let truncated: Record<string, boolean> = {};
const calls: Array<{ path: string; method: string }> = [];

function envelope(path: string) {
  const url = new URL(path, "http://x");
  const readState = url.searchParams.get("readState");
  const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
  const population = rows.filter((r) =>
    readState === "unread" ? !r.isRead : readState === "read" ? r.isRead : true,
  );
  const items = population.slice(0, pageSize).map((r) => ({
    id: r.itemKey,
    itemKey: r.itemKey,
    category: r.category,
    tone: r.tone,
    priority: "P3",
    title: r.title,
    body: "Something happened.",
    href: r.href,
    occurredAt: "2026-10-01T10:00:00.000Z",
    isRead: r.isRead,
    readAt: r.isRead ? "2026-10-01T11:00:00.000Z" : null,
    dismissedAt: null,
    snoozedUntil: null,
    resolvedAt: r.resolvedAt ?? null,
    sourceClearedAt: r.resolvedAt ?? null,
    canMarkRead: !r.resolvedAt,
    canDismiss: !r.resolvedAt,
    canSnooze: !r.resolvedAt,
    context: {},
  }));
  const metric = {
    total: rows.length,
    unread: rows.filter((r) => !r.isRead).length,
    byTone: { critical: 0, high: 0, warning: 0, info: rows.length },
  };
  return {
    generatedAt: "2026-10-01T12:00:00.000Z",
    caller: { userId: "u1", email: null, displayName: null },
    summary: { total: population.length, byTone: metric.byTone, byCategory: {} },
    scopeSummary: { ...metric },
    metricSummary: metric,
    truncated,
    anyTruncated: Object.values(truncated).some(Boolean),
    completeness: {
      anyIncomplete: incompleteSources.length > 0,
      incompleteSources,
      mayAssertAllClear: incompleteSources.length === 0,
    },
    pagination: {
      offset: 0,
      pageSize,
      returned: items.length,
      nextCursor: null,
      totalEstimate: population.length,
      totalIsExact: !Object.values(truncated).some(Boolean),
      appliedFilter: "all",
      appliedTone: null,
    },
    items,
  };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    const action = path.match(/\/v1\/me\/inbox\/items\/([^/]+)\/(read|unread|archive|unarchive)$/);
    if (action && method === "POST") {
      const key = decodeURIComponent(action[1]);
      const row = rows.find((r) => r.itemKey === key);
      if (row && action[2] === "read") row.isRead = true;
      if (row && action[2] === "unread") row.isRead = false;
      return { itemKey: key, isRead: row?.isRead ?? false };
    }
    if (path.startsWith("/v1/me/inbox")) return envelope(path);
    return {};
  },
  ApiError: class ApiError extends Error {},
}));

import InboxPage from "../../app/(app)/inbox/page";

const RAW = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[a-z]+_[a-z_]+\b/;

function listCalls() {
  return calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/me/inbox?"));
}

function cardCount(key: string): number {
  const card = document.querySelector(`[data-notifications-metric="${key}"]`);
  return Number(card?.getAttribute("data-notifications-metric-count"));
}

beforeEach(() => {
  calls.length = 0;
  incompleteSources = [];
  truncated = {};
  rows = [
    { itemKey: "discussion_mention:m1", category: "discussion_mention", tone: "high", title: "You were mentioned", href: "/evidence/e1?tab=discussion&thread=t1", isRead: false },
    { itemKey: "collaboration:c1", category: "collaboration", tone: "info", title: "Team update", href: "/collaboration-teams", isRead: true },
    { itemKey: "future_kind:f1", category: "future_kind", tone: "info", title: "Future item", href: "https://evil.example/x", isRead: false },
  ];
  window.history.replaceState(null, "", "/notifications");
});

afterEach(() => cleanup());

async function ready() {
  await waitFor(() => expect(document.querySelector("[data-inbox-stream]")).not.toBeNull());
}

describe("Notifications page — All / Unread / Read", () => {
  it("opens on All: no read-state narrowing on the wire, read and unread rows together", async () => {
    render(<InboxPage />);
    await ready();
    expect(listCalls()[0].path).not.toContain("readState");
    const rowsShown = document.querySelectorAll("[data-inbox-item]");
    expect(rowsShown).toHaveLength(3);
    expect(document.querySelector('[data-inbox-item-key="collaboration:c1"]')?.getAttribute("data-inbox-item-read")).toBe("true");
  });

  it("offers All, Unread and Read in the quick control, and Read asks the server for readState=read", async () => {
    render(<InboxPage />);
    await ready();
    const quick = document.querySelector("[data-inbox-quick-filters]") as HTMLElement;
    for (const label of ["All", "Unread", "Read"]) {
      expect(within(quick).getByRole("button", { name: label })).toBeTruthy();
    }
    fireEvent.click(within(quick).getByRole("button", { name: "Read" }));
    await waitFor(() => expect(listCalls().at(-1)!.path).toContain("readState=read"));
    await waitFor(() => expect(document.querySelectorAll("[data-inbox-item]")).toHaveLength(1));
    expect(document.querySelector('[data-inbox-item-key="collaboration:c1"]')).not.toBeNull();
    expect(window.location.search).toContain("view=read");
  });

  it("a valid deep link (?view=read) opens on Read; an invalid one falls back to All", async () => {
    window.history.replaceState(null, "", "/notifications?view=read");
    render(<InboxPage />);
    await waitFor(() => expect(listCalls().some((c) => c.path.includes("readState=read"))).toBe(true));
    cleanup();
    calls.length = 0;
    window.history.replaceState(null, "", "/notifications?view=deleted");
    render(<InboxPage />);
    await ready();
    expect(listCalls().every((c) => !c.path.includes("readState"))).toBe(true);
  });

  it("Mark as read keeps the row in All as read and the Unread card reconciles from the server", async () => {
    render(<InboxPage />);
    await ready();
    expect(cardCount("unread")).toBe(2);
    expect(cardCount("all")).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Mark as read: You were mentioned" }));
    await waitFor(() => expect(cardCount("unread")).toBe(1));
    // Read moves a row between the halves of All; it never shrinks All.
    expect(cardCount("all")).toBe(3);
    const row = document.querySelector('[data-inbox-item-key="discussion_mention:m1"]');
    expect(row, "read must not remove the row from All").not.toBeNull();
    expect(row?.getAttribute("data-inbox-item-read")).toBe("true");
  });

  it("in the Unread view, a row read there leaves THAT view (it is still under All and Read)", async () => {
    window.history.replaceState(null, "", "/notifications?view=unread");
    render(<InboxPage />);
    await waitFor(() => expect(document.querySelectorAll("[data-inbox-item]")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Mark as read: You were mentioned" }));
    await waitFor(() => expect(document.querySelector('[data-inbox-item-key="discussion_mention:m1"]')).toBeNull());
  });
});

describe("Notifications page — no raw internal code reaches the reader", () => {
  it("categories render through the shared authority, an unknown one as a neutral label", async () => {
    incompleteSources = ["discussion_mention", "some_new_source"];
    render(<InboxPage />);
    await ready();
    const chips = [...document.querySelectorAll("[data-category-chip]")].map((n) => n.textContent);
    expect(chips).toEqual(["Mention", "Collaboration", "Notification"]);
    const note = document.querySelector("[data-notifications-incomplete]")!.textContent!;
    expect(note).toContain("Mention");
    expect(note).toContain("Other notifications");
    expect(document.body.textContent).not.toMatch(RAW);
  });

  it("an off-site link never becomes the row's destination", async () => {
    render(<InboxPage />);
    await ready();
    const open = document.querySelector('[data-inbox-item-key="future_kind:f1"] [data-action="open-inbox-item"]');
    expect(open?.getAttribute("href")).toBe("/notifications");
    const mention = document.querySelector('[data-inbox-item-key="discussion_mention:m1"] [data-action="open-inbox-item"]');
    expect(mention?.getAttribute("href")).toBe("/evidence/e1?tab=discussion&thread=t1");
  });
});

describe("Notifications page — notification history (resolved notifications)", () => {
  it("All and Read ask for notification history; the Archived lifecycle does not", async () => {
    render(<InboxPage />);
    await ready();
    expect(listCalls()[0].path).toContain("include=resolved");
    const quick = document.querySelector("[data-inbox-quick-filters]") as HTMLElement;
    fireEvent.click(within(quick).getByRole("button", { name: "Read" }));
    await waitFor(() => expect(listCalls().at(-1)!.path).toContain("readState=read"));
    expect(listCalls().at(-1)!.path).toContain("include=resolved");
    cleanup();
    calls.length = 0;
    window.history.replaceState(null, "", "/notifications?lifecycle=archived");
    render(<InboxPage />);
    await waitFor(() => expect(listCalls().some((c) => c.path.includes("lifecycle=archived"))).toBe(true));
    for (const c of listCalls().filter((c) => c.path.includes("lifecycle=archived"))) {
      expect(c.path).not.toContain("include=resolved");
    }
  });

  it("a resolved notification stays listed as read history: marked no longer active, still openable, no read toggle", async () => {
    rows.push({
      itemKey: "report_failure:r1",
      category: "report_failure",
      tone: "high",
      title: "Report generation failed",
      href: "/reports/r1",
      isRead: true,
      resolvedAt: "2026-10-02T09:00:00.000Z",
    });
    window.history.replaceState(null, "", "/notifications?view=read");
    render(<InboxPage />);
    await waitFor(() =>
      expect(document.querySelector('[data-inbox-item-key="report_failure:r1"]')).not.toBeNull(),
    );
    const row = document.querySelector('[data-inbox-item-key="report_failure:r1"]') as HTMLElement;
    expect(row.getAttribute("data-inbox-item-read")).toBe("true");
    expect(row.querySelector("[data-inbox-item-resolved]")).not.toBeNull();
    expect(row.querySelector('[data-action="open-inbox-item"]')?.getAttribute("href")).toBe("/reports/r1");
    expect(row.querySelector('[data-action="mark-unread"]')).toBeNull();
    expect(row.querySelector('[data-action="mark-read"]')).toBeNull();
  });

  it("a capped history read is reported in the reader's words, never as a raw source code", async () => {
    truncated = { notification_history: true };
    render(<InboxPage />);
    await ready();
    expect(document.body.textContent).toContain("Earlier notifications");
    expect(document.body.textContent).not.toContain("notification_history");
  });
});

/**
 * The bell is a RECENT list whose rows survive being read.
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 *
 * The dropdown used to query `filter=unread`, so the list WAS the unread set:
 * marking an item read removed it, which made acknowledging a notification
 * indistinguishable from dismissing one, and left a caught-up user staring at
 * an empty panel with no way to tell "nothing happened" from "you read it".
 *
 * The two concepts are now separate and each has one owner:
 *   READ      — a state. The row stays, quieter, and leaves the badge count.
 *   DISMISSED — removal. The row goes and the next eligible item takes its
 *               place.
 *
 * The server half (ordering, the five-item window, workspace scope, real
 * persistence) is proven against live PostgreSQL in
 * `services/api/test/inbox-recent-bell.integration.test.ts`. This covers the
 * half that lives here: what the component asks for, what it renders for each
 * state, and what it does when requests race.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];
let apiImpl: (path: string, init?: RequestInit) => Promise<unknown> = async () =>
  ({});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return apiImpl(path, init);
  },
  ApiError: class ApiError extends Error {},
}));

let contextGeneration = 0;
let activeWorkspaceId: string | null = "ws-1";
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ contextGeneration, activeWorkspaceId }),
}));

vi.mock("../../lib/navigation/useDeepLinkNavigation", () => ({
  useDeepLinkNavigation: () => ({
    open: async () => ({ status: "navigated" as const }),
  }),
}));

// ---------------------------------------------------------------------------
// A tiny server: the five-most-recent window, read state, and dismissal.
// ---------------------------------------------------------------------------

type Row = {
  itemKey: string;
  title: string;
  occurredAt: string;
  isRead: boolean;
  dismissed: boolean;
};

const PREVIEW = 5;

function makeRows(n: number, over: Partial<Row> = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    itemKey: `intake_submission_pending_review:${i + 1}`,
    title: `Submission ${i + 1} needs review`,
    // Descending recency: item 1 is the newest.
    occurredAt: new Date(Date.UTC(2026, 7, 21, 12, 0, n - i)).toISOString(),
    isRead: false,
    dismissed: false,
    ...over,
  }));
}

/** Installs an API over a mutable row set, mirroring the real contract. */
function installServer(rows: Row[]) {
  const visible = () =>
    rows
      .filter((r) => !r.dismissed)
      .slice()
      .sort(
        (a, b) =>
          b.occurredAt.localeCompare(a.occurredAt) ||
          a.itemKey.localeCompare(b.itemKey),
      );

  apiImpl = async (path, init) => {
    if (path.startsWith("/v1/me/inbox/summary")) {
      const unread = visible().filter((r) => !r.isRead).length;
      return {
        unread,
        critical: 0,
        high: 0,
        assignedToMe: 0,
        overdue: 0,
        hasTruncatedSources: false,
        degraded: false,
        generatedAtUtc: new Date().toISOString(),
      };
    }
    if (path.startsWith("/v1/me/inbox?")) {
      const window = visible().slice(0, PREVIEW);
      return {
        items: window.map((r) => ({
          id: r.itemKey,
          itemKey: r.itemKey,
          category: "intake_submission_pending_review",
          tone: "warning",
          priority: "P2",
          title: r.title,
          body: "Open the request for details.",
          href: `/evidence-requests/${r.itemKey}`,
          occurredAt: r.occurredAt,
          isRead: r.isRead,
          canDismiss: true,
          context: {},
        })),
        pagination: { totalEstimate: visible().length, totalIsExact: true },
      };
    }
    if (init?.method === "POST" && path.endsWith("/mark-all-read")) {
      const targets = visible().filter((r) => !r.isRead);
      for (const r of targets) r.isRead = true;
      return { markedRead: targets.length };
    }
    if (init?.method === "POST") {
      const row = rows.find((r) => path.includes(encodeURIComponent(r.itemKey)));
      if (row && path.endsWith("/read")) {
        row.isRead = true;
        return { isRead: true };
      }
      if (row && path.endsWith("/dismiss")) {
        row.dismissed = true;
        row.isRead = true;
        return { dismissedAt: new Date().toISOString() };
      }
    }
    return {};
  };
  return { rows, visible };
}

async function mountBell() {
  const { NotificationBell } = await import(
    "../../components/app-shell-v2/NotificationBell"
  );
  render(<NotificationBell />);
}

function unreadAttr(): string | null {
  return (
    document
      .querySelector("[data-notification-bell-unread]")
      ?.getAttribute("data-notification-bell-unread") ?? null
  );
}
function badge(): string | null {
  return document.querySelector("[data-notification-bell-badge]")?.textContent ?? null;
}
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".ops-bell-row"));
}
function readFlags(): string[] {
  return rows().map((r) => r.getAttribute("data-notification-row-read") ?? "?");
}
function titles(): string[] {
  return rows().map(
    (r) => r.querySelector(".ops-bell-row__title")?.textContent?.trim() ?? "",
  );
}

async function openPopover(firstTitle: string) {
  fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
  await waitFor(() => expect(screen.getByText(firstTitle)).toBeTruthy());
}

beforeEach(() => {
  calls.length = 0;
  contextGeneration = 0;
  activeWorkspaceId = "ws-1";
  apiImpl = async () => ({});
});
afterEach(() => cleanup());

// ===========================================================================
// What the component ASKS FOR
// ===========================================================================

describe("the bell asks the server for a recent list, not an unread one", () => {
  it("requests the five most recent visible items, scoped to the workspace", async () => {
    installServer(makeRows(3));
    await mountBell();
    await waitFor(() => expect(unreadAttr()).toBe("3"));
    await openPopover("Submission 1 needs review");

    const listCall = calls.find((c) => c.path.startsWith("/v1/me/inbox?"));
    expect(listCall, "no list request was made").toBeTruthy();
    // `filter=all`, NOT `filter=unread` — the old query is why a read item
    // disappeared: it left the list's own population.
    expect(listCall!.path).toContain("filter=all");
    expect(listCall!.path).not.toContain("filter=unread");
    // Recency, decided by the server. Not re-sorted here.
    expect(listCall!.path).toContain("sort=recent");
    expect(listCall!.path).toContain(`pageSize=${PREVIEW}`);
    expect(listCall!.path).toContain("workspaceId=ws-1");

    // The badge is the SUMMARY's number, under the same scope.
    const summaryCall = calls.find((c) =>
      c.path.startsWith("/v1/me/inbox/summary"),
    );
    expect(summaryCall!.path).toContain("workspaceId=ws-1");
  });

  it("never fetches read and unread separately to merge them here", async () => {
    installServer(makeRows(3));
    await mountBell();
    await openPopover("Submission 1 needs review");
    const listCalls = calls.filter((c) => c.path.startsWith("/v1/me/inbox?"));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const c of listCalls) expect(c.path).toContain("filter=all");
  });
});

// ===========================================================================
// B8 1–5: read keeps the row, dismiss removes it
// ===========================================================================

describe("read is a state; dismissed is removal", () => {
  it("1. one unread → Mark read → the row REMAINS and the badge is zero", async () => {
    installServer(makeRows(1));
    await mountBell();
    await waitFor(() => expect(unreadAttr()).toBe("1"));
    await openPopover("Submission 1 needs review");

    fireEvent.click(
      screen.getByRole("button", { name: /^Mark as read: Submission 1/ }),
    );

    await waitFor(() => expect(unreadAttr()).toBe("0"));
    expect(badge()).toBeNull();
    // THE regression this suite is named for: the row is still there.
    expect(titles()).toEqual(["Submission 1 needs review"]);
    expect(readFlags()).toEqual(["true"]);
    // …and its Mark-read control is gone, because it can no longer do
    // anything. Dismiss stays.
    expect(
      screen.queryByRole("button", { name: /^Mark as read: Submission 1/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Dismiss: Submission 1/ }),
    ).toBeTruthy();
  });

  it("2. three unread → Mark one → all three rows remain, badge is two", async () => {
    installServer(makeRows(3));
    await mountBell();
    await waitFor(() => expect(unreadAttr()).toBe("3"));
    await openPopover("Submission 1 needs review");

    fireEvent.click(
      screen.getByRole("button", { name: /^Mark as read: Submission 2/ }),
    );

    await waitFor(() => expect(unreadAttr()).toBe("2"));
    expect(rows()).toHaveLength(3);
    expect(readFlags()).toEqual(["false", "true", "false"]);
  });

  it("3. five unread → Mark all → five READ rows remain, badge is zero", async () => {
    installServer(makeRows(5));
    await mountBell();
    await waitFor(() => expect(unreadAttr()).toBe("5"));
    await openPopover("Submission 1 needs review");

    fireEvent.click(screen.getByRole("button", { name: /mark all as read/i }));

    await waitFor(() => expect(unreadAttr()).toBe("0"));
    // Mark-all must not empty the dropdown.
    expect(rows()).toHaveLength(5);
    expect(readFlags()).toEqual(["true", "true", "true", "true", "true"]);
    await waitFor(() =>
      expect(screen.getByText("5 notifications marked as read.")).toBeTruthy(),
    );
  });

  it("4. unread → Dismiss → the row goes and the next recent item fills the list", async () => {
    // Six eligible items, so a dismissal has a sixth to promote.
    installServer(makeRows(6));
    await mountBell();
    await openPopover("Submission 1 needs review");
    expect(rows()).toHaveLength(PREVIEW);
    expect(titles()).not.toContain("Submission 6 needs review");

    fireEvent.click(
      screen.getByRole("button", { name: /^Dismiss: Submission 1/ }),
    );

    await waitFor(() =>
      expect(titles()).not.toContain("Submission 1 needs review"),
    );
    // Still five: the next most recent eligible item took the empty slot.
    expect(rows()).toHaveLength(PREVIEW);
    expect(titles()).toContain("Submission 6 needs review");
    await waitFor(() => expect(unreadAttr()).toBe("5"));
  });

  it("5. a READ row can still be dismissed, and the badge does not move", async () => {
    const rowSet = makeRows(2);
    rowSet[0].isRead = true;
    installServer(rowSet);
    await mountBell();
    await waitFor(() => expect(unreadAttr()).toBe("1"));
    await openPopover("Submission 1 needs review");

    fireEvent.click(
      screen.getByRole("button", { name: /^Dismiss: Submission 1/ }),
    );

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(titles()).toEqual(["Submission 2 needs review"]);
    // It was already read, so dismissing it cannot decrement the unread count.
    expect(unreadAttr()).toBe("1");
  });
});

// ===========================================================================
// B8 6–8: ordering and the window
// ===========================================================================

describe("the five-item window and its ordering", () => {
  it("6. mixed read/unread keep ONE recency order, not read-last", async () => {
    const rowSet = makeRows(4);
    rowSet[1].isRead = true;
    rowSet[3].isRead = true;
    installServer(rowSet);
    await mountBell();
    await openPopover("Submission 1 needs review");
    // Server order preserved verbatim: recency, regardless of read state.
    expect(titles()).toEqual([
      "Submission 1 needs review",
      "Submission 2 needs review",
      "Submission 3 needs review",
      "Submission 4 needs review",
    ]);
    expect(readFlags()).toEqual(["false", "true", "false", "true"]);
  });

  it("7. more than five notifications → only the newest five are shown", async () => {
    installServer(makeRows(9));
    await mountBell();
    await openPopover("Submission 1 needs review");
    expect(rows()).toHaveLength(PREVIEW);
    expect(titles()).toEqual([
      "Submission 1 needs review",
      "Submission 2 needs review",
      "Submission 3 needs review",
      "Submission 4 needs review",
      "Submission 5 needs review",
    ]);
    // The badge counts the whole unread population, not the window.
    await waitFor(() => expect(unreadAttr()).toBe("9"));
  });

  it("8. the component does not reorder what the server sent", async () => {
    // Equal timestamps: the server's tie-break is the authority, and the
    // client must render the sequence it was given.
    const rowSet = makeRows(3).map((r) => ({
      ...r,
      occurredAt: "2026-08-21T12:00:00.000Z",
    }));
    installServer(rowSet);
    await mountBell();
    await openPopover("Submission 1 needs review");
    expect(titles()).toEqual([
      "Submission 1 needs review",
      "Submission 2 needs review",
      "Submission 3 needs review",
    ]);
  });
});

// ===========================================================================
// B8 9–11: idempotency, failure, staleness
// ===========================================================================

describe("mutations are safe to repeat, fail loudly, and cannot be undone by a poll", () => {
  it("9. a second click cannot start a second write", async () => {
    installServer(makeRows(1));
    let posts = 0;
    let release: (() => void) | null = null;
    const base = apiImpl;
    apiImpl = async (path, init) => {
      if (init?.method === "POST" && path.endsWith("/read")) {
        posts += 1;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return base(path, init);
    };

    await mountBell();
    await openPopover("Submission 1 needs review");
    const button = screen.getByRole("button", {
      name: /^Mark as read: Submission 1/,
    });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(posts).toBe(1));
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(unreadAttr()).toBe("0"));
    expect(posts).toBe(1);
  });

  it("10. a failed mutation changes nothing locally and announces itself", async () => {
    installServer(makeRows(1));
    const base = apiImpl;
    apiImpl = async (path, init) => {
      if (init?.method === "POST") throw new Error("boom");
      return base(path, init);
    };

    await mountBell();
    await openPopover("Submission 1 needs review");
    expect(unreadAttr()).toBe("1");

    fireEvent.click(
      screen.getByRole("button", { name: /^Mark as read: Submission 1/ }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("Could not mark that notification as read."),
      ).toBeTruthy(),
    );
    // No local decrement stood in for the write that did not happen.
    expect(unreadAttr()).toBe("1");
    expect(readFlags()).toEqual(["false"]);
    const status = document.querySelector("[data-notification-action-status]");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    // The panel stays open so the message can be read.
    expect(document.querySelector("[data-notification-bell-popover]")).toBeTruthy();
  });

  it("11. a poll that left BEFORE the mutation cannot restore the unread state", async () => {
    const server = installServer(makeRows(1));
    let stalePollIssued = false;
    let releaseStale: (() => void) | null = null;
    const base = apiImpl;
    apiImpl = async (path, init) => {
      if (path.startsWith("/v1/me/inbox/summary") && !stalePollIssued) {
        stalePollIssued = true;
        // Captured BEFORE the mutation: a truthful description of a world
        // that is about to stop existing.
        const stale = await base(path, init);
        await new Promise<void>((r) => {
          releaseStale = r;
        });
        return stale;
      }
      return base(path, init);
    };

    await mountBell();
    await waitFor(() => expect(stalePollIssued).toBe(true));
    await openPopover("Submission 1 needs review");

    fireEvent.click(
      screen.getByRole("button", { name: /^Mark as read: Submission 1/ }),
    );
    await waitFor(() => expect(unreadAttr()).toBe("0"));

    await act(async () => {
      releaseStale?.();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(unreadAttr()).toBe("0");
    expect(server.visible()[0].isRead).toBe(true);
  });
});

// ===========================================================================
// B8 12–13: identity and workspace switching
// ===========================================================================

describe("switching context drops the previous state", () => {
  it("12. switching workspace clears the count synchronously and rescopes", async () => {
    installServer(makeRows(4));
    const { NotificationBell } = await import(
      "../../components/app-shell-v2/NotificationBell"
    );
    const view = render(<NotificationBell />);
    await waitFor(() => expect(unreadAttr()).toBe("4"));

    activeWorkspaceId = "ws-2";
    contextGeneration = 1;
    installServer(makeRows(1));
    view.rerender(<NotificationBell />);

    // Zero the instant the context changes — not after the replacement lands.
    expect(unreadAttr()).toBe("0");
    await waitFor(() => expect(unreadAttr()).toBe("1"));
    const rescoped = calls
      .filter((c) => c.path.startsWith("/v1/me/inbox/summary"))
      .at(-1);
    expect(rescoped!.path).toContain("workspaceId=ws-2");
  });

  it("13. switching account clears the count and the rows", async () => {
    installServer(makeRows(3));
    const { NotificationBell } = await import(
      "../../components/app-shell-v2/NotificationBell"
    );
    const view = render(<NotificationBell />);
    await waitFor(() => expect(unreadAttr()).toBe("3"));
    await openPopover("Submission 1 needs review");
    expect(rows()).toHaveLength(3);

    installServer([]);
    contextGeneration = 2;
    view.rerender(<NotificationBell />);

    expect(unreadAttr()).toBe("0");
    await waitFor(() => expect(rows()).toHaveLength(0));
  });
});

// ===========================================================================
// B8 18–20: accessibility and stability
// ===========================================================================

describe("read state is announced, and reading a row moves nothing", () => {
  it("18. every row states Read or Unread in text", async () => {
    const rowSet = makeRows(2);
    rowSet[0].isRead = true;
    installServer(rowSet);
    await mountBell();
    await openPopover("Submission 1 needs review");

    const statuses = rows().map(
      (r) => r.querySelector(".app-visually-hidden")?.textContent?.trim(),
    );
    expect(statuses).toEqual(["Read", "Unread"]);
  });

  it("19. unread is not signalled by colour alone", async () => {
    const rowSet = makeRows(2);
    rowSet[0].isRead = true;
    installServer(rowSet);
    await mountBell();
    await openPopover("Submission 1 needs review");

    // Three non-colour signals: the text status above, the presence/absence of
    // the dot, and the row's own state attribute.
    const dots = rows().map((r) =>
      r
        .querySelector(".ops-bell-row__dot")
        ?.getAttribute("data-notification-unread-dot"),
    );
    expect(dots).toEqual(["false", "true"]);
    expect(readFlags()).toEqual(["true", "false"]);
  });

  it("20. Mark read and Dismiss stay two controls with two distinct names", async () => {
    installServer(makeRows(3));
    await mountBell();
    await openPopover("Submission 1 needs review");

    const read = screen.getAllByRole("button", { name: /^Mark as read: / });
    const dismiss = screen.getAllByRole("button", { name: /^Dismiss: / });
    expect(read).toHaveLength(3);
    expect(dismiss).toHaveLength(3);
    const names = [...read, ...dismiss].map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).not.toMatch(/Mark readDismiss/);
    // No nested interactive elements, and no control inside the row's link.
    for (const b of [...read, ...dismiss]) {
      expect(b.querySelector("button, a")).toBeNull();
      expect(b.closest("a")).toBeNull();
    }
  });

  it("21. the row keeps its anatomy when it becomes read — no layout shift", async () => {
    installServer(makeRows(1));
    await mountBell();
    await openPopover("Submission 1 needs review");

    const before = rows()[0];
    const beforeShape = {
      dot: Boolean(before.querySelector(".ops-bell-row__dot")),
      title: Boolean(before.querySelector(".ops-bell-row__title")),
      body: Boolean(before.querySelector(".ops-bell-row__body")),
      meta: Boolean(before.querySelector(".ops-bell-row__meta")),
    };

    fireEvent.click(
      screen.getByRole("button", { name: /^Mark as read: Submission 1/ }),
    );
    await waitFor(() => expect(readFlags()).toEqual(["true"]));

    const after = rows()[0];
    // The DOT is still present — hidden by CSS, not removed — so the title's
    // indent cannot change. Every other part of the anatomy is unchanged.
    expect({
      dot: Boolean(after.querySelector(".ops-bell-row__dot")),
      title: Boolean(after.querySelector(".ops-bell-row__title")),
      body: Boolean(after.querySelector(".ops-bell-row__body")),
      meta: Boolean(after.querySelector(".ops-bell-row__meta")),
    }).toEqual(beforeShape);
  });

  it("offers a truthful link to the full list", async () => {
    installServer(makeRows(1));
    await mountBell();
    await openPopover("Submission 1 needs review");
    const link = screen.getByRole("link", { name: /view all notifications/i });
    // A real route, not a placeholder.
    expect(link.getAttribute("href")).toBe("/inbox");
  });
});

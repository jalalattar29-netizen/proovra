/**
 * The header bell's badge tracks the SERVER, and nothing else can move it.
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 *
 * The badge stuck on `1` in production. The server half of that is fixed and
 * proven against a real database elsewhere
 * (`services/api/test/inbox-unread-state.integration.test.ts`). This suite
 * covers the half that lives here: that the component applies the server's
 * post-mutation answer, that a response which left BEFORE the mutation cannot
 * overwrite it, that a second click cannot start a second write, and that a
 * failed write is announced rather than swallowed.
 *
 * There is deliberately no test for a local decrement, because there is no
 * local decrement. A client-side count is a guess about a ~19-source
 * server-side computation; the refetch is the answer.
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

// The identity/tenant generation the bell resets on. Driven per test.
let contextGeneration = 0;
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ contextGeneration }),
}));

vi.mock("../../lib/navigation/useDeepLinkNavigation", () => ({
  useDeepLinkNavigation: () => ({
    open: async () => ({ status: "navigated" as const }),
  }),
}));

function summary(unread: number) {
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

function item(n: number) {
  return {
    id: `n${n}`,
    itemKey: `intake_submission_pending_review:${n}`,
    category: "intake_submission_pending_review",
    tone: "warning" as const,
    priority: "P2" as const,
    title: `Submission ${n} needs review`,
    body: "Open the request for details.",
    href: `/evidence-requests/${n}`,
    occurredAt: new Date().toISOString(),
    canDismiss: true,
    context: {},
  };
}

function list(items: ReturnType<typeof item>[]) {
  return {
    items,
    pagination: { totalEstimate: items.length, totalIsExact: true },
  };
}

async function mountBell() {
  const { NotificationBell } = await import(
    "../../components/app-shell-v2/NotificationBell"
  );
  render(<NotificationBell />);
}

function badge(): string | null {
  const el = document.querySelector("[data-notification-bell-badge]");
  return el ? el.textContent : null;
}

function unreadAttr(): string | null {
  const el = document.querySelector("[data-notification-bell-unread]");
  return el ? el.getAttribute("data-notification-bell-unread") : null;
}

async function openPopover(firstTitle: string) {
  fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
  await waitFor(() => expect(screen.getByText(firstTitle)).toBeTruthy());
}

beforeEach(() => {
  calls.length = 0;
  contextGeneration = 0;
  apiImpl = async () => ({});
});

afterEach(() => {
  cleanup();
});

describe("NotificationBell — the badge follows the server", () => {
  it("Mark read: the badge goes 1 → 0 using the refetched count", async () => {
    let unread = 1;
    let rows = [item(1)];
    apiImpl = async (path, init) => {
      if (path === "/v1/me/inbox/summary") return summary(unread);
      if (path.startsWith("/v1/me/inbox?")) return list(rows);
      if (init?.method === "POST" && path.includes("/read")) {
        unread = 0;
        rows = [];
        return { isRead: true };
      }
      return {};
    };

    await mountBell();
    await waitFor(() => expect(badge()).toBe("1"));
    await openPopover("Submission 1 needs review");

    fireEvent.click(
      screen.getByRole("button", { name: /^Mark as read: Submission 1/ }),
    );

    // The badge disappears entirely at zero — `has` gates it — so the
    // authoritative reading is the attribute, which is always present.
    await waitFor(() => expect(unreadAttr()).toBe("0"));
    expect(badge()).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("No unread notifications.")).toBeTruthy(),
    );
  });

  it("Mark all as read: three become zero and the server's count is reported", async () => {
    let unread = 3;
    let rows = [item(1), item(2), item(3)];
    apiImpl = async (path, init) => {
      if (path === "/v1/me/inbox/summary") return summary(unread);
      if (path.startsWith("/v1/me/inbox?")) return list(rows);
      if (init?.method === "POST" && path.endsWith("/mark-all-read")) {
        const marked = rows.length;
        unread = 0;
        rows = [];
        return { markedRead: marked };
      }
      return {};
    };

    await mountBell();
    await waitFor(() => expect(badge()).toBe("3"));
    await openPopover("Submission 1 needs review");

    fireEvent.click(screen.getByRole("button", { name: /mark all as read/i }));

    await waitFor(() => expect(unreadAttr()).toBe("0"));
    // What the SERVER did, announced. Not "done", which would be a claim about
    // an outcome the client did not observe.
    await waitFor(() =>
      expect(
        screen.getByText("3 notifications marked as read."),
      ).toBeTruthy(),
    );
  });

  it("Dismiss: the row leaves the panel and the count drops", async () => {
    let unread = 2;
    let rows = [item(1), item(2)];
    apiImpl = async (path, init) => {
      if (path === "/v1/me/inbox/summary") return summary(unread);
      if (path.startsWith("/v1/me/inbox?")) return list(rows);
      if (init?.method === "POST" && path.includes("/dismiss")) {
        rows = rows.filter((r) => !path.includes(encodeURIComponent(r.itemKey)));
        unread = rows.length;
        return { dismissedAt: new Date().toISOString() };
      }
      return {};
    };

    await mountBell();
    await openPopover("Submission 1 needs review");

    fireEvent.click(
      screen.getByRole("button", { name: /^Dismiss: Submission 1/ }),
    );

    await waitFor(() => expect(unreadAttr()).toBe("1"));
    expect(screen.queryByText("Submission 1 needs review")).toBeNull();
    expect(screen.getByText("Submission 2 needs review")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("Notification dismissed.")).toBeTruthy(),
    );
  });

  // =========================================================================
  // The race the epoch exists for
  // =========================================================================

  it("a poll that left BEFORE the mutation cannot restore the old count", async () => {
    let unread = 1;
    let rows = [item(1)];
    // A summary request that is deliberately slow. It is issued before the
    // mutation and resolves after it, carrying the pre-mutation count — the
    // exact shape of "the badge went back to 1".
    let releaseStalePoll: (() => void) | null = null;
    let stalePollIssued = false;

    apiImpl = async (path, init) => {
      if (path === "/v1/me/inbox/summary") {
        if (!stalePollIssued) {
          stalePollIssued = true;
          const staleValue = summary(unread);
          await new Promise<void>((resolve) => {
            releaseStalePoll = resolve;
          });
          return staleValue;
        }
        return summary(unread);
      }
      if (path.startsWith("/v1/me/inbox?")) return list(rows);
      if (init?.method === "POST" && path.includes("/read")) {
        unread = 0;
        rows = [];
        return { isRead: true };
      }
      return {};
    };

    await mountBell();
    // The first (stale) summary is now suspended mid-flight.
    await waitFor(() => expect(stalePollIssued).toBe(true));

    await openPopover("Submission 1 needs review");
    await waitFor(() => expect(unreadAttr()).toBe("1"));

    fireEvent.click(
      screen.getByRole("button", { name: /^Mark as read: Submission 1/ }),
    );
    await waitFor(() => expect(unreadAttr()).toBe("0"));

    // NOW let the pre-mutation poll land. It is truthful about a world that no
    // longer exists, so it must be discarded rather than applied.
    await act(async () => {
      releaseStalePoll?.();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(unreadAttr()).toBe("0");
  });

  it("a second click cannot start a second write", async () => {
    let unread = 1;
    let posts = 0;
    let releaseMutation: (() => void) | null = null;
    apiImpl = async (path, init) => {
      if (path === "/v1/me/inbox/summary") return summary(unread);
      if (path.startsWith("/v1/me/inbox?")) return list(unread ? [item(1)] : []);
      if (init?.method === "POST" && path.includes("/read")) {
        posts += 1;
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
        unread = 0;
        return { isRead: true };
      }
      return {};
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
    // The control is also visibly unavailable while the write is in flight, so
    // the guard is not the only thing standing between a user and a double
    // submit.
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      releaseMutation?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(unreadAttr()).toBe("0"));
    expect(posts).toBe(1);
  });

  it("a failed mutation changes nothing locally and says so", async () => {
    apiImpl = async (path, init) => {
      if (path === "/v1/me/inbox/summary") return summary(1);
      if (path.startsWith("/v1/me/inbox?")) return list([item(1)]);
      if (init?.method === "POST") throw new Error("boom");
      return {};
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
    // The server state did not change, so neither does the badge. A local
    // decrement here would show a cleared badge over an uncleared inbox.
    expect(unreadAttr()).toBe("1");
    expect(screen.getByText("Submission 1 needs review")).toBeTruthy();
    // The outcome is announced, not merely rendered.
    const status = document.querySelector(
      "[data-notification-action-status]",
    );
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });

  // =========================================================================
  // Identity change
  // =========================================================================

  it("switching account drops the previous account's count immediately", async () => {
    let unread = 4;
    apiImpl = async (path) => {
      if (path === "/v1/me/inbox/summary") return summary(unread);
      if (path.startsWith("/v1/me/inbox?")) return list([item(1)]);
      return {};
    };

    const { NotificationBell } = await import(
      "../../components/app-shell-v2/NotificationBell"
    );
    const view = render(<NotificationBell />);
    await waitFor(() => expect(badge()).toBe("4"));

    // The new account has nothing waiting.
    unread = 0;
    contextGeneration = 1;
    view.rerender(<NotificationBell />);

    // Zero SYNCHRONOUSLY with the switch — not after the replacement request
    // lands. Carrying "4" across would attribute one account's unread work to
    // another for the length of a round trip.
    expect(unreadAttr()).toBe("0");
    await waitFor(() => expect(unreadAttr()).toBe("0"));
  });

  // =========================================================================
  // Presentation
  // =========================================================================

  it("Mark read and Dismiss are two controls with two distinct accessible names", async () => {
    apiImpl = async (path) => {
      if (path === "/v1/me/inbox/summary") return summary(2);
      if (path.startsWith("/v1/me/inbox?")) return list([item(1), item(2)]);
      return {};
    };

    await mountBell();
    await openPopover("Submission 1 needs review");

    const read = screen.getAllByRole("button", { name: /^Mark as read: / });
    const dismiss = screen.getAllByRole("button", { name: /^Dismiss: / });
    expect(read).toHaveLength(2);
    expect(dismiss).toHaveLength(2);

    // Every accessible name is unique, so a screen-reader user moving by
    // control can tell the eight identical-looking buttons apart — and the two
    // labels are never read as one run of text.
    const names = [...read, ...dismiss].map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).not.toMatch(/Mark readDismiss/);
    }

    // Neither control is nested inside the other, or inside the row's link.
    for (const b of [...read, ...dismiss]) {
      expect(b.querySelector("button, a")).toBeNull();
      expect(b.closest("a")).toBeNull();
    }
  });

  it("the bell polls the summary and does not fetch rows until it is opened", async () => {
    apiImpl = async (path) => {
      if (path === "/v1/me/inbox/summary") return summary(1);
      if (path.startsWith("/v1/me/inbox?")) return list([item(1)]);
      return {};
    };

    await mountBell();
    await waitFor(() => expect(badge()).toBe("1"));

    // The expensive row fetch is not part of awareness.
    expect(calls.some((c) => c.path.startsWith("/v1/me/inbox?"))).toBe(false);

    await openPopover("Submission 1 needs review");
    expect(calls.some((c) => c.path.startsWith("/v1/me/inbox?"))).toBe(true);
  });
});

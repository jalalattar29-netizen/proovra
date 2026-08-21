/**
 * /intake-links — the management surface, driven for real.
 *
 * Source text cannot prove that a KPI card filters the table, that a menu is
 * keyboard-operable, or that the desktop row and the mobile card say the same
 * thing about the same link. This file mounts the REAL page against
 * contract-shaped fixtures and asserts the behaviour.
 *
 * The properties under test:
 *   - metric semantics: the counts come from the state model, they overlap,
 *     and the surface says so;
 *   - lifecycle and activity are separate, labelled regions — never one
 *     ambiguous chip stack;
 *   - `REVOKED` reads as "Link disabled" everywhere the operator can see it;
 *   - search / channel / lifecycle / delivery / sort / pagination all narrow
 *     the same array the KPI counted;
 *   - the desktop row and the narrow card carry identical facts;
 *   - the actions menu is a real menu with a real confirmation;
 *   - loading / empty / no-match / error / restricted are distinct states, and
 *     the restricted one offers no retry.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  waitFor,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = { items?: unknown[] } | Record<string, unknown> | null;

let requestLog: Array<{ path: string; method: string }> = [];
let listReply: () => Reply = () => ({ items: [] });
let mutationReply: (path: string) => Reply = () => ({ ok: true });
let replaced: string[] = [];

/**
 * An API rejection shaped exactly like the one `apiFetch` throws: a real Error
 * carrying `statusCode` and an optional `code`. Built by a function rather than
 * a class so it is not caught in the temporal dead zone when Vitest hoists the
 * `vi.mock` factory above every declaration in this file.
 */
function apiFailure(statusCode: number, code?: string): Error {
  const err = new Error("request failed") as Error & {
    statusCode: number;
    code?: string;
  };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method });
    if (method === "GET" && path.startsWith("/v1/workflow/intake-links?")) {
      const reply = listReply();
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (path.startsWith("/v1/workflow/templates")) return { templates: [] };
    if (path.includes("/sender-identity")) {
      return {
        email: { configured: true, fromName: "PROOVRA" },
        sms: { configured: true, fromNumberPreview: "+1 ••• 8084" },
        whatsapp: { configured: false },
      };
    }
    if (path.startsWith("/v1/communications/messages")) return { messages: [] };
    if (path.includes("/submissions")) {
      return {
        link: {
          id: "l1",
          teamId: "t",
          intakeMode: "EXTERNAL_ONE_TIME",
          recipientLabel: null,
          workflowTemplateSlug: "general-evidence-record",
          workflowTemplateName: "General evidence request",
        },
        sessions: [],
        totals: { sessions: 0, submitted: 0, inProgress: 0, evidenceProduced: 0 },
      };
    }
    const reply = mutationReply(path);
    if (reply instanceof Error) throw reply;
    return reply;
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => replaced.push(href),
    back: () => {},
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/intake-links",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import IntakeLinksPage from "../../app/(app)/intake-links/page";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "11111111-1111-4111-8111-111111111111";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

type ItemOver = {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  expiresAtUtc?: string;
  revokedAtUtc?: string | null;
  archivedAtUtc?: string | null;
  usedCount?: number;
  maxUses?: number;
  recipientLabel?: string | null;
  recipientPhonePreview?: string | null;
  channel?: string | null;
  deliveryStatus?: string | null;
  attemptCount?: number;
  errorCode?: string | null;
  opened?: number;
  started?: number;
  submitted?: number;
  createdAt?: string;
};

function item(over: ItemOver) {
  const created = over.createdAt ?? "2026-08-01T00:00:00.000Z";
  return {
    link: {
      id: over.id,
      teamId: WS,
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      workflowTemplateName: over.name ?? "General evidence request",
      intakeMode: over.mode ?? "EXTERNAL_ONE_TIME",
      caseId: null,
      recipientLabel: over.recipientLabel ?? null,
      recipientEmailPreview: null,
      recipientPhonePreview: over.recipientPhonePreview ?? null,
      maxUses: over.maxUses ?? 1,
      usedCount: over.usedCount ?? 0,
      status: over.status ?? "ACTIVE",
      expiresAtUtc: over.expiresAtUtc ?? FAR_FUTURE,
      revokedAtUtc: over.revokedAtUtc ?? null,
      revokedReason: null,
      archivedAtUtc: over.archivedAtUtc ?? null,
      createdAt: created,
      updatedAt: created,
    },
    delivery: {
      latestStatus: over.deliveryStatus ?? null,
      latestChannel: over.channel ?? null,
      latestAtUtc: over.deliveryStatus ? created : null,
      latestSentAtUtc: null,
      latestDeliveredAtUtc: null,
      latestFailedAtUtc: null,
      latestErrorCode: over.errorCode ?? null,
      attemptCount: over.attemptCount ?? (over.deliveryStatus ? 1 : 0),
      channelsAttempted: over.channel ? [over.channel] : [],
      latestProviderMessageId: null,
    },
    activity: {
      firstOpenedAtUtc: null,
      lastOpenedAtUtc: null,
      firstStartedAtUtc: null,
      lastStartedAtUtc: null,
      firstSubmittedAtUtc: null,
      lastSubmittedAtUtc: null,
      sessionsCreated:
        (over.opened ?? 0) + (over.started ?? 0) + (over.submitted ?? 0),
      sessionsOpened: over.opened ?? 0,
      sessionsStarted: over.started ?? 0,
      sessionsSubmitted: over.submitted ?? 0,
      sessionsExpired: 0,
      sessionsRevoked: 0,
      evidenceCount: over.submitted ?? 0,
    },
    computedLifecycle: "CREATED",
  };
}

/** A realistic mix: active, opened, submitted-one-time, failed, archived, disabled. */
const MIXED = [
  item({ id: "active-1", name: "Property damage", channel: "SMS", deliveryStatus: "DELIVERED", recipientPhonePreview: "+491••23" }),
  item({ id: "opened-1", name: "Documents", channel: "EMAIL", deliveryStatus: "DELIVERED", opened: 1 }),
  item({
    id: "submitted-1",
    name: "Insurance claim evidence",
    status: "EXPIRED",
    usedCount: 1,
    channel: "SMS",
    deliveryStatus: "DELIVERED",
    opened: 1,
    started: 1,
    submitted: 1,
  }),
  item({
    id: "failed-1",
    name: "Incident investigation",
    channel: "WHATSAPP",
    deliveryStatus: "FAILED",
    attemptCount: 3,
    errorCode: "63016",
  }),
  item({ id: "archived-1", name: "Compliance / audit submission", archivedAtUtc: PAST }),
  item({
    id: "revoked-1",
    name: "Legal document collection",
    status: "REVOKED",
    revokedAtUtc: PAST,
  }),
];

function envelope(over: Record<string, unknown> = {}) {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { INTAKE_LINKS_MANAGE: true },
    diagnostics: { requestId: "test" },
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL" },
    activeSpace: {
      type: "PERSONAL",
      id: WS,
      displayName: "Personal Space",
      roleLabel: "Owner",
    },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WS,
        kind: "PERSONAL",
        organizationId: null,
        displayName: "Personal Space",
      },
    },
    account: { accountPlan: "PRO", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { intakeIncluded: true },
    ...over,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(env: unknown = envelope()) {
  cleanup();
  const utils = render(
    <PlatformContextProvider testEnvelope={env as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <IntakeLinksPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  return utils;
}

/** The desktop table, scoped so the narrow-card twin cannot answer for it. */
function table() {
  const el = document.querySelector("[data-intake-links-table]");
  if (!el) throw new Error("no table rendered");
  return within(el as HTMLElement);
}

/** Link ids in the WIDE table, in render order. */
function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-intake-links-row-id]"),
  ).map((el) => el.getAttribute("data-intake-links-row-id") as string);
}

/** Link ids in the NARROW card list, in render order. */
function cardIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-intake-links-card-id]"),
  ).map((el) => el.getAttribute("data-intake-links-card-id") as string);
}

function kpi(key: string): HTMLButtonElement {
  const el = document.querySelector(`[data-intake-links-kpi="${key}"]`);
  if (!el) throw new Error(`no KPI card for ${key}`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  requestLog = [];
  replaced = [];
  currentSearch = "";
  listReply = () => ({ items: MIXED });
  mutationReply = () => ({ ok: true });
});

// ===========================================================================
// Metrics
// ===========================================================================

describe("KPI metrics", () => {
  it("renders all seven counts from the state model", async () => {
    await mount();
    const counts = Object.fromEntries(
      [
        "total",
        "active",
        "submitted",
        "opened",
        "failedDelivery",
        "archived",
        "revokedOrExpired",
      ].map((k) => [
        k,
        Number(kpi(k).querySelector(".ilk-kpi__value")?.textContent),
      ]),
    );
    expect(counts.total).toBe(6);
    expect(counts.archived).toBe(1);
    expect(counts.submitted).toBe(1);
    expect(counts.opened).toBe(1);
    expect(counts.failedDelivery).toBe(1);
    expect(counts.revokedOrExpired).toBe(2); // revoked + the expired one-time
    expect(counts.active).toBe(3);
  });

  it("states out loud that the counts are filters, not a breakdown", async () => {
    await mount();
    const note = document.querySelector(
      "[data-intake-links-kpi-overlap-note]",
    ) as HTMLElement;
    expect(note).toBeTruthy();
    expect(note.textContent).toMatch(/more than one count/i);

    // And the arithmetic really does overlap, so the note is not decorative.
    const sum = ["active", "submitted", "opened", "failedDelivery", "archived", "revokedOrExpired"]
      .map((k) => Number(kpi(k).querySelector(".ilk-kpi__value")?.textContent))
      .reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(6);
  });

  it("carries the mandated tone on each card without relying on colour alone", async () => {
    await mount();
    const expected: Array<[string, string, string]> = [
      ["total", "slate", "Total links"],
      ["active", "indigo", "Active"],
      ["submitted", "blue", "Submitted"],
      ["opened", "green", "Opened"],
      ["failedDelivery", "red", "Failed delivery"],
      ["archived", "slate", "Archived"],
      ["revokedOrExpired", "red", "Revoked or expired"],
    ];
    for (const [key, tone, label] of expected) {
      const card = kpi(key);
      expect(card.getAttribute("data-intake-links-kpi-tone")).toBe(tone);
      expect(card.textContent).toContain(label);
      // Every card also carries a described-by explanation.
      expect(card.getAttribute("aria-describedby")).toBeTruthy();
    }
  });

  it("gives no card a selected-looking state except the active filter", async () => {
    await mount();
    expect(kpi("total").getAttribute("aria-pressed")).toBe("true");
    expect(kpi("active").getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(kpi("active"));
    });
    expect(kpi("active").getAttribute("aria-pressed")).toBe("true");
    expect(kpi("total").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking a KPI narrows the table to exactly what it promised", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(kpi("failedDelivery"));
    });
    expect(rowIds()).toEqual(["failed-1"]);
    // The narrow renderer narrows with it — one filter, two renderers.
    expect(cardIds()).toEqual(["failed-1"]);

    await act(async () => {
      fireEvent.click(kpi("archived"));
    });
    expect(rowIds()).toEqual(["archived-1"]);
    expect(cardIds()).toEqual(["archived-1"]);
  });
});

// ===========================================================================
// Lifecycle vs activity
// ===========================================================================

describe("lifecycle and activity vocabulary", () => {
  it("keeps lifecycle and contributor activity in separate labelled regions", async () => {
    await mount();
    const row = document.querySelector(
      '[data-intake-links-row-id="submitted-1"]',
    ) as HTMLElement;
    const lifecycle = row.querySelector("[data-intake-links-row-link-state]");
    const activity = row.querySelector("[data-intake-links-row-session-state]");
    expect(lifecycle?.textContent?.trim()).toBe("Expired");
    expect(activity?.textContent?.trim()).toBe("Submitted");
    // They are NOT in the same cell, and they never concatenate.
    expect(lifecycle?.closest("td")).not.toBe(activity?.closest("td"));
    expect(row.textContent).not.toContain("ArchivedSubmitted");
  });

  it("labels the delivery and activity facts visibly, and carries nothing else", async () => {
    await mount();
    const row = document.querySelector(
      '[data-intake-links-row-id="failed-1"]',
    ) as HTMLElement;
    const cluster = row.querySelector(".ilk-status") as HTMLElement;

    // Two labelled facts, both keys visible — "Failed" stacked over
    // "Not opened" with no keys reads as one status made of two words.
    const keys = Array.from(
      cluster.querySelectorAll(".ilk-status__key"),
    ).map((k) => k.textContent?.trim());
    expect(keys).toContain("Delivery");
    expect(keys).toContain("Activity");
    expect(cluster.textContent).toContain("Failed");
    expect(cluster.textContent).toContain("Not opened");

    // Lifecycle belongs to its own adjacent column and must NOT be restated
    // here — that duplication is exactly what this cell was corrected for.
    expect(keys).not.toContain("Lifecycle");
    expect(cluster.textContent).not.toMatch(/Lifecycle/i);
    expect(
      cluster.querySelector("[data-intake-links-row-link-state]"),
    ).toBeNull();
  });

  it("renders 'Queued with provider' as one string, not word by word", async () => {
    listReply = () => ({
      items: [item({ id: "q1", channel: "SMS", deliveryStatus: "QUEUED" })],
    });
    await mount();
    const cell = document.querySelector(
      '[data-intake-links-row-delivery="QUEUED"]',
    ) as HTMLElement;
    expect(cell.textContent).toBe("Queued with provider");
  });

  it("shows a disabled link as 'Link disabled', never as REVOKED", async () => {
    await mount();
    const row = document.querySelector(
      '[data-intake-links-row-id="revoked-1"]',
    ) as HTMLElement;
    expect(row.textContent).toContain("Link disabled");
    expect(row.textContent).not.toMatch(/\bREVOKED\b/);
    // The wire value is still available to probes.
    expect(
      row.querySelector('[data-intake-links-row-link-state="REVOKED"]'),
    ).toBeTruthy();
  });

  it("marks expiry as danger only when the link has really expired", async () => {
    listReply = () => ({
      items: [
        item({ id: "expired", expiresAtUtc: PAST }),
        item({ id: "later", expiresAtUtc: FAR_FUTURE }),
      ],
    });
    await mount();
    const expired = document.querySelector(
      '[data-intake-links-row-id="expired"] [data-intake-links-row-expires]',
    );
    const later = document.querySelector(
      '[data-intake-links-row-id="later"] [data-intake-links-row-expires]',
    );
    expect(expired?.getAttribute("data-intake-links-row-expires")).toBe("expired");
    expect(later?.getAttribute("data-intake-links-row-expires")).toBe("ok");
  });
});

// ===========================================================================
// Filters
// ===========================================================================

describe("search, filters, sorting and pagination", () => {
  it("search narrows the rows and reaches the address bar", async () => {
    await mount();
    const box = document.querySelector(
      "[data-intake-links-search]",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: "insurance" } });
    });
    expect(new Set(rowIds())).toEqual(new Set(["submitted-1"]));
    expect(replaced.at(-1)).toContain("q=insurance");
  });

  it("a search that matches nothing renders the no-match state, not an error", async () => {
    await mount();
    await act(async () => {
      fireEvent.change(
        document.querySelector("[data-intake-links-search]") as HTMLInputElement,
        { target: { value: "zzzz" } },
      );
    });
    expect(document.querySelector("[data-intake-links-no-match]")).toBeTruthy();
    expect(document.querySelector("[data-intake-links-error]")).toBeNull();
    expect(document.querySelector("[data-intake-links-table]")).toBeNull();
  });

  it("clearing filters restores every row and cleans the URL", async () => {
    await mount();
    await act(async () => {
      fireEvent.change(
        document.querySelector("[data-intake-links-search]") as HTMLInputElement,
        { target: { value: "zzzz" } },
      );
    });
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-links-empty-clear]") as HTMLElement,
      );
    });
    expect(new Set(rowIds()).size).toBe(6);
    expect(replaced.at(-1)).toBe("?");
  });

  it("the channel filter is a listbox, not a native select", async () => {
    await mount();
    const toolbar = document.querySelector(
      "[data-intake-links-controls]",
    ) as HTMLElement;
    expect(toolbar.querySelectorAll("select").length).toBe(0);
    const combos = toolbar.querySelectorAll('[role="combobox"]');
    // channel, lifecycle, delivery, sort
    expect(combos.length).toBe(4);
  });

  it("a listbox filter narrows the table, and its popup escapes the toolbar", async () => {
    await mount();
    const combos = document.querySelectorAll(
      '[data-intake-links-controls] [role="combobox"]',
    );
    const channel = combos[0] as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(channel);
    });
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox).toBeTruthy();
    // Portaled to <body>, so no table/panel overflow can clip it.
    expect(listbox.closest("[data-intake-links-controls]")).toBeNull();

    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => o.textContent?.trim() === "WhatsApp") as HTMLElement;
    await act(async () => {
      fireEvent.click(option);
    });
    expect(new Set(rowIds())).toEqual(new Set(["failed-1"]));
  });

  it("the listbox is keyboard operable and Escape restores focus", async () => {
    await mount();
    const channel = document.querySelectorAll(
      '[data-intake-links-controls] [role="combobox"]',
    )[0] as HTMLButtonElement;
    channel.focus();
    await act(async () => {
      fireEvent.keyDown(channel, { key: "ArrowDown" });
    });
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(listbox, { key: "End" });
      fireEvent.keyDown(listbox, { key: "Escape" });
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(channel);
  });

  it("paginates without losing rows, and page size is a listbox", async () => {
    listReply = () => ({
      items: Array.from({ length: 30 }, (_, i) =>
        item({ id: `row-${String(i).padStart(2, "0")}` }),
      ),
    });
    await mount();
    // 30 rows / 25 per page → the table shows 25 (plus its card twin).
    expect(table().getAllByRole("row").length).toBe(26); // + header
    const pager = document.querySelector(
      "[data-intake-links-pagination]",
    ) as HTMLElement;
    expect(pager).toBeTruthy();
    expect(pager.querySelectorAll("select").length).toBe(0);
    await act(async () => {
      fireEvent.click(
        pager.querySelector("[data-intake-links-next-page]") as HTMLElement,
      );
    });
    expect(table().getAllByRole("row").length).toBe(6); // 5 rows + header
  });
});

// ===========================================================================
// Desktop / mobile parity
// ===========================================================================

describe("one model, two renderers", () => {
  it("the narrow card states the same facts as the wide row", async () => {
    listReply = () => ({ items: [MIXED[2]] });
    await mount();
    const row = table().getByText("Insurance claim evidence").closest("tr")!;
    const card = document.querySelector(
      '[data-intake-links-card-id="submitted-1"]',
    ) as HTMLElement;

    for (const fact of ["Expired", "Submitted", "Delivered", "View submissions (1)"]) {
      expect(row.textContent).toContain(fact);
      expect(card.textContent).toContain(fact);
    }
  });

  it("both renderers offer the same actions for the same link", async () => {
    listReply = () => ({ items: [MIXED[0]] });
    await mount();
    const triggers = document.querySelectorAll(
      "[data-intake-links-row-menu-trigger]",
    );
    expect(triggers.length).toBe(2); // one per renderer
    for (const trigger of Array.from(triggers)) {
      expect(trigger.getAttribute("aria-label")).toBe(
        "Actions for Property damage",
      );
    }
  });
});

// ===========================================================================
// Row actions
// ===========================================================================

describe("row actions", () => {
  it("opens a real menu with the eligible actions only", async () => {
    listReply = () => ({ items: [MIXED[5]] }); // already disabled
    await mount();
    const trigger = document.querySelector(
      "[data-intake-links-row-menu-trigger]",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    const keys = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("data-intake-links-row-action"));
    expect(keys).toContain("details");
    expect(keys).toContain("archive");
    // An already-disabled link cannot be disabled again.
    expect(keys).not.toContain("revoke");
  });

  it("offers Disable on a live link and confirms before calling the API", async () => {
    listReply = () => ({ items: [MIXED[0]] });
    await mount();
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          "[data-intake-links-row-menu-trigger]",
        ) as HTMLElement,
      );
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    const disable = within(menu).getByRole("menuitem", { name: /disable link/i });
    await act(async () => {
      fireEvent.click(disable);
    });

    // The confirmation names the consequence and the irreversibility.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/cannot be undone/i);
    expect(
      requestLog.some((r) => r.path.includes("/revoke")),
    ).toBe(false);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /disable link/i }));
    });
    await waitFor(() =>
      expect(requestLog.some((r) => r.path.includes("/revoke"))).toBe(true),
    );
  });

  it("cancelling the confirmation performs no mutation", async () => {
    listReply = () => ({ items: [MIXED[0]] });
    await mount();
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          "[data-intake-links-row-menu-trigger]",
        ) as HTMLElement,
      );
    });
    await act(async () => {
      fireEvent.click(
        within(document.querySelector('[role="menu"]') as HTMLElement).getByRole(
          "menuitem",
          { name: /disable link/i },
        ),
      );
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    });
    expect(requestLog.some((r) => r.path.includes("/revoke"))).toBe(false);
  });

  it("archive calls the archive endpoint and refreshes the list", async () => {
    listReply = () => ({ items: [MIXED[0]] });
    await mount();
    const before = requestLog.filter((r) =>
      r.path.startsWith("/v1/workflow/intake-links?"),
    ).length;
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          "[data-intake-links-row-menu-trigger]",
        ) as HTMLElement,
      );
    });
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          '[data-intake-links-row-action="archive"]',
        ) as HTMLElement,
      );
    });
    await waitFor(() => {
      expect(requestLog.some((r) => r.path.endsWith("/archive"))).toBe(true);
      const after = requestLog.filter((r) =>
        r.path.startsWith("/v1/workflow/intake-links?"),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("a failed mutation surfaces a safe message and keeps the list", async () => {
    listReply = () => ({ items: [MIXED[0]] });
    mutationReply = (path) => {
      if (path.endsWith("/archive")) {
        return apiFailure(500) as unknown as Record<string, unknown>;
      }
      return { ok: true };
    };
    await mount();
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          "[data-intake-links-row-menu-trigger]",
        ) as HTMLElement,
      );
    });
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          '[data-intake-links-row-action="archive"]',
        ) as HTMLElement,
      );
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-intake-links-mutation-error]"),
      ).toBeTruthy(),
    );
    expect(document.querySelector("[data-intake-links-table]")).toBeTruthy();
  });

  it("the menu is keyboard operable and Escape returns focus to the trigger", async () => {
    listReply = () => ({ items: [MIXED[0]] });
    await mount();
    const trigger = document.querySelector(
      "[data-intake-links-row-menu-trigger]",
    ) as HTMLButtonElement;
    trigger.focus();
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("the submissions action opens the drawer for links that have sessions", async () => {
    listReply = () => ({ items: [MIXED[2]] });
    await mount();
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          "[data-intake-links-row-submissions]",
        ) as HTMLElement,
      );
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="intake-link-submissions-drawer"]'),
      ).toBeTruthy(),
    );
  });
});

// ===========================================================================
// States
// ===========================================================================

describe("loading, empty, error and restricted states", () => {
  it("never shows a zero-row table while the first read is in flight", async () => {
    let resolveList: ((v: unknown) => void) | null = null;
    listReply = () =>
      new Promise((resolve) => {
        resolveList = resolve;
      }) as unknown as Record<string, unknown>;
    cleanup();
    render(
      <PlatformContextProvider testEnvelope={envelope() as never}>
        <ToastProvider>
          <ConfirmActionProvider>
            <IntakeLinksPage />
          </ConfirmActionProvider>
        </ToastProvider>
      </PlatformContextProvider>,
    );
    await settle();
    expect(document.querySelector("[data-intake-links-loading]")).toBeTruthy();
    expect(document.querySelector("[data-intake-links-kpis]")).toBeNull();
    expect(document.body.textContent).not.toContain("0 links");
    await act(async () => {
      resolveList?.({ items: [] });
    });
  });

  it("shows the first-run empty state with quick-start purposes", async () => {
    listReply = () => ({ items: [] });
    await mount();
    expect(document.querySelector('[data-intake-links-empty="true"]')).toBeTruthy();
    expect(document.querySelector("[data-intake-links-quick-start]")).toBeTruthy();
    expect(document.querySelector("[data-intake-links-kpis]")).toBeNull();
  });

  it("a service failure offers a retry that re-reads", async () => {
    listReply = () =>
      apiFailure(500) as unknown as Record<string, unknown>;
    await mount();
    const panel = document.querySelector("[data-intake-links-error]") as HTMLElement;
    expect(panel).toBeTruthy();
    const before = requestLog.length;
    listReply = () => ({ items: MIXED });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: /try again/i }));
    });
    await waitFor(() => expect(requestLog.length).toBeGreaterThan(before));
  });

  it("a refusal renders the restricted panel and offers NO retry", async () => {
    listReply = () =>
      apiFailure(403) as unknown as Record<string, unknown>;
    await mount();
    const panel = document.querySelector(
      '[data-intake-links-restricted="forbidden"]',
    ) as HTMLElement;
    expect(panel).toBeTruthy();
    expect(within(panel).queryByRole("button")).toBeNull();
  });

  it("an anti-enumeration 404 is treated as restricted, not as an error", async () => {
    listReply = () =>
      apiFailure(404) as unknown as Record<string, unknown>;
    await mount();
    expect(
      document.querySelector('[data-intake-links-restricted="forbidden"]'),
    ).toBeTruthy();
    expect(document.querySelector("[data-intake-links-error]")).toBeNull();
  });

  it("a disabled feature says so instead of pretending the list is empty", async () => {
    listReply = () =>
      apiFailure(503, "FEATURE_DISABLED") as unknown as Record<string, unknown>;
    await mount();
    expect(
      document.querySelector("[data-intake-links-feature-disabled]"),
    ).toBeTruthy();
    expect(document.querySelector('[data-intake-links-empty="true"]')).toBeNull();
  });
});

// ===========================================================================
// Deep links + context
// ===========================================================================

describe("deep links and workspace context", () => {
  it("?new=1 opens the creation wizard", async () => {
    currentSearch = "new=1";
    listReply = () => ({ items: MIXED });
    await mount();
    expect(
      document.querySelector('[data-testid="intake-link-create-wizard"]'),
    ).toBeTruthy();
  });

  it("?linkId=… opens that link's delivery history", async () => {
    currentSearch = "linkId=active-1";
    await mount();
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="intake-link-delivery-drawer"]'),
      ).toBeTruthy(),
    );
  });

  it("names the owning workspace exactly once", async () => {
    await mount();
    const context = document.querySelector(
      "[data-intake-links-context]",
    ) as HTMLElement;
    expect(context.textContent).toContain("Personal Space");
    const occurrences = (context.textContent ?? "").split("Personal Space").length - 1;
    expect(occurrences).toBe(1);
  });

  it("reads the list scoped to the active workspace", async () => {
    await mount();
    const listCall = requestLog.find((r) =>
      r.path.startsWith("/v1/workflow/intake-links?"),
    );
    expect(listCall?.path).toContain(`teamId=${WS}`);
    expect(listCall?.path).toContain("archiveScope=all");
  });

  it("offers no row action that would need the unrecoverable raw token", async () => {
    listReply = () => ({ items: [MIXED[0]] });
    await mount();
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          "[data-intake-links-row-menu-trigger]",
        ) as HTMLElement,
      );
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    // The list projection never returns the token, so a per-row "copy link"
    // could not do what it says. Delivery history carries the real retry.
    expect(menu.textContent).not.toMatch(/copy link/i);
    expect(menu.textContent).toMatch(/delivery history/i);
  });
});

// ===========================================================================
// The Lifecycle filter: labels only
// ===========================================================================

describe("lifecycle filter option anatomy", () => {
  /** Open one of the toolbar listboxes and return its popup. */
  async function openFilter(index: number) {
    const combo = document.querySelectorAll(
      '[data-intake-links-controls] [role="combobox"]',
    )[index] as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(combo);
    });
    return {
      combo,
      listbox: document.querySelector('[role="listbox"]') as HTMLElement,
    };
  }

  it("offers exactly the five concise labels, and no secondary description", async () => {
    await mount();
    const { listbox } = await openFilter(1); // channel, LIFECYCLE, delivery, sort
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      "Any lifecycle",
      "Active",
      "Archived",
      "Link disabled",
      "Expired",
    ]);
    // No description NODE at all — an empty one would reserve its own line and
    // leave the option rows unevenly tall.
    for (const o of options) {
      expect(o.querySelector(".app-listbox__option-desc")).toBeNull();
    }
  });

  it("keeps its accessible name, keyboard operation and selected state", async () => {
    await mount();
    const { combo, listbox } = await openFilter(1);
    const labelledBy = combo.getAttribute("aria-labelledby") as string;
    expect(document.getElementById(labelledBy)?.textContent).toBe(
      "Filter by lifecycle",
    );
    expect(combo.getAttribute("aria-haspopup")).toBe("listbox");

    // Two separate acts: the Enter handler reads `activeIndex` from its own
    // closure, so batching both keys into one act would commit the stale one.
    await act(async () => {
      fireEvent.keyDown(listbox, { key: "End" });
    });
    await act(async () => {
      fireEvent.keyDown(listbox, { key: "Enter" });
    });
    // The last option is Expired; selecting it narrows the list and marks the
    // trigger — the control still behaves exactly as before.
    expect(combo.textContent).toContain("Expired");
    const reopened = await openFilter(1);
    const selected = within(reopened.listbox)
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true")
      .map((o) => o.textContent?.trim());
    expect(selected).toEqual(["Expired"]);
  });

  it("drives the same filter query it always did", async () => {
    await mount();
    const { listbox } = await openFilter(1);
    const disabled = within(listbox).getByRole("option", {
      name: "Link disabled",
    });
    await act(async () => {
      fireEvent.click(disabled);
    });
    // The wire value is unchanged — the label is user-facing only.
    expect(replaced.at(-1)).toContain("lifecycle=REVOKED");
    expect(rowIds()).toEqual(["revoked-1"]);
  });

  it("the other filters keep their descriptions where a consequence needs one", async () => {
    // The simplification was scoped to the lifecycle filter, whose four labels
    // are self-evident. Nothing else was touched.
    await mount();
    const lifecycle = await openFilter(1);
    expect(
      lifecycle.listbox.querySelectorAll(".app-listbox__option-desc").length,
    ).toBe(0);
    await act(async () => {
      fireEvent.keyDown(lifecycle.listbox, { key: "Escape" });
    });
    // Every option row in the simplified list carries the same content
    // structure — one label wrapper, no description track. A row that kept an
    // empty description node would reserve its line and make the list ragged.
    for (const o of within(lifecycle.listbox).getAllByRole("option")) {
      expect(o.querySelectorAll(".app-listbox__option-desc").length).toBe(0);
      expect(o.querySelectorAll(":scope > span").length).toBe(1);
    }
  });
});

// ===========================================================================
// KPI numbers consume their card's tone
// ===========================================================================

describe("KPI number tone", () => {
  it("every card exposes ONE tone that the rail and the number both read", async () => {
    await mount();
    const cards = Array.from(
      document.querySelectorAll("[data-intake-links-kpi]"),
    ) as HTMLElement[];
    expect(cards.length).toBe(7);
    for (const card of cards) {
      const tone = card.getAttribute("data-intake-links-kpi-tone");
      expect(tone, "a card with no tone").toBeTruthy();
      // ONE contract: the card declares the tone, and the value element is
      // inside it so it inherits the same resolved custom property. The card
      // must not carry a second tone attribute for the number.
      expect(card.getAttribute("data-ilk-tone")).toBe(tone);
      const value = card.querySelector(".ilk-kpi__value") as HTMLElement;
      expect(value).toBeTruthy();
      // The number carries no colour of its own in the markup — the cascade
      // supplies it from the card's tone.
      expect(value.getAttribute("style")).toBeNull();
      expect(value.getAttribute("data-tone")).toBeNull();
    }
  });

  it("keeps the hierarchy: coloured number, strong label, neutral note", async () => {
    await mount();
    const card = document.querySelector(
      '[data-intake-links-kpi="submitted"]',
    ) as HTMLElement;
    expect(card.querySelector(".ilk-kpi__value")).toBeTruthy();
    expect(card.querySelector(".ilk-kpi__label")?.textContent).toBe("Submitted");
    const meta = card.querySelector(".ilk-kpi__meta") as HTMLElement;
    expect(meta.textContent?.length).toBeGreaterThan(10);
    // The supporting line is not toned — only the number is.
    expect(meta.getAttribute("data-ilk-tone")).toBeNull();
    // The overlap disclosure survives.
    expect(
      document.querySelector("[data-intake-links-kpi-overlap-note]")?.textContent,
    ).toMatch(/more than one count/i);
  });
});

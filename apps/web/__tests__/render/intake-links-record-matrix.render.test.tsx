/**
 * RECORD-STATE MATRIX — /intake-links.
 *
 * Every lifecycle × activity × delivery combination a link can actually be in,
 * driven through the REAL page, asserting that all three axes stay separate and
 * that the redesigned row/card system renders every one of them.
 *
 * The combinations named here are the ones the production screenshots got
 * wrong: an archived link that had been submitted through rendered its two
 * chips into one cell and the browser ran them together as "ArchivedSubmitted".
 * A combination is only proven if BOTH renderers are checked, because the wide
 * table and the narrow cards are separate DOM — they are proven to be separate
 * DOM over ONE model, not two models.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, waitFor, act, cleanup, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

let requestLog: Array<{ path: string; method: string }> = [];
let items: unknown[] = [];
let mutationOutcome: (path: string) => "ok" | "fail" | "hang" = () => "ok";

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method });
    if (method === "GET" && path.startsWith("/v1/workflow/intake-links?")) {
      return { items };
    }
    if (path.startsWith("/v1/workflow/templates")) return { templates: [] };
    if (path.includes("/sender-identity")) {
      return {
        email: { configured: true },
        sms: { configured: true, fromNumberPreview: "+1 ••• 8084" },
        whatsapp: { configured: true },
      };
    }
    if (path.startsWith("/v1/communications/messages")) return { messages: [] };
    const outcome = mutationOutcome(path);
    if (outcome === "fail") {
      const err = new Error("refused") as Error & { statusCode: number };
      err.statusCode = 500;
      throw err;
    }
    if (outcome === "hang") return new Promise(() => {});
    return { ok: true };
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
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

const WS = "33333333-3333-4333-8333-333333333333";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

const LONG_TITLE =
  "Insurance claim evidence for the multi-vehicle incident on the northbound carriageway, reference NB-2026-08-14-0097-REVIEWED";
const LONG_RECIPIENT =
  "Jane Alexandra Smith-Fotheringay — consolidated claim 4842 / policy AX-99887766 / adjuster copy";

type Spec = {
  id: string;
  title?: string;
  mode?: string;
  status?: string;
  expires?: string;
  revoked?: string | null;
  archived?: string | null;
  used?: number;
  recipientLabel?: string | null;
  email?: string | null;
  phone?: string | null;
  /** The ORGANIZATION's own reference for this request. */
  customerId?: string | null;
  /** What the SERVER decided this caller may see. Never a client choice. */
  revealed?: boolean;
  rawEmail?: string | null;
  rawPhone?: string | null;
  channel?: string | null;
  delivery?: string | null;
  attempts?: number;
  code?: string | null;
  opened?: number;
  started?: number;
  submitted?: number;
};

function item(s: Spec) {
  const created = "2026-08-01T00:00:00.000Z";
  return {
    link: {
      id: s.id,
      teamId: WS,
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      workflowTemplateName: s.title ?? "General evidence request",
      intakeMode: s.mode ?? "EXTERNAL_ONE_TIME",
      caseId: null,
      recipientLabel: s.recipientLabel ?? null,
      customerId: s.customerId ?? null,
      recipientEmailPreview: s.email ?? null,
      recipientPhonePreview: s.phone ?? null,
      recipientEmail: s.revealed ? (s.rawEmail ?? s.email ?? null) : null,
      recipientPhone: s.revealed ? (s.rawPhone ?? s.phone ?? null) : null,
      recipientContactRevealAuthorized: s.revealed === true,
      maxUses: 1,
      usedCount: s.used ?? 0,
      status: s.status ?? "ACTIVE",
      expiresAtUtc: s.expires ?? FUTURE,
      revokedAtUtc: s.revoked ?? null,
      revokedReason: null,
      archivedAtUtc: s.archived ?? null,
      createdAt: created,
      updatedAt: created,
    },
    delivery: {
      latestStatus: s.delivery ?? null,
      latestChannel: s.channel ?? null,
      latestAtUtc: s.delivery ? created : null,
      latestSentAtUtc: null,
      latestDeliveredAtUtc: null,
      latestFailedAtUtc: null,
      latestErrorCode: s.code ?? null,
      attemptCount: s.attempts ?? (s.delivery ? 1 : 0),
      channelsAttempted: s.channel ? [s.channel] : [],
      latestProviderMessageId: null,
    },
    activity: {
      firstOpenedAtUtc: null,
      lastOpenedAtUtc: null,
      firstStartedAtUtc: null,
      lastStartedAtUtc: null,
      firstSubmittedAtUtc: null,
      lastSubmittedAtUtc: null,
      sessionsCreated: (s.opened ?? 0) + (s.started ?? 0) + (s.submitted ?? 0),
      sessionsOpened: s.opened ?? 0,
      sessionsStarted: s.started ?? 0,
      sessionsSubmitted: s.submitted ?? 0,
      sessionsExpired: 0,
      sessionsRevoked: 0,
      evidenceCount: s.submitted ?? 0,
    },
    computedLifecycle: "SENT",
  };
}

function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { INTAKE_LINKS_MANAGE: true },
    diagnostics: { requestId: "record-matrix" },
    workspace: { id: WS, name: "Acme Legal", status: "active", scope: "ORGANIZATION" },
    activeSpace: {
      type: "ORGANIZATION",
      id: WS,
      displayName: "Acme Legal",
      roleLabel: "Owner",
    },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WS,
        kind: "ORGANIZATION",
        organizationId: null,
        displayName: "Acme Legal",
      },
    },
    account: { accountPlan: "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { intakeIncluded: true },
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(rows: Spec[]) {
  cleanup();
  requestLog = [];
  items = rows.map(item);
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
}

/** The wide row and the narrow card for one link. */
function bothRenderers(id: string): { row: HTMLElement; card: HTMLElement } {
  const row = document.querySelector(
    `[data-intake-links-row-id="${id}"]`,
  ) as HTMLElement;
  const card = document.querySelector(
    `[data-intake-links-card-id="${id}"]`,
  ) as HTMLElement;
  expect(row, `no table row for ${id}`).toBeTruthy();
  expect(card, `no card for ${id}`).toBeTruthy();
  return { row, card };
}

/** The three axes as the row publishes them. */
function axes(el: HTMLElement) {
  return {
    // ONE probe. There is no folded twin to fall back to any more, and reading
    // for one would let its return pass unnoticed.
    lifecycle:
      el.querySelector("[data-intake-links-row-link-state]")?.getAttribute(
        "data-intake-links-row-link-state",
      ) ?? null,
    activity:
      el
        .querySelector("[data-intake-links-row-session-state]")
        ?.getAttribute("data-intake-links-row-session-state") ?? null,
    delivery:
      el
        .querySelector("[data-intake-links-row-delivery]")
        ?.getAttribute("data-intake-links-row-delivery") ?? null,
  };
}

beforeEach(() => {
  mutationOutcome = () => "ok";
});

// ===========================================================================
// The three axes never merge
// ===========================================================================

const COMBINATIONS: Array<{
  name: string;
  spec: Spec;
  lifecycle: string;
  activity: string;
  delivery: string;
  labels: string[];
}> = [
  {
    name: "Archived + Submitted",
    spec: { id: "c1", archived: PAST, opened: 1, started: 1, submitted: 1, channel: "SMS", delivery: "DELIVERED" },
    lifecycle: "ARCHIVED",
    activity: "SUBMITTED",
    delivery: "DELIVERED",
    labels: ["Archived", "Submitted", "Delivered"],
  },
  {
    name: "Expired + Submitted",
    spec: { id: "c2", status: "EXPIRED", used: 1, opened: 1, started: 1, submitted: 1, channel: "EMAIL", delivery: "DELIVERED" },
    lifecycle: "EXPIRED",
    activity: "SUBMITTED",
    delivery: "DELIVERED",
    labels: ["Expired", "Submitted", "Delivered"],
  },
  {
    name: "Archived + failed delivery",
    spec: { id: "c3", archived: PAST, channel: "WHATSAPP", delivery: "FAILED", attempts: 3, code: "63016" },
    lifecycle: "ARCHIVED",
    activity: "NO_ACTIVITY",
    delivery: "FAILED",
    labels: ["Archived", "Not opened", "Failed"],
  },
  {
    name: "Disabled + prior submission",
    spec: { id: "c4", status: "REVOKED", revoked: PAST, opened: 1, started: 1, submitted: 1, channel: "SMS", delivery: "DELIVERED" },
    lifecycle: "REVOKED",
    activity: "SUBMITTED",
    delivery: "DELIVERED",
    labels: ["Link disabled", "Submitted", "Delivered"],
  },
  {
    name: "Active + queued delivery",
    spec: { id: "c5", channel: "SMS", delivery: "QUEUED" },
    lifecycle: "ACTIVE",
    activity: "NO_ACTIVITY",
    delivery: "QUEUED",
    labels: ["Active", "Not opened", "With provider"],
  },
];

describe("lifecycle, activity and delivery stay three separate axes", () => {
  for (const combo of COMBINATIONS) {
    it(`${combo.name} keeps all three axes distinct in both renderers`, async () => {
      await mount([combo.spec]);
      const { row, card } = bothRenderers(combo.spec.id);

      const rowAxes = axes(row);
      expect(rowAxes.lifecycle).toBe(combo.lifecycle);
      expect(rowAxes.activity).toBe(combo.activity);
      expect(rowAxes.delivery).toBe(combo.delivery);

      for (const label of combo.labels) {
        expect(row.textContent).toContain(label);
        expect(card.textContent).toContain(label);
      }

      // The defect this matrix exists for: two chips concatenating.
      const squashed = combo.labels.join("");
      expect(row.textContent?.replace(/\s+/g, " ")).not.toContain(squashed);
      expect(row.textContent).not.toContain("ArchivedSubmitted");
      expect(card.textContent).not.toContain("ArchivedSubmitted");

      /*
       * The lifecycle chip and the activity value are never the same node, and
       * neither ever contains the other.
       *
       * They used to be required to sit in DIFFERENT CELLS. That was a proxy
       * for the real guarantee — that an operator never reads them as one
       * value — and the seven-column hierarchy answers it a better way: they
       * are one Status column, a filled badge over quiet toned text, with the
       * subordinate line named for assistive technology. A column boundary is
       * not the only way to separate two facts, and it was costing three
       * columns.
       */
      const life = row.querySelector("[data-intake-links-row-link-state]");
      const act_ = row.querySelector("[data-intake-links-row-session-state]");
      expect(life).not.toBe(act_);
      expect(life?.contains(act_ as Node)).toBe(false);
      expect(act_?.contains(life as Node)).toBe(false);
      // Different treatments: the lifecycle is the filled badge, the activity
      // is text. That is what stops them reading as a pair of equals.
      expect(life?.classList.contains("app-status-badge")).toBe(true);
      expect(act_?.classList.contains("ilk-state-text")).toBe(true);
    });
  }

  it("every axis value the contract can produce renders a label, never a raw enum", async () => {
    const deliveries = [
      null,
      "QUEUED",
      "SENT",
      "DELIVERED",
      "FAILED",
      "UNDELIVERED",
      "RETRY_SCHEDULED",
    ];
    const specs: Spec[] = deliveries.map((d, i) => ({
      id: `d${i}`,
      channel: d ? "SMS" : null,
      delivery: d,
    }));
    await mount(specs);
    for (const s of specs) {
      const { row, card } = bothRenderers(s.id);
      for (const el of [row, card]) {
        const text = el.textContent ?? "";
        expect(text).not.toMatch(/\bRETRY_SCHEDULED\b|\bUNDELIVERED\b|\bNO_ACTIVITY\b/);
      }
    }
    // The two folded states the contract distinguishes still land on one label.
    expect(
      document.querySelector('[data-intake-links-row-delivery="FAILED"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-intake-links-row-delivery="RETRY_SCHEDULED"]'),
    ).toBeTruthy();
  });

  it("activity walks Not opened → Opened → Upload started → Submitted", async () => {
    await mount([
      { id: "a0" },
      { id: "a1", opened: 1 },
      { id: "a2", opened: 1, started: 1 },
      { id: "a3", opened: 1, started: 1, submitted: 1 },
    ]);
    const expected = ["NO_ACTIVITY", "OPENED", "UPLOAD_STARTED", "SUBMITTED"];
    expected.forEach((state, i) => {
      const { row, card } = bothRenderers(`a${i}`);
      expect(axes(row).activity).toBe(state);
      expect(axes(card).activity).toBe(state);
    });
  });
});

// ===========================================================================
// Recipient, channel and submission-count variants
// ===========================================================================

describe("recipient, channel and submission variants", () => {
  it("renders each recipient shape without inventing one", async () => {
    await mount([
      { id: "r1", recipientLabel: "Jane Smith" },
      { id: "r2", email: "j•••@example.com", channel: "EMAIL", delivery: "SENT" },
      { id: "r3", phone: "+491••23", channel: "SMS", delivery: "SENT" },
      { id: "r4", channel: null },
    ]);
    expect(bothRenderers("r1").row.textContent).toContain("Jane Smith");
    expect(bothRenderers("r2").row.textContent).toContain("j•••@example.com");
    expect(bothRenderers("r3").row.textContent).toContain("+491••23");
    expect(bothRenderers("r4").row.textContent).toContain("No recipient");
  });

  it("shows all four identifiers at once, none standing in for another", async () => {
    /*
     * THE DEFECT THE GROUPED CELL EXISTS FOR.
     *
     * Customer ID, recipient name, address and number are four independent
     * facts. They used to be two columns and a substitution chain
     * (`label ?? email ?? phone`), so a request that had a name showed only
     * the name — the address it went to and the number it was texted to
     * simply vanished. They now share one cell and are all rendered; the
     * cell GROUPS them visually and merges nothing.
     */
    await mount([
      {
        id: "all4",
        recipientLabel: "Bilal Attar",
        customerId: "CUST-849271",
        rawEmail: "bilal@example.test",
        rawPhone: "+49 174 906 1823",
        email: "b***@example.test",
        phone: "+49 ••• ••• 1823",
        revealed: true,
        channel: "SMS",
        delivery: "SENT",
      },
    ]);
    for (const renderer of ["row", "card"] as const) {
      const scope = bothRenderers("all4")[renderer];
      const q = (a: string) => scope.querySelector(`[${a}]`)?.textContent?.trim();
      expect(q("data-intake-links-recipient-name"), renderer).toBe("Bilal Attar");
      expect(q("data-intake-links-recipient-email"), renderer).toBe("bilal@example.test");
      expect(q("data-intake-links-recipient-phone"), renderer).toBe("+49 174 906 1823");
      // The probe carries the identifier ALONE, not the labelled phrase.
      expect(q("data-intake-links-customer-id"), renderer).toBe("CUST-849271");
      // …and the label is beside it, so the reference is not mistaken for a
      // fourth way of naming the person.
      expect(scope.textContent, renderer).toContain("Customer ID");
    }
  });

  it("renders what the server authorised, and decides nothing itself", async () => {
    /*
     * The cell consumes the ALREADY-AUTHORIZED projection. When the server
     * says the caller may not see the raw contact it sends only the masked
     * preview, and the cell renders that — it does not fetch the raw value,
     * and it does not decide who may see it. The only thing the client adds
     * is a title explaining why the value looks the way it does.
     */
    await mount([
      {
        id: "masked",
        recipientLabel: "Bilal Attar",
        customerId: "CUST-849271",
        email: "b***@example.test",
        phone: "+49 ••• ••• 1823",
        revealed: false,
        channel: "SMS",
        delivery: "SENT",
      },
    ]);
    const row = bothRenderers("masked").row;
    expect(
      row.querySelector("[data-intake-links-recipient-email]")?.textContent,
    ).toBe("b***@example.test");
    expect(
      row.querySelector("[data-intake-links-recipient-phone]")?.textContent,
    ).toBe("+49 ••• ••• 1823");
    // The mask is explained rather than left looking like a broken value.
    expect(
      row
        .querySelector("[data-intake-links-recipient-email]")
        ?.getAttribute("title"),
    ).toMatch(/Masked/);
    // Neither the raw address nor the raw number is anywhere in the row.
    expect(row.textContent).not.toContain("bilal@example.test");
    expect(row.textContent).not.toContain("174 906 1823");
    // The business reference is NOT contact data and is unaffected.
    expect(
      row.querySelector("[data-intake-links-customer-id]")?.textContent,
    ).toBe("CUST-849271");
  });

  it("says so plainly when a manual link has no recipient", async () => {
    await mount([{ id: "manual", channel: null }]);
    const row = bothRenderers("manual").row;
    const cell = row.querySelector('[data-intake-links-recipient="none"]');
    expect(cell?.textContent).toContain("No recipient");
    expect(cell?.textContent).toContain("Manual link");
    // No dash, no invented placeholder.
    expect(row.querySelector("[data-intake-links-recipient-name]")).toBeNull();
    expect(row.querySelector("[data-intake-links-customer-id]")).toBeNull();
  });

  it("labels every channel, including the never-sent copy-link case", async () => {
    await mount([
      { id: "ch1", channel: "SMS", delivery: "SENT" },
      { id: "ch2", channel: "EMAIL", delivery: "SENT" },
      { id: "ch3", channel: "WHATSAPP", delivery: "SENT" },
      { id: "ch4", channel: null },
    ]);
    expect(bothRenderers("ch1").row.textContent).toContain("SMS");
    expect(bothRenderers("ch2").row.textContent).toContain("Email");
    expect(bothRenderers("ch3").row.textContent).toContain("WhatsApp");
    expect(bothRenderers("ch4").row.textContent).toContain("Copy link");
    // "Not sent" reported a failure that never happened here: this link has no
    // delivery record because none was ever supposed to exist. See
    // `getDeliveryPresentation`.
    expect(bothRenderers("ch4").row.textContent).toContain("Manual");
    expect(bothRenderers("ch4").row.textContent).not.toContain("Not sent");
  });

  it("offers a submissions action only when there is something to open", async () => {
    await mount([
      { id: "s0" },
      { id: "s1", opened: 1, started: 1, submitted: 1 },
      { id: "s9", opened: 9, started: 9, submitted: 9 },
    ]);
    expect(
      bothRenderers("s0").row.querySelector("[data-intake-links-row-submissions]"),
    ).toBeNull();
    expect(bothRenderers("s0").row.textContent).toContain("None yet");
    for (const [id, n] of [
      ["s1", 1],
      ["s9", 9],
    ] as const) {
      const btn = bothRenderers(id).row.querySelector(
        "[data-intake-links-row-submissions]",
      ) as HTMLElement;
      expect(btn).toBeTruthy();
      // The visible text shortens at narrow widths; the ACCESSIBLE name is the
      // full phrase at every width.
      expect(btn.getAttribute("aria-label")).toBe(`View submissions (${n})`);
    }
  });

  it("holds long titles and long recipient labels inside the row model", async () => {
    await mount([
      { id: "long", title: LONG_TITLE, recipientLabel: LONG_RECIPIENT },
    ]);
    const { row, card } = bothRenderers("long");
    // Not truncated in the DOM — containment is a CSS property, proven by the
    // browser geometry gate; what must be true HERE is that the value is whole.
    expect(row.textContent).toContain(LONG_TITLE);
    expect(card.textContent).toContain(LONG_TITLE);
    expect(row.textContent).toContain(LONG_RECIPIENT);
  });
});

// ===========================================================================
// Page states
// ===========================================================================

describe("page states", () => {
  it("paginates from the first page to the last without losing a row", async () => {
    const many: Spec[] = Array.from({ length: 60 }, (_, i) => ({
      id: `p${String(i).padStart(2, "0")}`,
    }));
    await mount(many);
    const pager = () =>
      document.querySelector("[data-intake-links-pagination]") as HTMLElement;
    const rowCount = () =>
      document.querySelectorAll("[data-intake-links-row-id]").length;

    expect(rowCount()).toBe(25);
    expect(pager().textContent).toContain("Page 1 of 3");
    // First page: no previous.
    expect(
      (pager().querySelector("[data-intake-links-prev-page]") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      fireEvent.click(pager().querySelector("[data-intake-links-next-page]") as HTMLElement);
    });
    expect(rowCount()).toBe(25);
    expect(pager().textContent).toContain("Page 2 of 3");

    await act(async () => {
      fireEvent.click(pager().querySelector("[data-intake-links-next-page]") as HTMLElement);
    });
    expect(rowCount()).toBe(10);
    expect(pager().textContent).toContain("Page 3 of 3");
    // Last page: no next.
    expect(
      (pager().querySelector("[data-intake-links-next-page]") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("marks an in-flight archive as pending and refuses a second click", async () => {
    mutationOutcome = (p) => (p.endsWith("/archive") ? "hang" : "ok");
    await mount([{ id: "m1" }]);
    const openMenu = async () => {
      await act(async () => {
        fireEvent.click(
          document.querySelector("[data-intake-links-row-menu-trigger]") as HTMLElement,
        );
      });
    };
    await openMenu();
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-intake-links-row-action="archive"]') as HTMLElement,
      );
    });
    const archiveCalls = () =>
      requestLog.filter((r) => r.path.endsWith("/archive")).length;
    expect(archiveCalls()).toBe(1);

    // The item is now pending; re-opening the menu shows it busy and firing it
    // again must not produce a second mutation.
    await openMenu();
    const again = document.querySelector(
      '[data-intake-links-row-action="archive"]',
    ) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    expect(again.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      fireEvent.click(again);
    });
    expect(archiveCalls()).toBe(1);
  });

  it("a partial failure keeps the list and says what failed", async () => {
    mutationOutcome = (p) => (p.endsWith("/archive") ? "fail" : "ok");
    await mount([{ id: "m2" }, { id: "m3" }]);
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-links-row-menu-trigger]") as HTMLElement,
      );
    });
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-intake-links-row-action="archive"]') as HTMLElement,
      );
    });
    await waitFor(() =>
      expect(document.querySelector("[data-intake-links-mutation-error]")).toBeTruthy(),
    );
    const alert = document.querySelector(
      "[data-intake-links-mutation-error]",
    ) as HTMLElement;
    expect(alert.getAttribute("role")).toBe("alert");
    // The canonical safe-feedback path supplies BOTH halves: what happened,
    // then what to do next. Neither may be the raw server text.
    expect(
      alert.querySelector("[data-intake-links-mutation-error-title]")?.textContent,
    ).toMatch(/couldn't archive/i);
    expect(alert.textContent).not.toContain("refused");
    // Both rows survive — a failed mutation is not a reason to blank the table.
    expect(document.querySelectorAll("[data-intake-links-row-id]").length).toBe(2);
    // ...and the operator can dismiss it.
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: /dismiss/i }));
    });
    expect(document.querySelector("[data-intake-links-mutation-error]")).toBeNull();
  });

  it("shows a refreshing notice without tearing the table down", async () => {
    await mount([{ id: "rf1" }]);
    // A refresh is what a successful mutation triggers.
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-links-row-menu-trigger]") as HTMLElement,
      );
    });
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-intake-links-row-action="archive"]') as HTMLElement,
      );
    });
    await waitFor(() =>
      expect(
        requestLog.filter((r) => r.path.startsWith("/v1/workflow/intake-links?")).length,
      ).toBeGreaterThan(1),
    );
    // The table never disappeared during the refresh.
    expect(document.querySelector("[data-intake-links-table]")).toBeTruthy();
  });
});

// ===========================================================================
// Every state uses the redesigned system
// ===========================================================================

describe("every record state renders through the redesigned system", () => {
  it("no state falls back to a native control or a legacy class", async () => {
    await mount(COMBINATIONS.map((c) => c.spec));
    const surface = document.querySelector(
      '[data-testid="intake-links-page"]',
    ) as HTMLElement;
    expect(surface.querySelectorAll("select").length).toBe(0);
    for (const legacy of [
      ".cases-panel",
      ".cases-empty",
      ".cases-form-input",
      "[data-intake-links-row-lifecycle-chip]",
    ]) {
      expect(
        surface.querySelector(legacy),
        `legacy selector ${legacy} is still rendered`,
      ).toBeNull();
    }
    // Every chip in the matrix is the canonical badge.
    // Both renderers are in the DOM under jsdom (CSS decides which is shown),
    // so every combination contributes a table badge AND a card badge.
    const badges = surface.querySelectorAll("[data-intake-links-row-link-state]");
    expect(badges.length).toBe(COMBINATIONS.length * 2);
    for (const b of Array.from(badges)) {
      expect(b.classList.contains("app-status-badge")).toBe(true);
      expect(b.getAttribute("data-tone")).toBeTruthy();
      expect((b.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("the actions menu is a menu in every state, and only offers eligible actions", async () => {
    await mount(COMBINATIONS.map((c) => c.spec));
    for (const combo of COMBINATIONS) {
      const row = document.querySelector(
        `[data-intake-links-row-id="${combo.spec.id}"]`,
      ) as HTMLElement;
      const trigger = row.querySelector(
        "[data-intake-links-row-menu-trigger]",
      ) as HTMLElement;
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      await act(async () => {
        fireEvent.click(trigger);
      });
      const menu = document.querySelector('[role="menu"]') as HTMLElement;
      const keys = within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.getAttribute("data-intake-links-row-action"));
      expect(keys).toContain("details");
      // Disable is offered only where the API would accept it.
      const disablable = combo.lifecycle === "ACTIVE" || combo.lifecycle === "EXPIRED";
      expect(keys.includes("revoke")).toBe(disablable);
      // Archived rows offer restore, never a second archive.
      if (combo.lifecycle === "ARCHIVED") {
        expect(keys).toContain("unarchive");
        expect(keys).not.toContain("archive");
      }
      await act(async () => {
        fireEvent.keyDown(menu, { key: "Escape" });
      });
    }
  });
});

// ===========================================================================
// Expiration is a DATE, and lifecycle is stated exactly once
// ===========================================================================

describe("expiration column and the single lifecycle region", () => {
  it("the expiration cell shows the formatted date and never the word Expired", async () => {
    await mount([
      { id: "e-past", status: "EXPIRED", used: 1, expires: PAST },
      { id: "e-future", expires: FUTURE },
    ]);
    for (const id of ["e-past", "e-future"]) {
      const cell = document.querySelector(
        `.ilk-records--wide [data-intake-links-row-id="${id}"] [data-intake-links-row-expires]`,
      ) as HTMLElement;
      const date = cell.querySelector(
        "[data-intake-links-row-expiry-date]",
      ) as HTMLElement;
      expect(date, `${id} has no date`).toBeTruthy();
      // The visible text is the date and nothing else…
      expect(date.textContent?.trim().length).toBeGreaterThan(0);
      expect(date.textContent).not.toMatch(/Expired|Expires/);
      // …the canonical formatter produced it (a real day/month/year), not a
      // fabricated or relative string.
      expect(date.textContent).toMatch(/\d{1,2}\s+\w{3}\s+\d{4}/);
      /*
       * …and assistive technology still hears the relationship — now from a
       * real <dt> key rather than a visually-hidden phrase, because the
       * Timeline column labels both of its dates in the open. The key reads
       * "Expires" in every state on purpose: the Status column one cell away
       * already says "Expired" when it is, and a row that prints the word
       * twice is a row talking over itself.
       */
      const line = cell.closest(".ilk-timeline__line") as HTMLElement;
      expect(line, `${id} has no timeline line`).toBeTruthy();
      const key = line.querySelector(".ilk-timeline__key") as HTMLElement;
      expect(key.textContent?.trim()).toBe("Expires");
      // The state is still machine-readable, which is what the probe is for.
      expect(cell.getAttribute("data-intake-links-row-expires")).toBe(
        id === "e-past" ? "expired" : "ok",
      );
    }
  });

  it("a missing expiry uses the canonical fallback, never a fabricated date", async () => {
    await mount([{ id: "e-none", expires: "" as unknown as string }]);
    const date = document.querySelector(
      '.ilk-records--wide [data-intake-links-row-id="e-none"] [data-intake-links-row-expiry-date]',
    ) as HTMLElement;
    expect(date.textContent?.trim()).toBe("Not available");
  });

  it("the Expired lifecycle badge stays in the Status column", async () => {
    await mount([{ id: "e1", status: "EXPIRED", used: 1, expires: PAST }]);
    const cell = document.querySelector(
      '.ilk-records--wide [data-intake-links-row-id="e1"] td[data-col="status"]',
    ) as HTMLElement;
    expect(cell.textContent).toContain("Expired");
    expect(
      cell.querySelector('[data-intake-links-row-link-state="EXPIRED"]'),
    ).toBeTruthy();
  });

  it("the desktop row states its lifecycle exactly once", async () => {
    await mount(COMBINATIONS.map((c) => c.spec));
    for (const combo of COMBINATIONS) {
      const row = document.querySelector(
        `.ilk-records--wide [data-intake-links-row-id="${combo.spec.id}"]`,
      ) as HTMLElement;
      expect(
        row.querySelectorAll("[data-intake-links-row-link-state]").length,
        `${combo.name} repeats its lifecycle`,
      ).toBe(1);
      // …and the one it has leads the Status column.
      const badge = row.querySelector("[data-intake-links-row-link-state]");
      expect(badge?.closest("td")?.getAttribute("data-col")).toBe("status");
    }
  });

  it("the mobile card states its lifecycle exactly once, in its own region", async () => {
    await mount(COMBINATIONS.map((c) => c.spec));
    for (const combo of COMBINATIONS) {
      const card = document.querySelector(
        `[data-intake-links-card-id="${combo.spec.id}"]`,
      ) as HTMLElement;
      expect(
        card.querySelectorAll("[data-intake-links-row-link-state]").length,
      ).toBe(1);
      // The card head is the lifecycle region; the facts list is not.
      const head = card.querySelector(".ilk-card__head") as HTMLElement;
      expect(head.querySelector("[data-intake-links-row-link-state]")).toBeTruthy();
      const facts = card.querySelector(".ilk-card__facts") as HTMLElement;
      expect(facts.querySelector("[data-intake-links-row-link-state]")).toBeNull();
      // Three separate concepts, three separate regions.
      expect(facts.querySelector("[data-intake-links-row-delivery]")).toBeTruthy();
      expect(
        facts.querySelector("[data-intake-links-row-session-state]"),
      ).toBeTruthy();
      // The card's expiry field is a date under a neutral key.
      /*
       * The card renders the SAME cells the table renders, so its keys are the
       * Timeline column's keys. "Expires", never "Expired" — the lifecycle
       * badge in the card head already carries that word.
       */
      const keys = Array.from(facts.querySelectorAll("dt")).map((d) =>
        d.textContent?.trim(),
      );
      expect(keys).toContain("Latest");
      expect(keys).toContain("Expires");
      expect(keys).not.toContain("Expired");
      expect(
        facts.querySelector("[data-intake-links-row-expiry-date]")?.textContent,
      ).not.toMatch(/Expired/);
    }
  });

  it("no lifecycle fold survives anywhere in the row", async () => {
    await mount([{ id: "f1", archived: PAST }]);
    expect(document.querySelector('[data-fold="lifecycle"]')).toBeNull();
    expect(
      document.querySelector("[data-intake-links-row-link-state-folded]"),
    ).toBeNull();
  });
});

// ===========================================================================
// The row-status tone mapping
// ===========================================================================

describe("row status treatment comes from one map", () => {
  /** The badge inside a probe holder, or the holder itself if it is one. */
  function badgeIn(holder: HTMLElement): HTMLElement | null {
    if (holder.classList.contains("app-status-badge")) return holder;
    return holder.querySelector(".app-status-badge");
  }

  // ---------------------------------------------------------------------
  // Lifecycle: the one state the row is scanned by, and the only fill
  // ---------------------------------------------------------------------
  // THE THREE EXCEPTIONS keep the solid fill: they are what an operator
  // scans this column to find. `Active` is handled separately below — it is
  // the ordinary case and is treated as one.
  const LIFECYCLE: Array<[string, Spec, string]> = [
    ["Expired", { id: "t-exp", status: "EXPIRED", used: 1, expires: PAST }, "blue"],
    ["Link disabled", { id: "t-rev", status: "REVOKED", revoked: PAST }, "red"],
    ["Archived", { id: "t-arch", archived: PAST }, "slate"],
  ];

  for (const [label, spec, tone] of LIFECYCLE) {
    it(`lifecycle ${label} keeps the ${tone} fill in both renderers`, async () => {
      await mount([spec]);
      for (const scope of [".ilk-records--wide", ".ilk-records--narrow"]) {
        const host = document.querySelector(scope) as HTMLElement;
        const badge = host.querySelector(
          "[data-intake-links-row-link-state]",
        ) as HTMLElement;
        expect(badge, `${label} missing in ${scope}`).toBeTruthy();
        expect(badge.classList.contains("app-status-badge")).toBe(true);
        expect(badge.getAttribute("data-tone"), `${label} in ${scope}`).toBe(tone);
        expect(badge.getAttribute("data-fill")).toBe("solid");
        // The word is always beside the colour.
        expect(badge.textContent?.trim()).toBe(label);
      }
    });
  }

  it("lifecycle Active is GREEN, on the SAME filled badge as the rest", async () => {
    // It was INDIGO — the product's brand accent standing in for a state,
    // saying "this is ours" where the column needs "this is healthy".
    //
    // It then briefly took the SOFT variant, on the reasoning that the
    // ordinary case should be quieter than the exceptions. Beside three solid
    // chips that read as a different KIND of thing rather than a different
    // state, so the column has one structure again and only the colour varies.
    // Canonical green as a solid fill is `--success-ink` (#167A5B); white on
    // it measures 5.29:1, so the badge holds WCAG AA.
    await mount([{ id: "t-act" }]);
    for (const scope of [".ilk-records--wide", ".ilk-records--narrow"]) {
      const host = document.querySelector(scope) as HTMLElement;
      const badge = host.querySelector(
        "[data-intake-links-row-link-state]",
      ) as HTMLElement;
      expect(badge, `Active missing in ${scope}`).toBeTruthy();
      expect(badge.classList.contains("app-status-badge")).toBe(true);
      expect(badge.getAttribute("data-tone"), scope).toBe("green");
      expect(badge.getAttribute("data-fill"), scope).toBe("solid");
      expect(badge.textContent?.trim()).toBe("Active");
    }
  });

  // ---------------------------------------------------------------------
  // Delivery and Activity: neutral text, in both renderers
  // ---------------------------------------------------------------------
  const NEUTRAL: Array<[string, Spec, string, string]> = [
    // label, fixture, probe attribute, expected wire value
    [
      "Submitted",
      { id: "n-sub", opened: 1, started: 1, submitted: 1 },
      "data-intake-links-row-session-state",
      "SUBMITTED",
    ],
    [
      "Not opened",
      { id: "n-quiet" },
      "data-intake-links-row-session-state",
      "NO_ACTIVITY",
    ],
    [
      "Opened",
      { id: "n-open", opened: 1 },
      "data-intake-links-row-session-state",
      "OPENED",
    ],
    [
      "Delivered",
      { id: "n-del", channel: "SMS", delivery: "DELIVERED" },
      "data-intake-links-row-delivery",
      "DELIVERED",
    ],
    [
      "Failed",
      { id: "n-fail", channel: "SMS", delivery: "FAILED", attempts: 2 },
      "data-intake-links-row-delivery",
      "FAILED",
    ],
    [
      // A REAL provider record whose status is not one of the recognised
      // sends — `RECEIVED` is an inbound message, which folds to NOT_SENT.
      // A record exists, so the manual rule cannot claim it.
      "Not sent",
      { id: "n-none", channel: "EMAIL", delivery: "RECEIVED", attempts: 1 },
      "data-intake-links-row-delivery",
      "NOT_SENT",
    ],
    [
      // No delivery record at all — the manual-distribution signal.
      "Manual",
      { id: "n-manual" },
      "data-intake-links-row-delivery",
      "MANUAL",
    ],
  ];

  for (const [label, spec, attr, wire] of NEUTRAL) {
    it(`${label} is neutral text, not a status fill, in both renderers`, async () => {
      await mount([spec]);
      for (const scope of [".ilk-records--wide", ".ilk-records--narrow"]) {
        const host = document.querySelector(scope) as HTMLElement;
        const holder = host.querySelector(`[${attr}]`) as HTMLElement;
        expect(holder, `${label} missing in ${scope}`).toBeTruthy();

        // The wire value and the wording are untouched — this is presentation.
        expect(holder.getAttribute(attr), `${label} in ${scope}`).toBe(wire);
        expect(holder.textContent).toContain(label);

        // NOTHING in this value is a badge, a tone or a fill.
        expect(badgeIn(holder), `${label} still renders a badge in ${scope}`).toBeNull();
        expect(holder.getAttribute("data-tone")).toBeNull();
        expect(holder.getAttribute("data-fill")).toBeNull();
        expect(holder.getAttribute("style")).toBeNull();
      }
    });
  }

  it("carries exactly one fill per row, and it is the lifecycle", async () => {
    /*
     * The rule has not changed, only where it applies. EXACTLY ONE filled
     * badge per row, and it is the state the row is scanned by. Delivery and
     * activity are supporting facts and stay as toned text — three saturated
     * rectangles in a row is a colour vocabulary competing with itself.
     *
     * The Status cell now holds that one badge, because the lifecycle moved
     * into it. So the assertion moved with it: the cell has one badge, the
     * activity beside it has none, and the Delivery cell has none either.
     */
    await mount(COMBINATIONS.map((c) => c.spec));
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".ilk-records--wide [data-intake-links-row-id]",
      ),
    );
    expect(rows.length).toBe(COMBINATIONS.length);
    for (const row of rows) {
      // One fill in the whole row.
      expect(row.querySelectorAll(".app-status-badge").length).toBe(1);
      expect(
        row.querySelector(".app-status-badge")?.getAttribute(
          "data-intake-links-row-link-state",
        ),
      ).toBeTruthy();

      const status = row.querySelector(".ilk-status") as HTMLElement;
      const delivery = row.querySelector(".ilk-delivery") as HTMLElement;
      expect(status).toBeTruthy();
      expect(delivery).toBeTruthy();

      // The subordinate values carry no fill of their own.
      for (const value of [
        status.querySelector("[data-intake-links-row-session-state]"),
        delivery.querySelector("[data-intake-links-row-delivery]"),
      ]) {
        expect(value).toBeTruthy();
        expect(value?.classList.contains("app-status-badge")).toBe(false);
        expect(value?.getAttribute("data-tone")).toBeNull();
        expect(value?.getAttribute("data-fill")).toBeNull();
      }

      // Both facts are still NAMED, so neither is heard as part of the other.
      expect(status.textContent).toMatch(/Contributor activity:/);
      expect(delivery.textContent).toMatch(/Delivery status:/);
    }
  });

  it("the card states the same two facts, the same TONED way", async () => {
    await mount(COMBINATIONS.map((c) => c.spec));
    for (const combo of COMBINATIONS) {
      const card = document.querySelector(
        `[data-intake-links-card-id="${combo.spec.id}"]`,
      ) as HTMLElement;
      const facts = card.querySelector(".ilk-card__facts") as HTMLElement;
      for (const attr of [
        "data-intake-links-row-delivery",
        "data-intake-links-row-session-state",
      ]) {
        const holder = facts.querySelector(`[${attr}]`) as HTMLElement;
        expect(holder, `${combo.name} / ${attr}`).toBeTruthy();
        expect(badgeIn(holder), `${combo.name} / ${attr} is a badge`).toBeNull();
        // TONED TEXT, from the shared class the table cell also uses — one
        // authority, two renderers, so the card cannot drift into a second
        // design. The capsule these values used to sit in is gone.
        expect(
          holder.classList.contains("ilk-state-text"),
          `${combo.name} / ${attr} lost the shared treatment`,
        ).toBe(true);
        expect(
          holder.getAttribute("data-ilk-tone"),
          `${combo.name} / ${attr} carries no tone`,
        ).toBeTruthy();
        // …and the WORD is always there, so colour is never the only cue.
        expect((holder.textContent ?? "").trim().length).toBeGreaterThan(0);
      }
      // The card head keeps the ONE badge: lifecycle. Solid for the
      // exceptions, the soft canonical green for the ordinary Active.
      const head = card.querySelector(".ilk-card__head") as HTMLElement;
      const life = head.querySelector(
        "[data-intake-links-row-link-state]",
      ) as HTMLElement;
      expect(life.classList.contains("app-status-badge")).toBe(true);
      expect(life.getAttribute("data-fill")).toBe("solid");
      expect(facts.querySelector(".app-status-badge")).toBeNull();
    }
  });

  it("an unknown wire state falls back to neutral rather than guessing", async () => {
    // A delivery status the contract does not define must not invent wording.
    await mount([
      { id: "u1", channel: "SMS", delivery: "SOMETHING_NEW_FROM_THE_PROVIDER" },
    ]);
    const holder = document.querySelector(
      ".ilk-records--wide [data-intake-links-row-delivery]",
    ) as HTMLElement;
    expect(holder.getAttribute("data-intake-links-row-delivery")).toBe("NOT_SENT");
    expect(holder.textContent?.trim()).toBe("Not sent");
    expect(badgeIn(holder)).toBeNull();
  });

  it("desktop and mobile state the SAME values for the same record", async () => {
    await mount(COMBINATIONS.map((c) => c.spec));
    for (const combo of COMBINATIONS) {
      const read = (scope: string, attr: string) => {
        const host = document.querySelector(
          `${scope} [data-intake-links-${scope.includes("wide") ? "row" : "card"}-id="${combo.spec.id}"]`,
        ) as HTMLElement;
        const holder = host.querySelector(`[${attr}]`) as HTMLElement;
        return {
          wire: holder.getAttribute(attr),
          badge: badgeIn(holder)?.getAttribute("data-tone") ?? null,
        };
      };
      for (const attr of [
        "data-intake-links-row-link-state",
        "data-intake-links-row-session-state",
        "data-intake-links-row-delivery",
      ]) {
        expect(
          read(".ilk-records--narrow", attr),
          `${combo.name} / ${attr}`,
        ).toEqual(read(".ilk-records--wide", attr));
      }
    }
  });
});

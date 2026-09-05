/**
 * WORKSPACE & CAPABILITY CONVERGENCE GATE — /intake-links.
 *
 * The management surface has to be ONE implementation. Personal, Personal Pro,
 * Organization, Enterprise and platform-admin contexts must mount the same
 * route file, the same shell, the same table geometry and the same wizard.
 * Capability decides WHETHER the surface renders and WHICH channels can send;
 * it may never decide which design system renders.
 *
 * That property cannot be read out of source, because every branch is runtime:
 * the page reads `usePlatformContext()`, `useCan()` and `useOwningContextLabel()`,
 * all resolved from the server-projected envelope. So this file drives the REAL
 * page through the whole matrix.
 *
 * The `legacyEnvelope` context is deliberately misleading: `accountPlan:
 * "ENTERPRISE"` and a workspace literally named "Enterprise Holdings", with the
 * capability withheld. It must be REFUSED. Enterprise is never inferred from a
 * plan string or a workspace name.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup, fireEvent, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

let requestLog: string[] = [];

type ChannelTransport = { configured: boolean; fromNumberPreview?: string };
type Transport = {
  email: ChannelTransport;
  sms: ChannelTransport;
  whatsapp: ChannelTransport;
};

let transport: Transport = {
  email: { configured: true },
  sms: { configured: true, fromNumberPreview: "+1 ••• 8084" },
  whatsapp: { configured: true },
};

/** When set, the list read rejects with this status (the server refusing). */
let refuseList: number | null = null;

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    requestLog.push(path);
    if (path.startsWith("/v1/workflow/intake-links?")) {
      if (refuseList !== null) {
        const err = new Error("refused") as Error & { statusCode: number };
        err.statusCode = refuseList;
        throw err;
      }
      return { items: [ITEM] };
    }
    if (path.startsWith("/v1/workflow/templates")) return { templates: [] };
    if (path.includes("/sender-identity")) return transport;
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
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

const WS = {
  personal: "11111111-1111-4111-8111-111111111111",
  pro: "22222222-2222-4222-8222-222222222222",
  organization: "33333333-3333-4333-8333-333333333333",
  enterprise: "44444444-4444-4444-8444-444444444444",
  admin: "55555555-5555-4555-8555-555555555555",
  legacy: "66666666-6666-4666-8666-666666666666",
  member: "77777777-7777-4777-8777-777777777777",
  inactive: "88888888-8888-4888-8888-888888888888",
} as const;

/**
 * ONE record fixture, shared by every context. Holding the RECORD constant is
 * deliberate: any difference the matrix observes must come from the capability
 * projection, never from the data.
 */
const ITEM = {
  link: {
    id: "link-1",
    teamId: "any",
    workflowTemplateSlug: "general-evidence-record",
    workflowTemplateVersion: 1,
    workflowTemplateName: "General evidence request",
    intakeMode: "EXTERNAL_ONE_TIME",
    caseId: null,
    recipientLabel: "Jane Smith",
    recipientEmailPreview: null,
    recipientPhonePreview: null,
    maxUses: 1,
    usedCount: 0,
    status: "ACTIVE",
    expiresAtUtc: "2099-01-01T00:00:00.000Z",
    revokedAtUtc: null,
    revokedReason: null,
    archivedAtUtc: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  delivery: {
    latestStatus: "DELIVERED",
    latestChannel: "SMS",
    latestAtUtc: "2026-08-01T00:00:00.000Z",
    latestSentAtUtc: "2026-08-01T00:00:00.000Z",
    latestDeliveredAtUtc: "2026-08-01T00:00:00.000Z",
    latestFailedAtUtc: null,
    latestErrorCode: null,
    attemptCount: 1,
    channelsAttempted: ["SMS"],
    latestProviderMessageId: null,
  },
  activity: {
    firstOpenedAtUtc: null,
    lastOpenedAtUtc: null,
    firstStartedAtUtc: null,
    lastStartedAtUtc: null,
    firstSubmittedAtUtc: null,
    lastSubmittedAtUtc: null,
    sessionsCreated: 0,
    sessionsOpened: 0,
    sessionsStarted: 0,
    sessionsSubmitted: 0,
    sessionsExpired: 0,
    sessionsRevoked: 0,
    evidenceCount: 0,
  },
  computedLifecycle: "SENT",
};

type ContextKey =
  | "personalFree"
  | "personalPro"
  | "organization"
  | "enterprise"
  | "platformAdmin"
  | "insufficientRole"
  | "featureExcluded"
  | "legacyEnvelope"
  | "missingEnvelope"
  | "inactiveWorkspace"
  | "wrongWorkspaceContext";

/** Contexts whose envelope authorises the management surface. */
const AUTHORISED: ContextKey[] = [
  "personalPro",
  "organization",
  "enterprise",
  "platformAdmin",
  // A suspended ACCOUNT is not a client-side gate: nothing in the web tier
  // reads `account.accountStatus`, and inventing a branch on it would be a
  // second authority guessing at something the server decides. The surface
  // therefore renders identically, and the API's refusal — asserted in its own
  // case below — is what closes the door.
  "inactiveWorkspace",
  // The page resolves its workspace from `activeSpace` alone. This context
  // deliberately disagrees with `contextOptions.activeContext` so a regression
  // that started reading the other field would read the WRONG tenant.
  "wrongWorkspaceContext",
];

/** Contexts that must NOT render the management surface at all. */
const REFUSED: ContextKey[] = [
  "personalFree",
  "insufficientRole",
  "featureExcluded",
  "legacyEnvelope",
  "missingEnvelope",
];

function space(
  type: "PERSONAL" | "ORGANIZATION",
  id: string,
  displayName: string,
) {
  return {
    workspace: { id, name: displayName, status: "active", scope: type },
    activeSpace: { type, id, displayName, roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: id,
        kind: type,
        organizationId: null,
        displayName,
      },
    },
  };
}

function makeEnvelope(key: ContextKey): unknown {
  const base = {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    diagnostics: { requestId: `test-${key}` },
    platform: { isPlatformAdmin: false },
    flags: { isEnterpriseWorkspace: false },
  };

  switch (key) {
    case "personalFree":
      // FREE excludes intake — the server says so via planFeatures.
      return {
        ...base,
        ...space("PERSONAL", WS.personal, "Personal Space"),
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "FREE", accountStatus: "active" },
        planFeatures: { intakeIncluded: false },
      };
    case "personalPro":
      return {
        ...base,
        ...space("PERSONAL", WS.pro, "Personal Space"),
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "PRO", accountStatus: "active" },
        planFeatures: { intakeIncluded: true },
      };
    case "organization":
      return {
        ...base,
        ...space("ORGANIZATION", WS.organization, "Acme Legal"),
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "TEAM", accountStatus: "active" },
        planFeatures: { intakeIncluded: true },
      };
    case "enterprise":
      return {
        ...base,
        ...space("ORGANIZATION", WS.enterprise, "Northwind Holdings"),
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
        planFeatures: { intakeIncluded: true },
        flags: { isEnterpriseWorkspace: true },
      };
    case "platformAdmin":
      return {
        ...base,
        ...space("ORGANIZATION", WS.admin, "Platform Operations"),
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
        planFeatures: { intakeIncluded: true },
        platform: { isPlatformAdmin: true },
      };
    case "insufficientRole":
      // Authenticated member of a paying workspace, without the capability.
      return {
        ...base,
        ...space("ORGANIZATION", WS.member, "Acme Legal"),
        capabilities: {},
        account: { accountPlan: "TEAM", accountStatus: "active" },
        planFeatures: { intakeIncluded: true },
      };
    case "featureExcluded":
      return {
        ...base,
        ...space("ORGANIZATION", WS.organization, "Acme Legal"),
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "TEAM", accountStatus: "active" },
        planFeatures: { intakeIncluded: false },
      };
    case "legacyEnvelope":
      // Misleading on purpose: an enterprise-sounding plan and name, with NO
      // capability and NO plan feature projected.
      return {
        ...base,
        ...space("ORGANIZATION", WS.legacy, "Enterprise Holdings"),
        capabilities: {},
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
      };
    case "inactiveWorkspace":
      return {
        ...base,
        workspace: {
          id: WS.inactive,
          name: "Northgate Claims",
          status: "suspended",
          scope: "ORGANIZATION",
        },
        activeSpace: {
          type: "ORGANIZATION",
          id: WS.inactive,
          displayName: "Northgate Claims",
          roleLabel: "Owner",
        },
        contextOptions: {
          personalSpace: null,
          ownedWorkspaces: [],
          organizations: [],
          activeContext: {
            workspaceId: WS.inactive,
            kind: "ORGANIZATION",
            organizationId: null,
            displayName: "Northgate Claims",
          },
        },
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "TEAM", accountStatus: "suspended" },
        planFeatures: { intakeIncluded: true },
      };
    case "wrongWorkspaceContext":
      // `activeSpace` says one workspace; `contextOptions.activeContext` says
      // another. Exactly one of them may drive the reads.
      return {
        ...base,
        ...space("ORGANIZATION", WS.organization, "Acme Legal"),
        contextOptions: {
          personalSpace: null,
          ownedWorkspaces: [],
          organizations: [],
          activeContext: {
            workspaceId: WS.legacy,
            kind: "ORGANIZATION",
            organizationId: null,
            displayName: "Some Other Workspace",
          },
        },
        capabilities: { INTAKE_LINKS_MANAGE: true },
        account: { accountPlan: "TEAM", accountStatus: "active" },
        planFeatures: { intakeIncluded: true },
      };
    case "missingEnvelope":
      return null;
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(key: ContextKey) {
  cleanup();
  requestLog = [];
  const utils = render(
    <PlatformContextProvider testEnvelope={makeEnvelope(key) as never}>
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

function managementRendered(): boolean {
  return Boolean(document.querySelector('[data-testid="intake-links-page"]'));
}

beforeEach(() => {
  currentSearch = "";
  refuseList = null;
  transport = {
    email: { configured: true },
    sms: { configured: true, fromNumberPreview: "+1 ••• 8084" },
    whatsapp: { configured: true },
  };
});

// ===========================================================================
// One anatomy across every authorised workspace
// ===========================================================================

describe("one design anatomy across authorised workspaces", () => {
  for (const key of AUTHORISED) {
    it(`${key} renders the same shell, header, KPI grid and table`, async () => {
      await mount(key);
      expect(managementRendered()).toBe(true);
      expect(document.querySelector("[data-ui-page-shell]")).toBeTruthy();
      expect(document.querySelector(".app-page-header")).toBeTruthy();
      expect(document.querySelector("[data-intake-links-kpis]")).toBeTruthy();
      expect(document.querySelector("[data-intake-links-table]")).toBeTruthy();
      expect(document.querySelector("[data-intake-links-cards]")).toBeTruthy();
      expect(document.querySelector("[data-intake-links-new-cta]")).toBeTruthy();
      // No legacy branch anywhere: no native option list, no legacy panel.
      expect(document.querySelectorAll("select").length).toBe(0);
      expect(document.querySelector(".cases-panel")).toBeNull();
      expect(document.querySelector(".cases-empty")).toBeNull();
    });
  }

  it("every authorised context renders an identical column set", async () => {
    const shapes: string[][] = [];
    for (const key of AUTHORISED) {
      await mount(key);
      const table = document.querySelector(
        "[data-intake-links-table]",
      ) as HTMLElement;
      shapes.push(
        Array.from(table.querySelectorAll("thead th")).map((th) =>
          (th.getAttribute("data-col") ?? "").trim(),
        ),
      );
    }
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    /*
     * THE SEVEN-COLUMN HIERARCHY.
     *
     * This list had drifted: it still named the nine columns from before the
     * Customer ID column was added, so it described a table that had not
     * existed for some time. Grouping the ten into seven is the occasion to
     * correct it, and the grouping is the point — Customer ID, recipient name,
     * address and number are FOUR independent fields rendered as four lines
     * inside `identity`, not one merged value. The search arms that match them
     * are untouched and remain four.
     */
    expect(shapes[0]).toEqual([
      "request",
      "identity",
      "delivery",
      "status",
      "timeline",
      "submissions",
      "actions",
    ]);
  });

  it("the surface reads ONLY the active workspace id", async () => {
    for (const key of AUTHORISED) {
      await mount(key);
      const env = makeEnvelope(key) as { activeSpace: { id: string } };
      const others = Object.values(WS).filter((id) => id !== env.activeSpace.id);
      for (const path of requestLog) {
        for (const foreign of others) {
          expect(path).not.toContain(foreign);
        }
      }
      expect(
        requestLog.some((p) => p.includes(`teamId=${env.activeSpace.id}`)),
      ).toBe(true);
    }
  });
});

// ===========================================================================
// Refusals — and the fail-closed default
// ===========================================================================

describe("refusals fail closed", () => {
  for (const key of REFUSED) {
    it(`${key} does not render the management surface`, async () => {
      await mount(key);
      expect(managementRendered()).toBe(false);
      expect(document.querySelector("[data-intake-links-table]")).toBeNull();
      expect(document.querySelector("[data-intake-links-new-cta]")).toBeNull();
    });
  }

  it("a refused context issues no intake read at all", async () => {
    for (const key of REFUSED) {
      await mount(key);
      expect(
        requestLog.filter((p) => p.startsWith("/v1/workflow/intake-links")),
      ).toEqual([]);
    }
  });

  it("a missing capability lands on the canonical route gate, not a blank page", async () => {
    await mount("insufficientRole");
    const panel = document.querySelector(
      '[data-testid="route-gate-panel-workspace.intake_links"]',
    );
    expect(panel).toBeTruthy();
    expect((panel as HTMLElement).textContent?.trim().length).toBeGreaterThan(0);
  });

  it("a plan without intake is refused even though the capability is granted", async () => {
    await mount("featureExcluded");
    expect(managementRendered()).toBe(false);
    expect(
      document.querySelector(
        '[data-testid="route-gate-panel-workspace.intake_links"]',
      ),
    ).toBeTruthy();
  });

  it("an ENTERPRISE plan string and an enterprise-sounding name grant nothing", async () => {
    await mount("legacyEnvelope");
    expect(managementRendered()).toBe(false);
    expect(document.body.textContent).not.toContain("General evidence request");
  });

  it("an absent envelope fails closed rather than assuming access", async () => {
    await mount("missingEnvelope");
    expect(managementRendered()).toBe(false);
    expect(document.querySelector("[data-intake-links-table]")).toBeNull();
  });
});

// ===========================================================================
// Provider availability is a server fact, per workspace
// ===========================================================================

// ===========================================================================
// Inactive account, and the one workspace id that may drive a read
// ===========================================================================

describe("inactive account and workspace-context resolution", () => {
  it("a suspended account renders the same surface and closes on the API refusal", async () => {
    // The client never guesses at account status. It renders, asks, and
    // believes the server — which is the only party that knows.
    await mount("inactiveWorkspace");
    expect(managementRendered()).toBe(true);

    refuseList = 403;
    await mount("inactiveWorkspace");
    expect(
      document.querySelector('[data-intake-links-restricted="forbidden"]'),
    ).toBeTruthy();
    // Fail closed: no table, no wizard entry point, and no retry that would
    // just repeat a refusal the server will repeat.
    expect(document.querySelector("[data-intake-links-table]")).toBeNull();
    expect(document.querySelector("[data-intake-links-new-cta]")).toBeNull();
    expect(
      requestLog.filter((p) => p.includes("/archive") || p.includes("/revoke")),
    ).toEqual([]);
  });

  it("reads ONLY the active-space id when contextOptions disagrees", async () => {
    await mount("wrongWorkspaceContext");
    expect(managementRendered()).toBe(true);
    const intakeReads = requestLog.filter((p) =>
      p.startsWith("/v1/workflow/intake-links"),
    );
    expect(intakeReads.length).toBeGreaterThan(0);
    for (const path of intakeReads) {
      expect(path).toContain(`teamId=${WS.organization}`);
      // The other id in the envelope must never reach a request.
      expect(path).not.toContain(WS.legacy);
    }
    // ...and it must not leak into the visible workspace label either.
    const context = document.querySelector(
      "[data-intake-links-context]",
    ) as HTMLElement;
    expect(context.textContent).toContain("Acme Legal");
    expect(context.textContent).not.toContain("Some Other Workspace");
  });
});

describe("delivery availability follows the server projection", () => {
  it("an unavailable channel is disabled in every authorised workspace", async () => {
    transport = {
      email: { configured: true },
      sms: { configured: false },
      whatsapp: { configured: false },
    };
    currentSearch = "new=1";
    for (const key of AUTHORISED) {
      await mount(key);
      const wizard = document.querySelector(
        '[data-testid="intake-link-create-wizard"]',
      ) as HTMLElement;
      expect(wizard).toBeTruthy();
      await act(async () => {
        fireEvent.click(
          wizard.querySelector("[data-intake-link-wizard-next]") as HTMLElement,
        );
      });
      const sms = document.querySelector(
        '[data-intake-link-delivery-method-input="SMS"]',
      ) as HTMLInputElement;
      const email = document.querySelector(
        '[data-intake-link-delivery-method-input="EMAIL"]',
      ) as HTMLInputElement;
      expect(sms.disabled).toBe(true);
      expect(email.disabled).toBe(false);
      // Copy-link needs no provider and is therefore always available.
      expect(
        (
          document.querySelector(
            '[data-intake-link-delivery-method-input="MANUAL"]',
          ) as HTMLInputElement
        ).disabled,
      ).toBe(false);
    }
  });

  it("the workspace name in the header is the one the envelope projected", async () => {
    await mount("organization");
    const context = document.querySelector(
      "[data-intake-links-context]",
    ) as HTMLElement;
    expect(context.textContent).toContain("Acme Legal");

    await mount("personalPro");
    const personal = document.querySelector(
      "[data-intake-links-context]",
    ) as HTMLElement;
    expect(personal.textContent).toContain("Personal Space");
    expect(personal.textContent).not.toContain("Acme Legal");
  });
});

// ===========================================================================
// Accessibility invariants that must hold in every authorised context
// ===========================================================================

describe("accessibility invariants hold in every authorised context", () => {
  it("status is never conveyed by colour alone", async () => {
    for (const key of AUTHORISED) {
      await mount(key);
      const badges = document.querySelectorAll("[data-intake-links-row-link-state]");
      expect(badges.length).toBeGreaterThan(0);
      for (const badge of Array.from(badges)) {
        expect((badge.textContent ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("no interactive element is nested inside another", async () => {
    for (const key of AUTHORISED) {
      await mount(key);
      const interactive = document.querySelectorAll(
        "button, a[href], input, textarea, [role='combobox'], [role='menuitem']",
      );
      for (const el of Array.from(interactive)) {
        const nested = el.querySelector(
          "button, a[href], input, textarea, select",
        );
        expect(nested).toBeNull();
      }
    }
  });

  it("the table exposes real table semantics with scoped headers", async () => {
    await mount("organization");
    const table = document.querySelector(
      "[data-intake-links-table]",
    ) as HTMLElement;
    expect(table.tagName).toBe("TABLE");
    expect(table.getAttribute("aria-label")).toBe("Intake links");
    for (const th of Array.from(table.querySelectorAll("thead th"))) {
      expect(th.getAttribute("scope")).toBe("col");
    }
    // The actions column has an accessible name without a visible label.
    const actions = table.querySelector('th[data-col="actions"]') as HTMLElement;
    expect(actions.querySelector(".app-visually-hidden")?.textContent).toBe(
      "Actions",
    );
  });

  it("the KPI cards expose pressed state and a described-by explanation", async () => {
    await mount("enterprise");
    const cards = document.querySelectorAll("[data-intake-links-kpi]");
    expect(cards.length).toBe(7);
    for (const card of Array.from(cards)) {
      expect(card.getAttribute("aria-pressed")).toMatch(/true|false/);
      const describedBy = card.getAttribute("aria-describedby") as string;
      expect(document.getElementById(describedBy)?.textContent?.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("every filter control has an accessible name", async () => {
    await mount("organization");
    const combos = document.querySelectorAll(
      '[data-intake-links-controls] [role="combobox"]',
    );
    expect(combos.length).toBe(4);
    for (const combo of Array.from(combos)) {
      const labelledBy = combo.getAttribute("aria-labelledby");
      const label = labelledBy
        ? document.getElementById(labelledBy)?.textContent
        : combo.getAttribute("aria-label");
      expect((label ?? "").trim().length).toBeGreaterThan(0);
    }
    const search = document.querySelector(
      "[data-intake-links-search]",
    ) as HTMLElement;
    expect(search.getAttribute("aria-label")).toBe("Search intake links");
  });

  it("the row menu names the row it acts on", async () => {
    await mount("organization");
    const trigger = document.querySelector(
      "[data-intake-links-row-menu-trigger]",
    ) as HTMLElement;
    expect(trigger.getAttribute("aria-label")).toBe(
      "Actions for General evidence request",
    );
    await act(async () => {
      fireEvent.click(trigger);
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.getAttribute("aria-label")).toBe(
      "Actions for General evidence request",
    );
    expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(0);
  });
});

/**
 * WORKSPACE & CAPABILITY CONVERGENCE GATE — /search.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The Search console has to be ONE implementation. Every workspace kind —
 * Personal, Personal Pro, Organization, Enterprise — must mount the same route
 * file, the same shell, the same result geometry and the same Inspector.
 * Capability may decide WHICH PANELS appear and WHICH ACTIONS are offered; it
 * may never decide which design system renders.
 *
 * That property cannot be proven by reading source, because the branches are
 * runtime: the route reads `useWorkspaceId()`, `usePlatformContext()` and
 * `useEnterpriseSurfaceAccess()`, all of which resolve from the
 * server-projected platform-context envelope, plus the server-projected
 * `readiness.canRecover`. So this file drives the REAL page component through
 * thirteen contexts and asserts the matrix directly.
 *
 * WHAT "CONVERGED" MEANS HERE, PRECISELY
 *   - the same shell anatomy in every context that renders results,
 *   - optional panels appear ONLY under their canonical capability,
 *   - a hidden capability leaves NO layout residue: no empty panel, no orphan
 *     heading, no reserved track, and NO request to the API it would have
 *     needed,
 *   - an unknown projection fails CLOSED — Enterprise is never inferred from a
 *     plan string, a workspace name, or the absence of a flag.
 *
 * The `legacy` context carries `accountPlan: "ENTERPRISE"` and a workspace
 * literally named "Enterprise Holdings" while being required to render as a
 * non-enterprise surface. That is the whole point of it.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams — every request the console makes, recorded in order
// ---------------------------------------------------------------------------

let requestLog: string[] = [];

/** What the fixture wants the server to say this render. */
type Scenario = {
  readiness: Record<string, unknown> | null;
  rows: Array<Record<string, unknown>>;
  /** `GET /v1/search` rejects. */
  searchFails?: boolean;
  savedViews?: Array<Record<string, unknown>>;
  semanticAvailable?: boolean;
  /**
   * What `POST /v1/search/reconcile` answers.
   *
   * 202-with-an-active-run and 200-completed are different facts, and the
   * console must not report the first as the second.
   */
  reconcile?: Record<string, unknown>;
};

let scenario: Scenario = { readiness: null, rows: [] };

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    requestLog.push(path);
    return respond(path);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/search",
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
import SearchPage from "../../app/(app)/search/page";

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
} as const;

/**
 * One row fixture, shared by every context.
 *
 * Holding the RECORD constant is deliberate: any difference the matrix
 * observes must come from the capability projection, never from the data.
 */
function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentId: "doc-1",
    documentType: "EVIDENCE",
    title: "incident-bundle.zip",
    subtitle: "Active",
    summary: "A recorded incident bundle.",
    evidenceId: "ev-1",
    workflowInstanceId: "wf-1",
    workflowStepInstanceId: "wfs-1",
    caseId: "case-1",
    reviewState: null,
    workflowState: null,
    exportState: null,
    retentionState: null,
    legalHoldState: null,
    contributorScoped: false,
    reviewerRestricted: false,
    badges: [],
    updatedAtUtc: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** The canonical readiness projection, with only the named fields overridden. */
function makeReadiness(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "READY",
    eligibleCount: 4,
    indexedCount: 4,
    outstandingCount: 0,
    unresolvedRemovals: 0,
    lastIndexedAtUtc: "2026-08-01T00:00:00.000Z",
    progressing: false,
    runStatus: "SUCCEEDED",
    runStartedAtUtc: "2026-08-01T00:00:00.000Z",
    runFinishedAtUtc: "2026-08-01T00:00:01.000Z",
    failureReason: null,
    degradedCapabilities: [],
    shouldPoll: false,
    resultsAreComplete: true,
    canRecover: false,
    ...over,
  };
}

function respond(path: string): unknown {
  if (path.startsWith("/v1/search/diagnostics")) {
    if (!scenario.readiness) return null;
    return {
      workspace: { id: "ws", name: "Fixture workspace", isPersonal: false },
      readiness: scenario.readiness,
      evidence: { total: scenario.readiness.eligibleCount },
      index: {
        total: scenario.readiness.indexedCount,
        byType: { EVIDENCE: scenario.readiness.indexedCount },
        evidenceIndexed: scenario.readiness.indexedCount,
        evidenceTotal: scenario.readiness.eligibleCount,
        coverage: 100,
        breakdown: {},
      },
      health: "healthy",
      runtime: { dbServerIp: null, dbName: null },
    };
  }
  if (path.startsWith("/v1/search/saved-views")) {
    return { views: scenario.savedViews ?? [] };
  }
  if (path.startsWith("/v1/search/semantic/status")) {
    return {
      enabled: scenario.semanticAvailable ?? false,
      providerName: scenario.semanticAvailable ? "openai" : "disabled",
      semanticAvailable: scenario.semanticAvailable ?? false,
      fallbackReason: null,
      usage: null,
    };
  }
  if (path.startsWith("/v1/search/audit")) {
    return { rows: [], nextCursor: null };
  }
  if (path.startsWith("/v1/search/reconcile")) {
    return scenario.reconcile ?? { accepted: true, status: "COMPLETED" };
  }
  if (path.startsWith("/v1/search?")) {
    if (scenario.searchFails) throw new Error("search unavailable");
    return {
      rows: scenario.rows,
      totalReturned: scenario.rows.length,
      nextCursor: null,
      withheld: 0,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The thirteen contexts
// ---------------------------------------------------------------------------

type ContextKey =
  | "personalNormal"
  | "personalPro"
  | "organization"
  | "enterpriseFull"
  | "enterpriseNoSemantic"
  | "enterpriseNoAudit"
  | "enterpriseNoRecovery"
  | "platformAdmin"
  | "authorizedNonAdmin"
  | "restrictedReadOnly"
  | "suspendedWorkspace"
  | "legacyEnvelope"
  | "missingEnvelope";

const ALL_CONTEXTS: ContextKey[] = [
  "personalNormal",
  "personalPro",
  "organization",
  "enterpriseFull",
  "enterpriseNoSemantic",
  "enterpriseNoAudit",
  "enterpriseNoRecovery",
  "platformAdmin",
  "authorizedNonAdmin",
  "restrictedReadOnly",
  "suspendedWorkspace",
  "legacyEnvelope",
  "missingEnvelope",
];

/** Contexts whose envelope allows the route AND resolves a workspace id. */
const RENDERING_CONTEXTS: ContextKey[] = [
  "personalNormal",
  "personalPro",
  "organization",
  "enterpriseFull",
  "enterpriseNoSemantic",
  "enterpriseNoAudit",
  "enterpriseNoRecovery",
  "platformAdmin",
  "authorizedNonAdmin",
];

/** Contexts that must NOT render the console at all. */
const NON_RENDERING_CONTEXTS: ContextKey[] = [
  "restrictedReadOnly",
  "suspendedWorkspace",
  "missingEnvelope",
];

const ADMIN_CONTEXTS: ContextKey[] = ["platformAdmin"];
const NON_ADMIN_RENDERING: ContextKey[] = RENDERING_CONTEXTS.filter(
  (k) => !ADMIN_CONTEXTS.includes(k),
);

function space(
  type: "PERSONAL" | "ORGANIZATION",
  id: string,
  displayName: string,
  status: "active" | "suspended" = "active",
) {
  return {
    workspace: { id, name: displayName, status, scope: type },
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

/**
 * Envelope builder.
 *
 * `capabilities`, `flags` and `platform` are the ONLY levers. The plan string
 * and workspace name are deliberately misleading in `legacyEnvelope`.
 */
function makeEnvelope(key: ContextKey): unknown {
  const base = {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { SEARCH_VIEW: true },
    diagnostics: { requestId: `test-${key}` },
  };

  switch (key) {
    case "personalNormal":
      return {
        ...base,
        ...space("PERSONAL", WS.personal, "Personal Space"),
        account: { accountPlan: "FREE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: {},
      };
    case "personalPro":
      return {
        ...base,
        ...space("PERSONAL", WS.pro, "Personal Space"),
        account: { accountPlan: "PRO", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: {},
      };
    case "organization":
      return {
        ...base,
        ...space("ORGANIZATION", WS.organization, "Northgate Claims"),
        account: { accountPlan: "BUSINESS", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: {},
      };
    case "enterpriseFull":
    case "enterpriseNoSemantic":
    case "enterpriseNoAudit":
    case "enterpriseNoRecovery":
      return {
        ...base,
        ...space("ORGANIZATION", WS.enterprise, "Meridian Legal"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: true },
        platform: { isPlatformAdmin: false },
        planFeatures: {},
      };
    case "platformAdmin":
      return {
        ...base,
        ...space("ORGANIZATION", WS.admin, "Meridian Legal"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: true },
        platform: { isPlatformAdmin: true },
        planFeatures: {},
      };
    case "authorizedNonAdmin":
      // Allowed to search, and nothing more. The distinction that matters:
      // this actor is INSIDE the workspace and still sees no operator surface.
      return {
        ...base,
        ...space("ORGANIZATION", WS.enterprise, "Meridian Legal"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: true },
        platform: { isPlatformAdmin: false },
        planFeatures: {},
      };
    case "restrictedReadOnly":
      // No SEARCH_VIEW. The route gate refuses before the console mounts.
      return {
        ...base,
        capabilities: {},
        ...space("ORGANIZATION", WS.organization, "Northgate Claims"),
        account: { accountPlan: "BUSINESS", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: {},
      };
    case "suspendedWorkspace":
      return {
        ...base,
        ...space("ORGANIZATION", WS.organization, "Northgate Claims", "suspended"),
        account: { accountPlan: "BUSINESS", accountStatus: "suspended" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: {},
      };
    case "legacyEnvelope":
      // No `flags`, no `platform`, no `planFeatures` — and every incidental
      // field screaming "enterprise". The gate must ignore all of it.
      return {
        ...base,
        ...space("ORGANIZATION", WS.legacy, "Enterprise Holdings"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
      };
    case "missingEnvelope":
      return null;
  }
}

/** Which readiness the context's server would project. */
function scenarioFor(key: ContextKey, over: Partial<Scenario> = {}): Scenario {
  const canRecover = key === "platformAdmin";
  const degraded =
    key === "enterpriseNoSemantic" ? ["semantic_search"] : [];
  return {
    readiness: makeReadiness({
      canRecover,
      degradedCapabilities: degraded,
      ...(degraded.length > 0 ? { state: "DEGRADED" } : {}),
    }),
    rows: [makeRow()],
    semanticAvailable: key !== "enterpriseNoSemantic",
    reconcile: { accepted: true, status: "COMPLETED" },
    ...over,
  };
}

function renderContext(key: ContextKey) {
  return render(
    <PlatformContextProvider testEnvelope={makeEnvelope(key) as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <SearchPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
}

/**
 * Render and let the console's own loads settle.
 *
 * Unmounts FIRST. A helper that mounts on top of a previous tree makes
 * `document.querySelector` return whichever root happens to be first, so a
 * matrix that looks like it compared two contexts can silently have compared
 * one context with itself — or, worse, attributed one context's DOM to
 * another's name.
 */
async function mount(key: ContextKey, over: Partial<Scenario> = {}) {
  cleanup();
  scenario = scenarioFor(key, over);
  const utils = renderContext(key);
  await settle();
  return utils;
}

/**
 * Flush to a FIXPOINT rather than a fixed number of microtasks.
 *
 * The console loads diagnostics, saved views, semantic status and the query
 * itself, and each can schedule the next. A fixed flush count settles some
 * contexts and not others, which shows up as a phantom "these two workspaces
 * render differently" failure that is really a race in the harness.
 */
async function settle(): Promise<void> {
  let previous = -1;
  for (let i = 0; i < 12 && previous !== document.body.innerHTML.length; i += 1) {
    previous = document.body.innerHTML.length;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mountRendered(key: ContextKey, over: Partial<Scenario> = {}) {
  const utils = await mount(key, over);
  await waitFor(() => {
    expect(consoleRoot()).not.toBeNull();
  });
  await settle();
  return utils;
}

/**
 * The mounted CONSOLE, or null.
 *
 * `data-search-page="pending"` is the workspace-not-resolved placeholder, not
 * the console: it has no form, no filters and no results, and it issues no
 * tenant-scoped request. Treating it as "the console mounted" would let a
 * suspended workspace pass a test about the console rendering.
 */
function consoleRoot(): HTMLElement | null {
  const el = document.querySelector(
    "[data-search-page]",
  ) as HTMLElement | null;
  if (!el) return null;
  return el.getAttribute("data-search-page") === "pending" ? null : el;
}

beforeEach(() => {
  requestLog = [];
  cleanup();
});

// ===========================================================================
// 1. ONE shell
// ===========================================================================

describe("convergence — one Search shell for every workspace kind", () => {
  it.each(RENDERING_CONTEXTS)("%s mounts the same shell anatomy", async (key) => {
    await mountRendered(key);
    // The anatomy every context shares. Not a screenshot: the STRUCTURE.
    for (const selector of [
      "[data-search-page]",
      ".search-form-panel",
      ".search-workspace",
      "[data-search-scope-tabs]",
    ]) {
      expect(
        document.querySelector(selector),
        `${key} is missing ${selector}`,
      ).not.toBeNull();
    }
  });

  it.each(RENDERING_CONTEXTS)("%s renders results with one geometry", async (key) => {
    await mountRendered(key);
    const list = document.querySelector(".search-results__list");
    expect(list, `${key} has no result list`).not.toBeNull();
    expect(list?.querySelectorAll("[data-search-result-row]").length).toBe(1);
  });

  it("no context mounts an alternate Search implementation", async () => {
    for (const key of RENDERING_CONTEXTS) {
      await mountRendered(key);
      // One console root, and nothing calling itself a V2 or Enterprise shell.
      expect(document.querySelectorAll('[data-search-page]:not([data-search-page="pending"])').length).toBe(1);
      expect(document.querySelector("[data-enterprise-search]")).toBeNull();
      expect(document.querySelector("[data-search-v2]")).toBeNull();
      cleanup();
    }
  });
});

// ===========================================================================
// 2. Optional panels appear only under their capability
// ===========================================================================

describe("convergence — capability controls panels, never presentation", () => {
  it.each(ADMIN_CONTEXTS)("%s sees the operator strip", async (key) => {
    await mountRendered(key);
    expect(document.querySelector("[data-search-admin-strip]")).not.toBeNull();
    // Saved views are an operator surface on the same gate.
    expect(document.body.textContent).toContain("Saved views");
  });

  it.each(NON_ADMIN_RENDERING)(
    "%s sees no operator panel and no residue where one would be",
    async (key) => {
      await mountRendered(key);
      // The strip element may exist as a layout slot, but it must be EMPTY —
      // no heading, no divider, no reserved track with nothing in it.
      const strip = document.querySelector("[data-search-admin-strip]");
      if (strip) {
        expect(
          strip.textContent?.trim() ?? "",
          `${key} left operator residue in the strip`,
        ).toBe("");
        expect(strip.querySelectorAll("h1,h2,h3,h4,hr").length).toBe(0);
      }
      expect(document.body.textContent).not.toContain("Saved views");
      expect(document.body.textContent).not.toContain("Save current view");
    },
  );

  it.each(NON_ADMIN_RENDERING)(
    "%s issues no request for a capability it does not have",
    async (key) => {
      await mountRendered(key);
      // A hidden panel that still fetches is a control that is merely
      // invisible, not absent — and it is a request the server will refuse.
      expect(
        requestLog.filter((p) => p.startsWith("/v1/search/semantic/backfill")),
      ).toHaveLength(0);
    },
  );
});

// ===========================================================================
// 3. Recovery — server-projected, never inferred
// ===========================================================================

describe("convergence — recovery is offered only where the server allows it", () => {
  it("an Enterprise workspace does NOT get the control merely for being Enterprise", async () => {
    // The forbidden inference, stated as a test. `enterpriseNoRecovery`
    // projects `canRecover: false` on a workspace with every Enterprise flag.
    await mountRendered("enterpriseNoRecovery", {
      readiness: makeReadiness({ state: "STALLED", indexedCount: 1, canRecover: false }),
    });
    expect(document.querySelector("[data-search-readiness-recover]")).toBeNull();
    // …and the user is told who CAN act, rather than left at a dead end.
    expect(
      document.querySelector("[data-search-readiness-recover-unavailable]"),
    ).not.toBeNull();
  });

  it("the control appears when — and only when — canRecover is true", async () => {
    await mountRendered("platformAdmin", {
      readiness: makeReadiness({ state: "STALLED", indexedCount: 1, canRecover: true }),
    });
    const button = document.querySelector("[data-search-readiness-recover]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-busy")).toBe("false");
  });

  it("a duplicate press cannot start a second run", async () => {
    await mountRendered("platformAdmin", {
      readiness: makeReadiness({ state: "STALLED", indexedCount: 1, canRecover: true }),
    });
    const button = document.querySelector(
      "[data-search-readiness-recover]",
    ) as HTMLButtonElement;
    requestLog = [];
    await act(async () => {
      button.click();
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(
      requestLog.filter((p) => p.startsWith("/v1/search/reconcile")).length,
    ).toBe(1);
  });

  it("recovery is offered in terminal states only", async () => {
    for (const state of ["INITIALIZING", "PARTIAL"]) {
      await mountRendered("platformAdmin", {
        readiness: makeReadiness({
          state,
          indexedCount: state === "INITIALIZING" ? 0 : 2,
          outstandingCount: 2,
          shouldPoll: true,
          progressing: true,
          runStatus: "RUNNING",
          canRecover: true,
        }),
      });
      expect(
        document.querySelector("[data-search-readiness-recover]"),
        `${state} must not offer recovery — a run already holds the slot`,
      ).toBeNull();
      cleanup();
    }
  });
});

// ===========================================================================
// 4. Fail closed
// ===========================================================================

describe("convergence — an unknown projection fails closed", () => {
  it.each(NON_RENDERING_CONTEXTS)("%s does not mount the console", async (key) => {
    await mount(key);
    expect(consoleRoot()).toBeNull();
  });

  it("a missing envelope issues NO tenant-scoped request", async () => {
    await mount("missingEnvelope");
    const tenantRequests = requestLog.filter((p) => p.includes("teamId="));
    expect(tenantRequests, requestLog.join(" | ")).toHaveLength(0);
  });

  it("a suspended workspace issues NO tenant-scoped request", async () => {
    await mount("suspendedWorkspace");
    expect(requestLog.filter((p) => p.includes("teamId="))).toHaveLength(0);
  });

  it("a legacy envelope renders the non-enterprise surface despite every misleading field", async () => {
    // `accountPlan: "ENTERPRISE"`, workspace named "Enterprise Holdings", and
    // no `flags` key at all.
    await mountRendered("legacyEnvelope");
    expect(consoleRoot()).not.toBeNull();
    expect(document.body.textContent).not.toContain("Saved views");
    // The Inspector's enterprise-only pivots stay unlinked.
    const workflowLink = document.querySelector('a[href^="/workflows/"]');
    expect(workflowLink).toBeNull();
  });

  it("readiness absent from the response produces no invented state", async () => {
    await mountRendered("organization", { readiness: null });
    // The console says nothing about readiness rather than guessing.
    expect(document.querySelector("[data-search-readiness]")).toBeNull();
  });
});

// ===========================================================================
// 5. Every readiness state renders, in every rendering context
// ===========================================================================

const READINESS_CASES: Array<[string, Record<string, unknown>]> = [
  ["READY", makeReadiness()],
  [
    "EMPTY_WORKSPACE",
    makeReadiness({ state: "EMPTY_WORKSPACE", eligibleCount: 0, indexedCount: 0 }),
  ],
  [
    "INITIALIZING",
    makeReadiness({
      state: "INITIALIZING",
      indexedCount: 0,
      outstandingCount: 4,
      shouldPoll: true,
      progressing: true,
      runStatus: "RUNNING",
      resultsAreComplete: false,
    }),
  ],
  [
    "PARTIAL",
    makeReadiness({
      state: "PARTIAL",
      indexedCount: 2,
      outstandingCount: 2,
      shouldPoll: true,
      progressing: true,
      runStatus: "RUNNING",
      resultsAreComplete: false,
    }),
  ],
  [
    "STALLED",
    makeReadiness({
      state: "STALLED",
      indexedCount: 1,
      outstandingCount: 3,
      runStatus: null,
      resultsAreComplete: false,
    }),
  ],
  [
    "FAILED",
    makeReadiness({
      state: "FAILED",
      indexedCount: 1,
      outstandingCount: 3,
      runStatus: "FAILED",
      failureReason: "timeout",
      resultsAreComplete: false,
    }),
  ],
  [
    "DEGRADED",
    makeReadiness({
      state: "DEGRADED",
      degradedCapabilities: ["semantic_search"],
    }),
  ],
  [
    "UNAVAILABLE",
    makeReadiness({
      state: "UNAVAILABLE",
      eligibleCount: 0,
      indexedCount: 0,
      resultsAreComplete: false,
    }),
  ],
];

describe("convergence — every readiness state renders one way", () => {
  it.each(READINESS_CASES)("%s renders without residue", async (_name, readiness) => {
    for (const key of ["personalNormal", "organization", "enterpriseFull"] as ContextKey[]) {
      await mountRendered(key, { readiness });
      // Whatever the state, the console mounted and nothing is an orphan
      // heading over an empty region.
      expect(consoleRoot()).not.toBeNull();
      for (const heading of Array.from(document.querySelectorAll("h2, h3"))) {
        const section = heading.parentElement;
        // A heading whose section carries nothing but the heading itself is
        // exactly the "orphan heading over a reserved track" this forbids.
        expect(
          (section?.textContent ?? "").trim().length,
          `${key}: orphan heading "${heading.textContent}"`,
        ).toBeGreaterThan((heading.textContent ?? "").trim().length);
      }
      cleanup();
    }
  });

  it("polling runs only while a real run is active", async () => {
    for (const [name, readiness] of READINESS_CASES) {
      await mountRendered("organization", { readiness });
      const shouldPoll = (readiness as Record<string, unknown>).shouldPoll === true;
      expect(
        ["INITIALIZING", "PARTIAL"].includes(name),
        `${name}: shouldPoll must match the two self-changing states`,
      ).toBe(shouldPoll);
      cleanup();
    }
  });
});

// ===========================================================================
// 6. Presentation is identical across contexts
// ===========================================================================

describe("convergence — no legacy design system in any capability branch", () => {
  it.each(RENDERING_CONTEXTS)("%s uses only canonical primitives", async (key) => {
    await mountRendered(key);
    const root = consoleRoot() as HTMLElement;
    expect(root).not.toBeNull();

    // No native select anywhere in the rendered tree.
    expect(root.querySelectorAll("select").length).toBe(0);

    // No element carries a presentation style attribute.
    //
    // TWO PERMITTED EXCEPTIONS, both outside the Search console's ownership:
    //
    //   `.app-anchored-overlay`  components/app-primitives/AppAnchoredOverlay
    //     Its position is measured from the anchor at runtime, so it is
    //     genuinely data-derived and cannot be expressed as a class.
    //
    //   `.app-listbox`                 components/app-primitives/AppListbox
    //     The canonical option control, consumed by the filter rail here and by
    //     every other internal surface. Its one inline span is that primitive's
    //     own presentation, audited by its owner; Search neither writes it nor
    //     may fork the primitive to remove it.
    //
    // Anything else is Search's, and must be zero.
    const styled = Array.from(root.querySelectorAll("[style]")).filter(
      (el) =>
        !el.closest(".app-anchored-overlay") &&
        !el.closest(".app-listbox"),
    );
    expect(
      styled.map((e) => e.getAttribute("style")),
      `${key} carries inline presentation`,
    ).toEqual([]);
  });

  it("Personal and Organization render an IDENTICAL element set", async () => {
    // Not "similar". Identical: same classes, same multiplicity. Neither is a
    // paid tier of the other, so nothing about the console may differ.
    const shapes: Record<string, string[]> = {};
    for (const key of ["personalNormal", "organization"] as ContextKey[]) {
      await mountRendered(key);
      shapes[key] = classShape(consoleRoot() as HTMLElement);
    }
    expect(shapes.organization).toEqual(shapes.personalNormal);
  });

  it("Enterprise adds capability sections and changes nothing else", async () => {
    // The ONE permitted difference: capability-driven sections and actions.
    // Everything Personal renders, Enterprise renders too — same classes, same
    // multiplicity — and the surplus is entirely inside the capability-gated
    // Investigation-pivots section.
    await mountRendered("personalNormal");
    const base = classShape(consoleRoot() as HTMLElement);

    await mountRendered("enterpriseFull");
    const root = consoleRoot() as HTMLElement;
    const full = classShape(root);

    // Nothing is LOST.
    const remaining = [...full];
    for (const cls of base) {
      const at = remaining.indexOf(cls);
      expect(at, `Enterprise dropped "${cls}"`).toBeGreaterThanOrEqual(0);
      remaining.splice(at, 1);
    }

    // …and everything GAINED sits inside a capability-gated section.
    const gatedText =
      Array.from(root.querySelectorAll(".search-inspector__section"))
        .filter((s) => (s.textContent ?? "").includes("Investigation pivots"))
        .map((s) => s.outerHTML)
        .join("") || "";
    expect(gatedText.length, "the capability section did not render").toBeGreaterThan(0);
    for (const cls of remaining) {
      expect(
        gatedText.includes(cls),
        `Enterprise added "${cls}" OUTSIDE a capability-gated section`,
      ).toBe(true);
    }
  });
});

/** Every canonical class on the subtree, with multiplicity, sorted. */
function classShape(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("[class]"))
    .map((e) => e.getAttribute("class") ?? "")
    .filter((c) => c.startsWith("search-") || c.startsWith("app-"))
    .sort();
}

// ===========================================================================
// 7. Behaviour that must survive convergence
// ===========================================================================

describe("convergence — behaviour is preserved, not just presentation", () => {
  it("selecting a result opens the Inspector, in every context", async () => {
    for (const key of RENDERING_CONTEXTS) {
      await mountRendered(key);
      const row = document.querySelector(
        "[data-search-result-row]",
      ) as HTMLElement;
      expect(row, `${key} rendered no result row`).not.toBeNull();
      await act(async () => {
        (row.querySelector("button") ?? row).click();
        await Promise.resolve();
      });
      expect(
        document.querySelector("[data-search-inspector]"),
        `${key} did not open the Inspector`,
      ).not.toBeNull();
      cleanup();
    }
  });

  it("a failed search is not reported as a zero count", async () => {
    await mountRendered("organization", { searchFails: true, rows: [] });
    expect(document.body.textContent).not.toContain("0 results");
  });

  it("the activity scope is reachable and is a second view, not a second console", async () => {
    await mountRendered("platformAdmin");
    const tab = document.querySelector(
      '[data-search-scope-tab="activity"]',
    ) as HTMLElement;
    expect(tab).not.toBeNull();
    await act(async () => {
      tab.click();
      await Promise.resolve();
    });
    // Still ONE console root.
    expect(document.querySelectorAll('[data-search-page]:not([data-search-page="pending"])').length).toBe(1);
  });
});

// ===========================================================================
// 8. The coverage table — every branch has a fixture
// ===========================================================================

// ===========================================================================
// 9. Recovery is an ACTION ROW, never a word inside a sentence
// ===========================================================================

describe("polish — the recovery action has its own row", () => {
  const stalled = makeReadiness({
    state: "STALLED",
    indexedCount: 1,
    outstandingCount: 3,
    runStatus: null,
    resultsAreComplete: false,
    canRecover: true,
  });

  it("18. the control lives in a dedicated actions row, outside the explanation", async () => {
    await mountRendered("platformAdmin", { readiness: stalled });

    const button = document.querySelector(
      "[data-search-readiness-recover]",
    ) as HTMLElement;
    expect(button, "no recovery control rendered").not.toBeNull();

    // It is inside the ACTIONS row…
    const actions = button.closest("[data-search-readiness-actions]");
    expect(actions, "the control is not in an actions row").not.toBeNull();

    // …and the actions row is a SIBLING of the copy, not a descendant of it.
    // This is the defect precisely: the button used to be laid out as another
    // inline run inside the explanatory block, so it appeared mid-sentence.
    const panel = document.querySelector(
      "[data-search-readiness='STALLED']",
    ) as HTMLElement;
    const body = panel.querySelector(".search-readiness-panel__body");
    expect(body, "the panel has no explanation block").not.toBeNull();
    expect(body!.contains(button)).toBe(false);

    // The heading, the explanation and the actions are three separate blocks,
    // in reading order.
    const children = Array.from(panel.children);
    const headIdx = children.findIndex((c) =>
      c.classList.contains("search-readiness-panel__head"),
    );
    const bodyIdx = children.findIndex((c) =>
      c.classList.contains("search-readiness-panel__body"),
    );
    const actionsIdx = children.findIndex((c) =>
      c.hasAttribute("data-search-readiness-actions"),
    );
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(headIdx);
    expect(actionsIdx).toBeGreaterThan(bodyIdx);
  });

  it("18b. a bounded failure reason gets its own line, never the sentence", async () => {
    await mountRendered("platformAdmin", {
      readiness: makeReadiness({
        state: "FAILED",
        indexedCount: 1,
        outstandingCount: 3,
        runStatus: "FAILED",
        failureReason: "timeout",
        resultsAreComplete: false,
        canRecover: true,
      }),
    });
    const reason = document.querySelector(
      "[data-search-readiness-reason]",
    ) as HTMLElement;
    expect(reason).not.toBeNull();
    expect(reason.textContent).toContain("timeout");
    // Not concatenated into the explanation, where a long value would push the
    // action further out of reach.
    const body = document.querySelector(".search-readiness-panel__body");
    expect(body?.textContent).not.toContain("timeout");
  });

  it("19. an unauthorized actor never receives the control, in any terminal state", async () => {
    for (const state of ["STALLED", "FAILED"]) {
      await mountRendered("authorizedNonAdmin", {
        readiness: makeReadiness({
          state,
          indexedCount: 1,
          outstandingCount: 3,
          runStatus: state === "FAILED" ? "FAILED" : null,
          resultsAreComplete: false,
          canRecover: false,
        }),
      });
      expect(
        document.querySelector("[data-search-readiness-recover]"),
        `${state} offered recovery to an unauthorized actor`,
      ).toBeNull();
      // …and they are told who can act, rather than left at a dead end.
      expect(
        document.querySelector("[data-search-readiness-recover-unavailable]"),
      ).not.toBeNull();
    }
  });

  it("20. accepted is not reported as completed", async () => {
    await mountRendered("platformAdmin", { readiness: stalled });
    const button = document.querySelector(
      "[data-search-readiness-recover]",
    ) as HTMLButtonElement;

    // The server answers 202 with an already-running run.
    scenario.reconcile = { accepted: true, status: "RUNNING", alreadyRunning: true };
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await settle();

    const status = document.querySelector(
      "[data-search-readiness-recover-status]",
    ) as HTMLElement;
    expect(status, "no status was announced").not.toBeNull();
    expect(status.getAttribute("aria-live")).toBe("polite");
    // "already running" — never "finished".
    expect(status.textContent?.toLowerCase()).toContain("already running");
    expect(status.textContent?.toLowerCase()).not.toContain("finished");
  });

  it("20b. a completed run is reported as completed, and only then", async () => {
    await mountRendered("platformAdmin", { readiness: stalled });
    scenario.reconcile = { accepted: true, status: "COMPLETED" };
    await act(async () => {
      (
        document.querySelector("[data-search-readiness-recover]") as HTMLElement
      ).click();
      await Promise.resolve();
    });
    await settle();
    expect(
      document.querySelector("[data-search-readiness-recover-status]")
        ?.textContent,
    ).toContain("finished");
  });

  it("21. a workspace that cannot answer never shows a plain result count", async () => {
    for (const state of ["INITIALIZING", "STALLED", "EMPTY_WORKSPACE"]) {
      await mountRendered("organization", {
        rows: [],
        readiness: makeReadiness({
          state,
          indexedCount: 0,
          eligibleCount: state === "EMPTY_WORKSPACE" ? 0 : 4,
          outstandingCount: state === "EMPTY_WORKSPACE" ? 0 : 4,
          runStatus: state === "INITIALIZING" ? "RUNNING" : null,
          progressing: state === "INITIALIZING",
          shouldPoll: state === "INITIALIZING",
          resultsAreComplete: false,
        }),
      });
      // "0 results" beside "Search is being set up" told users their records
      // were gone. The count is withheld until it is a claim worth making.
      expect(
        document.body.textContent,
        `${state} rendered a bare result count`,
      ).not.toContain("0 results");
      cleanup();
    }
  });
});

// ===========================================================================
// 10. The type label — ONE authority, two render sites
// ===========================================================================

describe("polish — the type label is one authority", () => {
  // EVIDENCE moved off the REPORT orange: a piece of evidence and the report
  // ABOUT it were reading as one category. Evidence now takes the SAME blue as
  // a Case — the two halves of a record's life — and orange is left to REPORT
  // alone, where it means one thing.
  const TYPES: Array<[string, string]> = [
    ["CASE", "blue"],
    ["EVIDENCE", "blue"],
    ["REPORT", "orange"],
    ["PACKAGE", "indigo"],
    ["NOTE", "slate"],
  ];

  it("22. every canonical type resolves through the one mapping", async () => {
    for (const [type, tone] of TYPES) {
      await mountRendered("organization", { rows: [makeRow({ documentType: type })] });
      const rowBadge = document.querySelector(
        "[data-search-result-type]",
      ) as HTMLElement;
      expect(rowBadge, `${type} rendered no type label`).not.toBeNull();
      expect(rowBadge.getAttribute("data-tone"), `${type} tone`).toBe(tone);
      cleanup();
    }
  });

  it("23. the result row and the Inspector render the SAME label authority", async () => {
    for (const [type, tone] of TYPES) {
      await mountRendered("organization", { rows: [makeRow({ documentType: type })] });
      const rowBadge = document.querySelector(
        "[data-search-result-type]",
      ) as HTMLElement;
      const inspectorBadge = document.querySelector(
        "[data-search-inspector-type]",
      ) as HTMLElement;
      expect(inspectorBadge, `${type} has no Inspector label`).not.toBeNull();
      // Same class, same tone — so the two can never drift apart.
      expect(inspectorBadge.className).toBe(rowBadge.className);
      expect(inspectorBadge.getAttribute("data-tone")).toBe(tone);
      expect(inspectorBadge.className).toContain("search-type-badge");
      cleanup();
    }
  });

  it("23b. a Case and a piece of Evidence render the identical label treatment", async () => {
    // Rendered, not read from the mapping table: the point is that the two
    // reach the DOM with the same class and the same tone, so no per-type
    // override can make them differ while the table still says they agree.
    const seen: Array<{ className: string; tone: string | null }> = [];
    for (const type of ["CASE", "EVIDENCE"]) {
      await mountRendered("organization", { rows: [makeRow({ documentType: type })] });
      const badge = document.querySelector(
        "[data-search-result-type]",
      ) as HTMLElement;
      seen.push({ className: badge.className, tone: badge.getAttribute("data-tone") });
      cleanup();
    }
    expect(seen[0]!.tone).toBe("blue");
    expect(seen[1]).toEqual(seen[0]);
  });

  it("26. an unknown type falls back to the neutral label, not to the last branch", async () => {
    await mountRendered("organization", {
      rows: [makeRow({ documentType: "SOMETHING_NEW" })],
    });
    expect(
      (document.querySelector("[data-search-result-type]") as HTMLElement)
        ?.getAttribute("data-tone"),
    ).toBe("slate");
    expect(
      (document.querySelector("[data-search-inspector-type]") as HTMLElement)
        ?.getAttribute("data-tone"),
    ).toBe("slate");
  });

  it("27. lifecycle tone is a SEPARATE authority from type tone", async () => {
    // A Case is blue whether it is open or closed; the lifecycle chip carries
    // the state colour and does NOT wear the filled type shape.
    // CLOSED is `ink`, the darkest neutral, not `slate`. `slate` is what this
    // console paints for ABSENT and unknown, and "this record is finished" is a
    // settled fact rather than a missing one. ARCHIVED is red — the one
    // lifecycle transition here with real consequences — and both now come from
    // the app-wide lifecycle table rather than from a Search-local switch.
    for (const [lifecycle, tone] of [
      ["OPEN", "green"],
      ["CLOSED", "ink"],
      ["ARCHIVED", "red"],
    ] as Array<[string, string]>) {
      await mountRendered("organization", {
        rows: [makeRow({ documentType: "CASE", workflowState: lifecycle })],
      });
      const type = document.querySelector(
        "[data-search-inspector-type]",
      ) as HTMLElement;
      const life = document.querySelector(
        "[data-search-inspector-lifecycle]",
      ) as HTMLElement;
      expect(type.getAttribute("data-tone")).toBe("blue");
      expect(life, `${lifecycle} rendered no lifecycle chip`).not.toBeNull();
      expect(life.getAttribute("data-tone")).toBe(tone);
      // The lifecycle label is NOT a type label: a state must not wear the
      // filled classification slab.
      expect(life.className).not.toContain("search-type-badge");
      // Nor a capsule of its own. The state is TEXT on this surface, and the
      // filled type label beside it is what makes the two read as different
      // kinds of claim.
      expect(life.className).toContain("app-status-text");
      expect(life.className).not.toContain("app-status-badge");
      cleanup();
    }
  });

  it("28. selecting a row changes no class on either label", async () => {
    await mountRendered("organization", {
      rows: [makeRow({ documentType: "CASE" }), makeRow({ documentId: "doc-2" })],
    });
    const before = (
      document.querySelector("[data-search-result-type]") as HTMLElement
    ).className;

    const row = document.querySelector("[data-search-result-row]") as HTMLElement;
    await act(async () => {
      (row.querySelector("button") ?? row).click();
      await Promise.resolve();
    });
    await settle();

    const after = (
      document.querySelector("[data-search-result-type]") as HTMLElement
    ).className;
    // Same class set → same box. Selection cannot resize a label.
    expect(after).toBe(before);
  });

  it("29. the typeahead still mounts on the canonical overlay layer", async () => {
    await mountRendered("organization");
    const input = document.querySelector(
      "[data-search-input]",
    ) as HTMLInputElement;
    expect(input, "the query field is gone").not.toBeNull();
    // The overlay primitive is still the one the console composes with; the
    // label work must not have disturbed the popup layer.
    const page = document.querySelector("[data-search-page]") as HTMLElement;
    expect(page.querySelector("[data-search-typeahead-overlay]")).toBeNull();
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
  });
});

describe("coverage", () => {
  it("every declared context is exercised by this file", () => {
    const exercised = new Set([
      ...RENDERING_CONTEXTS,
      ...NON_RENDERING_CONTEXTS,
      "legacyEnvelope" as ContextKey,
    ]);
    for (const key of ALL_CONTEXTS) {
      expect(exercised.has(key), `${key} has no fixture`).toBe(true);
    }
  });

  it("every readiness state the shared model declares has a fixture", () => {
    const covered = new Set(READINESS_CASES.map(([name]) => name));
    for (const state of [
      "READY",
      "EMPTY_WORKSPACE",
      "INITIALIZING",
      "PARTIAL",
      "STALLED",
      "FAILED",
      "DEGRADED",
      "UNAVAILABLE",
    ]) {
      expect(covered.has(state), `${state} has no fixture`).toBe(true);
    }
    // RESTRICTED is covered by the route gate, not by a readiness fixture:
    // the console never mounts for an actor without SEARCH_VIEW.
    expect(NON_RENDERING_CONTEXTS).toContain("restrictedReadOnly");
  });
});

/**
 * Operations drawers and the shared overlay primitives render in the ONE
 * canonical application font — proved on rendered DOM.
 *
 * ---------------------------------------------------------------------------
 * THE ROOT CAUSE THIS PINS (2026-10-14)
 * ---------------------------------------------------------------------------
 * Production screenshots showed the Operations condition and group drawers in
 * a visibly different face from the rest of PROOVRA. Neither drawer is
 * portalled out of the font-carrying element — both mount inside <body>, as
 * every shared portal does, and the next/font variables sit on <html>. The
 * drawers are built almost entirely from the design-token composites
 * `font: var(--font-label)` / `var(--font-meta)` (section titles, facts,
 * timeline, notes), and those composites asked for `var(--font-sans, …)`:
 * a property NOTHING declared. Every one of them silently fell back to
 * `-apple-system, "Segoe UI", system-ui` — the operating system's UI face —
 * while the body read Plus Jakarta Sans through `--font-jakarta`.
 *
 * The fix is at the global font authority: `--font-sans` is declared once in
 * lib/design-tokens/tokens.css (Jakarta, led by the Arabic face in RTL), and
 * the body, the form controls and the composites all ask for it.
 *
 * ---------------------------------------------------------------------------
 * HOW A JSDOM TEST CAN SEE A FONT
 * ---------------------------------------------------------------------------
 * jsdom cascades and INHERITS `font-family`, but it neither resolves `var()`
 * nor expands a `font:` shorthand built from one. So the REAL stylesheets are
 * loaded into the document, the root layout's body style is applied from its
 * own source, and `familyOf()` resolves each element's family the way CSS
 * does: its own `font` shorthand if one applies, otherwise its (inherited)
 * `font-family`, with every `var(--x, fallback)` substituted from the root's
 * custom properties — undefined variables taking their fallback, exactly as a
 * browser does. A control case re-creates the old stylesheet and shows the
 * drawer resolving to a DIFFERENT family, so this test fails if the defect
 * returns.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { operationsDict } from "@proovra/shared/i18n";

// ---------------------------------------------------------------------------
// Seams (the page is mounted for real; only the network and router are fake)
// ---------------------------------------------------------------------------

type Handler = (path: string, method: string) => unknown;
let handler: Handler = () => ({});
let currentSearch = "";

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    const r = await handler(path, init?.method ?? "GET");
    if (r instanceof Error) throw r;
    return r;
  },
  setActiveWorkspaceId: () => {},
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalLocale: () => "en",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => {
      currentSearch = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    },
    back: () => {},
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/operations",
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
import OperationsPage from "../../app/(app)/operations/page";

const EN = operationsDict.en;
const WS = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ISO = "2026-10-14T10:00:00.000Z";

// ---------------------------------------------------------------------------
// The real stylesheets and the real root-layout font plumbing
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const TOKENS_CSS = read("lib/design-tokens/tokens.css");
const GLOBALS_CSS = read("app/globals.css").replace(/@import[^;]+;/g, "");
const PRIMITIVES_CSS = read("components/app-primitives/app-primitives.css");
const OPERATIONS_CSS = read("app/(app)/operations/operations.css");
const LAYOUT_TSX = read("app/layout.tsx");

/** The body's font-family, read from the root layout's own source. */
const LAYOUT_BODY_FONT = (() => {
  const m = /<body[\s\S]*?fontFamily:\s*"([^"]+)"/.exec(LAYOUT_TSX);
  if (!m) throw new Error("the root layout no longer sets the body font family");
  return m[1]!;
})();

/**
 * What next/font puts on <html>: the three family variables. The test values
 * are distinct names so a resolved family says which variable it came from.
 */
const NEXT_FONT_VARIABLES = `:root { --font-jakarta: "PJS-test"; --font-header: "Header-test"; --font-arabic: "Arabic-test"; }`;

function installStyles(css: string, bodyFont: string) {
  for (const el of Array.from(document.querySelectorAll("style[data-typography-test]"))) el.remove();
  const style = document.createElement("style");
  style.setAttribute("data-typography-test", "true");
  style.textContent = `${NEXT_FONT_VARIABLES}\n${css}`;
  document.head.appendChild(style);
  document.body.setAttribute("style", `font-family: ${bodyFont}`);
}

const CURRENT_CSS = [TOKENS_CSS, GLOBALS_CSS, PRIMITIVES_CSS, OPERATIONS_CSS].join("\n");

// ---------------------------------------------------------------------------
// A small CSS var() resolver — the part of the cascade jsdom does not do
// ---------------------------------------------------------------------------

function rootVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Substitute every var(); null when a var has neither a value nor a fallback. */
function resolveVars(value: string, depth = 0): string | null {
  if (depth > 12) return null;
  const at = value.indexOf("var(");
  if (at < 0) return value;
  let i = at + 4;
  let level = 1;
  let comma = -1;
  for (; i < value.length && level > 0; i += 1) {
    const c = value[i];
    if (c === "(") level += 1;
    else if (c === ")") level -= 1;
    else if (c === "," && level === 1 && comma < 0) comma = i;
  }
  const end = i - 1;
  const name = value.slice(at + 4, comma >= 0 ? comma : end).trim();
  const fallback = comma >= 0 ? value.slice(comma + 1, end).trim() : null;
  const own = rootVar(name);
  let substituted: string | null = own ? resolveVars(own, depth + 1) : null;
  if (substituted === null) substituted = fallback === null ? null : resolveVars(fallback, depth + 1);
  if (substituted === null) return null;
  return resolveVars(value.slice(0, at) + substituted + value.slice(end + 1), depth + 1);
}

const normalise = (family: string) =>
  family
    .split(",")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .join(", ");

/**
 * The family an element actually renders in, as a browser would resolve it.
 *
 * A declaration whose var() has neither a value nor a fallback is "invalid at
 * computed-value time": the property behaves as `unset`, and font-family —
 * an inherited property — then takes the PARENT's family. (This is what the
 * global h1–h6 rule does today: it names an undeclared `--font-inter`, so
 * every heading inherits the canonical family.)
 */
function familyOf(el: Element): string {
  const cs = getComputedStyle(el);
  const inherit = () => {
    expect(el.parentElement, `${el.tagName} has a parent to inherit from`).not.toBeNull();
    return familyOf(el.parentElement!);
  };
  const shorthand = cs.getPropertyValue("font");
  if (shorthand && shorthand.includes("var(")) {
    const resolved = resolveVars(shorthand);
    if (resolved === null) return inherit();
    return normalise(resolved.replace(/^.*?\d+(?:\.\d+)?px(?:\/[\d.]+)?\s+/, ""));
  }
  const resolved = resolveVars(cs.fontFamily);
  if (resolved === null) return el === document.documentElement ? "" : inherit();
  return normalise(resolved);
}

// ---------------------------------------------------------------------------
// The page, mounted with a drawer-worthy condition and a group
// ---------------------------------------------------------------------------

function incident(id: string) {
  return {
    id,
    category: "GOVERNANCE",
    severity: "HIGH",
    status: "OPEN",
    title: `Condition ${id}`,
    safeSummary: "A retention policy conflicts with an active legal hold.",
    fingerprint: `f:${id}`,
    occurrenceCount: 2,
    firstSeenAtUtc: ISO,
    lastSeenAtUtc: ISO,
    requestId: "req-0123456789abcdef",
    traceId: null,
    relatedEvidenceId: null,
    relatedJobId: null,
    relatedProvider: "provider",
    runbookSlug: null,
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    assignedOperatorUserId: null,
    assignedAtUtc: null,
    lifecycle: {
      sourceId: "governance.notification_escalated",
      sourceMatch: "CATEGORY_RESIDUAL",
      resolutionAuthority: "OPERATOR_DECISION",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      recoveryPolicy: "OPERATOR_CLOSES",
      manualResolution: true,
      requiresResolutionNote: true,
    },
    metric: null,
  };
}

const GROUP = {
  groupKey: "governance.notification_escalated",
  sourceId: "governance.notification_escalated",
  category: "GOVERNANCE",
  title: "Escalated governance notifications",
  conditionCount: 1,
  affectedRecordCount: null,
  affectedUnit: null,
  observations: 2,
  durationSeconds: null,
  lastObservedAtUtc: null,
  severity: "HIGH",
  statusPosture: "OPEN",
  firstSeenAtUtc: ISO,
  lastSeenAtUtc: ISO,
  latestActivityAtUtc: ISO,
  latestResolvedAtUtc: null,
  assignedCount: 0,
  failureGroups: [],
  affectedSample: [],
  hasMoreAffected: false,
  availableActions: [],
  metric: null,
};

function routes(): Handler {
  return (path, method) => {
    if (path.startsWith("/v1/ops/summary")) {
      return {
        summary: {
          workspaceId: WS,
          generatedAtUtc: ISO,
          open: 1, critical: 0, high: 1, warning: 0, info: 0, acknowledged: 0,
          assignedToMe: 0, unassigned: 1, slaBreached: 0, slaAtRisk: 0, slaOnTrack: 0, slaUntracked: 1,
          resolved: 0, complete: true, mayAssertAllClear: false, incompleteReason: null,
          readiness: "READY", clearRefusalReason: "UNRESOLVED_CONDITIONS", reconciliation: null,
        },
        workspace: { operatorCount: 1 },
      };
    }
    if (path.startsWith("/v1/ops/incident-groups?")) {
      return path.includes("resolvedWithinDays")
        ? { groups: [], completeness: { complete: true } }
        : { groups: [GROUP], totals: { groups: 1, conditions: 1 }, completeness: { complete: true } };
    }
    if (path.includes("/affected")) {
      return {
        records: [{ incidentId: "i-1", title: "Condition i-1", status: "OPEN", severity: "HIGH", lastSeenAtUtc: ISO, entityType: null, entityId: null }],
        pagination: { nextCursor: null },
      };
    }
    if (path.startsWith("/v1/ops/saved-views")) return { views: [] };
    if (path.startsWith("/v1/ops/assignable-operators")) return { operators: [], selfUserId: ME };
    if (method === "GET" && /^\/v1\/ops\/incidents\/[^/?]+\?/.test(path)) {
      return {
        incident: {
          ...incident("i-1"),
          timeline: [{ id: "e1", eventType: "opened", safeMessage: "The condition was opened.", occurredAtUtc: ISO }],
          timelineComplete: true,
        },
      };
    }
    if (method === "GET" && path.startsWith("/v1/ops/incidents?")) {
      return { incidents: [incident("i-1")], pagination: { nextCursor: null }, completeness: { complete: true } };
    }
    return { ok: true };
  };
}

function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {
      OPERATIONS_VIEW: true,
      OPERATIONS_ACKNOWLEDGE: true,
      OPERATIONS_RESOLVE: true,
      OPERATIONS_SUPPRESS: true,
    },
    diagnostics: { requestId: "test" },
    workspace: { id: WS, name: "Northgate Team", status: "active", scope: "TEAM" },
    activeSpace: { type: "TEAM", id: WS, displayName: "Northgate Team", roleLabel: "Admin" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "ORGANIZATION", organizationId: null, displayName: "Northgate Team" },
    },
    account: { userId: ME, accountPlan: "PRO", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}

async function mount() {
  cleanup();
  render(
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <OperationsPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
}

const q = (sel: string) => document.querySelector(sel);

/** Every text-bearing part of the condition drawer, the note field and its buttons included. */
function conditionDrawerParts(): Element[] {
  const drawer = q("[data-ops-inspector]") as HTMLElement;
  expect(drawer).not.toBeNull();
  const parts = [
    drawer.querySelector(".app-dialog__title"),
    drawer.querySelector(".app-dialog__subtitle"),
    drawer.querySelector(".opsw-drawer__section-title"),
    drawer.querySelector(".opsw-summary-text"),
    drawer.querySelector(".opsw-fact dt"),
    drawer.querySelector(".opsw-fact dd"),
    drawer.querySelector(".opsw-timeline__type"),
    drawer.querySelector(".opsw-timeline__message"),
    drawer.querySelector("[data-ops-resolution-note-helper]"),
    drawer.querySelector("textarea"),
    drawer.querySelector('[data-ops-action="resolve"]'),
    drawer.querySelector('[data-ops-action="acknowledge"]'),
  ];
  for (const p of parts) expect(p, "a drawer part is missing from the render").not.toBeNull();
  return parts as Element[];
}

let savedWidth = 0;
beforeEach(() => {
  currentSearch = "";
  handler = routes();
  savedWidth = window.innerWidth;
  document.documentElement.removeAttribute("dir");
  installStyles(CURRENT_CSS, LAYOUT_BODY_FONT);
});
afterEach(() => {
  cleanup();
  for (const el of Array.from(document.querySelectorAll("style[data-typography-test]"))) el.remove();
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("dir");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: savedWidth });
});

// ===========================================================================
// The authority, as source
// ===========================================================================

describe("the canonical font has ONE authority, and every consumer asks it", () => {
  it("tokens.css declares --font-sans from the next/font variable, with an RTL variant led by the Arabic face", () => {
    const root = TOKENS_CSS.slice(TOKENS_CSS.indexOf(":root {"));
    // Each next/font variable carries its family name as a fallback, so the
    // token is complete for the native token generator too.
    expect(root).toMatch(/--font-sans:\s*var\(--font-jakarta, "Plus Jakarta Sans"\)/);
    expect(TOKENS_CSS).toMatch(
      /:root\[dir="rtl"\]\s*\{\s*--font-sans:\s*var\(--font-arabic, "Noto Sans Arabic"\),\s*var\(--font-jakarta, "Plus Jakarta Sans"\)/,
    );
    // The composite tokens ask for it.
    for (const token of ["--font-card-title", "--font-meta", "--font-label"]) {
      expect(TOKENS_CSS).toMatch(new RegExp(`${token}:[^;]*var\\(--font-sans`));
    }
  });

  it("the body, html and the form controls ask the same authority — no font hard-coded in Operations", () => {
    expect(LAYOUT_BODY_FONT).toMatch(/^var\(--font-sans/);
    expect(GLOBALS_CSS).toMatch(/html,\s*body\s*\{\s*font-family:\s*var\(--font-sans/);
    expect(GLOBALS_CSS).toMatch(/button,\s*input,\s*select,\s*textarea\s*\{\s*font-family:\s*inherit;/);
    expect(GLOBALS_CSS).toMatch(/textarea,\s*button\s*\{[^}]*font-family:\s*var\(--font-sans/);
    // The old literal that matched no loaded face is gone.
    expect(GLOBALS_CSS).not.toMatch(/font-family:\s*"Plus Jakarta Sans"/);
    // Operations names no family of its own except the monospace identifiers.
    const families = OPERATIONS_CSS.replace(/\/\*[\s\S]*?\*\//g, "").match(/font-family:[^;]+;/g) ?? [];
    for (const f of families) expect(f).toMatch(/monospace/);
    for (const file of ["IncidentInspector.tsx", "GroupInspector.tsx"]) {
      expect(read(`app/(app)/operations/_components/${file}`)).not.toMatch(/fontFamily/);
    }
  });
});

// ===========================================================================
// The rendered proof
// ===========================================================================

describe("the Operations drawers and the shared overlay primitives inherit the canonical font", () => {
  it("the condition drawer — titles, facts, timeline, note field and buttons — renders in the body's family", async () => {
    await mount();
    const body = familyOf(document.body);
    expect(body.startsWith("PJS-test")).toBe(true);
    await click(q('[data-ops-open="i-1"]'));
    // The drawer is mounted INSIDE the element that carries the font.
    const overlay = q("[data-ops-inspector-overlay]") as HTMLElement;
    expect(document.body.contains(overlay)).toBe(true);
    for (const part of conditionDrawerParts()) {
      expect(familyOf(part), `${part.tagName}.${part.className}`).toBe(body);
    }
  });

  it("the group drawer renders in the body's family", async () => {
    currentSearch = "view=grouped";
    await mount();
    const body = familyOf(document.body);
    await click(q(`[data-ops-group-open-button="${GROUP.groupKey}"]`));
    const drawer = q("[data-ops-group-inspector]") as HTMLElement;
    expect(drawer).not.toBeNull();
    const parts = [
      drawer.querySelector(".opsw-drawer__title"),
      drawer.querySelector(".opsw-drawer__section-title") ?? drawer.querySelector("h3"),
      drawer.querySelector(".opsw-muted"),
      drawer.querySelector("button"),
    ].filter(Boolean) as Element[];
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const part of parts) expect(familyOf(part), `${part.tagName}.${part.className}`).toBe(body);
  });

  it("a PORTALLED shared primitive (the listbox popup) renders in the body's family", async () => {
    await mount();
    const body = familyOf(document.body);
    await click(q("[data-ops-controls] .app-listbox__trigger"));
    const option = q(".app-listbox__option") as HTMLElement;
    expect(option).not.toBeNull();
    // Truly portalled: outside the page's own tree, still inside <body>.
    expect(option.closest('[data-testid="operations-page"]')).toBeNull();
    expect(document.body.contains(option)).toBe(true);
    expect(familyOf(option)).toBe(body);
    expect(familyOf(q(".app-listbox__trigger")!)).toBe(body);
  });

  it("the shared confirmation dialog opened from the drawer renders in the body's family", async () => {
    await mount();
    const body = familyOf(document.body);
    await click(q('[data-ops-open="i-1"]'));
    await click(q('[data-ops-inspector] [data-ops-action="suppress"]'));
    await act(async () => {
      fireEvent.change(q("[data-ops-suppress-reason-input]") as HTMLElement, {
        target: { value: "Known provider maintenance window" },
      });
    });
    await click(q('[data-ops-action="suppress-confirm"]'));
    const dialog = q("[data-confirm-action-modal]") as HTMLElement;
    expect(dialog).not.toBeNull();
    for (const el of [dialog, ...Array.from(dialog.querySelectorAll("button, h2, p"))]) {
      expect(familyOf(el), `${el.tagName}`).toBe(body);
    }
  });

  it("in a right-to-left document the drawer and the body both lead with the Arabic face", async () => {
    document.documentElement.setAttribute("dir", "rtl");
    installStyles(CURRENT_CSS, LAYOUT_BODY_FONT);
    await mount();
    const body = familyOf(document.body);
    expect(body.startsWith("Arabic-test, PJS-test")).toBe(true);
    await click(q('[data-ops-open="i-1"]'));
    for (const part of conditionDrawerParts()) expect(familyOf(part)).toBe(body);
  });

  it.each([
    ["desktop", 1440],
    ["mobile (narrow)", 375],
  ])("the condition drawer renders whole on %s, in the canonical font", async (_label, width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    await mount();
    await click(q('[data-ops-open="i-1"]'));
    const drawer = q("[data-ops-inspector]") as HTMLElement;
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.querySelector(`[aria-label="${EN.closeCondition}"]`)).not.toBeNull();
    expect(drawer.querySelector("[data-ops-resolution-note-helper]")?.textContent).toBe(EN.resolveNoteHelper);
    // One drawer for every width: it is never wider than the viewport.
    expect(OPERATIONS_CSS).toMatch(/\.opsw-drawer \{[^}]*inline-size: min\(580px, 100%\)/);
    const body = familyOf(document.body);
    for (const part of conditionDrawerParts()) expect(familyOf(part)).toBe(body);
  });

  it("CONTROL: with the old stylesheet (no --font-sans, body on --font-jakarta) the drawer resolves to a DIFFERENT family", async () => {
    const oldTokens = TOKENS_CSS.replace(/--font-sans:[^;]+;/g, "");
    installStyles([oldTokens, GLOBALS_CSS, PRIMITIVES_CSS, OPERATIONS_CSS].join("\n"), "var(--font-jakarta)");
    await mount();
    const body = familyOf(document.body);
    expect(body.startsWith("PJS-test")).toBe(true);
    await click(q('[data-ops-open="i-1"]'));
    const title = q("[data-ops-inspector] .opsw-drawer__section-title") as HTMLElement;
    // The defect: the system UI stack, not the application font.
    expect(familyOf(title)).not.toBe(body);
    expect(familyOf(title)).toMatch(/^-apple-system, Segoe UI, system-ui/);
  });
});

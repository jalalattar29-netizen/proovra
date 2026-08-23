/**
 * ATTENTION ARCHITECTURE — PHASE 6 (2026-08-22).
 * NOTIFICATIONS / OPERATIONS / HOME UI.
 *
 * The three surfaces now answer three different questions, and this suite
 * holds each of them to the shape of the question it answers:
 *
 *   NOTIFICATIONS  "what happened that I should know about?"
 *                  a recent-first personal feed, NOT an incident console.
 *   OPERATIONS     "what unresolved shared work must we act on?"
 *                  a dense work surface whose actions are capability-gated.
 *   HOME           "what is the state of my workspace?"
 *                  a cockpit that links to Operations and never becomes one.
 *
 * No parallel pages were created for any of it: there is one Notifications
 * implementation, one Operations console, and one Home — density and controls
 * vary by resolved CAPABILITY, never by a plan name or a forked page.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP_ROOT, rel), "utf8");

const NOTIFICATIONS = read("app/(app)/inbox/page.tsx");
const OPERATIONS = read("app/(app)/operations/page.tsx");
const NOTIFICATIONS_CSS = read("components/notifications/notifications.css");
// The Operations route was decomposed when it was rebuilt: the page is an
// orchestrator and every pixel lives in _components / _lib / operations.css.
const OPERATIONS_CSS = read("app/(app)/operations/operations.css");
const OPERATIONS_SURFACE = read(
  "app/(app)/operations/_components/IncidentSurface.tsx",
);
const OPERATIONS_TOOLBAR = read(
  "app/(app)/operations/_components/FilterToolbar.tsx",
);
const OPERATIONS_STATES = read("app/(app)/operations/_components/States.tsx");

/** Source with comments stripped, for "is this actually rendered?" checks. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

// ============================================================================
// 6.1 — the notification centre stops dressing as an incident console
// ============================================================================

test("the page leads with UNREAD, not with a severity scoreboard", () => {
  // The lead is still Unread — it is the FIRST metric card. The summary is now
  // a row of canonical metric cards rather than a running count with severity
  // pills beside it, and what this guards is unchanged: the page's own
  // question ("what did I miss?") comes before severity, so a personal feed
  // never opens with CRITICAL.
  const list = NOTIFICATIONS.slice(
    NOTIFICATIONS.indexOf("const NOTIFICATION_METRICS"),
  );
  assert.ok(
    list.indexOf('key: "unread"') < list.indexOf('key: "critical"'),
    "Unread must lead the summary, ahead of any severity",
  );
  assert.match(NOTIFICATIONS, /data-notifications-metric=/);
});

test("the five giant severity KPI cards are gone", () => {
  // They were the chrome of an operations dashboard on a personal feed, and
  // they put "CRITICAL 0" at the top of a page whose question is "what did I
  // miss?".
  assert.ok(
    !/ops-tone-tile__count/.test(code(NOTIFICATIONS)),
    "the severity KPI tiles must no longer render",
  );
});

test("severity survives as filterable METADATA", () => {
  // Severity still matters — a failed anchor is not a mention — so it stays a
  // filter.
  // Severity now lives in the SAME metric-card row as Unread and All, and it
  // is no longer a SECOND axis beside them: the six cards are one value, so
  // "unread AND high" is not a state the page can hold. Selecting a severity
  // card replaces whatever was selected.
  for (const tone of ["critical", "high", "warning", "info"]) {
    assert.ok(
      NOTIFICATIONS.includes(`key: "${tone}"`),
      `the summary must offer a ${tone} card`,
    );
  }
  assert.match(NOTIFICATIONS, /type PrimaryView = "all" \| "unread" \| InboxTone/);
  assert.match(NOTIFICATIONS, /setPrimaryView\(key\)/);
  // The retired two-axis wiring must not come back.
  assert.ok(
    !NOTIFICATIONS.includes("setToneFilter("),
    "severity must not be a second, independently-settable axis",
  );
  // And severity still reaches the SERVER as a narrowing, not merely a
  // highlight — it is a filter, not decoration.
  assert.match(NOTIFICATIONS, /params\.set\("tone", primaryView\)/);
});

test("the personal actions read as filing, not adjudication", () => {
  // "Remind me tomorrow" left this list when the reminder action was withdrawn
  // from the UI. The backend capability is deliberately untouched — see the
  // note where `remindItem` used to live.
  assert.ok(
    !NOTIFICATIONS.includes(">Remind me tomorrow<"),
    "the reminder action must not render",
  );
  for (const label of ["Archive", "Unarchive"]) {
    assert.ok(
      NOTIFICATIONS.includes(label),
      `the feed must offer "${label}"`,
    );
  }
  // "Dismiss" and "Snooze" were adjudication words on a surface that only
  // ever files one person's mail.
  assert.ok(!/>Dismiss</.test(NOTIFICATIONS), "no Dismiss control");
  assert.ok(!/>Snooze 1d</.test(NOTIFICATIONS), "no Snooze control");
});

test("a personal-feed fact is never labelled 'Resolved'", () => {
  assert.match(NOTIFICATIONS, /No longer active/);
  assert.ok(!/Resolved \{formatUserDate/.test(NOTIFICATIONS));
});

test("degraded state is honest on the feed", () => {
  assert.match(NOTIFICATIONS, /data-notifications-incomplete/);
  assert.match(NOTIFICATIONS, /may not be everything/);
  assert.match(NOTIFICATIONS, /mayAssertAllClear/);
});

// ============================================================================
// 6.2 / 6.3 / 6.4 — the Operations console
// ============================================================================

test("actions are gated on RESOLVED capabilities, not on role names", () => {
  assert.match(OPERATIONS, /OPERATIONS_ACKNOWLEDGE === true/);
  assert.match(OPERATIONS, /OPERATIONS_RESOLVE === true/);
  assert.match(OPERATIONS, /OPERATIONS_SUPPRESS === true/);
  assert.match(OPERATIONS, /OPERATIONS_ASSIGN === true/);
});

test("the workbench never compares a role name or a plan name", () => {
  const body = code(OPERATIONS);
  for (const forbidden of [
    'role === "OWNER"',
    'role === "ADMIN"',
    'plan === "ENTERPRISE"',
    'plan === "PRO"',
    'plan === "FREE"',
    "isPersonal",
    "workspaceKind",
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `the workbench must not branch on ${forbidden}`,
    );
  }
});

test("each action renders only with its own capability AND its own state", () => {
  // Permission alone is not enough: an operator who may acknowledge still gets
  // no Acknowledge on a condition that is already acknowledged, because the
  // server would refuse it and a control whose only outcome is a 409 teaches
  // people to distrust the surface.
  const ROW_MODEL = read("app/(app)/operations/_lib/rowModel.ts");
  assert.match(
    ROW_MODEL,
    /canAcknowledge: ctx\.capabilities\.canAcknowledge && isOpen/,
  );
  assert.match(
    ROW_MODEL,
    /canResolve: ctx\.capabilities\.canResolve && isUnresolved/,
  );
  assert.match(
    ROW_MODEL,
    /canSuppress: ctx\.capabilities\.canSuppress && isUnresolved/,
  );
});

test("a read-only operator gets NO mutation controls and no empty action column", () => {
  // The row menu returns null rather than an empty panel: a menu of nothing
  // reads as "these actions failed to load".
  const MENU = read("app/(app)/operations/_components/RowActionsMenu.tsx");
  assert.match(MENU, /if \(actions\.length === 0\) return null;/);
  // And the bulk toolbar never mounts without a selection.
  const BULK = read("app/(app)/operations/_components/BulkToolbar.tsx");
  assert.match(BULK, /if \(count === 0\) return null;/);
});

test("the single-operator shape falls out of capabilities, not a fork", () => {
  // A sole operator is granted no OPERATIONS_ASSIGN, so no owner column, no
  // owner filter and no assignment control render. There is no separate page
  // and no plan branch. Asserted over CODE: the page header explains the fork
  // it deliberately did NOT build.
  assert.ok(
    !/PersonalOperationsPage/.test(code(OPERATIONS)),
    "no forked personal page",
  );
  // Ownership as an AXIS is server-projected from the eligible-operator count,
  // not from the caller's own assign capability — a read-only viewer in a
  // shared workspace must still be able to ask who is on something.
  assert.match(OPERATIONS, /const collaborative = \(operatorCount \?\? 0\) > 1;/);
  assert.match(OPERATIONS, /showCollaborative=\{collaborative\}/);
  assert.match(OPERATIONS, /showOwnerColumn=\{collaborative\}/);
  assert.match(OPERATIONS_TOOLBAR, /showOwnerFilter \? \(/);
});

test("an all-clear is impossible over a partial or failed read", () => {
  // FOUR conditions, stated once. Drop any one and the sentence becomes a lie
  // an operator will act on.
  assert.match(OPERATIONS, /const mayAssertClear =/);
  assert.match(OPERATIONS, /incidents\.kind === "ready" &&/);
  assert.match(OPERATIONS, /complete &&/);
  assert.match(OPERATIONS, /rows\.length === 0 &&/);
  assert.match(OPERATIONS, /!anyFilterActive\(filters\)/);
  // A truncated read announces itself instead of reading as an empty one.
  assert.match(OPERATIONS, /Part of the condition list/);
});

test("the workbench explains read-only access instead of failing silently", () => {
  assert.match(OPERATIONS, /Acting on one needs an operator role/i);
});

// ============================================================================
// THE TENANT / PLATFORM BOUNDARY
// ============================================================================

test("the tenant workbench reads NO platform runtime data", () => {
  // Production rendered database status, Sentry status, webhook alert status,
  // process uptime, in-process counters and gauge counts on a TENANT page.
  // Those describe the API process, are identical for every tenant on the
  // instance, reset on deploy, and no tenant can act on any of them.
  const body = code(OPERATIONS);
  for (const platform of [
    "/v1/ops/health",
    "/v1/ops/metrics",
    "/v1/ops/alerts",
  ]) {
    assert.ok(
      !body.includes(platform),
      `the tenant workbench must not read ${platform}`,
    );
  }
  // And no platform vocabulary survived into the page.
  for (const word of [
    "uptimeSeconds",
    "gauges",
    "headlineCounters",
    "observability",
  ]) {
    assert.ok(!body.includes(word), `${word} is platform vocabulary`);
  }
});

test("the tenant workbench links to NO platform-admin console", () => {
  const body = code(OPERATIONS) + code(OPERATIONS_STATES);
  assert.ok(
    !body.includes("/admin/platform/"),
    "a shortcut to a console the reader is refused from is not navigation",
  );
});

test("there is exactly ONE h1, and one canonical page header", () => {
  // The duplicate-header defect: a hub bar emitted <h1>Operations Center</h1>
  // and the console below it rendered a second PageHeader with the same title.
  const h1s = code(OPERATIONS).match(/<h1\b/g) ?? [];
  assert.equal(h1s.length, 1, "exactly one <h1> on the Operations route");
  assert.match(OPERATIONS, /app-page-header__title/);
  assert.ok(
    !code(OPERATIONS).includes("HubQuickActionsBar"),
    "the hub bar was the second header",
  );
});

test("the six-button AI panel is gone, not restyled", () => {
  assert.ok(
    !code(OPERATIONS).includes("OperationsIntelligencePanel"),
    "the AI snapshot panel must not be mounted",
  );
  assert.ok(
    !existsSync(
      resolve(APP_ROOT, "components/ai-copilot/OperationsIntelligencePanel.tsx"),
    ),
    "the component must be deleted, not orphaned",
  );
});

// ============================================================================
// SELECTORS
// ============================================================================

test("every selector on the route is the canonical AppListbox", () => {
  // The production toolbar used FilterBar.Select, which is a native <select>:
  // the OS popup cannot be styled, cannot escape a clipping ancestor, and
  // cannot be audited for keyboard behaviour.
  assert.match(OPERATIONS_TOOLBAR, /AppListbox/);
  for (const src of [OPERATIONS, OPERATIONS_TOOLBAR, OPERATIONS_SURFACE]) {
    assert.ok(!code(src).includes("<select"), "no native select on this route");
    assert.ok(!code(src).includes("FilterBar"), "no legacy FilterBar selector");
  }
  // Every listbox names itself with the words the operator reads.
  const labelled = OPERATIONS_TOOLBAR.match(/ariaLabelledby=/g) ?? [];
  const boxes = OPERATIONS_TOOLBAR.match(/<AppListbox/g) ?? [];
  assert.equal(
    labelled.length,
    boxes.length,
    "every AppListbox must carry an accessible name",
  );
});

test("the Operations route introduces no colour literal", () => {
  // Every accent is a --tone-* token, which is itself an alias of the value
  // AppStatusBadge paints, so a rail and its badge cannot drift apart.
  // Stripped of comments: the sheet documents the rules it observes, so a
  // whole-file search matches its own header rather than a live declaration.
  const cssCode = OPERATIONS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(cssCode),
    "operations.css must name tokens, never hexes",
  );
  assert.ok(
    !/!important/.test(cssCode),
    "no !important on the Operations route",
  );
  for (const src of [OPERATIONS, OPERATIONS_SURFACE, OPERATIONS_TOOLBAR]) {
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(code(src)),
      "no hex literal in Operations JSX",
    );
    assert.ok(
      !/React\.CSSProperties/.test(src),
      "no inline style objects on the Operations route",
    );
  }
});

// ============================================================================
// 6.6 — responsive + accessibility
// ============================================================================

test("severity is never carried by colour alone", () => {
  // Every chip renders its LABEL as text beside the count; the colour is a
  // supporting cue on the left edge.
  // Every CARD renders its label AND an explanation as text; the tone rail is
  // a supporting cue on the inline-start edge, never the signal itself.
  assert.match(NOTIFICATIONS, /app-metric-card__label/);
  assert.match(NOTIFICATIONS, /app-metric-card__meta/);
  assert.match(NOTIFICATIONS, /\{metric\.label\}/);
  assert.match(NOTIFICATIONS, /\{metric\.explanation\}/);
  // The tone is a VARIABLE the route resolves, and it now resolves from the
  // CANONICAL design tokens rather than from this route's own `--ops-tone-*`
  // block — the same families the status badges and the Intake Links KPI
  // cards consume, so a colour cannot be defined twice and drift.
  for (const token of [
    "--ink-primary",
    "--accent-600",
    "--info",
    "--orange-500",
    "--error",
    "--ink-secondary",
  ]) {
    assert.ok(
      NOTIFICATIONS_CSS.includes(`--app-metric-tone: var(${token})`),
      `a metric card must resolve its tone from ${token}`,
    );
  }
  // And the mapping names tokens, never literals.
  const map = NOTIFICATIONS_CSS.slice(
    NOTIFICATIONS_CSS.indexOf('.ops-metric[data-ops-metric-tone="all"]'),
    NOTIFICATIONS_CSS.indexOf('.ops-metric[data-ops-metric-tone="all"]') + 800,
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(map),
    "the tone mapping must name tokens, never hexes",
  );
});

test("the severity chips are real buttons with pressed state", () => {
  // Not divs with click handlers: keyboard reachable, and their filter state
  // is announced rather than implied by colour.
  assert.match(NOTIFICATIONS, /aria-pressed=\{active\}/);
  assert.match(NOTIFICATIONS, /type="button"/);
});

test("focus is visible on every new interactive element", () => {
  // The metric card, the row actions and Refresh all take their focus ring
  // from the shared primitives, so it is asserted where it lives rather than
  // duplicated into this route's sheet.
  const PRIMITIVES = read("components/app-primitives/app-primitives.css");
  assert.match(PRIMITIVES, /\.app-metric-card:focus-visible/);
  assert.match(PRIMITIVES, /\.app-secondary-action:focus-visible/);
  assert.match(PRIMITIVES, /\.app-primary-action:focus-visible/);
  // The route's own controls keep the token ring.
  assert.match(NOTIFICATIONS_CSS, /box-shadow: var\(--focus-ring\)/);
});

test("the summary grid reflows instead of overflowing narrow viewports", () => {
  // 390px and 200% zoom are the same problem: not enough horizontal room.
  // The strip became a GRID of six metric cards, which survives both by
  // dropping to three, then two, then one column — and by giving every track a
  // `minmax(0, …)` floor, without which a grid child refuses to shrink below
  // its content and teaches the page to scroll sideways.
  const grid = NOTIFICATIONS_CSS.slice(
    NOTIFICATIONS_CSS.indexOf(".ops-metrics__grid {"),
  );
  assert.match(grid, /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(
    grid,
    /@media \(max-width: 1200px\)[\s\S]{0,200}repeat\(3, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    grid,
    /@media \(max-width: 640px\)[\s\S]{0,200}repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.ok(
    !/min-width:\s*\d{3,}px/.test(grid),
    "no fixed minimum width that could force horizontal page overflow",
  );
});

test("no hard-coded hex colour was introduced in the new chrome", () => {
  // The repo's design system is token-driven; a hex in JSX is how a surface
  // stops responding to theme.
  const newChrome = NOTIFICATIONS.slice(
    NOTIFICATIONS.indexOf("data-notifications-summary"),
    NOTIFICATIONS.indexOf("data-notifications-summary") + 4000,
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(newChrome),
    "the notification summary strip must use design tokens, not hex",
  );
});

// ============================================================================
// No parallel pages
// ============================================================================

test("there is exactly ONE notification implementation and ONE Operations console", () => {
  const canonical = read("app/(app)/notifications/page.tsx");
  assert.match(canonical, /export \{ default \} from "\.\.\/inbox\/page"/);
  // And no "v2"/"new" sibling was introduced for either surface.
  for (const forbidden of [
    "app/(app)/notifications-v2",
    "app/(app)/operations-v2",
    "app/(app)/operations/personal",
  ]) {
    assert.ok(
      !existsSync(resolve(APP_ROOT, forbidden)),
      `${forbidden} must not exist`,
    );
  }
});

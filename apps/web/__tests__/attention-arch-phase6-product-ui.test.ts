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
  assert.match(NOTIFICATIONS, /data-notifications-unread/);
  assert.match(NOTIFICATIONS, /unread notifications/);
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
  // Severity still matters — a failed anchor is not a mention — so it is kept
  // as compact chips with the same filter behaviour, at a fraction of the
  // visual weight.
  assert.match(NOTIFICATIONS, /data-notifications-severity/);
  assert.match(NOTIFICATIONS, /ops-severity-chip/);
  assert.match(NOTIFICATIONS, /setToneFilter\(active \? "all" : tone\)/);
});

test("the personal actions read as filing, not adjudication", () => {
  for (const label of ["Archive", "Unarchive", "Remind me tomorrow"]) {
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

test("row actions are gated on RESOLVED capabilities, not on role names", () => {
  assert.match(OPERATIONS, /capabilities\.OPERATIONS_ACKNOWLEDGE === true/);
  assert.match(OPERATIONS, /capabilities\.OPERATIONS_RESOLVE === true/);
  assert.match(OPERATIONS, /capabilities\.OPERATIONS_SUPPRESS === true/);
  assert.match(OPERATIONS, /capabilities\.OPERATIONS_ASSIGN === true/);
});

test("the console never compares a role name or a plan name", () => {
  const body = code(OPERATIONS);
  for (const forbidden of [
    'role === "OWNER"',
    'role === "ADMIN"',
    'plan === "ENTERPRISE"',
    'plan === "PRO"',
    'plan === "FREE"',
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `the console must not branch on ${forbidden}`,
    );
  }
});

test("a read-only operator gets NO action column", () => {
  // An empty column of nothing reads as "these actions failed to load".
  assert.match(OPERATIONS, /canActOnAnything\s*\n?\s*\?\s*\(i\)/);
  assert.match(OPERATIONS, /:\s*undefined/);
});

test("each action renders only with its own capability", () => {
  assert.match(OPERATIONS, /canAcknowledge && i\.status === "OPEN"/);
  assert.match(OPERATIONS, /canResolve &&/);
  assert.match(OPERATIONS, /canSuppress &&/);
});

test("6.3 — the single-operator shape falls out of capabilities, not a fork", () => {
  // A Personal Pro workspace is not granted OPERATIONS_ASSIGN, so no
  // assignment control renders. There is no separate page and no plan branch.
  // Assert over CODE: the comment above the capability reads names the
  // forked page it deliberately did NOT build, and a whole-file search would
  // match the explanation instead of the thing.
  assert.ok(
    !/PersonalOperationsPage/.test(code(OPERATIONS)),
    "no forked personal page",
  );
  // Named `_canAssign`: resolved on purpose, with no control attached YET.
  // The underscore is the lint convention for "read deliberately, unused for
  // now". Deleting it is how the next assignment button ends up gated on a
  // role-name comparison instead of on the capability.
  assert.match(OPERATIONS, /const _canAssign = capabilities\.OPERATIONS_ASSIGN/);
});

test("an empty list over a PARTIAL read does not read as an empty collection", () => {
  assert.match(OPERATIONS, /incidentsComplete/);
  assert.match(OPERATIONS, /Showing part of the list/);
  assert.match(OPERATIONS, /not the full picture/);
});

test("the console explains read-only access instead of failing silently", () => {
  assert.match(OPERATIONS, /acting on a condition needs an operator role/i);
});

// ============================================================================
// 6.6 — responsive + accessibility
// ============================================================================

test("severity is never carried by colour alone", () => {
  // Every chip renders its LABEL as text beside the count; the colour is a
  // supporting cue on the left edge.
  assert.match(NOTIFICATIONS, /ops-severity-chip__label/);
  assert.match(NOTIFICATIONS, /\{TONE_LABELS\[tone\]\}/);
  assert.match(NOTIFICATIONS_CSS, /\.ops-severity-chip__label/);
});

test("the severity chips are real buttons with pressed state", () => {
  // Not divs with click handlers: keyboard reachable, and their filter state
  // is announced rather than implied by colour.
  assert.match(NOTIFICATIONS, /aria-pressed=\{active\}/);
  assert.match(NOTIFICATIONS, /type="button"/);
});

test("focus is visible on every new interactive element", () => {
  assert.match(NOTIFICATIONS_CSS, /\.ops-severity-chip:focus-visible/);
  assert.match(NOTIFICATIONS_CSS, /box-shadow: var\(--focus-ring\)/);
});

test("the summary strip wraps instead of overflowing narrow viewports", () => {
  // 390px and 200% zoom are the same problem: not enough horizontal room.
  // A wrapping flex row survives both; a fixed grid of five cards does not.
  const strip = NOTIFICATIONS_CSS.slice(
    NOTIFICATIONS_CSS.indexOf(".ops-summary-strip {"),
  );
  assert.match(strip, /\.ops-summary-strip__chips \{[\s\S]{0,200}flex-wrap: wrap/);
  assert.ok(
    !/min-width:\s*\d{3,}px/.test(strip),
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

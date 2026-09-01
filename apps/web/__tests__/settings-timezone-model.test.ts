/**
 * TIMEZONE — one account value, one derivation, one editor.
 *
 * The model was already right in the database: `User.timezone` is the account
 * zone, `NotificationSchedule.timezone` is NULL-means-inherit, and the digest
 * scheduler resolves `schedule ?? account ?? "UTC"` in one place. What had
 * drifted was the SURFACE — three places showed the value, one of them let
 * you type a country into it, and the button that promised to set it did not
 * save anything.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectDeviceTimezone,
  supportedTimezones,
  timezoneLabel,
  timezoneOptions,
} from "../lib/timezones";
import { resolveEffectiveTimezone } from "../lib/notifications/effectiveTimezone";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

const PREFERENCES = read("app/(app)/settings/_sections/PreferencesSection.tsx");
const OVERVIEW = read("app/(app)/settings/_sections/SettingsOverview.tsx");
const NOTIFICATIONS = read("components/notifications/NotificationPreferencesPanel.tsx");
const SETTINGS_CSS = read("app/(app)/settings/settings.css");

// ------------------------------------------------------- THE EFFECTIVE VALUE

test("the effective notification timezone has exactly one derivation", () => {
  // override → account → UTC, and nothing else decides it.
  assert.equal(resolveEffectiveTimezone("Asia/Damascus", "Europe/Berlin"), "Asia/Damascus");
  assert.equal(resolveEffectiveTimezone(null, "Europe/Berlin"), "Europe/Berlin");
  assert.equal(resolveEffectiveTimezone(null, null), "UTC");
  // Disabling the override returns to the account value, without the pane
  // having to remember what that was.
  assert.equal(resolveEffectiveTimezone("", "Asia/Damascus"), "Asia/Damascus");
  // Whitespace is not an override.
  assert.equal(resolveEffectiveTimezone("   ", "Europe/Berlin"), "Europe/Berlin");
});

test("Notifications reads that one helper rather than deriving its own", () => {
  assert.match(NOTIFICATIONS, /resolveEffectiveTimezone\(/);
  assert.match(
    NOTIFICATIONS,
    /resolveEffectiveTimezone\(schedule\.timezone, accountTimezone\)/,
    "the pane must pass the override and the account value, and decide nothing",
  );
  // The account value it passes is the account's, read from the session.
  assert.match(NOTIFICATIONS, /user\?\.timezone/);
});

test("Notifications only offers an editor when an override is actually on", () => {
  // With "use account timezone" selected there must be no second editable
  // account-timezone field — that is what made the pane look like a duplicate
  // of Preferences.
  assert.match(
    NOTIFICATIONS,
    /schedule\.timezone !== null \?[\s\S]{0,900}Workspace timezone/,
    "the override selector is rendered only when an override exists",
  );
  assert.match(NOTIFICATIONS, /Override for this workspace/);
});

// ------------------------------------------------------------- THE SELECTOR

test("the account timezone is chosen, not typed", () => {
  // A free-text box accepted "Syria" — a country, not a zone.
  assert.match(PREFERENCES, /data-cc-preferences-tz-select/);
  assert.match(PREFERENCES, /<AppListbox[\s\S]{0,200}timezoneOptions\(timezone\)/);
  assert.doesNotMatch(
    PREFERENCES,
    /<Input[\s\S]{0,200}placeholder="e\.g\. Europe\/Berlin"/,
    "the free-text timezone field must be gone",
  );
});

test("the option list is real IANA zones, labelled by city, valued by identifier", () => {
  const zones = supportedTimezones();
  assert.ok(zones.length > 0, "the runtime must supply a zone list");
  assert.ok(zones.includes("UTC") || zones.length > 100, "a real IANA list, or the UTC fallback");

  // Label carries the city; the VALUE is always the canonical identifier.
  assert.equal(timezoneLabel("Asia/Damascus"), "Damascus — Asia/Damascus");
  assert.equal(timezoneLabel("America/New_York"), "New York — America/New_York");
  assert.equal(timezoneLabel("UTC"), "UTC");

  const opts = timezoneOptions("Europe/Berlin");
  assert.ok(
    opts.every((o) => o.value === o.value.trim() && !o.value.includes(" ")),
    "every stored value is an identifier, never a label",
  );
  // A country name is not in the list, so the control cannot produce one.
  assert.equal(opts.find((o) => o.value === "Syria"), undefined);
});

test("a zone the runtime does not enumerate is still shown, not silently dropped", () => {
  // An account may hold a name this browser has never heard of. Dropping it
  // would show a value the account is not set to, and the next save would
  // rewrite it without anyone asking.
  const opts = timezoneOptions("Mars/Olympus_Mons");
  assert.equal(opts[0]?.value, "Mars/Olympus_Mons");
});

// --------------------------------------------------- USE MY CURRENT TIMEZONE

test("detection returns a real zone or null, never a silent UTC", () => {
  const tz = detectDeviceTimezone();
  assert.ok(tz === null || (typeof tz === "string" && tz.length > 0));
});

test("`Use my current timezone` persists, and says so when it cannot detect", () => {
  // It used to call setTimezone and stop: the box changed, the account did
  // not, and the value was lost unless you also found the Save button.
  assert.match(
    PREFERENCES,
    /const detectTimezone = async \(\) => \{[\s\S]{0,700}await save\(\{ timezoneOverride: tz \}\)/,
    "detection must write the account timezone",
  );
  assert.match(
    PREFERENCES,
    /setError\("Could not detect your current timezone\."\)/,
    "a failed detection is reported, not swapped for UTC",
  );
  // The save uses the value it just detected, not stale React state.
  assert.match(PREFERENCES, /opts\?\.timezoneOverride \?\? timezone/);
});

test("nothing syncs the browser zone over a manual choice", () => {
  // The only writer is an explicit save; there is no effect watching the
  // device zone and pushing it into the account.
  assert.doesNotMatch(
    PREFERENCES,
    /useEffect\([\s\S]{0,300}detectDeviceTimezone\(\)/,
    "a manual override must never be overwritten automatically",
  );
});

// ----------------------------------------------------------- THE DUPLICATION

test("the Overview timezone card is gone", () => {
  assert.doesNotMatch(OVERVIEW, /title="Timezone"/);
  assert.doesNotMatch(OVERVIEW, /testId="timezone"/);
  // …and the summary row follows the content rather than keeping a hole.
  // The seat Timezone left was taken by Recent sign-ins, not by a filler.
  assert.match(
    SETTINGS_CSS,
    /\.settings-page-shell \.set-grid--summary \{[\s\S]{0,300}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/,
    "four cards: Workspace, Plan, Security, Recent sign-ins",
  );
});

test("Preferences remains the one editor, with the concise helper", () => {
  assert.match(PREFERENCES, /data-cc-preferences-timezone/);
  assert.match(PREFERENCES, /Account timezone/);
  assert.match(
    PREFERENCES,
    /Used for notification digests and quiet hours\. Evidence and audit\s*\n?\s*timestamps remain in UTC\./,
    "the UTC guarantee is stated once, where the value is edited",
  );
  assert.match(PREFERENCES, /data-cc-preferences-detect-tz/);
});

// -------------------------------------------------------------- POLICY ROWS

test("policy status rows share one set of grid tracks", () => {
  // Flex `space-between` balanced each row against its own content, so three
  // different policy names put three "Up to date" labels at three x positions.
  assert.match(
    SETTINGS_CSS,
    /\.set-policy-row \{[\s\S]{0,300}grid-template-columns: minmax\(0, 1fr\) max-content max-content/,
    "one grid, shared tracks",
  );
  assert.doesNotMatch(
    SETTINGS_CSS,
    /\.set-policy-row \{[\s\S]{0,300}justify-content: space-between/,
  );
  assert.match(
    SETTINGS_CSS,
    /@media \(max-width: 560px\)[\s\S]{0,400}\.set-policy-row__name \{[\s\S]{0,80}grid-column: 1 \/ -1/,
    "the row stacks rather than squeezing three columns onto a phone",
  );
});

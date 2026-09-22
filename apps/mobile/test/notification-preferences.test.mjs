/**
 * NOTIFICATION PREFERENCES — the native pane's projections.
 *
 * The claims that matter:
 *   - a category with no stored row is rendered at its DEFAULT, not as "off".
 *     The endpoint publishes `catalog.defaults` precisely because the absence
 *     of a row is not an opt-out, and telling a user they had muted something
 *     that is emailing them is the worst thing this pane could do;
 *   - a locked category is never offered as a free toggle. The lock is the
 *     platform floor or the organization's policy and is enforced server-side;
 *   - the vocabulary comes from the response. This module restates no list of
 *     categories, channels or frequencies, so a new category appears without a
 *     client release and a retired one disappears.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/notification-preferences.ts"), "utf8");
const js = ts.transpileModule(SRC, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const N = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const envelope = (over = {}) => ({
  teamId: "11111111-1111-1111-1111-111111111111",
  preferences: [],
  lockedTypes: [],
  emailLockedTypes: [],
  minimumFrequencyByType: {},
  organizationId: null,
  canManageOrgPolicy: false,
  isPersonalWorkspace: true,
  catalog: {
    preferenceTypes: ["MENTION", "ESCALATION", "GOVERNANCE_UPDATE"],
    channels: ["IN_APP", "EMAIL"],
    frequencies: ["IMMEDIATE", "HOURLY", "DAILY", "WEEKLY", "OFF"],
    defaults: { IN_APP: true, EMAIL: false, frequency: "IMMEDIATE" },
  },
  ...over,
});

const cell = (view, type, channel) =>
  view.rows.find((r) => r.type === type).cells.find((c) => c.channel === channel);

/* ------------------------------------------------------------------ defaults */

test("a category with no stored row renders at the published default", () => {
  const view = N.parsePreferences(envelope());

  // Not "off". IN_APP defaults on, EMAIL defaults off, and both are what the
  // user is actually experiencing right now.
  assert.equal(cell(view, "MENTION", "IN_APP").enabled, true);
  assert.equal(cell(view, "MENTION", "EMAIL").enabled, false);
  assert.equal(cell(view, "MENTION", "EMAIL").frequency, "IMMEDIATE");
  assert.equal(cell(view, "MENTION", "IN_APP").updatedAtIso, null);
});

test("a stored row overrides the default", () => {
  const view = N.parsePreferences(
    envelope({
      preferences: [
        {
          preferenceType: "MENTION",
          channel: "EMAIL",
          enabled: true,
          frequency: "DAILY",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    }),
  );

  const c = cell(view, "MENTION", "EMAIL");
  assert.equal(c.enabled, true);
  assert.equal(c.frequency, "DAILY");
  assert.equal(c.updatedAtIso, "2026-09-01T00:00:00.000Z");
});

/* --------------------------------------------------------------------- locks */

test("locked categories are marked per channel, not per row", () => {
  const view = N.parsePreferences(
    envelope({
      lockedTypes: ["GOVERNANCE_UPDATE"],
      emailLockedTypes: ["ESCALATION"],
      isPersonalWorkspace: false,
    }),
  );

  assert.equal(cell(view, "GOVERNANCE_UPDATE", "IN_APP").locked, true);
  // The in-app floor does NOT lock email for the same category — the server
  // leaves email user-controllable there.
  assert.equal(cell(view, "GOVERNANCE_UPDATE", "EMAIL").locked, false);
  assert.equal(cell(view, "ESCALATION", "EMAIL").locked, true);
  assert.equal(cell(view, "ESCALATION", "IN_APP").locked, false);
});

test("a policy 403 is recognised as policy, not as a failure", () => {
  assert.equal(N.isPolicyLocked({ statusCode: 403 }), true);
  assert.equal(N.isPolicyLocked({ code: "policy_locked" }), true);
  assert.equal(N.isPolicyLocked({ statusCode: 500 }), false);
  assert.equal(N.isPolicyLocked(new Error("network")), false);
});

/* --------------------------------------------------------------- frequencies */

test("an organization minimum removes the cadences the server would refuse", () => {
  const view = N.parsePreferences(
    envelope({
      isPersonalWorkspace: false,
      minimumFrequencyByType: { ESCALATION: "DAILY" },
    }),
  );

  // The user may strengthen (DAILY → HOURLY → IMMEDIATE) but never weaken.
  assert.deepEqual(N.allowedFrequencies(view, "ESCALATION"), [
    "IMMEDIATE",
    "HOURLY",
    "DAILY",
  ]);
  // A category with no floor keeps the full set, in the server's order.
  assert.deepEqual(N.allowedFrequencies(view, "MENTION"), [
    "IMMEDIATE",
    "HOURLY",
    "DAILY",
    "WEEKLY",
    "OFF",
  ]);
});

/* ------------------------------------------------------------------- writing */

test("frequency is sent only where it means something", () => {
  const email = N.buildPreferenceUpdate({
    teamId: "t",
    preferenceType: "MENTION",
    channel: "EMAIL",
    enabled: true,
    frequency: "DAILY",
  });
  assert.equal(email.frequency, "DAILY");

  // IN_APP rows ignore frequency server-side (in-app is immediate when on).
  const inApp = N.buildPreferenceUpdate({
    teamId: "t",
    preferenceType: "MENTION",
    channel: "IN_APP",
    enabled: true,
    frequency: "DAILY",
  });
  assert.equal("frequency" in inApp, false);
});

/* ------------------------------------------------------------------ schedule */

test("an absent schedule is not quiet hours turned off", () => {
  assert.equal(N.parseSchedule({}), null);
  assert.equal(N.parseSchedule({ schedule: {} }), null);
  assert.equal(N.isScheduleUnavailable({ statusCode: 503 }), true);
  assert.equal(N.isScheduleUnavailable({ code: "SCHEMA_NOT_READY" }), true);
  assert.equal(N.isScheduleUnavailable({ statusCode: 500 }), false);
});

test("minute-of-day renders as a clock time", () => {
  assert.equal(N.formatMinuteOfDay(0), "00:00");
  assert.equal(N.formatMinuteOfDay(9 * 60 + 5), "09:05");
  assert.equal(N.formatMinuteOfDay(1439), "23:59");
  // Out-of-range values are clamped rather than printed as "-1:-5".
  assert.equal(N.formatMinuteOfDay(-30), "00:00");
  assert.equal(N.formatMinuteOfDay(99999), "23:59");
});

test("a quiet window that wraps midnight is described, not treated as invalid", () => {
  const base = {
    timezone: null,
    quietHoursEnabled: true,
    quietStartMinute: 22 * 60,
    quietEndMinute: 7 * 60,
    quietCriticalOverride: true,
  };
  assert.match(N.describeQuietWindow(base), /22:00 to 07:00 \(next day\)/);
  assert.match(
    N.describeQuietWindow({ ...base, quietStartMinute: 60, quietEndMinute: 300 }),
    /^01:00 to 05:00$/,
  );
  // Equal endpoints are accepted by the server and quiet nothing — said aloud.
  assert.match(
    N.describeQuietWindow({ ...base, quietStartMinute: 60, quietEndMinute: 60 }),
    /empty window/,
  );
  assert.equal(N.describeQuietWindow({ ...base, quietHoursEnabled: false }), "Off");
});

/* ------------------------------------------------- no second preference model */

test("this module restates no vocabulary the endpoint publishes", () => {
  // A category, channel or frequency list duplicated here is a second model,
  // and it is the one that goes stale.
  for (const forbidden of [
    "NOTIFICATION_PREFERENCE_TYPES",
    "NOTIFICATION_PREFERENCE_CHANNELS",
    "NOTIFICATION_FREQUENCIES",
    "mobileNotificationPreferences",
  ]) {
    // The doc comment may quote the names; a declaration may not exist.
    assert.doesNotMatch(
      SRC,
      new RegExp(`(const|let|var|export const)\\s+${forbidden}\\s*=`),
      `${forbidden} is redeclared in the client`,
    );
  }
});

test("an unknown category still renders, under its key", () => {
  const view = N.parsePreferences(
    envelope({
      catalog: {
        preferenceTypes: ["SOMETHING_NEW"],
        channels: ["IN_APP"],
        frequencies: ["IMMEDIATE"],
        defaults: { IN_APP: true, EMAIL: false, frequency: "IMMEDIATE" },
      },
    }),
  );
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].label, "SOMETHING_NEW");
});

test("the paths address the canonical endpoints, workspace-scoped", () => {
  assert.equal(
    N.buildPreferencesPath("team-1"),
    "/v1/me/notification-preferences?teamId=team-1",
  );
  assert.equal(N.PREFERENCES_WRITE_PATH, "/v1/me/notification-preferences");
  assert.equal(N.buildSchedulePath("team-1"), "/v1/me/notification-schedule?teamId=team-1");
  assert.equal(N.SCHEDULE_WRITE_PATH, "/v1/me/notification-schedule");
});

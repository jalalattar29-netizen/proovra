/**
 * NOTIFICATION PREFERENCES — pure projections for the native preferences pane.
 *
 * Ports `apps/web/components/notifications/NotificationPreferencesPanel.tsx`
 * over `GET/PUT /v1/me/notification-preferences` and
 * `GET/PUT /v1/me/notification-schedule`.
 *
 * ===========================================================================
 * Q2 RESOLVED FROM THE REPOSITORY, AND THE PREMISE WAS WRONG
 * ===========================================================================
 * The question recorded as Q2 assumed these preferences were "most meaningful
 * alongside push, which does not exist", and so might be premature. The
 * canonical vocabulary says otherwise:
 *
 *   NOTIFICATION_PREFERENCE_CHANNELS = ["IN_APP", "EMAIL"]
 *
 * There is no PUSH channel, and a search of services/, packages/ and
 * apps/mobile finds no push infrastructure at all — no APNs, no FCM, no Expo
 * push, no device-token model. These preferences have never governed push.
 * They govern the in-app inbox the Native app ALREADY renders, and the email
 * a Native user is ALREADY receiving. Deferring them left a user able to read
 * notifications on the phone and unable to turn any of them off.
 *
 * So: preferences and schedule are ported. Contact-channel verification
 * (`/v1/communications/verify/*`) is NOT, and that is the same evidence read
 * the other way — it verifies a PHONE NUMBER, and with no SMS channel in the
 * enum, verifying one would let a user configure a delivery the platform
 * cannot perform.
 *
 * ===========================================================================
 * NO SECOND PREFERENCE MODEL
 * ===========================================================================
 * There is no `mobileNotificationPreferences` and no device registration here.
 * The endpoint is self-describing — it returns `catalog.preferenceTypes`,
 * `catalog.channels`, `catalog.frequencies` and `catalog.defaults` precisely so
 * a client does not restate them — so this module holds no vocabulary of its
 * own. The one thing it holds is display copy for the categories, which is UI
 * text, not policy: an unknown category still renders, under its raw key.
 *
 * The locks are equally not ours. `lockedTypes`, `emailLockedTypes` and
 * `minimumFrequencyByType` come from the platform floor and the organization's
 * policy, and are enforced server-side — the client lock is cosmetic, and a
 * PUT that violates one answers 403 `policy_locked`.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const strList = (v: unknown): string[] =>
  rows(v).filter((x): x is string => typeof x === "string");
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildPreferencesPath(teamId: string): string {
  return `/v1/me/notification-preferences?teamId=${encodeURIComponent(teamId)}`;
}

export const PREFERENCES_WRITE_PATH = "/v1/me/notification-preferences";

export function buildSchedulePath(teamId: string): string {
  return `/v1/me/notification-schedule?teamId=${encodeURIComponent(teamId)}`;
}

export const SCHEDULE_WRITE_PATH = "/v1/me/notification-schedule";

// ---------------------------------------------------------------------------
// Display copy
// ---------------------------------------------------------------------------

/**
 * Human labels for the canonical categories. Display only — the set of
 * categories comes from the response's `catalog`, and one that is not listed
 * here still renders (under its key) rather than disappearing.
 */
// WEB PARITY — the labels, help lines, lock reasons and groups are the web's
// (components/notifications/NotificationPreferencesPanel.tsx TYPE_LABEL,
// TYPE_HELP, IN_APP_LOCK_REASON, PREFERENCE_GROUPS). SLA_NEAR_BREACH is the
// evidence-integrity failure category, not an SLA timer, and the old native
// label ("SLA approaching breach") named the wrong thing.
const TYPE_LABELS: Readonly<Record<string, string>> = {
  MENTION: "@-mentions in discussions",
  ASSIGNED_THREAD: "Discussion threads assigned to you",
  REVIEWER_ASSIGNMENT: "Reviewer workflow assignments",
  ESCALATION: "Escalations routed to you",
  SLA_NEAR_BREACH: "Evidence integrity & verification failures",
  EVIDENCE_REQUEST_UPDATE: "Evidence request updates",
  GOVERNANCE_UPDATE: "Governance / destruction updates",
};

export function preferenceTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

const TYPE_HELP: Readonly<Record<string, string>> = {
  MENTION: "In-app + topbar surface when a reviewer @-mentions you in a workspace discussion.",
  ASSIGNED_THREAD: "In-app + topbar surface when a discussion thread is assigned to you.",
  REVIEWER_ASSIGNMENT: "Notified when a reviewer-ops workflow is assigned to you.",
  ESCALATION: "Notified when an escalation is routed to you.",
  SLA_NEAR_BREACH:
    "Evidence-integrity failures on records you can access — failed trusted timestamps (TSA/OTS), and, where your plan includes them, report generation and verification-package failures. Always shown in the app; email delivery is your choice.",
  EVIDENCE_REQUEST_UPDATE: "Notified when an evidence request you own has new activity.",
  GOVERNANCE_UPDATE: "Notified when a governance event (destruction, retention) affects scope you own.",
};

/** One line on what the category delivers; null for a category the client does not know. */
export function preferenceTypeHelp(type: string): string | null {
  return TYPE_HELP[type] ?? null;
}

const IN_APP_LOCK_REASON: Readonly<Record<string, string>> = {
  SLA_NEAR_BREACH: "Required for evidence integrity — always shown in the app",
  GOVERNANCE_UPDATE: "Required governance duty — always shown in the app",
};

/** Why an in-app channel is locked on: a platform duty, or the organization's policy. */
export function inAppLockReason(type: string): string {
  return IN_APP_LOCK_REASON[type] ?? "Managed by your organization — always on.";
}

export const EMAIL_LOCK_REASON = "Managed by your organization — email delivery is required.";

/** True when a REAL organization policy locks something (beyond the platform's own in-app duties). */
export function hasOrgPolicyLocks(view: PreferencesView): boolean {
  if (Object.keys(view.minimumFrequencyByType).length > 0) return true;
  return view.rows.some((row) =>
    row.cells.some((c) => c.locked && (c.channel !== "IN_APP" || !(row.type in IN_APP_LOCK_REASON))),
  );
}

/**
 * B2B-F-12 (Free-user audit 0ea0) — each group carries the web's operational
 * DOMAIN (NotificationPreferencesPanel PREFERENCE_GROUPS), so native hides the
 * same groups the web hides for the same actor (`preferenceGroupVisible`).
 */
export type PreferenceGroupDomain = "integrity" | "review" | "intake" | "collaboration" | "governance";
const PREFERENCE_GROUPS: ReadonlyArray<{ title: string; domain: PreferenceGroupDomain; types: ReadonlyArray<string> }> = [
  { title: "Evidence integrity & verification", domain: "integrity", types: ["SLA_NEAR_BREACH"] },
  { title: "Reviews & quality", domain: "review", types: ["REVIEWER_ASSIGNMENT", "ESCALATION"] },
  { title: "Secure intake", domain: "intake", types: ["EVIDENCE_REQUEST_UPDATE"] },
  { title: "Collaboration", domain: "collaboration", types: ["MENTION", "ASSIGNED_THREAD"] },
  { title: "Governance & retention", domain: "governance", types: ["GOVERNANCE_UPDATE"] },
];

/**
 * The published rows, in the web's groups. A category the server publishes
 * that no group names still renders — under "Other" — rather than vanishing.
 */
export function groupPreferenceRows(
  rowsIn: PreferenceRow[],
  groupVisible: (domain: PreferenceGroupDomain) => boolean = () => true,
): Array<{ title: string; rows: PreferenceRow[] }> {
  const out: Array<{ title: string; rows: PreferenceRow[] }> = [];
  const placed = new Set<string>();
  for (const g of PREFERENCE_GROUPS) {
    const members = g.types
      .map((t) => rowsIn.find((r) => r.type === t))
      .filter((r): r is PreferenceRow => Boolean(r));
    members.forEach((r) => placed.add(r.type));
    // A hidden group's types stay placed: they do not reappear under "Other".
    if (members.length > 0 && groupVisible(g.domain)) out.push({ title: g.title, rows: members });
  }
  const rest = rowsIn.filter((r) => !placed.has(r.type));
  if (rest.length > 0) out.push({ title: "Other", rows: rest });
  return out;
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  IN_APP: "In-app",
  EMAIL: "Email",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

const FREQUENCY_LABELS: Readonly<Record<string, string>> = {
  IMMEDIATE: "Immediate",
  HOURLY: "Hourly digest",
  DAILY: "Daily digest",
  WEEKLY: "Weekly digest",
  OFF: "Off",
};

export function frequencyLabel(frequency: string): string {
  return FREQUENCY_LABELS[frequency] ?? frequency;
}

/** Weakest to strongest, matching the server's FREQUENCY_RANK ordering. */
const FREQUENCY_RANK: Readonly<Record<string, number>> = {
  OFF: 0,
  WEEKLY: 1,
  DAILY: 2,
  HOURLY: 3,
  IMMEDIATE: 4,
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface PreferenceCell {
  channel: string;
  enabled: boolean;
  frequency: string;
  /** Locked by the platform floor or organization policy; a toggle would 403. */
  locked: boolean;
  /** Present only where the row came from a stored preference. */
  updatedAtIso: string | null;
}

export interface PreferenceRow {
  type: string;
  label: string;
  cells: PreferenceCell[];
}

export interface PreferencesView {
  teamId: string | null;
  rows: PreferenceRow[];
  channels: string[];
  frequencies: string[];
  /** Per type, the weakest email cadence the organization permits. */
  minimumFrequencyByType: Readonly<Record<string, string>>;
  isPersonalWorkspace: boolean;
  organizationId: string | null;
  canManageOrgPolicy: boolean;
}

/**
 * Project the envelope into a row per category and a cell per channel.
 *
 * A category with no stored row is NOT absent and NOT off — the endpoint
 * publishes the defaults the absence of a row implies (`catalog.defaults`), and
 * those are what the user is actually experiencing. Rendering such a category
 * as "off" would tell a user they had muted something that is emailing them.
 */
export function parsePreferences(payload: unknown): PreferencesView {
  const env = obj(payload);
  const catalog = obj(env.catalog);
  const defaults = obj(catalog.defaults);

  const types = strList(catalog.preferenceTypes);
  const channels = strList(catalog.channels);
  const frequencies = strList(catalog.frequencies);
  const defaultFrequency = str(defaults.frequency) ?? "IMMEDIATE";

  const stored = new Map<string, { enabled: boolean; frequency: string; updatedAt: string | null }>();
  for (const raw of rows(env.preferences)) {
    const r = obj(raw);
    const type = str(r.preferenceType);
    const channel = str(r.channel);
    if (!type || !channel) continue;
    stored.set(`${type} ${channel}`, {
      enabled: r.enabled !== false,
      frequency: str(r.frequency) ?? defaultFrequency,
      updatedAt: str(r.updatedAt),
    });
  }

  const inAppLocked = new Set(strList(env.lockedTypes));
  const emailLocked = new Set(strList(env.emailLockedTypes));

  const minimums: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(env.minimumFrequencyByType))) {
    const f = str(v);
    if (f) minimums[k] = f;
  }

  const preferenceRows: PreferenceRow[] = types.map((type) => ({
    type,
    label: preferenceTypeLabel(type),
    cells: channels.map((channel) => {
      const hit = stored.get(`${type} ${channel}`);
      const fallback = defaults[channel];
      return {
        channel,
        enabled: hit ? hit.enabled : fallback === true,
        frequency: hit ? hit.frequency : defaultFrequency,
        locked:
          channel === "IN_APP"
            ? inAppLocked.has(type)
            : channel === "EMAIL"
              ? emailLocked.has(type)
              : false,
        updatedAtIso: hit?.updatedAt ?? null,
      };
    }),
  }));

  return {
    teamId: str(env.teamId),
    rows: preferenceRows,
    channels,
    frequencies,
    minimumFrequencyByType: minimums,
    isPersonalWorkspace: env.isPersonalWorkspace === true,
    organizationId: str(env.organizationId),
    canManageOrgPolicy: env.canManageOrgPolicy === true,
  };
}

/**
 * The frequencies a user may actually choose for a category.
 *
 * The organization may set a floor the user can strengthen but never weaken;
 * the server answers 403 for anything below it. Offering a choice that will be
 * refused is worse than not offering it.
 */
export function allowedFrequencies(
  view: PreferencesView,
  type: string,
): string[] {
  const floor = view.minimumFrequencyByType[type];
  if (!floor) return view.frequencies;
  const min = FREQUENCY_RANK[floor] ?? 0;
  return view.frequencies.filter((f) => (FREQUENCY_RANK[f] ?? 0) >= min);
}

export function buildPreferenceUpdate(input: {
  teamId: string;
  preferenceType: string;
  channel: string;
  enabled: boolean;
  frequency?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    teamId: input.teamId,
    preferenceType: input.preferenceType,
    channel: input.channel,
    enabled: input.enabled,
  };
  // IN_APP rows ignore frequency (in-app is immediate when enabled), so it is
  // sent only where it means something.
  if (input.frequency && input.channel !== "IN_APP") {
    body.frequency = input.frequency;
  }
  return body;
}

/** A 403 the server raises because policy forbids the change, not an error. */
export function isPolicyLocked(err: unknown): boolean {
  const e = obj(err);
  const status = int(e.statusCode);
  const code = str(e.code);
  return status === 403 || code === "policy_locked";
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface NotificationSchedule {
  /** null = no workspace override; the digest scheduler inherits the account. */
  timezone: string | null;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  /** Critical alerts still break through quiet hours. */
  quietCriticalOverride: boolean;
}

export const DEFAULT_SCHEDULE: NotificationSchedule = {
  timezone: null,
  quietHoursEnabled: false,
  quietStartMinute: 22 * 60,
  quietEndMinute: 7 * 60,
  quietCriticalOverride: true,
};

/**
 * `null` when the endpoint reports the schema is not present (503
 * SCHEMA_NOT_READY on a deployment where the migration has not run).
 * That is "this feature is not available here", which is a different thing
 * from "quiet hours are off".
 */
export function parseSchedule(payload: unknown): NotificationSchedule | null {
  const s = obj(obj(payload).schedule);
  if (Object.keys(s).length === 0) return null;

  return {
    timezone: str(s.timezone),
    quietHoursEnabled: s.quietHoursEnabled === true,
    quietStartMinute: int(s.quietStartMinute) ?? DEFAULT_SCHEDULE.quietStartMinute,
    quietEndMinute: int(s.quietEndMinute) ?? DEFAULT_SCHEDULE.quietEndMinute,
    quietCriticalOverride: s.quietCriticalOverride !== false,
  };
}

export function isScheduleUnavailable(err: unknown): boolean {
  const e = obj(err);
  // The route answers a TYPED 503 `notification_schedule_unavailable`
  // (notification-preferences.routes.ts:398); SCHEMA_NOT_READY is the generic
  // schema gate, kept.
  const code = str(e.code);
  return int(e.statusCode) === 503 || code === "notification_schedule_unavailable" || code === "SCHEMA_NOT_READY";
}

/** Minutes past midnight → `HH:MM`, for display. */
export function formatMinuteOfDay(minute: number): string {
  const m = Math.max(0, Math.min(1439, Math.trunc(minute)));
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function buildScheduleUpdate(
  teamId: string,
  schedule: NotificationSchedule,
): Record<string, unknown> {
  return {
    teamId,
    timezone: schedule.timezone,
    quietHoursEnabled: schedule.quietHoursEnabled,
    quietStartMinute: schedule.quietStartMinute,
    quietEndMinute: schedule.quietEndMinute,
    quietCriticalOverride: schedule.quietCriticalOverride,
  };
}

/**
 * A quiet window that wraps midnight is normal (22:00 → 07:00) and must not be
 * mistaken for an invalid range. Equal endpoints are the degenerate case: the
 * server accepts them, and they mean no quiet time at all, which is worth
 * saying out loud on the surface.
 */
export function describeQuietWindow(schedule: NotificationSchedule): string {
  if (!schedule.quietHoursEnabled) return "Off";
  const from = formatMinuteOfDay(schedule.quietStartMinute);
  const to = formatMinuteOfDay(schedule.quietEndMinute);
  if (schedule.quietStartMinute === schedule.quietEndMinute) {
    return `${from} to ${to} — an empty window, so nothing is quieted`;
  }
  const wraps = schedule.quietEndMinute < schedule.quietStartMinute;
  return wraps ? `${from} to ${to} (next day)` : `${from} to ${to}`;
}

/**
 * Phase G3.1 — Operator notification preferences service.
 *
 * Owns the per-(user, workspace, preferenceType, channel) toggle table.
 * Distinct from `CommunicationPreference` (which controls outbound
 * SMS / WhatsApp delivery for CONTACT notifications) — this service
 * is about which operational events surface in the operator's own
 * inbox / topbar / email.
 *
 * Hard rules:
 *   * Workspace-scoped writes. `teamId` is required on every
 *     mutation. Cross-workspace updates are rejected at the route
 *     layer.
 *   * Bounded enum vocabulary. The seven preference types are pinned
 *     by `NOTIFICATION_PREFERENCE_TYPES`.
 *   * Defaults are operator-friendly. When no row exists for a
 *     (user, workspace, type, IN_APP) tuple, the absence is treated
 *     as `enabled = true` by `isPreferenceEnabled()`. The EMAIL
 *     channel is opt-in — absence treated as `enabled = false`.
 *   * The service does NOT decide what to send; it stores the
 *     toggles. Consuming surfaces (inbox aggregator, future email
 *     dispatcher) check `isPreferenceEnabled()` before surfacing /
 *     delivering.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export const NOTIFICATION_PREFERENCE_TYPES = [
  "MENTION",
  "ASSIGNED_THREAD",
  "REVIEWER_ASSIGNMENT",
  "ESCALATION",
  "SLA_NEAR_BREACH",
  "EVIDENCE_REQUEST_UPDATE",
  "GOVERNANCE_UPDATE",
] as const;

export type NotificationPreferenceType =
  (typeof NOTIFICATION_PREFERENCE_TYPES)[number];

export const NOTIFICATION_PREFERENCE_CHANNELS = [
  "IN_APP",
  "EMAIL",
] as const;

export type NotificationPreferenceChannel =
  (typeof NOTIFICATION_PREFERENCE_CHANNELS)[number];

/**
 * Email delivery cadence per preference type. IN_APP rows ignore
 * frequency (in-app is always immediate when enabled). OFF on the EMAIL
 * channel is equivalent to enabled=false for scheduling purposes.
 */
export const NOTIFICATION_FREQUENCIES = [
  "IMMEDIATE",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "OFF",
] as const;

export type NotificationFrequency = (typeof NOTIFICATION_FREQUENCIES)[number];

/**
 * MANDATORY categories in ORGANIZATION workspaces: platform policy keeps
 * governance signals on for every organization member — a user cannot
 * silently opt out of legal-hold / destruction / retention notifications
 * in an org context. Personal workspaces have no organization policy, so
 * the lock does not apply there. Enforced SERVER-SIDE in the PUT route;
 * the GET response marks these `locked` so the UI renders the
 * managed-by-organization state instead of a toggle.
 */
export const MANDATORY_ORG_PREFERENCE_TYPES: ReadonlyArray<NotificationPreferenceType> =
  ["GOVERNANCE_UPDATE"];

/** IANA timezone validation via the runtime's own tz database. */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type NotificationPreferenceProjection = {
  preferenceType: NotificationPreferenceType;
  channel: NotificationPreferenceChannel;
  enabled: boolean;
  frequency: NotificationFrequency;
  updatedAt: string;
};

/**
 * List the caller's preferences for a workspace. Returns explicit
 * rows only — callers should fall back to defaults via
 * `defaultEnabledForChannel()` when a row is absent.
 */
export async function listNotificationPreferences(
  input: { userId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<NotificationPreferenceProjection>> {
  const rows = await client.workspaceNotificationPreference.findMany({
    where: { userId: input.userId, teamId: input.teamId },
    select: {
      preferenceType: true,
      channel: true,
      enabled: true,
      frequency: true,
      updatedAt: true,
    },
  });
  return rows.map((r) => ({
    preferenceType: r.preferenceType as NotificationPreferenceType,
    channel: r.channel as NotificationPreferenceChannel,
    enabled: r.enabled,
    frequency: (r.frequency as NotificationFrequency) ?? "IMMEDIATE",
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * Upsert a single preference. The route layer is responsible for
 * verifying the caller belongs to the workspace + asserting the
 * preferenceType + channel are in the bounded enum.
 */
export async function upsertNotificationPreference(
  input: {
    userId: string;
    teamId: string;
    preferenceType: NotificationPreferenceType;
    channel: NotificationPreferenceChannel;
    enabled: boolean;
    frequency?: NotificationFrequency;
  },
  client: PrismaClient = defaultPrisma,
): Promise<NotificationPreferenceProjection> {
  const row = await client.workspaceNotificationPreference.upsert({
    where: {
      userId_teamId_preferenceType_channel: {
        userId: input.userId,
        teamId: input.teamId,
        preferenceType: input.preferenceType,
        channel: input.channel,
      },
    },
    create: {
      userId: input.userId,
      teamId: input.teamId,
      preferenceType: input.preferenceType,
      channel: input.channel,
      enabled: input.enabled,
      ...(input.frequency ? { frequency: input.frequency } : {}),
    },
    update: {
      enabled: input.enabled,
      ...(input.frequency ? { frequency: input.frequency } : {}),
    },
    select: {
      preferenceType: true,
      channel: true,
      enabled: true,
      frequency: true,
      updatedAt: true,
    },
  });
  return {
    preferenceType: row.preferenceType as NotificationPreferenceType,
    channel: row.channel as NotificationPreferenceChannel,
    enabled: row.enabled,
    frequency: (row.frequency as NotificationFrequency) ?? "IMMEDIATE",
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The default for an absent row. In-app is enabled by default;
 * email is opt-in (must be explicitly enabled).
 */
export function defaultEnabledForChannel(
  channel: NotificationPreferenceChannel,
): boolean {
  return channel === "IN_APP";
}

/**
 * Authoritative "should this user see this notification on this
 * channel right now?" check. Consuming surfaces (inbox aggregator,
 * email dispatcher) call this single function — they never read the
 * preference rows directly.
 */
export async function isPreferenceEnabled(
  input: {
    userId: string;
    teamId: string;
    preferenceType: NotificationPreferenceType;
    channel: NotificationPreferenceChannel;
  },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const row = await client.workspaceNotificationPreference.findUnique({
    where: {
      userId_teamId_preferenceType_channel: {
        userId: input.userId,
        teamId: input.teamId,
        preferenceType: input.preferenceType,
        channel: input.channel,
      },
    },
    select: { enabled: true },
  });
  if (!row) return defaultEnabledForChannel(input.channel);
  return row.enabled;
}

// -----------------------------------------------------------------------------
// Notification schedule settings — quiet hours / timezone / digest state.
// -----------------------------------------------------------------------------

export type NotificationScheduleProjection = {
  teamId: string;
  timezone: string;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  quietCriticalOverride: boolean;
  updatedAt: string | null;
};

const SCHEDULE_DEFAULTS = {
  timezone: "UTC",
  quietHoursEnabled: false,
  quietStartMinute: 22 * 60,
  quietEndMinute: 7 * 60,
  quietCriticalOverride: true,
} as const;

export async function getNotificationSchedule(
  input: { userId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<NotificationScheduleProjection> {
  const row = await client.notificationScheduleSetting.findUnique({
    where: { userId_teamId: { userId: input.userId, teamId: input.teamId } },
  });
  if (!row) {
    return { teamId: input.teamId, ...SCHEDULE_DEFAULTS, updatedAt: null };
  }
  return {
    teamId: input.teamId,
    timezone: row.timezone,
    quietHoursEnabled: row.quietHoursEnabled,
    quietStartMinute: row.quietStartMinute,
    quietEndMinute: row.quietEndMinute,
    quietCriticalOverride: row.quietCriticalOverride,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertNotificationSchedule(
  input: {
    userId: string;
    teamId: string;
    timezone: string;
    quietHoursEnabled: boolean;
    quietStartMinute: number;
    quietEndMinute: number;
    quietCriticalOverride: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<NotificationScheduleProjection> {
  if (!isValidTimezone(input.timezone)) {
    throw new Error("INVALID_TIMEZONE");
  }
  const data = {
    timezone: input.timezone,
    quietHoursEnabled: input.quietHoursEnabled,
    quietStartMinute: Math.min(1439, Math.max(0, Math.floor(input.quietStartMinute))),
    quietEndMinute: Math.min(1439, Math.max(0, Math.floor(input.quietEndMinute))),
    quietCriticalOverride: input.quietCriticalOverride,
  };
  const row = await client.notificationScheduleSetting.upsert({
    where: { userId_teamId: { userId: input.userId, teamId: input.teamId } },
    create: { userId: input.userId, teamId: input.teamId, ...data },
    update: data,
  });
  return {
    teamId: input.teamId,
    timezone: row.timezone,
    quietHoursEnabled: row.quietHoursEnabled,
    quietStartMinute: row.quietStartMinute,
    quietEndMinute: row.quietEndMinute,
    quietCriticalOverride: row.quietCriticalOverride,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Local-time quiet-hours check. Computes the recipient's current local
 * minute-of-day in their IANA timezone and tests it against the window
 * (windows may wrap midnight, e.g. 22:00 → 07:00).
 */
export function isWithinQuietHours(
  schedule: Pick<
    NotificationScheduleProjection,
    "quietHoursEnabled" | "quietStartMinute" | "quietEndMinute" | "timezone"
  >,
  now: Date,
): boolean {
  if (!schedule.quietHoursEnabled) return false;
  let hour = now.getUTCHours();
  let minute = now.getUTCMinutes();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      hour = h % 24;
      minute = m;
    }
  } catch {
    /* invalid tz row (should be prevented by validation) → UTC */
  }
  const local = hour * 60 + minute;
  const start = schedule.quietStartMinute;
  const end = schedule.quietEndMinute;
  if (start === end) return false;
  if (start < end) return local >= start && local < end;
  // Window wraps midnight.
  return local >= start || local < end;
}

/**
 * THE canonical preference-type → event-category mapping. One map for
 * every channel:
 *
 *   * EMAIL/digest — which categories a type's digest covers.
 *   * IN_APP — which categories a type's in-app toggle suppresses
 *     (OPTIONAL types only; see MANDATORY_INAPP_PREFERENCE_TYPES).
 *
 * Bounded and explicit: a category with no mapping here is a
 * system-mandatory operational signal (onboarding, invitations, admin
 * queues, security) that no preference can suppress.
 */
export const PREFERENCE_CATEGORY_MAP: Record<
  NotificationPreferenceType,
  ReadonlyArray<string>
> = {
  MENTION: ["discussion_mention"],
  ASSIGNED_THREAD: ["discussion_assigned", "collaboration"],
  REVIEWER_ASSIGNMENT: ["review_decision", "case_assignment"],
  ESCALATION: ["review_escalation"],
  SLA_NEAR_BREACH: [
    "report_failure",
    "verification_package_failure",
    "ots_failure",
    "tsa_failure",
  ],
  EVIDENCE_REQUEST_UPDATE: [
    "intake_submission_pending_review",
    "intake_required_items_missing",
    "intake_link_expiring",
  ],
  GOVERNANCE_UPDATE: ["governance"],
};

/**
 * IN_APP honesty — preference types whose in-app channel is a PLATFORM
 * floor in every workspace type: evidence-integrity/verification
 * failures and governance duties always surface in the Bell and the
 * Operations Center. Their IN_APP toggles render locked-on; the PUT
 * endpoint rejects disabling them. EMAIL remains user-controllable.
 */
export const MANDATORY_INAPP_PREFERENCE_TYPES: ReadonlyArray<NotificationPreferenceType> =
  ["SLA_NEAR_BREACH", "GOVERNANCE_UPDATE"];

/**
 * Reverse lookup for the aggregation: event category → the OPTIONAL
 * preference type whose IN_APP toggle governs it. Mandatory types are
 * deliberately absent — their categories can never be suppressed.
 */
export const OPTIONAL_INAPP_CATEGORY_TO_TYPE: ReadonlyMap<
  string,
  NotificationPreferenceType
> = new Map(
  (
    Object.entries(PREFERENCE_CATEGORY_MAP) as Array<
      [NotificationPreferenceType, ReadonlyArray<string>]
    >
  )
    .filter(([type]) => !MANDATORY_INAPP_PREFERENCE_TYPES.includes(type))
    .flatMap(([type, categories]) =>
      categories.map((c) => [c, type] as [string, NotificationPreferenceType]),
    ),
);

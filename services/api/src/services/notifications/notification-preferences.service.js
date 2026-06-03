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
import { prisma as defaultPrisma } from "../../db.js";
export const NOTIFICATION_PREFERENCE_TYPES = [
    "MENTION",
    "ASSIGNED_THREAD",
    "REVIEWER_ASSIGNMENT",
    "ESCALATION",
    "SLA_NEAR_BREACH",
    "EVIDENCE_REQUEST_UPDATE",
    "GOVERNANCE_UPDATE",
];
export const NOTIFICATION_PREFERENCE_CHANNELS = [
    "IN_APP",
    "EMAIL",
];
/**
 * List the caller's preferences for a workspace. Returns explicit
 * rows only — callers should fall back to defaults via
 * `defaultEnabledForChannel()` when a row is absent.
 */
export async function listNotificationPreferences(input, client = defaultPrisma) {
    const rows = await client.workspaceNotificationPreference.findMany({
        where: { userId: input.userId, teamId: input.teamId },
        select: {
            preferenceType: true,
            channel: true,
            enabled: true,
            updatedAt: true,
        },
    });
    return rows.map((r) => ({
        preferenceType: r.preferenceType,
        channel: r.channel,
        enabled: r.enabled,
        updatedAt: r.updatedAt.toISOString(),
    }));
}
/**
 * Upsert a single preference. The route layer is responsible for
 * verifying the caller belongs to the workspace + asserting the
 * preferenceType + channel are in the bounded enum.
 */
export async function upsertNotificationPreference(input, client = defaultPrisma) {
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
        },
        update: {
            enabled: input.enabled,
        },
        select: {
            preferenceType: true,
            channel: true,
            enabled: true,
            updatedAt: true,
        },
    });
    return {
        preferenceType: row.preferenceType,
        channel: row.channel,
        enabled: row.enabled,
        updatedAt: row.updatedAt.toISOString(),
    };
}
/**
 * The default for an absent row. In-app is enabled by default;
 * email is opt-in (must be explicitly enabled).
 */
export function defaultEnabledForChannel(channel) {
    return channel === "IN_APP";
}
/**
 * Authoritative "should this user see this notification on this
 * channel right now?" check. Consuming surfaces (inbox aggregator,
 * email dispatcher) call this single function — they never read the
 * preference rows directly.
 */
export async function isPreferenceEnabled(input, client = defaultPrisma) {
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
    if (!row)
        return defaultEnabledForChannel(input.channel);
    return row.enabled;
}

/**
 * Phase G3.1 — Operator notification preferences routes.
 *
 *   GET /v1/me/notification-preferences?teamId=...
 *   PUT /v1/me/notification-preferences
 *
 * Per-(user, workspace, type, channel) toggle list + upsert. The
 * route layer enforces workspace membership; the service layer
 * performs the bounded enum check + persistence.
 *
 * Hard rules:
 *   * Read + write are caller-scoped — the userId is always
 *     `getAuthUserId(req)`. Operators cannot set another user's
 *     preferences.
 *   * Workspace membership gate via `requireMember(teamId)` — 404
 *     for non-members (anti-enumeration).
 *   * Bounded vocabulary via Zod schema. Anything outside the
 *     `NOTIFICATION_PREFERENCE_TYPES` / `NOTIFICATION_PREFERENCE_CHANNELS`
 *     enums is rejected.
 *   * Audit-friendly: every PUT emits a bounded security event so
 *     governance admins can review unusual disable patterns. Reads
 *     emit no audit.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  MANDATORY_INAPP_PREFERENCE_TYPES,
  MANDATORY_ORG_PREFERENCE_TYPES,
  NOTIFICATION_FREQUENCIES,
  NOTIFICATION_PREFERENCE_CHANNELS,
  NOTIFICATION_PREFERENCE_TYPES,
  getNotificationSchedule,
  isValidTimezone,
  listNotificationPreferences,
  upsertNotificationPreference,
  upsertNotificationSchedule,
} from "../services/notifications/notification-preferences.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";

/**
 * Migration-order safety — true ONLY for Prisma's missing-table /
 * missing-column codes (P2021/P2022), i.e. "migration 20270916 not
 * applied here yet". Anything else (connection loss, constraint
 * violations, …) is NOT a schema gap and must keep propagating.
 */
function isMissingScheduleSchema(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "P2021" || code === "P2022";
}

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{
  userId: string;
  isPersonalWorkspace: boolean;
  organizationId: string | null;
} | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { team: { select: { isPersonal: true, organizationId: true } } },
  });
  if (!membership) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const isPersonal = membership.team?.isPersonal === true;
  return {
    userId,
    isPersonalWorkspace: isPersonal,
    organizationId: isPersonal
      ? null
      : (membership.team?.organizationId ?? null),
  };
}

/** Frequency strength — a user may never weaken below the policy minimum. */
const FREQUENCY_RANK: Record<string, number> = {
  IMMEDIATE: 4,
  HOURLY: 3,
  DAILY: 2,
  WEEKLY: 1,
  OFF: 0,
};

type OrgPolicyRow = {
  category: string;
  mandatoryInApp: boolean;
  mandatoryEmail: boolean;
  minimumFrequency: string | null;
};

/**
 * Organization policy rows for the workspace's org. Missing table
 * (pre-migration) degrades to "no org policy" — the platform floor
 * (mandatory governance in-app) still applies.
 */
async function loadOrgPolicy(
  organizationId: string | null,
): Promise<Map<string, OrgPolicyRow>> {
  const map = new Map<string, OrgPolicyRow>();
  if (!organizationId) return map;
  try {
    const rows = await prisma.organizationNotificationPolicy.findMany({
      where: { organizationId },
      select: {
        category: true,
        mandatoryInApp: true,
        mandatoryEmail: true,
        minimumFrequency: true,
      },
    });
    for (const r of rows) map.set(r.category, r);
  } catch {
    /* policy table not migrated yet — platform floor only */
  }
  return map;
}

const PreferenceTypeSchema = z.enum(NOTIFICATION_PREFERENCE_TYPES);
const PreferenceChannelSchema = z.enum(NOTIFICATION_PREFERENCE_CHANNELS);
const FrequencySchema = z.enum(NOTIFICATION_FREQUENCIES);

const PutBody = z.object({
  teamId: z.string().uuid(),
  preferenceType: PreferenceTypeSchema,
  channel: PreferenceChannelSchema,
  enabled: z.boolean(),
  frequency: FrequencySchema.optional(),
});

const SchedulePutBody = z.object({
  teamId: z.string().uuid(),
  // null = NO explicit workspace override; the digest scheduler inherits
  // the account timezone (User.timezone) → UTC.
  timezone: z.string().min(1).max(64).nullable(),
  quietHoursEnabled: z.boolean(),
  quietStartMinute: z.number().int().min(0).max(1439),
  quietEndMinute: z.number().int().min(0).max(1439),
  quietCriticalOverride: z.boolean(),
});

export async function notificationPreferencesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // GET /v1/me/notification-preferences?teamId=...
  //
  // Returns the caller's explicit preference rows for the workspace,
  // plus the bounded vocabulary (so the UI can render all 7 toggles
  // even when no row exists yet).
  // ---------------------------------------------------------------------
  app.get(
    "/v1/me/notification-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      const preferences = await listNotificationPreferences({
        userId: ok.userId,
        teamId: query.teamId,
      });

      // ORGANIZATION policy layer: the platform floor (mandatory
      // governance in-app) plus any org-configured mandatory categories
      // / minimum frequencies. IN_APP-honesty: the PLATFORM in-app
      // floor (evidence-integrity failures + governance duties) locks
      // the in-app channel in EVERY workspace type — Personal included
      // — because these are the alerts a user must never lose sight of.
      const orgPolicy = await loadOrgPolicy(ok.organizationId);
      const lockedTypes = ok.isPersonalWorkspace
        ? [...MANDATORY_INAPP_PREFERENCE_TYPES]
        : [
            ...new Set([
              ...MANDATORY_INAPP_PREFERENCE_TYPES,
              ...MANDATORY_ORG_PREFERENCE_TYPES,
              ...[...orgPolicy.values()]
                .filter((p) => p.mandatoryInApp)
                .map((p) => p.category),
            ]),
          ];
      const emailLockedTypes = ok.isPersonalWorkspace
        ? []
        : [...orgPolicy.values()]
            .filter((p) => p.mandatoryEmail)
            .map((p) => p.category);
      const minimumFrequencyByType: Record<string, string> = {};
      if (!ok.isPersonalWorkspace) {
        for (const p of orgPolicy.values()) {
          if (p.minimumFrequency) {
            minimumFrequencyByType[p.category] = p.minimumFrequency;
          }
        }
      }
      // Drives the org-admin policy card in the settings UI.
      let canManageOrgPolicy = false;
      if (ok.organizationId) {
        const adminRow = await prisma.organizationMembership.findFirst({
          where: {
            userId: ok.userId,
            organizationId: ok.organizationId,
            role: { in: ["ORG_OWNER", "ORG_ADMIN"] },
          },
          select: { id: true },
        });
        canManageOrgPolicy = adminRow !== null;
      }

      return reply.code(200).send({
        teamId: query.teamId,
        preferences,
        lockedTypes,
        emailLockedTypes,
        minimumFrequencyByType,
        organizationId: ok.organizationId,
        canManageOrgPolicy,
        isPersonalWorkspace: ok.isPersonalWorkspace,
        catalog: {
          preferenceTypes: NOTIFICATION_PREFERENCE_TYPES,
          channels: NOTIFICATION_PREFERENCE_CHANNELS,
          frequencies: NOTIFICATION_FREQUENCIES,
          // The defaults the absence of a row implies. Surfaced so
          // the UI doesn't need to duplicate the defaultEnabledForChannel
          // logic.
          defaults: {
            IN_APP: true,
            EMAIL: false,
            frequency: "IMMEDIATE",
          },
        },
      });
    },
  );

  // ---------------------------------------------------------------------
  // PUT /v1/me/notification-preferences
  //
  // Upserts a single preference toggle. The route enforces workspace
  // membership; the service enforces bounded vocabulary.
  // ---------------------------------------------------------------------
  app.put(
    "/v1/me/notification-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = PutBody.parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;

      // PLATFORM in-app floor — evidence-integrity failures and
      // governance duties always surface in the app, in EVERY workspace
      // type. EMAIL for the same types stays user-controllable.
      if (
        body.channel === "IN_APP" &&
        body.enabled === false &&
        MANDATORY_INAPP_PREFERENCE_TYPES.includes(body.preferenceType)
      ) {
        return reply.code(403).send({
          error: {
            code: "policy_locked",
            reason:
              "Critical evidence-integrity and governance alerts always appear in the app and cannot be turned off.",
          },
        });
      }

      // ORGANIZATION policy lock — enforced HERE, server-side; the UI
      // lock is cosmetic. Personal workspaces have no organization
      // policy. The platform floor (mandatory governance in-app) applies
      // even without configured policy rows.
      if (!ok.isPersonalWorkspace) {
        const orgPolicy = await loadOrgPolicy(ok.organizationId);
        const policy = orgPolicy.get(body.preferenceType);
        const platformFloor = MANDATORY_ORG_PREFERENCE_TYPES.includes(
          body.preferenceType,
        );
        const inAppLocked =
          body.channel === "IN_APP" && (platformFloor || policy?.mandatoryInApp);
        const emailLocked = body.channel === "EMAIL" && policy?.mandatoryEmail;
        const disabling = body.enabled === false || body.frequency === "OFF";
        if (disabling && (inAppLocked || emailLocked || platformFloor)) {
          return reply.code(403).send({
            error: {
              code: "policy_locked",
              reason:
                "This notification category is managed by your organization and cannot be disabled.",
            },
          });
        }
        // Minimum cadence — the user may strengthen but never weaken.
        if (
          body.frequency &&
          policy?.minimumFrequency &&
          (FREQUENCY_RANK[body.frequency] ?? 0) <
            (FREQUENCY_RANK[policy.minimumFrequency] ?? 0)
        ) {
          return reply.code(403).send({
            error: {
              code: "policy_locked",
              reason: `Your organization requires at least ${policy.minimumFrequency.toLowerCase()} delivery for this category.`,
            },
          });
        }
      }

      const result = await upsertNotificationPreference({
        userId: ok.userId,
        teamId: body.teamId,
        preferenceType: body.preferenceType,
        channel: body.channel,
        enabled: body.enabled,
        frequency: body.frequency,
      });

      // Audit emission — bounded, no PII. Governance admins can
      // notice unusual disable patterns (e.g. a reviewer disabling
      // ESCALATION emails right before an incident).
      safeEmitSecurityEvent({
        teamId: body.teamId,
        eventType: "notification_preference_updated",
        severity: "INFO",
        details: {
          preferenceType: body.preferenceType,
          channel: body.channel,
          enabled: body.enabled,
          frequency: body.frequency ?? null,
        },
      });

      return reply.code(200).send({ preference: result });
    },
  );

  // ---------------------------------------------------------------------
  // GET /v1/me/notification-schedule?teamId=...
  // PUT /v1/me/notification-schedule
  //
  // Quiet hours + IANA timezone + critical-override, per (user,
  // workspace). Caller-scoped; membership-gated (404 anti-enumeration).
  //
  // Migration-order safety: the backing table ships in migration
  // 20270916. On an environment where that migration has not been
  // applied yet, Prisma raises P2021/P2022 — we answer a TYPED 503
  // (`notification_schedule_unavailable`) instead of an unstructured
  // 500, and ONLY for those two codes; every other database error
  // still propagates unchanged.
  // ---------------------------------------------------------------------
  app.get(
    "/v1/me/notification-schedule",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      let schedule;
      try {
        schedule = await getNotificationSchedule({
          userId: ok.userId,
          teamId: query.teamId,
        });
      } catch (err) {
        if (isMissingScheduleSchema(err)) {
          return reply.code(503).send({
            error: {
              code: "notification_schedule_unavailable",
              reason:
                "Notification schedule storage is not provisioned in this environment yet.",
            },
          });
        }
        throw err;
      }
      return reply.code(200).send({ schedule });
    },
  );

  app.put(
    "/v1/me/notification-schedule",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = SchedulePutBody.parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      if (body.timezone !== null && !isValidTimezone(body.timezone)) {
        return reply.code(400).send({
          error: {
            code: "invalid_timezone",
            reason: "timezone must be a valid IANA timezone name.",
          },
        });
      }
      let schedule;
      try {
        schedule = await upsertNotificationSchedule({
          userId: ok.userId,
          teamId: body.teamId,
          timezone: body.timezone,
          quietHoursEnabled: body.quietHoursEnabled,
          quietStartMinute: body.quietStartMinute,
          quietEndMinute: body.quietEndMinute,
          quietCriticalOverride: body.quietCriticalOverride,
        });
      } catch (err) {
        if (isMissingScheduleSchema(err)) {
          return reply.code(503).send({
            error: {
              code: "notification_schedule_unavailable",
              reason:
                "Notification schedule storage is not provisioned in this environment yet. Nothing was saved.",
            },
          });
        }
        throw err;
      }
      safeEmitSecurityEvent({
        teamId: body.teamId,
        eventType: "notification_preference_updated",
        severity: "INFO",
        details: {
          schedule: true,
          quietHoursEnabled: body.quietHoursEnabled,
          timezone: body.timezone,
        },
      });
      return reply.code(200).send({ schedule });
    },
  );
}

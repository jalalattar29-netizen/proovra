/**
 * Operations-Center completion — preferences, quiet hours, timezone,
 * organization policy locks, and the digest scheduler.
 *
 *   1. Quiet-hours math: recipient-local minutes, midnight-wrapping
 *      windows, timezone boundaries.
 *   2. Timezone validation: IANA-only.
 *   3. PUT preferences: ORGANIZATION workspaces reject disabling a
 *      mandatory governance category (403 policy_locked); PERSONAL
 *      workspaces have no organization policy and may disable it.
 *   4. Digest scheduler: due/not-due cadences, empty batches advance the
 *      bookkeeping without sending, quiet-hours deferral + critical
 *      override, idempotent bucket claim, tenant/user scoping of the
 *      snapshot query, delivery through the existing pipeline.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  userId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  role: "MEMBER" as string,
  isPersonal: false,
  prefUpserts: [] as Array<Record<string, unknown>>,
  scheduleRow: null as Record<string, unknown> | null,
  scheduleWrites: [] as Array<Record<string, unknown>>,
  digestPrefs: [] as Array<Record<string, unknown>>,
  collabRows: [] as Array<Record<string, unknown>>,
  governanceRows: [] as Array<Record<string, unknown>>,
  stateRows: [] as Array<Record<string, unknown>>,
  snapshotCreates: [] as Array<Record<string, unknown>>,
  staleSnapshotIds: [] as string[],
  scheduleSchemaMissing: false,
  scheduleGenericError: false,
  inAppDisabledTypes: [] as string[],
  snapshotDeletes: [] as string[],
  orgAdminRole: null as string | null,
  orgPolicyRows: [] as Array<Record<string, unknown>>,
  orgPolicyWrites: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

const DIGEST = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));

vi.mock("../src/db.js", () => {
  const genericModel = {
    findMany: async () => [],
    findUnique: async () => null,
    findFirst: async () => null,
    count: async () => 0,
    groupBy: async () => [],
    updateMany: async () => ({ count: 0 }),
    createMany: async () => ({ count: 0 }),
  };
  const overrides: Record<string, unknown> = {
    user: {
      findUnique: async () => ({
        id: H.userId,
        email: "op@example.com",
        displayName: "Operator",
      }),
    },
    organizationMembership: {
      findMany: async () => [],
      findFirst: async () => (H.orgAdminRole ? { id: "m-1" } : null),
    },
    organizationNotificationPolicy: {
      findMany: async () => H.orgPolicyRows,
      upsert: async (args: { create: Record<string, unknown> }) => {
        H.orgPolicyWrites.push(args.create);
        return {
          category: args.create.category,
          mandatoryInApp: args.create.mandatoryInApp,
          mandatoryEmail: args.create.mandatoryEmail,
          minimumFrequency: args.create.minimumFrequency ?? null,
          quietHoursCriticalOverride: args.create.quietHoursCriticalOverride,
          policyVersion: 1,
          updatedAt: new Date(),
        };
      },
    },
    team: {
      findMany: async () => [],
      findUnique: async () => ({ name: "Workspace A" }),
    },
    teamMember: {
      findUnique: async () => ({
        team: {
          isPersonal: H.isPersonal,
          organizationId: H.isPersonal ? null : "55555555-5555-4555-8555-555555555555",
        },
        teamId: H.teamId,
        userId: H.userId,
        role: H.role,
      }),
      findMany: async ({ select }: { select?: Record<string, unknown> }) =>
        select && "team" in select
          ? [{ team: { id: H.teamId, name: "Workspace A" } }]
          : [{ teamId: H.teamId, role: H.role }],
    },
    collaborationTeamNotification: {
      findMany: async () => H.collabRows,
      updateMany: async () => ({ count: 1 }),
    },
    governanceNotification: { findMany: async () => H.governanceRows },
    inboxItemState: {
      findMany: async ({ where }: { where: { itemKey: { in: string[] } } }) =>
        H.stateRows.filter((r) =>
          where.itemKey.in.includes(r.itemKey as string),
        ),
      upsert: async (args: { create: Record<string, unknown> }) => args.create,
      createMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    operationsInboxSnapshot: {
      findFirst: async () => null,
      findMany: async ({
        where,
      }: { where?: { lastSeenAtUtc?: { lt?: Date } } } = {}) =>
        // Retention prune queries by lastSeenAtUtc cutoff; everything
        // else (sync lookups) sees an empty store in this suite.
        where?.lastSeenAtUtc?.lt
          ? H.staleSnapshotIds.map((id) => ({ id }))
          : [],
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        H.snapshotCreates.push(...args.data);
        return { count: args.data.length };
      },
      updateMany: async () => ({ count: 1 }),
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        H.snapshotDeletes.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      },
    },
    workspaceNotificationPreference: {
      // Serves BOTH the preferences GET (userId+teamId where) and the
      // digest scheduler's cadence query (channel EMAIL where).
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        where && "channel" in where ? H.digestPrefs : [],
      // IN_APP verdict lookups from the aggregation's annotation pass.
      // Types listed in H.inAppDisabledTypes read as explicitly
      // disabled; everything else falls to the channel default.
      findUnique: async ({
        where,
      }: {
        where: {
          userId_teamId_preferenceType_channel: {
            preferenceType: string;
            channel: string;
          };
        };
      }) => {
        const k = where.userId_teamId_preferenceType_channel;
        if (
          k.channel === "IN_APP" &&
          H.inAppDisabledTypes.includes(k.preferenceType)
        ) {
          return { enabled: false };
        }
        return null;
      },
      upsert: async (args: { create: Record<string, unknown> }) => {
        H.prefUpserts.push(args.create);
        return {
          preferenceType: args.create.preferenceType,
          channel: args.create.channel,
          enabled: args.create.enabled,
          frequency: args.create.frequency ?? "IMMEDIATE",
          updatedAt: new Date(),
        };
      },
    },
    notificationScheduleSetting: {
      // Migration-order probe + honest 503s: when the schema is
      // "missing", every access raises Prisma's P2021; a generic
      // failure raises a code-less error (must NOT be misclassified).
      findFirst: async () => {
        if (H.scheduleSchemaMissing) throw { code: "P2021" };
        if (H.scheduleGenericError) throw new Error("db exploded");
        return null;
      },
      findUnique: async () => {
        if (H.scheduleSchemaMissing) throw { code: "P2021" };
        if (H.scheduleGenericError) throw new Error("db exploded");
        return H.scheduleRow;
      },
      // Conditional-claim semantics mirroring Postgres.
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!H.scheduleRow) return { count: 0 };
        const field = Object.keys(args.data)[0]!;
        const cond = args.where[field];
        const current =
          (H.scheduleRow as Record<string, Date | null>)[field] ?? null;
        let matches = false;
        if (cond === null) matches = current === null;
        else if (cond && typeof cond === "object" && "lte" in (cond as object)) {
          matches = current !== null && current <= (cond as { lte: Date }).lte;
        }
        if (!matches) return { count: 0 };
        H.scheduleRow = { ...H.scheduleRow, ...args.data };
        H.scheduleWrites.push(args.data);
        return { count: 1 };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        if (H.scheduleRow) throw new Error("unique violation");
        H.scheduleRow = args.data;
        H.scheduleWrites.push(args.data);
        return H.scheduleRow;
      },
      upsert: async (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (H.scheduleSchemaMissing) throw { code: "P2021" };
        H.scheduleRow = H.scheduleRow
          ? { ...H.scheduleRow, ...args.update }
          : { ...args.create };
        H.scheduleWrites.push(args.update);
        return {
          timezone: args.update.timezone ?? "UTC",
          quietHoursEnabled: args.update.quietHoursEnabled ?? false,
          quietStartMinute: args.update.quietStartMinute ?? 1320,
          quietEndMinute: args.update.quietEndMinute ?? 420,
          quietCriticalOverride: args.update.quietCriticalOverride ?? true,
          updatedAt: new Date(),
        };
      },
    },
  };
  const prisma = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$transaction") {
          return async (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
              : Promise.all(arg as Array<Promise<unknown>>);
        }
        if (prop in overrides) return overrides[prop];
        return genericModel;
      },
    },
  ) as Record<string, unknown>;
  return { prisma };
});
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => undefined }));
vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.userId }));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: () => undefined,
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (entry: Record<string, unknown>) => {
    H.audits.push(entry);
  },
}));
vi.mock("../src/middleware/cron-secret.js", () => ({
  requireNotificationCronSecret: async () => true,
}));
vi.mock("../src/services/notifications/reminder-scheduler.js", () => ({
  runReminderScheduler: async () => ({}),
}));

import { notificationPreferencesRoutes } from "../src/routes/notification-preferences.routes.js";
import {
  isValidTimezone,
  isWithinQuietHours,
} from "../src/services/notifications/notification-preferences.service.js";
import { runDigestScheduler } from "../src/services/notifications/digest-scheduler.js";

// The email pipeline is module-mocked so digest sends are observable;
// the delivery-log surface is stubbed for the authorization tests.
vi.mock("../src/services/notifications/index.js", () => ({
  listNotificationDeliveries: async () => [],
  getNotificationDelivery: async () => null,
  projectNotificationDelivery: (row: unknown) => row,
  resendNotificationDelivery: async () => ({ ok: true }),
  processDueNotificationRetries: async () => ({}),
  sendEmailNotification: async () => undefined,
  safeSendEmailNotification: async (input: Record<string, unknown>) => {
    DIGEST.sent.push(input);
    return { status: "sent" };
  },
}));

async function buildApp(routes: (app: FastifyInstance) => Promise<void>) {
  const app = Fastify();
  await app.register(routes);
  await app.ready();
  return app;
}

beforeEach(() => {
  H.isPersonal = false;
  H.role = "MEMBER";
  H.prefUpserts.length = 0;
  H.scheduleRow = null;
  H.scheduleWrites.length = 0;
  H.digestPrefs = [];
  H.collabRows = [];
  H.governanceRows = [];
  H.stateRows = [];
  H.snapshotCreates.length = 0;
  H.staleSnapshotIds.length = 0;
  H.scheduleSchemaMissing = false;
  H.scheduleGenericError = false;
  H.inAppDisabledTypes.length = 0;
  H.snapshotDeletes.length = 0;
  H.orgAdminRole = null;
  H.orgPolicyRows = [];
  H.orgPolicyWrites.length = 0;
  H.audits.length = 0;
  DIGEST.sent.length = 0;
});

// ===========================================================================
// 1. Quiet hours + timezone math.
// ===========================================================================
describe("Quiet hours — recipient-local, midnight-wrapping", () => {
  const base = {
    quietHoursEnabled: true,
    quietStartMinute: 22 * 60, // 22:00
    quietEndMinute: 7 * 60, // 07:00
  };

  it("inside a wrapping window (23:00 UTC) → quiet", () => {
    expect(
      isWithinQuietHours(
        { ...base, timezone: "UTC" },
        new Date("2026-07-13T23:00:00Z"),
      ),
    ).toBe(true);
  });

  it("early morning inside the wrap (03:00 UTC) → quiet; midday → not quiet", () => {
    expect(
      isWithinQuietHours({ ...base, timezone: "UTC" }, new Date("2026-07-13T03:00:00Z")),
    ).toBe(true);
    expect(
      isWithinQuietHours({ ...base, timezone: "UTC" }, new Date("2026-07-13T12:00:00Z")),
    ).toBe(false);
  });

  it("timezone boundary: 23:00 UTC is 01:00 in Berlin (quiet) but 18:00 in New York (not quiet)", () => {
    const at = new Date("2026-07-13T23:00:00Z");
    expect(isWithinQuietHours({ ...base, timezone: "Europe/Berlin" }, at)).toBe(true);
    expect(isWithinQuietHours({ ...base, timezone: "America/New_York" }, at)).toBe(false);
  });

  it("disabled quiet hours never suppress", () => {
    expect(
      isWithinQuietHours(
        { ...base, quietHoursEnabled: false, timezone: "UTC" },
        new Date("2026-07-13T23:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("Timezone validation — IANA only", () => {
  it("accepts real IANA names and rejects junk", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Mars/OlympusMons")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("GMT+25")).toBe(false);
  });
});

// ===========================================================================
// 2. Organization policy locks + schedule endpoint validation.
// ===========================================================================
describe("Preference routes — organization policy locks", () => {
  it("ORG workspace: disabling the mandatory governance category → 403 policy_locked", async () => {
    H.isPersonal = false;
    const app = await buildApp(notificationPreferencesRoutes);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "GOVERNANCE_UPDATE",
        channel: "IN_APP",
        enabled: false,
      },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("policy_locked");
    expect(H.prefUpserts.length).toBe(0); // nothing persisted
  });

  it("ORG workspace: frequency OFF on the mandatory category is also locked", async () => {
    const app = await buildApp(notificationPreferencesRoutes);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "GOVERNANCE_UPDATE",
        channel: "EMAIL",
        enabled: true,
        frequency: "OFF",
      },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it("PERSONAL workspace: platform in-app floor now applies (remediation 2026-07-14) — GOVERNANCE_UPDATE IN_APP cannot be disabled, but an OPTIONAL type saves", async () => {
    H.isPersonal = true;
    const app = await buildApp(notificationPreferencesRoutes);
    const locked = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "GOVERNANCE_UPDATE",
        channel: "IN_APP",
        enabled: false,
      },
    });
    expect(locked.statusCode).toBe(403);
    // Optional types stay freely controllable in Personal.
    const optional = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "MENTION",
        channel: "IN_APP",
        enabled: false,
      },
    });
    await app.close();
    expect(optional.statusCode).toBe(200);
    expect(H.prefUpserts.length).toBe(1);
  });

  it("GET marks org+platform locks for ORG workspaces and the platform floor for PERSONAL", async () => {
    const app = await buildApp(notificationPreferencesRoutes);
    const org = await app.inject({
      method: "GET",
      url: `/v1/me/notification-preferences?teamId=${H.teamId}`,
    });
    expect(JSON.parse(org.body).lockedTypes).toContain("GOVERNANCE_UPDATE");
    H.isPersonal = true;
    const personal = await app.inject({
      method: "GET",
      url: `/v1/me/notification-preferences?teamId=${H.teamId}`,
    });
    await app.close();
    // Remediation 2026-07-14 — the PLATFORM in-app floor applies in
    // Personal too (integrity failures + governance duties).
    expect(JSON.parse(personal.body).lockedTypes).toEqual([
      "SLA_NEAR_BREACH",
      "GOVERNANCE_UPDATE",
    ]);
    expect(JSON.parse(personal.body).isPersonalWorkspace).toBe(true);
  });

  it("schedule PUT rejects a non-IANA timezone (400) and accepts a valid one", async () => {
    const app = await buildApp(notificationPreferencesRoutes);
    const bad = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-schedule",
      payload: {
        teamId: H.teamId,
        timezone: "Mars/OlympusMons",
        quietHoursEnabled: true,
        quietStartMinute: 1320,
        quietEndMinute: 420,
        quietCriticalOverride: true,
      },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-schedule",
      payload: {
        teamId: H.teamId,
        timezone: "Europe/Berlin",
        quietHoursEnabled: true,
        quietStartMinute: 1320,
        quietEndMinute: 420,
        quietCriticalOverride: true,
      },
    });
    await app.close();
    expect(good.statusCode).toBe(200);
    expect(H.scheduleWrites.length).toBe(1);
  });
});

// ===========================================================================
// 3. Digest scheduler — injected in-memory client, no module mocks.
// ===========================================================================
// 3. Digest scheduler — runs the CANONICAL aggregation (no UI-visit
//    dependency, no second aggregator).
// ===========================================================================

const NOON = new Date("2026-07-13T12:00:00Z");

function seedCollabSource(teamId: string = H.teamId) {
  H.collabRows = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: teamId,
      teamId: null,
      type: "DISCUSSION_REPLY",
      title: "New reply in your team discussion",
      body: "A teammate replied.",
      readAt: null,
      createdAt: new Date("2026-07-13T10:00:00Z"),
    },
  ];
}

const HOURLY_ASSIGNED_PREF = () => [
  {
    userId: H.userId,
    teamId: H.teamId,
    preferenceType: "ASSIGNED_THREAD", // maps to collaboration category
    frequency: "HOURLY",
  },
];

describe("Digest — canonical aggregation source (user NEVER opened the app)", () => {
  it("sends the authorized items with zero pre-existing snapshots and accrues history", async () => {
    seedCollabSource();
    H.digestPrefs = HOURLY_ASSIGNED_PREF();
    const summary = await runDigestScheduler({ now: NOON });
    expect(summary.digestsSent).toBe(1);
    const sent = DIGEST.sent[0] as {
      eventType: string;
      teamId: string;
      recipientUserId: string;
      template: { kind: string; data: { items: Array<{ title: string }> } };
    };
    expect(sent.eventType).toBe("OPERATIONS_DIGEST");
    expect(sent.teamId).toBe(H.teamId);
    expect(sent.recipientUserId).toBe(H.userId);
    expect(sent.template.data.items[0].title).toContain("New reply");
    // History accrued during the digest run — no UI visit ever happened.
    expect(
      H.snapshotCreates.some(
        (s) => s.itemKey === "collaboration:33333333-3333-4333-8333-333333333333",
      ),
    ).toBe(true);
  });

  it("cross-workspace items NEVER leak into another workspace's digest group", async () => {
    // Source lives in ANOTHER workspace the user belongs to; the digest
    // group is for H.teamId → batch must be empty (bookkeeping advances,
    // nothing sent).
    seedCollabSource("99999999-9999-4999-8999-999999999999");
    H.digestPrefs = HOURLY_ASSIGNED_PREF();
    const summary = await runDigestScheduler({ now: NOON });
    expect(summary.digestsSent).toBe(0);
    expect(summary.skippedEmpty).toBe(1);
    expect(DIGEST.sent.length).toBe(0);
  });

  it("admin-only sources stay out of a MEMBER's digest even when rows exist", async () => {
    // MFA queue rows exist in the double only via role-gated aggregation
    // (adjudicatorTeamIds) — as MEMBER the source query never runs, so
    // no mfa category can enter the batch.
    H.role = "MEMBER";
    seedCollabSource();
    H.digestPrefs = HOURLY_ASSIGNED_PREF();
    await runDigestScheduler({ now: NOON });
    const sent = DIGEST.sent[0] as {
      template: { data: { items: Array<{ category: string }> } };
    };
    for (const item of sent.template.data.items) {
      expect(item.category).not.toBe("mfa_recovery_pending");
    }
  });

  it("dismissed items are EXCLUDED from the digest batch", async () => {
    seedCollabSource();
    H.digestPrefs = HOURLY_ASSIGNED_PREF();
    H.stateRows = [
      {
        itemKey: "collaboration:33333333-3333-4333-8333-333333333333",
        readAt: null,
        dismissedAt: new Date("2026-07-13T11:00:00Z"),
        snoozedUntil: null,
      },
    ];
    const summary = await runDigestScheduler({ now: NOON });
    expect(summary.digestsSent).toBe(0);
    expect(DIGEST.sent.length).toBe(0);
  });

  it("not due yet → skipped; duplicate run in the same window sends nothing (idempotent claim)", async () => {
    seedCollabSource();
    H.digestPrefs = HOURLY_ASSIGNED_PREF();
    const first = await runDigestScheduler({ now: NOON });
    expect(first.digestsSent).toBe(1);
    const second = await runDigestScheduler({ now: NOON });
    expect(second.digestsSent).toBe(0);
    expect(second.skippedNotDue).toBe(1);
    expect(DIGEST.sent.length).toBe(1);
  });

  it("quiet hours DEFER routine items; PROOVRA-critical governance overrides when allowed", async () => {
    // Routine collaboration item during all-day quiet hours → deferred
    // even with the override on (its tone is never critical).
    seedCollabSource();
    H.digestPrefs = HOURLY_ASSIGNED_PREF();
    H.scheduleRow = {
      timezone: "UTC",
      quietHoursEnabled: true,
      quietStartMinute: 0,
      quietEndMinute: 1439,
      quietCriticalOverride: true,
      lastHourlyDigestAt: null,
    };
    const deferred = await runDigestScheduler({ now: NOON });
    expect(deferred.deferredQuietHours).toBe(1);
    expect(DIGEST.sent.length).toBe(0);

    // CRITICAL governance item + override → sends despite quiet hours.
    H.collabRows = [];
    H.governanceRows = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        teamId: H.teamId,
        kind: "LEGAL_HOLD_PLACED",
        severity: "CRITICAL",
        lastSeenAtUtc: new Date("2026-07-13T11:30:00Z"),
        occurrenceCount: 1,
        metadata: {},
      },
    ];
    H.digestPrefs = [
      {
        userId: H.userId,
        teamId: H.teamId,
        preferenceType: "GOVERNANCE_UPDATE",
        frequency: "HOURLY",
      },
    ];
    const sent = await runDigestScheduler({ now: NOON });
    expect(sent.digestsSent).toBe(1);
    expect(
      (DIGEST.sent[0] as { template: { data: { items: Array<{ severity: string }> } } })
        .template.data.items[0].severity,
    ).toBe("critical");
  });
});

// ===========================================================================
// 4. Organization notification policy — authorization + enforcement.
// ===========================================================================

import { orgNotificationPolicyRoutes } from "../src/routes/org-notification-policy.routes.js";

describe("Organization notification policy — authorized surface, enforced floors", () => {
  const ORG_ID = "55555555-5555-4555-8555-555555555555";

  it("non-admin org member (and personal users) get 403 on GET and PUT", async () => {
    H.orgAdminRole = null; // no ORG_OWNER/ORG_ADMIN membership
    const app = await buildApp(orgNotificationPolicyRoutes);
    const get = await app.inject({
      method: "GET",
      url: `/v1/orgs/${ORG_ID}/notification-policy`,
    });
    expect(get.statusCode).toBe(403);
    const put = await app.inject({
      method: "PUT",
      url: `/v1/orgs/${ORG_ID}/notification-policy`,
      payload: {
        category: "GOVERNANCE_UPDATE",
        mandatoryInApp: true,
        mandatoryEmail: false,
        quietHoursCriticalOverride: true,
      },
    });
    await app.close();
    expect(put.statusCode).toBe(403);
    expect(H.orgPolicyWrites.length).toBe(0);
  });

  it("ORG_ADMIN can write policy; the change is audited and versioned", async () => {
    H.orgAdminRole = "ORG_ADMIN";
    const app = await buildApp(orgNotificationPolicyRoutes);
    const put = await app.inject({
      method: "PUT",
      url: `/v1/orgs/${ORG_ID}/notification-policy`,
      payload: {
        category: "ESCALATION",
        mandatoryInApp: true,
        mandatoryEmail: true,
        minimumFrequency: "DAILY",
        quietHoursCriticalOverride: true,
      },
    });
    await app.close();
    expect(put.statusCode).toBe(200);
    expect(H.orgPolicyWrites.length).toBe(1);
    expect(H.audits.some((a) => a.action === "org.notification_policy_updated")).toBe(true);
  });

  it("PUT preferences enforces policy minimum frequency + org mandatory email", async () => {
    // The workspace's org has a policy: ESCALATION mandatory email +
    // minimum DAILY.
    H.orgPolicyRows = [
      {
        category: "ESCALATION",
        mandatoryInApp: false,
        mandatoryEmail: true,
        minimumFrequency: "DAILY",
      },
    ];
    const app = await buildApp(notificationPreferencesRoutes);
    // Weakening below the minimum → 403.
    const weak = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "ESCALATION",
        channel: "EMAIL",
        enabled: true,
        frequency: "WEEKLY",
      },
    });
    expect(weak.statusCode).toBe(403);
    // Disabling a mandatory-email category → 403.
    const disable = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "ESCALATION",
        channel: "EMAIL",
        enabled: false,
      },
    });
    expect(disable.statusCode).toBe(403);
    // Meeting the minimum saves.
    const ok = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "ESCALATION",
        channel: "EMAIL",
        enabled: true,
        frequency: "HOURLY",
      },
    });
    await app.close();
    expect(ok.statusCode).toBe(200);
    // GET exposes the locks + minimum for the UI.
    const app2 = await buildApp(notificationPreferencesRoutes);
    const get = await app2.inject({
      method: "GET",
      url: `/v1/me/notification-preferences?teamId=${H.teamId}`,
    });
    await app2.close();
    const body = JSON.parse(get.body);
    expect(body.emailLockedTypes).toContain("ESCALATION");
    expect(body.minimumFrequencyByType.ESCALATION).toBe("DAILY");
  });
});

// ===========================================================================
// 5. Delivery log — personal workspaces are denied the global log.
// ===========================================================================

import { notificationsRoutes } from "../src/routes/notifications.routes.js";

describe("Delivery log — organization operations surface only", () => {
  it("a PERSONAL workspace owner is denied the global delivery log (403)", async () => {
    H.isPersonal = true;
    H.role = "OWNER";
    const app = await buildApp(notificationsRoutes);
    const res = await app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries?teamId=${H.teamId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("organization operations surface");
  });

  it("an ORGANIZATION workspace ADMIN can list deliveries", async () => {
    H.isPersonal = false;
    H.role = "ADMIN";
    const app = await buildApp(notificationsRoutes);
    const res = await app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries?teamId=${H.teamId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });
});

// ===========================================================================
// 6. Summary-cache correctness — MUTATION-path invalidation only.
//
// Product-reset decision: event-writer invalidation (6 API hooks + the
// worker Redis module) was DELETED. The 45s summary TTL is the refresh
// path for NEW events; user mutations (read/dismiss/snooze/bulk) still
// invalidate so the badge never disagrees with an action the user just
// took. Writers must therefore contain NO invalidation calls.
// ===========================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getCachedOperationsSummary,
  invalidateOperationsSummary,
  setCachedOperationsSummary,
} from "../src/services/notifications/operations-summary-cache.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
}

describe("Summary cache — mutation-path invalidation, TTL for event freshness", () => {
  it("set → invalidate → next read recomputes (memory-fallback parity with Redis del)", async () => {
    await setCachedOperationsSummary("cache-user-1", JSON.stringify({ unread: 7 }));
    expect(await getCachedOperationsSummary("cache-user-1")).not.toBeNull();
    await invalidateOperationsSummary("cache-user-1");
    expect(await getCachedOperationsSummary("cache-user-1")).toBeNull();
    // Isolation: another user's entry is untouched by the invalidation.
    await setCachedOperationsSummary("cache-user-2", JSON.stringify({ unread: 1 }));
    await invalidateOperationsSummary("cache-user-1");
    expect(await getCachedOperationsSummary("cache-user-2")).not.toBeNull();
    await invalidateOperationsSummary("cache-user-2");
  });

  it("event writers contain NO cache invalidation (deleted layer must not creep back)", () => {
    const FORMER_WRITERS = [
      "../src/services/collaboration/discussion.service.ts",
      "../src/services/collaboration-team/collaboration-completion.service.ts",
      "../src/services/reviewer-ops/escalation-engine.service.ts",
      "../src/services/governance-lifecycle/governance-notification.service.ts",
      "../src/services/security/mfa-recovery-request.service.ts",
      "../src/routes/organizations.routes.ts",
      "../src/services/evidence-complete.service.ts",
    ];
    for (const file of FORMER_WRITERS) {
      const src = readSource(file);
      expect(
        src.includes("invalidateOperationsSummary"),
        `${file} must not reference the summary cache`,
      ).toBe(false);
    }
  });

  it("mutation endpoints still invalidate the caller's summary", () => {
    const src = readSource("../src/routes/me-inbox.routes.ts");
    expect(src).toContain("await invalidateOperationsSummary(userId)");
  });
});

// ===========================================================================
// 7. Operational-history retention — snapshots are attention records,
//    pruned OPERATIONS_SNAPSHOT_RETENTION_DAYS after last live sighting.
//    The sweep rides the digest cron (no dedicated scheduler).
// ===========================================================================

describe("Snapshot retention — bounded prune on the digest run", () => {
  it("digest run deletes stale snapshots and reports the count", async () => {
    H.staleSnapshotIds.push("snap-old-1", "snap-old-2");
    const summary = await runDigestScheduler({
      now: new Date("2027-01-10T12:00:00Z"),
    });
    expect(summary.snapshotsPruned).toBe(2);
    expect(H.snapshotDeletes).toEqual(["snap-old-1", "snap-old-2"]);
  });

  it("no stale rows → prune is a no-op", async () => {
    const summary = await runDigestScheduler({
      now: new Date("2027-01-10T12:00:00Z"),
    });
    expect(summary.snapshotsPruned).toBe(0);
    expect(H.snapshotDeletes).toEqual([]);
  });
});

// ===========================================================================
// 8. Migration-order safety — schedule schema missing (pre-20270916).
//    Typed 503s on the schedule API; the digest run REFUSES (zero sends,
//    zero watermark advancement); generic DB errors are never
//    misclassified as a schema gap.
// ===========================================================================

describe("Migration-order safety — schedule schema", () => {
  it("schedule GET: P2021 → typed 503 notification_schedule_unavailable", async () => {
    H.scheduleSchemaMissing = true;
    const app = await buildApp(notificationPreferencesRoutes);
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/notification-schedule?teamId=${H.teamId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe(
      "notification_schedule_unavailable",
    );
  });

  it("schedule GET: a generic database failure is NOT misclassified (500, not 503)", async () => {
    H.scheduleGenericError = true;
    const app = await buildApp(notificationPreferencesRoutes);
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/notification-schedule?teamId=${H.teamId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(500);
  });

  it("schedule PUT: P2021 → typed 503; nothing claims to be saved", async () => {
    H.scheduleSchemaMissing = true;
    const app = await buildApp(notificationPreferencesRoutes);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-schedule",
      payload: {
        teamId: H.teamId,
        timezone: "Europe/Berlin",
        quietHoursEnabled: true,
        quietStartMinute: 1320,
        quietEndMinute: 420,
        quietCriticalOverride: true,
      },
    });
    await app.close();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe(
      "notification_schedule_unavailable",
    );
    expect(H.scheduleWrites.length).toBe(0);
  });

  it("digest run refuses when the schema is missing: zero sends, zero watermarks, structured reason", async () => {
    H.scheduleSchemaMissing = true;
    H.digestPrefs = [
      {
        userId: H.userId,
        teamId: H.teamId,
        preferenceType: "MENTION",
        frequency: "DAILY",
      },
    ];
    const summary = await runDigestScheduler({
      now: new Date("2027-01-10T12:00:00Z"),
    });
    expect(summary.unavailableReason).toBe("schedule_schema_missing");
    expect(summary.digestsSent).toBe(0);
    expect(summary.groupsConsidered).toBe(0);
    expect(DIGEST.sent.length).toBe(0);
    expect(H.scheduleWrites.length).toBe(0); // no watermark advancement
  });

  it("cron endpoint surfaces a refused run as 503 (secret enforcement unchanged)", async () => {
    H.scheduleSchemaMissing = true;
    const app = await buildApp(notificationsRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/v1/notifications/run-digests",
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("digest_unavailable");
    expect(body.summary.digestsSent).toBe(0);
  });

  it("schema present → digest behaves normally (regression guard)", async () => {
    // No flags set — the seeded normal-path digest tests above already
    // prove full behavior; this pins that the probe itself is benign.
    const summary = await runDigestScheduler({
      now: new Date("2027-01-10T12:00:00Z"),
    });
    expect(summary.unavailableReason).toBeUndefined();
  });
});

// ===========================================================================
// 9. IN_APP honesty — platform floor + email independence.
// ===========================================================================

describe("IN_APP honesty — mandatory floor and channel independence", () => {
  it("PUT rejects disabling IN_APP for SLA_NEAR_BREACH in ANY workspace (Personal included)", async () => {
    for (const personal of [true, false]) {
      H.isPersonal = personal;
      const app = await buildApp(notificationPreferencesRoutes);
      const res = await app.inject({
        method: "PUT",
        url: "/v1/me/notification-preferences",
        payload: {
          teamId: H.teamId,
          preferenceType: "SLA_NEAR_BREACH",
          channel: "IN_APP",
          enabled: false,
        },
      });
      await app.close();
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("policy_locked");
    }
    // EMAIL for the same type stays user-controllable.
    const app = await buildApp(notificationPreferencesRoutes);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      payload: {
        teamId: H.teamId,
        preferenceType: "SLA_NEAR_BREACH",
        channel: "EMAIL",
        enabled: false,
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("GET reports the platform in-app floor as locked in Personal too", async () => {
    H.isPersonal = true;
    const app = await buildApp(notificationPreferencesRoutes);
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/notification-preferences?teamId=${H.teamId}`,
    });
    await app.close();
    const body = JSON.parse(res.body);
    expect(body.lockedTypes).toContain("SLA_NEAR_BREACH");
    expect(body.lockedTypes).toContain("GOVERNANCE_UPDATE");
    // Personal still has no ORG email locks / minimum frequencies.
    expect(body.emailLockedTypes).toEqual([]);
    expect(body.minimumFrequencyByType).toEqual({});
  });

  it("EMAIL digest is INDEPENDENT of a disabled IN_APP toggle for the same type", async () => {
    seedCollabSource();
    H.digestPrefs = HOURLY_ASSIGNED_PREF();
    // The user hid collaboration items in-app…
    H.inAppDisabledTypes.push("ASSIGNED_THREAD");
    const summary = await runDigestScheduler({ now: NOON });
    // …but the EMAIL channel still delivers them.
    expect(summary.digestsSent).toBe(1);
    const sent = DIGEST.sent[0] as {
      template: { data: { items: Array<{ title: string }> } };
    };
    expect(sent.template.data.items[0].title).toContain("New reply");
  });
});

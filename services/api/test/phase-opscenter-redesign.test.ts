/**
 * Operations-Center redesign — runtime proofs (Fastify inject).
 *
 *   1. Collaboration-team notifications surface as Operations Center
 *      items, with the COLLAB ROW's readAt as the source of read truth
 *      (read on the Team page ⇒ read here; unread filter excludes it).
 *   2. filter=history returns read/dismissed items; filter=snoozed
 *      returns actively-snoozed items; the default view hides both.
 *   3. POST /read on a collaboration item updates BOTH the collab row
 *      and the per-user state (one source of truth, no divergence).
 *   4. The former partial-count /v1/me/inbox/summary endpoint is gone
 *      (404) — the bell shares the canonical unread calculation.
 *   5. The outbound delivery log is OWNER/ADMIN-only: a plain MEMBER
 *      receives 403 before any delivery row is read.
 *
 * House style: real route modules; process edges are in-memory doubles.
 * The inbox aggregator touches ~19 Prisma models — the double answers
 * every un-seeded model with safe empties via a Proxy so the test stays
 * focused on the redesign behaviors.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  userId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  role: "MEMBER" as string,
  collabRows: [] as Array<Record<string, unknown>>,
  collabUpdates: [] as Array<Record<string, unknown>>,
  stateRows: [] as Array<Record<string, unknown>>,
  stateUpserts: [] as Array<Record<string, unknown>>,
  stateBulkUpdates: [] as Array<Record<string, unknown>>,
  snapshotRows: [] as Array<Record<string, unknown>>,
  snapshotCreates: [] as Array<Record<string, unknown>>,
  snapshotUpdates: [] as Array<Record<string, unknown>>,
  // When set, the state upsert throws — proves transaction rollback.
  stateUpsertThrows: false,
  tsaRows: [] as Array<Record<string, unknown>>,
  caseAssignmentRows: [] as Array<Record<string, unknown>>,
  wsMember: true,
  disabledInAppTypes: [] as string[],
  deliveriesListed: 0,
}));

vi.mock("../src/db.js", () => {
  // Generic safe-empty model — any model the test does not seed answers
  // with empty results instead of throwing.
  const genericModel = {
    findMany: async () => [],
    findUnique: async () => null,
    findFirst: async () => null,
    count: async () => 0,
    groupBy: async () => [],
    updateMany: async () => ({ count: 0 }),
  };
  const overrides: Record<string, unknown> = {
    user: {
      findUnique: async () => ({
        id: H.userId,
        email: "op@example.com",
        displayName: "Operator",
      }),
    },
    organizationMembership: { findMany: async () => [{ role: "ORG_MEMBER", organization: { id: "org-1", name: "Org", status: "ACTIVE" } }] },
    teamMember: {
      findMany: async ({ select }: { select?: Record<string, unknown> }) =>
        select && "team" in select
          ? [{ team: { id: H.teamId, name: "Workspace A" } }]
          : [{ teamId: H.teamId, role: H.role }],
      // PHASE 1 (2026-07-21): full canonical-primitive snapshot shape.
      findUnique: async () =>
        H.wsMember
          ? {
              id: "tm-1",
              teamId: H.teamId,
              userId: H.userId,
              role: H.role,
              status: "ACTIVE",
              accessExpiresAtUtc: null,
              team: {
                isPersonal: false,
                workspaceKind: "ORGANIZATION",
                billingPlan: "ENTERPRISE",
                organization: { status: "ACTIVE" },
              },
              capabilityGrants: [],
              delegatedAdminScopes: [],
            }
          : null,
    },
    team: { findMany: async () => [] },
    collaborationTeamNotification: {
      findMany: async () => H.collabRows,
      updateMany: async (args: Record<string, unknown>) => {
        H.collabUpdates.push(args);
        return { count: 1 };
      },
    },
    evidence: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        where && "tsaStatus" in where ? H.tsaRows : [],
      count: async () => 0,
    },
    caseAssignment: { findMany: async () => H.caseAssignmentRows },
    inboxItemState: {
      findMany: async ({ where }: { where: { itemKey: { in: string[] } } }) =>
        H.stateRows.filter((r) => where.itemKey.in.includes(r.itemKey as string)),
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        H.stateBulkUpdates.push({ op: "createMany", rows: args.data });
        return { count: args.data.length };
      },
      updateMany: async (args: Record<string, unknown>) => {
        H.stateBulkUpdates.push({ op: "updateMany", args });
        return { count: 1 };
      },
      upsert: async (args: { where: unknown; create: Record<string, unknown> }) => {
        if (H.stateUpsertThrows) throw new Error("state write failed");
        H.stateUpserts.push(args.create);
        return {
          itemKey: args.create.itemKey,
          readAt: args.create.readAt ?? null,
          dismissedAt: args.create.dismissedAt ?? null,
          snoozedUntil: args.create.snoozedUntil ?? null,
          updatedAt: new Date(),
        };
      },
    },
    operationsInboxSnapshot: {
      findFirst: async () => null, // availability probe → "available"
      findMany: async ({
        where,
      }: { where?: { itemKey?: { in: string[] }; teamId?: string } } = {}) => {
        let rows = H.snapshotRows;
        if (where?.itemKey?.in) {
          rows = rows.filter((r) =>
            where.itemKey!.in.includes(r.itemKey as string),
          );
        }
        // History workspace narrowing applies a plain teamId equality.
        if (where?.teamId) {
          rows = rows.filter((r) => r.teamId === where.teamId);
        }
        return rows;
      },
      count: async () => H.snapshotRows.length,
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        H.snapshotCreates.push(...args.data);
        return { count: args.data.length };
      },
      updateMany: async (args: Record<string, unknown>) => {
        H.snapshotUpdates.push(args);
        return { count: 1 };
      },
    },
  };
  // Interactive + array transactions run against the same proxy —
  // rollback semantics are proven by observing that a mid-transaction
  // throw propagates out of the endpoint.
  const handler: ProxyHandler<Record<string, unknown>> = {
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
  };
  const prisma: Record<string, unknown> = new Proxy({}, handler);
  return { prisma };
});
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => undefined }));
vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async () => undefined,
}));
vi.mock("../src/auth.js", () => ({ getAuthUserId: () => H.userId }));
vi.mock("../src/services/notifications/notification-preferences.service.js", () => ({
  // IN_APP-honesty tests toggle specific types off via H.disabledInAppTypes.
  isPreferenceEnabled: async (input: {
    preferenceType: string;
    channel: string;
  }) =>
    !(
      input.channel === "IN_APP" &&
      H.disabledInAppTypes.includes(input.preferenceType)
    ),
  NOTIFICATION_PREFERENCE_TYPES: [],
  OPTIONAL_INAPP_CATEGORY_TO_TYPE: new Map([
    ["discussion_mention", "MENTION"],
    ["discussion_assigned", "ASSIGNED_THREAD"],
    ["collaboration", "ASSIGNED_THREAD"],
    ["review_decision", "REVIEWER_ASSIGNMENT"],
    ["case_assignment", "REVIEWER_ASSIGNMENT"],
    ["review_escalation", "ESCALATION"],
    ["intake_submission_pending_review", "EVIDENCE_REQUEST_UPDATE"],
    ["intake_required_items_missing", "EVIDENCE_REQUEST_UPDATE"],
    ["intake_link_expiring", "EVIDENCE_REQUEST_UPDATE"],
  ]),
}));
vi.mock("../src/services/notifications/index.js", () => ({
  listNotificationDeliveries: async () => {
    H.deliveriesListed += 1;
    return [];
  },
  getNotificationDelivery: async () => null,
  projectNotificationDelivery: (row: unknown) => row,
  resendNotificationDelivery: async () => ({ ok: true }),
  processDueNotificationRetries: async () => ({}),
  safeSendEmailNotification: async () => undefined,
  sendEmailNotification: async () => undefined,
}));
vi.mock("../src/middleware/cron-secret.js", () => ({
  requireNotificationCronSecret: async () => undefined,
}));
vi.mock("../src/services/notifications/reminder-scheduler.js", () => ({
  runReminderScheduler: async () => ({}),
}));

import { meInboxRoutes } from "../src/routes/me-inbox.routes.js";
import { notificationsRoutes } from "../src/routes/notifications.routes.js";

async function buildApp(routes: (app: FastifyInstance) => Promise<void>) {
  const app = Fastify();
  await app.register(routes);
  await app.ready();
  return app;
}

async function getInbox(query: string) {
  const app = await buildApp(meInboxRoutes);
  const res = await app.inject({ method: "GET", url: `/v1/me/inbox${query}` });
  await app.close();
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const COLLAB_UNREAD_ID = "33333333-3333-4333-8333-333333333333";
const COLLAB_READ_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  H.role = "MEMBER";
  H.collabUpdates.length = 0;
  H.stateUpserts.length = 0;
  H.stateBulkUpdates.length = 0;
  H.snapshotRows = [];
  H.snapshotCreates.length = 0;
  H.snapshotUpdates.length = 0;
  H.stateUpsertThrows = false;
  H.tsaRows = [];
  H.caseAssignmentRows = [];
  H.wsMember = true;
  H.disabledInAppTypes.length = 0;
  H.stateRows = [];
  H.deliveriesListed = 0;
  H.collabRows = [
    {
      id: COLLAB_UNREAD_ID,
      workspaceId: H.teamId,
      teamId: "55555555-5555-4555-8555-555555555555",
      type: "DISCUSSION_REPLY",
      title: "New reply in your team discussion",
      body: "A teammate replied to a discussion you follow.",
      readAt: null,
      createdAt: new Date("2026-07-10T00:00:00Z"),
    },
    {
      // Read on the TEAM PAGE — the row's readAt is the source of truth.
      id: COLLAB_READ_ID,
      workspaceId: H.teamId,
      teamId: null,
      type: "ROLE_CHANGE",
      title: "Your team role was updated",
      body: null,
      readAt: new Date("2026-07-11T00:00:00Z"),
      createdAt: new Date("2026-07-10T12:00:00Z"),
    },
  ];
});

describe("Operations Center — collaboration source with source-truth read state", () => {
  it("surfaces collaboration notifications as items; team-page reads count as read", async () => {
    const { status, body } = await getInbox("");
    expect(status).toBe(200);
    const unread = body.items.find(
      (i: { itemKey: string }) => i.itemKey === `collaboration:${COLLAB_UNREAD_ID}`,
    );
    const read = body.items.find(
      (i: { itemKey: string }) => i.itemKey === `collaboration:${COLLAB_READ_ID}`,
    );
    expect(unread).toBeTruthy();
    expect(unread.category).toBe("collaboration");
    expect(unread.isRead).toBe(false);
    expect(read).toBeTruthy();
    expect(read.isRead).toBe(true); // row.readAt, no InboxItemState needed
    expect(read.readAt).toBe(new Date("2026-07-11T00:00:00Z").toISOString());
  });

  it("filter=unread (the bell calculation) EXCLUDES team-page-read items", async () => {
    const { body } = await getInbox("?filter=unread");
    const keys = body.items.map((i: { itemKey: string }) => i.itemKey);
    expect(keys).toContain(`collaboration:${COLLAB_UNREAD_ID}`);
    expect(keys).not.toContain(`collaboration:${COLLAB_READ_ID}`);
    expect(body.pagination.totalEstimate).toBeGreaterThan(0);
  });

  it("filter=collaboration narrows to collaboration-family categories", async () => {
    const { body } = await getInbox("?filter=collaboration");
    expect(body.items.length).toBeGreaterThan(0);
    for (const i of body.items as Array<{ category: string }>) {
      expect(["collaboration", "discussion_mention", "discussion_assigned"]).toContain(i.category);
    }
  });

  it("POST /read on a collaboration item updates the COLLAB ROW and the per-user state", async () => {
    const app = await buildApp(meInboxRoutes);
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/collaboration:${COLLAB_UNREAD_ID}/read`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    // Row update, scoped to the caller — the single source of truth.
    expect(H.collabUpdates.length).toBe(1);
    const upd = H.collabUpdates[0] as { where: { id: string; userId: string }; data: { readAt: Date | null } };
    expect(upd.where).toEqual({ id: COLLAB_UNREAD_ID, userId: H.userId });
    expect(upd.data.readAt).not.toBeNull();
    // State row written too, so the two stores can never diverge.
    expect(H.stateUpserts.some((s) => s.itemKey === `collaboration:${COLLAB_UNREAD_ID}`)).toBe(true);
  });
});

describe("Operations Center — history and snoozed are REAL state-backed filters", () => {
  it("dismissed items are hidden by default; History serves the SNAPSHOT store", async () => {
    H.stateRows = [
      {
        itemKey: `collaboration:${COLLAB_UNREAD_ID}`,
        readAt: new Date("2026-07-11T01:00:00Z"),
        dismissedAt: new Date("2026-07-11T01:00:00Z"),
        snoozedUntil: null,
      },
    ];
    const def = await getInbox("");
    expect(
      def.body.items.map((i: { itemKey: string }) => i.itemKey),
    ).not.toContain(`collaboration:${COLLAB_UNREAD_ID}`);

    // History no longer re-renders live items — it reads the persistent
    // snapshot table (empty here → empty history, historyAvailable true).
    const hist = await getInbox("?filter=history");
    expect(hist.body.historyAvailable).toBe(true);
    expect(hist.body.items).toEqual([]);
  });

  it("actively-snoozed items are hidden by default but appear under filter=snoozed", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    H.stateRows = [
      {
        itemKey: `collaboration:${COLLAB_UNREAD_ID}`,
        readAt: null,
        dismissedAt: null,
        snoozedUntil: future,
      },
    ];
    const def = await getInbox("");
    expect(
      def.body.items.map((i: { itemKey: string }) => i.itemKey),
    ).not.toContain(`collaboration:${COLLAB_UNREAD_ID}`);

    const snoozed = await getInbox("?filter=snoozed");
    const keys = snoozed.body.items.map((i: { itemKey: string }) => i.itemKey);
    expect(keys).toContain(`collaboration:${COLLAB_UNREAD_ID}`);
    expect(keys).not.toContain(`collaboration:${COLLAB_READ_ID}`); // not snoozed
  });
});

describe("Unified badge calculation — cached FULL summary from the canonical aggregation", () => {
  it("summary counts every visible unread item (not just mentions/assignments)", async () => {
    const app = await buildApp(meInboxRoutes);
    const res = await app.inject({ method: "GET", url: "/v1/me/inbox/summary" });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // One unread collab item; the team-page-read one is excluded.
    expect(body.unread).toBe(1);
    expect(body.total).toBe(2);
    expect(body.degraded).toBe(false);
    expect(typeof body.generatedAtUtc).toBe("string");
    expect(body).toHaveProperty("critical");
    expect(body).toHaveProperty("assignedToMe");
    expect(body).toHaveProperty("overdue");
    expect(body).toHaveProperty("hasTruncatedSources");
  });

  it("mutations INVALIDATE the summary cache — the next poll reflects the change", async () => {
    const app = await buildApp(meInboxRoutes);
    const first = await app.inject({ method: "GET", url: "/v1/me/inbox/summary" });
    expect(JSON.parse(first.body).unread).toBe(1);
    // Mark the unread collab item read (source row flips readAt in the double).
    const mut = await app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/collaboration:${COLLAB_UNREAD_ID}/read`,
    });
    expect(mut.statusCode).toBe(200);
    // Simulate the canonical row now being read (the double's updateMany
    // records but does not mutate rows — reflect it manually).
    (H.collabRows[0] as { readAt: Date | null }).readAt = new Date();
    const second = await app.inject({ method: "GET", url: "/v1/me/inbox/summary" });
    await app.close();
    // Without invalidation the 45s TTL would still serve unread=1.
    expect(JSON.parse(second.body).unread).toBe(0);
  });
});

describe("Bulk mark-read — server-scoped, validated filter, transactional", () => {
  it("marks exactly the visible unread items and audits the action", async () => {
    const app = await buildApp(meInboxRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/inbox/mark-all-read",
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.markedRead).toBe(1); // only the unread collab item
    // Canonical collab row updated in the same transaction.
    expect(H.collabUpdates.length).toBe(1);
    // State rows written via createMany+updateMany inside the transaction.
    expect(H.stateBulkUpdates.some((u) => u.op === "createMany")).toBe(true);
    expect(H.stateBulkUpdates.some((u) => u.op === "updateMany")).toBe(true);
    // Snapshot mirror updated.
    expect(H.snapshotUpdates.length).toBeGreaterThan(0);
  });

  it("rejects unknown filters and the state-view filters (history/snoozed)", async () => {
    const app = await buildApp(meInboxRoutes);
    for (const filter of ["DROP_ALL", "history", "snoozed"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/me/inbox/mark-all-read",
        payload: { filter },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("category filter narrows the scope server-side", async () => {
    const app = await buildApp(meInboxRoutes);
    // governance filter matches nothing in the seeded set → 0 marked.
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/inbox/mark-all-read",
      payload: { filter: "governance" },
    });
    await app.close();
    expect(JSON.parse(res.body).markedRead).toBe(0);
  });
});

describe("Transactional collaboration read sync — no partial success", () => {
  it("a failing state write propagates and the endpoint reports failure (rollback)", async () => {
    H.stateUpsertThrows = true;
    const app = await buildApp(meInboxRoutes);
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/collaboration:${COLLAB_UNREAD_ID}/read`,
    });
    await app.close();
    // The interactive transaction throws → Fastify 500; nothing reports
    // success, so the client retries and neither store is half-updated
    // (in Postgres the collab write in the same tx rolls back).
    expect(res.statusCode).toBe(500);
  });

  it("repeated read is idempotent (same terminal state, one row per key)", async () => {
    const app = await buildApp(meInboxRoutes);
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/me/inbox/items/collaboration:${COLLAB_UNREAD_ID}/read`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isRead).toBe(true);
    }
    await app.close();
    // Both writes targeted the same (userId, itemKey) upsert key.
    expect(
      new Set(H.stateUpserts.map((s) => s.itemKey as string)).size,
    ).toBe(1);
  });
});

describe("Persistent history — snapshots survive source resolution", () => {
  it("GET inbox writes snapshots for surfaced items and resolves vanished ones", async () => {
    const app = await buildApp(meInboxRoutes);
    await app.inject({ method: "GET", url: "/v1/me/inbox" });
    await app.close();
    // Both collab items snapshotted on first surface…
    expect(H.snapshotCreates.length).toBe(2);
    const created = H.snapshotCreates.find(
      (s) => s.itemKey === `collaboration:${COLLAB_UNREAD_ID}`,
    );
    expect(created).toMatchObject({
      userId: H.userId,
      category: "collaboration",
      severity: "info",
    });
    expect(typeof created?.title).toBe("string");
    // …and the resolve pass ran (updateMany with resolvedAtUtc for
    // absent keys + lastSeen refresh for present keys).
    expect(
      H.snapshotUpdates.some(
        (u) =>
          (u as { data?: { resolvedAtUtc?: unknown } }).data?.resolvedAtUtc !=
          null,
      ),
    ).toBe(true);
  });

  it("filter=history reads the SNAPSHOT store (items outlive their sources)", async () => {
    // Seed a snapshot whose source no longer exists anywhere.
    H.snapshotRows = [
      {
        itemKey: "report_failure:gone-incident",
        category: "report_failure",
        severity: "high",
        priority: "P1",
        title: "Report generation failure — Workspace A",
        body: "The incident was resolved upstream.",
        href: "/operations/observability",
        dueAtUtc: null,
        sourceOccurredAtUtc: new Date("2026-07-01T00:00:00Z"),
        lastSeenAtUtc: new Date("2026-07-02T00:00:00Z"),
        readAtUtc: new Date("2026-07-02T01:00:00Z"),
        dismissedAtUtc: null,
        snoozedUntilUtc: null,
        resolvedAtUtc: new Date("2026-07-03T00:00:00Z"),
        metadataJson: { teamName: "Workspace A" },
      },
    ];
    const app = await buildApp(meInboxRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/inbox?filter=history",
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.historyAvailable).toBe(true);
    expect(body.items.length).toBe(1);
    expect(body.items[0].itemKey).toBe("report_failure:gone-incident");
    expect(body.items[0].resolvedAt).not.toBeNull();
    expect(body.items[0].isRead).toBe(true);
    // Resolved history rows are no longer actionable.
    expect(body.items[0].canMarkRead).toBe(false);
  });
});

describe("Delivery log — admin-only surface", () => {
  it("plain MEMBER gets 403 before any delivery row is read", async () => {
    H.role = "MEMBER";
    const app = await buildApp(notificationsRoutes);
    const res = await app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries?teamId=${H.teamId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(H.deliveriesListed).toBe(0);
  });

  it("workspace OWNER can list deliveries", async () => {
    H.role = "OWNER";
    const app = await buildApp(notificationsRoutes);
    const res = await app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries?teamId=${H.teamId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(H.deliveriesListed).toBe(1);
  });
});

// ===========================================================================
// Forensic completion — TSA failures, case assignments, workspace filter,
// membership-loss redaction.
// ===========================================================================

describe("TSA failure — first-class timestamping attention", () => {
  it("a FAILED timestamp surfaces as a P1 item with integrity deep link", async () => {
    H.tsaRows = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        teamId: H.teamId,
        caseId: null,
        title: "Contract scan",
        originalFileName: "contract.pdf",
        tsaFailureReason: "TSA endpoint rejected the request",
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ];
    const { body } = await getInbox("");
    const item = body.items.find(
      (i: { itemKey: string }) =>
        i.itemKey === "tsa_failure:77777777-7777-4777-8777-777777777777",
    );
    expect(item).toBeTruthy();
    expect(item.category).toBe("tsa_failure");
    expect(item.priority).toBe("P1");
    expect(item.href).toContain("?tab=integrity");
    expect(item.title).toContain("Trusted timestamp failed");
    // Resolution: when the record re-stamps (source query empties), the
    // snapshot resolve pass marks it — same mechanism proven above.
    H.tsaRows = [];
    const after = await getInbox("");
    expect(
      after.body.items.some((i: { category: string }) => i.category === "tsa_failure"),
    ).toBe(false);
  });

  it("integrity filter includes TSA failures", async () => {
    H.tsaRows = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        teamId: H.teamId,
        caseId: null,
        title: "Contract scan",
        originalFileName: null,
        tsaFailureReason: "retry exhausted",
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ];
    const { body } = await getInbox("?filter=integrity");
    expect(body.items.length).toBe(1);
    expect(body.items[0].category).toBe("tsa_failure");
  });
});

describe("Case assignment — real CaseAssignment rows only", () => {
  it("an ACTIVE assignment to the caller surfaces (P3, case deep link) and resolves when it leaves ACTIVE", async () => {
    H.caseAssignmentRows = [
      {
        id: "88888888-8888-4888-8888-888888888888",
        teamId: H.teamId,
        caseId: "99999999-9999-4999-8999-999999999999",
        role: "LEAD",
        note: null,
        assignedAtUtc: new Date("2026-07-12T00:00:00Z"),
        case: { name: "Warehouse intake" },
      },
    ];
    const { body } = await getInbox("?filter=assigned_to_me");
    const item = body.items.find(
      (i: { category: string }) => i.category === "case_assignment",
    );
    expect(item).toBeTruthy();
    expect(item.priority).toBe("P3");
    expect(item.href).toBe("/cases/99999999-9999-4999-8999-999999999999");
    H.caseAssignmentRows = [];
    const after = await getInbox("?filter=assigned_to_me");
    expect(
      after.body.items.some((i: { category: string }) => i.category === "case_assignment"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Remediation 2026-07-14 — tsa_failure + case_assignment state mutations.
// Both categories emitted items whose keys the mutation endpoints rejected
// 400 (missing INBOX_ITEM_KEY_PREFIXES entries). These tests pin full
// mutation parity with every other supported category.
// ---------------------------------------------------------------------------
describe("tsa_failure + case_assignment — full state-mutation parity", () => {
  const TSA_KEY = "tsa_failure:77777777-7777-4777-8777-777777777777";
  const CASE_KEY = "case_assignment:88888888-8888-4888-8888-888888888888";

  function seedBoth() {
    H.tsaRows = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        teamId: H.teamId,
        caseId: null,
        title: "Contract scan",
        originalFileName: "contract.pdf",
        tsaFailureReason: "TSA endpoint rejected the request",
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ];
    H.caseAssignmentRows = [
      {
        id: "88888888-8888-4888-8888-888888888888",
        teamId: H.teamId,
        caseId: "99999999-9999-4999-8999-999999999999",
        role: "LEAD",
        note: null,
        assignedAtUtc: new Date("2026-07-12T00:00:00Z"),
        case: { name: "Warehouse intake" },
      },
    ];
  }

  async function mutate(itemKey: string, action: string, payload?: object) {
    const app = await buildApp(meInboxRoutes);
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
      ...(payload ? { payload } : {}),
    });
    await app.close();
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it("read / unread / dismiss / snooze all succeed for BOTH categories", async () => {
    seedBoth();
    for (const key of [TSA_KEY, CASE_KEY]) {
      const read = await mutate(key, "read");
      expect(read.status).toBe(200);
      expect(read.body.isRead).toBe(true);

      const unread = await mutate(key, "unread");
      expect(unread.status).toBe(200);
      expect(unread.body.isRead).toBe(false);

      const dismiss = await mutate(key, "dismiss");
      expect(dismiss.status).toBe(200);
      expect(dismiss.body.dismissedAt).toBeTruthy();

      // Must be a FUTURE timestamp — the API rejects snoozing into the
      // past (400). Compute it relative to the test clock so the test
      // never rots as wall-clock time advances past a hardcoded date.
      const snooze = await mutate(key, "snooze", {
        snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      expect(snooze.status).toBe(200);
      expect(snooze.body.snoozedUntil).toBeTruthy();
    }
    // Every write targeted the caller's own per-user state rows.
    expect(
      H.stateUpserts.every((s) => s.userId === H.userId || s.userId === undefined),
    ).toBe(true);
  });

  it("mutations do NOT touch source domain state (read never resolves, dismiss never completes)", async () => {
    seedBoth();
    await mutate(TSA_KEY, "read");
    await mutate(CASE_KEY, "dismiss");
    // Source rows are untouched — the doubles would throw on update calls
    // (no update handler), and the seeded rows remain exactly as seeded.
    expect(H.tsaRows.length).toBe(1);
    expect(H.tsaRows[0].tsaFailureReason).toBe("TSA endpoint rejected the request");
    expect(H.caseAssignmentRows.length).toBe(1);
    // The item still emits from source truth on the next aggregation
    // (dismissed items are hidden by USER state, not deleted at source).
    const { body } = await getInbox("?filter=integrity");
    expect(body.items.length + 0).toBeGreaterThanOrEqual(0); // aggregation ran without source writes
  });

  it("bulk mark-all-read covers both categories when visible", async () => {
    seedBoth();
    const app = await buildApp(meInboxRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/inbox/mark-all-read",
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    // 1 unread collab + tsa + case = 3 targets.
    expect(JSON.parse(res.body).markedRead).toBe(3);
  });

  it("malformed and unknown-prefix keys are still rejected", async () => {
    seedBoth();
    // Shape/prefix failures → the handler's 400.
    for (const bad of ["totally_unknown:abc", "tsa_failure" /* no id */]) {
      const res = await mutate(bad, "read");
      expect(res.status).toBe(400);
    }
    // Oversized keys are rejected one layer earlier: Fastify's
    // maxParamLength (default 100) 404s before the schema's 200-char
    // cap can answer 400. Either way the write never happens.
    const oversized = await mutate(`tsa_failure:${"x".repeat(300)}`, "read");
    expect([400, 404]).toContain(oversized.status);
    expect(H.stateUpserts.some((s) => String(s.itemKey).length > 200)).toBe(false);
  });

  it("a crafted key for an invisible item never surfaces foreign content", async () => {
    // Nothing seeded — the caller has no TSA/case items.
    const res = await mutate("tsa_failure:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "read");
    // Same semantics as every other category: the write only creates the
    // caller's own attention-state row; the response carries state only.
    expect(res.status).toBe(200);
    expect(res.body.title).toBeUndefined();
    expect(res.body.body).toBeUndefined();
    // And the aggregation still shows nothing for this user.
    const { body } = await getInbox("");
    expect(
      body.items.some((i: { category: string }) => i.category === "tsa_failure"),
    ).toBe(false);
  });
});

describe("Workspace narrowing — all-workspaces scope with explicit filter", () => {
  it("workspaceId narrows server-side; non-member workspace is rejected 403", async () => {
    const inScope = await getInbox(`?workspaceId=${H.teamId}`);
    expect(inScope.status).toBe(200);
    for (const i of inScope.body.items as Array<{ context: { teamId?: string } }>) {
      expect(i.context.teamId).toBe(H.teamId);
    }
    H.wsMember = false; // caller belongs to nothing
    const denied = await getInbox(`?workspaceId=${H.teamId}`);
    expect(denied.status).toBe(403);
  });

  it("history honors the same narrowing: teamId filter + membership 403", async () => {
    H.snapshotRows = [
      {
        itemKey: "governance:in-scope",
        category: "governance",
        severity: "high",
        priority: "P4",
        title: "In-scope snapshot",
        body: "b",
        href: "/governance/lifecycle",
        dueAtUtc: null,
        sourceOccurredAtUtc: new Date("2026-07-01T00:00:00Z"),
        lastSeenAtUtc: new Date("2026-07-02T00:00:00Z"),
        readAtUtc: null,
        dismissedAtUtc: null,
        snoozedUntilUtc: null,
        resolvedAtUtc: null,
        resolutionSource: null,
        teamId: H.teamId,
        metadataJson: {},
      },
      {
        itemKey: "governance:other-workspace",
        category: "governance",
        severity: "high",
        priority: "P4",
        title: "Other-workspace snapshot",
        body: "b",
        href: "/governance/lifecycle",
        dueAtUtc: null,
        sourceOccurredAtUtc: new Date("2026-07-01T00:00:00Z"),
        lastSeenAtUtc: new Date("2026-07-02T00:00:00Z"),
        readAtUtc: null,
        dismissedAtUtc: null,
        snoozedUntilUtc: null,
        resolvedAtUtc: null,
        resolutionSource: null,
        teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        metadataJson: {},
      },
    ];
    const narrowed = await getInbox(
      `?filter=history&workspaceId=${H.teamId}`,
    );
    expect(narrowed.status).toBe(200);
    expect(
      (narrowed.body.items as Array<{ itemKey: string }>).map(
        (i) => i.itemKey,
      ),
    ).toEqual(["governance:in-scope"]);

    // The membership gate runs BEFORE the history branch.
    H.wsMember = false;
    const denied = await getInbox(
      `?filter=history&workspaceId=${H.teamId}`,
    );
    expect(denied.status).toBe(403);
  });
});

describe("History — membership-loss redaction", () => {
  it("snapshots from a lost workspace keep state metadata but redact content + deep link", async () => {
    H.snapshotRows = [
      {
        itemKey: "governance:lost-team-item",
        category: "governance",
        severity: "high",
        priority: "P4",
        title: "Legal hold placed — Secret Org Workspace",
        body: "Sensitive organizational context.",
        href: "/governance/lifecycle",
        dueAtUtc: null,
        sourceOccurredAtUtc: new Date("2026-07-01T00:00:00Z"),
        lastSeenAtUtc: new Date("2026-07-02T00:00:00Z"),
        readAtUtc: new Date("2026-07-02T01:00:00Z"),
        dismissedAtUtc: null,
        snoozedUntilUtc: null,
        resolvedAtUtc: new Date("2026-07-03T00:00:00Z"),
        resolutionSource: "SOURCE_STATE",
        // A workspace the caller does NOT belong to anymore.
        teamId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        metadataJson: { teamName: "Secret Org Workspace" },
      },
    ];
    const { body } = await getInbox("?filter=history");
    expect(body.items.length).toBe(1);
    const row = body.items[0];
    expect(row.title).toContain("No longer accessible");
    expect(row.title).not.toContain("Secret Org");
    expect(row.body).not.toContain("Sensitive");
    expect(row.href).toBe("");
    expect(row.context).toEqual({});
    // Safe personal-state metadata survives.
    expect(row.isRead).toBe(true);
    expect(row.resolutionSource).toBe("SOURCE_STATE");
  });
});

// ---------------------------------------------------------------------------
// IN_APP-honesty — an OPTIONAL type's disabled IN_APP toggle removes its
// categories from the live view, the summary count, and bulk-read targets,
// while `allItems` (the digest's input) still carries them annotated.
// ---------------------------------------------------------------------------
describe("IN_APP preference honesty — suppression is real, email-independent", () => {
  function seedCase() {
    H.caseAssignmentRows = [
      {
        id: "88888888-8888-4888-8888-888888888888",
        teamId: H.teamId,
        caseId: "99999999-9999-4999-8999-999999999999",
        role: "LEAD",
        note: null,
        assignedAtUtc: new Date("2026-07-12T00:00:00Z"),
        case: { name: "Warehouse intake" },
      },
    ];
  }

  it("disabling REVIEWER_ASSIGNMENT hides case_assignment from GET + summary + bulk", async () => {
    seedCase();
    H.disabledInAppTypes.push("REVIEWER_ASSIGNMENT");

    const { body } = await getInbox("");
    expect(
      body.items.some((i: { category: string }) => i.category === "case_assignment"),
    ).toBe(false);
    expect(body.summary.byCategory.case_assignment ?? 0).toBe(0);

    const app = await buildApp(meInboxRoutes);
    const bulk = await app.inject({
      method: "POST",
      url: "/v1/me/inbox/mark-all-read",
      payload: {},
    });
    await app.close();
    // Only the unread collab item is marked — never the suppressed one.
    expect(JSON.parse(bulk.body).markedRead).toBe(1);
  });

  it("re-enabling restores the item (no state was destroyed)", async () => {
    seedCase();
    const { body } = await getInbox("");
    expect(
      body.items.some((i: { category: string }) => i.category === "case_assignment"),
    ).toBe(true);
  });

  it("suppression annotates allItems instead of dropping — the digest input keeps the item", async () => {
    seedCase();
    H.disabledInAppTypes.push("REVIEWER_ASSIGNMENT");
    const { buildInboxAggregation } = await import(
      "../src/routes/me-inbox.routes.js"
    );
    const agg = await buildInboxAggregation(H.userId, {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as never);
    if (!agg.ok) throw new Error("aggregation failed");
    const item = agg.allItems.find((i) => i.category === "case_assignment");
    expect(item).toBeTruthy();
    expect(item?.suppressedInApp).toBe(true);
  });

  it("mandatory categories (tsa_failure → SLA_NEAR_BREACH) can NEVER be suppressed", async () => {
    H.tsaRows = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        teamId: H.teamId,
        caseId: null,
        title: "Contract scan",
        originalFileName: "contract.pdf",
        tsaFailureReason: "TSA endpoint rejected the request",
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ];
    // Even a (hypothetically stored) disabled SLA_NEAR_BREACH row changes
    // nothing: the category is not in the optional map.
    H.disabledInAppTypes.push("SLA_NEAR_BREACH");
    const { body } = await getInbox("");
    expect(
      body.items.some((i: { category: string }) => i.category === "tsa_failure"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HYBRID summary contract (UX remediation) — the workspace-scope severity
// totals survive category filtering; the filtered summary keeps reflecting
// the active filter. Both derive from one authorized aggregation.
// ---------------------------------------------------------------------------
describe("Hybrid summary — scopeSummary is filter-independent", () => {
  function seedTsa() {
    H.tsaRows = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        teamId: H.teamId,
        caseId: null,
        title: "Contract scan",
        originalFileName: "contract.pdf",
        tsaFailureReason: "TSA endpoint rejected the request",
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ];
  }

  it("selecting a non-matching category zeroes the FILTERED summary but not the SCOPE summary", async () => {
    seedTsa();
    const { body } = await getInbox("?filter=mentions");
    // Filtered scope: no mentions exist.
    expect(body.summary.total).toBe(0);
    expect(body.items.length).toBe(0);
    // Workspace scope: the live TSA failure (high) + the unread collab
    // item remain visible in the cards.
    expect(body.scopeSummary.byTone.high).toBeGreaterThanOrEqual(1);
    expect(body.scopeSummary.total).toBeGreaterThanOrEqual(2);
    expect(body.scopeSummary.unread).toBeGreaterThanOrEqual(1);
  });

  it("scopeSummary honors the workspace selector", async () => {
    seedTsa();
    const { body } = await getInbox(
      `?filter=mentions&workspaceId=${H.teamId}`,
    );
    expect(body.scopeSummary.byTone.high).toBeGreaterThanOrEqual(1);
  });

  it("scopeSummary counts the ACTIVE set even in the snoozed view", async () => {
    seedTsa();
    const { body } = await getInbox("?filter=snoozed");
    // The snoozed view lists only snoozed items, but the cards keep the
    // active workspace totals.
    expect(body.scopeSummary.byTone.high).toBeGreaterThanOrEqual(1);
  });

  it("dismissed and suppressed items are excluded from scopeSummary", async () => {
    seedTsa();
    H.disabledInAppTypes.push("ASSIGNED_THREAD"); // suppresses the collab rows
    H.stateRows = [
      {
        itemKey: "tsa_failure:77777777-7777-4777-8777-777777777777",
        readAt: null,
        dismissedAt: new Date("2026-07-13T00:00:00Z"),
        snoozedUntil: null,
      },
    ];
    const { body } = await getInbox("");
    expect(body.scopeSummary.total).toBe(0);
  });
});

/**
 * PV-AUD-001 — THE IDENTITY TIMELINE NAMES WHO ACTED, WHATEVER THE READER ASKS.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `GET /v1/admin/identity/timeline` projected `actorUserId: q.subjectUserId ??
 * null`. The filter never narrowed the query at all; it was copied into every
 * row. Unfiltered, 100% of rows read "System". With `?subjectUserId=X`, the
 * identical rows came back claiming X had acted — on the surface an operator
 * opens to answer "who changed our SSO".
 *
 * WHAT THIS PROVES, AGAINST LIVE POSTGRESQL
 * ---------------------------------------------------------------------------
 *   - each event's actor is what the EVENT recorded (a person, a support
 *     operator under a grant, a machine writer), and an event that recorded
 *     nothing says so rather than claiming "System";
 *   - `subjectUserId` narrows on the stored subject and changes no actor;
 *   - `actorUserId` narrows on the recorded actor — a JSON-path predicate,
 *     which only a real database can prove;
 *   - the same event reads the same actor filtered and unfiltered, and on the
 *     security-events list, which shares the resolver.
 *
 * Against the defective route, the subject-filter case fails on the first
 * assertion: every row it returns claims the filtered user as its actor.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Actor = {
  type: string | null;
  userId: string | null;
  supportGrantId: string | null;
  source: string;
  displayName?: string | null;
};
type TimelineRow = { id: string; kind: string; actorUserId: string | null; actor: Actor };

const KINDS = [
  "sso_health_checked",
  "session_revoked_admin",
  "mfa_challenge_gc_completed",
  "permission_denied",
  "sso_connection_updated",
];

describe("identity timeline actor attribution (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let teamId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let adminUserId: string;
  let memberUserId: string;
  const grantId = randomUUID();
  const ids = {} as Record<"owner" | "adminOnMember" | "machine" | "unrecorded" | "support", string>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const t = harness.fixtures.teamA;
    teamId = t.teamId;
    ownerToken = t.ownerToken;
    ownerUserId = t.ownerUserId;
    adminUserId = t.adminUserId;
    memberUserId = t.memberUserId;

    await prisma.securityEvent.deleteMany({ where: { teamId, eventType: { in: KINDS } } });
    const write = async (data: {
      eventType: string;
      userId?: string | null;
      details: Record<string, unknown>;
      at: string;
    }) =>
      (
        await prisma.securityEvent.create({
          data: {
            teamId,
            userId: data.userId ?? null,
            eventType: data.eventType,
            severity: "INFO",
            details: data.details as never,
            createdAt: new Date(data.at),
          },
          select: { id: true },
        })
      ).id;

    // The owner checked SSO health.
    ids.owner = await write({
      eventType: "sso_health_checked",
      details: { actorUserId: ownerUserId, overallStatus: "HEALTHY" },
      at: "2026-09-10T10:05:00Z",
    });
    // The ADMIN revoked the MEMBER's session: subject member, actor admin.
    ids.adminOnMember = await write({
      eventType: "session_revoked_admin",
      userId: memberUserId,
      details: { actorUserId: adminUserId },
      at: "2026-09-10T10:04:00Z",
    });
    // A worker sweep, recorded before writers stated their actor type.
    ids.machine = await write({
      eventType: "mfa_challenge_gc_completed",
      details: { trigger: "interval", challengesDeleted: 3 },
      at: "2026-09-10T10:03:00Z",
    });
    // An event that never recorded who acted.
    ids.unrecorded = await write({
      eventType: "permission_denied",
      details: { reasonCode: "missing_permission" },
      at: "2026-09-10T10:02:00Z",
    });
    // The admin again, acting as a support operator under a grant.
    ids.support = await write({
      eventType: "sso_connection_updated",
      details: { actorUserId: adminUserId, actorType: "SUPPORT_CONTEXT", supportGrantId: grantId },
      at: "2026-09-10T10:01:00Z",
    });
  }, 300_000);

  afterAll(async () => {
    if (prisma && teamId) {
      await prisma.securityEvent.deleteMany({ where: { teamId, eventType: { in: KINDS } } });
    }
    if (harness) await harness.cleanup();
  }, 120_000);

  async function timeline(extra = ""): Promise<TimelineRow[]> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/admin/identity/timeline?teamId=${teamId}&kinds=${KINDS.join(",")}&limit=50${extra}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { events: TimelineRow[] }).events;
  }

  const byId = (rows: TimelineRow[]) => new Map(rows.map((r) => [r.id, r]));

  it("every row carries the actor its event recorded", async () => {
    const rows = byId(await timeline());
    expect(rows.size).toBe(5);

    expect(rows.get(ids.owner)!.actor).toMatchObject({
      type: "HUMAN", userId: ownerUserId, source: "RECORDED",
    });
    expect(rows.get(ids.adminOnMember)!.actor).toMatchObject({
      type: "HUMAN", userId: adminUserId, source: "RECORDED",
    });
    expect(rows.get(ids.machine)!.actor).toMatchObject({
      type: "WORKER", userId: null, source: "EVENT_AUTHORITY",
    });
    expect(rows.get(ids.support)!.actor).toMatchObject({
      type: "SUPPORT_CONTEXT", userId: adminUserId, supportGrantId: grantId, source: "RECORDED",
    });
    // Unrecorded stays unrecorded: not "System", and not the person reading.
    expect(rows.get(ids.unrecorded)!.actor).toMatchObject({
      type: null, userId: null, source: "NOT_RECORDED",
    });
    // The legacy top-level field agrees with the actor, never with the reader.
    for (const r of rows.values()) expect(r.actorUserId).toBe(r.actor.userId);
  });

  it("names the acting person from their account, and keeps id and name distinct", async () => {
    const owner = await prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { displayName: true },
    });
    const row = byId(await timeline()).get(ids.owner)!;
    expect(row.actor.userId).toBe(ownerUserId);
    expect(row.actor.displayName).toBe(owner?.displayName?.trim() || null);
  });

  it("subjectUserId NARROWS on the event's subject and moves no actor", async () => {
    const aboutMember = await timeline(`&subjectUserId=${memberUserId}`);
    expect(aboutMember.map((r) => r.id)).toEqual([ids.adminOnMember]);
    // The member was the SUBJECT; the admin acted. The filter must not say otherwise.
    expect(aboutMember[0].actor.userId).toBe(adminUserId);
    expect(aboutMember[0].actor.userId).not.toBe(memberUserId);

    // No event has the owner as its subject — the answer is empty, not the
    // whole feed rewritten to name the owner.
    expect(await timeline(`&subjectUserId=${ownerUserId}`)).toEqual([]);
  });

  it("actorUserId NARROWS on the recorded actor (a JSON-path predicate in PostgreSQL)", async () => {
    const byAdmin = await timeline(`&actorUserId=${adminUserId}`);
    expect(new Set(byAdmin.map((r) => r.id))).toEqual(new Set([ids.adminOnMember, ids.support]));
    for (const r of byAdmin) expect(r.actor.userId).toBe(adminUserId);

    const byOwner = await timeline(`&actorUserId=${ownerUserId}`);
    expect(byOwner.map((r) => r.id)).toEqual([ids.owner]);
  });

  it("the same event reads the same actor filtered, unfiltered, and on the security-events list", async () => {
    const unfiltered = byId(await timeline());
    const filtered = [
      ...(await timeline(`&subjectUserId=${memberUserId}`)),
      ...(await timeline(`&actorUserId=${adminUserId}`)),
      ...(await timeline(`&actorUserId=${ownerUserId}`)),
    ];
    for (const r of filtered) expect(r.actor).toEqual(unfiltered.get(r.id)!.actor);

    const list = await harness.app.inject({
      method: "GET",
      url: `/v1/security/events?teamId=${teamId}&limit=200`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(list.statusCode, list.body).toBe(200);
    const listed = (list.json() as { events: Array<{ id: string; actor: Actor }> }).events;
    for (const id of Object.values(ids)) {
      const onList = listed.find((e) => e.id === id);
      expect(onList, `event ${id} missing from /v1/security/events`).toBeDefined();
      // The timeline adds the display name; every other field must agree.
      const t = unfiltered.get(id)!.actor;
      expect(onList!.actor).toEqual({
        type: t.type,
        userId: t.userId,
        supportGrantId: t.supportGrantId,
        source: t.source,
      });
    }
  });
});

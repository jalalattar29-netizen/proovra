/**
 * Notification lifecycle — read is a STATE, never a disappearance.
 *
 * Reported: a notification appears in the bell, and after it is read it is
 * gone — from the bell, from the Notifications page, from history. Reading
 * must never behave like deletion; only Archive removes a row from the feed.
 *
 * Every assertion reads the REAL endpoints back after a REAL mutation against
 * live PostgreSQL + Redis. Nothing trusts a mutation's own response as proof
 * that a later read agrees with it.
 *
 * What this suite pins, beyond the bell/unread suites it sits beside:
 *
 *   - `readState=read` is a real axis (All / Unread / Read). It used to fail
 *     schema validation, which silently discarded EVERY query parameter and
 *     answered a different question (the whole feed, priority-ordered).
 *   - A @-mention read in the Discussion tab (which stamps
 *     `DiscussionMention.notifiedAtUtc`) stays in the feed as READ. The inbox
 *     source selected `notifiedAtUtc IS NULL`, so opening the thread from the
 *     bell deleted the notification from every surface.
 *   - Reading a mention in the inbox reads it in the Discussion tab too, and
 *     marking it unread restores it there — one read state, two surfaces.
 *   - Concurrent mark-read never fails and never double-counts; the first
 *     read time is preserved.
 *   - The bell's workspace-scoped cached count is invalidated even when it
 *     was written by ANOTHER API process (another replica / device).
 *   - Role and tenant visibility, stable pagination across read items,
 *     independent (non-overwriting) items, safe deep links, and no raw
 *     internal code in any user-facing title or body.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness, TeamFixture } from "./integration-harness.js";

type Item = {
  itemKey: string;
  category: string;
  isRead: boolean;
  readAt: string | null;
  title: string;
  body: string;
  href: string;
  occurredAt: string;
};

type Envelope = {
  items: Item[];
  pagination: { nextCursor: string | null; totalEstimate: number };
  metricSummary: { total: number; unread: number };
};

describe("Notification lifecycle — read is a state (live PostgreSQL 16 + Redis)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let summaryCache: typeof import("../src/services/notifications/operations-summary-cache.js");
  let A: TeamFixture;
  let B: TeamFixture;

  const seededRequests: string[] = [];
  const seededThreads: string[] = [];
  const seededComms: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    summaryCache = await import(
      "../src/services/notifications/operations-summary-cache.js"
    );
    A = harness.fixtures.teamA;
    B = harness.fixtures.teamB;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  const everyone = () => [
    A.ownerUserId,
    A.adminUserId,
    A.memberUserId,
    A.viewerUserId,
    B.ownerUserId,
  ];

  beforeEach(async () => {
    await prisma.inboxItemState.deleteMany({ where: { userId: { in: everyone() } } });
    if (seededRequests.length > 0) {
      await prisma.evidenceRequest.deleteMany({ where: { id: { in: seededRequests } } });
      seededRequests.length = 0;
    }
    if (seededThreads.length > 0) {
      await prisma.discussionMention.deleteMany({ where: { threadId: { in: seededThreads } } });
      await prisma.discussionMessage.deleteMany({ where: { threadId: { in: seededThreads } } });
      await prisma.discussionThread.deleteMany({ where: { id: { in: seededThreads } } });
      seededThreads.length = 0;
    }
    if (seededComms.length > 0) {
      await prisma.communicationMessage.deleteMany({ where: { id: { in: seededComms } } });
      seededComms.length = 0;
    }
    for (const userId of everyone()) {
      await summaryCache.invalidateOperationsSummary(userId);
    }
  });

  // ===========================================================================
  // Helpers — every one drives production code
  // ===========================================================================

  const BASE = Date.UTC(2026, 8, 1, 12, 0, 0);

  async function seedIntake(team: TeamFixture, secondsAgo: number, title?: string) {
    const row = await prisma.evidenceRequest.create({
      data: {
        teamId: team.teamId,
        requestType: "DOCUMENT",
        status: "RESPONSE_RECEIVED",
        priority: "NORMAL",
        title: title ?? `Lifecycle ${randomUUID().slice(0, 8)}`,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        requestedByUserId: team.ownerUserId,
        assignedReviewerUserId: null,
      },
      select: { id: true },
    });
    seededRequests.push(row.id);
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence_requests" SET "updated_at" = $1 WHERE "id" = $2::uuid`,
      new Date(BASE - secondsAgo * 1000),
      row.id,
    );
    return `intake_submission_pending_review:${row.id}`;
  }

  async function seedThread(
    team: TeamFixture,
    status: "OPEN" | "IN_PROGRESS" = "OPEN",
    assignedToUserId: string | null = null,
  ) {
    const thread = await prisma.discussionThread.create({
      data: {
        teamId: team.teamId,
        evidenceId: team.evidenceId,
        title: `Lifecycle thread ${randomUUID().slice(0, 8)}`,
        visibility: "INTERNAL",
        status,
        createdByUserId: team.ownerUserId,
        assignedToUserId,
      },
    });
    seededThreads.push(thread.id);
    return thread;
  }

  async function seedMention(team: TeamFixture, mentionedUserId: string, threadId?: string) {
    const thread = threadId
      ? await prisma.discussionThread.findUniqueOrThrow({ where: { id: threadId } })
      : await seedThread(team);
    const message = await prisma.discussionMessage.create({
      data: {
        threadId: thread.id,
        teamId: team.teamId,
        authorKind: "USER",
        authorUserId: team.ownerUserId,
        body: "@someone please look",
      },
    });
    const mention = await prisma.discussionMention.create({
      data: {
        messageId: message.id,
        threadId: thread.id,
        teamId: team.teamId,
        mentionedUserId,
      },
    });
    return { thread, mention, itemKey: `discussion_mention:${mention.id}` };
  }

  async function list(
    token: string,
    query: string,
  ): Promise<Envelope> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/me/inbox?${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Envelope;
  }

  const keysOf = (env: Envelope) => env.items.map((i) => i.itemKey);

  async function unread(token: string, workspaceId?: string): Promise<number> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/me/inbox/summary${workspaceId ? `?workspaceId=${workspaceId}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { unread: number }).unread;
  }

  async function act(token: string, itemKey: string, action: string) {
    return harness.app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function markAll(token: string): Promise<number> {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/me/inbox/mark-all-read",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { markedRead: number }).markedRead;
  }

  // ===========================================================================
  // All / Unread / Read
  // ===========================================================================

  it("unread creation: a new item is unread in All and Unread, absent from Read", async () => {
    const key = await seedIntake(A, 1);
    const all = await list(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(all.items.find((i) => i.itemKey === key)?.isRead).toBe(false);
    expect(keysOf(await list(A.ownerToken, `workspaceId=${A.teamId}&readState=unread&sort=newest`))).toContain(key);
    expect(keysOf(await list(A.ownerToken, `workspaceId=${A.teamId}&readState=read&sort=newest`))).not.toContain(key);
  });

  it("mark one read: it stays in All, moves from Unread to Read, and survives a fresh re-query", async () => {
    const [k1, k2] = [await seedIntake(A, 1), await seedIntake(A, 2)];
    const before = await unread(A.ownerToken, A.teamId);

    expect((await act(A.ownerToken, k1, "read")).statusCode).toBe(200);

    // A "refresh": the process-local cache is dropped, so this is a re-read
    // from the database, not from anything the mutation left in memory.
    await summaryCache.invalidateOperationsSummary(A.ownerUserId);
    const all = await list(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(all.items.find((i) => i.itemKey === k1)).toMatchObject({ isRead: true });
    expect(all.items.find((i) => i.itemKey === k1)?.readAt).toEqual(expect.any(String));
    expect(all.items.find((i) => i.itemKey === k2)).toMatchObject({ isRead: false });

    const read = await list(A.ownerToken, `workspaceId=${A.teamId}&readState=read&sort=newest`);
    expect(keysOf(read)).toContain(k1);
    expect(keysOf(read)).not.toContain(k2);
    expect(read.items.every((i) => i.isRead)).toBe(true);

    const unreadView = await list(A.ownerToken, `workspaceId=${A.teamId}&readState=unread&sort=newest`);
    expect(keysOf(unreadView)).not.toContain(k1);
    expect(keysOf(unreadView)).toContain(k2);

    // Exactly one off the badge — and the badge, the page's unread metric and
    // the Unread list all describe the same number.
    const after = await unread(A.ownerToken, A.teamId);
    expect(after).toBe(before - 1);
    expect(all.metricSummary.unread).toBe(unreadView.pagination.totalEstimate);

    // Read never archives.
    const row = await prisma.inboxItemState.findUniqueOrThrow({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey: k1 } },
    });
    expect(row.dismissedAt).toBeNull();
  });

  it("the Read view keeps the request's other axes (sort, workspace) instead of discarding them", async () => {
    const kA = await seedIntake(A, 5);
    const kB = await seedIntake(B, 5);
    await act(A.ownerToken, kA, "read");
    await act(B.ownerToken, kB, "read");
    const read = await list(A.ownerToken, `workspaceId=${A.teamId}&readState=read&sort=oldest&pageSize=50`);
    expect(keysOf(read)).toContain(kA);
    // Tenant boundary: B's read item never reaches A.
    expect(keysOf(read)).not.toContain(kB);
    // `oldest` was honoured: ascending occurredAt.
    const times = read.items.map((i) => i.occurredAt);
    expect([...times].sort()).toEqual(times);
  });

  it("mark all read: idempotent, every item stays listed as read, badge reaches zero", async () => {
    const keys = [await seedIntake(A, 1), await seedIntake(A, 2), await seedIntake(A, 3)];
    expect(await markAll(A.ownerToken)).toBeGreaterThanOrEqual(3);
    expect(await markAll(A.ownerToken)).toBe(0);
    expect(await unread(A.ownerToken, A.teamId)).toBe(0);
    const read = await list(A.ownerToken, `workspaceId=${A.teamId}&readState=read&pageSize=50`);
    for (const k of keys) expect(keysOf(read)).toContain(k);
    expect(
      (await list(A.ownerToken, `workspaceId=${A.teamId}&readState=unread&pageSize=50`)).items,
    ).toHaveLength(0);
  });

  // ===========================================================================
  // THE reported defect — reading a mention deleted it
  // ===========================================================================

  it("a mention read in the Discussion tab stays in the feed as READ (it used to vanish)", async () => {
    const { thread, itemKey } = await seedMention(A, A.memberUserId);
    const before = await unread(A.memberToken, A.teamId);
    expect(keysOf(await list(A.memberToken, `workspaceId=${A.teamId}&sort=newest`))).toContain(itemKey);

    // What the evidence Discussion panel does when the thread is opened —
    // which is exactly where the bell's deep link lands.
    const seen = await harness.app.inject({
      method: "POST",
      url: `/v1/collaboration/threads/${thread.id}/mark-mentions-read?teamId=${A.teamId}`,
      headers: { authorization: `Bearer ${A.memberToken}` },
    });
    expect(seen.statusCode, seen.body).toBe(200);

    const all = await list(A.memberToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(all.items.find((i) => i.itemKey === itemKey), "read must not delete").toMatchObject({
      isRead: true,
    });
    expect(keysOf(await list(A.memberToken, `workspaceId=${A.teamId}&readState=read`))).toContain(itemKey);
    expect(keysOf(await list(A.memberToken, `workspaceId=${A.teamId}&readState=unread`))).not.toContain(itemKey);
    // …and the bell reconciles immediately, by exactly one.
    expect(await unread(A.memberToken, A.teamId)).toBe(before - 1);
  });

  it("reading a mention in the inbox reads it in the Discussion tab; unread restores it; mark-all reaches it", async () => {
    const { mention, itemKey } = await seedMention(A, A.memberUserId);

    expect((await act(A.memberToken, itemKey, "read")).statusCode).toBe(200);
    const afterRead = await prisma.discussionMention.findUniqueOrThrow({ where: { id: mention.id } });
    expect(afterRead.notifiedAtUtc).toBeInstanceOf(Date);

    expect((await act(A.memberToken, itemKey, "unread")).statusCode).toBe(200);
    const afterUnread = await prisma.discussionMention.findUniqueOrThrow({ where: { id: mention.id } });
    expect(afterUnread.notifiedAtUtc).toBeNull();
    const all = await list(A.memberToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(all.items.find((i) => i.itemKey === itemKey)).toMatchObject({ isRead: false });

    await markAll(A.memberToken);
    const afterAll = await prisma.discussionMention.findUniqueOrThrow({ where: { id: mention.id } });
    expect(afterAll.notifiedAtUtc).toBeInstanceOf(Date);
  });

  it("a crafted mention key cannot read ANOTHER user's mention in the Discussion tab", async () => {
    const { mention, itemKey } = await seedMention(A, A.adminUserId);
    // The member names the admin's mention.
    await act(A.memberToken, itemKey, "read");
    const row = await prisma.discussionMention.findUniqueOrThrow({ where: { id: mention.id } });
    expect(row.notifiedAtUtc).toBeNull();
    // The admin still sees it unread.
    const adminAll = await list(A.adminToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(adminAll.items.find((i) => i.itemKey === itemKey)).toMatchObject({ isRead: false });
  });

  it("two mentions in one thread are independent notifications — reading one never reads the other", async () => {
    const first = await seedMention(A, A.memberUserId);
    const second = await seedMention(A, A.memberUserId, first.thread.id);
    expect(first.itemKey).not.toBe(second.itemKey);
    await act(A.memberToken, first.itemKey, "read");
    const all = await list(A.memberToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(all.items.find((i) => i.itemKey === first.itemKey)).toMatchObject({ isRead: true });
    expect(all.items.find((i) => i.itemKey === second.itemKey)).toMatchObject({ isRead: false });
  });

  // ===========================================================================
  // Concurrency, idempotence, counters
  // ===========================================================================

  it("concurrent mark-read of one item: every call succeeds, one state row, badge drops by exactly one", async () => {
    const key = await seedIntake(A, 1);
    const before = await unread(A.ownerToken, A.teamId);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => act(A.ownerToken, key, "read")),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(
      await prisma.inboxItemState.count({ where: { userId: A.ownerUserId, itemKey: key } }),
    ).toBe(1);
    expect(await unread(A.ownerToken, A.teamId)).toBe(before - 1);
    expect(await unread(A.ownerToken, A.teamId)).toBeGreaterThanOrEqual(0);
  });

  it("a repeated read (another device) keeps the FIRST read time", async () => {
    const key = await seedIntake(A, 1);
    await act(A.ownerToken, key, "read");
    const first = await prisma.inboxItemState.findUniqueOrThrow({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey: key } },
    });
    await new Promise((r) => setTimeout(r, 25));
    const again = await act(A.ownerToken, key, "read");
    expect(again.statusCode).toBe(200);
    const second = await prisma.inboxItemState.findUniqueOrThrow({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey: key } },
    });
    expect(second.readAt?.toISOString()).toBe(first.readAt?.toISOString());
    expect((again.json() as { readAt: string }).readAt).toBe(first.readAt?.toISOString());
  });

  it("the bell count written by ANOTHER API process is invalidated by a mutation here", async () => {
    const key = await seedIntake(A, 1);

    // Another replica cached the workspace-scoped count — through the real
    // cache writer, into the shared store. Then this process forgets every
    // in-memory trace of it, which is exactly the position a DIFFERENT replica
    // (or this one after a restart) is in when the mutation arrives. The
    // stale value is unmistakable.
    const { default: IORedis } = await import("ioredis");
    const redis = new IORedis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    try {
      const otherReplicaKey = `opscenter:summary:${A.ownerUserId}:${A.teamId}`;
      await summaryCache.setCachedOperationsSummary(
        A.ownerUserId,
        JSON.stringify({ unread: 999, critical: 0, high: 0, assignedToMe: 0, overdue: 0, hasTruncatedSources: false }),
        A.teamId,
      );
      summaryCache.__resetOperationsSummaryProcessStateForTests();
      expect(await unread(A.ownerToken, A.teamId), "precondition: the other replica's entry is served").toBe(999);

      expect((await act(A.ownerToken, key, "read")).statusCode).toBe(200);
      expect(await redis.get(otherReplicaKey)).toBeNull();
      expect(await unread(A.ownerToken, A.teamId)).not.toBe(999);
    } finally {
      redis.disconnect();
    }
  });

  // ===========================================================================
  // Pagination
  // ===========================================================================

  it("paging All across read and unread items never duplicates or skips one, and read items are on later pages too", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 7; i += 1) keys.push(await seedIntake(A, i * 10));
    // Read the OLDEST ones, so they sit on the last page under `newest`.
    await act(A.ownerToken, keys[5], "read");
    await act(A.ownerToken, keys[6], "read");

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const env: Envelope = await list(
        A.ownerToken,
        `workspaceId=${A.teamId}&filter=intake&sort=newest&pageSize=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...keysOf(env));
      cursor = env.pagination.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    const mine = seen.filter((k) => keys.includes(k));
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine).toEqual(keys); // newest first, all seven, read ones included

    // The Read view pages too.
    const readPage1 = await list(A.ownerToken, `workspaceId=${A.teamId}&filter=intake&readState=read&sort=newest&pageSize=1`);
    expect(readPage1.items).toHaveLength(1);
    expect(readPage1.pagination.nextCursor).not.toBeNull();
    const readPage2 = await list(
      A.ownerToken,
      `workspaceId=${A.teamId}&filter=intake&readState=read&sort=newest&pageSize=1&cursor=${encodeURIComponent(readPage1.pagination.nextCursor!)}`,
    );
    expect([...keysOf(readPage1), ...keysOf(readPage2)]).toEqual([keys[5], keys[6]]);
  });

  // ===========================================================================
  // Roles and tenants
  // ===========================================================================

  it("role visibility: a delivery failure reaches OWNER and ADMIN only; a workspace intake item reaches every role; nothing crosses tenants", async () => {
    const comm = await prisma.communicationMessage.create({
      data: {
        teamId: A.teamId,
        channel: "SMS",
        purpose: "EVIDENCE_REQUEST",
        recipientHash: "a".repeat(64),
        recipientPreview: "+••• 1234",
        status: "FAILED",
        attemptCount: 3,
        errorCode: "PROVIDER_REJECTED_30003",
      },
      select: { id: true },
    });
    seededComms.push(comm.id);
    const commKey = `communication_failure:${comm.id}`;
    const intakeKey = await seedIntake(A, 1);

    const sees = async (token: string) =>
      keysOf(await list(token, "sort=newest&pageSize=50"));

    for (const token of [A.ownerToken, A.adminToken]) {
      const k = await sees(token);
      expect(k).toContain(commKey);
      expect(k).toContain(intakeKey);
    }
    for (const token of [A.memberToken, A.viewerToken]) {
      const k = await sees(token);
      expect(k).not.toContain(commKey);
      expect(k).toContain(intakeKey);
    }
    const foreign = await sees(B.ownerToken);
    expect(foreign).not.toContain(commKey);
    expect(foreign).not.toContain(intakeKey);

    // A foreign owner cannot narrow to A, and learns nothing by trying.
    const refused = await harness.app.inject({
      method: "GET",
      url: `/v1/me/inbox?workspaceId=${A.teamId}&readState=read`,
      headers: { authorization: `Bearer ${B.ownerToken}` },
    });
    expect(refused.statusCode).toBe(403);
  });

  it("one reader's read state never changes another's", async () => {
    const key = await seedIntake(A, 1);
    await act(A.memberToken, key, "read");
    const owner = await list(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(owner.items.find((i) => i.itemKey === key)).toMatchObject({ isRead: false });
    expect(keysOf(await list(A.ownerToken, `workspaceId=${A.teamId}&readState=read`))).not.toContain(key);
  });

  // ===========================================================================
  // Presentation the server owns: deep links and copy
  // ===========================================================================

  it("deep links are internal paths to the exact resource", async () => {
    const { thread, itemKey } = await seedMention(A, A.memberUserId);
    const intakeKey = await seedIntake(A, 1);
    const all = await list(A.memberToken, `workspaceId=${A.teamId}&sort=newest&pageSize=50`);
    const mention = all.items.find((i) => i.itemKey === itemKey)!;
    expect(mention.href).toBe(
      `/evidence/${A.evidenceId}?tab=discussion&thread=${thread.id}`,
    );
    const intake = all.items.find((i) => i.itemKey === intakeKey)!;
    expect(intake.href).toBe(`/evidence-requests/${intakeKey.split(":")[1]}`);
    for (const it of all.items) {
      expect(it.href.startsWith("/"), it.href).toBe(true);
      expect(it.href.startsWith("//"), it.href).toBe(false);
    }
  });

  it("no raw internal code (enum, snake_case, provider error code) reaches a title or body", async () => {
    await seedThread(A, "IN_PROGRESS", A.ownerUserId);
    const comm = await prisma.communicationMessage.create({
      data: {
        teamId: A.teamId,
        channel: "WHATSAPP",
        purpose: "CONTRIBUTOR_CLARIFICATION",
        recipientHash: "b".repeat(64),
        recipientPreview: "+••• 9876",
        status: "FAILED",
        attemptCount: 1,
        errorCode: "PROVIDER_REJECTED_63016",
      },
      select: { id: true },
    });
    seededComms.push(comm.id);

    const all = await list(A.ownerToken, "sort=newest&pageSize=50");
    const assigned = all.items.find((i) => i.category === "discussion_assigned");
    const failure = all.items.find((i) => i.itemKey === `communication_failure:${comm.id}`);
    expect(assigned, "assigned thread item").toBeDefined();
    expect(failure, "delivery failure item").toBeDefined();

    const RAW = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[a-z]+_[a-z_]+\b/;
    for (const it of all.items) {
      expect(it.title, `${it.category} title`).not.toMatch(RAW);
      expect(it.body, `${it.category} body`).not.toMatch(RAW);
    }
    expect(assigned!.body).toContain("In progress");
    expect(failure!.title).toContain("WhatsApp");
    expect(failure!.body).not.toContain("63016");
  });
});

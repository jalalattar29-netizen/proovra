/**
 * The unread badge is a QUERY, and the query has to read what the mutation
 * wrote. (live PostgreSQL 16)
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 * ---------------------------------------------------------------------------
 * In production the header badge sat on `1` and would not move. `Mark read`,
 * `Mark all as read` and `Dismiss` all returned 200. The `InboxItemState` row
 * was written correctly by every one of them. The count did not change, the
 * item did not leave the list, and repeating the action changed nothing.
 *
 * The cause was not the write. `buildInboxAggregation` assembled its items in
 * stages and joined per-user state in the MIDDLE of that assembly, against a
 * snapshot of the item list taken at that moment. Four categories were emitted
 * after the join — `intake_submission_pending_review`,
 * `intake_required_items_missing`, `intake_link_expiring` and `collaboration`
 * — and only the last of them was given a compensating second fetch. For the
 * other three, `stateByKey` had no entry, so `isRead` was hard-coded false and
 * `dismissedAt` hard-coded null on every request, forever.
 *
 * Both halves of the product read those fields. The bell's count is
 * `visible.filter(i => !i.isRead).length`; the list is the same population.
 * So the badge could not decrement, the item could not be dismissed, and
 * `mark-all-read` re-targeted the same row on every invocation because it,
 * too, asks `if (it.isRead) return false`.
 *
 * Every assertion below therefore reads the count and the list back out of the
 * REAL endpoints after the REAL mutation, against a real database. Nothing
 * here asserts a source string, and nothing trusts a mutation's own return
 * value as evidence that a later read will agree with it — that agreement is
 * exactly what broke.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Inbox unread state (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let summaryCache: typeof import("../src/services/notifications/operations-summary-cache.js");

  /** Workspace under test, and a second one that must never be affected. */
  let A: {
    teamId: string;
    ownerToken: string;
    ownerUserId: string;
    memberToken: string;
    memberUserId: string;
  };
  let B: { teamId: string; ownerToken: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    summaryCache = await import(
      "../src/services/notifications/operations-summary-cache.js"
    );

    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      memberToken: harness.fixtures.teamA.memberToken,
      memberUserId: harness.fixtures.teamA.memberUserId,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerToken: harness.fixtures.teamB.ownerToken,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  const seededRequestIds: string[] = [];

  beforeEach(async () => {
    // Each case starts from a clean attention state for BOTH users in BOTH
    // workspaces, so a count assertion can never be satisfied by a row a
    // previous case left behind.
    await prisma.inboxItemState.deleteMany({
      where: { userId: { in: [A.ownerUserId, A.memberUserId, B.ownerUserId] } },
    });
    if (seededRequestIds.length > 0) {
      await prisma.evidenceRequest.deleteMany({
        where: { id: { in: seededRequestIds } },
      });
      seededRequestIds.length = 0;
    }
    // The summary is cached per user for 45s and is invalidated by USER
    // mutations, not by source-side changes — a documented, bounded staleness
    // the product accepts. Seeding a fixture is a source-side change, so the
    // cache is cleared here to keep each case measuring its own data. This is
    // a fixture concern only: the product path that must invalidate (every
    // read / dismiss / bulk-read) is asserted directly further down.
    for (const userId of [A.ownerUserId, A.memberUserId, B.ownerUserId]) {
      await summaryCache.invalidateOperationsSummary(userId);
    }
  });

  // =========================================================================
  // Helpers — every one drives PRODUCTION code
  // =========================================================================

  /**
   * Seed ONE `intake_submission_pending_review` item.
   *
   * This category is chosen deliberately: it is one of the three that the
   * mid-assembly join could not see, so it is the shortest path to the
   * production symptom. The row is a real `EvidenceRequest` in the state the
   * aggregation's own Source-14 query selects for — response arrived, no
   * reviewer claimed — not a hand-built item.
   */
  async function seedPendingReviewItem(input: {
    teamId: string;
    requestedByUserId: string;
    title?: string;
  }): Promise<{ requestId: string; itemKey: string }> {
    const row = await prisma.evidenceRequest.create({
      data: {
        teamId: input.teamId,
        requestType: "DOCUMENT",
        status: "RESPONSE_RECEIVED",
        priority: "NORMAL",
        title: input.title ?? `Intake ${randomUUID().slice(0, 8)}`,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        requestedByUserId: input.requestedByUserId,
        assignedReviewerUserId: null,
      },
      select: { id: true },
    });
    seededRequestIds.push(row.id);
    return {
      requestId: row.id,
      itemKey: `intake_submission_pending_review:${row.id}`,
    };
  }

  /** The REAL bell count, from the REAL summary endpoint. */
  async function unreadCount(token: string): Promise<number> {
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/me/inbox/summary",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { unread: number }).unread;
  }

  /** The REAL list, from the REAL inbox endpoint. */
  async function listItemKeys(
    token: string,
    filter?: "unread",
  ): Promise<string[]> {
    const res = await harness.app.inject({
      method: "GET",
      url: filter ? `/v1/me/inbox?filter=${filter}` : "/v1/me/inbox",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: Array<{ itemKey: string }> }).items.map(
      (i) => i.itemKey,
    );
  }

  async function itemFromList(
    token: string,
    itemKey: string,
  ): Promise<{ isRead: boolean; dismissedAt: string | null } | null> {
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/me/inbox",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const items = (
      res.json() as {
        items: Array<{
          itemKey: string;
          isRead: boolean;
          dismissedAt: string | null;
        }>;
      }
    ).items;
    return items.find((i) => i.itemKey === itemKey) ?? null;
  }

  async function mutateItem(
    token: string,
    itemKey: string,
    action: "read" | "unread" | "dismiss",
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.statusCode, body };
  }

  async function markAllRead(
    token: string,
  ): Promise<{ status: number; markedRead: number }> {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/me/inbox/mark-all-read",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    const body = res.json() as { markedRead?: number };
    return { status: res.statusCode, markedRead: body.markedRead ?? -1 };
  }

  // =========================================================================
  // 1. The reported symptom, one action at a time
  // =========================================================================

  it("one unread → Mark read → the badge goes 1 to 0 and the row is persisted", async () => {
    const { itemKey } = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });

    const before = await unreadCount(A.ownerToken);
    expect(before).toBeGreaterThanOrEqual(1);
    expect(await listItemKeys(A.ownerToken, "unread")).toContain(itemKey);

    const mutation = await mutateItem(A.ownerToken, itemKey, "read");
    expect(mutation.status).toBe(200);
    expect(mutation.body.isRead).toBe(true);

    // THE ASSERTION THAT WAS FAILING IN PRODUCTION. The mutation always
    // answered `isRead: true` — it is reporting the row it just wrote. The
    // question is whether the COUNT, which is a different computation over a
    // different code path, agrees.
    expect(await unreadCount(A.ownerToken)).toBe(before - 1);
    expect(await listItemKeys(A.ownerToken, "unread")).not.toContain(itemKey);

    // Read state is durable, not a response artifact: the item is still in the
    // full list, and it is marked read there.
    const listed = await itemFromList(A.ownerToken, itemKey);
    expect(listed).not.toBeNull();
    expect(listed!.isRead).toBe(true);

    // And the persisted row is the one the count must be derived from.
    const row = await prisma.inboxItemState.findUnique({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey } },
      select: { readAt: true, dismissedAt: true },
    });
    expect(row?.readAt).toBeInstanceOf(Date);
    expect(row?.dismissedAt).toBeNull();
  });

  it("three unread → Mark ONE read → 3 becomes 2", async () => {
    const seeded = [];
    for (let i = 0; i < 3; i += 1) {
      seeded.push(
        await seedPendingReviewItem({
          teamId: A.teamId,
          requestedByUserId: A.ownerUserId,
          title: `Batch item ${i}`,
        }),
      );
    }
    const before = await unreadCount(A.ownerToken);
    expect(before).toBeGreaterThanOrEqual(3);

    const r = await mutateItem(A.ownerToken, seeded[1].itemKey, "read");
    expect(r.status).toBe(200);

    expect(await unreadCount(A.ownerToken)).toBe(before - 1);
    const unreadKeys = await listItemKeys(A.ownerToken, "unread");
    expect(unreadKeys).toContain(seeded[0].itemKey);
    expect(unreadKeys).not.toContain(seeded[1].itemKey);
    expect(unreadKeys).toContain(seeded[2].itemKey);
  });

  it("three unread → Mark all as read → the badge reaches 0", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedPendingReviewItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Bulk item ${i}`,
      });
    }
    const before = await unreadCount(A.ownerToken);
    expect(before).toBeGreaterThanOrEqual(3);

    const bulk = await markAllRead(A.ownerToken);
    expect(bulk.status).toBe(200);
    expect(bulk.markedRead).toBe(before);

    // ZERO, not "fewer". `mark-all-read` targets exactly the currently-visible
    // unread set, so anything left over means the read it performed is not the
    // read the count is measuring.
    expect(await unreadCount(A.ownerToken)).toBe(0);
    expect(await listItemKeys(A.ownerToken, "unread")).toHaveLength(0);
  });

  it("unread → Dismiss → the item leaves the list and the count drops", async () => {
    const { itemKey } = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });
    const before = await unreadCount(A.ownerToken);

    const r = await mutateItem(A.ownerToken, itemKey, "dismiss");
    expect(r.status).toBe(200);
    expect(r.body.dismissedAt).toBeTruthy();

    expect(await unreadCount(A.ownerToken)).toBe(before - 1);
    // Dismissed means gone from the ACTIVE list — not deleted. The existing
    // product contract is that dismissal is per-user attention state; the
    // history snapshot keeps the record.
    expect(await listItemKeys(A.ownerToken)).not.toContain(itemKey);

    const row = await prisma.inboxItemState.findUnique({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey } },
      select: { readAt: true, dismissedAt: true },
    });
    expect(row?.dismissedAt).toBeInstanceOf(Date);
    // Dismissing implicitly reads, so a dismissed item can never be a
    // "dismissed but unread" ghost in the counter.
    expect(row?.readAt).toBeInstanceOf(Date);
  });

  // =========================================================================
  // 2. Idempotency and bounded outcomes
  // =========================================================================

  it("repeating Mark read / Mark all / Dismiss is idempotent", async () => {
    const { itemKey } = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });
    const before = await unreadCount(A.ownerToken);

    await mutateItem(A.ownerToken, itemKey, "read");
    const afterFirst = await unreadCount(A.ownerToken);
    expect(afterFirst).toBe(before - 1);

    // A second identical click must not move the number again — a count that
    // decremented per CLICK rather than per STATE CHANGE would drift below the
    // truth and then stick there.
    await mutateItem(A.ownerToken, itemKey, "read");
    expect(await unreadCount(A.ownerToken)).toBe(afterFirst);

    await mutateItem(A.ownerToken, itemKey, "dismiss");
    const afterDismiss = await unreadCount(A.ownerToken);
    await mutateItem(A.ownerToken, itemKey, "dismiss");
    expect(await unreadCount(A.ownerToken)).toBe(afterDismiss);

    // Bulk read over an inbox with nothing unread left is a truthful zero,
    // not an error and not a re-write of everything it can see.
    const remaining = await unreadCount(A.ownerToken);
    const bulk = await markAllRead(A.ownerToken);
    expect(bulk.status).toBe(200);
    expect(bulk.markedRead).toBe(remaining);
    const second = await markAllRead(A.ownerToken);
    expect(second.markedRead).toBe(0);
  });

  it("dismissing an ALREADY-READ item still removes it and does not double-count", async () => {
    const { itemKey } = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });
    await mutateItem(A.ownerToken, itemKey, "read");
    const afterRead = await unreadCount(A.ownerToken);

    await mutateItem(A.ownerToken, itemKey, "dismiss");

    // It was already out of the unread population, so the count must NOT fall
    // a second time for the same item.
    expect(await unreadCount(A.ownerToken)).toBe(afterRead);
    expect(await listItemKeys(A.ownerToken)).not.toContain(itemKey);
  });

  it("an unknown / malformed itemKey is refused without revealing anything", async () => {
    const unknownPrefix = await mutateItem(
      A.ownerToken,
      `not_a_real_source:${randomUUID()}`,
      "read",
    );
    expect(unknownPrefix.status).toBeGreaterThanOrEqual(400);
    expect(unknownPrefix.status).toBeLessThan(500);
    expect(JSON.stringify(unknownPrefix.body)).not.toMatch(/select|from |where /i);

    // A well-formed key for a row that does not exist is accepted as attention
    // state (the state table is the caller's own), and it must not change the
    // count of anything that DOES exist.
    const before = await unreadCount(A.ownerToken);
    const ghost = await mutateItem(
      A.ownerToken,
      `intake_submission_pending_review:${randomUUID()}`,
      "read",
    );
    expect([200, 400, 404]).toContain(ghost.status);
    expect(await unreadCount(A.ownerToken)).toBe(before);
  });

  // =========================================================================
  // 3. Isolation — the property a shared count must never violate
  // =========================================================================

  it("two users in ONE workspace keep independent read state", async () => {
    const { itemKey } = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });

    const ownerBefore = await unreadCount(A.ownerToken);
    const memberBefore = await unreadCount(A.memberToken);
    expect(ownerBefore).toBeGreaterThanOrEqual(1);
    expect(memberBefore).toBeGreaterThanOrEqual(1);

    await mutateItem(A.ownerToken, itemKey, "read");

    expect(await unreadCount(A.ownerToken)).toBe(ownerBefore - 1);
    // The other member of the SAME workspace has not read it. Read state is
    // per-recipient; a shared write here would mark work done for someone who
    // never saw it.
    expect(await unreadCount(A.memberToken)).toBe(memberBefore);
    expect(await listItemKeys(A.memberToken, "unread")).toContain(itemKey);

    const memberRow = await prisma.inboxItemState.findUnique({
      where: { userId_itemKey: { userId: A.memberUserId, itemKey } },
    });
    expect(memberRow).toBeNull();
  });

  it("mark-all-read in one workspace never touches another workspace's items", async () => {
    const inA = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });
    const inB = await seedPendingReviewItem({
      teamId: B.teamId,
      requestedByUserId: B.ownerUserId,
    });

    const bBefore = await unreadCount(B.ownerToken);
    expect(await listItemKeys(B.ownerToken, "unread")).toContain(inB.itemKey);

    await markAllRead(A.ownerToken);

    expect(await unreadCount(A.ownerToken)).toBe(0);
    // B's owner is a different recipient in a different workspace. Nothing A's
    // bulk read did may reach them.
    expect(await unreadCount(B.ownerToken)).toBe(bBefore);
    expect(await listItemKeys(B.ownerToken, "unread")).toContain(inB.itemKey);

    // A's own item is read, and B's is not — proven from the rows, not the
    // responses.
    const aRow = await prisma.inboxItemState.findUnique({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey: inA.itemKey } },
      select: { readAt: true },
    });
    expect(aRow?.readAt).toBeInstanceOf(Date);
    const bRow = await prisma.inboxItemState.findUnique({
      where: { userId_itemKey: { userId: B.ownerUserId, itemKey: inB.itemKey } },
    });
    expect(bRow).toBeNull();
  });

  it("a caller cannot mutate another user's state by naming their itemKey", async () => {
    const { itemKey } = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });
    const memberBefore = await unreadCount(A.memberToken);

    // The owner reads it. The write is keyed by (userId, itemKey) with userId
    // taken from the TOKEN, so naming the same key can only ever write the
    // caller's own row.
    await mutateItem(A.ownerToken, itemKey, "read");

    expect(await unreadCount(A.memberToken)).toBe(memberBefore);
    const rows = await prisma.inboxItemState.findMany({
      where: { itemKey },
      select: { userId: true },
    });
    expect(rows.map((r) => r.userId)).toEqual([A.ownerUserId]);
  });

  // =========================================================================
  // 4. The invariant that makes the class of bug unreachable
  // =========================================================================

  it("the badge count and the unread list agree on EVERY category, not just some", async () => {
    // Three categories in one inbox, including two that the mid-assembly join
    // could not see. The check is parity: the number the bell renders and the
    // list the popover renders are the same population by definition, so any
    // category the join misses shows up here as a mismatch.
    await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });
    const incomplete = await prisma.evidenceRequest.create({
      data: {
        teamId: A.teamId,
        requestType: "DOCUMENT",
        status: "NEEDS_MORE_INFO",
        priority: "NORMAL",
        title: `Incomplete ${randomUUID().slice(0, 8)}`,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        requestedByUserId: A.ownerUserId,
      },
      select: { id: true },
    });
    seededRequestIds.push(incomplete.id);

    const count = await unreadCount(A.ownerToken);
    const unreadKeys = await listItemKeys(A.ownerToken, "unread");
    expect(count).toBe(unreadKeys.length);
    expect(unreadKeys).toContain(
      `intake_required_items_missing:${incomplete.id}`,
    );

    // Now read EVERY unread item one at a time and require the count to fall
    // by exactly one each time. A category whose state is not joined would
    // hold the number still on its turn — which is precisely how the
    // production badge stuck on 1.
    let expected = count;
    for (const key of unreadKeys) {
      const res = await mutateItem(A.ownerToken, key, "read");
      expect(res.status).toBe(200);
      expected -= 1;
      expect(
        await unreadCount(A.ownerToken),
        `count did not fall after reading ${key}`,
      ).toBe(expected);
    }
    expect(expected).toBe(0);
    expect(await unreadCount(A.ownerToken)).toBe(0);
  });

  it("the cached summary reflects a mutation immediately, not after its TTL", async () => {
    const { itemKey } = await seedPendingReviewItem({
      teamId: A.teamId,
      requestedByUserId: A.ownerUserId,
    });

    // Prime the cache, then mutate, then read again with no waiting. The
    // summary is cached per user for 45s; if the mutation did not invalidate
    // it the second read would return the primed value and the badge would sit
    // still for the whole TTL.
    const primed = await unreadCount(A.ownerToken);
    await mutateItem(A.ownerToken, itemKey, "read");
    expect(await unreadCount(A.ownerToken)).toBe(primed - 1);
  });
});

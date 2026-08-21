/**
 * The bell's five-most-recent window, proven against the real database.
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 *
 * The dropdown used to be `GET /v1/me/inbox?filter=unread&pageSize=8`, so the
 * LIST WAS THE UNREAD SET. Marking an item read removed it from the list's own
 * population, which made "I have seen this" indistinguishable from "get rid of
 * this", and left a caught-up user with an empty panel.
 *
 * The corrected contract is a different query over the same aggregation:
 * `filter=all&sort=recent&pageSize=5`, scoped to one workspace. Read items
 * stay; only dismissal removes a row; and the badge counts the unread subset of
 * exactly the population the list is drawn from.
 *
 * Every assertion below reads that back out of the REAL endpoints after a REAL
 * mutation, against live PostgreSQL. Nothing here asserts a source string, and
 * nothing trusts a mutation's own response as evidence that a later read will
 * agree with it — that agreement is the whole property.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Notification bell — recent window (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let summaryCache: typeof import("../src/services/notifications/operations-summary-cache.js");

  let A: {
    teamId: string;
    ownerToken: string;
    ownerUserId: string;
    memberToken: string;
    memberUserId: string;
  };
  let B: { teamId: string; ownerToken: string; ownerUserId: string };

  const seeded: string[] = [];

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

  beforeEach(async () => {
    await prisma.inboxItemState.deleteMany({
      where: { userId: { in: [A.ownerUserId, A.memberUserId, B.ownerUserId] } },
    });
    if (seeded.length > 0) {
      await prisma.evidenceRequest.deleteMany({ where: { id: { in: seeded } } });
      seeded.length = 0;
    }
    // Source-side seeding is not a user mutation, so the per-user summary cache
    // does not invalidate itself for it. Cleared here so each case measures its
    // own data; the invalidation the PRODUCT owes is asserted directly below.
    for (const userId of [A.ownerUserId, A.memberUserId, B.ownerUserId]) {
      await summaryCache.invalidateOperationsSummary(userId);
    }
  });

  // =========================================================================
  // Helpers — all of them drive production code
  // =========================================================================

  /**
   * Seed one `intake_submission_pending_review` item at a chosen instant.
   *
   * A real `EvidenceRequest` in the state the aggregation's own source query
   * selects for. `updatedAt` is set out of band because it is `@updatedAt`, and
   * it is what the item's `occurredAt` is derived from — which is what the
   * recency ordering sorts on.
   */
  async function seedItem(input: {
    teamId: string;
    requestedByUserId: string;
    at: Date;
    title?: string;
  }): Promise<{ id: string; itemKey: string }> {
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
    seeded.push(row.id);
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence_requests" SET "updated_at" = $1 WHERE "id" = $2::uuid`,
      input.at,
      row.id,
    );
    return {
      id: row.id,
      itemKey: `intake_submission_pending_review:${row.id}`,
    };
  }

  /** The REAL bell list request. */
  async function bellList(
    token: string,
    workspaceId?: string,
  ): Promise<Array<{ itemKey: string; isRead: boolean; occurredAt: string }>> {
    const scope = workspaceId ? `&workspaceId=${workspaceId}` : "";
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/me/inbox?filter=all&sort=recent&pageSize=5${scope}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (
      res.json() as {
        items: Array<{ itemKey: string; isRead: boolean; occurredAt: string }>;
      }
    ).items;
  }

  /** The REAL badge number. */
  async function unread(token: string, workspaceId?: string): Promise<number> {
    const scope = workspaceId ? `?workspaceId=${workspaceId}` : "";
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/me/inbox/summary${scope}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { unread: number }).unread;
  }

  async function mutate(
    token: string,
    itemKey: string,
    action: "read" | "dismiss",
  ): Promise<number> {
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.statusCode;
  }

  async function markAll(token: string): Promise<number> {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/me/inbox/mark-all-read",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { markedRead: number }).markedRead;
  }

  const BASE = Date.UTC(2026, 7, 21, 12, 0, 0);
  const at = (secondsAgo: number) => new Date(BASE - secondsAgo * 1000);

  async function seedN(n: number, teamId = A.teamId, owner = A.ownerUserId) {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push(
        await seedItem({
          teamId,
          requestedByUserId: owner,
          at: at(i), // index 0 is newest
          title: `Item ${i + 1}`,
        }),
      );
    }
    return out;
  }

  // =========================================================================
  // 1–5. Read keeps the row; dismissal removes it
  // =========================================================================

  it("1. one unread → Mark read → the item is STILL LISTED and the badge is zero", async () => {
    const [item] = await seedN(1);

    expect(await unread(A.ownerToken, A.teamId)).toBe(1);
    expect((await bellList(A.ownerToken, A.teamId)).map((i) => i.itemKey)).toEqual([
      item.itemKey,
    ]);

    expect(await mutate(A.ownerToken, item.itemKey, "read")).toBe(200);

    // THE defect: the row used to leave the list because the list WAS the
    // unread set.
    const after = await bellList(A.ownerToken, A.teamId);
    expect(after.map((i) => i.itemKey)).toEqual([item.itemKey]);
    expect(after[0].isRead).toBe(true);
    expect(await unread(A.ownerToken, A.teamId)).toBe(0);

    // …and it is persisted, not a response artifact.
    const row = await prisma.inboxItemState.findUnique({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey: item.itemKey } },
      select: { readAt: true, dismissedAt: true },
    });
    expect(row?.readAt).toBeInstanceOf(Date);
    expect(row?.dismissedAt).toBeNull();
  });

  it("2. three unread → Mark ONE → three rows remain, badge is two", async () => {
    const items = await seedN(3);
    expect(await unread(A.ownerToken, A.teamId)).toBe(3);

    await mutate(A.ownerToken, items[1].itemKey, "read");

    const after = await bellList(A.ownerToken, A.teamId);
    expect(after).toHaveLength(3);
    expect(after.find((i) => i.itemKey === items[1].itemKey)!.isRead).toBe(true);
    expect(after.filter((i) => i.isRead)).toHaveLength(1);
    expect(await unread(A.ownerToken, A.teamId)).toBe(2);
  });

  it("3. five unread → Mark all → five READ rows remain, badge is zero", async () => {
    await seedN(5);
    expect(await unread(A.ownerToken, A.teamId)).toBe(5);

    const marked = await markAll(A.ownerToken);
    expect(marked).toBeGreaterThanOrEqual(5);

    const after = await bellList(A.ownerToken, A.teamId);
    // Bulk read must not empty the dropdown.
    expect(after).toHaveLength(5);
    expect(after.every((i) => i.isRead)).toBe(true);
    expect(await unread(A.ownerToken, A.teamId)).toBe(0);
  });

  it("4. unread → Dismiss → the row leaves and the next eligible item fills the window", async () => {
    const items = await seedN(6);
    const before = await bellList(A.ownerToken, A.teamId);
    expect(before).toHaveLength(5);
    expect(before.map((i) => i.itemKey)).not.toContain(items[5].itemKey);

    expect(await mutate(A.ownerToken, items[0].itemKey, "dismiss")).toBe(200);

    const after = await bellList(A.ownerToken, A.teamId);
    expect(after.map((i) => i.itemKey)).not.toContain(items[0].itemKey);
    // Still five: the sixth was promoted into the freed slot.
    expect(after).toHaveLength(5);
    expect(after.map((i) => i.itemKey)).toContain(items[5].itemKey);
    expect(await unread(A.ownerToken, A.teamId)).toBe(5);

    // Dismissal PERSISTS and preserves history — the state row survives with
    // both stamps rather than the record being destroyed.
    const row = await prisma.inboxItemState.findUnique({
      where: {
        userId_itemKey: { userId: A.ownerUserId, itemKey: items[0].itemKey },
      },
      select: { readAt: true, dismissedAt: true },
    });
    expect(row?.dismissedAt).toBeInstanceOf(Date);
    expect(row?.readAt).toBeInstanceOf(Date);
    // The SOURCE record is untouched — dismissal is attention state, not
    // deletion.
    expect(
      await prisma.evidenceRequest.findUnique({ where: { id: items[0].id } }),
    ).not.toBeNull();
  });

  it("5. dismissing an already-READ item removes it without moving the badge", async () => {
    const items = await seedN(2);
    await mutate(A.ownerToken, items[0].itemKey, "read");
    expect(await unread(A.ownerToken, A.teamId)).toBe(1);

    await mutate(A.ownerToken, items[0].itemKey, "dismiss");

    const after = await bellList(A.ownerToken, A.teamId);
    expect(after.map((i) => i.itemKey)).toEqual([items[1].itemKey]);
    // It had already left the unread population; dismissing it cannot
    // decrement the count a second time.
    expect(await unread(A.ownerToken, A.teamId)).toBe(1);
  });

  // =========================================================================
  // 6–8. Ordering and the window
  // =========================================================================

  it("6. read and unread share ONE recency order", async () => {
    const items = await seedN(4);
    await mutate(A.ownerToken, items[1].itemKey, "read");
    await mutate(A.ownerToken, items[3].itemKey, "read");

    const after = await bellList(A.ownerToken, A.teamId);
    // Newest first, whatever the read state — a read item does not sink.
    expect(after.map((i) => i.itemKey)).toEqual(items.map((i) => i.itemKey));
    expect(after.map((i) => i.isRead)).toEqual([false, true, false, true]);
  });

  it("7. more than five → exactly the newest five", async () => {
    const items = await seedN(9);
    const after = await bellList(A.ownerToken, A.teamId);
    expect(after).toHaveLength(5);
    expect(after.map((i) => i.itemKey)).toEqual(
      items.slice(0, 5).map((i) => i.itemKey),
    );
    // The badge counts the whole unread population, not the window.
    expect(await unread(A.ownerToken, A.teamId)).toBe(9);
  });

  it("8. equal timestamps produce a STABLE order across repeated reads", async () => {
    const same = new Date(BASE);
    for (let i = 0; i < 4; i += 1) {
      await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        at: same,
        title: `Tie ${i}`,
      });
    }
    const first = (await bellList(A.ownerToken, A.teamId)).map((i) => i.itemKey);
    const second = (await bellList(A.ownerToken, A.teamId)).map((i) => i.itemKey);
    const third = (await bellList(A.ownerToken, A.teamId)).map((i) => i.itemKey);
    // A comparator that returned 0 for a tie would let the order shuffle
    // between requests over identical data, which reads as rows jumping.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  // =========================================================================
  // 9. Idempotency
  // =========================================================================

  it("9. repeating Mark read / Mark all / Dismiss is idempotent", async () => {
    const items = await seedN(3);

    await mutate(A.ownerToken, items[0].itemKey, "read");
    const afterRead = await unread(A.ownerToken, A.teamId);
    await mutate(A.ownerToken, items[0].itemKey, "read");
    expect(await unread(A.ownerToken, A.teamId)).toBe(afterRead);
    expect(await bellList(A.ownerToken, A.teamId)).toHaveLength(3);

    await markAll(A.ownerToken);
    expect(await unread(A.ownerToken, A.teamId)).toBe(0);
    expect(await markAll(A.ownerToken)).toBe(0);
    expect(await unread(A.ownerToken, A.teamId)).toBe(0);

    await mutate(A.ownerToken, items[0].itemKey, "dismiss");
    const afterDismiss = await bellList(A.ownerToken, A.teamId);
    await mutate(A.ownerToken, items[0].itemKey, "dismiss");
    expect(await bellList(A.ownerToken, A.teamId)).toEqual(afterDismiss);
  });

  // =========================================================================
  // 12–15. Scope, isolation, capability
  // =========================================================================

  it("12. two workspaces carry different counts, and each list matches its own", async () => {
    await seedN(3, A.teamId, A.ownerUserId);
    await seedN(1, B.teamId, B.ownerUserId);

    // A's owner is not a member of B, so the two are read by their own owners.
    expect(await unread(A.ownerToken, A.teamId)).toBe(3);
    expect(await bellList(A.ownerToken, A.teamId)).toHaveLength(3);
    expect(await unread(B.ownerToken, B.teamId)).toBe(1);
    expect(await bellList(B.ownerToken, B.teamId)).toHaveLength(1);
  });

  it("13. one user's read state does not change another's, in the same workspace", async () => {
    const [item] = await seedN(1);
    expect(await unread(A.ownerToken, A.teamId)).toBe(1);
    expect(await unread(A.memberToken, A.teamId)).toBe(1);

    await mutate(A.ownerToken, item.itemKey, "read");

    expect(await unread(A.ownerToken, A.teamId)).toBe(0);
    // The other recipient has not read it. Read state is per-recipient.
    expect(await unread(A.memberToken, A.teamId)).toBe(1);
    const memberList = await bellList(A.memberToken, A.teamId);
    expect(memberList.find((i) => i.itemKey === item.itemKey)!.isRead).toBe(false);
  });

  it("14. one user's DISMISSAL does not remove another user's row", async () => {
    const [item] = await seedN(1);
    await mutate(A.ownerToken, item.itemKey, "dismiss");

    expect(await bellList(A.ownerToken, A.teamId)).toHaveLength(0);
    // Still there for the other member — dismissal is attention state, and
    // attention state is per-recipient.
    expect(
      (await bellList(A.memberToken, A.teamId)).map((i) => i.itemKey),
    ).toContain(item.itemKey);
    expect(await unread(A.memberToken, A.teamId)).toBe(1);
  });

  it("15. a non-member cannot scope the bell to a workspace, and learns nothing", async () => {
    await seedN(2, B.teamId, B.ownerUserId);

    for (const url of [
      `/v1/me/inbox/summary?workspaceId=${B.teamId}`,
      `/v1/me/inbox?filter=all&sort=recent&pageSize=5&workspaceId=${B.teamId}`,
    ]) {
      const res = await harness.app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${A.ownerToken}` },
      });
      expect(res.statusCode).toBe(403);
      // Anti-enumerating: no count, no item, no workspace name.
      expect(res.body).not.toMatch(/unread|itemKey|Item /);
    }
  });

  // =========================================================================
  // 21. The badge and the list agree after a full refetch
  // =========================================================================

  it("21. list and badge agree after every mutation, read back from the server", async () => {
    const items = await seedN(6);

    const check = async (label: string) => {
      const list = await bellList(A.ownerToken, A.teamId);
      const count = await unread(A.ownerToken, A.teamId);
      // The window is capped at five, so the badge can legitimately exceed the
      // rows shown — but every unread row in the window must be counted, and a
      // read row must never be.
      const unreadInWindow = list.filter((i) => !i.isRead).length;
      expect(unreadInWindow, `${label}: window unread exceeds badge`).toBeLessThanOrEqual(count);
      return { list, count };
    };

    const start = await check("start");
    expect(start.count).toBe(6);

    await mutate(A.ownerToken, items[0].itemKey, "read");
    expect((await check("after read")).count).toBe(5);

    await mutate(A.ownerToken, items[1].itemKey, "dismiss");
    expect((await check("after dismiss")).count).toBe(4);

    await markAll(A.ownerToken);
    const end = await check("after mark-all");
    expect(end.count).toBe(0);
    expect(end.list.every((i) => i.isRead)).toBe(true);
    expect(end.list).toHaveLength(5);
  });

  it("the summary reflects a mutation immediately, in the workspace scope", async () => {
    const [item] = await seedN(1);
    // Prime the workspace-scoped cache entry, then mutate, then read again.
    const primed = await unread(A.ownerToken, A.teamId);
    expect(primed).toBe(1);
    await mutate(A.ownerToken, item.itemKey, "read");
    // A cache keyed only by user would still be serving the primed value here.
    expect(await unread(A.ownerToken, A.teamId)).toBe(0);
    // …and the all-workspaces scope agrees, because invalidation reaches every
    // scope the caller has.
    expect(await unread(A.ownerToken)).toBe(0);
  });
});

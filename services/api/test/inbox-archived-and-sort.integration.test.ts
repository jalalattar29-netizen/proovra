/**
 * ARCHIVED MEANS ARCHIVED, AND SORT MEANS THE WHOLE POPULATION.
 * (live PostgreSQL 16)
 *
 * ---------------------------------------------------------------------------
 * THE REPORTED DEFECT
 * ---------------------------------------------------------------------------
 * Selecting the "Archived" filter on /notifications returned archived AND
 * non-archived notifications. It was reproducible with nothing more than
 * "open a few notifications, archive two, click Archived".
 *
 * THE CAUSE was not one predicate but two, in two different code paths, both
 * inherited from the filter's previous life as "History" — a view whose
 * question was "what have I already dealt with?", for which "read OR archived"
 * is a correct answer. The control was renamed to "Archived"; neither
 * predicate was narrowed with it.
 *
 *   1. THE ONE THAT ACTUALLY SERVED THE REQUEST. The archive is read from
 *      `operations_inbox_snapshots`, which holds a per-user row for EVERY item
 *      ever surfaced (that is what lets an archived item outlive its source).
 *      The query's `where` carried `userId`, an optional tone and an optional
 *      workspace — and NO lifecycle predicate at all. So it returned the
 *      reader's entire notification history.
 *
 *   2. THE ONE EVERYONE WOULD HAVE FOUND FIRST. `matchesFilter` answered
 *      `item.isRead || item.dismissedAt != null`. This one is unreachable for
 *      the archive — the snapshot branch returns before the live path runs —
 *      which is exactly why it is dangerous: it is a wrong copy of a rule,
 *      sitting one refactor away from becoming the live one.
 *
 * Both are fixed. `archived` is now the canonical key and means
 * `dismissedAt != null`, nothing else; `history` is accepted on the wire and
 * normalized to it so one predicate exists downstream.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ASSERTED HERE
 * ---------------------------------------------------------------------------
 * Every case drives the REAL endpoints against a real database. The archive
 * cases reach the archived state the way a person does — by POSTing the
 * archive action — rather than by writing the snapshot column directly, so a
 * regression in the mutation half fails these too.
 *
 * The sort cases DO set snapshot ordering columns directly. That is a fixture
 * concern and deliberate: the code under test is the ORDERING and its
 * interaction with offset pagination, and the four tones cannot all be
 * produced from one seedable source. What is never faked is the read — every
 * expected order is compared against what the endpoint actually returns, page
 * by page.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Inbox archived filter + sorting (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let summaryCache: typeof import("../src/services/notifications/operations-summary-cache.js");

  let A: { teamId: string; ownerToken: string; ownerUserId: string };
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
    await prisma.inboxItemState.deleteMany({
      where: { userId: { in: [A.ownerUserId, B.ownerUserId] } },
    });
    await prisma.operationsInboxSnapshot.deleteMany({
      where: { userId: { in: [A.ownerUserId, B.ownerUserId] } },
    });
    if (seededRequestIds.length > 0) {
      await prisma.evidenceRequest.deleteMany({
        where: { id: { in: seededRequestIds } },
      });
      seededRequestIds.length = 0;
    }
    for (const userId of [A.ownerUserId, B.ownerUserId]) {
      await summaryCache.invalidateOperationsSummary(userId);
    }
  });

  // =========================================================================
  // Helpers — every read and every mutation goes through production routes
  // =========================================================================

  async function seedItem(input: {
    teamId: string;
    requestedByUserId: string;
    title: string;
  }): Promise<{ requestId: string; itemKey: string }> {
    const row = await prisma.evidenceRequest.create({
      data: {
        teamId: input.teamId,
        requestType: "DOCUMENT",
        status: "RESPONSE_RECEIVED",
        priority: "NORMAL",
        title: input.title,
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

  type ListRow = {
    itemKey: string;
    isRead: boolean;
    dismissedAt: string | null;
    tone: string;
    occurredAt: string;
  };

  async function list(
    token: string,
    query: Record<string, string> = {},
  ): Promise<{
    items: ListRow[];
    totalEstimate: number;
    nextCursor: string | null;
    historyAvailable?: boolean;
  }> {
    const qs = new URLSearchParams(query).toString();
    const res = await harness.app.inject({
      method: "GET",
      url: qs ? `/v1/me/inbox?${qs}` : "/v1/me/inbox",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: ListRow[];
      historyAvailable?: boolean;
      pagination: { totalEstimate: number; nextCursor: string | null };
    };
    return {
      items: body.items,
      totalEstimate: body.pagination.totalEstimate,
      nextCursor: body.pagination.nextCursor,
      historyAvailable: body.historyAvailable,
    };
  }

  async function act(
    token: string,
    itemKey: string,
    action: "read" | "unread" | "archive" | "unarchive",
  ): Promise<number> {
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.statusCode;
  }

  /**
   * Seed the exact population the bug report describes and reach the archived
   * state through the product's own action.
   */
  async function seedThreeActiveTwoArchived(): Promise<{
    active: string[];
    archived: string[];
  }> {
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { itemKey } = await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Archive fixture ${i} ${randomUUID().slice(0, 8)}`,
      });
      seeded.push(itemKey);
    }
    // One read pass so the snapshot rows exist, exactly as a page view would.
    await list(A.ownerToken);
    const archived = seeded.slice(0, 2);
    const active = seeded.slice(2);
    for (const key of archived) {
      expect(await act(A.ownerToken, key, "archive")).toBe(200);
    }
    return { active, archived };
  }

  // =========================================================================
  // 1. THE REPORTED DEFECT
  // =========================================================================

  it("1. Archived returns ONLY archived notifications — the reported defect", async () => {
    const { active, archived } = await seedThreeActiveTwoArchived();

    const res = await list(A.ownerToken, { filter: "archived" });
    const keys = res.items.map((i) => i.itemKey).sort();

    // This is the assertion that failed before the fix: the archived view
    // returned all five.
    expect(keys).toEqual([...archived].sort());
    expect(res.items).toHaveLength(2);
    for (const row of res.items) {
      expect(row.dismissedAt).not.toBeNull();
    }
    for (const activeKey of active) {
      expect(keys).not.toContain(activeKey);
    }
    // And the count the page prints agrees with the rows it shows.
    expect(res.totalEstimate).toBe(2);
  });

  it("2. READ IS NOT ARCHIVED — reading every item archives none of them", async () => {
    // The precise shape of the old predicate (`isRead || dismissedAt`): a
    // reader who merely opened their notifications saw all of them under
    // Archived.
    const seeded: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { itemKey } = await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Read-not-archived ${i} ${randomUUID().slice(0, 8)}`,
      });
      seeded.push(itemKey);
    }
    await list(A.ownerToken);
    for (const key of seeded) {
      expect(await act(A.ownerToken, key, "read")).toBe(200);
    }

    const res = await list(A.ownerToken, { filter: "archived" });
    expect(res.items).toHaveLength(0);
    expect(res.totalEstimate).toBe(0);
  });

  it("3. `history` is the same filter under its legacy name, not a second one", async () => {
    const { archived } = await seedThreeActiveTwoArchived();
    const viaLegacy = await list(A.ownerToken, { filter: "history" });
    const viaCanonical = await list(A.ownerToken, { filter: "archived" });
    expect(viaLegacy.items.map((i) => i.itemKey).sort()).toEqual(
      [...archived].sort(),
    );
    expect(viaLegacy.items.map((i) => i.itemKey).sort()).toEqual(
      viaCanonical.items.map((i) => i.itemKey).sort(),
    );
  });

  // =========================================================================
  // 2. ALL SEMANTICS — the other half of the product decision
  // =========================================================================

  it("4. All = every NON-archived notification; archiving removes from the feed", async () => {
    const { active, archived } = await seedThreeActiveTwoArchived();

    const all = await list(A.ownerToken);
    const keys = all.items.map((i) => i.itemKey);
    for (const activeKey of active) expect(keys).toContain(activeKey);
    for (const archivedKey of archived) expect(keys).not.toContain(archivedKey);
  });

  it("5. unarchive returns the item to All and removes it from Archived", async () => {
    const { archived } = await seedThreeActiveTwoArchived();
    const restored = archived[0]!;
    expect(await act(A.ownerToken, restored, "unarchive")).toBe(200);

    const all = await list(A.ownerToken);
    expect(all.items.map((i) => i.itemKey)).toContain(restored);

    const arch = await list(A.ownerToken, { filter: "archived" });
    expect(arch.items.map((i) => i.itemKey)).not.toContain(restored);
    expect(arch.items).toHaveLength(1);
  });

  it("6. ARCHIVED IMPLIES READ, so Archived + Unread is empty BY CONSTRUCTION", async () => {
    // This is a product rule, not an accident, and it is the reason the UI
    // disables the Unread quick filter while Archived is selected instead of
    // letting the reader assemble a combination that can only ever return
    // nothing. `archiveHandler` writes `readAt` in the same mutation as
    // `dismissedAt` — deliberately, so an "archived but unread" item cannot
    // sit in the unread counter forever where nobody will ever see it.
    //
    // Asserted end-to-end rather than by reading that handler, because what
    // the UI relies on is the state the LIST reports.
    await seedThreeActiveTwoArchived();

    const arch = await list(A.ownerToken, { filter: "archived" });
    expect(arch.items).toHaveLength(2);
    for (const row of arch.items) {
      expect(row.dismissedAt).not.toBeNull();
      expect(row.isRead).toBe(true);
    }

    // The intersection the UI refuses to offer is genuinely empty.
    const both = await list(A.ownerToken, {
      filter: "archived",
      sort: "unread_first",
    });
    expect(both.items.every((i) => i.isRead)).toBe(true);

    // And archiving an item removes it from the unread count rather than
    // hiding an unread item somewhere the reader cannot reach.
    const summary = await harness.app.inject({
      method: "GET",
      url: "/v1/me/inbox/summary",
      headers: { authorization: `Bearer ${A.ownerToken}` },
    });
    expect(summary.statusCode).toBe(200);
    const unread = (summary.json() as { unread: number }).unread;
    const active = await list(A.ownerToken);
    expect(unread).toBe(active.items.filter((i) => !i.isRead).length);
  });

  it("7. one reader's archive is invisible to another — archive is PERSONAL", async () => {
    await seedThreeActiveTwoArchived();
    // B is a different workspace and a different person; nothing A filed can
    // appear in B's archive.
    const arch = await list(B.ownerToken, { filter: "archived" });
    expect(arch.items).toHaveLength(0);
  });

  it("8. bulk mark-all-read refuses the archive under BOTH of its names", async () => {
    for (const filter of ["archived", "history"]) {
      const res = await harness.app.inject({
        method: "POST",
        url: "/v1/me/inbox/mark-all-read",
        headers: {
          authorization: `Bearer ${A.ownerToken}`,
          "content-type": "application/json",
        },
        payload: { filter },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  // =========================================================================
  // 3. SORTING — over the full population, with pagination
  // =========================================================================

  /**
   * Give the archive a known shape. Ordering columns are written directly
   * (fixture); the rows themselves were created by the product.
   */
  async function seedOrderedArchive(
    specs: Array<{ tone: string; minutesAgo: number; read: boolean }>,
  ): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < specs.length; i += 1) {
      const { itemKey } = await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Sort fixture ${i} ${randomUUID().slice(0, 8)}`,
      });
      keys.push(itemKey);
    }
    await list(A.ownerToken);
    for (const key of keys) {
      expect(await act(A.ownerToken, key, "archive")).toBe(200);
    }
    const base = Date.now();
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i]!;
      await prisma.operationsInboxSnapshot.updateMany({
        where: { userId: A.ownerUserId, itemKey: keys[i]! },
        data: {
          severity: spec.tone,
          sourceOccurredAtUtc: new Date(base - spec.minutesAgo * 60_000),
          readAtUtc: spec.read ? new Date(base) : null,
        },
      });
    }
    return keys;
  }

  it("9. newest / oldest are exact reversals over the whole archive", async () => {
    // index:            0    1    2    3
    // minutesAgo:      40   10   30   20   → newest = 1,3,2,0
    const keys = await seedOrderedArchive([
      { tone: "info", minutesAgo: 40, read: false },
      { tone: "info", minutesAgo: 10, read: false },
      { tone: "info", minutesAgo: 30, read: false },
      { tone: "info", minutesAgo: 20, read: false },
    ]);
    const expectNewest = [keys[1]!, keys[3]!, keys[2]!, keys[0]!];

    const newest = await list(A.ownerToken, {
      filter: "archived",
      sort: "newest",
    });
    expect(newest.items.map((i) => i.itemKey)).toEqual(expectNewest);

    const oldest = await list(A.ownerToken, {
      filter: "archived",
      sort: "oldest",
    });
    expect(oldest.items.map((i) => i.itemKey)).toEqual(
      [...expectNewest].reverse(),
    );
  });

  it("10. unread_first puts unread ahead of read, newest within each half", async () => {
    // read flags:      R    U    R    U
    // minutesAgo:     40   30   20   10   → unread: 3,1  then read: 2,0
    const keys = await seedOrderedArchive([
      { tone: "info", minutesAgo: 40, read: true },
      { tone: "info", minutesAgo: 30, read: false },
      { tone: "info", minutesAgo: 20, read: true },
      { tone: "info", minutesAgo: 10, read: false },
    ]);
    const res = await list(A.ownerToken, {
      filter: "archived",
      sort: "unread_first",
    });
    expect(res.items.map((i) => i.itemKey)).toEqual([
      keys[3]!,
      keys[1]!,
      keys[2]!,
      keys[0]!,
    ]);
  });

  it("11. severity orders critical > high > warning > info, NOT alphabetically", async () => {
    // Alphabetical on the varchar would give critical, high, info, warning —
    // this is the case that catches a naive `orderBy: { severity: 'asc' }`.
    const keys = await seedOrderedArchive([
      { tone: "info", minutesAgo: 10, read: false },
      { tone: "warning", minutesAgo: 20, read: false },
      { tone: "critical", minutesAgo: 30, read: false },
      { tone: "high", minutesAgo: 40, read: false },
    ]);
    const res = await list(A.ownerToken, {
      filter: "archived",
      sort: "severity",
    });
    expect(res.items.map((i) => i.tone)).toEqual([
      "critical",
      "high",
      "warning",
      "info",
    ]);
    expect(res.items.map((i) => i.itemKey)).toEqual([
      keys[2]!,
      keys[3]!,
      keys[1]!,
      keys[0]!,
    ]);
  });

  it("12. severity ties break on recency, then stably", async () => {
    const keys = await seedOrderedArchive([
      { tone: "high", minutesAgo: 30, read: false },
      { tone: "high", minutesAgo: 10, read: false },
      { tone: "high", minutesAgo: 20, read: false },
    ]);
    const res = await list(A.ownerToken, {
      filter: "archived",
      sort: "severity",
    });
    expect(res.items.map((i) => i.itemKey)).toEqual([
      keys[1]!,
      keys[2]!,
      keys[0]!,
    ]);
  });

  // =========================================================================
  // 4. SORT + PAGINATION — the property that makes a partial order a bug
  // =========================================================================

  /** Walk every page and return the concatenated key sequence. */
  async function walkAllPages(
    query: Record<string, string>,
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<typeof list>> = await list(
        A.ownerToken,
        cursor ? { ...query, cursor } : query,
      );
      seen.push(...page.items.map((i) => i.itemKey));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return seen;
  }

  it("13. paging an ordering never duplicates or skips a row", async () => {
    const specs = Array.from({ length: 7 }, (_, i) => ({
      tone: (["critical", "high", "warning", "info"] as const)[i % 4]!,
      minutesAgo: 10 * (i + 1),
      read: i % 2 === 0,
    }));
    const keys = await seedOrderedArchive(specs);

    for (const sort of ["newest", "oldest", "unread_first", "severity"]) {
      const paged = await walkAllPages({
        filter: "archived",
        sort,
        pageSize: "2",
      });
      const whole = await walkAllPages({
        filter: "archived",
        sort,
        pageSize: "50",
      });
      // Every row exactly once…
      expect(new Set(paged).size).toBe(keys.length);
      expect(paged).toHaveLength(keys.length);
      // …and paging produced the SAME sequence as reading it in one go, which
      // is the property a partial ordering breaks.
      expect(paged).toEqual(whole);
    }
  });

  it("14. the severity walk crosses tone buckets correctly at a page boundary", async () => {
    // Two criticals then two highs, with pageSize 3: the second page must
    // begin at the LAST high, not restart the bucket.
    const keys = await seedOrderedArchive([
      { tone: "critical", minutesAgo: 20, read: false },
      { tone: "critical", minutesAgo: 10, read: false },
      { tone: "high", minutesAgo: 20, read: false },
      { tone: "high", minutesAgo: 10, read: false },
    ]);
    const expected = [keys[1]!, keys[0]!, keys[3]!, keys[2]!];

    const first = await list(A.ownerToken, {
      filter: "archived",
      sort: "severity",
      pageSize: "3",
    });
    expect(first.items.map((i) => i.itemKey)).toEqual(expected.slice(0, 3));
    expect(first.nextCursor).not.toBeNull();

    const second = await list(A.ownerToken, {
      filter: "archived",
      sort: "severity",
      pageSize: "3",
      cursor: first.nextCursor!,
    });
    expect(second.items.map((i) => i.itemKey)).toEqual(expected.slice(3));
  });

  it("15. sorting the LIVE feed orders the whole population, not one page", async () => {
    // The active list takes its ordering from an in-memory comparator over the
    // full filtered set. Same guarantee, different mechanism, so it gets its
    // own proof.
    const keys: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { itemKey, requestId } = await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Live sort ${i} ${randomUUID().slice(0, 8)}`,
      });
      // `occurredAt` for this category is the request's updatedAt.
      await prisma.$executeRaw`
        UPDATE evidence_requests
           SET updated_at = ${new Date(Date.now() - (i + 1) * 60_000)}
         WHERE id = ${requestId}::uuid`;
      keys.push(itemKey);
    }

    const newest = await walkAllPages({ sort: "newest", pageSize: "2" });
    const seededNewest = newest.filter((k) => keys.includes(k));
    expect(seededNewest).toEqual(keys);

    const oldest = await walkAllPages({ sort: "oldest", pageSize: "2" });
    const seededOldest = oldest.filter((k) => keys.includes(k));
    expect(seededOldest).toEqual([...keys].reverse());
  });

  // =========================================================================
  // 5. THE FOUR AXES — independent, composable, backward compatible
  //
  // `filter` used to be a single slot carrying four different questions
  // (read-state, lifecycle, severity, category), so any two of them were
  // mutually exclusive by accident. That is what made the notification metric
  // cards misbehave: selecting Unread and then High sent BOTH, and the
  // intersection was usually empty with no way out but clearing the first.
  // =========================================================================

  it("17. readState and a CATEGORY compose — the old single slot could not", async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { itemKey } = await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Axis compose ${i} ${randomUUID().slice(0, 8)}`,
      });
      seeded.push(itemKey);
    }
    await list(A.ownerToken);
    // Read ONE of them, so unread and the category genuinely disagree.
    expect(await act(A.ownerToken, seeded[0]!, "read")).toBe(200);

    const composed = await list(A.ownerToken, {
      readState: "unread",
      filter: "intake",
    });
    const keys = composed.items.map((i) => i.itemKey);
    // Both narrowings applied: the intake category AND unread.
    expect(keys).not.toContain(seeded[0]!);
    expect(keys).toContain(seeded[1]!);
    expect(keys).toContain(seeded[2]!);
  });

  it("18. lifecycle and tone compose — archived High is a real question", async () => {
    const keys = await seedOrderedArchive([
      { tone: "high", minutesAgo: 10, read: true },
      { tone: "info", minutesAgo: 20, read: true },
    ]);
    const highArchive = await list(A.ownerToken, {
      lifecycle: "archived",
      tone: "high",
    });
    expect(highArchive.items.map((i) => i.itemKey)).toEqual([keys[0]!]);
  });

  it("19. an explicit axis is never overruled by the legacy compatibility value", async () => {
    await seedThreeActiveTwoArchived();
    // `filter=archived` decomposes to lifecycle=archived — unless the caller
    // said otherwise, in which case the explicit axis wins and the legacy
    // value contributes nothing.
    const explicit = await list(A.ownerToken, {
      filter: "archived",
      lifecycle: "active",
    });
    expect(explicit.items).toHaveLength(3);
    expect(explicit.items.every((i) => i.dismissedAt === null)).toBe(true);
  });

  it("20. the legacy single-slot spellings still answer as they always did", async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { itemKey } = await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Legacy ${i} ${randomUUID().slice(0, 8)}`,
      });
      seeded.push(itemKey);
    }
    await list(A.ownerToken);
    expect(await act(A.ownerToken, seeded[0]!, "read")).toBe(200);
    expect(await act(A.ownerToken, seeded[1]!, "archive")).toBe(200);

    // `?filter=unread` — a shipped URL.
    const unread = await list(A.ownerToken, { filter: "unread" });
    const unreadKeys = unread.items.map((i) => i.itemKey);
    expect(unreadKeys).toContain(seeded[2]!);
    expect(unreadKeys).not.toContain(seeded[0]!);
    expect(unreadKeys).not.toContain(seeded[1]!);

    // …and its canonical axis spelling returns the SAME population.
    const viaAxis = await list(A.ownerToken, { readState: "unread" });
    expect(viaAxis.items.map((i) => i.itemKey).sort()).toEqual(
      [...unreadKeys].sort(),
    );
  });

  it("21. the archive honours a CATEGORY narrowing rather than ignoring it", async () => {
    await seedThreeActiveTwoArchived();
    // Every seeded item is an intake submission, so the intake category keeps
    // them and an unrelated category keeps none — pushed down to the query,
    // which is what makes the count and the rows agree.
    const intake = await list(A.ownerToken, {
      lifecycle: "archived",
      filter: "intake",
    });
    expect(intake.items).toHaveLength(2);
    expect(intake.totalEstimate).toBe(2);

    const reports = await list(A.ownerToken, {
      lifecycle: "archived",
      filter: "reports",
    });
    expect(reports.items).toHaveLength(0);
    expect(reports.totalEstimate).toBe(0);
  });

  // =========================================================================
  // 6. THE METRIC-CARD BASIS
  //
  // The six cards are ALTERNATIVE primary filters. Their counts must describe
  // the population the reader is currently looking at, MINUS the one axis the
  // cards themselves set:
  //
  //     IN   lifecycle, category, workspace
  //     OUT  tone, read-state
  //
  // They used to read `scopeSummary`, which is deliberately filter-independent
  // because it drives the filter-chip reveal and must not shrink when a filter
  // narrows. So selecting Archived showed the ACTIVE severity distribution
  // above a list of archived rows — the numbers and the list disagreed.
  // =========================================================================

  /** `metricSummary` as the endpoint reports it. */
  async function metrics(
    token: string,
    query: Record<string, string> = {},
  ): Promise<{ total: number; unread: number; byTone: Record<string, number> }> {
    const qs = new URLSearchParams(query).toString();
    const res = await harness.app.inject({
      method: "GET",
      url: qs ? `/v1/me/inbox?${qs}` : "/v1/me/inbox",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { metricSummary: {
      total: number;
      unread: number;
      byTone: Record<string, number>;
    } }).metricSummary;
  }

  it("22. Archived redistributes every count to the archived population", async () => {
    // 8 archived High + 2 archived Info, and 18 ACTIVE High that must not be
    // counted once the archive is selected.
    const archived = await seedOrderedArchive([
      ...Array.from({ length: 8 }, (_, i) => ({
        tone: "high",
        minutesAgo: 10 + i,
        read: true,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        tone: "info",
        minutesAgo: 40 + i,
        read: true,
      })),
    ]);
    expect(archived).toHaveLength(10);
    for (let i = 0; i < 18; i += 1) {
      await seedItem({
        teamId: A.teamId,
        requestedByUserId: A.ownerUserId,
        title: `Active high ${i} ${randomUUID().slice(0, 8)}`,
      });
    }
    await list(A.ownerToken);

    const m = await metrics(A.ownerToken, { lifecycle: "archived" });
    expect(m.total).toBe(10);
    expect(m.unread).toBe(0);
    expect(m.byTone).toEqual({ critical: 0, high: 8, warning: 0, info: 2 });

    // …and the list it sits above agrees with it.
    const rows = await list(A.ownerToken, {
      lifecycle: "archived",
      pageSize: "50",
    });
    expect(rows.items).toHaveLength(10);
    expect(rows.totalEstimate).toBe(10);
  });

  it("23. the cards' OWN axes are excluded from their own basis", async () => {
    await seedOrderedArchive([
      { tone: "high", minutesAgo: 10, read: true },
      { tone: "info", minutesAgo: 20, read: true },
    ]);

    const base = await metrics(A.ownerToken, { lifecycle: "archived" });
    expect(base.byTone).toEqual({ critical: 0, high: 1, warning: 0, info: 1 });

    // Selecting High narrows the LIST and leaves the BASIS alone — which is
    // what keeps the other five cards telling you what is behind them.
    const withTone = await metrics(A.ownerToken, {
      lifecycle: "archived",
      tone: "high",
    });
    expect(withTone).toEqual(base);

    const withRead = await metrics(A.ownerToken, {
      lifecycle: "archived",
      readState: "unread",
    });
    expect(withRead).toEqual(base);
  });

  it("24. an ADVANCED filter narrows the basis; the list follows it", async () => {
    await seedThreeActiveTwoArchived();
    // Every seeded row is an intake submission.
    const intake = await metrics(A.ownerToken, {
      lifecycle: "archived",
      filter: "intake",
    });
    expect(intake.total).toBe(2);

    const reports = await metrics(A.ownerToken, {
      lifecycle: "archived",
      filter: "reports",
    });
    expect(reports.total).toBe(0);
    expect(reports.byTone).toEqual({
      critical: 0,
      high: 0,
      warning: 0,
      info: 0,
    });
  });

  it("25. sorting and paging never move a count", async () => {
    await seedOrderedArchive([
      { tone: "high", minutesAgo: 10, read: true },
      { tone: "high", minutesAgo: 20, read: true },
      { tone: "info", minutesAgo: 30, read: true },
    ]);
    const base = await metrics(A.ownerToken, { lifecycle: "archived" });
    expect(base.total).toBe(3);

    for (const sort of ["newest", "oldest", "unread_first", "severity"]) {
      expect(
        await metrics(A.ownerToken, { lifecycle: "archived", sort }),
      ).toEqual(base);
    }
    // A single-row page reports the same totals as a whole one — the counts
    // come from the population, never from the rows this page holds.
    const paged = await metrics(A.ownerToken, {
      lifecycle: "archived",
      pageSize: "1",
    });
    expect(paged).toEqual(base);
  });

  it("26. the ACTIVE basis excludes archived rows", async () => {
    const { active } = await seedThreeActiveTwoArchived();
    const m = await metrics(A.ownerToken);
    expect(m.total).toBe(active.length);
    // Archiving takes a row out of the normal feed AND out of its counts.
    const archived = await metrics(A.ownerToken, { lifecycle: "archived" });
    expect(archived.total).toBe(2);
    expect(m.total + archived.total).toBe(5);
  });

  it("16. an unknown sort value falls back to the default, never to a 500", async () => {
    await seedThreeActiveTwoArchived();
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/me/inbox?sort=not-a-sort",
      headers: { authorization: `Bearer ${A.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

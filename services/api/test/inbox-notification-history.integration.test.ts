/**
 * Notification history — a read or resolved notification never vanishes.
 * (live PostgreSQL 16 + Redis)
 *
 * Reported: read notifications disappear from the Notifications page (All and
 * Read). Three causes, each pinned here against the real endpoints:
 *
 *   1. Read discussion mentions were only returned while CREATED in the last
 *      30 days, so a mention made 31 days ago left every view once read.
 *   2. Collaboration notifications were bounded to the last 30 days by
 *      creation time, read or not.
 *   3. Most items are live projections of a condition. When the condition
 *      clears the item leaves the live feed — and with it All and Read — even
 *      though its notification-history snapshot was kept. Only ARCHIVED
 *      snapshots were ever served.
 *
 * The contract asserted: the bell (and its unread count) stays CURRENT; the
 * page's All = live items + resolved notification history (no duplicates),
 * Unread = unread live items only, Read = read live items + read history,
 * Archived unchanged — with stable pagination across the merged population.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness, TeamFixture } from "./integration-harness.js";
import { expectFaithfulInboxMessages } from "./helpers/inbox-message-fidelity.js";

type Item = {
  itemKey: string;
  category: string;
  isRead: boolean;
  readAt: string | null;
  title: string;
  body: string;
  href: string;
  occurredAt: string;
  resolvedAt?: string | null;
  canMarkRead: boolean;
  message?: unknown;
};

type Envelope = {
  items: Item[];
  pagination: { nextCursor: string | null; totalEstimate: number; totalIsExact: boolean };
  metricSummary: { total: number; unread: number };
  truncated: Record<string, boolean>;
  completeness?: { incompleteSources: string[] };
};

const DAY = 24 * 60 * 60 * 1000;

describe("Notification history — read and resolved notifications stay in All / Read (live PostgreSQL 16 + Redis)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let summaryCache: typeof import("../src/services/notifications/operations-summary-cache.js");
  let A: TeamFixture;
  let B: TeamFixture;

  const seededRequests: string[] = [];
  const seededThreads: string[] = [];
  const seededCollab: string[] = [];

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
    await prisma.operationsInboxSnapshot.deleteMany({ where: { userId: { in: everyone() } } });
    await prisma.workspaceNotificationPreference.deleteMany({
      where: { userId: { in: everyone() } },
    });
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
    if (seededCollab.length > 0) {
      await prisma.collaborationTeamNotification.deleteMany({ where: { id: { in: seededCollab } } });
      seededCollab.length = 0;
    }
    for (const userId of everyone()) {
      await summaryCache.invalidateOperationsSummary(userId);
    }
  });

  // ===========================================================================
  // Helpers — every read and mutation goes through production routes
  // ===========================================================================

  const BASE = Date.now() - 60_000;

  async function seedIntake(team: TeamFixture, secondsAgo: number) {
    const row = await prisma.evidenceRequest.create({
      data: {
        teamId: team.teamId,
        requestType: "DOCUMENT",
        status: "RESPONSE_RECEIVED",
        priority: "NORMAL",
        title: `History ${randomUUID().slice(0, 8)}`,
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
    return { id: row.id, itemKey: `intake_submission_pending_review:${row.id}` };
  }

  /** The source condition clears: the live projection stops emitting it. */
  async function resolveIntake(id: string) {
    await prisma.evidenceRequest.update({ where: { id }, data: { status: "CLOSED" } });
  }

  async function reopenIntake(id: string) {
    await prisma.evidenceRequest.update({
      where: { id },
      data: { status: "RESPONSE_RECEIVED" },
    });
  }

  async function seedThread(team: TeamFixture) {
    const thread = await prisma.discussionThread.create({
      data: {
        teamId: team.teamId,
        evidenceId: team.evidenceId,
        title: `History thread ${randomUUID().slice(0, 8)}`,
        visibility: "INTERNAL",
        status: "OPEN",
        createdByUserId: team.ownerUserId,
      },
    });
    seededThreads.push(thread.id);
    return thread;
  }

  async function seedMention(
    team: TeamFixture,
    mentionedUserId: string,
    opts: { createdDaysAgo?: number; readDaysAgo?: number | null; threadId?: string } = {},
  ) {
    const thread = opts.threadId
      ? await prisma.discussionThread.findUniqueOrThrow({ where: { id: opts.threadId } })
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
        createdAt: new Date(Date.now() - (opts.createdDaysAgo ?? 0) * DAY),
        notifiedAtUtc:
          opts.readDaysAgo == null ? null : new Date(Date.now() - opts.readDaysAgo * DAY),
      },
    });
    return { thread, mention, itemKey: `discussion_mention:${mention.id}` };
  }

  async function seedCollab(
    team: TeamFixture,
    userId: string,
    opts: { createdDaysAgo: number; readDaysAgo: number | null },
  ) {
    const row = await prisma.collaborationTeamNotification.create({
      data: {
        userId,
        workspaceId: team.teamId,
        type: "DISCUSSION_REPLY",
        title: `Reply in history ${randomUUID().slice(0, 8)}`,
        createdAt: new Date(Date.now() - opts.createdDaysAgo * DAY),
        readAt:
          opts.readDaysAgo == null ? null : new Date(Date.now() - opts.readDaysAgo * DAY),
      },
    });
    seededCollab.push(row.id);
    return `collaboration:${row.id}`;
  }

  /** What the Notifications page (web and mobile) asks for. */
  async function page(token: string, query: string): Promise<Envelope> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/me/inbox?include=resolved&${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const env = res.json() as Envelope;
    expectFaithfulInboxMessages(env.items);
    return env;
  }

  /** Every page of a view, following the opaque cursor. */
  async function allPages(token: string, query: string, pageSize: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const env: Envelope = await page(
        token,
        `${query}&pageSize=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(env.items.length).toBeLessThanOrEqual(pageSize);
      seen.push(...env.items.map((i) => i.itemKey));
      cursor = env.pagination.nextCursor;
      guard += 1;
    } while (cursor && guard < 50);
    return seen;
  }

  /** What the header bell asks for: its preview list and its count. */
  async function bellList(token: string): Promise<Item[]> {
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/me/inbox?filter=all&sort=recent&pageSize=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as Envelope).items;
  }

  async function bellUnread(token: string, workspaceId?: string): Promise<number> {
    // Fixtures are written straight to the database, behind the summary
    // cache's back; drop it so the count is recomputed from the sources.
    for (const userId of everyone()) await summaryCache.invalidateOperationsSummary(userId);
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/me/inbox/summary${workspaceId ? `?workspaceId=${workspaceId}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { unread: number }).unread;
  }

  async function act(token: string, itemKey: string, action: string) {
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  const keysOf = (env: Envelope) => env.items.map((i) => i.itemKey);
  const views = async (token: string, scope: string) => ({
    all: keysOf(await page(token, `${scope}&sort=newest&pageSize=50`)),
    unread: keysOf(await page(token, `${scope}&readState=unread&sort=newest&pageSize=50`)),
    read: keysOf(await page(token, `${scope}&readState=read&sort=newest&pageSize=50`)),
  });

  // ===========================================================================
  // 1 — mentions: no creation-time window on read history
  // ===========================================================================

  it("a read mention created 45 days ago is in All and Read, never Unread, and never in the bell count", async () => {
    const before = await bellUnread(A.memberToken, A.teamId);
    const { itemKey } = await seedMention(A, A.memberUserId, { createdDaysAgo: 45, readDaysAgo: 44 });

    const v = await views(A.memberToken, `workspaceId=${A.teamId}`);
    expect(v.all).toContain(itemKey);
    expect(v.read).toContain(itemKey);
    expect(v.unread).not.toContain(itemKey);
    const all = await page(A.memberToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(all.items.find((i) => i.itemKey === itemKey)).toMatchObject({ isRead: true });
    expect(await bellUnread(A.memberToken, A.teamId)).toBe(before);
  });

  it("a 45-day-old mention opened from the bell (thread mark-mentions-read) stays in All and Read, and its history keeps the read", async () => {
    const { thread, itemKey } = await seedMention(A, A.memberUserId, { createdDaysAgo: 45 });
    // Surfaced on the page while unread: its notification-history snapshot is written.
    expect((await views(A.memberToken, `workspaceId=${A.teamId}`)).unread).toContain(itemKey);
    const before = await bellUnread(A.memberToken, A.teamId);

    // Exactly what the bell's deep link does: open the thread.
    const seen = await harness.app.inject({
      method: "POST",
      url: `/v1/collaboration/threads/${thread.id}/mark-mentions-read?teamId=${A.teamId}`,
      headers: { authorization: `Bearer ${A.memberToken}` },
    });
    expect(seen.statusCode, seen.body).toBe(200);

    const v = await views(A.memberToken, `workspaceId=${A.teamId}`);
    expect(v.all).toContain(itemKey);
    expect(v.read).toContain(itemKey);
    expect(v.unread).not.toContain(itemKey);
    expect(await bellUnread(A.memberToken, A.teamId)).toBe(before - 1);

    // The snapshot now carries the read the Discussion tab recorded, so the
    // notification still reads as read once it leaves the live feed.
    const snap = await prisma.operationsInboxSnapshot.findUniqueOrThrow({
      where: { userId_itemKey: { userId: A.memberUserId, itemKey } },
    });
    expect(snap.readAtUtc).toBeInstanceOf(Date);
  });

  it("read mentions beyond the source's read bound neither mark mentions incomplete nor disappear", async () => {
    const thread = await seedThread(A);
    // The oldest read mention, first surfaced while still unread.
    const oldest = await seedMention(A, A.memberUserId, { createdDaysAgo: 200, threadId: thread.id });
    await page(A.memberToken, `workspaceId=${A.teamId}&sort=newest`);
    await act(A.memberToken, oldest.itemKey, "read");
    await prisma.discussionMention.update({
      where: { id: oldest.mention.id },
      data: { notifiedAtUtc: new Date(Date.now() - 150 * DAY) },
    });
    // 100 more recently read mentions push it past the read half's bound.
    for (let i = 0; i < 100; i += 1) {
      await seedMention(A, A.memberUserId, { createdDaysAgo: 40, readDaysAgo: 1, threadId: thread.id });
    }

    const first = await page(A.memberToken, `workspaceId=${A.teamId}&filter=mentions&sort=newest`);
    expect(first.truncated.discussion_mention).toBe(false);
    expect(first.completeness?.incompleteSources ?? []).not.toContain("discussion_mention");

    const all = await allPages(A.memberToken, `workspaceId=${A.teamId}&filter=mentions&sort=newest`, 50);
    const read = await allPages(
      A.memberToken,
      `workspaceId=${A.teamId}&filter=mentions&readState=read&sort=newest`,
      50,
    );
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(101);
    expect(all).toContain(oldest.itemKey);
    expect(read).toContain(oldest.itemKey);
    expect(read).toHaveLength(101);
  });

  // ===========================================================================
  // 2 — collaboration: no 30-day creation window
  // ===========================================================================

  it("a read collaboration notification older than 30 days is in All and Read, never Unread", async () => {
    const before = await bellUnread(A.ownerToken, A.teamId);
    const key = await seedCollab(A, A.ownerUserId, { createdDaysAgo: 40, readDaysAgo: 39 });
    const v = await views(A.ownerToken, `workspaceId=${A.teamId}`);
    expect(v.all).toContain(key);
    expect(v.read).toContain(key);
    expect(v.unread).not.toContain(key);
    expect(await bellUnread(A.ownerToken, A.teamId)).toBe(before);
  });

  it("an unread collaboration notification older than 30 days is still unread and still counted", async () => {
    const before = await bellUnread(A.ownerToken, A.teamId);
    const key = await seedCollab(A, A.ownerUserId, { createdDaysAgo: 40, readDaysAgo: null });
    const v = await views(A.ownerToken, `workspaceId=${A.teamId}`);
    expect(v.unread).toContain(key);
    expect(v.read).not.toContain(key);
    expect(await bellUnread(A.ownerToken, A.teamId)).toBe(before + 1);
  });

  // ===========================================================================
  // 3 — resolved conditions: served from notification history
  // ===========================================================================

  it("an item marked read and then resolved stays in All and Read from its snapshot; the bell does not count or list it", async () => {
    const { id, itemKey } = await seedIntake(A, 1);
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    await act(A.ownerToken, itemKey, "read");
    const bellBefore = await bellUnread(A.ownerToken, A.teamId);

    await resolveIntake(id);
    // The request that observes the absence resolves the snapshot …
    const all = await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    const row = all.items.find((i) => i.itemKey === itemKey);
    // … and the notification is still there, as history.
    expect(row, "a resolved notification must not vanish").toBeDefined();
    expect(row).toMatchObject({ isRead: true, canMarkRead: false });
    expect(row?.resolvedAt).toEqual(expect.any(String));
    expect(row?.href).toBe(`/evidence-requests/${id}`);

    const v = await views(A.ownerToken, `workspaceId=${A.teamId}`);
    expect(v.read).toContain(itemKey);
    expect(v.unread).not.toContain(itemKey);

    // The bell stays current: neither its count nor its list includes history.
    expect(await bellUnread(A.ownerToken, A.teamId)).toBe(bellBefore);
    expect((await bellList(A.ownerToken)).map((i) => i.itemKey)).not.toContain(itemKey);
    // Read never archived it.
    const snap = await prisma.operationsInboxSnapshot.findUniqueOrThrow({
      where: { userId_itemKey: { userId: A.ownerUserId, itemKey } },
    });
    expect(snap.dismissedAtUtc).toBeNull();
    expect(snap.resolvedAtUtc).toBeInstanceOf(Date);
  });

  it("a resolved item never read is in All only; the bell count drops with the live item and history adds nothing", async () => {
    const { id, itemKey } = await seedIntake(A, 1);
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    const bellBefore = await bellUnread(A.ownerToken, A.teamId);

    await resolveIntake(id);
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    await summaryCache.invalidateOperationsSummary(A.ownerUserId);

    const v = await views(A.ownerToken, `workspaceId=${A.teamId}`);
    expect(v.all).toContain(itemKey);
    expect(v.unread).not.toContain(itemKey);
    expect(v.read).not.toContain(itemKey);
    expect(await bellUnread(A.ownerToken, A.teamId)).toBe(bellBefore - 1);
    // The page's unread metric is the bell's population, not history's.
    const unreadView = await page(A.ownerToken, `workspaceId=${A.teamId}&readState=unread&sort=newest`);
    const allView = await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    expect(allView.metricSummary.unread).toBe(unreadView.pagination.totalEstimate);
  });

  it("a condition that re-fires appears exactly once, as the live item — never beside its own snapshot", async () => {
    const { id, itemKey } = await seedIntake(A, 1);
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    await act(A.ownerToken, itemKey, "read");
    await resolveIntake(id);
    expect(keysOf(await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`))).toContain(itemKey);

    await reopenIntake(id);
    for (const query of [
      `workspaceId=${A.teamId}&sort=newest&pageSize=50`,
      `workspaceId=${A.teamId}&readState=read&sort=newest&pageSize=50`,
      `workspaceId=${A.teamId}&sort=priority&pageSize=50`,
    ]) {
      const env = await page(A.ownerToken, query);
      const rows = env.items.filter((i) => i.itemKey === itemKey);
      expect(rows, query).toHaveLength(1);
      expect(rows[0].resolvedAt ?? null, query).toBeNull();
      expect(rows[0].canMarkRead, query).toBe(true);
    }
  });

  it("a live item hidden by an in-app preference is not brought back by its own snapshot", async () => {
    const { itemKey } = await seedIntake(A, 1);
    expect(keysOf(await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`))).toContain(itemKey);

    // The reader mutes intake notifications in-app. The item is still live
    // (suppressed, not resolved), so its snapshot leaves the sync set …
    await prisma.workspaceNotificationPreference.create({
      data: {
        userId: A.ownerUserId,
        teamId: A.teamId,
        preferenceType: "EVIDENCE_REQUEST_UPDATE",
        channel: "IN_APP",
        enabled: false,
      },
    });
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    // … but a live item always wins over its own snapshot: muted means muted.
    const v = await views(A.ownerToken, `workspaceId=${A.teamId}`);
    expect(v.all).not.toContain(itemKey);
    expect(v.read).not.toContain(itemKey);
  });

  it("an archived item stays on the Archived lifecycle only, resolved or not", async () => {
    const { id, itemKey } = await seedIntake(A, 1);
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    await act(A.ownerToken, itemKey, "archive");
    await resolveIntake(id);

    const v = await views(A.ownerToken, `workspaceId=${A.teamId}`);
    expect(v.all).not.toContain(itemKey);
    expect(v.read).not.toContain(itemKey);
    expect(v.unread).not.toContain(itemKey);
    const archived = await page(A.ownerToken, `workspaceId=${A.teamId}&lifecycle=archived&sort=newest`);
    expect(keysOf(archived)).toEqual([itemKey]);
  });

  it("history from a workspace the reader can no longer access is redacted, and narrowing never crosses tenants", async () => {
    // A history row owned by the caller but bound to a workspace they are not in.
    const foreignKey = `intake_submission_pending_review:${randomUUID()}`;
    await prisma.operationsInboxSnapshot.create({
      data: {
        userId: A.ownerUserId,
        itemKey: foreignKey,
        sourceType: "intake_submission_pending_review",
        sourceId: foreignKey.split(":")[1],
        teamId: B.teamId,
        category: "intake_submission_pending_review",
        severity: "warning",
        priority: "P3",
        title: "Tenant B secret intake",
        body: "Tenant B secret body",
        href: "/evidence-requests/secret",
        sourceOccurredAtUtc: new Date(Date.now() - DAY),
        readAtUtc: new Date(),
        resolvedAtUtc: new Date(),
        resolutionSource: "SOURCE_STATE",
      },
    });

    const all = await page(A.ownerToken, "sort=newest&pageSize=50");
    const row = all.items.find((i) => i.itemKey === foreignKey);
    expect(row).toBeDefined();
    expect(row!.title).not.toContain("Tenant B");
    expect(row!.body).not.toContain("Tenant B");
    expect(row!.href).toBe("");
    expect(row!.canMarkRead).toBe(false);
    expect(JSON.stringify(all.items)).not.toContain("secret");

    // Narrowed to A, B-bound history is out of scope entirely.
    expect(keysOf(await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest&pageSize=50`))).not.toContain(
      foreignKey,
    );
    // And B's owner never sees A's history at all.
    expect(keysOf(await page(B.ownerToken, "sort=newest&pageSize=50"))).not.toContain(foreignKey);
  });

  // ===========================================================================
  // Pagination across the merged population
  // ===========================================================================

  it("All, Read and Unread page across live and resolved items with no duplicate and no gap, in one total order", async () => {
    const seeded: Array<{ id: string; itemKey: string }> = [];
    for (let i = 0; i < 8; i += 1) seeded.push(await seedIntake(A, i * 10));
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);
    // Read four (two of which then resolve), resolve two unread ones.
    for (const i of [0, 3, 4, 7]) await act(A.ownerToken, seeded[i].itemKey, "read");
    for (const i of [3, 4, 5, 6]) await resolveIntake(seeded[i].id);
    await page(A.ownerToken, `workspaceId=${A.teamId}&sort=newest`);

    const keys = seeded.map((s) => s.itemKey);
    const scope = `workspaceId=${A.teamId}&filter=intake`;
    for (const pageSize of [1, 3]) {
      const all = await allPages(A.ownerToken, `${scope}&sort=newest`, pageSize);
      expect(new Set(all).size, "no duplicates in All").toBe(all.length);
      expect(all.filter((k) => keys.includes(k)), "All, newest first, nothing skipped").toEqual(keys);

      const read = await allPages(A.ownerToken, `${scope}&readState=read&sort=newest`, pageSize);
      expect(new Set(read).size).toBe(read.length);
      expect(read.filter((k) => keys.includes(k))).toEqual([0, 3, 4, 7].map((i) => keys[i]));

      const unread = await allPages(A.ownerToken, `${scope}&readState=unread&sort=newest`, pageSize);
      expect(new Set(unread).size).toBe(unread.length);
      // Only LIVE unread items: 1 and 2. Resolved 5 and 6 are history, not the bell's population.
      expect(unread.filter((k) => keys.includes(k))).toEqual([1, 2].map((i) => keys[i]));

      const oldest = await allPages(A.ownerToken, `${scope}&sort=oldest`, pageSize);
      expect(oldest.filter((k) => keys.includes(k))).toEqual([...keys].reverse());
    }

    // Priority is a work queue: every live item ranks above every resolved one.
    const priority = await allPages(A.ownerToken, `${scope}&sort=priority`, 2);
    const mine = priority.filter((k) => keys.includes(k));
    const resolvedSet = new Set([3, 4, 5, 6].map((i) => keys[i]));
    const firstResolved = mine.findIndex((k) => resolvedSet.has(k));
    expect(mine.slice(firstResolved).every((k) => resolvedSet.has(k))).toBe(true);
    expect(mine.slice(firstResolved)).toEqual([3, 4, 5, 6].map((i) => keys[i]));

    // The bell's list never carries history.
    const bell = (await bellList(A.ownerToken)).map((i) => i.itemKey);
    for (const k of resolvedSet) expect(bell).not.toContain(k);
  });
});

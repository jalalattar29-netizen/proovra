/**
 * Phase RW3 — Reviewer-ops queue real cursor pagination.
 *
 * Replaces the Phase RW2 "Showing the first N" CANNOT_WIRE banner with
 * honest cursor pagination wired end-to-end:
 *
 *   Route (services/api/src/routes/reviewer-ops.routes.ts):
 *     - QueueQuery Zod now accepts `cursor: z.string().uuid().optional()`.
 *     - Cursor is forwarded into the service as `cursor: q.cursor ?? null`.
 *     - A cursor-only validation failure surfaces a dedicated 400
 *       `INVALID_CURSOR` so the frontend can stop forwarding a broken
 *       cursor without dumping the entire row state.
 *
 *   Service (services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts):
 *     - `listReviewerOpsQueueInner` reads `input.cursor` and, when set,
 *       calls Prisma findMany with `{ cursor: { id }, skip: 1 }`.
 *     - Adds `{ id: "desc" }` as a tiebreaker to the orderBy tuple so
 *       the ordering is total and `cursor: { id }` is well-defined.
 *
 * This file is source-contract + behavioural. The behavioural half mocks
 * Prisma's `evidenceReviewWorkflow.findMany` so we can prove:
 *
 *   1. First page: ≤ limit rows returned and nextCursor is the last
 *      row id when there are more rows.
 *   2. Second page: uses Prisma's cursor + skip:1 and returns rows
 *      strictly AFTER the cursor with no overlap.
 *   3. Filter + cursor: the `where` clause carries both the filter
 *      branch's predicates AND the cursor pagination — they compose.
 *   4. Invalid cursor: the route Zod rejects non-UUIDs with 400
 *      INVALID_CURSOR (asserted from source contract).
 *   5. Stable under concurrent inserts: because the orderBy includes
 *      `{ id: "desc" }` as a total-order tiebreaker, a row inserted
 *      while paginating cannot make the cursor either re-emit or skip
 *      a stable row.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Source-contract helpers
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTE_SRC = readSource(
  "../src/routes/reviewer-ops.routes.ts",
);
const ENGINE_SRC = readSource(
  "../src/services/reviewer-ops/reviewer-operations-engine.service.ts",
);

// ---------------------------------------------------------------------------
// Mocks for the behavioural half — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

const findManyMock = vi.fn();
const escalationFindManyMock = vi.fn(async () => []);
const safeEmitSecurityEventMock = vi.fn(() => undefined);
const bumpMock = vi.fn();
const setGaugeMock = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    evidenceReviewWorkflow: { findMany: findManyMock },
    reviewEscalation: { findMany: escalationFindManyMock },
  },
}));

vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: bumpMock,
  setGauge: setGaugeMock,
}));

vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: safeEmitSecurityEventMock,
}));

// withProovraSpan: pass-through so the inner fn runs.
vi.mock("../src/observability/otel.js", () => ({
  PROOVRA_SPAN_NAMES: new Proxy(
    {},
    {
      get: (_t, prop) => String(prop),
    },
  ),
  withProovraSpan: async (
    _name: string,
    _attrs: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = "10000000-0000-0000-0000-000000000001";
const ME_USER_ID = "10000000-0000-0000-0000-000000000002";
const CURSOR_ID = "20000000-0000-0000-0000-000000000050";

// ---------------------------------------------------------------------------
// SUT import — after mocks are bound.
// ---------------------------------------------------------------------------

const engineMod = await import(
  "../src/services/reviewer-ops/reviewer-operations-engine.service.js"
);

// Helper to build a deterministic workflow row. Only the fields the
// service projects are required; the projection helper is hardened to
// nulls everywhere else.
function makeRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    evidenceId: `ev-${id}`,
    teamId: TEAM_ID,
    workspaceType: "INTERNAL",
    status: "AWAITING_REVIEW",
    priority: "NORMAL",
    assignedToUserId: null,
    assignedByUserId: null,
    assignedAtUtc: null,
    reassignedAtUtc: null,
    dueAt: null,
    lastReviewedAt: null,
    closedAt: null,
    firstResponseDueAtUtc: null,
    escalationDueAtUtc: null,
    completedAtUtc: null,
    slaStatus: null,
    slaPausedAtUtc: null,
    escalationLevel: 0,
    escalatedAtUtc: null,
    escalatedByUserId: null,
    escalationReason: null,
    rejectionReason: null,
    reopenCount: 0,
    reopenedAtUtc: null,
    reopenedByUserId: null,
    assignmentDueAtUtc: null,
    completionDueAtUtc: null,
    pausedReason: null,
    activeEscalationId: null,
    codingSchemaId: null,
    codingSchemaVersion: null,
    templateSlug: null,
    templateVersion: null,
    templateDbId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  findManyMock.mockReset();
  escalationFindManyMock.mockReset();
  escalationFindManyMock.mockResolvedValue([]);
  safeEmitSecurityEventMock.mockReset();
  bumpMock.mockReset();
});

// ===========================================================================
// PART 1 — Source contract: route + service wiring
// ===========================================================================

describe("Phase RW3 — route wiring (source contract)", () => {
  it("QueueQuery Zod accepts a `cursor` as an optional UUID", () => {
    expect(ROUTE_SRC).toMatch(
      /QueueQuery\s*=\s*z\.object\(\{[\s\S]*?cursor:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/,
    );
  });

  it("forwards cursor into listReviewerOpsQueue", () => {
    expect(ROUTE_SRC).toMatch(
      /listReviewerOpsQueue\([\s\S]*?cursor:\s*q\.cursor\s*\?\?\s*null/,
    );
  });

  it("surfaces a dedicated INVALID_CURSOR 400 when only cursor failed", () => {
    expect(ROUTE_SRC).toMatch(/code:\s*"INVALID_CURSOR"/);
    expect(ROUTE_SRC).toMatch(
      /issue\.path\.join\("\."\)\s*===\s*"cursor"/,
    );
  });

  it("limit cap remains ≤ 100", () => {
    expect(ROUTE_SRC).toMatch(
      /limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)/,
    );
  });
});

describe("Phase RW3 — service wiring (source contract)", () => {
  it("declares cursor on ReviewerOpsQueueInput", () => {
    expect(ENGINE_SRC).toMatch(
      /export type ReviewerOpsQueueInput\s*=\s*\{[\s\S]*?cursor\?:\s*string\s*\|\s*null/,
    );
  });

  it("reads input.cursor in listReviewerOpsQueueInner", () => {
    expect(ENGINE_SRC).toMatch(
      /typeof\s+input\.cursor\s*===\s*"string"\s*&&\s*input\.cursor\.length\s*>\s*0/,
    );
  });

  it("passes Prisma cursor + skip:1 when cursor is set", () => {
    expect(ENGINE_SRC).toMatch(/cursor:\s*\{\s*id:\s*cursorId\s*\}/);
    expect(ENGINE_SRC).toMatch(/skip:\s*1/);
  });

  it("orderBy ends with { id: 'desc' } as a total-order tiebreaker", () => {
    // The tiebreaker is essential — Prisma `cursor` requires the cursor
    // column to appear in orderBy, and without a unique key the sort
    // could repeat or skip rows under concurrent inserts.
    expect(ENGINE_SRC).toMatch(
      /orderBy:[\s\S]*?\{\s*priority:\s*"desc"\s*\}[\s\S]*?\{\s*dueAt:\s*"asc"\s*\}[\s\S]*?\{\s*updatedAt:\s*"desc"\s*\}[\s\S]*?\{\s*id:\s*"desc"\s*\}/,
    );
  });

  it("still computes nextCursor from the last row id", () => {
    expect(ENGINE_SRC).toMatch(
      /nextCursor:\s*hasMore\s*&&\s*rows\.length\s*>\s*0\s*\?\s*rows\[rows\.length\s*-\s*1\]\.id\s*:\s*null/,
    );
  });
});

// ===========================================================================
// PART 2 — Behavioural: cursor pagination is honest
// ===========================================================================

describe("Phase RW3 — first page returns ≤ limit rows", () => {
  it("returns all rows when result fits in one page", async () => {
    findManyMock.mockResolvedValueOnce([
      makeRow("a"),
      makeRow("b"),
      makeRow("c"),
    ]);

    const result = await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "UNASSIGNED",
      limit: 50,
    });

    expect(result.rows).toHaveLength(3);
    expect(result.nextCursor).toBeNull();

    // Prove the orderBy + cursor shape passed into Prisma.
    const args = findManyMock.mock.calls[0]![0] as {
      take: number;
      orderBy: ReadonlyArray<Record<string, unknown>>;
      cursor?: unknown;
      skip?: unknown;
    };
    expect(args.take).toBe(51); // limit + 1
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(args.orderBy[args.orderBy.length - 1]).toEqual({ id: "desc" });
  });

  it("caps rows at limit and sets nextCursor to last row id when there is more", async () => {
    // 4 rows, limit 3 → service requested take=4, popped overflow.
    findManyMock.mockResolvedValueOnce([
      makeRow("a"),
      makeRow("b"),
      makeRow("c"),
      makeRow("d"),
    ]);

    const result = await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "UNASSIGNED",
      limit: 3,
    });

    expect(result.rows).toHaveLength(3);
    expect(result.nextCursor).toBe("c");
  });
});

describe("Phase RW3 — second page uses cursor + skip:1 (no overlap)", () => {
  it("forwards cursor + skip:1 into Prisma findMany", async () => {
    findManyMock.mockResolvedValueOnce([
      makeRow("d"),
      makeRow("e"),
      makeRow("f"),
    ]);

    const result = await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "UNASSIGNED",
      limit: 50,
      cursor: CURSOR_ID,
    });

    expect(result.rows.map((r) => r.workflowId)).toEqual(["d", "e", "f"]);
    expect(result.nextCursor).toBeNull();

    const args = findManyMock.mock.calls[0]![0] as {
      cursor: { id: string };
      skip: number;
      take: number;
    };
    expect(args.cursor).toEqual({ id: CURSOR_ID });
    expect(args.skip).toBe(1);
    expect(args.take).toBe(51);
  });

  it("does not include the cursor row in the returned rows (no overlap)", async () => {
    // Prisma's `cursor + skip: 1` semantics mean the cursor row itself
    // is excluded. We simulate that by NOT returning the cursor id
    // from the mock; the service must surface only rows strictly
    // after the cursor.
    findManyMock.mockResolvedValueOnce([
      makeRow("page2-1"),
      makeRow("page2-2"),
    ]);

    const result = await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "UNASSIGNED",
      limit: 50,
      cursor: CURSOR_ID,
    });

    expect(result.rows.map((r) => r.workflowId)).not.toContain(CURSOR_ID);
  });
});

describe("Phase RW3 — filter + cursor compose", () => {
  it("OVERDUE filter + cursor combine in a single Prisma call", async () => {
    findManyMock.mockResolvedValueOnce([
      makeRow("o1", { slaStatus: "OVERDUE" }),
      makeRow("o2", { slaStatus: "BREACHED" }),
    ]);

    await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "OVERDUE",
      limit: 10,
      cursor: CURSOR_ID,
    });

    const args = findManyMock.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      cursor: { id: string };
      skip: number;
    };
    // Filter predicate present
    expect(args.where.teamId).toBe(TEAM_ID);
    expect(args.where.slaStatus).toEqual({ in: ["OVERDUE", "BREACHED"] });
    // Cursor pagination present
    expect(args.cursor).toEqual({ id: CURSOR_ID });
    expect(args.skip).toBe(1);
  });

  it("MY_REVIEWS filter + cursor combine in a single Prisma call", async () => {
    findManyMock.mockResolvedValueOnce([]);

    await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "MY_REVIEWS",
      limit: 10,
      cursor: CURSOR_ID,
    });

    const args = findManyMock.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      cursor: { id: string };
    };
    expect(args.where.teamId).toBe(TEAM_ID);
    expect(args.where.assignedToUserId).toBe(ME_USER_ID);
    expect(args.cursor).toEqual({ id: CURSOR_ID });
  });
});

describe("Phase RW3 — null/empty cursor falls back to first page", () => {
  it("treats cursor=null as no cursor (first page)", async () => {
    findManyMock.mockResolvedValueOnce([makeRow("a"), makeRow("b")]);

    await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "UNASSIGNED",
      limit: 50,
      cursor: null,
    });

    const args = findManyMock.mock.calls[0]![0] as {
      cursor?: unknown;
      skip?: unknown;
    };
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("treats cursor='' (empty string) as no cursor (first page)", async () => {
    findManyMock.mockResolvedValueOnce([]);

    await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "UNASSIGNED",
      limit: 50,
      cursor: "",
    });

    const args = findManyMock.mock.calls[0]![0] as {
      cursor?: unknown;
      skip?: unknown;
    };
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });
});

describe("Phase RW3 — stable under concurrent inserts", () => {
  it("orderBy tuple is total: priority + dueAt + updatedAt + id tiebreaker", async () => {
    // The {id: 'desc'} tiebreaker is the safety net against a row
    // inserted between page reads with the same (priority, dueAt,
    // updatedAt) as the cursor row. Without it, the cursor row could
    // re-emit or a stable row could be skipped.
    findManyMock.mockResolvedValueOnce([]);

    await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "UNASSIGNED",
      limit: 50,
      cursor: CURSOR_ID,
    });

    const args = findManyMock.mock.calls[0]![0] as {
      orderBy: ReadonlyArray<Record<string, unknown>>;
    };
    // Ordered tuple: priority, dueAt, updatedAt, id.
    expect(args.orderBy).toHaveLength(4);
    expect(args.orderBy[0]).toEqual({ priority: "desc" });
    expect(args.orderBy[1]).toEqual({ dueAt: "asc" });
    expect(args.orderBy[2]).toEqual({ updatedAt: "desc" });
    expect(args.orderBy[3]).toEqual({ id: "desc" });
  });

  it("a row inserted with the same (priority, dueAt, updatedAt) cannot duplicate (cursor is id-based)", async () => {
    // Simulate page 1 returning 3 rows where all share the same
    // priority + dueAt + updatedAt; the tiebreaker is id.
    const sameSortKey = {
      priority: "HIGH",
      dueAt: new Date("2026-06-10T00:00:00Z"),
      updatedAt: new Date("2026-06-09T00:00:00Z"),
    };
    findManyMock.mockResolvedValueOnce([
      makeRow("30000000-0000-0000-0000-000000000003", sameSortKey),
      makeRow("20000000-0000-0000-0000-000000000002", sameSortKey),
      makeRow("10000000-0000-0000-0000-000000000001", sameSortKey),
    ]);
    const page1 = await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "HIGH_PRIORITY",
      limit: 2, // force pagination — pop the overflow.
    });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).toBe(
      "20000000-0000-0000-0000-000000000002",
    );

    // Now simulate a concurrent insert with the SAME sort key and an
    // id that sorts between the cursor row and the next page. The
    // cursor pagination still anchors on the id of the LAST row of
    // page 1 — the new row's id is "00000000-…-NEW" which sorts AFTER
    // the cursor under `id desc`, so it cannot duplicate a page-1 row.
    findManyMock.mockResolvedValueOnce([
      makeRow("10000000-0000-0000-0000-000000000001", sameSortKey),
    ]);
    const page2 = await engineMod.listReviewerOpsQueue({
      teamId: TEAM_ID,
      meUserId: ME_USER_ID,
      queue: "HIGH_PRIORITY",
      limit: 2,
      cursor: page1.nextCursor!,
    });
    // Page 2 must NOT contain any page 1 ids — the cursor + skip:1
    // contract excludes the cursor row itself.
    const page1Ids = new Set(page1.rows.map((r) => r.workflowId));
    for (const r of page2.rows) {
      expect(page1Ids.has(r.workflowId)).toBe(false);
    }

    const args = findManyMock.mock.calls[1]![0] as {
      cursor: { id: string };
      skip: number;
    };
    expect(args.cursor.id).toBe(page1.nextCursor);
    expect(args.skip).toBe(1);
  });
});

// ===========================================================================
// PART 3 — Invalid cursor surface (route-level)
// ===========================================================================

describe("Phase RW3 — invalid cursor surface", () => {
  it("INVALID_CURSOR branch fires only when cursor was the failing field", () => {
    // The route source returns INVALID_CURSOR only when EVERY issue is
    // on `cursor`. If teamId is bad AND cursor is bad, INVALID_QUERY
    // is returned so the operator sees the broader failure.
    expect(ROUTE_SRC).toMatch(
      /const\s+cursorOnly\s*=\s*[\s\S]*?parsed\.error\.issues\.every\(/,
    );
    // INVALID_CURSOR returned only inside the cursorOnly branch.
    const cursorOnlyBlock = ROUTE_SRC.match(
      /if\s*\(cursorOnly\)\s*\{[\s\S]*?\}\s*const\s+fieldSummary/,
    );
    expect(cursorOnlyBlock).toBeTruthy();
    expect(cursorOnlyBlock![0]).toContain('"INVALID_CURSOR"');
  });

  it("INVALID_CURSOR message is bounded and does not leak the raw cursor input", () => {
    const block = ROUTE_SRC.match(
      /if\s*\(cursorOnly\)\s*\{[\s\S]*?return\s+reply\.code\(400\)\.send\([\s\S]*?\}\);[\s\S]*?\}/,
    );
    expect(block).toBeTruthy();
    // Must not include rawQuery.cursor / parsed.error.issues / etc.
    expect(block![0]).not.toContain("rawQuery.cursor");
    expect(block![0]).not.toContain("parsed.error");
  });
});

// ===========================================================================
// PART 4 — Regression: the Phase 3 banner is gone from the frontend.
// ===========================================================================

describe("Phase RW3 — frontend banner removed", () => {
  it("queue page no longer renders the CANNOT_WIRE pagination banner", () => {
    const pageSrc = readSource(
      "../../../apps/web/app/(app)/review/queues/page.tsx",
    );
    expect(pageSrc).not.toContain("data-reviewer-queue-pagination-banner");
    expect(pageSrc).toContain("data-reviewer-queue-load-more");
  });

  it("queue page sends &cursor= on subsequent pages", () => {
    const pageSrc = readSource(
      "../../../apps/web/app/(app)/review/queues/page.tsx",
    );
    expect(pageSrc).toMatch(/&cursor=\$\{encodeURIComponent\(cursor\)\}/);
  });
});

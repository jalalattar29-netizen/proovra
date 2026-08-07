/**
 * Phase RW3-2 — Reviewer-ops assignable-reviewers picker endpoint.
 *
 * Replaces the previous `window.prompt("Reviewer user id…")` CANNOT_WIRE
 * compromise in /review/queues with a real team-scoped reviewer picker.
 *
 *   Route (services/api/src/routes/reviewer-ops.routes.ts):
 *     - New GET /v1/reviewer-ops/assignable-reviewers.
 *     - Resolves teamId from query, falling back to currentWorkspaceId.
 *     - Gates on requireReviewerActor (team membership) AND
 *       callerHasCapability(review.assign) so callers who cannot
 *       bulk-assign do not see a misleading list.
 *
 *   Service (services/api/src/services/reviewer-ops/workload.service.ts):
 *     - New listAssignableReviewers reads TeamMember (status=ACTIVE)
 *       filtered by evaluateMemberAccess(evidence_request.review) and
 *       projects { userId, displayName, role, status,
 *       currentWorkloadCount? }. NO email, NO raw PII, bounded shape.
 *     - Latest ReviewerWorkloadSnapshot joined per reviewer; omitted
 *       (not a fake zero) when no snapshot exists.
 *
 * This file is source-contract + behavioural. The behavioural half
 * mocks Prisma's `teamMember.findMany`, `reviewerWorkloadSnapshot.findMany`,
 * and `evaluateMemberAccess` so we can prove:
 *
 *   1. Bounded projection. Returned rows carry NO email, NO password
 *      hashes, NO accessReason, NO PII surface beyond { userId,
 *      displayName, role, status, currentWorkloadCount? }.
 *   2. Only `evidence_request.review`-capable, ACTIVE members are
 *      returned. Members denied by the access policy are filtered out.
 *   3. Cross-team isolation. Service is called with `teamId` and
 *      Prisma `findMany` filters on `teamId` — no other team's
 *      members are enumerated.
 *   4. limit cap. Service caps at 200 even when caller asks for 9999.
 *   5. currentWorkloadCount is sourced from the most recent snapshot
 *      and is omitted when no snapshot exists.
 *   6. (Source contract) Route gates on `review.assign` capability
 *      and returns REVIEW_PERMISSION_DENIED 403 for callers who lack
 *      it.
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
const SERVICE_SRC = readSource(
  "../src/services/reviewer-ops/workload.service.ts",
);
const PAGE_SRC = readSource(
  "../../../apps/web/app/(app)/review/queues/page.tsx",
);

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

const teamMemberFindManyMock = vi.fn();
const snapshotFindManyMock = vi.fn();
const evaluateMemberAccessMock = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    teamMember: { findMany: teamMemberFindManyMock },
    reviewerWorkloadSnapshot: { findMany: snapshotFindManyMock },
  },
}));

vi.mock("../src/services/identity/access-policy.service.js", () => ({
  evaluateMemberAccess: evaluateMemberAccessMock,
}));

vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: vi.fn(),
  setGauge: vi.fn(),
}));

vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_TEAM_ID = "22222222-2222-2222-2222-222222222222";
const REVIEWER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const REVIEWER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REVIEWER_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// ---------------------------------------------------------------------------
// SUT import — after mocks are bound.
// ---------------------------------------------------------------------------

const workloadMod = await import(
  "../src/services/reviewer-ops/workload.service.js"
);

function makeMember(
  userId: string,
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER",
  displayName: string | null = null,
) {
  return {
    userId,
    role,
    user: {
      id: userId,
      displayName,
    },
  };
}

beforeEach(() => {
  teamMemberFindManyMock.mockReset();
  snapshotFindManyMock.mockReset();
  evaluateMemberAccessMock.mockReset();
  // Default: snapshots are empty.
  snapshotFindManyMock.mockResolvedValue([]);
});

// ===========================================================================
// PART 1 — Source contract: route + service wiring
// ===========================================================================

describe("Phase RW3-2 — route source contract", () => {
  it("declares GET /v1/reviewer-ops/assignable-reviewers", () => {
    expect(ROUTE_SRC).toMatch(
      /app\.get\(\s*"\/v1\/reviewer-ops\/assignable-reviewers"/,
    );
  });

  it("uses requireReviewerActor (team membership gate)", () => {
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/assignable-reviewers[\s\S]{0,2000}?requireReviewerActor\(req, reply, q\.teamId\)/,
    );
  });

  it("gates on the review.assign capability", () => {
    // PHASE 12 REMEDIATION — AUTH-005 (2026-08-06). INTENTIONAL CONTRACT
    // CHANGE, same permission, same admission set.
    //
    //   OLD: the route re-read the TeamMember row with `select: { role: true }`
    //        and NO status predicate, fed the bare role to
    //        `resolveReviewerRole`, and asserted
    //        `callerHasCapability(resolution, "review.assign")`.
    //
    //   NEW: it reads `review.assign` from the PROVEN capability set on the
    //        `AuthorizedWorkspaceContext` that `requireReviewerActor`
    //        established — a context that cannot exist without ACTIVE
    //        membership, unexpired access, a provable workspace kind and an
    //        ACTIVE parent Organization.
    //
    // WHY: this was one of the four status-blind secondary role reads the
    // audit recorded as AUTH-005; a SUSPENDED or REVOKED member holding
    // OWNER/ADMIN satisfied it. The capability asserted is UNCHANGED, so the
    // picker still surfaces only to callers who can actually assign; what
    // changed is that an inactive member can no longer be one of them.
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/assignable-reviewers[\s\S]{0,4000}?contextHasCapability\(ctx\.authorized,\s*"review\.assign"\)/,
    );
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/assignable-reviewers[\s\S]{0,4000}?code:\s*"REVIEW_PERMISSION_DENIED"[\s\S]{0,200}?reason:\s*"review_assign_required"/,
    );
  });

  it("Zod query schema bounds teamId (uuid) and limit (1..200)", () => {
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/assignable-reviewers[\s\S]{0,2000}?teamId:\s*z\.string\(\)\.uuid\(\)/,
    );
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/assignable-reviewers[\s\S]{0,2000}?limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/,
    );
  });

  it("resolves teamId from currentWorkspaceId when query omits it", () => {
    expect(ROUTE_SRC).toMatch(
      /\/v1\/reviewer-ops\/assignable-reviewers[\s\S]{0,2000}?currentWorkspaceId/,
    );
  });

  it("forwards the limit + teamId to listAssignableReviewers", () => {
    expect(ROUTE_SRC).toMatch(
      /listAssignableReviewers\(\s*\{\s*teamId:\s*q\.teamId,\s*limit:\s*q\.limit/,
    );
  });
});

describe("Phase RW3-2 — service source contract", () => {
  it("exports listAssignableReviewers", () => {
    expect(SERVICE_SRC).toMatch(
      /export\s+async\s+function\s+listAssignableReviewers/,
    );
  });

  it("uses evaluateMemberAccess(evidence_request.review) per candidate", () => {
    expect(SERVICE_SRC).toMatch(
      /listAssignableReviewers[\s\S]{0,4000}?permission:\s*"evidence_request\.review"/,
    );
  });

  it("filters TeamMember to status=ACTIVE only", () => {
    expect(SERVICE_SRC).toMatch(
      /listAssignableReviewers[\s\S]{0,4000}?teamId:\s*input\.teamId[\s\S]{0,200}?status:\s*"ACTIVE"/,
    );
  });

  it("caps limit at 200 inside the service (defence-in-depth)", () => {
    expect(SERVICE_SRC).toMatch(
      /listAssignableReviewers[\s\S]{0,4000}?Math\.min\(Math\.max\(input\.limit\s*\?\?\s*50,\s*1\),\s*200\)/,
    );
  });

  it("does NOT select email or password fields in the user projection", () => {
    // Locate the listAssignableReviewers function body and assert
    // that within it, the TeamMember.user select clause never picks
    // up `email` or `passwordHash`.
    const fnIdx = SERVICE_SRC.indexOf("async function listAssignableReviewers");
    expect(fnIdx).toBeGreaterThan(-1);
    // Take a generous chunk after the function header so we capture
    // the full body up to the next top-level export.
    const fnBody = SERVICE_SRC.slice(fnIdx, fnIdx + 4000);
    expect(fnBody).not.toMatch(/email\s*:\s*true/);
    expect(fnBody).not.toMatch(/passwordHash/);
    expect(fnBody).not.toMatch(/accessReason/);
  });
});

describe("Phase RW3-2 — frontend source contract", () => {
  it("queues page no longer calls window.prompt for the assignee", () => {
    expect(PAGE_SRC).not.toMatch(/window\.prompt\(/);
  });

  it("queues page wires openReviewerPicker into the Bulk assign action", () => {
    expect(PAGE_SRC).toMatch(/openReviewerPicker/);
    expect(PAGE_SRC).toMatch(
      /onAssign=\{\s*\(\)\s*=>\s*\{\s*void\s+openReviewerPicker\(\)/,
    );
  });

  it("queues page fetches /v1/reviewer-ops/assignable-reviewers", () => {
    expect(PAGE_SRC).toMatch(
      /\/v1\/reviewer-ops\/assignable-reviewers/,
    );
  });

  it("queues page renders FORBIDDEN bounded copy on 403 (no prompt fallback)", () => {
    expect(PAGE_SRC).toMatch(/REVIEW_PERMISSION_DENIED/);
    expect(PAGE_SRC).toMatch(
      /You do not have permission to assign reviews in this workspace\./,
    );
  });

  it("queues page wraps the picker fetch in try/catch with a warn log", () => {
    expect(PAGE_SRC).toMatch(
      /openReviewerPicker[\s\S]{0,2000}?console\.warn\(\s*"\[reviewer-workspace\] assignable-reviewers fetch failed"/,
    );
  });
});

// ===========================================================================
// PART 2 — Behavioural: bounded projection, capability filter, isolation
// ===========================================================================

describe("Phase RW3-2 — bounded projection (no PII)", () => {
  it("returns only { userId, displayName, role, status, currentWorkloadCount? }", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "MEMBER", "Alice Anchor"),
      makeMember(REVIEWER_B, "ADMIN", null),
    ]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });

    const reviewers = await workloadMod.listAssignableReviewers({
      teamId: TEAM_ID,
    });

    expect(reviewers).toHaveLength(2);
    for (const r of reviewers) {
      expect(Object.keys(r).sort()).toEqual(
        // currentWorkloadCount is OMITTED when no snapshot exists, so
        // the sorted key set is exactly four. That's the bounded shape.
        ["displayName", "role", "status", "userId"],
      );
      // Tight type assertions on the bounded shape.
      expect(typeof r.userId).toBe("string");
      expect(r.status).toBe("ACTIVE");
      // No leaking email, password, or PII fields.
      expect((r as Record<string, unknown>).email).toBeUndefined();
      expect((r as Record<string, unknown>).passwordHash).toBeUndefined();
      expect((r as Record<string, unknown>).accessReason).toBeUndefined();
    }
  });
});

describe("Phase RW3-2 — reviewer-capable filter", () => {
  it("excludes members denied by evaluateMemberAccess", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "MEMBER", "Alice"),
      makeMember(REVIEWER_B, "VIEWER", "Bob"),
      makeMember(REVIEWER_C, "MEMBER", "Carol"),
    ]);
    // Only A + C pass the capability check; B is denied.
    evaluateMemberAccessMock.mockImplementation(
      async (input: { userId: string }) => ({
        allowed:
          input.userId === REVIEWER_A || input.userId === REVIEWER_C,
      }),
    );

    const reviewers = await workloadMod.listAssignableReviewers({
      teamId: TEAM_ID,
    });

    expect(reviewers.map((r) => r.userId)).toEqual([REVIEWER_A, REVIEWER_C]);
  });

  it("returns empty when no member is reviewer-capable", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "VIEWER"),
      makeMember(REVIEWER_B, "VIEWER"),
    ]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: false });

    const reviewers = await workloadMod.listAssignableReviewers({
      teamId: TEAM_ID,
    });
    expect(reviewers).toEqual([]);
  });
});

describe("Phase RW3-2 — cross-team isolation", () => {
  it("Prisma findMany is scoped to the requested teamId", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });

    await workloadMod.listAssignableReviewers({ teamId: TEAM_ID });

    const args = teamMemberFindManyMock.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where.teamId).toBe(TEAM_ID);
    expect(args.where.status).toBe("ACTIVE");
    // No way for the where clause to spill into another team.
    expect(JSON.stringify(args.where)).not.toContain(OTHER_TEAM_ID);
  });

  it("evaluateMemberAccess is also called with the requested teamId", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "MEMBER"),
    ]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });

    await workloadMod.listAssignableReviewers({ teamId: TEAM_ID });

    expect(evaluateMemberAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM_ID,
        userId: REVIEWER_A,
        permission: "evidence_request.review",
      }),
    );
  });
});

describe("Phase RW3-2 — limit cap", () => {
  it("caps at 200 even when caller asks for 9999", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });

    await workloadMod.listAssignableReviewers({
      teamId: TEAM_ID,
      limit: 9999,
    });

    const args = teamMemberFindManyMock.mock.calls[0]![0] as { take: number };
    // pool = min(limit*2, 400); limit clamped to 200 → pool = 400.
    expect(args.take).toBeLessThanOrEqual(400);
  });

  it("default limit is 50 (max pool = 100)", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });

    await workloadMod.listAssignableReviewers({ teamId: TEAM_ID });

    const args = teamMemberFindManyMock.mock.calls[0]![0] as { take: number };
    expect(args.take).toBe(100);
  });

  it("stops capability checks once `limit` capable rows are accumulated", async () => {
    // Pool of 6 candidates, but limit=2 should short-circuit after 2 allowed.
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "MEMBER"),
      makeMember(REVIEWER_B, "MEMBER"),
      makeMember(REVIEWER_C, "MEMBER"),
      makeMember("dddddddd-dddd-dddd-dddd-dddddddddddd", "MEMBER"),
    ]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });

    const reviewers = await workloadMod.listAssignableReviewers({
      teamId: TEAM_ID,
      limit: 2,
    });

    expect(reviewers).toHaveLength(2);
    // Capability check stopped at 2 → only 2 calls to evaluateMemberAccess.
    expect(evaluateMemberAccessMock).toHaveBeenCalledTimes(2);
  });
});

describe("Phase RW3-2 — currentWorkloadCount join", () => {
  it("omits currentWorkloadCount when no snapshot exists", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "MEMBER"),
    ]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });
    snapshotFindManyMock.mockResolvedValueOnce([]);

    const reviewers = await workloadMod.listAssignableReviewers({
      teamId: TEAM_ID,
    });

    expect(reviewers[0]).not.toHaveProperty("currentWorkloadCount");
  });

  it("surfaces the latest snapshot's activeReviewCount when present", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "MEMBER"),
      makeMember(REVIEWER_B, "MEMBER"),
    ]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });
    snapshotFindManyMock.mockResolvedValueOnce([
      // Mixed-order snapshots; the service picks the latest per
      // reviewer (computedAtUtc desc is the orderBy contract).
      {
        reviewerUserId: REVIEWER_A,
        activeReviewCount: 7,
        computedAtUtc: new Date("2026-06-05T12:00:00Z"),
      },
      {
        reviewerUserId: REVIEWER_A,
        activeReviewCount: 99, // older — should NOT be used.
        computedAtUtc: new Date("2026-06-01T12:00:00Z"),
      },
      {
        reviewerUserId: REVIEWER_B,
        activeReviewCount: 0,
        computedAtUtc: new Date("2026-06-05T12:00:00Z"),
      },
    ]);

    const reviewers = await workloadMod.listAssignableReviewers({
      teamId: TEAM_ID,
    });

    // findMany was called orderBy desc; service iterates and takes the
    // first occurrence per reviewer. We assert the projection picks
    // the latest (7, not 99) and that a zero is honestly projected
    // (zero is a real snapshot, not a fake placeholder).
    const byId = new Map(reviewers.map((r) => [r.userId, r]));
    expect(byId.get(REVIEWER_A)?.currentWorkloadCount).toBe(7);
    expect(byId.get(REVIEWER_B)?.currentWorkloadCount).toBe(0);
  });

  it("snapshot lookup is scoped to the requested teamId AND the projected reviewer set", async () => {
    teamMemberFindManyMock.mockResolvedValueOnce([
      makeMember(REVIEWER_A, "MEMBER"),
      makeMember(REVIEWER_B, "MEMBER"),
    ]);
    evaluateMemberAccessMock.mockResolvedValue({ allowed: true });
    snapshotFindManyMock.mockResolvedValueOnce([]);

    await workloadMod.listAssignableReviewers({ teamId: TEAM_ID });

    expect(snapshotFindManyMock).toHaveBeenCalledTimes(1);
    const args = snapshotFindManyMock.mock.calls[0]![0] as {
      where: { teamId: string; reviewerUserId: { in: string[] } };
    };
    expect(args.where.teamId).toBe(TEAM_ID);
    expect(args.where.reviewerUserId.in).toEqual(
      expect.arrayContaining([REVIEWER_A, REVIEWER_B]),
    );
    // Cross-team leak guard.
    expect(JSON.stringify(args.where)).not.toContain(OTHER_TEAM_ID);
  });
});

/**
 * Phase HOME-DATA-OWNERSHIP — regression tests.
 *
 * Root cause being locked down: the capture write path stored personal
 * evidence with `team_id = NULL` ("NULL means personal") while the Home
 * dashboard reads by the personal Team row's UUID — so production users
 * with hundreds of records saw an all-zero Home.
 *
 * Invariants enforced here:
 *
 *   1. createEvidence STAMPS a real team id on every row: the personal
 *      Team id when teamId is omitted (or equals the caller's personal
 *      team), the team workspace id otherwise. `teamId: scope.teamId`
 *      (the old NULL writer) must never return.
 *   2. Personal billing semantics survive the stamp: scope resolution
 *      for personal captures still goes through the PERSONAL path
 *      (entitlement-based) — stamping is a data-ownership decision,
 *      not a billing decision.
 *   3. The personal plan-limit counter and personal storage usage
 *      count BOTH legacy `teamId NULL` rows and personal-team rows, so
 *      limits survive the backfill.
 *   4. workspaceEvidenceWhere widens personal reads to include the
 *      owner's legacy NULL rows and stays STRICT for team workspaces
 *      (no cross-tenant leak).
 *   5. /v1/reports?teamId=<own personal team> includes legacy NULL
 *      rows owned by the caller; trust-summary uses the shared
 *      personal-aware filter.
 *   6. Case creation stamps a real team id (personal Team when no
 *      teamId is pinned).
 *   7. The backfill script is dry-run by default, idempotent by
 *      construction, never overwrites a valid team id, and stamps
 *      organization_id alongside team_id (Phase A1 CHECK).
 *
 * House style for route/service contracts: source-contract assertions +
 * pure unit tests with a mocked prisma module — no live database.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// -----------------------------------------------------------------------------
// Mocked prisma for the pure unit tests of workspace-personal-scope.
// -----------------------------------------------------------------------------

const teamFindUnique = vi.fn();

/**
 * WORKSPACE-SCOPE CONVERGENCE — the client is now passed EXPLICITLY rather
 * than mocked out from under the module.
 *
 * The authority moved into `@proovra/shared-runtime` (the Worker reads the
 * same populations and cannot import from the API), and shared-runtime never
 * constructs a Prisma client — each host registers its own. Mocking
 * `../src/db.js` would therefore no longer intercept anything. Passing the
 * fake in is also the stronger test: it proves the optional-client parameter
 * is honoured, which is what lets a caller inside a transaction resolve the
 * scope on the same connection it runs its query on.
 */
const fakeClient = {
  team: {
    findUnique: (...args: unknown[]) => teamFindUnique(...args),
  },
} as unknown as import("@prisma/client").PrismaClient;

import {
  resolvePersonalScope,
  workspaceCaseWhere,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";

beforeEach(() => {
  teamFindUnique.mockReset();
});

// -----------------------------------------------------------------------------
// Invariant 4 — personal-aware where helper.
// -----------------------------------------------------------------------------

describe("workspace-personal-scope — personal-aware filters", () => {
  const PERSONAL_TEAM = "11111111-1111-4111-8111-111111111111";
  const OWNER = "22222222-2222-4222-8222-222222222222";

  it("personal team → OR clause bound to the owner's legacy NULL rows", async () => {
    teamFindUnique.mockResolvedValue({ isPersonal: true, ownerUserId: OWNER });
    const where = await workspaceEvidenceWhere(PERSONAL_TEAM, fakeClient);
    expect(where).toEqual({
      OR: [
        { teamId: PERSONAL_TEAM },
        { AND: [{ ownerUserId: OWNER }, { teamId: null }] },
      ],
    });
  });

  it("real team workspace → STRICT teamId filter (no legacy arm, no leak)", async () => {
    teamFindUnique.mockResolvedValue({ isPersonal: false, ownerUserId: OWNER });
    const where = await workspaceEvidenceWhere(PERSONAL_TEAM, fakeClient);
    expect(where).toEqual({ teamId: PERSONAL_TEAM });
  });

  it("unknown team id → STRICT filter (matches nothing, never widens)", async () => {
    teamFindUnique.mockResolvedValue(null);
    const where = await workspaceEvidenceWhere(PERSONAL_TEAM, fakeClient);
    expect(where).toEqual({ teamId: PERSONAL_TEAM });
    const scope = await resolvePersonalScope(PERSONAL_TEAM, fakeClient);
    expect(scope).toEqual({ isPersonal: false, ownerUserId: null });
  });

  it("case filter mirrors the evidence contract", async () => {
    teamFindUnique.mockResolvedValue({ isPersonal: true, ownerUserId: OWNER });
    const where = await workspaceCaseWhere(PERSONAL_TEAM, fakeClient);
    expect(where).toEqual({
      OR: [
        { teamId: PERSONAL_TEAM },
        { AND: [{ ownerUserId: OWNER }, { teamId: null }] },
      ],
    });
  });
});

// -----------------------------------------------------------------------------
// Invariant 1 + 2 — createEvidence stamps a real team id, keeps
// personal billing semantics.
// -----------------------------------------------------------------------------

describe("createEvidence — every row carries a REAL team id", () => {
  const src = readSource("../src/services/evidence.service.ts");

  it("resolves (or bootstraps) the personal Team when teamId is omitted", () => {
    expect(src).toMatch(/ensurePersonalWorkspace/);
    // The else-branch (no teamId) must assign the personal team id.
    expect(src).toMatch(
      /const personal = await ensurePersonalWorkspace\(\{\s*userId: params\.ownerUserId,?\s*\}\);\s*effectiveTeamId = personal\.teamId;/,
    );
  });

  it("the Evidence row is created with effectiveTeamId, NEVER scope.teamId", () => {
    // The old NULL writer was `teamId: scope.teamId` inside the
    // evidence.create data block (personal scope has teamId === null).
    // It must not return there. (The webhook emit below the create
    // legitimately keeps its `scope.teamId` team-only guard.)
    const createIdx = src.indexOf("tx.evidence.create");
    expect(createIdx).toBeGreaterThan(0);
    const createBlock = src.slice(createIdx, createIdx + 2500);
    expect(createBlock).not.toMatch(/teamId:\s*scope\.teamId\s*,/);
    expect(createBlock).toMatch(/teamId:\s*effectiveTeamId\s*,/);
  });

  it("personal captures keep PERSONAL billing scope (no TEAM gate regression)", () => {
    expect(src).toMatch(
      /teamId:\s*isPersonalWorkspaceCapture\s*\?\s*null\s*:\s*effectiveTeamId/,
    );
  });

  it("personal captures keep personal identity semantics (no ORGANIZATION_ACCOUNT promotion)", () => {
    expect(src).toMatch(
      /currentWorkspaceId:\s*isPersonalWorkspaceCapture\s*\?\s*null\s*:\s*effectiveTeamId/,
    );
  });

  it("no fallback to owner.currentWorkspaceId (the historic billing bug)", () => {
    expect(src).not.toMatch(/params\.teamId\s*\?\?\s*owner\.currentWorkspaceId/);
  });
});

// -----------------------------------------------------------------------------
// Invariant 3 — plan limits and storage usage survive the backfill.
// -----------------------------------------------------------------------------

describe("personal plan limits + storage usage count personal-team rows", () => {
  it("billing-enforcement counts legacy NULL rows AND personal-team rows", () => {
    const src = readSource("../src/services/billing-enforcement.service.ts");
    expect(src).toMatch(/isPersonal:\s*true/);
    expect(src).toMatch(
      /OR:\s*\[\s*\{\s*teamId:\s*null\s*\},\s*\.\.\.\(personalTeam \? \[\{ teamId: personalTeam\.id \}\] : \[\]\),\s*\]/,
    );
  });

  it("workspace-usage personal aggregates include personal-team rows", () => {
    const src = readSource("../src/services/workspace-usage.service.ts");
    expect(src).toMatch(/personalTeamForUsage/);
    expect(src).toMatch(/personalEvidenceWhere/);
  });
});

// -----------------------------------------------------------------------------
// Invariant 5 — Home read endpoints see personal data.
// -----------------------------------------------------------------------------

describe("Home read endpoints — personal workspace sees owner data", () => {
  it("/v1/reports?teamId=<own personal team> includes legacy NULL rows", () => {
    const src = readSource("../src/routes/reports.routes.ts");
    expect(src).toMatch(/isCallersPersonalTeam/);
    expect(src).toMatch(
      /OR:\s*\[\s*\{\s*teamId:\s*scopedTeamId\s*\},\s*\{\s*AND:\s*\[\{\s*ownerUserId:\s*userId\s*\},\s*\{\s*teamId:\s*null\s*\}\]\s*\},\s*\]/,
    );
  });

  it("trust-summary builds its base filter via workspaceEvidenceWhere", () => {
    const src = readSource("../src/services/dashboard/trust-summary.service.ts");
    expect(src).toMatch(/workspaceEvidenceWhere/);
    expect(src).not.toMatch(/baseWhere = \{ teamId: input\.teamId/);
  });
});

// -----------------------------------------------------------------------------
// Invariant 6 — case creation stamps a real team id.
// -----------------------------------------------------------------------------

describe("case creation — personal cases carry the personal Team id", () => {
  it("POST /v1/cases resolves the personal Team when no teamId is pinned", () => {
    const src = readSource("../src/routes/cases.routes.ts");
    expect(src).toMatch(/effectiveCaseTeamId/);
    expect(src).toMatch(
      /body\.teamId \?\?\s*\(await ensurePersonalWorkspace\(\{ userId: ownerUserId \}\)\)\.teamId/,
    );
    expect(src).not.toMatch(/teamId:\s*body\.teamId \?\? null/);
  });
});

// -----------------------------------------------------------------------------
// Invariant 7 — backfill script safety contract.
// -----------------------------------------------------------------------------

describe("backfill-personal-team-ownership — safety contract", () => {
  const src = readSource("../scripts/backfill-personal-team-ownership.ts");

  it("dry-run by default; writes only behind --apply", () => {
    expect(src).toMatch(/const APPLY = process\.argv\.includes\("--apply"\)/);
    // Every $executeRawUnsafe write sits behind the APPLY guard: the
    // dry-run path `continue`s before any transaction is opened.
    const dryRunGuard = src.indexOf("if (!APPLY) {");
    const firstWrite = src.indexOf("$executeRawUnsafe");
    expect(dryRunGuard).toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(dryRunGuard);
  });

  it("never overwrites a valid team id (only NULL or dangling rows match)", () => {
    expect(src).toMatch(/team_id IS NULL/);
    expect(src).toMatch(/NOT EXISTS \(SELECT 1 FROM teams t2 WHERE t2\.id = e\.team_id\)/);
  });

  it("stamps organization_id alongside team_id (Phase A1 CHECK constraint)", () => {
    expect(src).toMatch(
      /organization_id = COALESCE\(\s*e\.organization_id,/,
    );
  });

  it("repairs cases with the same NULL-or-dangling guard", () => {
    expect(src).toMatch(/UPDATE cases c/);
    expect(src).toMatch(/NOT EXISTS \(SELECT 1 FROM teams t2 WHERE t2\.id = c\.team_id\)/);
  });

  it("skips owners without a personal team unless --bootstrap-missing", () => {
    expect(src).toMatch(/--bootstrap-missing/);
    expect(src).toMatch(/owner has no personal Team row/);
  });
});

// -----------------------------------------------------------------------------
// The dead convention stays dead.
// -----------------------------------------------------------------------------

describe("'team_id NULL means personal' is dead for NEW rows", () => {
  it("POST /v1/evidence passes the client teamId through to createEvidence", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    const postIdx = src.indexOf('app.post("/v1/evidence"');
    const handlerSlice = src.slice(postIdx, postIdx + 12_000);
    expect(handlerSlice).toMatch(/teamId:\s*body\.teamId \?\? null/);
  });

  it("CreateEvidenceBody accepts an optional uuid teamId", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    const bodyIdx = src.indexOf("const CreateEvidenceBody = z.object");
    const bodySlice = src.slice(bodyIdx, bodyIdx + 1200);
    expect(bodySlice).toMatch(/teamId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
  });
});

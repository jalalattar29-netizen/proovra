/**
 * Matter Queue — expanded search coverage.
 *
 * The `/v1/cases/matter-queue` endpoint's `search` term must match, WITHIN
 * the caller's workspace scope, any of:
 *
 *   1. name            (contains, insensitive)
 *   2. referenceNumber (contains, insensitive)
 *   3. FULL case uuid  (exact id match)
 *   4. uuid PREFIX     (case id starts with the term — e.g. first 8 chars)
 *   5. OWNER           (User.email / displayName / firstName / lastName)
 *   6. LINKED EVIDENCE (evidence id / prefix → owning caseIds)
 *
 * CRITICALLY: the `teamId` scope is applied as a top-level AND on the
 * base query, so no search branch may surface a case from another
 * workspace. That no-leak invariant is the load-bearing test here.
 *
 * These are BEHAVIORAL tests against a mocked Prisma client. We simulate a
 * two-team dataset and assert:
 *   - the base `case.findMany` `where` always carries `teamId`;
 *   - each search dimension contributes the right OR branch;
 *   - the team-scoped raw subqueries (uuid prefix, evidence) bind the
 *     caller's teamId and never another team's;
 *   - a term that would match a case in team B returns nothing for team A.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Two-workspace fixture.
// ---------------------------------------------------------------------------
const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const CASE_A1 = {
  id: "f2b14622-1111-4111-8111-111111111111",
  name: "Acme breach investigation",
  referenceNumber: "REF-A-001",
  status: "OPEN",
  priority: "P1",
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  teamId: TEAM_A,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};
const CASE_B1 = {
  id: "c9c9c9c9-2222-4222-8222-222222222222",
  name: "Beta workspace secret matter",
  referenceNumber: "REF-B-777",
  status: "OPEN",
  priority: "P1",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  teamId: TEAM_B,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

const USER_A_OWNER = {
  id: CASE_A1.ownerUserId,
  email: "investigator@acme.example",
  displayName: "Dana Investigator",
  firstName: "Dana",
  lastName: "Investigator",
  teamId: TEAM_A,
};

// Evidence linked to A1 (via canonical join). Hex-only uuid so the
// term is a valid uuid-shaped prefix (id prefix "e50a1111").
const EVIDENCE_A1 = {
  id: "e50a1111-3333-4333-8333-333333333333",
  caseId: CASE_A1.id,
  teamId: TEAM_A,
};

const ALL_CASES = [CASE_A1, CASE_B1];

// ---------------------------------------------------------------------------
// Mock Prisma. Each method is a spy so tests can inspect the args the
// service passes (this is where scope/leak assertions live).
// ---------------------------------------------------------------------------
const mockClient = {
  case: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  evidence: { findMany: vi.fn(), count: vi.fn() },
  caseEvidenceLink: { findMany: vi.fn() },
  caseRiskSnapshot: { findMany: vi.fn() },
  operationalIncident: { count: vi.fn() },
  operationalWorkflow: { count: vi.fn() },
  caseLegalHold: { count: vi.fn() },
  caseAssignment: { count: vi.fn(), findMany: vi.fn() },
  $queryRaw: vi.fn(),
};

vi.mock("../src/db.js", () => ({ prisma: mockClient }));

// Prisma.sql tagged-template shim: capture the interpolated params so we
// can assert the raw queries bind the right teamId and are parameterised
// (never string-concatenated).
vi.mock("@prisma/client", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
  },
}));

const { buildMatterQueue } = await import(
  "../src/services/cases/matter-queue.service.js"
);

/**
 * Emulate the base `case.findMany` against our fixture: honour the
 * top-level `teamId` scope AND the composed `OR` branches. This lets us
 * assert real filtering behaviour (a match in team B never leaks into a
 * team A query) rather than just inspecting the where object.
 */
function caseMatchesOr(
  c: (typeof ALL_CASES)[number],
  or: Array<Record<string, unknown>>,
): boolean {
  return or.some((branch) => {
    if (
      "name" in branch &&
      typeof (branch.name as { contains?: string })?.contains === "string"
    ) {
      const needle = (branch.name as { contains: string }).contains.toLowerCase();
      return c.name.toLowerCase().includes(needle);
    }
    if ("referenceNumber" in branch) {
      const needle = (
        branch.referenceNumber as { contains: string }
      ).contains.toLowerCase();
      return (c.referenceNumber ?? "").toLowerCase().includes(needle);
    }
    if ("id" in branch) {
      const idf = branch.id as { equals?: string; in?: string[] };
      if (idf.equals) return c.id === idf.equals;
      if (idf.in) return idf.in.includes(c.id);
    }
    if ("ownerUserId" in branch) {
      const of = branch.ownerUserId as { in?: string[] };
      return !!of.in && of.in.includes(c.ownerUserId);
    }
    return false;
  });
}

beforeEach(() => {
  for (const model of Object.values(mockClient)) {
    if (typeof model === "function") {
      (model as ReturnType<typeof vi.fn>).mockReset();
      continue;
    }
    for (const fn of Object.values(model)) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }

  // Base case.findMany honours teamId + OR against the fixture.
  mockClient.case.findMany.mockImplementation(
    async (args: {
      where: { teamId: string; OR?: Array<Record<string, unknown>> };
      take?: number;
    }) => {
      const { teamId, OR } = args.where;
      return ALL_CASES.filter(
        (c) =>
          c.teamId === teamId && (!OR || OR.length === 0 || caseMatchesOr(c, OR)),
      ).slice(0, args.take ?? 50);
    },
  );

  // Owner resolution: return USER_A_OWNER when the term matches its
  // name/email fields (case-insensitive contains on any of the 4 fields).
  mockClient.user.findMany.mockImplementation(
    async (args: { where: { OR: Array<Record<string, { contains: string }>> } }) => {
      const needle = args.where.OR[0]
        ? Object.values(args.where.OR[0])[0].contains.toLowerCase()
        : "";
      const fields = [
        USER_A_OWNER.email,
        USER_A_OWNER.displayName,
        USER_A_OWNER.firstName,
        USER_A_OWNER.lastName,
      ].map((s) => s.toLowerCase());
      return fields.some((f) => f.includes(needle)) ? [{ id: USER_A_OWNER.id }] : [];
    },
  );

  // $queryRaw drives the uuid-prefix + evidence subqueries. We route on
  // which table the query targets, and — critically — return rows ONLY
  // when the bound teamId matches the fixture team that owns the data.
  mockClient.$queryRaw.mockImplementation(
    async (q: { strings: string[]; values: unknown[] }) => {
      const sql = q.strings.join(" ");
      const boundTeamId = q.values.find(
        (v) => v === TEAM_A || v === TEAM_B,
      ) as string | undefined;
      // The LIKE pattern is the last string param ending in "%".
      const pattern = q.values.find(
        (v): v is string => typeof v === "string" && v.endsWith("%"),
      );
      const prefix = (pattern ?? "").slice(0, -1);

      // uuid-prefix subquery over `cases`.
      if (/FROM "cases"\s+WHERE/i.test(sql) && !/JOIN/i.test(sql)) {
        return ALL_CASES.filter(
          (c) => c.teamId === boundTeamId && c.id.startsWith(prefix),
        ).map((c) => ({ id: c.id }));
      }

      // evidence subquery (case_evidence_links UNION cases JOIN evidence).
      if (/case_evidence_links/i.test(sql)) {
        const rows: Array<{ case_id: string }> = [];
        if (
          EVIDENCE_A1.teamId === boundTeamId &&
          EVIDENCE_A1.id.startsWith(prefix)
        ) {
          rows.push({ case_id: EVIDENCE_A1.caseId });
        }
        return rows;
      }
      return [];
    },
  );

  // Per-case counter reads: everything zero / empty so rows render.
  mockClient.caseRiskSnapshot.findMany.mockResolvedValue([]);
  mockClient.evidence.findMany.mockResolvedValue([]);
  mockClient.caseEvidenceLink.findMany.mockResolvedValue([]);
  mockClient.evidence.count.mockResolvedValue(0);
  mockClient.operationalIncident.count.mockResolvedValue(0);
  mockClient.operationalWorkflow.count.mockResolvedValue(0);
  mockClient.caseLegalHold.count.mockResolvedValue(0);
  mockClient.caseAssignment.count.mockResolvedValue(0);
  mockClient.caseAssignment.findMany.mockResolvedValue([]);
});

async function search(teamId: string, term: string) {
  return buildMatterQueue({
    teamId,
    userId: "test-user",
    role: "OWNER",
    filter: { search: term },
    limit: 50,
  });
}

describe("matter-queue search — base scope", () => {
  it("every base case.findMany carries the caller's teamId", async () => {
    await search(TEAM_A, "acme");
    expect(mockClient.case.findMany).toHaveBeenCalled();
    for (const call of mockClient.case.findMany.mock.calls) {
      const where = (call[0] as { where: { teamId: string } }).where;
      expect(where.teamId).toBe(TEAM_A);
    }
  });
});

describe("matter-queue search — dimensions", () => {
  it("(1) matches by name (contains, insensitive)", async () => {
    const env = await search(TEAM_A, "acme");
    expect(env.items.map((i) => i.id)).toContain(CASE_A1.id);
  });

  it("(2) matches by referenceNumber", async () => {
    const env = await search(TEAM_A, "REF-A-001");
    expect(env.items.map((i) => i.id)).toContain(CASE_A1.id);
  });

  it("(3) matches by FULL case uuid (exact id)", async () => {
    const env = await search(TEAM_A, CASE_A1.id);
    expect(env.items.map((i) => i.id)).toEqual([CASE_A1.id]);
    // A full uuid must NOT trigger the prefix `cases` raw subquery.
    const rawCalls = mockClient.$queryRaw.mock.calls.map((c) =>
      (c[0] as { strings: string[] }).strings.join(" "),
    );
    expect(
      rawCalls.some((s) => /FROM "cases"\s+WHERE/i.test(s) && !/JOIN/i.test(s)),
    ).toBe(false);
  });

  it("(4) matches by first-8-char uuid PREFIX via the team-scoped raw query", async () => {
    const prefix = CASE_A1.id.slice(0, 8); // "f2b14622"
    const env = await search(TEAM_A, prefix);
    expect(env.items.map((i) => i.id)).toContain(CASE_A1.id);

    // The prefix subquery must have bound TEAM_A (never a literal term).
    const prefixCall = mockClient.$queryRaw.mock.calls.find((c) => {
      const q = c[0] as { strings: string[] };
      const sql = q.strings.join(" ");
      return /FROM "cases"\s+WHERE/i.test(sql) && !/JOIN/i.test(sql);
    });
    expect(prefixCall).toBeTruthy();
    const q = prefixCall![0] as { values: unknown[] };
    expect(q.values).toContain(TEAM_A);
    // The term is bound as a param (`f2b14622%`), never concatenated.
    expect(q.values).toContain(`${prefix}%`);
  });

  it("(5) matches by OWNER email / name → ownerUserId in [...]", async () => {
    const env = await search(TEAM_A, "investigator@acme.example");
    expect(env.items.map((i) => i.id)).toContain(CASE_A1.id);

    const byName = await search(TEAM_A, "Dana");
    expect(byName.items.map((i) => i.id)).toContain(CASE_A1.id);
  });

  it("(6) matches by LINKED EVIDENCE id prefix → owning caseIds", async () => {
    const evPrefix = EVIDENCE_A1.id.slice(0, 8); // "e50a1111" — valid uuid-shaped hex prefix
    const env = await search(TEAM_A, evPrefix);
    expect(env.items.map((i) => i.id)).toContain(CASE_A1.id);

    // The evidence subquery must bind TEAM_A.
    const evCall = mockClient.$queryRaw.mock.calls.find((c) => {
      const q = c[0] as { strings: string[] };
      return /case_evidence_links/i.test(q.strings.join(" "));
    });
    expect(evCall).toBeTruthy();
    expect((evCall![0] as { values: unknown[] }).values).toContain(TEAM_A);
  });
});

describe("matter-queue search — CROSS-WORKSPACE no-leak", () => {
  it("a name term matching a team-B case returns nothing for team A", async () => {
    const env = await search(TEAM_A, "secret matter"); // only CASE_B1
    expect(env.items).toHaveLength(0);
  });

  it("team B's referenceNumber does not leak into team A", async () => {
    const env = await search(TEAM_A, "REF-B-777");
    expect(env.items).toHaveLength(0);
  });

  it("team B's FULL uuid does not leak into team A", async () => {
    const env = await search(TEAM_A, CASE_B1.id);
    expect(env.items).toHaveLength(0);
  });

  it("team B's uuid prefix does not leak into team A (raw query is team-scoped)", async () => {
    const env = await search(TEAM_A, CASE_B1.id.slice(0, 8)); // "c9c9c9c9"
    expect(env.items).toHaveLength(0);
    // And team A's own prefix DOES resolve within team A only.
    const envA = await search(TEAM_A, CASE_A1.id.slice(0, 8));
    expect(envA.items.map((i) => i.id)).toEqual([CASE_A1.id]);
  });

  it("owner-resolved ownerUserId is still AND-scoped by teamId (no cross-team owner leak)", async () => {
    // Even if a user matched, the base query's teamId AND-scope means a
    // team-A owner can never surface a team-B case. Searching team B for
    // team A's owner returns nothing.
    const env = await search(TEAM_B, "Dana");
    expect(env.items).toHaveLength(0);
  });
});

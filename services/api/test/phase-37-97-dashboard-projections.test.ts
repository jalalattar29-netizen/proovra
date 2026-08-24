/**
 * PHASE 37.97 — Dashboard projection layer tests.
 *
 * Two layers of coverage:
 *
 *   1. Source-contract: the Prisma schema declares the projection
 *      models with tenant-keyed indexes, the migration is additive,
 *      and the refresh service is structurally tenant-safe.
 *
 *   2. Behavioral (mocked Prisma): `refreshOrgHealthProjection` writes
 *      ONLY the row for the input teamId, never queries cross-tenant,
 *      and is idempotent (same input → same upsert).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

// =============================================================================
// PART 1 — Source-contract: schema + migration + refresh service
// =============================================================================

describe("Phase 37.97 — projection schema + migration", () => {
  const SCHEMA = readApi("prisma/schema.prisma");
  const MIGRATION = readApi(
    "prisma/migrations/20260720200000_dashboard_projections/migration.sql",
  );

  it("declares OrgHealthProjection with the canonical tenant-keyed shape", () => {
    expect(SCHEMA).toMatch(/model OrgHealthProjection\s*\{/);
    expect(SCHEMA).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
    expect(SCHEMA).toMatch(/sampledAtUtc\s+DateTime/);
    expect(SCHEMA).toMatch(/@@id\(\[teamId, sampledAtUtc\]\)/);
    expect(SCHEMA).toMatch(
      /@@index\(\[teamId, sampledAtUtc\(sort: Desc\)\]\)/,
    );
    expect(SCHEMA).toMatch(/@@map\("org_health_projections"\)/);
  });

  it("ReviewerQueueProjection model has been removed (orphan dropped)", () => {
    // The reviewer queue projection was added in 37.97 but never wired
    // into any service or worker. It was dropped in the
    // 20261009000000_drop_reviewer_queue_projection migration. The
    // schema must no longer declare the model or its table mapping.
    expect(SCHEMA).not.toMatch(/model ReviewerQueueProjection\s*\{/);
    expect(SCHEMA).not.toMatch(/@@map\("reviewer_queue_projections"\)/);
  });

  it("migration is additive (IF NOT EXISTS) on every CREATE", () => {
    const creates = MIGRATION.match(/CREATE [^\n]+/g) ?? [];
    for (const line of creates) {
      expect(
        /IF NOT EXISTS/i.test(line),
        `Migration must use IF NOT EXISTS for additive safety: ${line}`,
      ).toBe(true);
    }
  });

  it("migration declares the tenant-keyed indexes", () => {
    expect(MIGRATION).toMatch(
      /CREATE INDEX IF NOT EXISTS "org_health_projections_team_sampled_desc_idx"/,
    );
  });
});

describe("Phase 37.97 — refresh service is tenant-scoped", () => {
  const SRC = readApi(
    "../../packages/shared-runtime/src/org-health-projection.ts",
  );

  it("requires a teamId input (rejects empty)", () => {
    // WORKSPACE-SCOPE CONVERGENCE — the guard now lives in
    // `computeOrgHealthCounts`, which `refreshOrgHealthProjection` calls
    // first, and it additionally rejects a whitespace-only id. Matching the
    // CONDITION rather than one spelling of it keeps the contract — an absent
    // workspace id must refuse loudly, never return a confident set of zeros
    // about a workspace nobody named — while allowing the refactor that
    // removed the duplicate arithmetic.
    // Two refusals, asserted separately because they ARE separate statements:
    // an absent id and a whitespace-only one. Written as one `||` the refusal
    // becomes invisible to `refusalGuardOn`, which reads an `if (!<subject>)`
    // — the guard would still be there and the instrument would report it
    // missing.
    expect(SRC).toMatch(/if \(!input\.teamId\)/);
    expect(SRC).toMatch(/if \(!input\.teamId\.trim\(\)\)/);
    expect(SRC).toMatch(/throw new Error[\s\S]{0,200}teamId/);
  });

  it("every count query is scoped by `teamId` (no global aggregate)", () => {
    // Count the appearances of `.count(`. Each one must have `teamId`
    // in the surrounding 200 chars.
    const counts = [...SRC.matchAll(/\.count\(\s*\{[\s\S]*?\}\s*\)/g)];
    expect(counts.length).toBeGreaterThan(0);
    for (const m of counts) {
      // WORKSPACE-SCOPE CONVERGENCE — the bound is the canonical workspace
      // scope carried in an `AND` arm, not a literal `teamId` equality. That
      // is a STRICTER contract, not a looser one: a bare `teamId: input.teamId`
      // on Evidence or Case silently omits a personal workspace's legacy
      // NULL-team rows, so the old assertion passed while this projection
      // under-counted. The scope is strict for a shared workspace and
      // owner-bound for a personal one.
      //
      // The bindings are named `evidence` / `cases` because this is now the
      // ONE implementation both hosts reach; the Worker's copy — which omitted
      // the pipeline-status filter and turned stalled uploads into outstanding
      // reports — is deleted.
      const bounded =
        /\bAND:\s*\[\s*(scope|caseScope|evidence|cases)\b/.test(m[0]) ||
        /teamId/.test(m[0]);
      expect(
        bounded,
        `Every refresh count query must be bounded by the canonical workspace scope. Offender: ${m[0].slice(0, 200)}`,
      ).toBe(true);
    }
  });

  it("upsert uses the (teamId, sampledAtUtc) composite key only", () => {
    expect(SRC).toMatch(
      // Same composite key; the workspace id is now spelled `input.teamId`
      // because the authority takes an input object rather than a destructured
      // local. The KEY is what this pins, and it is unchanged.
      /upsert\(\s*\{[\s\S]*?teamId_sampledAtUtc:\s*\{\s*teamId:\s*input\.teamId,\s*sampledAtUtc\s*\}/,
    );
  });

  it("never writes audit/billing/legal-hold/retention side effects", () => {
    // Strip comments so the doc-string "no billing writes" doesn't trip
    // the negative match.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(^|[^:])\/\/.*$/gm,
      "$1",
    );
    expect(code).not.toMatch(/auditLog\b/);
    expect(code).not.toMatch(/auditEvent\.create/);
    expect(code).not.toMatch(/prisma\.billing/i);
    expect(code).not.toMatch(/legalHold\./);
    expect(code).not.toMatch(/retentionPolicy\./);
  });
});

// =============================================================================
// PART 2 — Behavioral: refresh writes only the input teamId's row
// =============================================================================

// Mock Prisma BEFORE importing the refresh service.
const teamFindUnique = vi.fn();
const mockClient = {
  // WORKSPACE-SCOPE CONVERGENCE — the refresh now resolves the workspace's
  // kind and owner before counting, so the fake must model the Team row it
  // reads. Defaulting to a NON-personal workspace keeps every existing
  // assertion below meaning exactly what it meant: a shared workspace's scope
  // is the strict  these tests already assert on.
  team: { findUnique: (...args: unknown[]) => teamFindUnique(...args) },
  evidence: { count: vi.fn() },
  case: { count: vi.fn() },
  orgHealthProjection: {
    upsert: vi.fn(),
    findFirst: vi.fn(),
  },
};
// WORKSPACE-SCOPE CONVERGENCE — the authority moved into
// `@proovra/shared-runtime`, which never constructs a Prisma client; each host
// registers its own. Mocking `../src/db.js` would therefore intercept nothing.
// Passing the fake in is also the stronger test: it proves the optional-client
// parameter is honoured, which is what lets a caller inside a transaction
// resolve on the same connection it queries on.
const fakeClient = mockClient as unknown as import("@prisma/client").PrismaClient;

const { refreshOrgHealthProjection, readLatestOrgHealthProjection } =
  await import(
    "@proovra/shared-runtime"
  );

beforeEach(() => {
  teamFindUnique.mockReset();
  teamFindUnique.mockResolvedValue({ isPersonal: false, ownerUserId: null });
  mockClient.evidence.count.mockReset();
  mockClient.case.count.mockReset();
  mockClient.orgHealthProjection.upsert.mockReset();
  mockClient.orgHealthProjection.findFirst.mockReset();
});

describe("Phase 37.97 — refresh service tenant safety (behavioral)", () => {
  it("rejects an empty teamId loudly", async () => {
    await expect(
      refreshOrgHealthProjection({ teamId: "" }, fakeClient),
    ).rejects.toThrow(/teamId/);
    expect(mockClient.evidence.count).not.toHaveBeenCalled();
  });

  it("scopes EVERY count query by the input teamId", async () => {
    mockClient.evidence.count.mockResolvedValue(3);
    mockClient.case.count.mockResolvedValue(2);
    mockClient.orgHealthProjection.upsert.mockResolvedValue({});

    await refreshOrgHealthProjection({ teamId: "teamA" }, fakeClient);

    // Every recorded count call's `where` must reference `teamId: "teamA"`.
    const allCalls = [
      ...mockClient.evidence.count.mock.calls,
      ...mockClient.case.count.mock.calls,
    ];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      const arg = call[0] as {
        where?: { teamId?: string; AND?: Array<{ teamId?: string }> };
      };
      // A shared workspace's canonical scope IS `{ teamId }` — it is carried
      // in the AND arm rather than written inline, so the tenant bound is
      // asserted wherever the query actually puts it.
      const bound = arg.where?.teamId ?? arg.where?.AND?.[0]?.teamId;
      expect(
        bound,
        `Every count must filter by the input teamId. Offender args: ${JSON.stringify(arg)}`,
      ).toBe("teamA");
    }
  });

  it("upserts the row for the input teamId (and only that team)", async () => {
    mockClient.evidence.count.mockResolvedValue(0);
    mockClient.case.count.mockResolvedValue(0);
    mockClient.orgHealthProjection.upsert.mockResolvedValue({});

    await refreshOrgHealthProjection({ teamId: "teamA" }, fakeClient);

    expect(mockClient.orgHealthProjection.upsert).toHaveBeenCalledTimes(1);
    const arg = mockClient.orgHealthProjection.upsert.mock.calls[0][0] as {
      where: { teamId_sampledAtUtc: { teamId: string } };
      create: { teamId: string };
    };
    expect(arg.where.teamId_sampledAtUtc.teamId).toBe("teamA");
    expect(arg.create.teamId).toBe("teamA");
  });

  it("refresh for teamA does NOT touch teamB's projection row", async () => {
    mockClient.evidence.count.mockResolvedValue(0);
    mockClient.case.count.mockResolvedValue(0);
    mockClient.orgHealthProjection.upsert.mockResolvedValue({});

    await refreshOrgHealthProjection({ teamId: "teamA" }, fakeClient);

    // Inspect every upsert call: none may target teamB.
    for (const call of mockClient.orgHealthProjection.upsert.mock.calls) {
      const arg = call[0] as {
        where: { teamId_sampledAtUtc: { teamId: string } };
      };
      expect(arg.where.teamId_sampledAtUtc.teamId).not.toBe("teamB");
    }
  });

  it("readLatestOrgHealthProjection filters by teamId", async () => {
    mockClient.orgHealthProjection.findFirst.mockResolvedValue(null);
    await readLatestOrgHealthProjection({ teamId: "teamA" }, fakeClient);
    const arg = mockClient.orgHealthProjection.findFirst.mock.calls[0][0] as {
      where: { teamId: string };
    };
    expect(arg.where.teamId).toBe("teamA");
  });

  it("returns null when no projection row exists (caller falls back to live)", async () => {
    mockClient.orgHealthProjection.findFirst.mockResolvedValue(null);
    const result = await readLatestOrgHealthProjection({ teamId: "teamA" }, fakeClient);
    expect(result).toBeNull();
  });
});

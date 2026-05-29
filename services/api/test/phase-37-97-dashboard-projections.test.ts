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
    "src/services/dashboard/projections/refresh-org-health.service.ts",
  );

  it("requires a teamId input (rejects empty)", () => {
    expect(SRC).toMatch(/if \(!input\.teamId\)/);
    expect(SRC).toMatch(/throw new Error[\s\S]{0,200}teamId/);
  });

  it("every count query is scoped by `teamId` (no global aggregate)", () => {
    // Count the appearances of `.count(`. Each one must have `teamId`
    // in the surrounding 200 chars.
    const counts = [...SRC.matchAll(/\.count\(\s*\{[\s\S]*?\}\s*\)/g)];
    expect(counts.length).toBeGreaterThan(0);
    for (const m of counts) {
      expect(
        /teamId/.test(m[0]),
        `Every refresh count query must scope by teamId. Offender: ${m[0].slice(0, 200)}`,
      ).toBe(true);
    }
  });

  it("upsert uses the (teamId, sampledAtUtc) composite key only", () => {
    expect(SRC).toMatch(
      /upsert\(\s*\{[\s\S]*?teamId_sampledAtUtc:\s*\{\s*teamId,\s*sampledAtUtc\s*\}/,
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
const mockClient = {
  evidence: { count: vi.fn() },
  case: { count: vi.fn() },
  orgHealthProjection: {
    upsert: vi.fn(),
    findFirst: vi.fn(),
  },
};
vi.mock("../src/db.js", () => ({ prisma: mockClient }));

const { refreshOrgHealthProjection, readLatestOrgHealthProjection } =
  await import(
    "../src/services/dashboard/projections/refresh-org-health.service.js"
  );

beforeEach(() => {
  mockClient.evidence.count.mockReset();
  mockClient.case.count.mockReset();
  mockClient.orgHealthProjection.upsert.mockReset();
  mockClient.orgHealthProjection.findFirst.mockReset();
});

describe("Phase 37.97 — refresh service tenant safety (behavioral)", () => {
  it("rejects an empty teamId loudly", async () => {
    await expect(
      refreshOrgHealthProjection({ teamId: "" }),
    ).rejects.toThrow(/teamId/);
    expect(mockClient.evidence.count).not.toHaveBeenCalled();
  });

  it("scopes EVERY count query by the input teamId", async () => {
    mockClient.evidence.count.mockResolvedValue(3);
    mockClient.case.count.mockResolvedValue(2);
    mockClient.orgHealthProjection.upsert.mockResolvedValue({});

    await refreshOrgHealthProjection({ teamId: "teamA" });

    // Every recorded count call's `where` must reference `teamId: "teamA"`.
    const allCalls = [
      ...mockClient.evidence.count.mock.calls,
      ...mockClient.case.count.mock.calls,
    ];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      const arg = call[0] as { where?: { teamId?: string } };
      expect(
        arg.where?.teamId,
        `Every count must filter by the input teamId. Offender args: ${JSON.stringify(arg)}`,
      ).toBe("teamA");
    }
  });

  it("upserts the row for the input teamId (and only that team)", async () => {
    mockClient.evidence.count.mockResolvedValue(0);
    mockClient.case.count.mockResolvedValue(0);
    mockClient.orgHealthProjection.upsert.mockResolvedValue({});

    await refreshOrgHealthProjection({ teamId: "teamA" });

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

    await refreshOrgHealthProjection({ teamId: "teamA" });

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
    await readLatestOrgHealthProjection({ teamId: "teamA" });
    const arg = mockClient.orgHealthProjection.findFirst.mock.calls[0][0] as {
      where: { teamId: string };
    };
    expect(arg.where.teamId).toBe("teamA");
  });

  it("returns null when no projection row exists (caller falls back to live)", async () => {
    mockClient.orgHealthProjection.findFirst.mockResolvedValue(null);
    const result = await readLatestOrgHealthProjection({ teamId: "teamA" });
    expect(result).toBeNull();
  });
});

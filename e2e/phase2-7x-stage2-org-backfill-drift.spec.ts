/**
 * Phase 2.7X Stage 2 — Org backfill + drift-protection regression tests.
 *
 * Locks in:
 *
 *   1. Existing Phase 2.6 governance endpoints still gate correctly
 *      after the Org backfill (regression guard — backfill must NOT
 *      have changed any RBAC behavior).
 *
 *   2. No new public route surfaces org membership data yet (Stage 3+
 *      work). If someone accidentally exposes `/v1/orgs/*` BEFORE the
 *      Stage 3 dual-read design is complete, this test will fail.
 *
 *   3. The destructive-diff guard refuses unsafe SQL — exercised by
 *      shelling out to the `db:diff-guard` script with a synthetic
 *      DROP TABLE on a protected-runtime-table name.
 *
 * These tests do NOT mutate the DB. They verify regression-level
 * invariants only.
 */
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

const FAKE_TEAM = "00000000-0000-4000-8000-000000000001";

test.describe("Phase 2.7X Stage 2 — org backfill + drift protection @critical", () => {
  test("Phase 2.6D RBAC matrix still returns canonical shape (regression)", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/platform/rbac/matrix");
    expect(
      resp.ok(),
      `Phase 2.6D matrix endpoint must still work after Org backfill; got ${resp.status()}`,
    ).toBe(true);
    const body = (await resp.json()) as { roles?: unknown[]; categories?: unknown[] };
    expect(Array.isArray(body.roles)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
  });

  test("Phase 2.6B access-review endpoint still refuses authed non-members (regression)", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(`/v1/teams/${FAKE_TEAM}/access-review`);
    // Phase 2.6B contract: 403 for authed non-members, 404 for missing
    // team. Either is acceptable; the key invariant is that authed
    // non-members CANNOT read another team's access-review payload.
    expect([403, 404]).toContain(resp.status());
  });

  test("Phase 2.6B external-collaborators endpoint still refuses authed non-members (regression)", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(
      `/v1/teams/${FAKE_TEAM}/external-collaborators`,
    );
    expect([403, 404]).toContain(resp.status());
  });

  // NOTE: Stage 2 previously asserted `/v1/orgs/*` returned 404 as a
  // guard against accidental early Stage 3 rollout. Stage 3 now ships
  // those endpoints; the equivalent contract assertion (authed
  // non-members get 403 + UUID validation) lives in
  // `phase2-7x-stage3-org-runtime.spec.ts`.

  test("db:diff-guard refuses DROP TABLE on a protected runtime table", async () => {
    // Synthetic destructive SQL that targets a known drift-catalog
    // table. The guard must exit non-zero (9) and refuse to echo
    // the SQL to stdout.
    const malicious = 'DROP TABLE "evidence_ocr_text";';
    const apiRoot = resolve(__dirname, "..", "services", "api");
    const result = spawnSync(
      "node",
      ["scripts/db-diff-guard.mjs"],
      {
        cwd: apiRoot,
        input: malicious,
        encoding: "utf8",
        shell: false,
      },
    );
    expect(
      result.status,
      `db:diff-guard must refuse destructive ops on protected tables; got exit ${result.status}, stderr:\n${result.stderr}`,
    ).toBe(9);
    // The guard MUST NOT echo the malicious SQL through stdout.
    expect(result.stdout).not.toContain("DROP TABLE");
    // The refusal banner must name the protected table.
    expect(result.stderr).toContain("evidence_ocr_text");
  });

  test("db:diff-guard passes safe additive SQL", async () => {
    const safe = `-- Phase 2.7X Stage 2 e2e test fixture\nCREATE TABLE "phase_2_7x_test_table" ("id" UUID PRIMARY KEY);\n`;
    const apiRoot = resolve(__dirname, "..", "services", "api");
    const result = spawnSync(
      "node",
      ["scripts/db-diff-guard.mjs"],
      {
        cwd: apiRoot,
        input: safe,
        encoding: "utf8",
        shell: false,
      },
    );
    expect(
      result.status,
      `db:diff-guard must pass safe additive SQL; got exit ${result.status}, stderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain("CREATE TABLE");
    expect(result.stdout).toContain("phase_2_7x_test_table");
  });
});

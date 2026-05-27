/**
 * Phase 2.5D — Migration safety hardening regression tests.
 *
 * Covers:
 *   1. The in-process safety hook in `prisma.config.ts` refuses
 *      direct `prisma migrate` invocations against a remote URL,
 *      with exit code 8 (distinct from the wrapper's exit 3 so the
 *      enforcement layer is identifiable from the exit code alone).
 *   2. The destructive migration scanner classifies a synthetic
 *      sample SQL containing `DROP TABLE` as DESTRUCTIVE (exit
 *      code 10).
 *   3. The destructive scanner classifies an ADD-COLUMN-only SQL
 *      as SAFE (exit code 0).
 *   4. The safe-migrate wrapper refuses remote migrations missing
 *      the Phase 2.5D backup acknowledgement (exit code 11) even
 *      when the dual override is supplied.
 *   5. The shared policy module agrees on classifications across
 *      the wrapper + the in-process hook (regression for the
 *      "duplicate policy code drifts" risk).
 */
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const API_DIR = resolve(process.cwd(), "services/api");
const SAFE_MIGRATE = join(API_DIR, "scripts/safe-migrate.mjs");
const RISK_SCAN = join(API_DIR, "scripts/migration-risk-scan.mjs");

test.describe("Phase 2.5D — migration safety hardening @critical", () => {
  test("in-process prisma config hook refuses remote URL with exit 8", async () => {
    // Direct prisma invocation — bypasses safe-migrate.mjs but is
    // caught by the in-process hook in prisma.config.ts.
    const result = spawnSync(
      "pnpm",
      ["exec", "prisma", "migrate", "status"],
      {
        encoding: "utf8",
        cwd: API_DIR,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "DATABASE_URL"),
          ),
          DATABASE_URL:
            "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/db",
        },
        shell: process.platform === "win32",
      },
    );
    expect(
      result.status,
      `expected exit 8; got ${result.status}\nstderr:\n${result.stderr ?? ""}`,
    ).toBe(8);
    expect(result.stderr ?? "").toContain("in-process migration safety hook");
    expect(result.stderr ?? "").toContain("ep-fake.eu-central-1.aws.neon.tech");
  });

  test("risk scanner reports DESTRUCTIVE on DROP TABLE migration", async () => {
    // Build an isolated migrations directory with one DROP TABLE
    // migration. Run the scanner against it. Expect exit 10.
    const tmpRoot = mkdtempSync(join(tmpdir(), "p25d-risk-"));
    const migDir = join(tmpRoot, "prisma", "migrations", "test_destructive");
    mkdirSync(migDir, { recursive: true });
    writeFileSync(
      join(migDir, "migration.sql"),
      "-- test migration\nDROP TABLE \"some_table\";\n",
    );
    try {
      const result = spawnSync("node", [RISK_SCAN], {
        encoding: "utf8",
        cwd: tmpRoot,
        shell: process.platform === "win32",
      });
      expect(result.status).toBe(10);
      expect(result.stdout ?? "").toContain("DESTRUCTIVE");
      expect(result.stdout ?? "").toContain("DROP TABLE");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("risk scanner reports SAFE on ADD COLUMN-only migration", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "p25d-safe-"));
    const migDir = join(tmpRoot, "prisma", "migrations", "test_safe");
    mkdirSync(migDir, { recursive: true });
    writeFileSync(
      join(migDir, "migration.sql"),
      "-- additive migration\n" +
        "CREATE TABLE \"new_table\" (\"id\" UUID PRIMARY KEY);\n" +
        "ALTER TABLE \"new_table\" ADD COLUMN \"name\" TEXT;\n",
    );
    try {
      const result = spawnSync("node", [RISK_SCAN], {
        encoding: "utf8",
        cwd: tmpRoot,
        shell: process.platform === "win32",
      });
      expect(result.status).toBe(0);
      expect(result.stdout ?? "").toContain("[SAFE       ]");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("safe-migrate refuses remote migration without MIGRATE_BACKUP_ID", async () => {
    const result = spawnSync(
      "node",
      [SAFE_MIGRATE, "status", "--allow-remote"],
      {
        encoding: "utf8",
        cwd: API_DIR,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) =>
                k !== "DATABASE_URL" &&
                k !== "MIGRATE_BACKUP_ID" &&
                k !== "MIGRATE_ALLOW_REMOTE",
            ),
          ),
          DATABASE_URL:
            "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/db",
          MIGRATE_ALLOW_REMOTE: "1",
        },
        shell: process.platform === "win32",
      },
    );
    expect(
      result.status,
      `expected exit 11 (missing backup ack); got ${result.status}\nstderr:\n${result.stderr ?? ""}`,
    ).toBe(11);
    expect(result.stderr ?? "").toContain("MIGRATE_BACKUP_ID");
    expect(result.stderr ?? "").toContain("backup");
  });

  test("policy module classifies the same way as the in-process hook", async () => {
    // Smoke-test that both code paths agree by invoking the
    // wrapper (which uses the .mjs policy) and the in-process hook
    // (which inlines the same logic) against the same URL. Both
    // should refuse identically.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "DATABASE_URL"),
      ),
      DATABASE_URL: "postgresql://x:y@db.unknown-host.example.com:5432/db",
    };
    const wrapperResult = spawnSync("node", [SAFE_MIGRATE, "status"], {
      encoding: "utf8",
      cwd: API_DIR,
      env,
      shell: process.platform === "win32",
    });
    const directResult = spawnSync(
      "pnpm",
      ["exec", "prisma", "migrate", "status"],
      {
        encoding: "utf8",
        cwd: API_DIR,
        env,
        shell: process.platform === "win32",
      },
    );
    // Wrapper exits 3; in-process hook exits 8 — both refuse, but
    // with different codes so operators can tell which layer fired.
    expect(wrapperResult.status).toBe(3);
    expect(directResult.status).toBe(8);
    // Both must mention the same host string in their output.
    expect(wrapperResult.stderr ?? "").toContain("db.unknown-host.example.com");
    expect(directResult.stderr ?? "").toContain("db.unknown-host.example.com");
  });
});

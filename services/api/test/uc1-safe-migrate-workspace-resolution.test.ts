/**
 * REGRESSION — the migration safety wrapper must resolve the API-local Prisma
 * CLI when invoked from the REPOSITORY ROOT, exactly as the UC-1 Windows
 * acceptance harness invokes it (`node services/api/scripts/safe-migrate.mjs
 * <cmd>` with cwd = repo root).
 *
 * The bug: `safe-migrate.mjs` spawned `pnpm exec prisma migrate …` in the
 * caller's cwd. `prisma` is a dependency of the `proovra-api` workspace
 * (services/api), not of the repository root, so from the root the spawn failed
 * with `Command "prisma" not found` / `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`, and
 * `pnpm uc1:acceptance:windows` died at the migrate step. The fix pins the
 * prisma spawn's cwd to the proovra-api workspace directory (derived from the
 * wrapper's own location), so the CLI resolves regardless of caller cwd.
 *
 * This test runs the wrapper with `status` (read-only, no schema mutation) so it
 * is hermetic — it needs no database, only a resolvable Prisma CLI. The DB URL
 * points at a definitely-unreachable LOCAL port with a `*_test` name, so the
 * host guard classifies it LOCAL and prisma runs and then fails to connect. The
 * point is not the connection: it is that prisma was FOUND and EXECUTED from the
 * repo root, which the pre-connection banner proves and the old bug prevented.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const WRAPPER_REL = "services/api/scripts/safe-migrate.mjs";
// Unreachable LOCAL target, `*_test` name → classified LOCAL, allowed, no DB
// contacted for real (connection is refused immediately).
const UNREACHABLE_LOCAL =
  "postgresql://proovra:disposable@127.0.0.1:59991/uc1_resolution_probe_test";

function runWrapperFromRepoRoot(subcommand: string) {
  return spawnSync("node", [WRAPPER_REL, subcommand], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: UNREACHABLE_LOCAL,
      DIRECT_URL: UNREACHABLE_LOCAL,
      // Never allow a remote target from this test, whatever the ambient env.
      MIGRATE_ALLOW_REMOTE: "",
    },
    encoding: "utf8",
    // The wrapper itself spawns `pnpm` with shell on win32; `node` is a real
    // binary so it needs no shell here.
    timeout: 120_000,
  });
}

describe("UC-1 safe-migrate — Prisma CLI resolves from the repository root", () => {
  it("does NOT fail with 'prisma not found' when run from the repo root", () => {
    const res = runWrapperFromRepoRoot("status");
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    // The exact failure symptoms the harness hit must be gone.
    expect(out).not.toMatch(/not recognized as an internal or external command/i);
    expect(out).not.toMatch(/Command "prisma" not found/i);
    expect(out).not.toMatch(/ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/i);
  });

  it("actually resolves and executes the API-local Prisma CLI (config + schema load)", () => {
    const res = runWrapperFromRepoRoot("status");
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    // Positive proof prisma RAN: it printed its own pre-connection banner (it
    // loaded prisma.config.ts and the schema) before it could fail to reach the
    // unreachable local port. The old bug never got this far.
    const prismaRan =
      /Prisma schema loaded/i.test(out) ||
      /Loaded Prisma config/i.test(out) ||
      /migrations found/i.test(out) ||
      /P1001/i.test(out) ||
      /Can't reach database server/i.test(out);
    expect(prismaRan, `wrapper output did not show prisma executing:\n${out}`).toBe(true);
  });

  it("preserves the LOCAL host classification and the safety banner from the root", () => {
    const res = runWrapperFromRepoRoot("status");
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    // The wrapper's own guard ran in-process before the spawn.
    expect(out).toMatch(/PROOVRA migration safety wrapper/i);
    expect(out).toMatch(/classification: LOCAL/i);
    // And it never refused a remote host (this target is local).
    expect(out).not.toMatch(/REFUSED: target host/i);
  });
});

/**
 * Phase 2.5C — Migration safety wrapper regression tests.
 *
 * These tests exercise the `services/api/scripts/safe-migrate.mjs`
 * wrapper directly (no HTTP), and assert the four cases that matter
 * for platform safety:
 *
 *   1. A remote host (matching the Neon pattern) is REFUSED with
 *      exit code 3.
 *   2. A remote host WITH the `--allow-remote` flag but WITHOUT the
 *      `MIGRATE_ALLOW_REMOTE=1` env var is still REFUSED.
 *   3. A remote host WITH the env var but WITHOUT the flag is still
 *      REFUSED.
 *   4. A missing `DATABASE_URL` is REFUSED with exit code 2.
 *
 * These tests do NOT exercise the success path (passing both
 * overrides + a remote DB) because we don't want CI to ever
 * actually attempt a remote prisma command. The CI workflow's own
 * "Verify safe-migrate refuses a remote DATABASE_URL" step covers
 * the same surface from the CI side.
 *
 * The tests run as Playwright @critical so they share the existing
 * gate posture and run on every PR.
 */
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir as _tmpdir } from "node:os";
void _tmpdir; // re-imported inside the test that uses it

const SCRIPT_PATH = resolve(
  process.cwd(),
  "services/api/scripts/safe-migrate.mjs",
);

function runSafeMigrate(
  args: string[],
  env: Record<string, string | undefined>,
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    cwd: resolve(process.cwd(), "services/api"),
    env: {
      // Strip the parent process's DATABASE_URL so each test
      // starts from a known-empty baseline. Tests that need a DB
      // URL set it explicitly via the `env` arg.
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "DATABASE_URL"),
      ),
      ...env,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test.describe("Phase 2.5C — migration safety wrapper @critical", () => {
  test.beforeAll(() => {
    expect(
      existsSync(SCRIPT_PATH),
      `safe-migrate.mjs must exist at ${SCRIPT_PATH}`,
    ).toBe(true);
  });

  test("refuses a Neon URL with exit code 3", async () => {
    const r = runSafeMigrate(["status"], {
      DATABASE_URL:
        "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/neondb",
    });
    expect(
      r.code,
      `expected exit 3, got ${r.code}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
    ).toBe(3);
    // The refusal message must contain the exact host so an
    // operator can confirm the right DB triggered the refusal.
    expect(r.stderr).toContain("ep-fake.eu-central-1.aws.neon.tech");
    expect(r.stderr).toContain("REFUSED");
  });

  test("refuses --allow-remote without MIGRATE_ALLOW_REMOTE", async () => {
    const r = runSafeMigrate(["status", "--allow-remote"], {
      DATABASE_URL:
        "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/neondb",
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Both are required");
  });

  test("refuses MIGRATE_ALLOW_REMOTE without --allow-remote flag", async () => {
    const r = runSafeMigrate(["status"], {
      DATABASE_URL:
        "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/neondb",
      MIGRATE_ALLOW_REMOTE: "1",
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Both are required");
  });

  test("refuses missing DATABASE_URL with exit code 2", async () => {
    // The wrapper falls back to loading services/api/.env and the
    // repo-root .env. To exercise the "no URL at all" branch we
    // run the script from a temp directory (os.tmpdir()) so neither
    // .env file is loaded; we also pass an empty string for
    // DATABASE_URL so the env-var-set path can't see it either.
    const { tmpdir } = await import("node:os");
    const tmpCwd = tmpdir();
    const result = spawnSync("node", [SCRIPT_PATH, "status"], {
      encoding: "utf8",
      cwd: tmpCwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== "DATABASE_URL"),
        ),
        DATABASE_URL: "",
      },
    });
    expect(
      result.status,
      `expected exit 2; got ${result.status}\nstderr:\n${result.stderr ?? ""}`,
    ).toBe(2);
    expect(result.stderr ?? "").toContain("DATABASE_URL is not set");
  });

  test("prints a clear target banner before any classification check", async () => {
    // The banner is the operator's last-chance visual signal. It must
    // appear in stderr for BOTH allowed and refused paths.
    const r = runSafeMigrate(["status"], {
      DATABASE_URL:
        "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/neondb",
    });
    expect(r.stderr).toContain("PROOVRA migration safety wrapper");
    expect(r.stderr).toContain("classification: REMOTE");
    expect(r.stderr).toContain("ep-fake.eu-central-1.aws.neon.tech");
  });

  test("classifies an unknown host (custom DNS) as `unknown` and refuses", async () => {
    // A DNS name we don't recognise (no Neon/AWS pattern, not in the
    // local allowlist) must be refused with classification=unknown.
    // This is the defense-in-depth path for self-hosted / custom
    // DB hostnames the wrapper doesn't know about.
    const r = runSafeMigrate(["status"], {
      DATABASE_URL: "postgresql://x:y@db.internal.example.com:5432/app",
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("classification: UNKNOWN");
    expect(r.stderr).toContain("db.internal.example.com");
  });
});

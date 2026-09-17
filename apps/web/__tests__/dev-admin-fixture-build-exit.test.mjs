/**
 * PV-TOOL-001 — a failed fixture build fails the command.
 *
 * `dev-admin-fixture.mjs --build-only` is the CI step that builds the admin
 * control-plane suite's production bundle. The audit watched a failed build
 * print "next build failed" while the caller saw success, and the next step
 * then died with "no build at …". A build step that can report green without
 * producing a build is a false success.
 *
 * These cases run the REAL script with `npx` replaced on PATH by a stub, so
 * `next build` is exercised as a black box: the stub either fails, or
 * "succeeds" without writing BUILD_ID. Each case first asserts the script
 * actually reached the build (a child that never ran proves nothing), then
 * asserts the exit status.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(WEB_ROOT, "scripts", "dev-admin-fixture.mjs");
const DIST = "node_modules/.cache/pv-tool-001-build-exit-proof";

/** A directory whose `npx` exits with `code` and writes nothing. */
function stubNpx(code) {
  const dir = mkdtempSync(join(tmpdir(), "pv-tool-001-"));
  if (process.platform === "win32") {
    writeFileSync(join(dir, "npx.cmd"), `@echo stub npx %*\r\n@exit /b ${code}\r\n`);
  } else {
    const p = join(dir, "npx");
    writeFileSync(p, `#!/bin/sh\necho "stub npx $*"\nexit ${code}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

function runBuild(code) {
  const dir = stubNpx(code);
  try {
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    return spawnSync(
      process.execPath,
      [SCRIPT, "--mode=production", "--build-only", `--dist=${DIST}`],
      {
        cwd: WEB_ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}` },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(WEB_ROOT, DIST), { recursive: true, force: true });
  }
}

test("a build that fails exits with the build's status", () => {
  const r = runBuild(7);
  assert.equal(r.error, undefined, String(r.error));
  assert.match(r.stdout, /stub npx next build/, "the script reached the build");
  assert.equal(r.status, 7, r.stdout + r.stderr);
});

test("a build that reports success but leaves no BUILD_ID is a failure", () => {
  const r = runBuild(0);
  assert.equal(r.error, undefined, String(r.error));
  assert.match(r.stdout, /stub npx next build/, "the script reached the build");
  assert.notEqual(r.status, 0, "exit 0 without a build is the false success");
  assert.match(r.stderr, /no BUILD_ID/);
});

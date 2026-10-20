#!/usr/bin/env node
/**
 * Build the extension's test bundle, then run its tests — one command, no
 * shell quoting (the forward mutation runner invokes it on Linux and Windows).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const script of ["build-test.mjs", "scripts/run-tests.mjs"]) {
  const r = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

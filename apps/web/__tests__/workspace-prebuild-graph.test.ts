/**
 * DEPLOYMENT REPRODUCIBILITY CONTRACT — the web prebuild graph must build
 * EVERY workspace dependency whose package resolution points into generated
 * `dist/` output.
 *
 * Root cause this pins: `@proovra/shared-billing` exports only `./dist/*`
 * (main/module/types/exports + `files: ["dist"]`), `dist/` is gitignored, and
 * the web `prebuild` chain did not build it — so every CLEAN checkout
 * (Vercel) failed with `Module not found: Can't resolve
 * '@proovra/shared-billing'` while local builds silently rode on stale,
 * untracked dist output.
 *
 * The contract is derived from the ACTUAL package manifests — a new workspace
 * dependency with dist-based exports fails this test the moment it is added
 * to apps/web without also being added to the canonical prebuild sequence.
 * (One build mechanism: the `prebuild` script IS the repo's web build graph;
 * Vercel runs `pnpm --filter proovra-web build`, which triggers it.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

type PackageJson = {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const webPkg = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "package.json"), "utf8"),
) as PackageJson;

/** Every @proovra/* workspace dependency of apps/web, resolved to its manifest. */
function workspaceDeps(): Array<{ name: string; pkg: PackageJson }> {
  const all = { ...(webPkg.dependencies ?? {}), ...(webPkg.devDependencies ?? {}) };
  const out: Array<{ name: string; pkg: PackageJson }> = [];
  for (const [name, spec] of Object.entries(all)) {
    if (!name.startsWith("@proovra/") || !spec.startsWith("workspace:")) continue;
    const dir = resolve(REPO_ROOT, "packages", name.replace("@proovra/", ""));
    const manifest = resolve(dir, "package.json");
    assert.ok(existsSync(manifest), `workspace dep ${name} has no package at ${dir}`);
    out.push({ name, pkg: JSON.parse(readFileSync(manifest, "utf8")) as PackageJson });
  }
  return out;
}

/** True when the package's resolution surface points into generated dist/. */
function exportsGeneratedDist(pkg: PackageJson): boolean {
  const fields = [pkg.main, pkg.module, pkg.types].filter(
    (v): v is string => typeof v === "string",
  );
  if (fields.some((v) => v.includes("dist/"))) return true;
  return JSON.stringify(pkg.exports ?? {}).includes("dist/");
}

test("every dist-exporting @proovra workspace dependency of apps/web is in the prebuild graph", () => {
  const prebuild = webPkg.scripts?.prebuild ?? "";
  assert.ok(prebuild.length > 0, "apps/web must define the canonical prebuild chain");
  const missing = workspaceDeps()
    .filter(({ pkg }) => exportsGeneratedDist(pkg))
    .filter(({ name }) => !prebuild.includes(`--filter ${name} build`))
    .map(({ name }) => name);
  assert.deepEqual(
    missing,
    [],
    `dist-exporting workspace deps missing from the web prebuild chain (clean ` +
      `checkouts like Vercel will fail with Module-not-found): ${missing.join(", ")}`,
  );
});

test("each dist-exporting workspace dep actually has a build script the chain can run", () => {
  for (const { name, pkg } of workspaceDeps()) {
    if (!exportsGeneratedDist(pkg)) continue;
    assert.ok(
      typeof pkg.scripts?.build === "string" && pkg.scripts.build.length > 0,
      `${name} exports dist/ but has no build script — the prebuild chain cannot produce its output`,
    );
  }
});

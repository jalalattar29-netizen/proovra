/**
 * DEPLOYMENT REPRODUCIBILITY CONTRACT — every package that consumes generated
 * `dist/` output must BUILD that output before it builds AND before it
 * typechecks.
 *
 * The original root cause: `@proovra/shared-billing` exports only `./dist/*`,
 * `dist/` is gitignored, and the web `prebuild` chain did not build it — so
 * every CLEAN checkout (Vercel) failed with `Module not found: Can't resolve
 * '@proovra/shared-billing'` while local builds silently rode on stale,
 * untracked dist output.
 *
 * THE SECOND INSTANCE, AND WHY THIS CONTRACT IS NOW REPO-WIDE (2026-08-25)
 * ---------------------------------------------------------------------------
 * `origin/main` failed with:
 *
 *   evidence-lifecycle.service.ts: Property 'archiveBlockReason' does not
 *   exist on type 'EvidenceLifecycleCapabilities'
 *
 * The source was consistent — `archiveBlockReason` IS a field on the canonical
 * authority. `services/api` resolves `@proovra/shared` through
 * `dist/index.d.ts`, and `typecheck` had no equivalent of `prebuild`, so it
 * measured whatever `dist/` happened to be lying around. On a machine with a
 * fresh build it passed; on a clean checkout it failed to resolve the module at
 * all, and on a machine holding output from an older branch it reported a
 * missing property on a type that has it.
 *
 * The same audit found `@proovra/shared-runtime` — dist-exporting, imported by
 * 33 worker files and by the API — missing from the root `build:shared`
 * aggregate and from the worker's chain, alongside two more the worker imports
 * and never built. Those are the same bug, not new ones, which is why the
 * contract below is derived from the ACTUAL manifests for EVERY package rather
 * than asserted about one hand-maintained script.
 *
 * ONE CHAIN PER PACKAGE. `build:deps` is it; `prebuild` and `pretypecheck` both
 * delegate to it, so the build path and the typecheck path cannot drift apart —
 * which is exactly how the typecheck path came to have no chain at all.
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

const read = (rel: string): PackageJson =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf8")) as PackageJson;

/**
 * Every package in the workspace that can consume another one.
 *
 * Listed as directories rather than discovered by globbing so a package that
 * is deleted or renamed fails loudly here instead of silently dropping out of
 * the contract.
 */
const CONSUMERS = [
  "apps/web",
  "apps/mobile",
  "services/api",
  "services/worker",
  "packages/shared-runtime",
  "packages/shared-evidence-presentation",
  "packages/shared-billing",
  "packages/ui",
  "packages/shared",
] as const;

const webPkg = read("apps/web/package.json");

/** Resolve a `@proovra/*` workspace name to its directory in the repo. */
function packageDir(name: string): string {
  return resolve(REPO_ROOT, "packages", name.replace("@proovra/", ""));
}

/** The `@proovra/*` workspace dependencies a package declares. */
function workspaceDeps(pkg: PackageJson): Array<{ name: string; pkg: PackageJson }> {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const out: Array<{ name: string; pkg: PackageJson }> = [];
  for (const [name, spec] of Object.entries(all)) {
    if (!name.startsWith("@proovra/") || !String(spec).startsWith("workspace:")) continue;
    const manifest = resolve(packageDir(name), "package.json");
    assert.ok(existsSync(manifest), `workspace dep ${name} has no package at ${packageDir(name)}`);
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

/** The dist-exporting workspace deps of one consumer, by name. */
function distDeps(pkg: PackageJson): string[] {
  return workspaceDeps(pkg)
    .filter(({ pkg: dep }) => exportsGeneratedDist(dep))
    .map(({ name }) => name);
}

test("every consumer of generated dist output declares a build:deps chain that covers it", () => {
  const problems: string[] = [];
  for (const dir of CONSUMERS) {
    const pkg = read(`${dir}/package.json`);
    const needed = distDeps(pkg);
    if (needed.length === 0) continue;
    const chain = pkg.scripts?.["build:deps"] ?? "";
    if (chain.length === 0) {
      problems.push(`${dir}: consumes ${needed.join(", ")} but declares no build:deps`);
      continue;
    }
    const missing = needed.filter((n) => !chain.includes(`--filter ${n} build`));
    if (missing.length > 0) {
      problems.push(`${dir}: build:deps omits ${missing.join(", ")}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `a clean checkout cannot resolve what nothing builds:\n${problems.join("\n")}`,
  );
});

test("build:deps orders a dependency before the package that consumes it", () => {
  // `@proovra/shared-runtime` imports `@proovra/shared`. Building it first
  // compiles against a `dist/` that does not exist yet, and the failure reads
  // as a missing module rather than as a chain ordered backwards.
  const problems: string[] = [];
  for (const dir of CONSUMERS) {
    const pkg = read(`${dir}/package.json`);
    const chain = pkg.scripts?.["build:deps"] ?? "";
    if (!chain) continue;
    const order = distDeps(pkg)
      .map((name) => ({ name, at: chain.indexOf(`--filter ${name} build`) }))
      .filter((e) => e.at >= 0);
    for (const entry of order) {
      const depPkg = read(
        `packages/${entry.name.replace("@proovra/", "")}/package.json`,
      );
      for (const inner of distDeps(depPkg)) {
        const innerAt = chain.indexOf(`--filter ${inner} build`);
        if (innerAt < 0) {
          problems.push(`${dir}: ${entry.name} needs ${inner}, absent from the chain`);
        } else if (innerAt > entry.at) {
          problems.push(`${dir}: ${inner} is built AFTER ${entry.name}, which needs it`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("both prebuild AND pretypecheck delegate to that one chain", () => {
  // The hole this closes: `prebuild` existed and `pretypecheck` did not, so the
  // build path was reproducible and the typecheck path measured stale output.
  const problems: string[] = [];
  for (const dir of CONSUMERS) {
    const pkg = read(`${dir}/package.json`);
    if (distDeps(pkg).length === 0) continue;
    for (const hook of ["prebuild", "pretypecheck"] as const) {
      const gated = hook === "prebuild" ? pkg.scripts?.build : pkg.scripts?.typecheck;
      if (!gated) continue; // nothing to gate
      const script = pkg.scripts?.[hook] ?? "";
      if (!script.includes("build:deps")) {
        problems.push(
          `${dir}: has "${hook === "prebuild" ? "build" : "typecheck"}" but its ${hook} does not run build:deps`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("each dist-exporting workspace dep actually has a build script the chain can run", () => {
  for (const dir of CONSUMERS) {
    const pkg = read(`${dir}/package.json`);
    for (const { name, pkg: dep } of workspaceDeps(pkg)) {
      if (!exportsGeneratedDist(dep)) continue;
      assert.ok(
        typeof dep.scripts?.build === "string" && dep.scripts.build.length > 0,
        `${name} exports dist/ but has no build script — no chain can produce its output`,
      );
    }
  }
});

test("the root build:shared aggregate names every dist-exporting package", () => {
  // `build:api` and `build:worker` are `build:shared && …`. A dist-exporting
  // package missing from the aggregate is output nobody produces.
  const root = read("package.json");
  const aggregate = root.scripts?.["build:shared"] ?? "";
  assert.ok(aggregate.length > 0, "the root must define build:shared");

  const distPackages = CONSUMERS.filter((dir) => dir.startsWith("packages/"))
    .map((dir) => read(`${dir}/package.json`))
    .filter((pkg) => exportsGeneratedDist(pkg))
    .map((pkg) => pkg.name as string);

  const missing = distPackages.filter((n) => !aggregate.includes(`--filter ${n} build`));
  assert.deepEqual(
    missing,
    [],
    `build:shared omits ${missing.join(", ")} — build:api/build:worker would ride on output nobody produced`,
  );
});

test("apps/web still carries the original web-build contract", () => {
  // Kept as its own case so broadening the contract cannot quietly drop the
  // assertion the Vercel failure originally bought.
  const chain = webPkg.scripts?.["build:deps"] ?? "";
  for (const name of distDeps(webPkg)) {
    assert.ok(
      chain.includes(`--filter ${name} build`),
      `the web build graph must build ${name}`,
    );
  }
  assert.equal(webPkg.scripts?.prebuild, "pnpm run build:deps");
});

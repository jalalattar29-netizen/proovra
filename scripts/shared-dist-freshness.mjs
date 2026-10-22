/**
 * TESTS NEVER RUN AGAINST A STALE BUILD OF A SHARED PACKAGE.
 *
 * The services and apps import `@proovra/shared` (and its siblings) through
 * each package's compiled `dist/`, not its TypeScript source. A source edit
 * that was not rebuilt is therefore invisible to every test that imports the
 * package: the suite passes against code that no longer exists, and a fix (or a
 * regression) in a shared authority is never exercised.
 *
 * (F-14 closure, 2026-10-22) This guard closes that hole. Every `src/**\/*.ts`
 * file of a guarded package must have its compiled counterpart in `dist/`, and
 * must not be NEWER than it: the build compiles without `incremental`, so a
 * build rewrites every output and a source edited after it is caught here.
 * It compares files, so it holds for CI, for a mutation runner that rebuilds a
 * package between mutants, and for a local working copy alike.
 *
 * Registered as a vitest `globalSetup` (the API unit and integration projects
 * and the worker project), so a stale build fails the run before any test.
 * Usable directly: `node scripts/shared-dist-freshness.mjs` exits 1 and names
 * the stale files.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The packages consumed through `dist/` by the API, worker and web tests. */
export const GUARDED_PACKAGES = ["shared", "shared-runtime", "shared-evidence-presentation", "shared-billing"];

/** Filesystem timestamps can differ by a rounding step between a write and a stat. */
const SLACK_MS = 2000;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * The stale or missing compiled files of one package: [{ source, reason }].
 * `packageDir` is the package root (holding src/ and dist/).
 */
export function staleDistFiles(packageDir) {
  const src = join(packageDir, "src");
  const dist = join(packageDir, "dist");
  if (!existsSync(src)) return [];
  if (!existsSync(dist)) return [{ source: relative(REPO, src), reason: "dist/ is missing — the package was never built" }];
  const stale = [];
  for (const file of walk(src)) {
    if (!/\.tsx?$/.test(file) || /\.d\.ts$/.test(file)) continue;
    const rel = relative(src, file).replace(/\.tsx?$/, ".js");
    const out = join(dist, rel);
    if (!existsSync(out)) {
      stale.push({ source: relative(REPO, file), reason: "no compiled counterpart in dist/" });
      continue;
    }
    if (statSync(file).mtimeMs > statSync(out).mtimeMs + SLACK_MS) {
      stale.push({ source: relative(REPO, file), reason: "edited after the last build" });
    }
  }
  return stale;
}

export function assertSharedDistFresh(packagesRoot = join(REPO, "packages"), packages = GUARDED_PACKAGES) {
  const problems = packages.flatMap((p) => staleDistFiles(join(packagesRoot, p)).map((s) => ({ pkg: p, ...s })));
  if (problems.length === 0) return;
  const list = problems.slice(0, 20).map((p) => `  @proovra/${p.pkg}: ${p.source} — ${p.reason}`).join("\n");
  throw new Error(
    `STALE_SHARED_DIST: the tests would import compiled code older than its source.\n${list}` +
      (problems.length > 20 ? `\n  …and ${problems.length - 20} more` : "") +
      "\nRun `pnpm run build:shared` (with any DATABASE_URL set) and run the tests again.",
  );
}

/** vitest globalSetup entry. */
export default function setup() {
  assertSharedDistFresh();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertSharedDistFresh();
    console.log("shared dist: fresh");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

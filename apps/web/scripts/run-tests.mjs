import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const testsRoot = join(appRoot, "__tests__");
const filters = process.argv
  .slice(2)
  .filter((value) => value !== "--")
  .map((value) => value.toLowerCase());

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    // .test.mjs COUNTS TOO.
    //
    // This collected only .test.ts, so four .test.mjs files sat in __tests__
    // passing when run by hand and never once running as a gate — including
    // one added two sessions earlier that everybody, including its author,
    // believed was protecting the KMS redaction.
    //
    // A test that is not collected is not a test. Widening the filter is the
    // fix; renaming the files would have worked once and left the next .mjs
    // test in exactly the same silent hole.
    if (/\.test\.(ts|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function findTsxLoader() {
  const pnpmRoot = join(workspaceRoot, "node_modules", ".pnpm");
  const match = readdirSync(pnpmRoot)
    .filter((name) => name.startsWith("tsx@"))
    .sort()
    .pop();

  if (!match) {
    throw new Error("Unable to locate tsx in node_modules/.pnpm");
  }

  const loaderPath = join(
    pnpmRoot,
    match,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );

  if (!statSync(loaderPath).isFile()) {
    throw new Error(`TSX loader not found at ${loaderPath}`);
  }

  return pathToFileURL(loaderPath).href;
}

const testFiles = walk(testsRoot).filter((file) => {
  if (filters.length === 0) return true;
  const haystack = file.toLowerCase();
  return filters.every((filter) => haystack.includes(filter));
});

/*
 * WHICH HARNESSES THIS RUN COVERS.
 *
 * Decided BEFORE the "nothing matched" guard below, because `render` on its own
 * matches no `.test.ts` file and would otherwise be rejected as a typo.
 */
const renderFilters = filters.filter((f) => f !== "render");
const runRender = filters.length === 0 || filters.some((f) => f.includes("render"));

if (testFiles.length === 0 && !runRender) {
  console.error(
    `No apps/web tests matched filters: ${filters.length ? filters.join(", ") : "(none)"}`,
  );
  process.exit(1);
}

if (testFiles.length > 0) {
  const loaderUrl = findTsxLoader();
  const result = spawnSync(
    process.execPath,
    ["--import", loaderUrl, "--test", ...testFiles],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
    },
  );
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

/*
 * THE RENDER SUITE RUNS HERE TOO, AND UNTIL NOW IT RAN NOWHERE.
 *
 * `walk` collects `.test.ts` and `.test.mjs`. The 50 files under
 * `__tests__/render/` are `.render.test.tsx` and need jsdom plus the React
 * plugin, so they have their own vitest config and their own script,
 * `test:render` — which was referenced by NO workflow, NO aggregate script and
 * nothing else in the repository. 1,099 render tests, invoked only when
 * somebody remembered the command.
 *
 * That is the same hole this file already documents one screen above, for the
 * four `.test.mjs` files that "sat in __tests__ passing when run by hand and
 * never once running as a gate". It cost something real: `artifactStatus`
 * gained the canonical `outputs` projection on 2026-09-08, the Evidence Detail
 * convergence fixture was not updated with it, and all 39 of that file's cases
 * had been throwing ever since with nothing to notice.
 *
 * `pnpm --filter proovra-web test` is the "Test — web" step in ci.yml, so
 * delegating here is what makes the render suite a gate. It is a separate
 * process because the two harnesses cannot share one: node:test with a tsx
 * loader, and vitest with jsdom.
 *
 * FILTERS ARE HONOURED. A filtered run is somebody narrowing to one suite, and
 * running 1,099 unrelated render tests after it would defeat the narrowing —
 * so the render pass is skipped unless the filter also matches render files,
 * in which case it is forwarded as vitest's own name filter.
 */
if (runRender) {
  /*
   * `node <vitest entry>`, not `pnpm exec vitest`.
   *
   * Same reasoning as `findTsxLoader` above: resolving the module and handing
   * it to THIS node is one dependency (the package must be installed), whereas
   * shelling out adds two more — a `pnpm` on PATH and, on Windows, a shell to
   * find its `.CMD` shim. This step is the "Test — web" gate on Linux CI and a
   * developer's Windows terminal, and it should not be able to fail
   * differently on the two for a reason that has nothing to do with the tests.
   */
  const vitestEntry = resolve(
    dirname(
      createRequire(import.meta.url).resolve("vitest/package.json", {
        paths: [appRoot],
      }),
    ),
    "vitest.mjs",
  );
  const render = spawnSync(
    process.execPath,
    [
      vitestEntry,
      "run",
      "--config",
      "vitest.render.config.ts",
      "--reporter=dot",
      ...renderFilters,
    ],
    { cwd: appRoot, stdio: "inherit" },
  );
  if ((render.status ?? 1) !== 0) process.exit(render.status ?? 1);
}

process.exit(0);

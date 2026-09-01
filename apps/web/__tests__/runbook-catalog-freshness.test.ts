/**
 * THE RUNBOOK CATALOG — FRESHNESS, REACHABILITY, AND THE RENDERER.
 *
 * ===========================================================================
 * THE THREE THINGS THAT CAN GO WRONG
 * ===========================================================================
 * 1. THE CONSOLE SHOWS A STALE PROCEDURE. `docs/runbooks/*.md` is the
 *    authority; `catalog.generated.ts` is a build of it. If the two diverge,
 *    an operator reads a corrected runbook in the repository and a superseded
 *    one in the product, and does not know which. That is worse than having no
 *    reader at all, and it is the entire cost of generating rather than
 *    reading at request time — so it is gated here.
 *
 * 2. A LINK GOES NOWHERE. The reader sets `dynamicParams = false`, so an
 *    unknown slug is a hard 404. Most `runbookSlug` values in this codebase
 *    are condition labels with no document behind them (23 of 29 at the time
 *    of writing), so every surface that renders a runbook link must check the
 *    slug first. This asserts they do, and asserts the slugs the platform
 *    itself emits into a link resolve.
 *
 * 3. THE RENDERER SWALLOWS A STEP. A markdown construct the renderer does not
 *    understand must fall through as text, never vanish. A runbook step that
 *    silently disappears is the failure nobody notices until it matters.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(APP_ROOT, "..", "..");
const RUNBOOK_DIR = join(REPO_ROOT, "docs", "runbooks");
const read = (rel: string): string =>
  readFileSync(resolve(APP_ROOT, rel), "utf8");

// ===========================================================================
// 1 — freshness
// ===========================================================================

/**
 * The generator is a plain `.mjs` build script with no type declarations, and
 * writing a `.d.ts` for a file only this test imports would be ceremony. The
 * shape is asserted immediately below by using it.
 */
type CatalogGenerator = {
  buildCatalog: () => Array<{ slug: string; body: string }>;
  renderModule: (entries: unknown) => string;
  renderSlugModule: (entries: unknown) => string;
};

test("the generated catalog is current against docs/runbooks", async () => {
  const gen = (await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error — untyped build script, shaped by CatalogGenerator above
    "../scripts/generate-runbook-catalog.mjs"
  )) as CatalogGenerator;
  const entries = gen.buildCatalog();

  const expectedCatalog = gen.renderModule(entries);
  const actualCatalog = read("lib/runbooks/catalog.generated.ts").replace(
    /\r\n/g,
    "\n",
  );
  assert.equal(
    actualCatalog,
    expectedCatalog,
    "lib/runbooks/catalog.generated.ts is STALE — the console would show a " +
      "different procedure than the repository. Run: node apps/web/scripts/generate-runbook-catalog.mjs",
  );

  const expectedSlugs = gen.renderSlugModule(entries);
  const actualSlugs = read("lib/runbooks/slugs.generated.ts").replace(
    /\r\n/g,
    "\n",
  );
  assert.equal(
    actualSlugs,
    expectedSlugs,
    "lib/runbooks/slugs.generated.ts is STALE — link guards would disagree " +
      "with the reader about which slugs exist.",
  );
});

test("every markdown file is in the catalog, and vice versa", async () => {
  const { RUNBOOKS } = await import("../lib/runbooks/catalog.generated");
  const onDisk = readdirSync(RUNBOOK_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const inCatalog = RUNBOOKS.map((r) => r.slug).sort();

  // A runbook missing from the catalog is invisible in the product. A catalog
  // entry with no file renders a menu item that 404s.
  assert.deepEqual(inCatalog, onDisk);
});

test("the body in the catalog is byte-identical to the markdown", async () => {
  const { RUNBOOKS } = await import("../lib/runbooks/catalog.generated");
  for (const r of RUNBOOKS) {
    const onDisk = readFileSync(join(RUNBOOK_DIR, `${r.slug}.md`), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    assert.equal(
      r.body,
      onDisk,
      `${r.slug}: the catalog body differs from the markdown — the reader is ` +
        `not showing the repository's text`,
    );
  }
});

test("the two generated modules agree on which slugs exist", async () => {
  const { RUNBOOKS } = await import("../lib/runbooks/catalog.generated");
  const { RUNBOOK_SLUGS } = await import("../lib/runbooks/slugs.generated");
  assert.deepEqual(
    [...RUNBOOK_SLUGS].sort(),
    RUNBOOKS.map((r) => r.slug).sort(),
  );
});

test("the slug module stays small enough to import into a client bundle", () => {
  // The point of splitting it. If it starts carrying bodies again, every
  // surface that guards a link pulls 125 KB of markdown into the client.
  const bytes = read("lib/runbooks/slugs.generated.ts").length;
  assert.ok(
    bytes < 8_000,
    `slugs.generated.ts is ${bytes} bytes — it should hold slugs only`,
  );
});

test("every catalog entry has a title and a summary", async () => {
  const { RUNBOOKS } = await import("../lib/runbooks/catalog.generated");
  for (const r of RUNBOOKS) {
    assert.ok(r.title.length > 0, `${r.slug} has no title`);
    assert.ok(r.summary.length > 0, `${r.slug} has no summary`);
    // A summary that still carries markdown punctuation was not parsed, it
    // was copied.
    assert.doesNotMatch(r.summary, /^[-*>#|]/, `${r.slug}: raw markdown in summary`);
  }
});

// ===========================================================================
// 2 — reachability
// ===========================================================================

test("the reader route exists and 404s an unknown slug", () => {
  const src = read("app/(app)/admin/platform/runbooks/[slug]/page.tsx");
  assert.match(src, /export const dynamicParams = false/);
  assert.match(src, /generateStaticParams/);
  // A dynamic page under the (app) layout streams a 200 before notFound()
  // can change it, so the params must be closed rather than checked at
  // runtime.
  assert.match(src, /notFound\(\)/);
  assert.match(src, /PageRouteGate routeId="platform\.runbooks"/);
});

test("no surface links a runbook slug without checking it resolves", () => {
  // `dynamicParams = false` means an unchecked link is a 404 mid-incident.
  const linkers = [
    "components/command-center/CommandCenter.tsx",
    "components/governance-experience/GovernanceControlPlane.tsx",
    "app/(app)/admin/operations/page.tsx",
  ];
  for (const rel of linkers) {
    const src = read(rel);
    assert.match(
      src,
      /hasRunbook\(/,
      `${rel} builds a runbook href without calling hasRunbook`,
    );
    assert.match(
      src,
      /from "(\.\.\/)+lib\/runbooks\/slugs\.generated"/,
      `${rel} must import the slug-only module, not the full catalog`,
    );
    // The full catalog carries every body; importing it here would put the
    // whole corpus in the client bundle.
    assert.doesNotMatch(
      src,
      /catalog\.generated/,
      `${rel} imports the full catalog into a client component`,
    );
  }
});

test("no surface links the old fragment or the route that never existed", () => {
  const roots = ["app", "components", "lib"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name)) {
        const src = readFileSync(p, "utf8");
        // `/admin/platform/runbooks#<slug>` pointed at an anchor the catalog
        // never rendered; `/admin/runbooks/...` is not a route at all.
        if (/\/admin\/platform\/runbooks#\$\{/.test(src)) {
          offenders.push(`${p} (fragment link to a non-existent anchor)`);
        }
        if (/["'`]\/admin\/runbooks\//.test(src)) {
          offenders.push(`${p} (/admin/runbooks/ is not a route)`);
        }
      }
    }
  };
  for (const r of roots) walk(resolve(APP_ROOT, r));
  assert.deepEqual(offenders, []);
});

test("the catalog page links each runbook by path, not by fragment", () => {
  const src = read("app/(app)/admin/platform/runbooks/page.tsx");
  assert.match(src, /\/admin\/platform\/runbooks\/\$\{r\.slug\}/);
  // The sentence that described the old failure must be gone with it.
  assert.doesNotMatch(
    src,
    /full markdown text lives in the repository/,
    "the catalog must no longer tell the operator to go read the repository",
  );
});

// ===========================================================================
// 3 — the renderer
// ===========================================================================

test("the renderer produces React elements, never HTML", () => {
  // Comments stripped: this file DISCUSSES dangerouslySetInnerHTML in its
  // header, explaining why it does not use one. An assertion that cannot tell
  // an explanation from a call is an assertion that forbids writing the
  // explanation down.
  const src = read("lib/runbooks/render.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  // No HTML pipeline means no sanitiser to get wrong.
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(src, /innerHTML/);
});

test("the renderer covers every construct the corpus actually uses", () => {
  const src = read("lib/runbooks/render.tsx");
  for (const [construct, pattern] of [
    ["fenced code", /startsWith\("```"\)/],
    ["tables", /rb-table/],
    ["blockquotes", /rb-quote/],
    ["ordered lists", /rb-ol/],
    ["unordered lists", /rb-ul/],
    ["horizontal rules", /rb-hr/],
    ["headings", /rb-h\$\{depth\}|rb-h2/],
  ] as const) {
    assert.match(src, pattern, `the renderer does not handle ${construct}`);
  }
});

test("the renderer cannot loop forever on an unrecognised line", () => {
  const src = read("lib/runbooks/render.tsx");
  // A block loop that consumes nothing and does not advance is a hung tab,
  // which presents as a broken machine rather than a broken page.
  assert.match(
    src,
    /Advance rather than loop[\s\S]{0,120}i \+= 1;/,
    "the paragraph fallback must advance when it consumes nothing",
  );
});

test("a cross-reference between runbooks resolves to the reader", () => {
  const src = read("lib/runbooks/render.tsx");
  // The corpus links siblings as `./other.md`, which means nothing in a
  // browser. The TSA runbook points at OTS and at report generation
  // specifically so a reader does not reason from one to the other — those
  // links have to work.
  assert.match(src, /\\\.md/, "relative .md links must be rewritten");
  assert.match(src, /\/admin\/platform\/runbooks\/\$\{runbook\[1\]\}/);
});

test("an external link opens in a new tab and cannot reach back", () => {
  const src = read("lib/runbooks/render.tsx");
  assert.match(src, /target="_blank"/);
  assert.match(src, /rel="noopener noreferrer"/);
});

test("code and tables scroll inside themselves", () => {
  const css = read("app/(app)/admin/platform/runbooks/runbooks.css");
  // The page body must never scroll horizontally.
  assert.match(css, /\.rb-pre[\s\S]{0,300}overflow-x: auto/);
  assert.match(css, /\.rb-table-wrap[\s\S]{0,120}overflow-x: auto/);
});

test("the reader is RTL-safe", () => {
  const css = read("app/(app)/admin/platform/runbooks/runbooks.css");
  // Logical properties, so lists and the quote rule move to the correct side.
  assert.match(css, /padding-inline-start/);
  assert.match(css, /border-inline-start/);
  assert.match(css, /text-align: start/);
  // Code stays LTR inside RTL prose — a shell command mirrored is a shell
  // command that cannot be copied.
  assert.match(css, /unicode-bidi: isolate/);
});

test("the stylesheet uses tokens, not raw colour literals", () => {
  const css = read("app/(app)/admin/platform/runbooks/runbooks.css");
  // Every hex must be a fallback inside a var(), never a bare declaration.
  const bare = css
    .split("\n")
    .filter((l) => /#[0-9a-f]{3,8}\b/i.test(l) && !/var\(--/.test(l));
  assert.deepEqual(bare, [], "raw colour literals outside a var() fallback");
});

// ===========================================================================
// The TSA runbook, which the evidence-health cohorts link.
// ===========================================================================

test("the TSA runbook exists and states the no-retry position", () => {
  const md = readFileSync(join(RUNBOOK_DIR, "tsa-timestamp-failure.md"), "utf8");
  // The cohort tiles link here to explain why they refuse a retry. If this
  // document ever softens that, the tile and the runbook disagree about
  // whether an operator may act.
  assert.match(md, /There is no retry/i);
  assert.match(md, /genTime/);
  assert.match(md, /NO_SAFE_REMEDIATION_AUTHORITY/);
  assert.match(md, /Do not add a TSA retry job, queue or route/i);
  // And it must not describe affected records as invalid.
  assert.match(md, /remains valid evidence/i);
});

test("the docs/runbooks README index lists every runbook", () => {
  // This table had drifted to 23 of 31 files, so eight runbooks existed and
  // were listed nowhere. A second hand-maintained list always drifts; gating
  // it is cheaper than noticing.
  const readme = readFileSync(join(RUNBOOK_DIR, "README.md"), "utf8");
  const indexed = [...readme.matchAll(/^\| \[([a-z0-9-]+)\]/gm)]
    .map((m) => m[1])
    .sort();
  const onDisk = readdirSync(RUNBOOK_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  assert.deepEqual(indexed, onDisk);
});

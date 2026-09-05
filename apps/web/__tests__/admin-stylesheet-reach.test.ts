/**
 * A PAGE THAT USES A CLASS FAMILY MUST LOAD THE STYLESHEET THAT DEFINES IT.
 *
 * ===========================================================================
 * WHAT THIS CAUGHT
 * ===========================================================================
 * `/admin/platform/observability` used the `apf-*` classes throughout — its
 * own comments say "See `.apf-tile` in admin-platform.css for what each tone
 * means" — and was the one page of the ten under `/admin/platform` that never
 * imported that file. In Next's App Router a CSS import belongs to the route
 * that declares it, so every `apf-*` element on the page resolved to nothing:
 * the six summary tiles measured 0px border, transparent background and 0
 * padding, and the platform's alert rollup rendered as bare stacked text
 * outside any surface while every section around it sat in a card.
 *
 * That is invisible to a typecheck, to eslint, and to a screenshot of any
 * OTHER page. It is visible here in milliseconds.
 *
 * ===========================================================================
 * WHY A SOURCE TEST AND NOT ONLY THE BROWSER PROBE
 * ===========================================================================
 * `scripts/admin-ledger/visual/composition.mjs` does catch a missing
 * stylesheet — it appends a probe element and reads its computed border — but
 * it needs a running fixture, and it probes ONE family per route. This asks
 * the cheaper and broader question of every admin page at once, with no
 * server, and it is the check that fails in CI.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");

const ADMIN = resolve(WEB, "app/(app)/admin");

/**
 * Class prefix -> the stylesheet that defines it, relative to the repo's
 * `apps/web`. A page using the prefix must import that file, or inherit it
 * from a layout above it.
 */
const FAMILIES: Array<{
  prefix: string;
  sheet: string;
  /** Loaded by a layout, so any page beneath it already has it. */
  viaLayout?: string;
}> = [
  {
    prefix: "apf-",
    sheet: resolve(WEB, "app/(app)/admin/platform/admin-platform.css"),
  },
  {
    prefix: "adm-",
    sheet: resolve(WEB, "app/(app)/admin/admin-system.css"),
    // admin/layout.tsx imports it for the whole console.
    viaLayout: ADMIN,
  },
  {
    prefix: "rb-",
    sheet: resolve(WEB, "app/(app)/admin/platform/runbooks/runbooks.css"),
  },
];

/**
 * ROUTES, NOT COMPONENTS.
 *
 * In the App Router a CSS import belongs to the ROUTE that declares it, and it
 * then applies to everything that route renders. So a component using `rb-*`
 * is styled as long as every page rendering it loads `runbooks.css` — which
 * `_RunbookCatalogNav` and `_RunbookLayout` are, by both runbook pages.
 * Requiring the import at the component would be asking for a duplicate.
 *
 * The unit of ownership is therefore `page.tsx` / `layout.tsx`, and that is
 * exactly the level at which the observability defect existed.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^(page|layout)\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Does `file`, or a layout above it, import `sheet`? */
function reaches(file: string, sheet: string, viaLayout?: string): boolean {
  const sheetAbs = sheet;

  const importsSheet = (candidate: string): boolean => {
    let src: string;
    try {
      src = readFileSync(candidate, "utf8");
    } catch {
      return false;
    }
    for (const m of src.matchAll(/import\s+"([^"]+\.css)"/g)) {
      if (resolve(dirname(candidate), m[1]) === sheetAbs) return true;
    }
    return false;
  };

  if (importsSheet(file)) return true;

  // Walk up to the family's layout root, checking each layout.tsx.
  let dir = dirname(file);
  const stop = viaLayout ?? ADMIN;
  for (;;) {
    const layout = join(dir, "layout.tsx");
    try {
      statSync(layout);
      if (importsSheet(layout)) return true;
    } catch {
      /* no layout at this level */
    }
    if (resolve(dir) === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

const files = walk(ADMIN);

test("the admin page set is found", () => {
  assert.ok(
    files.length > 40,
    `expected 40+ admin route files, found ${files.length}`,
  );
});

for (const family of FAMILIES) {
  test(`${family.prefix}* classes resolve on every page that uses them`, () => {
    const offenders: string[] = [];
    const re = new RegExp(`["'\\s]${family.prefix}[a-z0-9-]+`);

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Only look at what the page RENDERS: a prefix inside a comment is
      // documentation, and this test's whole point is that a comment
      // referencing a stylesheet is not the same as loading it.
      const rendered = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (!re.test(rendered)) continue;
      if (!reaches(file, family.sheet, family.viaLayout)) {
        offenders.push(relative(WEB, file).split("\\").join("/"));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these pages use ${family.prefix}* but neither they nor a layout above ` +
        `them import ${relative(WEB, family.sheet).split("\\").join("/")}, ` +
        `so those classes resolve to nothing:\n${offenders.join("\n")}`,
    );
  });
}

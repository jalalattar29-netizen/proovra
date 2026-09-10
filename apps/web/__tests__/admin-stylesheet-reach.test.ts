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
 * the cheaper and broader question of every administrative page at once, with
 * no server, and it is the check that fails in CI.
 *
 * ===========================================================================
 * PV-PLACE-001 — THE ADMINISTRATIVE PAGES THAT LEFT /admin
 * ===========================================================================
 * Owner decision PV-OD-001 moved eleven workspace-administration pages out of
 * /admin to their tenant homes (Security Center, Operations). They kept the
 * administrative visual system, which now loads through ONE component —
 * `components/admin/AdminVisualSystem.tsx` imports `admin-system.css` and
 * `admin-console.css` — rendered by admin/layout.tsx and by each moved
 * route's own layout or page. So:
 *
 *   * the scanned set is /admin PLUS those roots, so a moved page that loses
 *     its stylesheet fails here exactly as it would have under /admin;
 *   * a page or layout "loads" a sheet when it imports it directly OR imports
 *     a local module that does. In the App Router a stylesheet imported by a
 *     module the route imports belongs to that route — which is precisely how
 *     the shared component delivers it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");

const APP = resolve(WEB, "app/(app)");
const ADMIN = resolve(APP, "admin");

/** Every root that renders the administrative visual system. */
const ROOTS = [
  ADMIN,
  resolve(APP, "security-center/identity"),
  resolve(APP, "security-center/posture"),
  resolve(APP, "security-center/sso"),
  resolve(APP, "operations/analytics"),
  resolve(APP, "operations/automation"),
  resolve(APP, "operations/reliability"),
];

/**
 * Class prefix -> the stylesheet that defines it, relative to the repo's
 * `apps/web`. A page using the prefix must import that file, or inherit it
 * from a layout above it within its root.
 */
const FAMILIES: Array<{ prefix: string; sheet: string }> = [
  {
    prefix: "apf-",
    sheet: resolve(WEB, "app/(app)/admin/platform/admin-platform.css"),
  },
  {
    // Delivered by AdminVisualSystem, which admin/layout.tsx and every moved
    // root renders.
    prefix: "adm-",
    sheet: resolve(WEB, "app/(app)/admin/admin-system.css"),
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

function read(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Does this module import `sheet` itself? */
function importsSheetDirectly(file: string, sheet: string): boolean {
  const src = read(file);
  if (src === null) return false;
  for (const m of src.matchAll(/import\s+"([^"]+\.css)"/g)) {
    if (resolve(dirname(file), m[1]) === sheet) return true;
  }
  return false;
}

/** A relative module specifier resolved to the .tsx/.ts file it names. */
function resolveModule(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Does this route file load `sheet` — directly, or through a local module it
 * imports that imports the sheet? One level, deliberately: that is the shape
 * of the shared AdminVisualSystem delivery, and a deeper chain would be a
 * stylesheet hidden where no reviewer looks for it.
 */
function loadsSheet(file: string, sheet: string): boolean {
  if (importsSheetDirectly(file, sheet)) return true;
  const src = read(file);
  if (src === null) return false;
  for (const m of src.matchAll(/import\s+[^"']*?from\s+"(\.{1,2}\/[^"]+)"/g)) {
    const mod = resolveModule(file, m[1]);
    if (mod && importsSheetDirectly(mod, sheet)) return true;
  }
  return false;
}

function rootOf(file: string): string {
  const root = ROOTS.find((r) => file === r || file.startsWith(r + "\\") || file.startsWith(r + "/"));
  if (!root) throw new Error(`no scanned root contains ${file}`);
  return root;
}

/** Does `file`, or a layout above it within its root, load `sheet`? */
function reaches(file: string, sheet: string): boolean {
  if (loadsSheet(file, sheet)) return true;

  // Walk up to the file's root, checking each layout.tsx.
  let dir = dirname(file);
  const stop = rootOf(file);
  for (;;) {
    const layout = join(dir, "layout.tsx");
    try {
      statSync(layout);
      if (loadsSheet(layout, sheet)) return true;
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

const files = ROOTS.flatMap((root) => walk(root));

test("the administrative page set is found", () => {
  assert.ok(
    files.length > 40,
    `expected 40+ administrative route files, found ${files.length}`,
  );
  // Every moved root is actually scanned — a typo in ROOTS must not quietly
  // shrink the set back to /admin.
  for (const root of ROOTS) {
    assert.ok(
      files.some((f) => f.startsWith(root)),
      `no page or layout found under ${relative(WEB, root)}`,
    );
  }
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
      if (!reaches(file, family.sheet)) {
        offenders.push(relative(WEB, file).split("\\").join("/"));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these pages use ${family.prefix}* but neither they nor a layout above ` +
        `them load ${relative(WEB, family.sheet).split("\\").join("/")}, ` +
        `so those classes resolve to nothing:\n${offenders.join("\n")}`,
    );
  });
}

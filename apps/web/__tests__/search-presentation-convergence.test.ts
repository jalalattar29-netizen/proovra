/**
 * REDESIGN/SEARCH — the convergence guard.
 *
 * The Search console used to describe itself with sixty `React.CSSProperties`
 * objects and a private palette of literal colours. Deleting them once is not
 * the same as keeping them deleted: the previous four migrations of this
 * surface each left a residue that the next one had to find by reading three
 * thousand lines. This file makes the end state assertable.
 *
 * It measures the console — `app/(app)/search/**` plus `components/search/**`,
 * the panel that only this route renders — against six properties:
 *
 *   1. no presentation objects and no presentation `style={…}` sites,
 *   2. no private colour palette; colour comes from tokens and primitives,
 *   3. no legacy Card / Button / Badge consumers and no native `<select>`,
 *   4. every selector in `search.css` has a real consumer,
 *   5. every `app-*` class the console names actually exists,
 *   6. one Search implementation, and the three foundation files are all
 *      genuinely mounted rather than merely present.
 *
 * Source-text assertions, like the rest of this directory's contracts.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const WEB = resolve(REPO_ROOT, "apps/web");
const ROUTE = resolve(WEB, "app/(app)/search");
const PANEL_DIR = resolve(WEB, "components/search");
const CSS_PATH = join(ROUTE, "search.css");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every TS/TSX file the Search console is built from. */
const CONSOLE_FILES = [
  ...walk(ROUTE, /\.tsx?$/),
  ...walk(PANEL_DIR, /\.tsx?$/),
];
const CONSOLE_SOURCE = CONSOLE_FILES.map(read).join("\n");

/** A file's text with block and line comments removed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function relative(p: string): string {
  return p.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
}

// ===========================================================================
// 1. No presentation objects, no presentation style props
// ===========================================================================

test("the Search console declares no React.CSSProperties objects", () => {
  const offenders = CONSOLE_FILES.filter((f) =>
    /React\.CSSProperties/.test(stripComments(read(f))),
  ).map(relative);
  assert.deepEqual(
    offenders,
    [],
    "presentation belongs in search.css or the app-* primitives",
  );
});

test("the Search console carries no inline style props", () => {
  const offenders = CONSOLE_FILES.filter((f) =>
    /\sstyle=\{/.test(stripComments(read(f))),
  ).map(relative);
  assert.deepEqual(offenders, [], "no style={…} site may survive");
});

// ===========================================================================
// 2. No private palette
// ===========================================================================

test("the Search console names no literal colours", () => {
  // A hex triplet/quad or an rgba() in a component means a colour decided
  // outside the token system, which is how two surfaces drift apart.
  const offenders: string[] = [];
  for (const f of CONSOLE_FILES) {
    const src = stripComments(read(f));
    if (/#[0-9a-fA-F]{3,8}\b/.test(src) || /\brgba?\(/.test(src)) {
      offenders.push(relative(f));
    }
  }
  assert.deepEqual(offenders, [], "colour comes from tokens, not call sites");
});

// ===========================================================================
// 3. No legacy primitives, no native select
// ===========================================================================

test("the Search console consumes no legacy Card / Button / Badge", () => {
  const offenders = CONSOLE_FILES.filter((f) =>
    /from "[^"]*components\/ui\/(Card|Button|Badge)"/.test(read(f)),
  ).map(relative);
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(
    stripComments(CONSOLE_SOURCE),
    /<(Card|Button|Badge)[\s/>]/,
    "the canonical app-* primitives are the only ones this console uses",
  );
});

test("the Search console renders no native <select>", () => {
  // A native select renders the OS popup: it cannot be styled, and it cannot
  // be audited for keyboard behaviour. AppListbox is the one option control.
  assert.doesNotMatch(stripComments(CONSOLE_SOURCE), /<select[\s/>]/);
  assert.match(CONSOLE_SOURCE, /<AppListbox\b/);
});

// ===========================================================================
// 4. Every selector in search.css has a consumer
// ===========================================================================

test("every search-* selector in search.css has a real consumer", () => {
  const css = read(CSS_PATH).replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (m[1].startsWith("search-")) declared.add(m[1]);
  }
  assert.ok(declared.size > 50, "the stylesheet should describe the console");

  // A dynamic family is a class assembled at runtime — `search-x--${variant}`.
  // Such a prefix documents the family; members of it count as consumed.
  const dynamicFamilies = [
    ...CONSOLE_SOURCE.matchAll(
      /["'`]([a-zA-Z0-9_ -]*search-[a-zA-Z0-9_-]*)\$\{/g,
    ),
  ].map((m) => m[1].trim());

  const orphans = [...declared]
    .filter((cls) => {
      if (new RegExp(`\\b${cls}\\b`).test(CONSOLE_SOURCE)) return false;
      return !dynamicFamilies.some((prefix) => cls.startsWith(prefix));
    })
    .sort();

  assert.deepEqual(
    orphans,
    [],
    "a selector nothing renders is dead presentation — delete it",
  );
});

// ===========================================================================
// 5. Every app-* class the console names exists
// ===========================================================================

test("every app-* class the Search console names is declared by the primitives", () => {
  const primitives = read(
    resolve(WEB, "components/app-primitives/app-primitives.css"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Set<string>();
  for (const m of primitives.matchAll(/\.([a-zA-Z0-9_-]+)/g)) declared.add(m[1]);

  const used = new Set<string>();
  for (const m of CONSOLE_SOURCE.matchAll(/className=\{?["'`]([^"'`]+)["'`]/g)) {
    for (const cls of m[1].split(/\s+/)) {
      // A template-literal head such as `app-tab${…}` contributes its stem.
      const stem = cls.split("$")[0];
      if (stem.startsWith("app-")) used.add(stem);
    }
  }
  const missing = [...used].filter((c) => !declared.has(c)).sort();
  assert.deepEqual(missing, [], "a class the primitives do not define is a typo");
});

// ===========================================================================
// 6. One implementation, and the foundation is genuinely mounted
// ===========================================================================

test("there is exactly one workspace Search console", () => {
  // `/admin/search` is a different surface — the platform-admin entity lookup,
  // behind the platform.admin route gate — not a second copy of this one.
  const consoles = CONSOLE_FILES.filter((f) => /page\.tsx$/.test(f));
  assert.equal(consoles.length, 1);
  assert.doesNotMatch(
    CONSOLE_SOURCE,
    /function PreviewDefault\(/,
    "the superseded right-rail preview must stay deleted",
  );
});

test("the three foundation files are actively consumed, not merely present", () => {
  const page = read(join(ROUTE, "page.tsx"));
  assert.match(page, /import "\.\/search\.css";/);

  // Every export of the two component files is mounted by the console. An
  // unmounted state component is a state the console cannot actually reach.
  for (const file of ["SearchStates.tsx", "SearchGuidance.tsx"]) {
    const src = read(join(ROUTE, "components", file));
    const exported = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]);
    assert.ok(exported.length > 0, `${file} must export something`);
    for (const name of exported) {
      assert.match(
        page,
        new RegExp(`<${name}[\\s/>]`),
        `${name} is exported by ${file} but never rendered`,
      );
    }
  }
});

test("each operational state is reachable from its own branch", () => {
  const page = read(join(ROUTE, "page.tsx"));
  // The distinctions the states exist to preserve: nothing-asked-yet is not a
  // zero result, a filtered miss is not an empty workspace, and a refusal is
  // not an outage.
  for (const kind of [
    "loading",
    "restricted",
    "error",
    "idle",
    "no-match-filtered",
    "empty-workspace",
    "empty-index",
    "partial-index",
    "no-match",
  ]) {
    assert.ok(
      page.includes(`data-search-empty-state-kind="${kind}"`),
      `no branch renders the ${kind} state`,
    );
  }
});

// ===========================================================================
// 7. What the visual pass found
// ===========================================================================

test("a failed search clears the selection", () => {
  // Found by driving the real console: a failure cleared the rows but left
  // the previously selected record's Inspector mounted, so a record sat open
  // beside "Search is temporarily unavailable" as though the results it came
  // from were still there.
  const page = read(join(ROUTE, "page.tsx"));
  assert.match(
    page,
    /setSearchFailure\(classifySearchFailure\(err\)\);[\s\S]{0,500}?setSelected\(null\);/,
  );
});

test("a failure is not reported as a count", () => {
  // Same pass: the results header went on printing "0 results" over the top
  // of an outage. A request that did not answer has no count to report, and
  // no filter summary to explain one.
  const page = read(join(ROUTE, "page.tsx"));
  assert.match(page, /searchFailure\s*\n?\s*\?\s*"No results to show"/);
  assert.match(
    page,
    /\{searchFailure \? null : <span>\{filterSummary\}<\/span>\}/,
  );
});

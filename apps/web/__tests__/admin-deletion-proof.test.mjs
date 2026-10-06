/**
 * THE LEGACY COLOUR MECHANISMS STAY DELETED.
 *
 * ===========================================================================
 * WHY THIS IS A TEST
 * ===========================================================================
 * The legacy colour system was DELETED rather than isolated: each mechanism
 * below had its consumers migrated to the canonical semantic tokens and was
 * then removed. A deletion is a claim about the whole tree, and it stops being
 * true the first time somebody re-adds the thing — silently, because a
 * re-added token WORKS.
 *
 * So each deletion is a PREDICATE over the current source, and this test
 * names the file and line that brought it back.
 *
 * ===========================================================================
 * WHAT COUNTS AS A CONSUMER
 * ===========================================================================
 * Source that RENDERS or IMPORTS the thing. Not a comment: every one of these
 * deletions is explained in a comment somewhere, and a checker that counted
 * prose would report the explanation as the offence. Comments are stripped
 * before any pattern is applied, and tests / e2e specs are excluded by path —
 * a guard naming the thing it forbids is the opposite of a regression.
 *
 * It already caught one: `--text-muted` had been deleted along with all sixty
 * of its consumers, and the console's own stylesheet still RE-DECLARED it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "../..");

/** Every source file that could hold a consumer. */
function sources() {
  const out = [];
  const skip = new Set([
    "node_modules",
    ".next",
    "dist",
    "coverage",
    "playwright-report",
    "test-results",
  ]);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|mjs|css)$/.test(e.name)) out.push(p);
    }
  };
  for (const root of ["app", "components", "lib"]) {
    const r = resolve(WEB, root);
    if (existsSync(r)) walk(r);
  }
  return out;
}

/**
 * Strip comments so an explanation is never read as a consumer.
 *
 * Deliberately crude: it can eat a `//` inside a string literal, which for
 * these patterns can only ever cause a FALSE PASS on a URL and never a false
 * failure. Every pattern below is a token name or an import specifier, and
 * none of them is a substring of a URL in this tree.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\*.*$/gm, "");
}

/** Paths whose whole job is to name a forbidden thing. */
const GUARDS = ["__tests__/", "e2e/"];

const files = sources()
  .map((p) => [relative(WEB, p).split("\\").join("/"), p])
  .filter(([rel]) => !GUARDS.some((g) => rel.includes(g)));

const cache = new Map();
function body(abs) {
  if (!cache.has(abs)) cache.set(abs, stripComments(readFileSync(abs, "utf8")));
  return cache.get(abs);
}

/**
 * THE DELETIONS.
 *
 * `what`   — the thing that no longer exists, and what replaced it.
 * `gone`   — a path that must not exist, when the deletion was a whole file.
 * `absent` — a regex that must match nothing in the rendered source.
 * `only`   — path prefixes the ban is scoped to (default: app, components, lib).
 */
const DELETIONS = [
  {
    what: "admin/identity/ui-tokens.ts — the console's parallel style objects and colour alias map (replaced by the canonical tokens)",
    gone: "apps/web/app/(app)/admin/identity/ui-tokens.ts",
    absent: /from\s+["'][^"']*identity\/ui-tokens["']/,
  },
  {
    what: "the TOKENS.* colour alias map — a second name for every colour",
    absent: /\bTOKENS\.[A-Za-z]/,
  },
  {
    what: "reviewer-ops/ui-tokens.ts — a second parallel raw-hex palette (replaced by the shared design system)",
    gone: "apps/web/app/(app)/reviewer-ops/ui-tokens.ts",
    absent: /from\s+["'][^"']*reviewer-ops\/ui-tokens["']/,
  },
  {
    what: "the raw-hex badge palettes (replaced by the canonical status and severity maps)",
    absent: /(slaBadgePalette|severityPalette|lifecycleBadgeStyle|slaBadgeStyle|severityBadgeStyle)\b/,
  },
  {
    what: "--text-muted and --text-strong (failed WCAG AA; consumers use --silver-ink / --ink-primary)",
    absent: /--text-(muted|strong)\b/,
  },
  {
    what: "duplicate --status-* declarations in app/globals.css (lib/design-tokens/tokens.css is the authority)",
    absent: /^\s*--status-[a-z]+-(bg|fg|border|solid):/m,
    only: ["app/globals.css"],
  },
  {
    what: "hex fallbacks inside var() at admin call sites — a second value for the same name",
    absent: /var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/,
    only: ["app/(app)/admin/"],
  },
  {
    what: "page-local INK_* and PALETTE aliases under /admin",
    absent: /\b(INK|PALETTE|COLORS|COLOURS)_[A-Z]+\s*=/,
    only: ["app/(app)/admin/"],
  },
  {
    what: "the cc-* class family — class names no stylesheet defines",
    absent: /["'\s]cc-[a-z][a-z0-9-]*/,
    only: ["app/(app)/admin/"],
  },
  {
    what: "admin-v2 files — no parallel v2 tree",
    absent: /admin-v2/,
  },
  {
    what: "hand-rolled status capsules under /admin (use Badge or AppStatusBadge)",
    absent: /borderRadius:\s*999[\s\S]{0,120}?background(Color)?:\s*["']#/,
    only: ["app/(app)/admin/"],
  },
];

test("the source scan reaches the web app", () => {
  // A walk that found nothing would pass every predicate below.
  assert.ok(files.length > 100, `only ${files.length} source files were scanned`);
  assert.ok(
    files.some(([rel]) => rel === "app/globals.css"),
    "app/globals.css was not scanned",
  );
});

for (const d of DELETIONS) {
  test(`stays deleted: ${d.what}`, () => {
    if (d.gone) {
      assert.equal(existsSync(resolve(REPO, d.gone)), false, `${d.gone} exists again`);
    }
    const scope = d.only
      ? files.filter(([rel]) => d.only.some((o) => rel.startsWith(o) || rel === o))
      : files;
    assert.ok(scope.length > 0, "the predicate's scope matched no files");
    const hits = [];
    for (const [rel, abs] of scope) {
      const src = body(abs);
      const m = d.absent.exec(src);
      if (m) {
        const line = src.slice(0, m.index).split("\n").length;
        hits.push(`${rel}:${line}  ${m[0].slice(0, 60)}`);
      }
    }
    assert.deepEqual(hits, [], `re-introduced:\n${hits.join("\n")}`);
  });
}

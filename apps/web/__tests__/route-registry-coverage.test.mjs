/**
 * ADM-P3-011 — WHAT THE ROUTE REGISTRY IS ACTUALLY THE SOURCE OF TRUTH FOR.
 *
 * =============================================================================
 * THE CLAIM, AND WHAT WAS UNDERNEATH IT
 * =============================================================================
 * `lib/navigation/routeRegistry.ts` opens by calling itself "the SOURCE OF
 * TRUTH for route existence". It carries 143 entries against 165 filesystem
 * pages. Most of the remainder is public marketing and token-bearing detail
 * routes, which is defensible — but it also included authenticated product
 * children, and `PageRouteGate` used to render an unregistered id's children
 * UNPROTECTED with a development-only console warning.
 *
 * "Unregistered ids render unprotected" plus "unregistered pages exist" is not
 * a latent shape. Two admin detail pages gated on `admin.contactSales` and
 * `admin.demoRequests`, neither of which is in the registry — the entries are
 * `platform.contact_sales_detail` and `platform.demo_request_detail` — so both
 * page-level gates had been doing nothing.
 *
 * =============================================================================
 * THE TWO INVARIANTS, AND WHY NOT "EVERY PAGE IS REGISTERED"
 * =============================================================================
 * The obvious rule — every page under `app/(app)` has its own registry entry —
 * is the wrong one. Thirteen authenticated children deliberately gate on a
 * PARENT's routeId (the six `/evidence-lifecycle/*` sub-pages share
 * `workspace.evidence_lifecycle`, the five `/governance-platform/*` sub-pages
 * share `workspace.governance_platform`), and inventing a per-child entry for
 * each would put thirteen new destinations into All Tools and the command
 * palette to satisfy a test. They are gated; they are simply gated by their
 * parent.
 *
 * So:
 *
 *   1. Every `routeId` used anywhere in the tree resolves to a registry entry.
 *      This is what makes `PageRouteGate` safe to fail CLOSED — an id that
 *      resolves to nothing cannot reach production, so a denial can never be
 *      the result of a typo nobody caught.
 *
 *   2. Every page under `app/(app)` is gated: by its own entry, by an
 *      ancestor's, or it renders nothing at all (a pure server redirect, whose
 *      destination carries the gate).
 *
 * The registry header's own wording is narrowed to match, in the same change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REGISTRY = join(WEB, "lib", "navigation", "routeRegistry.ts");
const APP_GROUP = join(WEB, "app", "(app)");

function walk(dir, match, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match(entry)) out.push(full);
  }
  return out;
}

const rel = (f) => relative(WEB, f).split(sep).join("/");

/** Registry ids and hrefs, read from the one file that defines them. */
function registry() {
  const src = readFileSync(REGISTRY, "utf8");
  return {
    ids: new Set([...src.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1])),
    hrefs: new Set([...src.matchAll(/\bhref:\s*"([^"]+)"/g)].map((m) => m[1])),
  };
}

/**
 * The URL a page file serves.
 *
 * Route groups — the `(app)`, `(marketing)` parentheses — are path segments in
 * the filesystem and not in the URL, and `[id]` is written `:id` in the
 * registry.
 */
function urlOf(pageFile) {
  const parts = relative(APP_GROUP, dirname(pageFile))
    .split(sep)
    .filter((s) => s.length > 0 && !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => s.replace(/^\[\.\.\.?(.+)\]$/, ":$1").replace(/^\[(.+)\]$/, ":$1"));
  return "/" + parts.join("/");
}

// ===========================================================================
// 1. No routeId resolves to nothing.
// ===========================================================================

test("every routeId used in the tree exists in the registry", () => {
  const { ids } = registry();
  assert.ok(ids.size > 0, "the registry parsed to zero ids");

  const offenders = [];
  const sources = [
    ...walk(join(WEB, "app"), (e) => /\.tsx?$/.test(e)),
    ...walk(join(WEB, "components"), (e) => /\.tsx?$/.test(e)),
  ];
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/routeId=\{?"([^"]+)"/g)) {
      if (!ids.has(m[1])) offenders.push(`${rel(file)}: routeId="${m[1]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "PageRouteGate fails CLOSED on an unknown id, so each of these renders a " +
      "denial instead of the page:\n  " + offenders.join("\n  "),
  );
});

// ===========================================================================
// 2. No authenticated page is ungated.
// ===========================================================================

/**
 * A redirect shim carries no gate, because it shows nothing to gate.
 *
 * Two shapes, both real in this tree:
 *
 *   - `redirect("/elsewhere")` — a server redirect that returns no JSX at all
 *     (`/settings/security/saml`, the procurement deep-link).
 *   - a client shim that calls `router.replace` in an effect and renders one
 *     line of "Opening…" text while it goes
 *     (`/collaboration-teams/:teamId/collaboration`, a retired destination).
 *
 * The property that matters is that the page reads NO product data — so
 * `apiFetch` anywhere in the module disqualifies it, whatever it renders. The
 * destination carries the gate.
 */
function isRedirectShim(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  if (/\bapiFetch\b/.test(code)) return false;
  return /\bredirect\(|router\.(replace|push)\(/.test(code);
}

/**
 * `export { default } from "../inbox/page"` is ONE page at two URLs.
 *
 * `/notifications` is the canonical URL for the implementation that also
 * serves `/inbox`, deliberately re-exported rather than copied so a
 * 1,300-line page cannot exist twice and drift. The gate lives in the
 * implementation, so follow the re-export and judge that file.
 */
function reExportTarget(pageFile, src) {
  const m = src.match(/export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/);
  if (!m) return null;
  const candidate = resolve(dirname(pageFile), m[1]);
  for (const ext of [".tsx", ".ts", "/index.tsx"]) {
    try {
      const full = candidate.endsWith(ext) ? candidate : candidate + ext;
      readFileSync(full, "utf8");
      return full;
    } catch {
      /* try the next extension */
    }
  }
  return null;
}

test("every page under app/(app) is gated, by itself or by an ancestor", () => {
  const { hrefs } = registry();
  const pages = walk(APP_GROUP, (e) => e === "page.tsx");
  assert.ok(pages.length > 100, `only ${pages.length} pages found — the walk is wrong`);

  const ungated = [];
  for (const page of pages) {
    let src = readFileSync(page, "utf8");
    const target = reExportTarget(page, src);
    if (target) src = readFileSync(target, "utf8");
    if (/<PageRouteGate\b/.test(src)) continue;
    if (isRedirectShim(src)) continue;

    // An ancestor LAYOUT may carry the gate — that is how every /admin page is
    // protected, from app/(app)/admin/layout.tsx.
    let dir = dirname(page);
    let gatedByLayout = false;
    while (dir.startsWith(APP_GROUP)) {
      const layout = join(dir, "layout.tsx");
      try {
        if (/<PageRouteGate\b/.test(readFileSync(layout, "utf8"))) {
          gatedByLayout = true;
          break;
        }
      } catch {
        /* no layout at this level */
      }
      if (dir === APP_GROUP) break;
      dir = dirname(dir);
    }
    if (gatedByLayout) continue;

    ungated.push(`${rel(page)} (serves ${urlOf(page)})`);
  }

  assert.deepEqual(
    ungated,
    [],
    "these authenticated pages render with no route gate at any level:\n  " +
      ungated.join("\n  "),
  );
  // The registry is still expected to describe the product's destinations;
  // this keeps the two facts in one place rather than trusting the count.
  assert.ok(hrefs.size > 100, "the registry describes suspiciously few routes");
});

// ===========================================================================
// 3. The header says what is true.
// ===========================================================================

test("the registry does not claim to enumerate every page", () => {
  /*
   * The header said the registry is the source of truth for "route existence
   * (which routes the app knows about)", which reads as an enumeration of every
   * page and is not one — 22 filesystem pages have no entry, deliberately.
   * What it IS the source of truth for is which routes are NAVIGABLE
   * DESTINATIONS and what unlocks them. The wording has to say that, or the
   * next reader draws the same wrong conclusion from it that this finding did.
   */
  const src = readFileSync(REGISTRY, "utf8");
  const header = src.slice(0, src.indexOf("import "));
  assert.ok(
    /not every page under `app\/\(app\)`|does not enumerate every page|gated by (a|an) (parent|ancestor)/i.test(
      header,
    ),
    "the registry header must state that some pages are gated by an ancestor " +
      "rather than by an entry of their own",
  );
});

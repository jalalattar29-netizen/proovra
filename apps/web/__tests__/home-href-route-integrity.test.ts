/**
 * UC-WEB-004 — every Home priority / CTA href resolves to a real page.
 *
 * Home rendered "Review submissions" → /evidence-requests?status=…, a route
 * with no page (only /evidence-requests/[id] ships; the route registry itself
 * records "root list page does not exist"). This guard extracts EVERY literal
 * internal href from the Home view model and resolves its pathname against
 * the App Router tree (route groups stripped, dynamic segments matching any
 * segment) or a next.config.js redirect source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(WEB, "app");
const VIEW_MODEL = readFileSync(
  join(WEB, "components/home-experience/home-view-model.ts"),
  "utf8",
);

/** All page route patterns as segment arrays (route groups removed). */
function pageRoutes(dir: string, segs: string[] = []): string[][] {
  const out: string[][] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith("_") || e.name.startsWith("@")) continue;
      const next = /^\(.*\)$/.test(e.name) ? segs : [...segs, e.name];
      out.push(...pageRoutes(join(dir, e.name), next));
    } else if (/^page\.(tsx|ts|jsx|js)$/.test(e.name)) {
      out.push(segs);
    }
  }
  return out;
}
const ROUTES = pageRoutes(APP);

function resolves(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return ROUTES.some((route) => {
    if (route.some((s) => s.startsWith("[..."))) {
      const fixed = route.findIndex((s) => s.startsWith("[..."));
      return parts.length >= fixed + 1 && route.slice(0, fixed).every((s, i) => s.startsWith("[") || s === parts[i]);
    }
    if (route.length !== parts.length) return false;
    return route.every((s, i) => s.startsWith("[") || s === parts[i]);
  });
}

function redirectSources(): string[] {
  const cfg = join(WEB, "next.config.js");
  if (!existsSync(cfg)) return [];
  return [...readFileSync(cfg, "utf8").matchAll(/source:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** Literal internal hrefs: `href: "/x"`, `href: \`/x/${…}\`` prefixes, and *_HREF constants. */
function homeHrefs(): string[] {
  const hrefs = new Set<string>();
  for (const m of VIEW_MODEL.matchAll(/href:\s*"(\/[^"]*)"/g)) hrefs.add(m[1]);
  for (const m of VIEW_MODEL.matchAll(/_HREF\s*=\s*\n?\s*"(\/[^"]*)"/g)) hrefs.add(m[1]);
  for (const m of VIEW_MODEL.matchAll(/href:\s*`(\/[^`$]*)(\$\{[^}]+\})?/g)) {
    // A template with an interpolated id segment resolves as a dynamic segment.
    hrefs.add(m[2] ? `${m[1]}__dynamic__` : m[1]);
  }
  return [...hrefs];
}

test("Home view model exposes a non-trivial set of internal hrefs", () => {
  assert.ok(homeHrefs().length >= 10, `expected >= 10 hrefs, found ${homeHrefs().length}`);
});

test("every Home href resolves to a page or a redirect (no 404 CTA)", () => {
  const redirects = redirectSources();
  const broken: string[] = [];
  for (const href of homeHrefs()) {
    const pathname = href.split(/[?#]/)[0].replace(/\/$/, "") || "/";
    if (resolves(pathname)) continue;
    if (redirects.some((src) => src === pathname)) continue;
    broken.push(href);
  }
  assert.deepEqual(broken, [], `Home links to routes with no page: ${broken.join(", ")}`);
});

test("'Review submissions' lands on the evidence-request review queue", () => {
  assert.doesNotMatch(VIEW_MODEL, /href:\s*"\/evidence-requests\?/);
  assert.match(VIEW_MODEL, /HOME_SUBMISSION_REVIEW_HREF\s*=\s*\n?\s*"\/review\/queues#evidence-request-queue"/);
  const panel = readFileSync(join(APP, "(app)/review/queues/_evidence-request-queue.tsx"), "utf8");
  assert.match(panel, /id="evidence-request-queue"/);
});

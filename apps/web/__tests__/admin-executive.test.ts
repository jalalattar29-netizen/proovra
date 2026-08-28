/**
 * PROOVRA Platform Admin — Executive Dashboard page contract.
 *
 * Source-contract pins (node:test style, matching the sibling web tests):
 *
 *   1. The page exists at app/(app)/admin/executive/page.tsx and is a
 *      client component with a default export.
 *   2. It is gated to platform-admin — it wraps its content in the
 *      canonical `<PageRouteGate routeId="platform.admin">` (in addition to
 *      inheriting the shared admin/layout gate). It does not roll its own
 *      capability check.
 *   3. It reads the executive aggregate from GET /v1/admin/executive and
 *      performs no admin mutation.
 *   4. It renders honest "Not measured" states for growth, MRR and ARR —
 *      and NEVER a fabricated growth-% / MRR / ARR numeric literal.
 *   5. Errors flow through the sanctioned `toSafeUserError` path.
 *   6. It carries data-testid="admin-executive" and uses AdminConsoleNav +
 *      DataTable for top-customers and at-risk, with no hero/legacy classes.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const APP_ROOT = resolve(REPO_ROOT, "apps/web");

const PAGE = resolve(APP_ROOT, "app/(app)/admin/executive/page.tsx");
const ADMIN_LAYOUT = resolve(APP_ROOT, "app/(app)/admin/layout.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — page exists", () => {
  it("app/(app)/admin/executive/page.tsx exists", () => {
    assert.ok(existsSync(PAGE), "executive page.tsx missing");
  });

  it("is a client component with a default export", () => {
    const src = read(PAGE);
    assert.match(src, /^"use client";/);
    assert.match(src, /export default function AdminExecutivePage/);
  });
});

describe("Pin 2 — gated to platform-admin (reuses the existing gate)", () => {
  it("wraps its content in the canonical PageRouteGate", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /import\s+\{\s*PageRouteGate\s*\}\s+from\s+["'][^"']*navigation\/PageRouteGate["']/
    );
    assert.match(src, /<PageRouteGate\s+routeId="platform\.admin"/);
  });

  it("does NOT roll its own capability / admin check", () => {
    const src = read(PAGE);
    assert.doesNotMatch(src, /isPlatformAdmin/);
  });

  it("the shared admin layout gates /admin/* with platform.admin", () => {
    const layout = read(ADMIN_LAYOUT);
    assert.match(layout, /routeId="platform\.admin"/);
  });
});

describe("Pin 3 — reads the executive aggregate, no mutation", () => {
  it("GETs /v1/admin/executive", () => {
    const src = read(PAGE);
    assert.match(src, /apiFetch\(\s*`\/v1\/admin\/executive`\s*\)/);
  });

  it("references no other /v1/admin endpoint and no mutation method", () => {
    const src = read(PAGE);
    const adminCalls = [...src.matchAll(/["'`]\/v1\/admin\/[^"'`]*/g)].map((m) =>
      m[0].replace(/["'`]/g, "")
    );
    for (const call of adminCalls) {
      assert.ok(
        call.startsWith("/v1/admin/executive"),
        `unexpected admin endpoint referenced by the page: ${call}`
      );
    }
    assert.doesNotMatch(src, /method:\s*["'](POST|PATCH|PUT|DELETE)["']/);
  });
});

describe("Pin 4 — honest 'Not measured' for growth / MRR / ARR (never fabricated)", () => {
  it("renders explicit not-measured states for growth, MRR and ARR", () => {
    const src = read(PAGE);
    assert.match(src, /admin-executive-growth-not-measured/);
    assert.match(src, /admin-executive-mrr-not-measured/);
    assert.match(src, /admin-executive-arr-not-measured/);
    assert.match(src, /Not measured/);
  });

  it("reads growth / MRR / ARR as not-measured null (uses .notMeasured, never a value)", () => {
    const src = read(PAGE);
    assert.match(src, /growthRatePct\.notMeasured/);
    assert.match(src, /mrrCents\.notMeasured/);
    assert.match(src, /arrCents\.notMeasured/);
    // The page must NOT read a numeric value off these honest-null fields.
    assert.doesNotMatch(src, /growthRatePct\.value\s*[^=]/);
    assert.doesNotMatch(src, /mrrCents\.value/);
    assert.doesNotMatch(src, /arrCents\.value/);
  });

  it("contains no fabricated growth-% literal (no hard-coded percentage)", () => {
    const src = read(PAGE);
    // A fabricated growth rate would look like "+12%", "12.5%", "growthRate = 12".
    assert.doesNotMatch(src, /[+-]?\d+(?:\.\d+)?\s*%/);
    assert.doesNotMatch(src, /growthRate\s*[:=]\s*[-\d]/);
  });
});

describe("Pin 5 — sanctioned error path only", () => {
  it("uses toSafeUserError", () => {
    const src = read(PAGE);
    assert.match(src, /toSafeUserError/);
  });

  it("never renders a raw error.message / err.message passthrough", () => {
    const src = read(PAGE);
    assert.doesNotMatch(src, /\{[^{}]*\berr(?:or)?\.message\b[^{}]*\}/);
  });
});

describe("Pin 6 — shape: testid, nav, DataTables, no legacy classes", () => {
  it('carries data-testid="admin-executive"', () => {
    const src = read(PAGE);
    assert.match(src, /data-testid="admin-executive"/);
  });

  it("uses AdminConsoleNav and DataTable for top-customers + at-risk", () => {
    const src = read(PAGE);
    assert.match(
    readFileSync(
      resolve(APP_ROOT, "app/(app)/admin/layout.tsx"),
      "utf8",
    ),
    /AdminConsoleNav/,
    "AdminConsoleNav moved to app/(app)/admin/layout.tsx (ADM-025) — asserted there, once, for every admin page",
  );
    const tables = src.match(/<DataTable/g) ?? [];
    assert.ok(tables.length >= 2, "top-customers + at-risk DataTables expected");
    assert.match(src, /admin-executive-top-empty/);
    assert.match(src, /admin-executive-at-risk-empty/);
  });

  it("uses no app-hero / cc-page / legacy btn- classes", () => {
    const src = read(PAGE);
    assert.doesNotMatch(src, /app-hero/);
    assert.doesNotMatch(src, /cc-page/);
    assert.doesNotMatch(src, /className="[^"]*\bbtn-/);
  });
});

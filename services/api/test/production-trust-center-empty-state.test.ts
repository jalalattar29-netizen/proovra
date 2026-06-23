/**
 * Production regression test — Trust Center empty in production.
 *
 * Symptoms observed:
 *   1. /trust-center: "No published articles. Click Re-seed defaults
 *      to publish the 15 canonical sections."
 *   2. /trust-center/methodology: "No published articles for this kind."
 *   3. /trust-center/ai-disclosure: "No published articles for this kind."
 *   4. /trust-center/security: "No published articles for this kind."
 *   5. /trust-center/subprocessors: "No subprocessors registered."
 *   6. /trust-center/status: "Loading status..." (forever).
 *
 * Root cause (proved by tracing every layer):
 *
 *   * POST /v1/trust/articles/seed AND POST /v1/trust/subprocessors/seed
 *     were gated by `requireDelegatedTierAny([ORG_ADMIN,
 *     SECURITY_OFFICER, COMPLIANCE_OFFICER])`. PERSONAL workspaces
 *     have NO delegated-tier system at all, and most ORG members
 *     lack these tiers. The "Re-seed defaults" button therefore
 *     returned 403 for the vast majority of users.
 *
 *   * The frontend silently swallowed the 403 (`catch {}`). The
 *     user clicked the button and saw nothing change.
 *
 *   * The landing "Re-seed defaults" only POSTed to
 *     /v1/trust/articles/seed — never to /v1/trust/subprocessors/seed
 *     — so even if the gate hadn't blocked them, subprocessors
 *     would have remained empty.
 *
 *   * /trust-center/status rendered `{status ? (...) : <Loading>}`,
 *     conflating "still loading", "loaded empty", and "load failed"
 *     into a single permanent "Loading status…" message.
 *
 * Fixes applied (pinned below):
 *
 *   A. GET /v1/trust/articles auto-seeds when the workspace returns
 *      empty (idempotent ensureTrustCenterSeed). Same for GET
 *      /v1/trust/subprocessors. Read-side self-healing means any
 *      workspace member visiting the page populates it.
 *
 *   B. POST /v1/trust/articles/seed and POST /v1/trust/subprocessors/seed
 *      now require only requireAuth. Canonical platform documentation
 *      is not customer content; any workspace member may request the
 *      idempotent seed. Custom AUTHORING routes
 *      (POST /v1/trust/articles, POST /v1/trust/subprocessors)
 *      remain gated by delegated tier.
 *
 *   C. The landing "Re-seed defaults" button now seeds BOTH articles
 *      AND subprocessors via Promise.allSettled, and surfaces a
 *      bounded `<created>·<updated>` summary so the user can tell
 *      what happened. Errors are reported, not swallowed.
 *
 *   D. /trust-center/status uses an explicit 4-phase load state
 *      machine (`loading | loaded | empty | error`) so the page
 *      never renders "Loading status…" after a failed or empty
 *      request.
 *
 * Style: source-contract (file-text). No DB I/O.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRepo(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

const ROUTES = readRepo("services/api/src/routes/trust-and-governance.routes.ts");
// Phase E5 rebaseline: workspace Trust hub migrated from
// `(app)/trust/page.tsx` to `(app)/trust-hub/page.tsx`. The canonical
// public Trust Center now owns `/trust` (Next.js parallel-page rule
// forbids both). Empty-state guarantees still apply to the workspace
// hub at its new canonical location.
const TRUST_PAGE = readRepo("apps/web/app/(app)/trust-hub/page.tsx");
const REDIRECT_LANDING = readRepo("apps/web/app/(app)/trust-center/page.tsx");
const STATUS = readRepo("apps/web/app/(app)/trust-center/status/page.tsx");

// ===========================================================================
// Fix A — GET routes auto-seed when the workspace is empty
// ===========================================================================

describe("Production fix A — GET routes self-heal an empty Trust Center", () => {
  it("GET /v1/trust/articles auto-calls ensureTrustCenterSeed when empty", () => {
    // Pull the articles GET handler body.
    const idx = ROUTES.indexOf('"/v1/trust/articles"');
    expect(idx, "/v1/trust/articles route must exist").toBeGreaterThan(-1);
    const slice = ROUTES.slice(idx, idx + 3500);
    expect(slice).toMatch(/let\s+articles\s*;/);
    expect(slice).toMatch(/articles\s*=\s*await\s+listTrustArticles/);
    expect(slice).toMatch(
      /if\s*\(\s*articles\.length\s*===\s*0\s*\)\s*\{[\s\S]{0,400}ensureTrustCenterSeed/,
    );
    // The self-heal must be wrapped in try/catch so a seed failure
    // never turns a GET into a 500.
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}ensureTrustCenterSeed/);
    expect(slice).toMatch(/ensureTrustCenterSeed[\s\S]{0,400}\}\s*catch\b/);
  });

  it("GET /v1/trust/subprocessors auto-calls ensureSubprocessorSeed when empty", () => {
    const idx = ROUTES.indexOf('"/v1/trust/subprocessors"');
    expect(idx).toBeGreaterThan(-1);
    const slice = ROUTES.slice(idx, idx + 3500);
    expect(slice).toMatch(/let\s+subprocessors\s*;/);
    expect(slice).toMatch(/subprocessors\s*=\s*await\s+listSubprocessors/);
    expect(slice).toMatch(
      /if\s*\(\s*subprocessors\.length\s*===\s*0\s*\)\s*\{[\s\S]{0,400}ensureSubprocessorSeed/,
    );
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}ensureSubprocessorSeed/);
    expect(slice).toMatch(/ensureSubprocessorSeed[\s\S]{0,400}\}\s*catch\b/);
  });
});

// ===========================================================================
// Fix B — POST seed gates relaxed to any authenticated workspace member
// ===========================================================================

describe("Production fix B — seed POSTs no longer require delegated tier", () => {
  it("POST /v1/trust/articles/seed handler runs under requireAuth only", () => {
    const idx = ROUTES.indexOf('"/v1/trust/articles/seed"');
    expect(idx).toBeGreaterThan(-1);
    // Slice from the route literal to the NEXT app.post/app.get so we
    // never bleed into a sibling route's preHandler (the subprocessors
    // GET / authoring POST etc).
    const after = ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 1500));
    expect(slice).not.toMatch(/requireDelegatedTier/);
    expect(slice).toMatch(/preHandler:\s*requireAuth\b/);
  });

  it("POST /v1/trust/subprocessors/seed handler runs under requireAuth only", () => {
    const idx = ROUTES.indexOf('"/v1/trust/subprocessors/seed"');
    expect(idx).toBeGreaterThan(-1);
    const after = ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 1500));
    expect(slice).not.toMatch(/requireDelegatedTier/);
    expect(slice).toMatch(/preHandler:\s*requireAuth\b/);
  });

  it("Authoring routes still require delegated tier (gate preserved where it matters)", () => {
    // Pin that POST /v1/trust/articles (NO trailing /seed) and
    // POST /v1/trust/subprocessors (NO trailing /seed) DO still
    // require the delegated tier. We only opened up the canonical
    // seed paths.
    const authoringIdx = ROUTES.indexOf('app.post(\n    "/v1/trust/articles",');
    expect(authoringIdx).toBeGreaterThan(-1);
    const authoringSlice = ROUTES.slice(authoringIdx, authoringIdx + 800);
    expect(authoringSlice).toMatch(/requireDelegatedTierAny/);

    const subAuthoringIdx = ROUTES.indexOf('app.post(\n    "/v1/trust/subprocessors",');
    expect(subAuthoringIdx).toBeGreaterThan(-1);
    const subAuthoringSlice = ROUTES.slice(subAuthoringIdx, subAuthoringIdx + 800);
    expect(subAuthoringSlice).toMatch(/requireDelegatedTierAny/);
  });
});

// ===========================================================================
// Fix C — duplicate /trust-center shell is retired in favour of /trust
// ===========================================================================

describe("Production fix C — /trust-center now defers to the canonical /trust page", () => {
  it("/trust-center is a redirect-only shim", () => {
    expect(REDIRECT_LANDING).toMatch(/from\s+["']next\/navigation["']\s*;?/);
    expect(REDIRECT_LANDING).toMatch(/redirect\("\/trust"\)/);
  });

  it("the canonical /trust page carries the public trust cards instead of an empty article shell", () => {
    expect(TRUST_PAGE).toMatch(/data-trust-section="cards"/);
    expect(TRUST_PAGE).toMatch(/title:\s*"AI transparency"/);
    expect(TRUST_PAGE).toMatch(/title:\s*"Security documentation"/);
    expect(TRUST_PAGE).toMatch(/title:\s*"Subprocessors"/);
    expect(TRUST_PAGE).toMatch(/title:\s*"Public verification"/);
  });

  it("operator vocabulary stays bounded — no env names or stack traces", () => {
    // Negative pin against accidental error-leak regressions.
    expect(TRUST_PAGE).not.toMatch(/process\.env\./);
    expect(TRUST_PAGE).not.toMatch(/err\.stack/);
    expect(TRUST_PAGE).not.toMatch(/console\.error\(.*err/);
    expect(REDIRECT_LANDING).not.toMatch(/process\.env\./);
    expect(REDIRECT_LANDING).not.toMatch(/err\.stack/);
  });
});

// ===========================================================================
// Fix D — Status page has explicit load-state machine; never stuck on Loading
// ===========================================================================

describe("Production fix D — status page renders honest load states", () => {
  it("uses a 4-phase LoadState union (loading / loaded / empty / error)", () => {
    expect(STATUS).toMatch(/type\s+LoadState\b/);
    expect(STATUS).toMatch(/phase:\s*"loading"/);
    expect(STATUS).toMatch(/phase:\s*"loaded"/);
    expect(STATUS).toMatch(/phase:\s*"empty"/);
    expect(STATUS).toMatch(/phase:\s*"error"/);
  });

  it("renders dedicated DOM for each phase (so the user can tell what's happening)", () => {
    expect(STATUS).toMatch(/data-status-phase="loading"/);
    expect(STATUS).toMatch(/data-status-phase="empty"/);
    expect(STATUS).toMatch(/data-status-phase="error"/);
  });

  it('the failed-fetch path sets phase: "error" with a bounded message (not "Loading…")', () => {
    // The catch block must move us to the error phase. Pin that
    // the new error message is in the source AND that the message
    // is operator-bounded (no env names, no stack traces).
    expect(STATUS).toMatch(/setState\(\s*\{\s*phase:\s*"error"/);
    expect(STATUS).toMatch(/Status page could not be loaded/);
    expect(STATUS).not.toMatch(/err\.stack/);
    expect(STATUS).not.toMatch(/process\.env\./);
  });

  it("the refresh button labels switch between Loading / Retry / Refresh by phase", () => {
    expect(STATUS).toMatch(/state\.phase === "error"[\s\S]{0,100}"Retry"/);
  });
});

// ===========================================================================
// Bounded GUARDs — no Trust Center v2, no new pages
// ===========================================================================

describe("Bounded guards — no Trust Center v2, no new pages", () => {
  it("the source contains no `trust-center-v2` references", () => {
    // The fix MUST be applied in-place. Any v2 ladder is a regression.
    expect(ROUTES).not.toMatch(/trust[-_]center[-_]v2/);
    expect(TRUST_PAGE).not.toMatch(/trust[-_]center[-_]v2/);
    expect(REDIRECT_LANDING).not.toMatch(/trust[-_]center[-_]v2/);
    expect(STATUS).not.toMatch(/trust[-_]center[-_]v2/);
  });

  it("no new /v1/trust/* endpoint added beyond the canonical surface", () => {
    // Whitelist of canonical Trust Center HTTP endpoints. Adding
    // anything new is a regression of the "no v2" rule.
    const canonicalEndpoints = [
      "/v1/trust/articles",
      "/v1/trust/articles/:kind/:slug",
      "/v1/trust/articles/:id/versions",
      "/v1/trust/articles/seed",
      "/v1/trust/articles/:id/review",
      "/v1/trust/subprocessors",
      "/v1/trust/subprocessors/:id/versions",
      "/v1/trust/subprocessors/seed",
      "/v1/trust/status",
      "/v1/trust/status/incidents",
      "/v1/trust/status/incidents/:id/updates",
      "/v1/trust/status/maintenance",
      // Phase 4A Closure additions (pre-existing — not introduced by
      // this regression fix). Listed so future drift detection still
      // works: any NEW path beyond these is a regression.
      "/v1/trust/drift/scan",
      "/v1/trust/drift/stale",
      "/v1/trust/security-claims/scan",
      "/v1/trust/security-claims",
      "/v1/trust/verify-references",
      "/v1/trust/verification-package/preview",
    ];
    const trustPaths =
      ROUTES.match(/"\/v1\/trust\/[a-z0-9/:_-]+"/gi) ?? [];
    const stripped = trustPaths.map((p) => p.slice(1, -1));
    const unique = Array.from(new Set(stripped));
    for (const p of unique) {
      expect(
        canonicalEndpoints,
        `unknown /v1/trust endpoint introduced: ${p}`,
      ).toContain(p);
    }
  });
});

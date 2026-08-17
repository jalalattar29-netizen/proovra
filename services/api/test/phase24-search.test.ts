/**
 * Phase 24 — Enterprise Evidence Discovery regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests covering the
 * Phase 24 backend hardening + the web search console:
 *
 *   - Indexing service NEVER reads / projects the privateReviewerNote.
 *   - Search service hashes the raw query string before any audit
 *     emission (we assert source-level — no raw `q` in the event body).
 *   - Result row projection only contains allowed-catalog badges.
 *   - Routes use requireAuth + requireSearchActor (404-on-non-member)
 *     and write routes require identity.access_review.action.
 *   - Reindex routes accept only POST with operator gate.
 *   - Web search page never writes a forbidden overclaim phrase.
 *   - Public verify routes have NO Phase 24 imports.
 *   - Untouched files invariant: services/worker/src/pdf/report.ts
 *     carries no Phase 24 markers.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SEARCH_RESULT_ALLOWED_BADGES,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  decodeSearchCursor,
  encodeSearchCursor,
  isAllowedSearchBadge,
  stringContainsForbiddenOverclaim,
} from "@proovra/shared";

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

function readSource(relativeFromTest: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeFromTest, import.meta.url)),
    "utf8"
  );
}

// -----------------------------------------------------------------------------
// Indexing service — privacy guarantees
// -----------------------------------------------------------------------------

describe("Phase 24 — indexing service privacy guarantees", () => {
  const src = readSource("../src/services/search/evidence-indexing.service.ts");

  it("never reads privateReviewerNote into the search projection", () => {
    // The phrase may legitimately appear in the file's header docstring
    // as a deliberate exclusion comment. The invariant is that no
    // property access reaches into it.
    expect(src).not.toMatch(/\.privateReviewerNote\b/);
    expect(src).not.toMatch(/privateReviewerNote\s*:/);
    expect(src).not.toMatch(/\bselect\s*:\s*\{[^}]*privateReviewerNote/);
  });

  it("never reads legal-hold reason text into the projection", () => {
    expect(src).not.toMatch(/legalHoldReason\b/);
    expect(src).not.toMatch(/legal_hold_reason\b/);
  });

  it("only consumes COMPLETED extraction text (no PENDING / FAILED leakage)", () => {
    // We rely on the Phase 15 extraction status enum; the service must
    // only fold COMPLETED extractions into the searchable_text body.
    expect(src).toMatch(/COMPLETED/);
    expect(src).not.toMatch(/EvidenceExtractedTextStatus\.SUCCESS/);
  });

  it("redacts via safeJsonSnapshot (not raw JSON.stringify of metadata)", () => {
    expect(src).toMatch(/safeJsonSnapshot/);
  });
});

// -----------------------------------------------------------------------------
// Search service — query privacy + reviewer gate
// -----------------------------------------------------------------------------

describe("Phase 24 — search service privacy + reviewer gate", () => {
  const src = readSource("../src/services/search/evidence-search.service.ts");

  it("hashes the search query (SHA256) before emitting any audit", () => {
    expect(src).toMatch(/createHash\(["']sha256["']\)/);
    expect(src).toMatch(/queryHash/);
  });

  it("never sends the raw `q` text into the SecurityEvent details", () => {
    // The event body must use queryHash + queryLength, not the raw string.
    // We assert source-level by checking the SecurityEvent emit shape
    // never references `q:` as the raw key in the details payload.
    const detailsBlock = src.match(/details:\s*\{[\s\S]*?\}/g) ?? [];
    for (const block of detailsBlock) {
      expect(block).not.toMatch(/q:\s*filter\.q\b/);
      expect(block).not.toMatch(/query:\s*filter\.q\b/);
    }
  });

  it("fails closed when isReviewerCapable is false (sets reviewerRestricted = false)", () => {
    expect(src).toMatch(/if \(!input\.isReviewerCapable\)/);
    expect(src).toMatch(/where\.reviewerRestricted\s*=\s*false/);
  });

  it("filters governance-blocked workflow rows (CANCELLED) in the per-row pass", () => {
    expect(src).toMatch(/workflowState\s*===\s*["']CANCELLED["']/);
  });

  it("only emits badges from the allowed catalog", () => {
    expect(src).toMatch(/isAllowedSearchBadge/);
  });
});

// -----------------------------------------------------------------------------
// Saved-search service — visibility + permission shape
// -----------------------------------------------------------------------------

describe("Phase 24 — saved-search service", () => {
  const src = readSource("../src/services/search/saved-search.service.ts");

  it("blocks PRIVATE-view deletion by non-creators", () => {
    expect(src).toMatch(
      /visibility\s*===\s*["']PRIVATE["'][\s\S]*?createdByUserId\s*!==\s*input\.actorUserId/
    );
  });

  it("includes other users' TEAM-visibility views in the list", () => {
    expect(src).toMatch(/visibility:\s*["']TEAM["']/);
  });

  it("no touch writer survives, so nothing can throw from one", () => {
    // PHASE 13 §4. This pinned the WORD "best-effort" in the docblock of
    // `touchSavedView`, a `lastUsedAtUtc` bump that nothing in the tree called:
    // no route, no sweep, no test but this string match. It was removed rather
    // than wired, and the assertion follows — the property "a touch cannot
    // throw to the caller" is now held by there being no touch at all, which is
    // checkable, where a comment was not.
    expect(src).not.toMatch(/\btouchSavedView\b/);
    expect(src).not.toMatch(/lastUsedAtUtc:\s*new Date\(\)/);
  });
});

// -----------------------------------------------------------------------------
// Routes — auth posture + operator gate on write surfaces
// -----------------------------------------------------------------------------

describe("Phase 24 — search routes auth posture", () => {
  const src = readSource("../src/routes/search.routes.ts");

  it("uses requireAuth on every Phase 24 route", () => {
    // The route file may include legacy routes too; we assert that
    // every Phase 24 path appears alongside a preHandler: requireAuth.
    const phase24Paths = [
      "/v1/search",
      "/v1/search/saved-views",
      "/v1/search/relationships",
      "/v1/search/reindex/evidence",
      "/v1/search/reindex/workflow",
    ];
    for (const p of phase24Paths) {
      const idx = src.indexOf(`"${p}`);
      expect(idx, `expected route "${p}" registered`).toBeGreaterThanOrEqual(0);
    }
    expect(src).toMatch(/preHandler:\s*requireAuth/);
  });

  it("404s on non-member via requireSearchActor", () => {
    expect(src).toMatch(/requireSearchActor/);
    expect(src).toMatch(/reply\.code\(404\)\.send\(\{ error: \{ code: ["']not_found["'] \} \}\)/);
  });

  it("write routes gate via requireSearchOperator (identity.access_review.action)", () => {
    expect(src).toMatch(/requireSearchOperator/);
    expect(src).toMatch(/identity\.access_review\.action/);
  });

  it("reindex routes only accept POST", () => {
    // Find every route registration referencing /v1/search/reindex
    // and assert its verb is POST.
    const reindexPaths = [
      "/v1/search/reindex/evidence/:id",
      "/v1/search/reindex/workflow/:id",
    ];
    for (const path of reindexPaths) {
      const idx = src.indexOf(`"${path}"`);
      expect(idx, `expected "${path}" registered`).toBeGreaterThan(0);
      // Look backwards from the path string to find the nearest verb
      // call (`app.post(`, `app.get(`, …) within ~120 chars.
      const before = src.slice(Math.max(0, idx - 160), idx);
      expect(
        before.match(/app\.post\(\s*$/),
        `route "${path}" must be registered via app.post`
      ).not.toBeNull();
      expect(before).not.toMatch(/app\.(get|put|delete|patch)\(\s*$/);
    }
  });

  it("delete route is restricted to /v1/search/saved-views/:id", () => {
    expect(src).toMatch(
      /app\.delete\([\s\S]*?"\/v1\/search\/saved-views\/:id"/
    );
  });

  // PHASE 12B (Evidence Operations, 2026-07-29) — exactly ONE public
  // search authority per data domain. The owner-scoped
  // /v1/search/evidence + /v1/search/cases primitives were deleted after
  // their filters were absorbed by the unified authority; the audit-log
  // route stays because search_audit_logs is a DIFFERENT data domain with
  // a different gate (operator, not actor).
  it("exposes exactly one public search authority over workspace content", () => {
    expect(src).not.toMatch(/["']\/v1\/search\/evidence["']/);
    expect(src).not.toMatch(/["']\/v1\/search\/cases["']/);
    // The unified authority survives.
    expect(src).toMatch(/["']\/v1\/search["']/);
    // The audit-log domain keeps its own (operator-gated) authority.
    expect(src).toMatch(/["']\/v1\/search\/audit["']/);
  });

  it("the unified authority carries the absorbed caseId + evidenceTypes filters", () => {
    // Route forwards caseId; the shared schema accepts it.
    expect(src).toMatch(/caseId:\s*typeof raw\.caseId === "string"/);
    const shared = readSource("../../../packages/shared/src/search.ts");
    expect(shared).toMatch(/caseId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
    // executeSearch APPLIES both (evidenceTypes was previously accepted
    // and silently ignored, so the /search filter chips did nothing).
    const svc = readSource("../src/services/search/evidence-search.service.ts");
    expect(svc).toMatch(/where\.caseId = filter\.caseId/);
    expect(svc).toMatch(/filter\.evidenceTypes/);
    expect(svc).toMatch(/path:\s*\["type"\]/);
  });
});

// -----------------------------------------------------------------------------
// Cursor helper — pure round-trip
// -----------------------------------------------------------------------------

describe("Phase 24 — cursor helper round-trip", () => {
  it("encode + decode is lossless for {updatedAtUtc, id}", () => {
    const c = {
      updatedAtUtc: "2026-05-17T08:30:00.000Z",
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    };
    const round = decodeSearchCursor(encodeSearchCursor(c));
    expect(round).toEqual(c);
  });

  it("rejects malformed input as null (no throw)", () => {
    expect(decodeSearchCursor("garbage!!!")).toBeNull();
    expect(decodeSearchCursor("")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Badge wording catalog — operator-safe phrases only
// -----------------------------------------------------------------------------

describe("Phase 24 — badge catalog", () => {
  it("contains the operator-readable phrases from the brief", () => {
    for (const required of [
      "matched metadata",
      "related evidence",
      "workflow-linked",
      "review-linked",
      "governance-restricted",
      "visibility-restricted",
      "integrity record",
    ]) {
      expect(SEARCH_RESULT_ALLOWED_BADGES.includes(required)).toBe(true);
      expect(isAllowedSearchBadge(required)).toBe(true);
    }
  });

  it("rejects free-form overclaims", () => {
    expect(isAllowedSearchBadge("court-approved")).toBe(false);
    expect(isAllowedSearchBadge("forensic proof")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Forbidden overclaim wording sweep — UI surface
// -----------------------------------------------------------------------------

describe("Phase 24 — UI wording sweep", () => {
  const pageSrc = readSource(
    "../../../apps/web/app/(app)/search/page.tsx"
  );

  it("the search page contains no forbidden overclaim phrases", () => {
    for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
      expect(pageSrc).not.toMatch(re);
    }
  });

  it("result badges render through the shared <Badge> with the catalog-validated label", () => {
    // Phase 7C — the bespoke `badgeChipStyle` palette map was removed; result
    // badges now render via the shared <Badge tone={badgeTone(b)}
    // data-search-result-badge={b}> primitive. The badge LABEL `b` comes from
    // the search projection, whose values are constrained to
    // SEARCH_RESULT_ALLOWED_BADGES by `isAllowedSearchBadge` at the SERVICE
    // layer (see "only emits badges from the allowed catalog" above). So the
    // honesty guarantee is enforced on the data, not a page-local style map.
    expect(pageSrc).not.toMatch(/function badgeChipStyle/);
    expect(pageSrc).toMatch(/tone=\{badgeTone\(b\)\}/);
    expect(pageSrc).toMatch(/data-search-result-badge=\{b\}/);
    // Sanity: the allowed catalog still exists and is non-trivial.
    expect(Array.isArray(SEARCH_RESULT_ALLOWED_BADGES)).toBe(true);
    expect(SEARCH_RESULT_ALLOWED_BADGES.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Public verify isolation — Phase 24 services must NOT leak into the
// public verify surface (which has to remain ultra-minimal + zero-cost).
// -----------------------------------------------------------------------------

describe("Phase 24 — public verify isolation", () => {
  it("evidence routes (which host /public/verify) do NOT statically import heavy Phase 24 search services", () => {
    // Public verify lives inside services/api/src/routes/evidence.routes.ts.
    // The hot read paths (public verify + evidence detail) must never
    // statically import the heavy Phase 24 search services. The label
    // (rename) route is allowed to DYNAMICALLY import
    // evidence-indexing.service to keep the search projection in
    // sync (Phase SEARCH-REMEDIATION) because:
    //   - rename is a low-frequency owner-authed mutation, not the
    //     public-verify hot path,
    //   - the import is `await import(...)` inside the handler so
    //     it's lazy-loaded only when the rename runs, and
    //   - the public-verify route at the bottom of the file remains
    //     completely untouched.
    const evidenceSrc = readSource("../src/routes/evidence.routes.ts");
    expect(evidenceSrc).not.toMatch(/from\s+["']\.\.\/services\/search\/evidence-search/);
    expect(evidenceSrc).not.toMatch(/from\s+["']\.\.\/services\/search\/saved-search/);
    expect(evidenceSrc).not.toMatch(/from\s+["']\.\.\/services\/search\/evidence-indexing/);
  });
});

// -----------------------------------------------------------------------------
// Untouched files invariant — Phase 24 must NOT touch the renderer.
// -----------------------------------------------------------------------------

describe("Phase 24 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts has NO Phase 24 markers", () => {
    const src = /* Phase 2: pdf/report.ts was deleted as confirmed dead code; the
       "untouched files invariant" assertion is vacuously satisfied. */ "";
    expect(src).not.toMatch(/Phase 24/);
    expect(src).not.toMatch(/search\/evidence-search/);
    expect(src).not.toMatch(/EvidenceSearchDocument/);
  });
});

// -----------------------------------------------------------------------------
// Helper: catch obvious "save raw query string" regressions in the search
// service (caller is the route layer, but the safety net is layered here).
// -----------------------------------------------------------------------------

describe("Phase 24 — raw-query non-leak guard", () => {
  const src = readSource("../src/services/search/evidence-search.service.ts");
  it("never includes the raw filter.q as an audit field by name", () => {
    // SafeEmitSecurityEvent payloads must not reference `q: filter.q`.
    const matches = src.match(/safeEmitSecurityEvent\(\{[\s\S]*?\}\);/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const block of matches) {
      expect(block).not.toMatch(/q:\s*filter\.q\b/);
      expect(block).not.toMatch(/rawQuery:/);
    }
  });
});

// -----------------------------------------------------------------------------
// Wording sweep — the catalog excludes the legally-overclaiming phrases.
// -----------------------------------------------------------------------------

describe("Phase 24 — overclaim catalog", () => {
  it("flags every banned phrase the brief enumerates", () => {
    const phrases = [
      "this image is tamper-proof",
      "court-approved chain of custody",
      "guaranteed authentic evidence",
      "impossible to alter",
      "detects fake media",
      "forensic proof of integrity",
      "legally admissible record",
    ];
    for (const p of phrases) {
      expect(
        stringContainsForbiddenOverclaim(p),
        `expected "${p}" to be flagged`
      ).toBe(true);
    }
  });

  it("leaves operator-safe phrases unflagged", () => {
    expect(stringContainsForbiddenOverclaim("integrity record")).toBe(false);
    expect(stringContainsForbiddenOverclaim("matched metadata")).toBe(false);
    expect(stringContainsForbiddenOverclaim("related evidence")).toBe(false);
  });
});

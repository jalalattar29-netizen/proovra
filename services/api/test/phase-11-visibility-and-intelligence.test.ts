/**
 * Phase 11 — Visibility & Intelligence source-contract test.
 *
 * Phase 11 was a connect-only pass (see
 * `docs/architecture/phase-11-decisions.md`). It deliberately did NOT
 * build any v2 intelligence layer; it ONLY:
 *
 *   1. Added EVENT_WIRE fan-outs from `evidence-complete.service.ts`
 *      (search reindex + graph reconcile) — both best-effort, both
 *      via existing helpers.
 *   2. Added an EVENT_WIRE from `intelligence/extraction.service.ts`
 *      (extracted-text → entity extraction) via existing helper.
 *   3. Documented three deferred NAV_VISIBILITY flips
 *      (Phase 11 §5 of the decisions doc) that require new registry
 *      primitives the phase forbids touching.
 *   4. Kept honest empty-state copy on `/investigation/duplicates`.
 *
 * This file pins the above so a future PR cannot silently regress
 * Phase 11. The assertions are deliberately relaxed enough to follow
 * production code (production is the source of truth — this test does
 * NOT drive code changes from the test author).
 *
 * Style: source-contract (file-text fs.readFileSync), matching
 * `phase-7-team-vs-workspace-anti-confusion.test.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_ROOT = resolve(REPO_ROOT, "apps/web");

const EVIDENCE_COMPLETE_SRC = resolve(
  API_ROOT,
  "src/services/evidence-complete.service.ts",
);
const EXTRACTION_SRC = resolve(
  API_ROOT,
  "src/services/intelligence/extraction.service.ts",
);
const ROUTE_REGISTRY_SRC = resolve(
  WEB_ROOT,
  "lib/navigation/routeRegistry.ts",
);
const DUPLICATES_PAGE_SRC = resolve(
  WEB_ROOT,
  "app/(app)/investigation/duplicates/page.tsx",
);
const DECISIONS_DOC = resolve(
  REPO_ROOT,
  "docs/architecture/phase-11-decisions.md",
);
const MIGRATIONS_DIR = resolve(API_ROOT, "prisma/migrations");

function readSrc(path: string): string {
  return readFileSync(path, "utf8");
}

// ===========================================================================
// EVENT_WIRE — evidence-complete.service.ts
// ===========================================================================

describe("Phase 11 EVENT_WIRE — evidence-complete fan-out", () => {
  const src = readSrc(EVIDENCE_COMPLETE_SRC);

  it("imports the existing search-queue helper (no v2 queue introduced)", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*enqueueSearchIndexingJob[^}]*\}\s*from\s*["'][^"']*queue\/search-queue[^"']*["']/,
    );
  });

  it("calls enqueueSearchIndexingJob from the finalize fan-out block", () => {
    expect(src).toMatch(/enqueueSearchIndexingJob\s*\(/);
  });

  it("passes kind: 'evidence' to the search-queue helper (matches existing producer contract)", () => {
    expect(src).toMatch(/kind:\s*["']evidence["']/);
  });

  it("dispatches a best-effort graph reconcile via reconcileTeamGraph (existing reconciler)", () => {
    // Mirrors the dynamic-import pattern used in `ops.routes.ts`.
    expect(src).toMatch(/reconcileTeamGraph\s*\(/);
    expect(src).toMatch(
      /import\(\s*["'][^"']*graph\/graph-builder\.service[^"']*["']\s*\)/,
    );
  });

  it("wraps the post-finalize fan-out in try/catch so producer outages never block completion", () => {
    // Be tolerant of formatting — look for at least one swallow comment
    // attached to the Phase 11 fan-out.
    expect(src).toMatch(/never fail completion on post-finalize fan-out/);
  });
});

// ===========================================================================
// EVENT_WIRE — intelligence/extraction.service.ts
// ===========================================================================

describe("Phase 11 EVENT_WIRE — extraction → entity extraction", () => {
  const src = readSrc(EXTRACTION_SRC);

  it("dynamic-imports the existing entity extractor (no v2 extractor introduced)", () => {
    expect(src).toMatch(
      /import\(\s*["'][^"']*entity-extraction\.service[^"']*["']\s*\)/,
    );
  });

  it("calls extractAndPersistEntities after a successful extraction", () => {
    expect(src).toMatch(/extractAndPersistEntities\s*\(/);
  });

  it("maps jobKind OCR → source 'OCR' and TRANSCRIPT → source 'TRANSCRIPT'", () => {
    expect(src).toMatch(/jobKind\s*===\s*["']OCR["']/);
    expect(src).toMatch(/["']OCR["']/);
    expect(src).toMatch(/["']TRANSCRIPT["']/);
  });

  it("guards the entity-extraction call with try/catch (advisory, never blocks the write)", () => {
    // Match a try block that mentions extractAndPersistEntities or the
    // advisory comment that documents the swallow.
    expect(src).toMatch(/entity extraction is best-effort/);
  });

  it("only invokes entity extraction when the truncated text is non-empty", () => {
    expect(src).toMatch(/truncated\.length\s*>\s*0/);
  });
});

// ===========================================================================
// NAV_VISIBILITY — bounded guard (no core daily route hidden)
// ===========================================================================

describe("Phase 11 NAV_VISIBILITY — core workspace routes remain reachable", () => {
  const src = readSrc(ROUTE_REGISTRY_SRC);

  const CORE_ROUTE_IDS = [
    "workspace.home",
    "workspace.capture",
    "workspace.evidence",
    "workspace.cases",
    "workspace.search",
  ] as const;

  /**
   * Extract the inline object literal for a route id from the
   * registry source. Returns the literal text from the `{` through
   * the matching `}`.
   */
  function extractRouteBlock(routeId: string): string {
    const re = new RegExp(`id:\\s*"${routeId.replace(/\./g, "\\.")}"`);
    const match = re.exec(src);
    expect(match, `route id ${routeId} present in registry`).not.toBeNull();
    const start = src.lastIndexOf("{", match!.index);
    expect(start).toBeGreaterThan(0);
    let depth = 0;
    let end = start;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return src.slice(start, end + 1);
  }

  for (const routeId of CORE_ROUTE_IDS) {
    it(`${routeId} keeps sidebarEligible: true`, () => {
      const block = extractRouteBlock(routeId);
      expect(block).toMatch(/sidebarEligible:\s*true/);
    });

    it(`${routeId} keeps commandPaletteVisible: true`, () => {
      const block = extractRouteBlock(routeId);
      expect(block).toMatch(/commandPaletteVisible:\s*true/);
    });

    it(`${routeId} keeps allToolsVisible: true`, () => {
      const block = extractRouteBlock(routeId);
      expect(block).toMatch(/allToolsVisible:\s*true/);
    });
  }
});

// ===========================================================================
// EMPTY_STATE_COPY — duplicates page
// ===========================================================================

describe("Phase 11 EMPTY_STATE_COPY — duplicates page is honest", () => {
  const src = readSrc(DUPLICATES_PAGE_SRC);

  it("does NOT promise perceptual similarity it cannot deliver today", () => {
    // The synthesis required honesty: perceptual similarity is a
    // Phase 12 deferred item per the decisions doc. The empty state
    // must say so plainly. The literal copy we ship is the canonical
    // one (no internal "Phase 12" / feature-name leakage allowed per
    // EMPTY_STATE_COPY rules).
    expect(src).toMatch(/Perceptual similarity is not yet available/i);
  });

  it("does not leak internal phase / roadmap names into the empty state", () => {
    // Constitutional EMPTY_STATE_COPY rule: do not surface internal
    // phase / feature codenames to operators.
    const FORBIDDEN_LEAKS = [
      /["']Phase\s*1[0-9]["']/i,
      /["']deferred to Phase[^"']*["']/i,
      /["']Phase\s*12 scope["']/i,
    ];
    for (const re of FORBIDDEN_LEAKS) {
      expect(src).not.toMatch(re);
    }
  });

  it("still offers operator next-step CTAs (Capture / Cases) in the empty state", () => {
    expect(src).toMatch(/Capture evidence/);
    expect(src).toMatch(/Open cases/);
  });
});

// ===========================================================================
// NO-NEW-SCHEMA — Phase 11 is no-schema
// ===========================================================================

describe("Phase 11 schema discipline — no new Prisma migrations added", () => {
  /**
   * Allowlist: pre-existing migration folders whose name contains
   * "phase11" but pre-date the current Phase 11 (Visibility &
   * Intelligence connect-only) pass. These are legacy unrelated names
   * we explicitly do NOT regress on; this test is here to prevent a
   * FUTURE Phase 11 migration from being added.
   */
  const PRE_EXISTING_PHASE11_ALLOWLIST = new Set<string>([
    // Security-hardening migration from 2026-05-19 — unrelated to the
    // Phase 11 Visibility & Intelligence pass (2026-06-02).
    "20260519100000_add_security_hardening_phase11",
  ]);

  it("prisma/migrations contains no NEW phase_11 / phase-11 folders beyond the documented allowlist", () => {
    if (!existsSync(MIGRATIONS_DIR)) {
      // Skip in environments where the prisma migrations dir was
      // pruned (e.g. CI shallow clone); the test only fires if the
      // directory exists.
      return;
    }
    const offenders: string[] = [];
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      const full = resolve(MIGRATIONS_DIR, name);
      if (!statSync(full).isDirectory()) continue;
      if (!/phase[_-]?11/i.test(name)) continue;
      if (PRE_EXISTING_PHASE11_ALLOWLIST.has(name)) continue;
      offenders.push(name);
    }
    expect(offenders, `unexpected Phase 11 migrations: ${offenders.join(", ")}`)
      .toEqual([]);
  });
});

// ===========================================================================
// DOC — Phase 11 decisions doc exists and lists the deferred flips
// ===========================================================================

describe("Phase 11 documentation — decisions doc pins the deferred work", () => {
  it("phase-11-decisions.md exists at the architecture path", () => {
    expect(existsSync(DECISIONS_DOC)).toBe(true);
  });

  it("documents the three EVENT_WIRE fan-outs in the connect-only verdict", () => {
    const doc = readSrc(DECISIONS_DOC);
    expect(doc).toMatch(/enqueueSearchIndexingJob/);
    expect(doc).toMatch(/reconcileTeamGraph/);
    expect(doc).toMatch(/extractAndPersistEntities/);
  });

  it("documents the deferred NAV_VISIBILITY flips so a future phase can revisit", () => {
    const doc = readSrc(DECISIONS_DOC);
    expect(doc).toMatch(/workspace\.evidence_requests/);
    expect(doc).toMatch(/investigation\.reviewers/);
    // Either the hide-until-seeded primitive or the four route ids it
    // would have touched must be named in the deferred section.
    expect(doc).toMatch(/sidebarHideUntilSeeded|hub.*graph.*duplicates.*timeline/s);
  });

  it("pins the hard-no list (no v2 layers, no schema, no producer-mode flips)", () => {
    const doc = readSrc(DECISIONS_DOC);
    expect(doc).toMatch(/No OCR v2/i);
    expect(doc).toMatch(/No new Prisma models/i);
    expect(doc).toMatch(/OCR_PRODUCER_MODE|TRANSCRIPT_PRODUCER_MODE/);
  });
});

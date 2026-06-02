/**
 * Phase 12 — Investigation Productization source-contract test.
 *
 * Phase 12 was a "make existing intelligence systems USER-FACING and
 * CONNECTED" pass (see
 * `docs/architecture/phase-12-productization-final.md`).  It deliberately
 * did NOT introduce v2 layers for OCR, transcript, entity extraction,
 * graph, timeline, search, or similarity.  It ONLY:
 *
 *   1. UI_SURFACE_EXISTING_DATA — `apps/web/app/(app)/evidence/[id]/page.tsx`
 *      reads the existing `/v1/intelligence/evidence/:id` endpoint via a
 *      typed client and renders an Intelligence section that mounts
 *      `EntityChipGroup` + an extracted-text summary block.
 *
 *   2. UI_SURFACE_EXISTING_DATA — `apps/web/app/(app)/investigation/page.tsx`
 *      mounts additive `Reviewer activity` + `Indexing progress` sections
 *      that read the existing `/v1/investigation/reviewers` endpoint.
 *
 *   3. NEW_TYPED_API_CLIENT — `apps/web/lib/api/intelligence.ts` exports a
 *      typed `fetchEvidenceIntelligence` client + a typed response shape.
 *
 *   4. NEW_DISPLAY_COMPONENT — `apps/web/components/intelligence/EntityChipGroup.tsx`
 *      exports a display-only entity-chip component.
 *
 *   5. NEW_DISPLAY_COMPONENT (inline) — `apps/web/app/(app)/investigation/relationships/page.tsx`
 *      renders a `System-detected` vs `Manually recorded` indicator on
 *      `NodeInspector` incident edges.
 *
 *   6. NEW_MIGRATION_PERCEPTUAL — additive migration
 *      `20260606120000_phase12_perceptual_foundation` adds two nullable
 *      `VARCHAR(16)` columns + two partial indexes on `evidence_parts`,
 *      mirrored in `prisma/schema.prisma` as `perceptualPhash` /
 *      `perceptualDhash` with `@@map("evidence_parts")`.
 *
 *   7. NEW_WORKER_PERCEPTUAL — `services/worker/src/queue.ts` adds
 *      `compute_perceptual_hashes` to the `MediaIntelligenceJobKind`
 *      union, and `services/worker/src/media-intelligence.processor.ts`
 *      handles that branch via the existing
 *      `processMediaIntelligenceJob` entry point (wired from `index.ts`
 *      onto the existing `mediaIntelligenceQueue`).
 *
 *   8. RECONCILER — `packages/shared-runtime/src/graph/graph-builder.service.ts`
 *      writes `SIMILAR_TO` edges from the new perceptual-hash columns.
 *
 * Bounded guards (forbidden by the Phase 12 ground rules):
 *   * NO new file named `ocr-v2.ts`, `transcript-v2.ts`, `graph-v2.ts`,
 *     `search-v2.ts`, `similarity-v2.ts` anywhere in
 *     `services/api/src/services` (these are the v2 duplicate sentinel
 *     names from the Phase 12 plan).
 *   * NO new path that contains `v2` for the same capability families.
 *   * NO NEW Prisma migration directory beyond the single Phase 12 one
 *     (`20260606120000_phase12_perceptual_foundation`).  The audit is
 *     bounded to the Phase-12 timestamp window only.
 *
 * Style: source-contract (file-text fs.readFileSync), matching
 * `phase-7-team-vs-workspace-anti-confusion.test.ts` and
 * `phase-11-visibility-and-intelligence.test.ts`.
 *
 * Production code is the source of truth — this test never drives code
 * changes from the test author.  Assertions are deliberately tolerant of
 * formatting / argument-order variation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_ROOT = resolve(REPO_ROOT, "apps/web");
const WORKER_ROOT = resolve(REPO_ROOT, "services/worker");
const SHARED_RUNTIME_ROOT = resolve(REPO_ROOT, "packages/shared-runtime");

const EVIDENCE_DETAIL_PAGE = resolve(
  WEB_ROOT,
  "app/(app)/evidence/[id]/page.tsx",
);
const INVESTIGATION_PAGE = resolve(
  WEB_ROOT,
  "app/(app)/investigation/page.tsx",
);
const RELATIONSHIPS_PAGE = resolve(
  WEB_ROOT,
  "app/(app)/investigation/relationships/page.tsx",
);
const INTELLIGENCE_CLIENT = resolve(WEB_ROOT, "lib/api/intelligence.ts");
const ENTITY_CHIP_GROUP = resolve(
  WEB_ROOT,
  "components/intelligence/EntityChipGroup.tsx",
);
const SCHEMA_PRISMA = resolve(API_ROOT, "prisma/schema.prisma");
const MIGRATIONS_DIR = resolve(API_ROOT, "prisma/migrations");
const PHASE_12_MIGRATION_DIR = resolve(
  MIGRATIONS_DIR,
  "20260606120000_phase12_perceptual_foundation",
);
const PHASE_12_MIGRATION_SQL = resolve(
  PHASE_12_MIGRATION_DIR,
  "migration.sql",
);
const WORKER_QUEUE = resolve(WORKER_ROOT, "src/queue.ts");
const WORKER_PROCESSOR = resolve(
  WORKER_ROOT,
  "src/media-intelligence.processor.ts",
);
const WORKER_INDEX = resolve(WORKER_ROOT, "src/index.ts");
const GRAPH_BUILDER = resolve(
  SHARED_RUNTIME_ROOT,
  "src/graph/graph-builder.service.ts",
);
const SERVICES_DIR = resolve(API_ROOT, "src/services");

function readSrc(path: string): string {
  return readFileSync(path, "utf8");
}

// ===========================================================================
// UI_SURFACE_EXISTING_DATA — evidence detail page mounts the typed client +
// the EntityChipGroup display component.
// ===========================================================================

describe("Phase 12 UI_SURFACE_EXISTING_DATA — evidence detail intelligence section", () => {
  const src = readSrc(EVIDENCE_DETAIL_PAGE);

  it("imports the new typed intelligence client (fetchEvidenceIntelligence)", () => {
    expect(src).toMatch(/fetchEvidenceIntelligence/);
    expect(src).toMatch(
      /from\s+["'][^"']*lib\/api\/intelligence["']/,
    );
  });

  it("imports the typed IntelligenceEvidenceResponse projection", () => {
    expect(src).toMatch(/IntelligenceEvidenceResponse/);
  });

  it("imports the new EntityChipGroup display component", () => {
    expect(src).toMatch(/EntityChipGroup/);
    expect(src).toMatch(
      /from\s+["'][^"']*components\/intelligence\/EntityChipGroup["']/,
    );
  });

  it("mounts <EntityChipGroup entities={...} /> in the overview tab", () => {
    expect(src).toMatch(/<EntityChipGroup[\s\S]{0,200}entities=/);
  });

  it("calls fetchEvidenceIntelligence(evidenceId, teamId) to hydrate the projection", () => {
    expect(src).toMatch(/fetchEvidenceIntelligence\s*\(/);
  });
});

// ===========================================================================
// UI_SURFACE_EXISTING_DATA — investigation overview gains Reviewer activity +
// Indexing progress sections.
// ===========================================================================

describe("Phase 12 UI_SURFACE_EXISTING_DATA — investigation overview surfaces", () => {
  const src = readSrc(INVESTIGATION_PAGE);

  it("reads from the existing /v1/investigation/reviewers endpoint (no new endpoint)", () => {
    expect(src).toMatch(/\/v1\/investigation\/reviewers/);
  });

  it("renders a Reviewer activity section heading", () => {
    expect(src).toMatch(/Reviewer activity/);
  });

  it("renders an Indexing progress section heading", () => {
    expect(src).toMatch(/Indexing progress/);
  });

  it("links to the dedicated reviewer console (does not duplicate it)", () => {
    expect(src).toMatch(/href=["']\/investigation\/reviewers["']/);
  });
});

// ===========================================================================
// NEW_TYPED_API_CLIENT — apps/web/lib/api/intelligence.ts
// ===========================================================================

describe("Phase 12 NEW_TYPED_API_CLIENT — intelligence client", () => {
  it("the client file exists", () => {
    expect(existsSync(INTELLIGENCE_CLIENT)).toBe(true);
  });

  const src = readSrc(INTELLIGENCE_CLIENT);

  it("exports the typed fetchEvidenceIntelligence function", () => {
    expect(src).toMatch(/export\s+async\s+function\s+fetchEvidenceIntelligence/);
  });

  it("exports the IntelligenceEvidenceResponse type", () => {
    expect(src).toMatch(/export\s+type\s+IntelligenceEvidenceResponse/);
  });

  it("exports the IntelligenceEntity type", () => {
    expect(src).toMatch(/export\s+type\s+IntelligenceEntity/);
  });

  it("calls the EXISTING /v1/intelligence/evidence/:id endpoint (no new route)", () => {
    expect(src).toMatch(/\/v1\/intelligence\/evidence\//);
  });

  it("uses the existing apiFetch helper (no bespoke fetch layer)", () => {
    expect(src).toMatch(/apiFetch/);
  });
});

// ===========================================================================
// NEW_DISPLAY_COMPONENT — apps/web/components/intelligence/EntityChipGroup.tsx
// ===========================================================================

describe("Phase 12 NEW_DISPLAY_COMPONENT — EntityChipGroup", () => {
  it("the component file exists", () => {
    expect(existsSync(ENTITY_CHIP_GROUP)).toBe(true);
  });

  const src = readSrc(ENTITY_CHIP_GROUP);

  it("exports a named EntityChipGroup component", () => {
    expect(src).toMatch(/export\s+function\s+EntityChipGroup/);
  });

  it("exports a default EntityChipGroup binding for ergonomic imports", () => {
    expect(src).toMatch(/export\s+default\s+EntityChipGroup/);
  });

  it("imports the typed IntelligenceEntity from the new client (no duplicate type)", () => {
    expect(src).toMatch(/IntelligenceEntity/);
    expect(src).toMatch(/from\s+["'][^"']*lib\/api\/intelligence["']/);
  });
});

// ===========================================================================
// NEW_DISPLAY_COMPONENT (inline) — System/Manual badge on NodeInspector.
// ===========================================================================

describe("Phase 12 NEW_DISPLAY_COMPONENT — System/Manual edge-source indicator", () => {
  const src = readSrc(RELATIONSHIPS_PAGE);

  it("renders the 'System-detected' label for SYSTEM edges", () => {
    expect(src).toMatch(/System-detected/);
  });

  it("renders the 'Manually recorded' label for MANUAL edges", () => {
    expect(src).toMatch(/Manually recorded/);
  });

  it("discriminates on edge.sourceKind === 'SYSTEM'", () => {
    expect(src).toMatch(/sourceKind\s*===\s*["']SYSTEM["']/);
  });
});

// ===========================================================================
// NEW_MIGRATION_PERCEPTUAL — additive migration + schema mirror.
// ===========================================================================

describe("Phase 12 NEW_MIGRATION_PERCEPTUAL — additive migration", () => {
  it("the Phase 12 migration directory exists", () => {
    expect(existsSync(PHASE_12_MIGRATION_DIR)).toBe(true);
    expect(statSync(PHASE_12_MIGRATION_DIR).isDirectory()).toBe(true);
  });

  it("the migration.sql file exists inside the directory", () => {
    expect(existsSync(PHASE_12_MIGRATION_SQL)).toBe(true);
  });

  const sql = readSrc(PHASE_12_MIGRATION_SQL);

  it("adds the perceptual_phash column with ADD COLUMN IF NOT EXISTS and a terminating ;", () => {
    expect(sql).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"perceptual_phash"[\s\S]*?VARCHAR\(16\)[^;]*;/i,
    );
  });

  it("adds the perceptual_dhash column with ADD COLUMN IF NOT EXISTS and a terminating ;", () => {
    expect(sql).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"perceptual_dhash"[\s\S]*?VARCHAR\(16\)[^;]*;/i,
    );
  });

  it("creates the per-column phash index with CREATE INDEX IF NOT EXISTS and a terminating ;", () => {
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"evidence_parts_perceptual_phash_idx"[\s\S]*?;/i,
    );
  });

  it("creates the per-column dhash index with CREATE INDEX IF NOT EXISTS and a terminating ;", () => {
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"evidence_parts_perceptual_dhash_idx"[\s\S]*?;/i,
    );
  });

  it("performs NO destructive operations (no DROP TABLE / DROP COLUMN / RENAME) in executable SQL", () => {
    // Strip SQL `--` line comments before scanning so a comment that
    // documents the additive intent ("No DROP / RENAME") does not
    // trip the destructive-operation guard.
    const executable = sql
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(executable).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(executable).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(executable).not.toMatch(/\bRENAME\b/i);
  });
});

describe("Phase 12 NEW_MIGRATION_PERCEPTUAL — schema.prisma mirror", () => {
  const schema = readSrc(SCHEMA_PRISMA);

  it("declares perceptualPhash mapped to perceptual_phash", () => {
    expect(schema).toMatch(
      /perceptualPhash[\s\S]{0,80}@map\(\s*"perceptual_phash"\s*\)/,
    );
  });

  it("declares perceptualDhash mapped to perceptual_dhash", () => {
    expect(schema).toMatch(
      /perceptualDhash[\s\S]{0,80}@map\(\s*"perceptual_dhash"\s*\)/,
    );
  });

  it("retains the canonical @@map(\"evidence_parts\") table mapping", () => {
    expect(schema).toMatch(/@@map\(\s*"evidence_parts"\s*\)/);
  });

  it("indexes perceptualPhash on EvidencePart", () => {
    expect(schema).toMatch(/@@index\(\s*\[\s*perceptualPhash\s*\]\s*\)/);
  });

  it("indexes perceptualDhash on EvidencePart", () => {
    expect(schema).toMatch(/@@index\(\s*\[\s*perceptualDhash\s*\]\s*\)/);
  });
});

// ===========================================================================
// NEW_WORKER_PERCEPTUAL — queue type + processor + producer wiring.
// ===========================================================================

describe("Phase 12 NEW_WORKER_PERCEPTUAL — compute_perceptual_hashes job", () => {
  it("services/worker/src/queue.ts adds compute_perceptual_hashes to MediaIntelligenceJobKind", () => {
    const src = readSrc(WORKER_QUEUE);
    expect(src).toMatch(/MediaIntelligenceJobKind/);
    expect(src).toMatch(/["']compute_perceptual_hashes["']/);
  });

  it("services/worker/src/media-intelligence.processor.ts handles the compute_perceptual_hashes branch", () => {
    const src = readSrc(WORKER_PROCESSOR);
    expect(src).toMatch(
      /kind\s*===\s*["']compute_perceptual_hashes["']/,
    );
  });

  it("the perceptual-hash worker persists into the new evidence_parts columns", () => {
    const src = readSrc(WORKER_PROCESSOR);
    expect(src).toMatch(/perceptual_phash/);
    expect(src).toMatch(/perceptual_dhash/);
  });

  it("services/worker/src/index.ts wires the existing processMediaIntelligenceJob (no new BullMQ queue)", () => {
    const src = readSrc(WORKER_INDEX);
    expect(src).toMatch(/processMediaIntelligenceJob/);
    expect(src).toMatch(/mediaIntelligenceQueue/);
  });
});

// ===========================================================================
// RECONCILER — SIMILAR_TO edge writer in graph-builder.service.ts.
// ===========================================================================

describe("Phase 12 RECONCILER — SIMILAR_TO edge writer", () => {
  const src = readSrc(GRAPH_BUILDER);

  it("emits SIMILAR_TO edges from the reconciler (not a new graph layer)", () => {
    expect(src).toMatch(/SIMILAR_TO/);
  });

  it("references the perceptual-hash columns from the existing reconciler", () => {
    // Tolerate either snake_case (raw SQL) or camelCase (Prisma).
    expect(src).toMatch(/perceptual_phash|perceptualPhash/);
  });
});

// ===========================================================================
// Bounded GUARD — no v2 duplicate files for any intelligence capability.
// ===========================================================================

describe("Phase 12 GUARD — no v2 duplicate intelligence files", () => {
  const FORBIDDEN_V2_FILES = [
    resolve(SERVICES_DIR, "ocr-v2.ts"),
    resolve(SERVICES_DIR, "transcript-v2.ts"),
    resolve(SERVICES_DIR, "entity-v2.ts"),
    resolve(SERVICES_DIR, "graph-v2.ts"),
    resolve(SERVICES_DIR, "search-v2.ts"),
    resolve(SERVICES_DIR, "similarity-v2.ts"),
    resolve(SERVICES_DIR, "timeline-v2.ts"),
  ];

  for (const path of FORBIDDEN_V2_FILES) {
    it(`forbids the v2 duplicate file ${path}`, () => {
      expect(existsSync(path)).toBe(false);
    });
  }
});

describe("Phase 12 GUARD — no v2 paths for intelligence capabilities anywhere", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (
          name === "node_modules" ||
          name === ".next" ||
          name === "dist" ||
          name === "build" ||
          name === ".turbo"
        ) {
          continue;
        }
        out.push(...walk(full));
        continue;
      }
      if (
        name.endsWith(".ts") ||
        name.endsWith(".tsx") ||
        name.endsWith(".js")
      ) {
        out.push(full);
      }
    }
    return out;
  }

  // The Phase 12 ground rules forbid a second layer for these
  // capability families.  The guard greps the API source tree for
  // filenames whose basename contains both the capability noun and
  // the literal `v2` token — that catches `ocr-v2.ts`, `graph.v2.ts`,
  // `searchV2.ts`, etc.  It deliberately allows the legitimate
  // `route.ts` patterns where v2 might appear as a route prefix.
  const FORBIDDEN_BASENAMES = /(ocr|transcript|entity|graph|search|similarity|timeline)[._-]?v2\b/i;

  it("no NEW source file's basename matches the v2-of-an-intelligence-capability pattern", () => {
    const apiSrc = resolve(API_ROOT, "src");
    const files = walk(apiSrc);
    const offenders = files
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const base = p.split("/").pop() ?? "";
        return FORBIDDEN_BASENAMES.test(base);
      });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// ===========================================================================
// Bounded GUARD — exactly ONE Phase 12 Prisma migration directory.
// ===========================================================================

describe("Phase 12 GUARD — exactly one additive Phase 12 migration", () => {
  it("the migrations directory contains exactly one entry matching the Phase 12 sentinel name", () => {
    const entries = readdirSync(MIGRATIONS_DIR);
    const phase12 = entries.filter((name) =>
      /^\d+_phase12_/i.test(name),
    );
    expect(phase12, phase12.join("\n")).toEqual([
      "20260606120000_phase12_perceptual_foundation",
    ]);
  });

  it("no other migration directory was added in the Phase 12 timestamp window (20260606120000)", () => {
    // Defensive: confirm no sibling migration shares the exact Phase
    // 12 prefix (which would imply a second additive migration snuck
    // in under the same timestamp shape).
    const entries = readdirSync(MIGRATIONS_DIR);
    const siblings = entries.filter((name) =>
      name.startsWith("20260606120000_"),
    );
    expect(siblings, siblings.join("\n")).toEqual([
      "20260606120000_phase12_perceptual_foundation",
    ]);
  });
});

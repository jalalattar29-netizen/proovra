/**
 * Phase 31.13 — Derived Assets Pipeline source-contract + behaviour.
 *
 * End-to-end source-contract tests for the derived-assets layer.
 *
 * Layers covered:
 *   1. SQL drift patch — table shape, bounded CHECKs, separate
 *      hash columns, storage_bucket/key columns exist (worker
 *      needs them) BUT must never be projected by API.
 *   2. Persistence service — never throws, anti-leak read shape.
 *   3. API queue helper — idempotent enqueue, bounded retry, lazy
 *      Redis init.
 *   4. Worker processor — canonical prisma import, capability
 *      detection wired, bounded range fetch (4MB), separate SHA-256,
 *      derived bytes stored under derived-assets prefix, originals
 *      never mutated.
 *   5. Worker capability module — never throws, cached, returns
 *      bounded result.
 *   6. API routes — GET projection has no storage internals, POST
 *      trigger bounded auth + idempotent.
 *   7. UI hook + panel — bounded shape, polling clamp, no
 *      forbidden vocabulary, no storage internals, no signed URLs.
 *   8. Worker bootstrap — derived-assets worker registered via
 *      safeRegisterWorker; isolated from the media-intelligence
 *      worker; no crash can cascade.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — SQL drift patch
// =============================================================================

describe("Phase 31.13 — evidence_part_derived_assets SQL drift patch", () => {
  const sql = readSource(
    "../../../services/api/sql/drift-patches/2026-05-20-evidence-part-derived-assets.sql",
  );

  it("BEGIN/COMMIT for partial-state safety", () => {
    expect(sql).toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("idempotent CREATE TABLE", () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"evidence_part_derived_assets"/,
    );
  });

  it("asset_kind CHECK bounded to known catalog", () => {
    const block = sql.match(
      /CONSTRAINT "evidence_part_derived_assets_kind_bounded"[\s\S]*?\)\)/,
    )?.[0];
    expect(block).toBeTruthy();
    for (const k of [
      "'image_thumbnail'",
      "'video_frame'",
      "'audio_waveform'",
      "'low_res_proxy'",
      "'compact_review_preview'",
    ]) {
      expect(block!, `kind ${k} missing`).toContain(k);
    }
  });

  it("status CHECK bounded to lifecycle catalog including UNSUPPORTED", () => {
    const block = sql.match(
      /CONSTRAINT "evidence_part_derived_assets_status_bounded"[\s\S]*?\)\)/,
    )?.[0];
    expect(block).toBeTruthy();
    for (const s of [
      "'PENDING'",
      "'PROCESSING'",
      "'COMPLETED'",
      "'FAILED'",
      "'UNSUPPORTED'",
    ]) {
      expect(block!, `status ${s} missing`).toContain(s);
    }
  });

  it("derived_sha256 column exists + source_sha256_at_generation captures source-at-generation", () => {
    expect(sql).toMatch(/"derived_sha256"\s+VARCHAR\(64\)/);
    expect(sql).toMatch(/"source_sha256_at_generation"\s+VARCHAR\(64\)/);
  });

  it("size cap (50MB) + dimensions cap (200000 px) to prevent runaway storage", () => {
    expect(sql).toMatch(/"size_bytes" >= 0 AND "size_bytes" <= 50000000/);
    expect(sql).toMatch(
      /"width_px" > 0 AND "width_px" <= 200000/,
    );
    expect(sql).toMatch(
      /"height_px" > 0 AND "height_px" <= 200000/,
    );
  });

  it("per-team unique on (evidence_part_id, asset_kind)", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "evidence_part_derived_assets_team_part_kind_uk"[\s\S]*?\("team_id", "evidence_part_id", "asset_kind"\)/,
    );
  });

  it("schema-validation registers the new table + key column + index", () => {
    const src = readSource(
      "../src/runtime/schema-validation.ts",
    );
    expect(src).toContain('name: "evidence_part_derived_assets"');
    expect(src).toContain(
      'indexName: "evidence_part_derived_assets_team_part_kind_uk"',
    );
  });
});

// =============================================================================
// PART 2 — Persistence service
// =============================================================================

describe("Phase 31.13 — derived assets persistence service", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/media-intelligence/derived-assets.service.ts",
  );

  it("upsert keyed by (team_id, evidence_part_id, asset_kind) — idempotent", () => {
    expect(src).toMatch(
      /ON CONFLICT \("team_id", "evidence_part_id", "asset_kind"\) DO UPDATE/,
    );
  });

  it("read projection NEVER includes storage internals", () => {
    const projectRowFn = src.match(
      /function projectRow\([\s\S]*?\n\}/,
    )?.[0];
    expect(projectRowFn, "projectRow function found").toBeTruthy();
    for (const banned of [
      "storage_bucket",
      "storage_key",
      "storageBucket",
      "storageKey",
      "signedUrl",
      "signed_url",
      "presignedUrl",
    ]) {
      expect(
        projectRowFn!,
        `projectRow leaks ${banned}`,
      ).not.toContain(banned);
    }
  });

  it("read SQL SELECT clause does NOT request storage_bucket / storage_key", () => {
    const listFn = src.match(
      /export async function listDerivedAssetsForEvidence[\s\S]*?\n\}/,
    )?.[0];
    expect(listFn).toBeTruthy();
    expect(listFn!).not.toContain('"storage_bucket"');
    expect(listFn!).not.toContain('"storage_key"');
  });

  it("worker-side storage reference helper exists + is name-prefixed with _ (internal only)", () => {
    // The byte-serving helper IS named with a leading underscore to
    // signal "internal use; not for API routes" — defence in depth.
    expect(src).toMatch(/export async function _getDerivedAssetStorageReference/);
  });

  it("never throws — every code path returns a bounded result", () => {
    for (const fn of [
      "recordDerivedAsset",
      "listDerivedAssetsForEvidence",
      "_getDerivedAssetStorageReference",
    ]) {
      const block = src.match(
        new RegExp(`export async function ${fn}\\([\\s\\S]*?\\n\\}`),
      )?.[0];
      expect(block, `${fn} found`).toBeTruthy();
      expect(block!).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
    }
  });

  it("sanitizeError strips control codes + URLs + bounds to 240 chars", () => {
    const fn = src.match(/function sanitizeError[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/replace\(\/\[\\n\\r\\t\]\/g/);
    expect(fn!).toMatch(/replace\(\/https\?:\\\/\\\/\[\^\\s\]\+\/g/);
    expect(fn!).toMatch(/slice\(0,\s*240\)/);
  });
});

// =============================================================================
// PART 3 — API queue helper
// =============================================================================

describe("Phase 31.13 — API derived-assets queue helper", () => {
  const src = readSource("../src/queue/derived-assets-queue.ts");

  /**
   * PHASE 12 — POINT 5 replaced this module's private transport, job id and
   * collapse ladder with the shared authority, and gave the chain the durable
   * row it always needed.
   *
   * The old payload was `{ teamId, evidenceId, evidencePartId, assetKind }` and
   * the processor believed all four. `teamId` scoped the raw SQL that reads the
   * source bytes, so a tampered value read another workspace's evidence part
   * and wrote the thumbnail back under that asserted tenant.
   */
  it("importing the module without REDIS_URL is safe (lazy transport)", () => {
    expect(src).not.toMatch(/new IORedis\(/);
    expect(src).toMatch(/canonical-queue-client\.js/);
  });

  it("the job id names the DURABLE ROW, not a kind and a part id", () => {
    // `da-<kind>-<partId>` re-encoded two payload fields as an identity.
    // `EvidencePartDerivedAsset` already modelled this work and already had the
    // right unique index on (teamId, evidencePartId, assetKind).
    expect(src).not.toMatch(/`da-\$\{assetKind\}-\$\{evidencePartId\}`/);
    const entry = getWorkEntryOrThrow(JOB_NAMES.GENERATE_DERIVED_ASSET);
    expect(entry.jobIdPrefix).toBe("mi-derived");
    expect(entry.durableAuthority.model).toBe("EvidencePartDerivedAsset");
  });

  it("the request row is committed BEFORE the enqueue, and scoped by a real join", () => {
    // The part must be proven to belong to the caller's workspace through
    // `evidence.team_id` — a restatement of the input would prove nothing.
    expect(src).toMatch(/evidence: \{ teamId: input\.teamId, deletedAt: null \}/);
    expect(src).toMatch(/evidencePartDerivedAsset\.upsert\(/);
    expect(src).toMatch(/evidence_part_not_found/);
    const upsertIdx = src.indexOf("evidencePartDerivedAsset.upsert(");
    const enqueueIdx = src.indexOf("enqueueCanonicalWork(");
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeGreaterThan(upsertIdx);
  });

  it("Redis outage returns { enqueued: false, reason } — never throws", () => {
    // The row stays PENDING, which is recoverable and observable rather than a
    // lost request.
    expect(src).toMatch(/return \{ enqueued: false, reason: outcome\.reason/);
    expect(src).toMatch(/request_persist_failed/);
  });

  it("bumps the right metrics on success + failure", () => {
    expect(src).toMatch(/bump\("derived_assets_enqueue_total"\)/);
    expect(src).toMatch(/bump\("derived_assets_enqueue_failed_total"\)/);
  });
});

// =============================================================================
// PART 4 — Worker processor
// =============================================================================

describe("Phase 31.13 — worker derived-assets processor", () => {
  const src = readSource(
    "../../../services/worker/src/derived-assets.processor.ts",
  );

  it("imports canonical prisma from ./db.js (no bare new PrismaClient)", () => {
    expect(src).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*"\.\/db\.js"/);
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/new\s+PrismaClient\s*\(/);
  });

  it("uses bounded 4MB range fetch (no full-original pull)", () => {
    expect(src).toMatch(/SOURCE_RANGE_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
    expect(src).toMatch(/range:\s*`bytes=0-\$\{SOURCE_RANGE_BYTES - 1\}`/);
  });

  it("256-px max edge thumbnail (bounded output)", () => {
    expect(src).toMatch(/THUMBNAIL_MAX_EDGE_PX\s*=\s*256/);
    expect(src).toMatch(/width:\s*THUMBNAIL_MAX_EDGE_PX/);
    expect(src).toMatch(/withoutEnlargement:\s*true/);
  });

  it("derived bytes stored under separate `derived-assets/` S3 prefix", () => {
    expect(src).toMatch(
      /DERIVED_ASSET_S3_PREFIX\s*=\s*"derived-assets"/,
    );
    expect(src).toMatch(
      /\$\{DERIVED_ASSET_S3_PREFIX\}\/\$\{evidenceId\}\/\$\{evidencePartId\}/,
    );
  });

  it("computes separate SHA-256 of derived bytes", () => {
    expect(src).toMatch(/createHash\("sha256"\)\.update\(derivedBuffer\)\.digest\("hex"\)/);
  });

  it("captures source SHA-256 AT generation time (downstream integrity check)", () => {
    expect(src).toMatch(/sourceSha256AtGeneration:\s*part\.sha256/);
  });

  it("never throws on structural problems (missing part / non-image / no storage ref)", () => {
    // Each structural-problem branch returns success-from-queue.
    expect(src).toMatch(/return\s*\{\s*ok:\s*true,\s*status:\s*"FAILED"\s*\}/);
    expect(src).toMatch(
      /return\s*\{\s*ok:\s*true,\s*status:\s*"UNSUPPORTED"\s*\}/,
    );
  });

  it("capability detection wired — UNSUPPORTED status when sharp unavailable", () => {
    expect(src).toMatch(/detectDerivedAssetCapability\(\)/);
    expect(src).toMatch(/if \(!capability\.ok\)/);
  });

  it("non-image MIME refused at the start (no wasted S3 fetch)", () => {
    expect(src).toMatch(
      /!part\.mime_type\.toLowerCase\(\)\.startsWith\("image\/"\)/,
    );
  });

  it("originals are never mutated — only reads source via getObjectRange, writes to derived prefix", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // The processor must NEVER putObjectBuffer to the source key.
    // Tightened to match only within a single argument object literal
    // (Phase 31.20: previously the non-greedy [\s\S]*? could cross
    // function boundaries when multiple putObjectBuffer calls exist
    // and trip on a `key: part.storage_key` in a *different* call site
    // — typically inside a getObjectRange, which is correct).
    expect(noComments).not.toMatch(
      /putObjectBuffer\(\{[^}]*?key:\s*part\.storage_key/,
    );
  });

  it("uses lowercase table names (evidence_parts / evidence)", () => {
    expect(src).toMatch(/FROM "evidence_parts" p/);
    expect(src).toMatch(/JOIN "evidence" e ON e\."id" = p\."evidence_id"/);
  });

  it("DLQ counter bumped only on final attempt exhaustion", () => {
    expect(src).toMatch(
      /\(job\.attemptsMade \?\? 0\) >= attemptsAllowed - 1[\s\S]*?tryBump\("derived_assets_dlq_total"\)/,
    );
  });
});

// =============================================================================
// PART 5 — Capability detection
// =============================================================================

describe("Phase 31.13 — capability detection", () => {
  const src = readSource(
    "../../../services/worker/src/derived-assets-capability.ts",
  );

  it("cached — first call detects, later calls reuse", () => {
    expect(src).toMatch(/let cached:[\s\S]*?\{\s*ok:\s*true/);
    expect(src).toMatch(/if \(cached !== null\) return cached/);
  });

  it("never throws — every code path returns a bounded result", () => {
    const fn = src.match(
      /export async function detectDerivedAssetCapability[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/try\s*\{[\s\S]*?\}\s*catch[\s\S]*?cached\s*=\s*\{\s*ok:\s*false/);
  });

  it("probes sharp with a 1x1 image (verifies native binary works)", () => {
    expect(src).toMatch(/create:\s*\{[\s\S]*?width:\s*1/);
    expect(src).toMatch(/\.png\(\)/);
    expect(src).toMatch(/\.toBuffer\(\)/);
  });
});

// =============================================================================
// PART 6 — API routes
// =============================================================================

describe("Phase 31.13 — derived-assets API routes", () => {
  const src = readSource(
    "../src/routes/media-intelligence.routes.ts",
  );

  it("GET route registered + gated by authorizeOrFail + antiEnumeration", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/authorizeOrFail/);
    expect(block!).toMatch(/permission:\s*"evidence\.read"/);
    expect(block!).toMatch(/antiEnumeration:\s*true/);
  });

  it("GET route anti-enumeration: cross-team evidence id surfaces 404", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/evidence\.teamId !== teamId/);
    expect(block!).toMatch(/reply\.code\(404\)/);
  });

  it("POST run route requires evidence.update_metadata (not just read)", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/run"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/permission:\s*"evidence\.update_metadata"/);
  });

  it("POST run body is .strict() (no unknown fields)", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/run"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/\.strict\(\)/);
  });

  it("POST run asset kind is bounded (z.enum)", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/run"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/assetKind:\s*z\.enum\(\[/);
    expect(block!).toMatch(/"image_thumbnail"/);
  });
});

// =============================================================================
// PART 7 — UI hook + panel
// =============================================================================

describe("Phase 31.13 — UI hook + panel extension", () => {
  const hookSrc = readSource(
    "../../../apps/web/lib/media-intelligence/useDerivedAssets.ts",
  );
  const panelSrc = readSource(
    "../../../apps/web/components/media-intelligence/MediaIntelligencePanel.tsx",
  );

  it("hook never throws — bounded error state with stable codes", () => {
    const noComments = hookSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/\bthrow\s+new\s+/);
    expect(hookSrc).toMatch(/error:\s*\{\s*code\s*\}/);
  });

  it("polling interval clamped [2000, 60000]", () => {
    expect(hookSrc).toMatch(
      /Math\.max\(2_?000,\s*Math\.min\(60_?000/,
    );
  });

  it("hook only hits the two whitelisted endpoints", () => {
    const noComments = hookSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const apiFetchCalls =
      noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
    expect(apiFetchCalls.length).toBeGreaterThan(0);
    const allowed = [
      "/v1/evidence/${encodeURIComponent(evidenceId)}/derived-assets",
      "/v1/evidence/${encodeURIComponent(evidenceId)}/derived-assets/run",
    ];
    for (const call of apiFetchCalls) {
      const path = call.match(/[`"]([^`"]+)[`"]/)?.[1] ?? "";
      const ok = allowed.some((p) => path.includes(p.split("$")[0]!));
      expect(ok, `unexpected endpoint: ${path}`).toBe(true);
    }
  });

  it("panel renders the DerivedAssetsStrip only when assets exist", () => {
    // JSX may use either `? <X />` or `? ( <X /> )` so allow both.
    expect(panelSrc).toMatch(
      /derived\.state\.assets\.length > 0\s*\?\s*\(?\s*<DerivedAssetsStrip/,
    );
  });

  it("panel categorizes assets by status (completed / failed / unsupported / pending)", () => {
    const strip = panelSrc.match(
      /function DerivedAssetsStrip[\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(strip).toBeTruthy();
    expect(strip!).toMatch(/status === "COMPLETED"/);
    expect(strip!).toMatch(/status === "FAILED"/);
    expect(strip!).toMatch(/status === "UNSUPPORTED"/);
  });

  it("hint mentions advisory + reviewer-safe + not-substitute-for-original", () => {
    const flat = panelSrc.replace(/\s+/g, " ");
    expect(flat).toMatch(/Advisory aids only/);
    expect(flat).toMatch(/preserved original/);
  });

  it("no forbidden vocabulary in panel literals", () => {
    const noComments = panelSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `panel uses forbidden wording: ${lit}`).not.toMatch(
        forbidden,
      );
    }
  });

  it("no storage internals in hook or panel", () => {
    for (const [name, src] of [
      ["hook", hookSrc],
      ["panel", panelSrc],
    ] as const) {
      const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const banned of [
        "storageKey",
        "storage_key",
        "storageBucket",
        "storage_bucket",
        "multipartUploadId",
        "signedUrl",
        "signed_url",
        "presignedUrl",
      ]) {
        expect(noComments, `${name} leaks ${banned}`).not.toContain(banned);
      }
    }
  });
});

// =============================================================================
// PART 8 — Worker bootstrap isolation
// =============================================================================

describe("Phase 31.13 — derived-assets worker bootstrap", () => {
  const indexSrc = readSource(
    "../../../services/worker/src/index.ts",
  );

  it("derived-assets worker registered via safeRegisterWorker", () => {
    expect(indexSrc).toMatch(
      /safeRegisterWorker\(\s*"derived-assets"\s*,\s*\(\)\s*=>/,
    );
  });

  it("WorkerKind union includes 'derived-assets'", () => {
    expect(indexSrc).toMatch(/\|\s*"derived-assets"/);
  });

  it("shutdown null-checks derivedAssetsWorker before close", () => {
    expect(indexSrc).toMatch(
      /if\s*\(derivedAssetsWorker\)\s*\{[\s\S]*?await derivedAssetsWorker\.close/,
    );
  });

  it("shutdown closes derivedAssetsQueue", () => {
    expect(indexSrc).toMatch(/await derivedAssetsQueue\.close\(\)/);
  });
});

// =============================================================================
// PART 9 — Metrics catalog
// =============================================================================

describe("Phase 31.13 — metrics catalog", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers all 7 new derived-assets counters", () => {
    for (const m of [
      "derived_assets_enqueue_total",
      "derived_assets_enqueue_failed_total",
      "derived_assets_processor_started_total",
      "derived_assets_processor_completed_total",
      "derived_assets_processor_failed_total",
      "derived_assets_processor_unsupported_total",
      "derived_assets_dlq_total",
    ]) {
      expect(src, `counter ${m} missing`).toContain(`"${m}"`);
    }
  });

  it("registers derived-assets backlog gauges", () => {
    for (const m of [
      "derived_assets_pending",
      "derived_assets_processing",
      "derived_assets_failed",
      "derived_assets_completed",
      "derived_assets_unsupported",
      "derived_assets_oldest_pending_age_seconds",
    ]) {
      expect(src, `gauge ${m} missing`).toContain(`"${m}"`);
    }
  });
});

// =============================================================================
// PART 10 — Cross-source anti-leak invariants
// =============================================================================

describe("Phase 31.13 — anti-leak across new surfaces", () => {
  const sources = [
    "../../../packages/shared-runtime/src/media-intelligence/derived-assets.service.ts",
    "../src/queue/derived-assets-queue.ts",
    "../../../services/worker/src/derived-assets.processor.ts",
    "../../../services/worker/src/derived-assets-capability.ts",
    "../../../apps/web/lib/media-intelligence/useDerivedAssets.ts",
  ].map(readSource);

  it("no forbidden truth-claim vocabulary in any source literal", () => {
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (let i = 0; i < sources.length; i++) {
      const noComments = sources[i]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const literals = noComments.match(/"[^"\n]+"/g) ?? [];
      for (const lit of literals) {
        expect(lit, `source ${i} forbidden wording: ${lit}`).not.toMatch(
          forbidden,
        );
      }
    }
  });

  it("no signed-URL / multipart-upload-id / raw-GPS / private-note leakage", () => {
    for (let i = 0; i < sources.length; i++) {
      const noComments = sources[i]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const banned of [
        "signedUrl",
        "signed_url",
        "presignedUrl",
        "multipart_upload_id",
        "multipartUploadId",
        "raw_gps",
        "rawGps",
        "privateNote",
        "legalNote",
        "legalNoteBody",
      ]) {
        expect(noComments, `source ${i} leaks ${banned}`).not.toContain(
          banned,
        );
      }
    }
  });
});

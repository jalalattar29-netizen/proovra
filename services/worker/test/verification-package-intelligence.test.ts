/**
 * Phase 31.9 — Verification package advisory intelligence manifests.
 *
 * Tests the bounded behaviour of the manifest builder. The wiring
 * into `createVerificationPackage` is exercised at the source-
 * contract level (no actual zip build; that would require the full
 * signing-key + governance gate harness which exists in
 * report.test.ts).
 *
 * Layers covered:
 *
 *   1. Empty input → empty manifest list (no surprises in package
 *      shape when intelligence is absent).
 *   2. Each manifest emitted only when its corresponding input
 *      array is non-empty.
 *   3. Manifest schemas + versions stable.
 *   4. Bounded list sizes (DoS prevention).
 *   5. Bounded string lengths.
 *   6. Bounded enum values (unknown severities/statuses fold to
 *      safe defaults).
 *   7. Advisory disclaimers present + use safe wording (NO
 *      forbidden vocabulary).
 *   8. Anti-leak source contract — no storage internals, no raw
 *      GPS, no private notes referenced anywhere in the module.
 *   9. Package generator source contract — intelligence manifests
 *      emitted BEFORE the checksums index (so each manifest is
 *      hash-recorded) and after every canonical artifact (so the
 *      base package shape is unchanged for callers that don't
 *      supply intelligence).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildIntelligencePackageManifests,
  buildMediaIntelligenceManifest,
  type IntelligencePackageInput,
} from "../src/verification-package-intelligence.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Empty / null input
// =============================================================================

describe("Phase 31.9 — empty input", () => {
  it("returns an empty array when input is null", () => {
    expect(buildIntelligencePackageManifests(null)).toEqual([]);
  });

  it("returns an empty array when input is undefined", () => {
    expect(buildIntelligencePackageManifests(undefined)).toEqual([]);
  });

  it("returns an empty array when every list is empty", () => {
    const r = buildIntelligencePackageManifests({
      mediaSignals: [],
      derivedAssets: [],
      ocrTranscript: { ocr: [], transcript: [] },
      graphRelationships: [],
      timelineEvents: [],
    });
    expect(r).toEqual([]);
  });

  it("returns an empty array when the OCR/transcript object itself is empty", () => {
    const r = buildIntelligencePackageManifests({
      ocrTranscript: {},
    });
    expect(r).toEqual([]);
  });
});

// =============================================================================
// PART 2 — Selective emission
// =============================================================================

describe("Phase 31.9 — selective emission", () => {
  it("does NOT emit advisory-signals.json / media_intelligence.json for media signals (product removal)", () => {
    // Product decision: the low-value advisory/workspace-correlation
    // output is no longer emitted in the default verification package.
    // ANY mediaSignals input — safe, restricted, or mixed — produces no
    // advisory files. Deterministic technical metadata lives under
    // technical-metadata/ (emitted by a separate builder).
    const r = buildIntelligencePackageManifests({
      mediaSignals: [
        {
          id: "safe-1",
          signalType: "EXIF_MISSING",
          materialId: null,
          severity: "INFO",
          confidence: "MEDIUM",
          safeSummary: "No EXIF metadata was observed.",
          status: "PENDING",
          createdAtUtc: "2026-05-20T00:00:00.000Z",
        },
        {
          id: "restricted-dup",
          signalType: "DUPLICATE_HASH_MATCH",
          materialId: "other-evidence-abc",
          severity: "INFO",
          confidence: "HIGH",
          safeSummary: "Byte-identical material observed elsewhere in workspace.",
          status: "PENDING",
          createdAtUtc: "2026-05-20T00:00:00.000Z",
        },
      ],
    });
    expect(r.find((m) => m.path === "intelligence/advisory-signals.json")).toBeUndefined();
    expect(r.find((m) => m.path === "intelligence/media_intelligence.json")).toBeUndefined();
    // And no workspace-correlation content leaks into the package at all.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("DUPLICATE_HASH_MATCH");
    expect(serialized).not.toContain("other-evidence-abc");
  });

  it("emits ONLY derived_assets_manifest.json when only derived assets are present", () => {
    const r = buildIntelligencePackageManifests({
      derivedAssets: [
        {
          id: "thumb-1",
          assetKind: "image_thumbnail",
          sourceEvidenceId: "evi-1",
          sourceMaterialId: "mat-1",
          sha256: "a".repeat(64),
          sizeBytes: 1024,
          contentType: "image/png",
          createdAtUtc: "2026-05-20T00:00:00.000Z",
        },
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.path).toBe("intelligence/derived_assets_manifest.json");
  });

  it("emits the 4 non-advisory manifests when every input is supplied (advisory removed)", () => {
    // advisory-signals.json + media_intelligence.json are no longer
    // emitted; the remaining manifests are unaffected.
    const r = buildIntelligencePackageManifests(fullInput());
    expect(r.map((m) => m.path).sort()).toEqual([
      "intelligence/derived_assets_manifest.json",
      "intelligence/graph_relationships.json",
      "intelligence/ocr_transcript_manifest.json",
      "intelligence/timeline_manifest.json",
    ]);
  });
});

// =============================================================================
// PART 3 — Schema + version stability
// =============================================================================

describe("Phase 31.9 — manifest schemas", () => {
  it("media_intelligence schema is PROOVRA_PACKAGE_MEDIA_INTELLIGENCE v1", () => {
    const m = build("media_intelligence");
    expect(m.schema).toBe("PROOVRA_PACKAGE_MEDIA_INTELLIGENCE");
    expect(m.version).toBe(1);
  });

  it("derived_assets schema is PROOVRA_PACKAGE_DERIVED_ASSETS v1", () => {
    const m = build("derived_assets");
    expect(m.schema).toBe("PROOVRA_PACKAGE_DERIVED_ASSETS");
    expect(m.version).toBe(1);
    expect(m.algorithm).toBe("SHA-256");
  });

  it("ocr_transcript schema is PROOVRA_PACKAGE_OCR_TRANSCRIPT v1", () => {
    const m = build("ocr_transcript");
    expect(m.schema).toBe("PROOVRA_PACKAGE_OCR_TRANSCRIPT");
    expect(m.version).toBe(1);
  });

  it("graph_relationships schema is PROOVRA_PACKAGE_GRAPH_RELATIONSHIPS v1", () => {
    const m = build("graph_relationships");
    expect(m.schema).toBe("PROOVRA_PACKAGE_GRAPH_RELATIONSHIPS");
    expect(m.version).toBe(1);
  });

  it("timeline schema is PROOVRA_PACKAGE_TIMELINE v1", () => {
    const m = build("timeline");
    expect(m.schema).toBe("PROOVRA_PACKAGE_TIMELINE");
    expect(m.version).toBe(1);
  });

  it("every manifest carries an inline advisory disclaimer", () => {
    for (const kind of [
      "media_intelligence",
      "derived_assets",
      "ocr_transcript",
      "graph_relationships",
      "timeline",
    ] as const) {
      const m = build(kind);
      expect(typeof m.advisory).toBe("string");
      expect((m.advisory as string).length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// PART 4 — Bounded list sizes
// =============================================================================

describe("Phase 31.9 — bounded list sizes", () => {
  it("media_intelligence caps at 200 items", () => {
    const signals = Array.from({ length: 500 }, (_, i) => ({
      id: `sig-${i}`,
      signalType: "EXIF_MISSING",
      materialId: null,
      severity: "INFO" as const,
      confidence: "MEDIUM" as const,
      safeSummary: "x",
      status: "PENDING" as const,
      createdAtUtc: "2026-05-20T00:00:00.000Z",
    }));
    // Advisory output is no longer emitted in the package; assert the
    // retained builder's bound directly.
    const m = buildMediaIntelligenceManifest(signals) as {
      count: number;
      items: unknown[];
    };
    expect(m.items).toHaveLength(200);
    expect(m.count).toBe(200);
  });

  it("graph_relationships caps at 400 items", () => {
    const edges = Array.from({ length: 700 }, (_, i) => ({
      edgeId: `e-${i}`,
      edgeType: "SAME_HASH_AS",
      sourceNodeKind: "EVIDENCE",
      targetNodeKind: "EVIDENCE",
      sourceNodeExternalId: null,
      targetNodeExternalId: null,
      safeSummary: "x",
      createdAtUtc: "2026-05-20T00:00:00.000Z",
    }));
    const r = buildIntelligencePackageManifests({
      graphRelationships: edges,
    });
    const m = r[0]!.json as { items: unknown[] };
    expect(m.items).toHaveLength(400);
  });

  it("timeline caps at 400 events", () => {
    const events = Array.from({ length: 900 }, (_, i) => ({
      id: `ev-${i}`,
      kind: "NODE_CREATED",
      atUtc: "2026-05-20T00:00:00.000Z",
      summary: "x",
      nodeId: "n-1",
      otherNodeId: null,
      edgeType: null,
    }));
    const r = buildIntelligencePackageManifests({ timelineEvents: events });
    const m = r[0]!.json as { events: unknown[] };
    expect(m.events).toHaveLength(400);
  });
});

// =============================================================================
// PART 5 — Bounded string lengths
// =============================================================================

describe("Phase 31.9 — bounded string lengths", () => {
  it("safeSummary is truncated to 240 chars", () => {
    const huge = "x".repeat(1000);
    const m = buildMediaIntelligenceManifest([
      {
        id: "sig-1",
        signalType: "EXIF_MISSING",
        materialId: null,
        severity: "INFO",
        confidence: "MEDIUM",
        safeSummary: huge,
        status: "PENDING",
        createdAtUtc: "2026-05-20T00:00:00.000Z",
      },
    ]) as { items: Array<{ safeSummary: string }> };
    expect(m.items[0]!.safeSummary.length).toBeLessThanOrEqual(240);
  });

  it("identifier fields truncated to 120 chars", () => {
    const huge = "x".repeat(5000);
    const m = buildMediaIntelligenceManifest([
      {
        id: huge,
        signalType: huge,
        materialId: huge,
        severity: "INFO",
        confidence: "MEDIUM",
        safeSummary: "x",
        status: "PENDING",
        createdAtUtc: "2026-05-20T00:00:00.000Z",
      },
    ]) as {
      items: Array<{ id: string; signalType: string; materialId: string }>;
    };
    expect(m.items[0]!.id.length).toBeLessThanOrEqual(120);
    expect(m.items[0]!.signalType.length).toBeLessThanOrEqual(120);
    expect(m.items[0]!.materialId.length).toBeLessThanOrEqual(120);
  });
});

// =============================================================================
// PART 6 — Bounded enums
// =============================================================================

describe("Phase 31.9 — bounded enum values", () => {
  it("unknown severity folds to INFO (safest default)", () => {
    const m = buildMediaIntelligenceManifest([
      {
        id: "sig-1",
        signalType: "EXIF_MISSING",
        materialId: null,
        // @ts-expect-error — intentionally invalid value
        severity: "BREACH",
        confidence: "MEDIUM",
        safeSummary: "x",
        status: "PENDING",
        createdAtUtc: "2026-05-20T00:00:00.000Z",
      },
    ]) as { items: Array<{ severity: string }> };
    expect(m.items[0]!.severity).toBe("INFO");
  });

  it("unknown derived asset kind folds to low_res_proxy", () => {
    const r = buildIntelligencePackageManifests({
      derivedAssets: [
        {
          id: "x",
          // @ts-expect-error — intentionally invalid
          assetKind: "deepfake_thumbnail",
          sourceEvidenceId: "evi",
          sourceMaterialId: null,
          sha256: "a".repeat(64),
          sizeBytes: 1,
          contentType: "image/png",
          createdAtUtc: "2026-05-20T00:00:00.000Z",
        },
      ],
    });
    const m = r[0]!.json as { items: Array<{ assetKind: string }> };
    expect(m.items[0]!.assetKind).toBe("low_res_proxy");
  });
});

// =============================================================================
// PART 7 — Safe wording (no forbidden vocabulary in any field)
// =============================================================================

describe("Phase 31.9 — safe advisory wording", () => {
  const FORBIDDEN =
    /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;

  it("no manifest disclaimer contains forbidden vocabulary", () => {
    const r = buildIntelligencePackageManifests(fullInput());
    for (const entry of r) {
      const advisory = (entry.json as { advisory?: string }).advisory ?? "";
      expect(advisory, `path ${entry.path}`).not.toMatch(FORBIDDEN);
    }
  });

  it("advisory mentions 'advisory' wording explicitly", () => {
    const r = buildIntelligencePackageManifests(fullInput());
    for (const entry of r) {
      const advisory = (entry.json as { advisory?: string }).advisory ?? "";
      expect(advisory).toMatch(/advisory/i);
    }
  });
});

// =============================================================================
// PART 8 — Anti-leak source contract
// =============================================================================

describe("Phase 31.9 — anti-leak source contract", () => {
  const src = readSource("../src/verification-package-intelligence.ts");

  it("no storage internals referenced in any input shape", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "multipartUploadId",
      "multipart_upload_id",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "rawGps",
      "raw_gps",
      "privateNote",
      "private_note",
      "legalNote",
      "legalNoteBody",
    ]) {
      expect(noComments, `intelligence module leaks ${banned}`).not.toContain(
        banned,
      );
    }
  });

  it("no forbidden truth-claim vocabulary in any source literal", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(
        lit,
        `intelligence module uses forbidden wording: ${lit}`,
      ).not.toMatch(forbidden);
    }
  });
});

// =============================================================================
// PART 9 — Package generator wiring (source contract)
// =============================================================================

describe("Phase 31.9 — verification-package wiring", () => {
  const src = readSource("../src/verification-package.ts");

  it("intelligence input field is OPTIONAL (allows undefined and null)", () => {
    expect(src).toMatch(
      /intelligence\?:\s*import\("\.\/verification-package-intelligence\.js"\)\.IntelligencePackageInput\s*\|\s*null/,
    );
  });

  it("manifests emitted BEFORE the checksums index", () => {
    // The checksums index runs SHA-256 over every preceding entry,
    // so manifests must be appended first so each manifest hash is
    // captured in package-checksums.json.
    const idxIntelligence = src.indexOf("buildIntelligencePackageManifests");
    const idxChecksums = src.indexOf("buildPackageChecksums(packageEntries)");
    expect(idxIntelligence).toBeGreaterThan(0);
    expect(idxChecksums).toBeGreaterThan(0);
    expect(idxIntelligence).toBeLessThan(idxChecksums);
  });

  it("package shape unchanged when intelligence is absent (data.intelligence ?? null)", () => {
    // The wiring uses `data.intelligence ?? null` so callers that
    // never set the field get an empty manifest list back — the
    // archive emits zero new files in that case.
    expect(src).toMatch(/buildIntelligencePackageManifests\([\s\S]*?data\.intelligence \?\? null/);
  });

  it("intelligence manifests live in the `intelligence/` subdirectory", () => {
    const moduleSrc = readSource(
      "../src/verification-package-intelligence.ts",
    );
    // advisory-signals.json / media_intelligence.json paths were removed
    // (product decision); the remaining manifests still live under
    // intelligence/.
    expect(moduleSrc).toMatch(
      /path:\s*"intelligence\/derived_assets_manifest\.json"/,
    );
    expect(moduleSrc).toMatch(
      /path:\s*"intelligence\/ocr_transcript_manifest\.json"/,
    );
    expect(moduleSrc).toMatch(
      /path:\s*"intelligence\/graph_relationships\.json"/,
    );
    expect(moduleSrc).toMatch(/path:\s*"intelligence\/timeline_manifest\.json"/);
  });
});

// =============================================================================
// Helpers
// =============================================================================

function fullInput(): IntelligencePackageInput {
  return {
    mediaSignals: [
      {
        id: "sig-1",
        signalType: "EXIF_MISSING",
        materialId: null,
        severity: "INFO",
        confidence: "MEDIUM",
        safeSummary: "No EXIF metadata was observed on this material.",
        status: "PENDING",
        createdAtUtc: "2026-05-20T00:00:00.000Z",
      },
    ],
    derivedAssets: [
      {
        id: "thumb-1",
        assetKind: "image_thumbnail",
        sourceEvidenceId: "evi-1",
        sourceMaterialId: "mat-1",
        sha256: "a".repeat(64),
        sizeBytes: 2048,
        contentType: "image/png",
        createdAtUtc: "2026-05-20T00:00:00.000Z",
      },
    ],
    ocrTranscript: {
      ocr: [
        {
          materialId: "mat-1",
          availability: "AVAILABLE",
          indexed: true,
          extractedAtUtc: "2026-05-20T00:00:00.000Z",
          engineVersion: "ocr-v1",
        },
      ],
      transcript: [
        {
          materialId: "mat-2",
          availability: "PENDING",
          indexed: false,
          extractedAtUtc: null,
          engineVersion: null,
        },
      ],
    },
    graphRelationships: [
      {
        edgeId: "e-1",
        edgeType: "SAME_HASH_AS",
        sourceNodeKind: "EVIDENCE",
        targetNodeKind: "EVIDENCE",
        sourceNodeExternalId: "evi-1",
        targetNodeExternalId: "evi-2",
        safeSummary: "Byte-identical material observed.",
        createdAtUtc: "2026-05-20T00:00:00.000Z",
      },
    ],
    timelineEvents: [
      {
        id: "ev-1",
        kind: "NODE_CREATED",
        atUtc: "2026-05-20T00:00:00.000Z",
        summary: "Evidence node created.",
        nodeId: "n-1",
        otherNodeId: null,
        edgeType: null,
      },
    ],
  };
}

function build(kind:
  | "media_intelligence"
  | "derived_assets"
  | "ocr_transcript"
  | "graph_relationships"
  | "timeline"): Record<string, unknown> {
  // advisory-signals.json / media_intelligence.json are NO LONGER emitted
  // in the default package (product decision). The bounded-output contract
  // of the advisory manifest builder is still unit-tested by invoking the
  // retained `buildMediaIntelligenceManifest` directly.
  if (kind === "media_intelligence") {
    return buildMediaIntelligenceManifest(
      fullInput().mediaSignals!,
    ) as Record<string, unknown>;
  }
  const r = buildIntelligencePackageManifests(fullInput());
  const path = `intelligence/${kind}${
    kind === "graph_relationships"
      ? ".json"
      : kind === "timeline"
        ? "_manifest.json"
        : "_manifest.json"
  }`;
  const entry = r.find((e) => e.path === path);
  if (!entry) throw new Error(`manifest ${path} not built`);
  return entry.json as Record<string, unknown>;
}

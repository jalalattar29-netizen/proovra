/**
 * UC-0 — the verification package's acquisition record and derived manifest.
 *
 * `acquisition.json` is emitted for every package (additive to the existing
 * layout) and `derived/derived-manifest.json` only when derivatives exist.
 * Both are pure builders, so the invariants are executed directly:
 *
 *   - the mode comes from the acquisition authority, never from structure;
 *   - a legacy record says "Not recorded" and is never upgraded;
 *   - derived material is counted and described as DERIVED, never as original;
 *   - the capture-record part is counted apart from originals;
 *   - the record distinguishes what a third party can verify from what rests on
 *     PROOVRA's own record, and never claims truth, authorship or admissibility.
 */
import { describe, expect, it } from "vitest";
import { resolveEvidenceAcquisition, type ProvenanceChain } from "@proovra/shared";

import {
  buildDerivedManifest,
  buildPackageAcquisitionRecord,
} from "../src/verification-package";

/** The emitted documents, as the tests read them. */
type AcquisitionDoc = {
  schema: string;
  acquisition: {
    mode: string;
    recorded: boolean;
    recordedBy: string | null;
    label: string;
  };
  captureSession: { status: string; digestsConfirmed: number } | null;
  artifacts: { original: number; captureRecord: number; derived: number };
  verifiability: { dependsOnProovraRecord: string[] };
};
type DerivedDoc = {
  schema: string;
  boundary: string;
  items: Array<{ artifactClass: string; status: string } & Record<string, unknown>>;
};

function chain(overrides: Partial<ProvenanceChain> = {}): ProvenanceChain {
  return {
    acquisition: resolveEvidenceAcquisition({
      acquisitionMode: "PROOVRA_MOBILE_APP",
      acquisitionModeSource: "RECORDED_AT_CREATION",
    }),
    captureSession: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      status: "BOUND",
      startedAtUtc: "2026-09-17T10:00:00.000Z",
      endedAtUtc: "2026-09-17T10:01:00.000Z",
      digestsConfirmed: 2,
      trustChainHeadHash: "a".repeat(64),
    },
    derivedArtifacts: [
      {
        artifactClass: "DERIVED",
        sourcePartIndex: 0,
        assetKind: "THUMBNAIL",
        variantKey: "default",
        transformation: "IMAGE_THUMBNAIL",
        engineVersion: "sharp-1",
        sourceSha256AtGeneration: "b".repeat(64),
        derivedSha256: "c".repeat(64),
        parametersSha256: null,
        status: "COMPLETED",
        generatedAtUtc: "2026-09-17T10:02:00.000Z",
      },
      {
        artifactClass: "DERIVED",
        sourcePartIndex: 1,
        assetKind: "OCR_TEXT",
        variantKey: "default",
        transformation: "OCR_TEXT_EXTRACTION",
        engineVersion: "ocr-1",
        sourceSha256AtGeneration: "d".repeat(64),
        derivedSha256: null,
        parametersSha256: null,
        status: "FAILED",
        generatedAtUtc: null,
      },
    ],
    ...overrides,
  } as unknown as ProvenanceChain;
}

describe("UC-0 package acquisition.json", () => {
  it("records the authority's mode, its source and the bound session", () => {
    const rec = buildPackageAcquisitionRecord({
      evidenceId: "ev-1",
      chain: chain(),
      acquisitionMode: "PROOVRA_MOBILE_APP",
      signedAtUtc: "2026-09-17T10:01:05.000Z",
      evidenceFiles: [
        { artifactClass: "ORIGINAL" },
        { artifactClass: "ORIGINAL" },
        { artifactClass: "CAPTURE_MANIFEST" },
      ],
    }) as unknown as AcquisitionDoc;
    expect(rec.schema).toBe("PROOVRA_PACKAGE_ACQUISITION");
    expect(rec.acquisition.mode).toBe("PROOVRA_MOBILE_APP");
    expect(rec.acquisition.recorded).toBe(true);
    expect(rec.acquisition.recordedBy).toBe("RECORDED_AT_CREATION");
    expect(rec.acquisition.label).toBe("Submitted through the PROOVRA mobile app");
    expect(rec.captureSession?.status).toBe("BOUND");
    expect(rec.captureSession?.digestsConfirmed).toBe(2);
    // Originals, capture records and derivatives are three separate counts;
    // only COMPLETED derivatives count as present.
    expect(rec.artifacts).toEqual({ original: 2, captureRecord: 1, derived: 1 });
    expect(rec.verifiability.dependsOnProovraRecord).toContain(
      "the acquisition mode assignment",
    );
  });

  it("a legacy record without a chain says Not recorded — never guessed", () => {
    const rec = buildPackageAcquisitionRecord({
      evidenceId: "ev-legacy",
      chain: null,
      acquisitionMode: null,
      signedAtUtc: null,
      evidenceFiles: [{ artifactClass: null }],
    }) as unknown as AcquisitionDoc;
    expect(rec.acquisition.mode).toBe("LEGACY_NOT_RECORDED");
    expect(rec.acquisition.recorded).toBe(false);
    expect(rec.acquisition.recordedBy).toBeNull();
    expect(rec.acquisition.label).toBe("Not recorded");
    expect(rec.captureSession).toBeNull();
    // An unknown artifact class is an original, never a derivative.
    expect(rec.artifacts).toEqual({ original: 1, captureRecord: 0, derived: 0 });
  });

  it("the intake backfill is disclosed as a backfill", () => {
    const rec = buildPackageAcquisitionRecord({
      evidenceId: "ev-intake",
      chain: chain({
        acquisition: resolveEvidenceAcquisition({
          acquisitionMode: "SECURE_INTAKE_LINK",
          acquisitionModeSource: "BACKFILL_INTAKE_SESSION_LINK",
        }),
        captureSession: null,
        derivedArtifacts: [],
      }),
      acquisitionMode: "SECURE_INTAKE_LINK",
      signedAtUtc: null,
      evidenceFiles: [{ artifactClass: "ORIGINAL" }],
    }) as unknown as AcquisitionDoc;
    expect(rec.acquisition.mode).toBe("SECURE_INTAKE_LINK");
    expect(rec.acquisition.recordedBy).toBe("BACKFILL_INTAKE_SESSION_LINK");
  });

  it("makes no truth, authorship, capture-verification or admissibility claim", () => {
    const text = JSON.stringify(
      buildPackageAcquisitionRecord({
        evidenceId: "ev-1",
        chain: chain(),
        acquisitionMode: "PROOVRA_MOBILE_APP",
        signedAtUtc: null,
        evidenceFiles: [],
      }),
    );
    expect(text).not.toMatch(
      /verified at source|verified capture|tamper-?proof|unfakeable|legally admissible|authentic screenshot|Class [ABC]\b/i,
    );
  });
});

describe("UC-0 package derived/derived-manifest.json", () => {
  it("lists derivatives with their source lineage and never as originals", () => {
    const m = buildDerivedManifest({ evidenceId: "ev-1", chain: chain() }) as unknown as DerivedDoc;
    expect(m.schema).toBe("PROOVRA_PACKAGE_DERIVED_MANIFEST");
    expect(m.items).toHaveLength(2);
    for (const item of m.items) expect(item.artifactClass).toBe("DERIVED");
    expect(m.items[0]).toMatchObject({
      sourcePartIndex: 0,
      sourceSha256AtGeneration: "b".repeat(64),
      transformation: "IMAGE_THUMBNAIL",
      variantKey: "default",
    });
    // A failed derivative is listed with its status, not silently dropped.
    expect(m.items[1].status).toBe("FAILED");
    expect(m.boundary).toMatch(/not originals/);
    // Lineage only — no storage location or bytes leave the platform.
    expect(JSON.stringify(m)).not.toMatch(/storageKey|bucket|base64/i);
  });

  it("an empty chain yields an empty manifest", () => {
    const m = buildDerivedManifest({ evidenceId: "ev-1", chain: null }) as unknown as DerivedDoc;
    expect(m.items).toEqual([]);
  });
});

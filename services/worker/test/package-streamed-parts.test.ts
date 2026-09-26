/**
 * VERIFICATION PACKAGES FROM STREAMED PARTS.
 *
 * UC-3 (10d43e40) stopped loading ORIGINAL evidence parts into memory: the
 * processor now hands the package builder each part's storage coordinates,
 * digest and size, and `appendEvidencePart` streams the bytes from storage.
 * The builder's entry filter, however, still accepted only entries carrying an
 * in-memory `buffer` — so every part-based record was rejected with
 * "Verification package requires at least one evidence file", and the worker
 * looped "report exists but its verification package does not".
 *
 * Found by running the real worker against MinIO (e2e/runtime-boundary-
 * fullstack.spec.ts): the report PDF was produced, the package never was.
 */

import { describe, expect, it } from "vitest";

import { selectPackageEvidenceFiles } from "../src/verification-package.js";

const streamed = {
  name: "note.txt",
  storageBucket: "proovra-e2e",
  storageKey: "evidence/ev-1/parts/0000/note.txt",
  sha256: "a".repeat(64),
  sizeBytes: 31,
  mimeType: "text/plain",
};

describe("selectPackageEvidenceFiles — the files a package is built from", () => {
  it("accepts a streamed part (storage coordinates + digest + size, no buffer)", () => {
    expect(selectPackageEvidenceFiles({ evidenceFiles: [streamed] })).toEqual([streamed]);
  });

  it("still accepts a legacy in-memory part", () => {
    const legacy = { name: "legacy.bin", buffer: Buffer.from("bytes") };
    expect(selectPackageEvidenceFiles({ evidenceFiles: [legacy] })).toEqual([legacy]);
  });

  it("rejects an entry that has neither bytes nor complete storage coordinates", () => {
    const partial = { name: "x", storageBucket: "b", storageKey: "k" }; // no digest / size
    expect(selectPackageEvidenceFiles({ evidenceFiles: [partial, null] })).toEqual([]);
  });

  it("falls back to the single legacy evidence buffer when no files are given", () => {
    const buf = Buffer.from("single");
    expect(selectPackageEvidenceFiles({ evidenceBuffer: buf })).toEqual([{ name: "evidence-file", buffer: buf }]);
    expect(selectPackageEvidenceFiles({})).toEqual([]);
  });
});

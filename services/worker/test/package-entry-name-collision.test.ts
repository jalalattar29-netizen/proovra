/**
 * ET-PKG-14 — a single-file record's root name never collides with an entry
 * the generator writes itself.
 *
 * On a40ca76f a record titled "fingerprint" (application/json, no capture or
 * upload time) was packaged as "fingerprint.json" beside the fixed
 * fingerprint.json: two entries with one path, listed twice in the checksum
 * index while Map-based verifiers saw only one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RESERVED_ROOT_ENTRY_NAMES,
  buildEvidencePackageFileName,
} from "../src/verification-package.js";

const SRC = readFileSync(fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)), "utf8");

describe("package root entry names (ET-PKG-14)", () => {
  it("a record titled like a fixed entry gets a distinct root name", () => {
    const name = buildEvidencePackageFileName({
      evidenceTitle: "fingerprint",
      mimeType: "application/json",
      capturedAtUtc: null,
      uploadedAtUtc: null,
      totalParts: 1,
      fileOrder: 1,
    });
    expect(RESERVED_ROOT_ENTRY_NAMES.has(name)).toBe(false);
    expect(name).toBe("evidence-fingerprint.json");
  });

  it("the collision check folds case (extractors do)", () => {
    const name = buildEvidencePackageFileName({
      evidenceTitle: "Custody",
      mimeType: "application/json",
      totalParts: 1,
      fileOrder: 1,
    });
    expect(name.toLowerCase()).not.toBe("custody.json");
  });

  it("an ordinary title is untouched", () => {
    expect(
      buildEvidencePackageFileName({ evidenceTitle: "Site photo", mimeType: "image/jpeg", totalParts: 1, fileOrder: 1 }),
    ).not.toMatch(/^evidence-/);
  });

  it("the reserved set covers every root entry the generator appends (exhaustive)", () => {
    const rootLiterals = [...SRC.matchAll(/appendPackageEntry\(\s*archive,\s*packageEntries,\s*"([^"/]+)",/g)].map((m) => m[1]!);
    expect(rootLiterals.length).toBeGreaterThan(20);
    for (const n of rootLiterals) expect(RESERVED_ROOT_ENTRY_NAMES.has(n), n).toBe(true);
  });
});

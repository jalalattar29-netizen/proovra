/**
 * ET-PKG-15 — the verification package streams the SAME object version the
 * integrity pre-read hashed (the record's sealed storageVersionId).
 *
 * On a40ca76f the pre-read (headObject + getObjectStream) was pinned to the
 * sealed version but the package stream read latest-at-the-key, so a newer
 * object at the key failed the build as EVIDENCE_PART_DIGEST_MISMATCH instead
 * of packaging the sealed bytes.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("package streams the sealed version (ET-PKG-15)", () => {
  it("the part stream is pinned to the file's recorded version", () => {
    const pkg = read("../src/verification-package.ts");
    expect(pkg).toMatch(/getObjectStream\(\{\s*bucket: file\.storageBucket,\s*key: file\.storageKey,\s*versionId: file\.storageVersionId \?\? null,/);
    expect(pkg).not.toMatch(/getObjectStream\(\{ bucket: file\.storageBucket, key: file\.storageKey \}\)/);
  });

  it("the processor hands the pre-read's version to the package", () => {
    const proc = read("../src/processor.ts");
    const push = proc.indexOf("verificationEvidenceFiles.push({");
    const close = proc.indexOf("});", push);
    expect(push).toBeGreaterThan(0);
    expect(proc.slice(push, close)).toContain("storageVersionId: part.storageVersionId ?? null,");
  });
});

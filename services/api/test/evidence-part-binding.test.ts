/**
 * F-03 (Free-user audit 2026-11-13) — the part-index file binding rule.
 * Pure checks; the HTTP + PostgreSQL proof is
 * capture-selection-change-reservation.integration.test.ts.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  boundPartDigestHex,
  boundPartsMatchManifest,
  isSameBoundFile,
  sha256Base64ToHex,
  storedBytesMatchBoundDigest,
} from "../src/services/evidence/evidence-part-binding.service.js";

const b64 = (s: string) => createHash("sha256").update(s).digest("base64");
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

const row = (partIndex: number, name: string, bytes: string | null, mime = "image/jpeg") => ({
  partIndex,
  originalFileName: name,
  mimeType: mime,
  clientSignals: bytes === null ? null : { clientHintSha256Base64: b64(bytes), duplicateStatus: "unique" },
});
const file = (name: string, bytes: string | null, mime = "image/jpeg") => ({
  originalFileName: name,
  mimeType: mime,
  sha256Base64: bytes === null ? null : b64(bytes),
});

describe("part-index file binding (F-03)", () => {
  it("reads only a well-formed 32-byte SHA-256 as a bound digest", () => {
    expect(sha256Base64ToHex(b64("a"))).toBe(hex("a"));
    expect(sha256Base64ToHex("bm90LWEtZGlnZXN0")).toBeNull();
    expect(sha256Base64ToHex("***")).toBeNull();
    expect(boundPartDigestHex(null)).toBeNull();
    expect(boundPartDigestHex(["x"])).toBeNull();
    expect(boundPartDigestHex({ clientHintSha256Base64: 7 })).toBeNull();
  });

  it("the same file again is the idempotent retry", () => {
    expect(isSameBoundFile(row(0, "a.jpg", "A"), file("a.jpg", "A"))).toBe(true);
  });

  it("another name, another type, or the same name with other bytes is another file", () => {
    expect(isSameBoundFile(row(0, "a.jpg", "A"), file("b.jpg", "A"))).toBe(false);
    expect(isSameBoundFile(row(0, "a.jpg", "A"), file("a.jpg", "A", "image/png"))).toBe(false);
    expect(isSameBoundFile(row(0, "a.jpg", "A"), file("a.jpg", "A2"))).toBe(false);
    // A row bound to a digest is not matched by a declaration that states none.
    expect(isSameBoundFile(row(0, "a.jpg", "A"), file("a.jpg", null))).toBe(false);
  });

  it("a row bound without a digest (mobile, extension) matches on name and type", () => {
    expect(isSameBoundFile(row(0, "a.jpg", null), file("a.jpg", "anything"))).toBe(true);
    expect(isSameBoundFile(row(0, "a.jpg", null), file("b.jpg", null))).toBe(false);
  });

  it("a reservation resumes for the same files or with files appended — never after removal, reorder or replacement", () => {
    const rows = [row(0, "a.jpg", "A"), row(1, "b.jpg", "B")];
    expect(boundPartsMatchManifest(rows, [file("a.jpg", "A"), file("b.jpg", "B")])).toBe(true);
    expect(boundPartsMatchManifest(rows, [file("a.jpg", "A"), file("b.jpg", "B"), file("c.jpg", "C")])).toBe(true);
    expect(boundPartsMatchManifest(rows, [file("b.jpg", "B")]), "removal").toBe(false);
    expect(boundPartsMatchManifest(rows, [file("a.jpg", "A")]), "tail removal").toBe(false);
    expect(boundPartsMatchManifest(rows, [file("b.jpg", "B"), file("a.jpg", "A")]), "reorder").toBe(false);
    expect(boundPartsMatchManifest(rows, [file("a.jpg", "A"), file("b.jpg", "B-edited")]), "same name, other bytes").toBe(false);
    expect(boundPartsMatchManifest([], [file("z.jpg", "Z")]), "no part issued yet").toBe(true);
  });

  it("at the seal, the stored bytes must be the bound file's bytes", () => {
    expect(storedBytesMatchBoundDigest({ clientHintSha256Base64: b64("A") }, hex("A"))).toBe(true);
    expect(storedBytesMatchBoundDigest({ clientHintSha256Base64: b64("A") }, hex("B"))).toBe(false);
    expect(storedBytesMatchBoundDigest(null, hex("B"))).toBe(true);
  });
});

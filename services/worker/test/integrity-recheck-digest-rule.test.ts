/**
 * ET-SM-07 — the digest rule of the integrity recheck, without a database.
 *
 * `observeOriginalDigest` must reach the same answer the completion and report
 * paths reach for the same bytes: a single object is its own SHA-256; a
 * multipart record is the SHA-256 of its part hashes joined by "|"; a legacy
 * single-part record whose stored digest is that composite still verifies.
 * Every object is read at its exact recorded VersionId.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/storage.js", () => ({ headObject: vi.fn(), getObjectStream: vi.fn() }));
vi.mock("../src/integrity-rejection.service.js", () => ({ rejectEvidenceIntegrity: vi.fn() }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { observeOriginalDigest, compositeSha256 } = await import("../src/integrity-recheck.js");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function readerOf(objects: Record<string, string | Error>) {
  const asked: Array<{ key: string; versionId: string | null }> = [];
  const get = (o: { key: string; versionId: string | null }) => {
    asked.push({ key: o.key, versionId: o.versionId });
    const v = objects[`${o.key}@${o.versionId ?? "latest"}`];
    if (v === undefined) throw Object.assign(new Error("NoSuchVersion"), { name: "NoSuchVersion" });
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    asked,
    reader: {
      head: async (o: { bucket: string; key: string; versionId: string | null }) => ({ sizeBytes: get(o).length }),
      stream: async (o: { bucket: string; key: string; versionId: string | null }) => Readable.from([Buffer.from(get(o))]),
    },
  };
}

const single = (fileSha256: string | null, versionId: string | null = "v1") => ({
  id: "ev",
  fileSha256,
  storageBucket: "b",
  storageKey: "k",
  storageVersionId: versionId,
});
const part = (i: number, versionId: string | null) => ({
  partIndex: i,
  storageBucket: "b",
  storageKey: `p${i}`,
  storageVersionId: versionId,
});

describe("observeOriginalDigest", () => {
  it("single object: its own SHA-256, read at the recorded version", async () => {
    const { reader, asked } = readerOf({ "k@v1": "hello" });
    const o = await observeOriginalDigest(single(sha("hello")), [], reader);
    expect(o).toEqual({
      // UC-TRUST-001 — the observation names the digest it compared against.
      expectedDigest: sha("hello"),
      outcome: "VERIFIED",
      failureCode: null,
      checkedDigest: sha("hello"),
      storageVersionId: "v1",
      checkedObjects: [{ partIndex: null, versionId: "v1", sha256: sha("hello") }],
    });
    expect(asked.every((a) => a.versionId === "v1")).toBe(true);
  });

  it("multipart: the composite of the part hashes, each part at its own version", async () => {
    const { reader, asked } = readerOf({ "p0@a": "one", "p1@b": "two", "p2@c": "three" });
    const expected = compositeSha256([sha("one"), sha("two"), sha("three")]);
    expect(expected).toBe(sha([sha("one"), sha("two"), sha("three")].join("|")));
    const o = await observeOriginalDigest(single(expected, null), [part(0, "a"), part(1, "b"), part(2, "c")], reader);
    expect(o.outcome).toBe("VERIFIED");
    expect(o.storageVersionId).toBeNull();
    expect(o.checkedObjects).toEqual([
      { partIndex: 0, versionId: "a", sha256: sha("one") },
      { partIndex: 1, versionId: "b", sha256: sha("two") },
      { partIndex: 2, versionId: "c", sha256: sha("three") },
    ]);
    expect(asked.map((a) => `${a.key}@${a.versionId}`)).toEqual(["p0@a", "p0@a", "p1@b", "p1@b", "p2@c", "p2@c"]);
  });

  it("a single-part record verifies against its plain hash AND against the legacy composite", async () => {
    const { reader } = readerOf({ "p0@a": "only" });
    expect((await observeOriginalDigest(single(sha("only"), null), [part(0, "a")], reader)).outcome).toBe("VERIFIED");
    const legacy = compositeSha256([sha("only")]);
    expect((await observeOriginalDigest(single(legacy, null), [part(0, "a")], reader)).outcome).toBe("VERIFIED");
  });

  it("different bytes: FAILED / DIGEST_MISMATCH, carrying what was computed", async () => {
    const { reader } = readerOf({ "k@v1": "changed" });
    expect(await observeOriginalDigest(single(sha("original")), [], reader)).toMatchObject({
      outcome: "FAILED",
      failureCode: "DIGEST_MISMATCH",
      checkedDigest: sha("changed"),
    });
  });

  it("a part that is gone: FAILED / OBJECT_VERSION_MISSING, and no digest is claimed", async () => {
    const { reader } = readerOf({ "p0@a": "one" });
    const o = await observeOriginalDigest(single("x".repeat(64), null), [part(0, "a"), part(1, "b")], reader);
    expect(o).toMatchObject({ outcome: "FAILED", failureCode: "OBJECT_VERSION_MISSING", checkedDigest: null });
    expect(o.checkedObjects).toEqual([
      { partIndex: 0, versionId: "a", sha256: sha("one") },
      { partIndex: 1, versionId: "b", sha256: null },
    ]);
  });

  it("a store error that is not 'not found': UNAVAILABLE, never FAILED", async () => {
    const { reader } = readerOf({ "k@v1": Object.assign(new Error("SlowDown"), { name: "SlowDown" }) });
    expect(await observeOriginalDigest(single(sha("x")), [], reader)).toMatchObject({
      outcome: "UNAVAILABLE",
      failureCode: "STORAGE_UNAVAILABLE",
      checkedDigest: null,
    });
  });

  it("no stored location or no signed digest: NOT_CHECKABLE, nothing read", async () => {
    const { reader, asked } = readerOf({});
    expect(await observeOriginalDigest({ ...single(sha("x")), storageKey: null }, [], reader)).toMatchObject({
      outcome: "UNAVAILABLE",
      failureCode: "NOT_CHECKABLE",
    });
    expect(await observeOriginalDigest(single(null), [], reader)).toMatchObject({ failureCode: "NOT_CHECKABLE" });
    expect(asked).toEqual([]);
  });

  it("an empty object is a missing object, not an empty match", async () => {
    const { reader } = readerOf({ "k@v1": "" });
    expect(await observeOriginalDigest(single(sha("")), [], reader)).toMatchObject({
      outcome: "FAILED",
      failureCode: "OBJECT_VERSION_MISSING",
    });
  });
});

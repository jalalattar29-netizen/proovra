import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { declaredObject } from "../../lib/uploads/retry";
import { sha256Base64OfBlob } from "../../lib/uploads/streaming-sha256";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

describe("sha256Base64OfBlob", () => {
  it.each([
    ["empty", 0],
    ["one byte", 1],
    ["one slice exactly", 8 * 1024 * 1024],
    ["across slices", 8 * 1024 * 1024 + 17],
  ])("%s", async (_name, size) => {
    const bytes = randomBytes(size);
    expect(await sha256Base64OfBlob(new Blob([bytes]))).toBe(digest(bytes).toString("base64"));
  });
});

describe("declaredObject", () => {
  it("declares the size and the digest in the form the server compares", async () => {
    const bytes = randomBytes(64);
    const declared = declaredObject(bytes.length, await sha256Base64OfBlob(new Blob([bytes])));
    expect(declared).toEqual({ expectedTotalBytes: 64, expectedSha256: digest(bytes).toString("hex") });
  });

  it("no digest means the key is absent, not empty", () => {
    expect(declaredObject(10)).toEqual({ expectedTotalBytes: 10 });
  });
});

// F-P1-03 (Free-user audit of 4d9b78963) — capture's part checksum and
// Content-MD5 are computed in one pass over bounded slices; the whole file is
// never read into one buffer (that killed phone tabs on large videos).
import { computeIntegrityFromBlob } from "../../app/(app)/capture/_lib/hash-utils";

describe("computeIntegrityFromBlob (F-P1-03)", () => {
  it.each([
    ["empty", 0],
    ["one byte", 1],
    ["across slices", 2 * 8 * 1024 * 1024 + 5],
  ])("%s: the same SHA-256 and MD5 as a whole-buffer digest", async (_name, size) => {
    const bytes = randomBytes(size);
    expect(await computeIntegrityFromBlob(new Blob([bytes]))).toEqual({
      checksumSha256Base64: digest(bytes).toString("base64"),
      contentMd5Base64: createHash("md5").update(bytes).digest("base64"),
    });
  });

  it("reads bounded slices only, never the whole file at once", async () => {
    const bytes = randomBytes(2 * 8 * 1024 * 1024 + 5);
    const real = new Blob([bytes]);
    const sliceSizes: number[] = [];
    const file = {
      size: real.size,
      arrayBuffer: () => {
        throw new Error("whole-file read");
      },
      slice: (start: number, end: number) => {
        const part = real.slice(start, end);
        sliceSizes.push(part.size);
        return part;
      },
    } as unknown as Blob;
    const out = await computeIntegrityFromBlob(file);
    expect(out.checksumSha256Base64).toBe(digest(bytes).toString("base64"));
    expect(sliceSizes.length).toBe(3);
    expect(Math.max(...sliceSizes)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

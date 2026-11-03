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

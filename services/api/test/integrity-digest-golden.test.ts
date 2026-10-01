/**
 * UC-ARCH-006 — the integrity digest rules have ONE implementation
 * (@proovra/shared-runtime integrity/digest.ts), pinned by golden vectors.
 * The API completion and its stream hash import it; the worker (lane T) is to
 * import the same module (see the lane's cross-lane request), at which point
 * the source assertion below extends to it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compositeSha256,
  multipartManifestSha256,
  recordDigestFromParts,
  sha256HexFromStream,
} from "@proovra/shared-runtime";
import { sha256HexFromStream as apiStreamHash } from "../src/stream-hash.js";

const A = createHash("sha256").update("part-a").digest("hex");
const B = createHash("sha256").update("part-b").digest("hex");

describe("UC-ARCH-006 — one integrity digest authority (golden vectors)", () => {
  it("composite / manifest / single-part digests match the published rules", () => {
    expect(compositeSha256([A, B])).toBe(createHash("sha256").update(`${A}|${B}`).digest("hex"));
    expect(multipartManifestSha256([A, B])).toBe(createHash("sha256").update(`${A}\n${B}`).digest("hex"));
    expect(recordDigestFromParts([{ partIndex: 1, sha256: B }, { partIndex: 0, sha256: A }])).toBe(compositeSha256([A, B]));
    expect(recordDigestFromParts([{ partIndex: 0, sha256: A }])).toBe(A);
    // Fixed golden value: changing the rule anywhere breaks this line.
    expect(compositeSha256(["0".repeat(64), "f".repeat(64)])).toBe(
      createHash("sha256").update(`${"0".repeat(64)}|${"f".repeat(64)}`).digest("hex"),
    );
  });

  it("the streaming hash is the same function on both import paths", async () => {
    const bytes = Buffer.from("stream-bytes-0123456789");
    const want = createHash("sha256").update(bytes).digest("hex");
    expect(await sha256HexFromStream(Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]))).toBe(want);
    expect(await apiStreamHash(Readable.from([bytes]))).toBe(want);
    expect(apiStreamHash).toBe(sha256HexFromStream);
  });

  it("API completion derives digests only through the shared module", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/services/evidence-complete.service.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/compositeSha256\(/);
    expect(src).toMatch(/multipartManifestSha256\(/);
    expect(src).not.toMatch(/\.join\("\|"\)/);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFile, stat, rm } from "node:fs/promises";
import { Readable } from "node:stream";

import {
  streamZipToTempFile,
  cleanupStagedTemp,
  stagingPackageKey,
  type StreamingPackageEntry,
} from "../src/verification-package-staging.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A synthetic large stream WITHOUT allocating the whole payload up front. */
function syntheticStream(totalBytes: number, chunk = 64 * 1024): Readable {
  let sent = 0;
  const block = Buffer.alloc(chunk, 0xab);
  return new Readable({
    read() {
      if (sent >= totalBytes) return this.push(null);
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      this.push(n === chunk ? block : block.subarray(0, n));
    },
  });
}

describe("streaming verification-package staging writer", () => {
  it("writes a zip to a private temp file and reports EXACT size + incremental SHA-256", async () => {
    const entries: StreamingPackageEntry[] = [
      { name: "manifest.json", buffer: Buffer.from(JSON.stringify({ schema: "x" })) },
      { name: "evidence-parts/part-0.bin", source: () => Readable.from([Buffer.from("hello "), Buffer.from("world")]) },
    ];
    const staged = await streamZipToTempFile(entries);
    dirs.push(staged.tempDir);

    // The reported size/digest must equal a fresh, independent read of the temp file
    // — proving the incremental meter counted and hashed every byte with no loss.
    const bytes = await readFile(staged.tempPath);
    expect((await stat(staged.tempPath)).size).toBe(staged.sizeBytes);
    expect(bytes.length).toBe(staged.sizeBytes);
    const reHex = createHash("sha256").update(bytes).digest("hex");
    const reB64 = createHash("sha256").update(bytes).digest("base64");
    expect(staged.sha256Hex).toBe(reHex);
    expect(staged.sha256Base64).toBe(reB64);
    expect(staged.sizeBytes).toBeGreaterThan(0);
  });

  it("streams a large artifact via a source stream without buffering it as one Buffer", async () => {
    // 8 MiB synthetic source produced in 64 KiB chunks — the writer must never need
    // the whole artifact resident. We assert it completes and the temp file's own
    // bytes hash to the reported digest (end-to-end streaming integrity).
    const big = 8 * 1024 * 1024;
    const staged = await streamZipToTempFile([{ name: "big.bin", source: () => syntheticStream(big) }]);
    dirs.push(staged.tempDir);
    const bytes = await readFile(staged.tempPath);
    expect(staged.sha256Hex).toBe(createHash("sha256").update(bytes).digest("hex"));
    // The zip is smaller than the raw payload (0xAB compresses well) — proves real
    // streaming compression happened, not a raw copy.
    expect(staged.sizeBytes).toBeLessThan(big);
  });

  it("propagates a source-stream failure (fails closed, no silent truncation)", async () => {
    const failing = () =>
      new Readable({
        read() {
          this.destroy(new Error("source read failure"));
        },
      });
    await expect(streamZipToTempFile([{ name: "x.bin", source: failing }])).rejects.toThrow();
  });

  it("cleanupStagedTemp removes the temp dir and is idempotent", async () => {
    const staged = await streamZipToTempFile([{ name: "a.txt", buffer: Buffer.from("a") }]);
    await cleanupStagedTemp(staged);
    await expect(stat(staged.tempPath)).rejects.toThrow();
    await cleanupStagedTemp(staged); // idempotent, no throw
  });

  it("staging keys live under a private namespace, idempotent per (evidence, version)", () => {
    const k = stagingPackageKey("ev-1", 3);
    expect(k).toBe("internal/package-staging/ev-1/v3.zip");
    expect(k.startsWith("internal/package-staging/")).toBe(true);
    // Distinct from the canonical `verification/<id>/v<n>.zip` namespace users resolve.
    expect(k.startsWith("verification/")).toBe(false);
    // A retry produces the SAME key (overwrite, not a per-attempt leak).
    expect(stagingPackageKey("ev-1", 3)).toBe(k);
  });
});

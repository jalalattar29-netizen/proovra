import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFile, stat, rm } from "node:fs/promises";
import { Readable } from "node:stream";

import {
  streamZipToTempFile,
  cleanupStagedTemp,
  stagingPackageKey,
  isStaleStagingObject,
  reconcileStaleStaging,
  STAGING_PREFIX,
  STAGING_RECONCILE_TTL_MS,
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

  it("isStaleStagingObject flags only objects older than the TTL, never unknown-age", () => {
    const now = 1_000_000_000_000;
    expect(isStaleStagingObject(new Date(now - STAGING_RECONCILE_TTL_MS - 1), now)).toBe(true);
    expect(isStaleStagingObject(new Date(now - 1000), now)).toBe(false); // fresh
    expect(isStaleStagingObject(null, now)).toBe(false); // unknown age → never delete
    expect(isStaleStagingObject(new Date(now - 10), now, 5)).toBe(true); // custom ttl
  });

  it("reconcileStaleStaging deletes ONLY stale staging orphans, bounded and idempotent", async () => {
    const now = 2_000_000_000_000;
    const listed = [
      { key: `${STAGING_PREFIX}ev-1/v1.zip`, lastModified: new Date(now - STAGING_RECONCILE_TTL_MS - 1), sizeBytes: 10 }, // stale
      { key: `${STAGING_PREFIX}ev-2/v1.zip`, lastModified: new Date(now - 1000), sizeBytes: 10 }, // fresh — keep
      { key: `${STAGING_PREFIX}ev-3/v1.zip`, lastModified: null, sizeBytes: 10 }, // unknown — keep
    ];
    const deletedKeys: string[] = [];
    const res = await reconcileStaleStaging({
      bucket: "b",
      now,
      listObjects: async ({ prefix }) => {
        expect(prefix).toBe(STAGING_PREFIX); // only ever scans the private staging prefix
        return listed;
      },
      deleteObject: async ({ key }) => {
        deletedKeys.push(key);
      },
    });
    expect(res.scanned).toBe(3);
    expect(res.deleted).toBe(1);
    expect(deletedKeys).toEqual([`${STAGING_PREFIX}ev-1/v1.zip`]);
    // Never touches the canonical `verification/` namespace or fresh/unknown objects.
    expect(deletedKeys.some((k) => k.startsWith("verification/"))).toBe(false);
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

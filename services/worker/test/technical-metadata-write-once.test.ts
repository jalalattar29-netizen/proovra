/**
 * AUD-38 (2026-10-20) — TECHNICAL METADATA IS PARSED FROM THE SEALED VERSION
 * AND WRITTEN ONCE.
 *
 * Characterization (before): the pass read each part "latest at the key" and
 * UPDATEd technical_metadata unconditionally, so a re-run (a newer parser, a
 * retried job) silently replaced metadata a report or a reviewer had relied
 * on — on a sealed record, with no history. Now the read names the sealed
 * version and both writes only fill metadata that is not there yet.
 */
import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  parts: [] as Array<Record<string, unknown>>,
  executed: [] as Array<{ sql: string; params: unknown[] }>,
  ranges: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    $queryRawUnsafe: async () => db.parts,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      db.executed.push({ sql, params });
      return 1;
    },
  },
}));
vi.mock("../src/storage.js", () => ({
  getObjectRange: async (p: Record<string, unknown>) => {
    db.ranges.push(p);
    return Buffer.from("not really an image, but bytes");
  },
}));
vi.mock("../src/technical-metadata/dispatch.js", () => ({
  dispatchTechnicalMetadata: async () => ({ parserName: "test", parserVersion: "1", metadataStatus: "Partial" }),
}));

// Top-level await, not in-test: the processor's cold transform counted
// against the 5s test timeout under full-suite load (2026-10-24). The db
// double is vi.hoisted, so it exists before the mocked modules load.
const { extractTechnicalMetadataForTest } = await import("../src/media-intelligence.processor.js");

describe("technical metadata pass (AUD-38)", () => {
  it("reads the sealed version and writes part and record metadata only where none exists", async () => {
    db.parts = [{ id: "part-1", storage_bucket: "b", storage_key: "k", storage_version_id: "v-sealed", mime_type: "image/jpeg", size_bytes: 1000 }];
    await extractTechnicalMetadataForTest({ jobId: "j", teamId: "t", evidenceId: "e", evidencePartId: null } as never);
    expect(db.ranges[0]).toMatchObject({ bucket: "b", key: "k", versionId: "v-sealed" });
    const writes = db.executed.filter((e) => /UPDATE "evidence(_parts)?"\s+SET "technical_metadata"/.test(e.sql));
    expect(writes.length).toBe(2);
    for (const w of writes) expect(w.sql).toMatch(/AND "technical_metadata" IS NULL/);
  });
});

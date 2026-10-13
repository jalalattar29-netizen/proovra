/**
 * UC-OUT-003 — package recovery reads the COMMITTED report object version.
 *
 * A storage double holds two versions at reports/<id>/v1.pdf: the committed
 * one (whose digest the report row recorded) and a later one (an interrupted
 * earlier attempt that uploaded after the commit). An unpinned read returned
 * the latest and failed permanently with REPORT_INTEGRITY_MISMATCH.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const { readVerifiedStoredReport } = await import("../src/processor.js");

const committed = Buffer.from("%PDF-committed");
const later = Buffer.from("%PDF-later-stray-upload");
const versions: Record<string, Buffer> = { "v-committed": committed, "v-later": later };
const latest = "v-later";

const io = {
  head: (async (o: { versionId?: string | null }) => ({
    sizeBytes: versions[o.versionId ?? latest]!.length,
    checksumSha256: null,
  })) as never,
  stream: (async (o: { versionId?: string | null }) => Readable.from([versions[o.versionId ?? latest]!])) as never,
};

describe("UC-OUT-003 — readVerifiedStoredReport is pinned to s3VersionId", () => {
  it("reads the committed version, not the latest at the key", async () => {
    const out = await readVerifiedStoredReport(
      {
        version: 1,
        storageBucket: "b",
        storageKey: "reports/ev/v1.pdf",
        sizeBytes: BigInt(committed.length),
        pdfSha256: createHash("sha256").update(committed).digest("hex"),
        s3VersionId: "v-committed",
      },
      io,
    );
    expect(out.bytes.equals(committed)).toBe(true);
  });
});

/*
 * (2026-10-13) A legacy report row may carry no pdfSha256. Every TRUSTED
 * source that exists vouches for the bytes — the row, the report's own
 * REPORT_GENERATED issuance record, the store's checksum — and every one that
 * exists must agree. With none, the bytes are never packaged.
 */
describe("legacy report bytes: every trusted hash source must agree", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const base = { version: 7, storageBucket: "b", storageKey: "reports/ev/v7.pdf", sizeBytes: BigInt(committed.length), pdfSha256: null, s3VersionId: "v-committed" };
  const withChecksum = (b64: string | null) => ({ ...io, head: (async () => ({ sizeBytes: committed.length, checksumSha256: b64 })) as never });
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);

  it("no row hash, no issuance hash, no store checksum: REPORT_INTEGRITY_UNVERIFIABLE", async () => {
    expect(await code(readVerifiedStoredReport({ ...base, issuanceSha256: null }, io))).toBe("REPORT_INTEGRITY_UNVERIFIABLE");
  });
  it("the issuance record alone vouches for the stored bytes", async () => {
    const out = await readVerifiedStoredReport({ ...base, issuanceSha256: sha(committed) }, io);
    expect(out.sha256).toBe(sha(committed));
  });
  it("a store checksum that agrees with the bytes does not outvote an issuance record that does not", async () => {
    const b64 = createHash("sha256").update(committed).digest("base64");
    expect(await code(readVerifiedStoredReport({ ...base, issuanceSha256: sha(later) }, withChecksum(b64)))).toBe("REPORT_INTEGRITY_MISMATCH");
  });
  it("all present sources agreeing: the derived hash is the hash of the stored bytes", async () => {
    const b64 = createHash("sha256").update(committed).digest("base64");
    const out = await readVerifiedStoredReport({ ...base, issuanceSha256: sha(committed) }, withChecksum(b64));
    expect(out.sha256).toBe(sha(committed));
  });
  it("a malformed issuance value is not a source", async () => {
    expect(await code(readVerifiedStoredReport({ ...base, issuanceSha256: "not-a-hash" }, io))).toBe("REPORT_INTEGRITY_UNVERIFIABLE");
  });
});

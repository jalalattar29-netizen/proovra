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

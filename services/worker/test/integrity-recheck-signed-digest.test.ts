/**
 * UC-TRUST-001 — the integrity recheck binds to the SIGNED fingerprint.
 *
 * Threat: a DB writer substitutes the stored bytes (a new object version),
 * then rewrites the unsigned columns consistently — evidence_parts.sha256,
 * evidence.file_sha256 and the storage version ids. A check that compares the
 * bytes with those columns passes. The fingerprint the signature covers still
 * lists the ORIGINAL digests, so the check must compare against it — and a
 * column that disagrees with it is itself an integrity failure.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/storage.js", () => ({ headObject: vi.fn(), getObjectStream: vi.fn() }));
vi.mock("../src/integrity-rejection.service.js", () => ({ rejectEvidenceIntegrity: vi.fn() }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { observeOriginalDigest } = await import("../src/integrity-recheck.js");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function reader(objects: Record<string, string>) {
  const get = (o: { key: string; versionId: string | null }) => {
    const v = objects[`${o.key}@${o.versionId ?? "latest"}`];
    if (v === undefined) throw Object.assign(new Error("NoSuchVersion"), { name: "NoSuchVersion" });
    return v;
  };
  return {
    head: async (o: { bucket: string; key: string; versionId: string | null }) => ({ sizeBytes: get(o).length }),
    stream: async (o: { bucket: string; key: string; versionId: string | null }) => Readable.from([Buffer.from(get(o))]),
  };
}

const fingerprintMultipart = (a: string, b: string) =>
  JSON.stringify({
    v: 1,
    evidenceId: "ev",
    file: {
      multipart: true,
      parts: [
        { partIndex: 0, storageBucket: "b", storageKey: "p0", sizeBytes: 1, mimeType: "x", sha256: sha(a) },
        { partIndex: 1, storageBucket: "b", storageKey: "p1", sizeBytes: 1, mimeType: "x", sha256: sha(b) },
      ],
    },
  });

describe("UC-TRUST-001 — observeOriginalDigest compares with the signed fingerprint", () => {
  it("bytes + columns rewritten consistently: FAILED / DIGEST_MISMATCH (the signed digests expose it)", async () => {
    const evilComposite = sha(`${sha("EVIL")}|${sha("two")}`);
    const o = await observeOriginalDigest(
      {
        id: "ev",
        fileSha256: evilComposite, // rewritten column
        fingerprintCanonicalJson: fingerprintMultipart("one", "two"), // signed: original digests
        storageBucket: null,
        storageKey: null,
        storageVersionId: null,
      },
      [
        { partIndex: 0, sha256: sha("EVIL"), storageBucket: "b", storageKey: "p0", storageVersionId: "v9" },
        { partIndex: 1, sha256: sha("two"), storageBucket: "b", storageKey: "p1", storageVersionId: "v1" },
      ],
      reader({ "p0@v9": "EVIL", "p1@v1": "two" }),
    );
    expect(o.outcome).toBe("FAILED");
    expect(o.failureCode).toBe("DIGEST_MISMATCH");
    expect(o.expectedDigest).toBe(sha(`${sha("one")}|${sha("two")}`));
  });

  it("single file: column rewritten to the substituted bytes' digest still fails against the fingerprint", async () => {
    const o = await observeOriginalDigest(
      {
        id: "ev",
        fileSha256: sha("EVIL"),
        fingerprintCanonicalJson: JSON.stringify({ v: 1, file: { multipart: false, sha256: sha("genuine") } }),
        storageBucket: "b",
        storageKey: "k",
        storageVersionId: "v2",
      },
      [],
      reader({ "k@v2": "EVIL" }),
    );
    expect(o.outcome).toBe("FAILED");
    expect(o.failureCode).toBe("DIGEST_MISMATCH");
    expect(o.expectedDigest).toBe(sha("genuine"));
  });

  it("genuine bytes but a tampered column: still an integrity failure (the records disagree)", async () => {
    const o = await observeOriginalDigest(
      {
        id: "ev",
        fileSha256: sha("something else"),
        fingerprintCanonicalJson: JSON.stringify({ v: 1, file: { multipart: false, sha256: sha("genuine") } }),
        storageBucket: "b",
        storageKey: "k",
        storageVersionId: "v1",
      },
      [],
      reader({ "k@v1": "genuine" }),
    );
    expect(o.outcome).toBe("FAILED");
    expect(o.failureCode).toBe("DIGEST_MISMATCH");
  });

  it("genuine bytes and agreeing columns: VERIFIED against the signed digest", async () => {
    const o = await observeOriginalDigest(
      {
        id: "ev",
        fileSha256: sha(`${sha("one")}|${sha("two")}`),
        fingerprintCanonicalJson: fingerprintMultipart("one", "two"),
        storageBucket: null,
        storageKey: null,
        storageVersionId: null,
      },
      [
        { partIndex: 0, sha256: sha("one"), storageBucket: "b", storageKey: "p0", storageVersionId: "v1" },
        { partIndex: 1, sha256: sha("two"), storageBucket: "b", storageKey: "p1", storageVersionId: "v1" },
      ],
      reader({ "p0@v1": "one", "p1@v1": "two" }),
    );
    expect(o.outcome).toBe("VERIFIED");
    expect(o.expectedDigest).toBe(sha(`${sha("one")}|${sha("two")}`));
  });
});

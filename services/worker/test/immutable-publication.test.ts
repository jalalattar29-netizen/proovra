/**
 * The one publication path for report PDFs and package ZIPs.
 *
 * These pin the REQUEST the worker sends (the installed SDK adds no checksum
 * under `requestChecksumCalculation: "WHEN_REQUIRED"`, so the header must come
 * from us), the single-use-key contract, and that nothing unverified is
 * returned. They run against a stubbed client: they prove the request shape
 * and the decision logic, NOT that a real Object Lock bucket accepts it. That
 * gate is only closed by a run against a real AWS bucket (see the rollout doc).
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
let respond: (name: string, input: Record<string, unknown>) => unknown = () => ({});

vi.mock("../src/storage.js", () => ({
  s3: {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const out = respond(name, command.input);
      if (out instanceof Error) throw out;
      return out;
    }),
  },
  isObjectLockEnabled: () => process.env.S3_OBJECT_LOCK_ENABLED === "true",
  readObjectLockDefaults: () =>
    process.env.S3_OBJECT_LOCK_ENABLED === "true"
      ? { mode: "COMPLIANCE", retainUntilDate: new Date(Date.now() + 2920 * 86400_000) }
      : {},
  normalizeContentType: (c: string) => c,
  normalizeMetadata: (m?: Record<string, string>) => m,
  normalizeTagging: () => undefined,
}));

const {
  publishImmutableArtifact,
  comparePublishedObject,
  buildPublicationKey,
  StoragePublicationRejectedError,
  StoragePublicationVerifyError,
} = await import("../src/immutable-publication.js");

const body = Buffer.from("%PDF-1.7 exact bytes");
const sha = createHash("sha256").update(body).digest("base64");

function s3Error(name: string, status = 400): Error {
  const e = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } };
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}

beforeEach(() => {
  sent.length = 0;
  process.env.S3_OBJECT_LOCK_ENABLED = "true";
  respond = (name, input) =>
    name === "PutObjectCommand"
      ? { VersionId: "ver-1" }
      : {
          VersionId: input.VersionId,
          ContentLength: body.length,
          ChecksumSHA256: sha,
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: new Date(Date.now() + 2921 * 86400_000),
        };
});

describe("publishImmutableArtifact", () => {
  it("sends the checksum, the retention and If-None-Match in ONE PutObject, then reads back by VersionId", async () => {
    const out = await publishImmutableArtifact({
      bucket: "b",
      key: "reports/e/v1/r-n.pdf",
      body: { kind: "buffer", buffer: body },
      sha256Base64: sha,
      contentType: "application/pdf",
    });
    const put = sent.find((c) => c.name === "PutObjectCommand")!;
    expect(put.input.ChecksumSHA256).toBe(sha);
    expect(put.input.IfNoneMatch).toBe("*");
    expect(put.input.ObjectLockMode).toBe("COMPLIANCE");
    expect(put.input.ObjectLockRetainUntilDate).toBeInstanceOf(Date);
    // No staging key, no copy — exactly one write.
    expect(sent.filter((c) => c.name === "CopyObjectCommand")).toHaveLength(0);
    const head = sent.find((c) => c.name === "HeadObjectCommand")!;
    expect(head.input.VersionId).toBe("ver-1");
    expect(head.input.ChecksumMode).toBe("ENABLED");
    expect(out.versionId).toBe("ver-1");
    expect(out.sha256Hex).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("classifies an Object Lock checksum refusal as deterministic, not retryable", async () => {
    respond = (name) => (name === "PutObjectCommand" ? s3Error("InvalidRequest") : {});
    await expect(
      publishImmutableArtifact({
        bucket: "b",
        key: "k",
        body: { kind: "buffer", buffer: body },
        sha256Base64: sha,
        contentType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(StoragePublicationRejectedError);
  });

  it("treats a 412 over OUR exact bytes as a lost response, and different bytes as a conflict", async () => {
    respond = (name, input) =>
      name === "PutObjectCommand"
        ? s3Error("PreconditionFailed", 412)
        : {
            VersionId: input.VersionId ?? "ver-existing",
            ContentLength: body.length,
            ChecksumSHA256: sha,
            ObjectLockMode: "COMPLIANCE",
            ObjectLockRetainUntilDate: new Date(Date.now() + 2921 * 86400_000),
          };
    const ok = await publishImmutableArtifact({
      bucket: "b",
      key: "k",
      body: { kind: "buffer", buffer: body },
      sha256Base64: sha,
      contentType: "application/pdf",
    });
    expect(ok.versionId).toBe("ver-existing");

    respond = (name) =>
      name === "PutObjectCommand"
        ? s3Error("PreconditionFailed", 412)
        : { ContentLength: body.length, ChecksumSHA256: "different" };
    await expect(
      publishImmutableArtifact({
        bucket: "b",
        key: "k",
        body: { kind: "buffer", buffer: body },
        sha256Base64: sha,
        contentType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(StoragePublicationRejectedError);
  });

  it("refuses to return an object whose stored digest or retention does not match", async () => {
    respond = (name, input) =>
      name === "PutObjectCommand"
        ? { VersionId: "v" }
        : { VersionId: input.VersionId, ContentLength: body.length, ChecksumSHA256: sha, ObjectLockMode: null };
    await expect(
      publishImmutableArtifact({
        bucket: "b",
        key: "k",
        body: { kind: "buffer", buffer: body },
        sha256Base64: sha,
        contentType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(StoragePublicationVerifyError);
  });
});

describe("comparePublishedObject", () => {
  const expected = {
    sizeBytes: 10,
    sha256Base64: "a",
    objectLockMode: "COMPLIANCE" as const,
    minimumRetainUntil: new Date(2_000_000_000_000),
  };
  it("passes an exact match", () => {
    expect(
      comparePublishedObject({
        expected,
        observed: {
          sizeBytes: 10,
          checksumSha256: "a",
          objectLockMode: "COMPLIANCE",
          objectLockRetainUntil: new Date(2_000_000_000_000),
        },
      }),
    ).toEqual([]);
  });
  it("names every mismatch", () => {
    expect(
      comparePublishedObject({
        expected,
        observed: {
          sizeBytes: 9,
          checksumSha256: "b",
          objectLockMode: "GOVERNANCE",
          objectLockRetainUntil: new Date(1_000),
        },
      }),
    ).toEqual(["size", "sha256", "object_lock_mode", "object_lock_retain_until"]);
  });
});

describe("buildPublicationKey", () => {
  it("never repeats a key across attempts", () => {
    const a = buildPublicationKey({ family: "verification", evidenceId: "e", version: 7, requestId: "r", extension: "zip" });
    const b = buildPublicationKey({ family: "verification", evidenceId: "e", version: 7, requestId: "r", extension: "zip" });
    expect(a).not.toBe(b);
    expect(a.startsWith("verification/e/v7/r-")).toBe(true);
  });
});

/**
 * INGEST-005 — the resumable sequence cannot seal a record without a file the
 * user saw as uploaded, and a late failure can be retried.
 *
 * A bridge failure was swallowed and reported as success. A second complete
 * reused an upload id that storage had already spent, so it could never finish.
 * A cancel after storage completion left the bridged part to be sealed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ complete: vi.fn(async () => ({ ok: true, etag: "etag-final" })) }));
const writer = vi.hoisted(() => ({
  write: vi.fn(async () => ({ part: { id: "part-1" } })),
  lock: vi.fn(async () => undefined),
}));

vi.mock("../src/services/uploads/storage-multipart.js", () => ({
  abortMultipartUpload: vi.fn(async () => ({ ok: true, alreadyAbsent: true })),
  createPresignedPartUploadUrl: vi.fn(),
  initiateMultipartUpload: vi.fn(),
  completeMultipartUpload: storage.complete,
  headCompletedObject: vi.fn(async () => ({ ok: true, contentLength: 1024 })),
  verifyCompletedObject: vi.fn(async () => ({ ok: true, serverSha256: "a".repeat(64), matchedExpected: true })),
}));
vi.mock("../src/services/evidence/evidence-part-writer.service.js", async (original) => ({
  ...(await original<typeof import("../src/services/evidence/evidence-part-writer.service.js")>()),
  writeEvidencePart: writer.write,
  lockEvidenceForByteWrite: writer.lock,
}));

const { abortStorageMultipart, completeStorageMultipart, evaluateUploadSessionFinalizeGate } = await import(
  "../src/services/uploads/upload-session.service.js"
);

function session(over: Record<string, unknown> = {}) {
  return {
    id: "s-1",
    team_id: "t-1",
    evidence_id: "ev-1",
    actor_user_id: "u-1",
    state: "UPLOADING",
    expected_part_count: 2,
    expected_sha256: "a".repeat(64),
    expected_total_bytes: 1024,
    multipart_upload_id: "mpu-1",
    storage_bucket: "b",
    storage_key: "k",
    completed_at_storage_utc: null,
    completed_object_etag: null,
    aborted_at_storage_utc: null,
    target_part_index: 0,
    original_file_name: "large.mov",
    expected_mime_type: "video/quicktime",
    bridged_evidence_part_id: null,
    ...over,
  };
}

function client(row: Record<string, unknown>) {
  const queries = [[row], [{ part_index: 0, part_etag: "e0" }, { part_index: 1, part_etag: "e1" }]];
  const deleted: unknown[] = [];
  const c = {
    $queryRawUnsafe: vi.fn(async () => queries.shift() ?? []),
    $executeRawUnsafe: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        $executeRawUnsafe: vi.fn(async () => 1),
        evidencePart: {
          deleteMany: vi.fn(async (a: unknown) => {
            deleted.push(a);
            return { count: 1 };
          }),
        },
      }),
    ),
  };
  return { c: c as never, deleted };
}

const complete = (c: never) =>
  completeStorageMultipart({ teamId: "t-1", sessionId: "s-1", actorUserId: "u-1", verifyHash: true } as never, c);

describe("the resumable sequence", () => {
  beforeEach(() => {
    storage.complete.mockClear();
    writer.write.mockReset();
    writer.write.mockImplementation(async () => ({ part: { id: "part-1" } }));
    writer.lock.mockClear();
  });

  it("positive control: a first complete assembles the object and bridges its part", async () => {
    const res = await complete(client(session()).c);
    expect(res).toMatchObject({ ok: true, etag: "etag-final" });
    expect(storage.complete).toHaveBeenCalledOnce();
    expect(writer.write).toHaveBeenCalledOnce();
  });

  it("a bridge failure is a failure, never a success the client marks as uploaded", async () => {
    writer.write.mockRejectedValueOnce(new Error("connection reset"));
    const res = await complete(client(session()).c);
    expect(res).toEqual({ ok: false, reason: "storage_unavailable" });
  });

  it("the retry after that failure does not reassemble: it bridges and succeeds", async () => {
    const res = await complete(
      client(session({ completed_at_storage_utc: new Date(), completed_object_etag: "etag-final" })).c,
    );
    expect(res).toMatchObject({ ok: true, etag: "etag-final" });
    expect(storage.complete).not.toHaveBeenCalled();
    expect(writer.write).toHaveBeenCalledOnce();
  });

  it("a completed session with no bridged part refuses the seal", async () => {
    const c = {
      $queryRawUnsafe: vi.fn().mockResolvedValueOnce([
        {
          id: "s-1",
          state: "COMPLETED",
          completed_at_utc: new Date(),
          aborted_at_utc: null,
          expires_at_utc: new Date(),
          created_at_utc: new Date(),
          target_part_index: 0,
          original_file_name: "large.mov",
          bridged_evidence_part_id: null,
        },
      ]),
    };
    const gate = await evaluateUploadSessionFinalizeGate({ teamId: "t-1", evidenceId: "ev-1" }, c as never);
    expect(gate).toMatchObject({ ok: false, reason: "session_part_missing", sessionId: "s-1" });
  });

  it("a cancel after storage completion removes the unsealed bridged part", async () => {
    const { c, deleted } = client(session({ bridged_evidence_part_id: "part-1", completed_at_storage_utc: new Date() }));
    const res = await abortStorageMultipart({ teamId: "t-1", sessionId: "s-1", actorUserId: "u-1", reason: "user_cancel" }, c);
    expect(res).toMatchObject({ ok: true });
    expect(writer.lock).toHaveBeenCalledOnce();
    expect(deleted).toEqual([{ where: { id: "part-1", evidenceId: "ev-1" } }]);
  });

  it("a sealed record refuses that removal, and nothing is deleted", async () => {
    const { EvidencePartWriteRefused } = await import("../src/services/evidence/evidence-part-writer.service.js");
    writer.lock.mockRejectedValueOnce(new EvidencePartWriteRefused("EVIDENCE_NOT_WRITABLE"));
    const { c, deleted } = client(session({ bridged_evidence_part_id: "part-1" }));
    const res = await abortStorageMultipart({ teamId: "t-1", sessionId: "s-1", actorUserId: "u-1", reason: "user_cancel" }, c);
    expect(res).toEqual({ ok: false, reason: "evidence_not_writable" });
    expect(deleted).toEqual([]);
  });
});

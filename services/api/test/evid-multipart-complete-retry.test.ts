/**
 * PRO-C1-04 — multipart/complete is retryable after a failure between storage
 * assembly and recording it.
 *
 * Once storage has assembled the object (CompleteMultipartUpload succeeded) its
 * upload id no longer exists: re-sending it answers NoSuchUpload. If the HEAD (or
 * hash) step after assembly failed, the first call returned an error WITHOUT
 * recording that storage had completed, so every retry re-sent the dead upload
 * id and failed for good. The fix records completed_at_storage_utc and the etag
 * right after CompleteMultipartUpload succeeds, so a retry takes the INGEST-005
 * re-check path.
 *
 * Storage is a stateful double that behaves like S3 (an upload id completes
 * once; afterwards it is unknown). The session row is a stateful double that
 * keeps what the service persisted between the two calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  liveUploadIds: new Set<string>(),
  completeCalls: 0,
  headFailuresLeft: 0,
}));

vi.mock("../src/services/uploads/storage-multipart.js", () => ({
  abortMultipartUpload: vi.fn(),
  createPresignedPartUploadUrl: vi.fn(),
  initiateMultipartUpload: vi.fn(),
  completeMultipartUpload: vi.fn(async (input: { multipartUploadId: string }) => {
    storage.completeCalls += 1;
    if (!storage.liveUploadIds.has(input.multipartUploadId)) return { ok: false, reason: "multipart_not_found" };
    storage.liveUploadIds.delete(input.multipartUploadId);
    return { ok: true, etag: "etag-final" };
  }),
  headCompletedObject: vi.fn(async () => {
    if (storage.headFailuresLeft > 0) {
      storage.headFailuresLeft -= 1;
      return { ok: false, reason: "storage_unavailable" };
    }
    return { ok: true, contentLength: 2048 };
  }),
  verifyCompletedObject: vi.fn(async () => ({ ok: true, serverSha256: "b".repeat(64), matchedExpected: false })),
}));

const { completeStorageMultipart } = await import("../src/services/uploads/upload-session.service.js");

const TEAM = "team-c104";
const SESSION = "session-c104";

/** A session row that keeps what the service writes to it between calls. */
function statefulSession() {
  const row: Record<string, unknown> = {
    id: SESSION,
    team_id: TEAM,
    evidence_id: "ev-c104",
    actor_user_id: "u-c104",
    state: "UPLOADING",
    expected_part_count: 2,
    expected_sha256: null,
    expected_total_bytes: 2048,
    multipart_upload_id: "mpu-c104",
    storage_bucket: "b",
    storage_key: "k",
    target_part_index: null,
    original_file_name: null,
    expected_mime_type: null,
    bridged_evidence_part_id: null,
    completed_at_storage_utc: null,
    completed_object_etag: null,
    lifetime_expired: false,
  };
  let reads = 0;
  const client = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes(`"evidence_upload_session_parts"`)) {
        return [
          { part_index: 0, part_etag: "e0" },
          { part_index: 1, part_etag: "e1" },
        ];
      }
      reads += 1;
      return [{ ...row }];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      // Persist the storage-completion facts the service records on the session.
      if (/UPDATE "evidence_upload_sessions"/.test(sql) && sql.includes(`"completed_at_storage_utc"`)) {
        row.completed_at_storage_utc ??= new Date();
        row.completed_object_etag ??= args[2] ?? null;
      }
      if (/UPDATE "evidence_upload_sessions"/.test(sql) && /"state" = 'COMPLETED'/.test(sql)) row.state = "COMPLETED";
      return 1;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
  };
  return { client: client as never, row, reads: () => reads };
}

describe("PRO-C1-04 — multipart/complete after a post-assembly failure", () => {
  beforeEach(() => {
    storage.liveUploadIds = new Set(["mpu-c104"]);
    storage.completeCalls = 0;
    storage.headFailuresLeft = 0;
  });

  it("allowed retry: a HEAD failure after storage assembled the object leaves the session retryable, and the retry completes without re-sending the upload id", async () => {
    storage.headFailuresLeft = 1;
    const s = statefulSession();
    const first = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: false }, s.client);
    expect(first.ok).toBe(false);
    expect(s.row.completed_at_storage_utc).not.toBeNull();
    expect(s.row.completed_object_etag).toBe("etag-final");

    const retry = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: false }, s.client);
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    expect(storage.completeCalls).toBe(1);
  });

  it("refused: a storage refusal of the assembly records nothing, so nothing claims storage completed", async () => {
    storage.liveUploadIds = new Set(); // the upload id is unknown to storage
    const s = statefulSession();
    const r = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: false }, s.client);
    expect(r).toMatchObject({ ok: false, reason: "multipart_not_found" });
    expect(s.row.completed_at_storage_utc).toBeNull();
  });

  it("control: a clean first call completes with one assembly", async () => {
    const s = statefulSession();
    const r = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: false }, s.client);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(storage.completeCalls).toBe(1);
  });
});

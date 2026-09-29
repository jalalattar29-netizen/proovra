/**
 * ET-UPL-05 — multipart completion enforces the declared size and only
 * claims VERIFIED for parts whose whole-object digest matched a reference.
 *
 * On a40ca76f completeStorageMultipart accepted a completed object of ANY
 * size (expected_total_bytes was never read), and marked every part VERIFIED
 * whenever the server merely hashed the object — even when the client had
 * declared no reference hash, so nothing was verified against anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  contentLength: 1024,
  matchedExpected: false as boolean,
}));

vi.mock("../src/services/uploads/storage-multipart.js", () => ({
  abortMultipartUpload: vi.fn(),
  createPresignedPartUploadUrl: vi.fn(),
  initiateMultipartUpload: vi.fn(),
  completeMultipartUpload: vi.fn(async () => ({ ok: true, etag: "etag-final" })),
  headCompletedObject: vi.fn(async () => ({ ok: true, contentLength: storage.contentLength })),
  verifyCompletedObject: vi.fn(async () => ({
    ok: true,
    serverSha256: "a".repeat(64),
    matchedExpected: storage.matchedExpected,
  })),
}));

const { completeStorageMultipart } = await import(
  "../src/services/uploads/upload-session.service.js"
);

const TEAM = "team-1";
const SESSION = "session-1";

type Exec = { sql: string; args: unknown[] };

function stubClient(session: Record<string, unknown>) {
  const executes: Exec[] = [];
  const queries = [
    [session],
    [
      { part_index: 0, part_etag: "e0" },
      { part_index: 1, part_etag: "e1" },
    ],
  ];
  const client = {
    $queryRawUnsafe: vi.fn(async () => queries.shift() ?? []),
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      executes.push({ sql, args });
      return 1;
    }),
  };
  return { client: client as never, executes };
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    team_id: TEAM,
    evidence_id: "ev-1",
    actor_user_id: "u-1",
    state: "UPLOADING",
    expected_part_count: 2,
    expected_sha256: null,
    expected_total_bytes: 1024,
    multipart_upload_id: "mpu-1",
    storage_bucket: "b",
    storage_key: "k",
    target_part_index: null,
    original_file_name: null,
    expected_mime_type: null,
    bridged_evidence_part_id: null,
    ...over,
  };
}

const partsUpdate = (executes: Exec[]) =>
  executes.find((e) => e.sql.includes(`UPDATE "evidence_upload_session_parts"`));

describe("completeStorageMultipart — declared size and reference (ET-UPL-05)", () => {
  beforeEach(() => {
    storage.contentLength = 1024;
    storage.matchedExpected = false;
  });

  it("a completed object of another size than declared fails the session size_mismatch", async () => {
    storage.contentLength = 4096;
    const { client, executes } = stubClient(session({ expected_total_bytes: 1024 }));
    const result = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: true }, client);
    expect(result).toEqual({ ok: false, reason: "size_mismatch" });
    const failed = executes.find((e) => /SET "state" = 'FAILED'/.test(e.sql));
    expect(failed?.args).toEqual([SESSION, TEAM]);
    expect(partsUpdate(executes)).toBeUndefined();
  });

  it("no reference hash declared → parts settle HASHED, never VERIFIED", async () => {
    storage.matchedExpected = false;
    const { client, executes } = stubClient(session({ expected_sha256: null }));
    const result = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: true }, client);
    expect(result.ok).toBe(true);
    expect(partsUpdate(executes)?.args).toEqual([SESSION, TEAM, "a".repeat(64), "HASHED"]);
  });

  it("a matched reference hash → parts settle VERIFIED", async () => {
    storage.matchedExpected = true;
    const { client, executes } = stubClient(session({ expected_sha256: "a".repeat(64) }));
    const result = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: true }, client);
    expect(result.ok).toBe(true);
    expect(partsUpdate(executes)?.args).toEqual([SESSION, TEAM, "a".repeat(64), "VERIFIED"]);
  });

  it("an undeclared size is not enforced (legacy sessions stay completable)", async () => {
    storage.contentLength = 777;
    const { client } = stubClient(session({ expected_total_bytes: null }));
    const result = await completeStorageMultipart({ teamId: TEAM, sessionId: SESSION, verifyHash: true }, client);
    expect(result.ok).toBe(true);
  });
});

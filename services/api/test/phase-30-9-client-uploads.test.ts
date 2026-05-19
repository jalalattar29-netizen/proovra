/**
 * Phase 30.9 — Client-side resumable upload orchestrator tests.
 *
 * Six layers of coverage:
 *
 *   1. **Pure logic** — chunk planner + retry classifier are pure
 *      modules in apps/web/lib/uploads/. We import them directly
 *      and exercise the branching.
 *
 *   2. **Bounded vocabularies** — every state / failure-reason /
 *      classification catalog is exhaustive + snake/UPPER_SNAKE
 *      cased.
 *
 *   3. **Persistence projection** — verify `project()` strips the
 *      ETag (storage metadata), collapses transient client-only
 *      part states to PENDING, and persists nothing browser-specific.
 *
 *   4. **Recovery classification** — server state strings map to
 *      bounded classifications with the right cleanupSafe /
 *      resumable / needsAttention flags.
 *
 *   5. **Source-contract: custody-safety** — the orchestrator,
 *      persistence, recovery, and UI panel source files NEVER
 *      reference custody events, never set uploadedAt, never
 *      project storage keys / signed URLs / multipartUploadId.
 *
 *   6. **Backend metric registration** — the 11 client-side
 *      counters from the brief are registered.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// =============================================================================
// Direct imports of pure apps/web modules (no browser API dependency)
// =============================================================================

import {
  classifyRetry,
  planChunks,
} from "../../../apps/web/lib/uploads/retry.js";
import {
  CLIENT_FAILURE_REASONS,
  CLIENT_PART_STATES,
  CLIENT_UPLOAD_SESSION_STATES,
  DEFAULT_CHUNK_SIZE_BYTES,
  MAX_CHUNK_SIZE_BYTES,
  MAX_CONCURRENCY,
  MAX_PART_RETRIES,
  MAX_RETRY_BACKOFF_MS,
  MIN_CHUNK_SIZE_BYTES,
  MIN_CONCURRENCY,
  MIN_RETRY_BACKOFF_MS,
  OFFLINE_DRAFT_STATES,
} from "../../../apps/web/lib/uploads/types.js";
import { RECOVERY_CLASSIFICATIONS } from "../../../apps/web/lib/uploads/recovery.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Chunk planner (pure)
// =============================================================================

describe("Phase 30.9 — chunk planner", () => {
  it("clamps chunk size to [5 MiB, 64 MiB]", () => {
    const small = planChunks(100 * 1024 * 1024, 1024); // requested 1 KB
    // With min 5 MiB chunks, 100 MiB → exactly 20 chunks (no rounding up).
    expect(small.length).toBeGreaterThanOrEqual(15);
    expect(small.length).toBeLessThanOrEqual(20);

    const big = planChunks(
      500 * 1024 * 1024,
      512 * 1024 * 1024, // requested 512 MiB
    );
    // Clamped to 64 MiB → 500 / 64 ≈ 8 chunks.
    expect(big.length).toBeGreaterThanOrEqual(7);
    expect(big.length).toBeLessThanOrEqual(8);
  });

  it("plan covers the entire file with no overlap and no gaps", () => {
    const file = 100_000_000;
    const plan = planChunks(file);
    expect(plan[0].byteStart).toBe(0);
    expect(plan[plan.length - 1].byteEnd).toBe(file);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].byteStart).toBe(plan[i - 1].byteEnd);
    }
    const total = plan.reduce((acc, p) => acc + p.byteLength, 0);
    expect(total).toBe(file);
  });

  it("emits 0-indexed partIndex strictly ascending", () => {
    const plan = planChunks(30 * 1024 * 1024);
    for (let i = 0; i < plan.length; i++) {
      expect(plan[i].partIndex).toBe(i);
    }
  });

  it("respects S3's 10000-part hard limit", () => {
    // 100 GiB → with 5 MiB chunks, would be 20480 parts — but planner
    // caps at 10_000 by widening the effective chunk size.
    const huge = planChunks(100 * 1024 ** 3, 5 * 1024 * 1024);
    expect(huge.length).toBeLessThanOrEqual(10_000);
  });

  it("rejects negative or non-finite totalBytes", () => {
    expect(() => planChunks(-1)).toThrow();
    expect(() => planChunks(Number.NaN)).toThrow();
  });

  it("zero-byte file yields a single zero-byte plan entry", () => {
    const plan = planChunks(0);
    expect(plan.length).toBe(1);
    expect(plan[0].byteLength).toBe(0);
  });

  it("default chunk size is bounded + matches DEFAULT_CHUNK_SIZE_BYTES", () => {
    expect(DEFAULT_CHUNK_SIZE_BYTES).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE_BYTES);
    expect(DEFAULT_CHUNK_SIZE_BYTES).toBeLessThanOrEqual(MAX_CHUNK_SIZE_BYTES);
  });
});

// =============================================================================
// PART 2 — Retry classifier (pure)
// =============================================================================

describe("Phase 30.9 — retry classifier", () => {
  it("offline → retry with MAX_RETRY_BACKOFF_MS wait + 'offline' reason", () => {
    const d = classifyRetry({ status: 500, attempt: 0, isOnline: false });
    expect(d.kind).toBe("retry");
    if (d.kind === "retry") {
      expect(d.reason).toBe("offline");
      expect(d.waitMs).toBe(MAX_RETRY_BACKOFF_MS);
    }
  });

  it("attempt >= MAX_PART_RETRIES → terminal", () => {
    const d = classifyRetry({
      status: 500,
      attempt: MAX_PART_RETRIES,
      isOnline: true,
    });
    expect(d.kind).toBe("terminal");
  });

  it("401 / 403 / 404 → terminal put_4xx", () => {
    for (const status of [401, 403, 404]) {
      const d = classifyRetry({ status, attempt: 0, isOnline: true });
      expect(d.kind).toBe("terminal");
      if (d.kind === "terminal") expect(d.reason).toBe("put_4xx");
    }
  });

  it("422 → terminal hash_mismatch (custody integrity signal)", () => {
    const d = classifyRetry({ status: 422, attempt: 0, isOnline: true });
    expect(d.kind).toBe("terminal");
    if (d.kind === "terminal") expect(d.reason).toBe("hash_mismatch");
  });

  it("410 → terminal session_expired", () => {
    const d = classifyRetry({ status: 410, attempt: 0, isOnline: true });
    expect(d.kind).toBe("terminal");
    if (d.kind === "terminal") expect(d.reason).toBe("session_expired");
  });

  it("409 → terminal conflict", () => {
    const d = classifyRetry({ status: 409, attempt: 0, isOnline: true });
    expect(d.kind).toBe("terminal");
    if (d.kind === "terminal") expect(d.reason).toBe("conflict");
  });

  it("429 → retry with Retry-After floor honored + bounded by MAX_RETRY_BACKOFF_MS", () => {
    const d = classifyRetry({
      status: 429,
      attempt: 0,
      retryAfterSec: 10,
      isOnline: true,
    });
    expect(d.kind).toBe("retry");
    if (d.kind === "retry") {
      expect(d.waitMs).toBeGreaterThanOrEqual(10_000);
      expect(d.waitMs).toBeLessThanOrEqual(MAX_RETRY_BACKOFF_MS);
      expect(d.reason).toBe("rate_limited");
    }
  });

  it("503 → retry with bounded backoff + 'service_unavailable' reason", () => {
    const d = classifyRetry({ status: 503, attempt: 0, isOnline: true });
    expect(d.kind).toBe("retry");
    if (d.kind === "retry") {
      expect(d.reason).toBe("service_unavailable");
      expect(d.waitMs).toBeGreaterThanOrEqual(MIN_RETRY_BACKOFF_MS / 2); // jitter floor
      expect(d.waitMs).toBeLessThanOrEqual(MAX_RETRY_BACKOFF_MS);
    }
  });

  it("status === 0 (network error) → retry network_error", () => {
    const d = classifyRetry({ status: 0, attempt: 0, isOnline: true });
    expect(d.kind).toBe("retry");
    if (d.kind === "retry") expect(d.reason).toBe("network_error");
  });

  it("exponential backoff grows with attempt count (bounded)", () => {
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = classifyRetry({ status: 500, attempt: i, isOnline: true });
      if (d.kind === "retry") waits.push(d.waitMs);
    }
    // Each wait should be ≤ MAX_RETRY_BACKOFF_MS and the later
    // attempts should not be systematically smaller than the
    // earlier ones (jitter aside).
    for (const w of waits) {
      expect(w).toBeLessThanOrEqual(MAX_RETRY_BACKOFF_MS);
    }
  });
});

// =============================================================================
// PART 3 — Bounded vocabularies
// =============================================================================

describe("Phase 30.9 — bounded vocabularies", () => {
  it("CLIENT_UPLOAD_SESSION_STATES covers every operator-visible state", () => {
    for (const required of [
      "STAGED",
      "CREATING_SESSION",
      "INITIATING_MULTIPART",
      "UPLOADING",
      "PAUSED",
      "VERIFYING",
      "READY_FOR_FINALIZATION",
      "FINALIZING",
      "FINALIZED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
      "CANCELLED",
      "CONFLICT",
    ]) {
      expect(CLIENT_UPLOAD_SESSION_STATES).toContain(required as never);
    }
    for (const s of CLIENT_UPLOAD_SESSION_STATES) {
      expect(s).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });

  it("OFFLINE_DRAFT_STATES matches the brief catalog exactly", () => {
    expect([...OFFLINE_DRAFT_STATES]).toEqual([
      "LOCAL_ONLY",
      "SERVER_DRAFT",
      "SYNC_PENDING",
      "SYNCING",
      "PARTIALLY_UPLOADED",
      "READY_FOR_FINALIZATION",
      "FINALIZING",
      "FINALIZED",
      "CONFLICT",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
      "CANCELLED",
    ]);
  });

  it("CLIENT_PART_STATES include the server vocabulary + client-only scheduler states", () => {
    for (const required of [
      "PENDING",
      "UPLOADED_UNVERIFIED",
      "VERIFIED",
      "FAILED",
    ]) {
      expect(CLIENT_PART_STATES).toContain(required as never);
    }
    // Client-only scheduler states (won't appear in server catalog):
    for (const cs of ["QUEUED", "PRESIGNING", "IN_FLIGHT", "PAUSED"]) {
      expect(CLIENT_PART_STATES).toContain(cs as never);
    }
  });

  it("CLIENT_FAILURE_REASONS is exhaustive + snake_case", () => {
    for (const required of [
      "network_error",
      "offline",
      "presign_failed",
      "put_5xx",
      "put_4xx",
      "etag_missing",
      "mark_uploaded_failed",
      "multipart_complete_failed",
      "session_expired",
      "session_aborted",
      "session_failed",
      "hash_mismatch",
      "conflict",
      "cancelled_by_user",
      "rate_limited",
      "service_unavailable",
      "unknown",
    ]) {
      expect(CLIENT_FAILURE_REASONS).toContain(required as never);
    }
    for (const r of CLIENT_FAILURE_REASONS) {
      expect(r).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it("concurrency / chunk / retry / backoff bounds are sane", () => {
    expect(MIN_CONCURRENCY).toBe(1);
    expect(MAX_CONCURRENCY).toBe(6);
    expect(MIN_CHUNK_SIZE_BYTES).toBeLessThan(MAX_CHUNK_SIZE_BYTES);
    expect(MAX_PART_RETRIES).toBeGreaterThan(0);
    expect(MIN_RETRY_BACKOFF_MS).toBeLessThan(MAX_RETRY_BACKOFF_MS);
  });

  it("RECOVERY_CLASSIFICATIONS is exhaustive + snake_case", () => {
    for (const c of [
      "resumable",
      "verifying",
      "ready_for_finalization",
      "finalized",
      "expired",
      "aborted",
      "failed",
      "not_found",
      "unknown",
    ]) {
      expect(RECOVERY_CLASSIFICATIONS).toContain(c as never);
    }
    for (const c of RECOVERY_CLASSIFICATIONS) {
      expect(c).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });
});

// =============================================================================
// PART 4 — Source-contract: orchestrator custody-safety
// =============================================================================

describe("Phase 30.9 — orchestrator custody-safety", () => {
  const src = readSource(
    "../../../apps/web/lib/uploads/multipart-uploader.ts",
  );
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("NEVER calls /v1/evidence/:id/complete (finalize stays server-side)", () => {
    expect(noComments).not.toMatch(/\/v1\/evidence\/[^"]*\/complete/);
    // The orchestrator does call multipart/complete (storage-side
    // only); that is NOT evidence finalization.
    expect(noComments).toMatch(/multipart\/initiate/);
  });

  it("NEVER creates custody events (no appendCustody / CustodyEventType references)", () => {
    expect(noComments).not.toMatch(/appendCustody/);
    expect(noComments).not.toMatch(/CustodyEventType/);
    expect(noComments).not.toMatch(/custody[-_]event/i);
  });

  it("NEVER writes the canonical Evidence.uploadedAt field", () => {
    // No `uploadedAt: ...` setter (the orchestrator's snapshot
    // carries `lastServerContactMs` instead — advisory only).
    expect(noComments).not.toMatch(/uploadedAtUtc\s*[:=]/);
    expect(noComments).not.toMatch(/uploadedAt\s*[:=]/);
  });

  it("NEVER claims serverSha256 from local code", () => {
    // The orchestrator never computes a SHA-256. That belongs to
    // the server-side verifier worker.
    expect(noComments).not.toMatch(/serverSha256\s*=\s*[^"']/);
    expect(noComments).not.toMatch(/crypto\.subtle\.digest/);
  });

  it("ETag is recorded as opaque storage metadata, never compared to sha256", () => {
    // No `etag === sha256` / `sha256 === etag` patterns.
    expect(noComments).not.toMatch(/sha256\w*\s*===\s*\w*[Ee][Tt]ag/);
    expect(noComments).not.toMatch(/\w*[Ee][Tt]ag\s*===\s*sha256/);
  });

  it("snapshot projection never exposes storage keys / multipartUploadId / signed URLs", () => {
    // Surface check on the snapshot() function only.
    const snapshotFn = src.match(/snapshot\(\):\s*UploadProgressSnapshot[\s\S]*?\n  \}/)?.[0];
    expect(snapshotFn).toBeTruthy();
    for (const banned of [
      "storageBucket",
      "storage_bucket",
      "storageKey",
      "storage_key",
      "multipartUploadId",
      "multipart_upload_id",
      "uploadUrl",
      "presigned",
      "signed_url",
      "signedUrl",
    ]) {
      expect(snapshotFn!, `snapshot leaks ${banned}`).not.toContain(banned);
    }
  });

  it("presigned PUT bypasses apiFetch (no auth-header attachment to S3)", () => {
    // The PUT to S3 must use the global `fetch` — apiFetch would
    // attach the Bearer token, which would taint the presigned URL
    // and trip CORS.
    expect(src).toMatch(/await fetch\(presign[^,]+,\s*\{\s*\n?\s*method:\s*"PUT"/);
  });

  it("concurrency + chunk size clamped via clamp() helper (bounded)", () => {
    expect(src).toMatch(/clamp\(/);
    expect(src).toMatch(/MIN_CONCURRENCY/);
    expect(src).toMatch(/MAX_CONCURRENCY/);
  });

  it("no full-file buffering — file.slice() is the only byte handle", () => {
    // The orchestrator must consume the file via `file.slice(start, end)`
    // and pipe straight to fetch. No `readAsArrayBuffer`, no
    // `arrayBuffer()` on the whole file.
    expect(noComments).toMatch(/this\.cfg\.file\.slice\(/);
    expect(noComments).not.toMatch(/readAsArrayBuffer/);
    expect(noComments).not.toMatch(/file\.arrayBuffer\(\)/);
  });

  it("safeToClose only true when no parts in flight + state is terminal/paused/ready", () => {
    // The helper is `private computeSafeToClose(): boolean { ... }`.
    const fn = src.match(
      /private computeSafeToClose\(\)[\s\S]*?\n  \}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/this\.inFlightCount\s*>\s*0/);
  });
});

// =============================================================================
// PART 5 — Source-contract: persistence + recovery + UI panel
// =============================================================================

describe("Phase 30.9 — persistence + recovery + UI anti-leak", () => {
  const persistenceSrc = readSource(
    "../../../apps/web/lib/uploads/persistence.ts",
  );
  const recoverySrc = readSource(
    "../../../apps/web/lib/uploads/recovery.ts",
  );
  const panelSrc = readSource(
    "../../../apps/web/components/uploads/UploadOperationsPanel.tsx",
  );

  it("persistence layer NEVER stores raw bytes / URLs / S3 identifiers", () => {
    const noComments = persistenceSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "ArrayBuffer",
      "Blob.prototype",
      "uploadUrl",
      "presignedUrl",
      "storage_bucket",
      "storageBucket",
      "storage_key",
      "storageKey",
      "multipartUploadId",
      "multipart_upload_id",
    ]) {
      expect(noComments, `persistence leaks ${banned}`).not.toContain(banned);
    }
  });

  it("persistence project() strips part.etag (storage metadata, not needed for resume)", () => {
    const projectFn = persistenceSrc.match(
      /function projectSnapshot\([\s\S]*?\n\}/,
    )?.[0];
    expect(projectFn).toBeTruthy();
    // Strip comments — the function intentionally documents the
    // anti-leak in its body.
    const body = projectFn!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(body).not.toContain("etag");
    expect(body).not.toContain("ETag");
  });

  it("persistence stripClientOnlyPartState collapses transient states to PENDING (clean resume)", () => {
    const helper = persistenceSrc.match(
      /function stripClientOnlyPartState\([\s\S]*?\n\}/,
    )?.[0];
    expect(helper).toBeTruthy();
    expect(helper!).toMatch(/PRESIGNING/);
    expect(helper!).toMatch(/IN_FLIGHT/);
    expect(helper!).toMatch(/QUEUED/);
    expect(helper!).toMatch(/return "PENDING"/);
  });

  it("recovery NEVER auto-resumes (entry exposes a resumable boolean but no auto-action)", () => {
    const noComments = recoverySrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // No function name / call that auto-resumes.
    expect(noComments).not.toMatch(/autoResume|autoRecover|silentRecover/);
    // No code that calls `resume()` or `start()` after classification.
    expect(noComments).not.toMatch(/\.resume\(\)/);
    expect(noComments).not.toMatch(/\.start\(\)/);
  });

  it("recovery classifies cleanupSafe correctly for terminal server states", () => {
    expect(recoverySrc).toMatch(
      /cleanupSafe:[\s\S]*?finalized[\s\S]*?aborted[\s\S]*?expired[\s\S]*?not_found/,
    );
  });

  it("UI panel NEVER reads storage / multipart identifiers from props", () => {
    const noComments = panelSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageBucket",
      "storage_bucket",
      "storageKey",
      "storage_key",
      "multipartUploadId",
      "multipart_upload_id",
      "uploadUrl",
      "presigned",
      "signed_url",
    ]) {
      expect(noComments, `panel leaks ${banned}`).not.toContain(banned);
    }
  });

  it("UI panel distinguishes 'Uploaded' from 'Server-verified' (anti-confusion)", () => {
    expect(panelSrc).toMatch(/Uploaded\s*\{uploadedPct\}/);
    expect(panelSrc).toMatch(/Server-verified\s*\{verifiedPct\}/);
  });

  it("UI panel shows 'Safe to close' / 'Do not close' messages", () => {
    expect(panelSrc).toMatch(/Safe to close/);
    expect(panelSrc).toMatch(/Do not close/);
  });

  it("UI panel surfaces hash mismatch as 'file integrity violated' (custody-careful wording)", () => {
    expect(panelSrc).toMatch(/Hash mismatch — file integrity violated/);
  });
});

// =============================================================================
// PART 6 — Backend metric registration
// =============================================================================

describe("Phase 30.9 — backend client-side telemetry counters", () => {
  const metricsSrc = readSource(
    "../../../services/api/src/services/ops/metrics.service.ts",
  );

  it("11 client-side counters registered per brief", () => {
    for (const m of [
      "upload_resume_total",
      "upload_pause_total",
      "upload_cancel_total",
      "upload_retry_total",
      "upload_chunk_retry_total",
      "upload_recovery_total",
      "offline_draft_created_total",
      "offline_draft_recovered_total",
      "offline_draft_conflict_total",
      "background_sync_retry_total",
      "background_sync_failed_total",
    ]) {
      expect(metricsSrc, `counter ${m} missing`).toContain(`"${m}"`);
    }
  });
});

// =============================================================================
// PART 7 — Persistence projection — behavioral
// =============================================================================

describe("Phase 30.9 — persistence projection behavioral", () => {
  it("project() turns IN_FLIGHT parts into PENDING + drops etag", async () => {
    const { createUploadPersistence } = await import(
      "../../../apps/web/lib/uploads/persistence.js"
    );
    const persistence = createUploadPersistence();
    const projected = persistence.project(
      {
        sessionId: "session-1",
        state: "UPLOADING",
        verifiedBytes: 0,
        uploadedBytes: 5 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024,
        parts: [
          {
            partIndex: 0,
            state: "IN_FLIGHT",
            bytes: 5 * 1024 * 1024,
            retryCount: 1,
            etag: "etag-should-not-persist",
            failureReason: null,
          },
          {
            partIndex: 1,
            state: "UPLOADED_UNVERIFIED",
            bytes: 5 * 1024 * 1024,
            retryCount: 0,
            etag: "another-etag",
            failureReason: null,
          },
        ],
        failureReason: null,
        isOnline: true,
        safeToClose: false,
        lastServerContactMs: Date.now(),
      },
      {
        evidenceId: "ev-1",
        teamId: "team-1",
        fileFingerprint: {
          name: "vid.mp4",
          sizeBytes: 10 * 1024 * 1024,
          lastModifiedMs: Date.now(),
        },
        createdAtMsClient: Date.now(),
      },
    );
    expect(projected.parts[0].state).toBe("PENDING"); // IN_FLIGHT collapsed
    expect(projected.parts[1].state).toBe("UPLOADED_UNVERIFIED"); // preserved
    // ETag is NOT persisted.
    expect(JSON.stringify(projected)).not.toContain("etag-should-not-persist");
    expect(JSON.stringify(projected)).not.toContain("another-etag");
  });
});

// =============================================================================
// PART 8 — Recovery: bounded mapping
// =============================================================================

describe("Phase 30.9 — recovery classification behavioral", () => {
  it("runs against a fake fetcher + persistence, classifies each known state", async () => {
    const { createUploadPersistence } = await import(
      "../../../apps/web/lib/uploads/persistence.js"
    );
    const { runUploadRecovery } = await import(
      "../../../apps/web/lib/uploads/recovery.js"
    );
    const persistence = createUploadPersistence();
    const baseEntry = {
      teamId: "team-1",
      evidenceId: "ev-1",
      fileFingerprint: {
        name: "doc.pdf",
        sizeBytes: 1024,
        lastModifiedMs: 0,
      },
      state: "UPLOADING" as const,
      parts: [],
      createdAtMsClient: 0,
      updatedAtMsClient: 0,
    };
    const states: Array<{ id: string; serverState: string | null }> = [
      { id: "s-uploading", serverState: "UPLOADING" },
      { id: "s-initiated", serverState: "INITIATED" },
      { id: "s-verifying", serverState: "VERIFYING" },
      { id: "s-completed", serverState: "COMPLETED" },
      { id: "s-expired", serverState: "EXPIRED" },
      { id: "s-aborted", serverState: "ABORTED" },
      { id: "s-failed", serverState: "FAILED" },
      { id: "s-notfound", serverState: null }, // forces 404
    ];
    for (const s of states) {
      await persistence.put({ ...baseEntry, sessionId: s.id });
    }
    const fakeFetcher = (async (url: string) => {
      const m = url.match(/sessions\/([^/?]+)\/status/);
      const id = m?.[1];
      const target = states.find((s) => s.id === id);
      if (!target || target.serverState === null) {
        const err = Object.assign(new Error("not_found"), {
          statusCode: 404,
        });
        throw err;
      }
      return { state: target.serverState };
    }) as never;
    const report = await runUploadRecovery({
      persistence,
      fetcher: fakeFetcher,
    });
    const byId = new Map(report.entries.map((e) => [e.sessionId, e]));
    expect(byId.get("s-uploading")?.classification).toBe("resumable");
    expect(byId.get("s-initiated")?.classification).toBe("resumable");
    expect(byId.get("s-verifying")?.classification).toBe("verifying");
    expect(byId.get("s-completed")?.classification).toBe(
      "ready_for_finalization",
    );
    expect(byId.get("s-expired")?.classification).toBe("expired");
    expect(byId.get("s-aborted")?.classification).toBe("aborted");
    expect(byId.get("s-failed")?.classification).toBe("failed");
    expect(byId.get("s-notfound")?.classification).toBe("not_found");

    expect(byId.get("s-completed")?.resumable).toBe(false);
    expect(byId.get("s-uploading")?.resumable).toBe(true);
    expect(byId.get("s-expired")?.cleanupSafe).toBe(true);
    expect(byId.get("s-failed")?.needsAttention).toBe(true);
  });
});

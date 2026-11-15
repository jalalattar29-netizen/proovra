/**
 * F-P1-02 / F-P1-08 (Free-user audit of 4d9b78963) — the resumable uploader
 * delivers its own scheduled retries, and reads storage PUT refusals by the
 * shared storage-PUT rule.
 *
 *   F-P1-02 — a part that failed transiently scheduled a retry timer, but the
 *             workers exited when no part was PENDING, so the pool drained,
 *             reported FAILED_RETRYABLE and the capture item failed (a one-part
 *             or last-part failure never got its retry). Workers now wait for a
 *             pending retry; a pause wakes them; the timer moves only a FAILED
 *             part back to PENDING.
 *   F-P1-08 — a 403 from storage (the presigned URL refused — expired) is
 *             retried with a fresh presign instead of failing terminally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ presigns: 0, uploaded: 0 }));
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    if (/\/presign$/.test(path)) {
      api.presigns += 1;
      return { uploadUrl: `https://s3.test/part?n=${api.presigns}`, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    }
    if (/\/uploaded$/.test(path)) api.uploaded += 1;
    return {};
  },
  readApiToken: () => null,
}));

import { MultipartUploader } from "../../lib/uploads/multipart-uploader";

let putAnswers: number[] = [];
const puts: string[] = [];

beforeEach(() => {
  api.presigns = 0;
  api.uploaded = 0;
  puts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      puts.push(url);
      const status = putAnswers.shift() ?? 200;
      return new Response(null, { status, headers: status === 200 ? { ETag: '"etag-1"' } : {} });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const oneChunkFile = () => new File([new Uint8Array(32)], "clip.mp4", { type: "video/mp4" });

function uploader() {
  return new MultipartUploader({
    sessionId: "sess-1",
    teamId: "ws-A",
    file: oneChunkFile(),
    concurrency: 1,
    isOnline: () => true,
    multipartAlreadyInitiated: true,
  });
}

describe("F-P1-02 — a scheduled retry is delivered, not dropped", () => {
  it("a transient 503 on the only part is retried and the upload reaches VERIFYING", async () => {
    putAnswers = [503];
    const u = uploader();
    const snap = await u.start();
    expect(snap.state).toBe("VERIFYING");
    expect(puts).toHaveLength(2);
    expect(api.uploaded).toBe(1);
  }, 15_000);

  it("a pause while a retry is pending stops promptly; the part stays FAILED until resumed, then completes", async () => {
    putAnswers = [503];
    const u = uploader();
    const running = u.start();
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    u.pause();
    const paused = await running;
    expect(paused.state).toBe("PAUSED");
    // The timer fires while paused: it must not re-queue the part.
    await new Promise((r) => setTimeout(r, 1_100));
    expect(u.snapshot().parts[0]!.state).toBe("FAILED");
    expect(puts).toHaveLength(1);
    const resumed = await u.resume();
    expect(resumed.state).toBe("VERIFYING");
    expect(puts).toHaveLength(2);
  }, 15_000);
});

describe("F-P1-08 — storage PUT refusals by the shared rule", () => {
  it("403 (expired URL) is retried with a fresh presign", async () => {
    putAnswers = [403];
    const snap = await uploader().start();
    expect(snap.state).toBe("VERIFYING");
    expect(api.presigns).toBe(2);
    expect(new Set(puts).size).toBe(2);
  }, 15_000);

  it("a refusal of the bytes (400) is final, without a retry", async () => {
    putAnswers = [400];
    const snap = await uploader().start();
    expect(snap.state).toBe("FAILED_TERMINAL");
    expect(puts).toHaveLength(1);
  });
});

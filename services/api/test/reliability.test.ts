/**
 * Phase 12 — API-side reliability tests.
 *
 *   - Upload limits respect env overrides + clamp to safe bounds
 *   - checkUploadSize correctly recommends multipart and refuses
 *     oversize uploads
 *   - Stale thresholds respect env overrides + clamp
 *   - Queue policy doc matches the worker source (single source of
 *     truth check)
 *   - Reliability route uses 404 (not 403) for non-admin (anti-enum)
 *   - Evidence finalize uses an atomic where-status guard (DB-level
 *     idempotency assertion via source-code check)
 *   - Session projection redacts the reserved `multipartUploadId`
 *
 * No DB required — purely service / helper / source-text tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkUploadSize,
  getStaleThresholds,
  getUploadSizeLimits,
} from "../src/services/reliability/upload-limits.service.js";
import {
  listQueuePolicies,
  OTS_UPGRADE_QUEUE_POLICY,
  REPORT_QUEUE_POLICY,
} from "../src/services/reliability/queue-policy.service.js";
import { projectUploadSession } from "../src/services/reliability/upload-session.service.js";

describe("upload size limits", () => {
  let snap: Record<string, string | undefined> = {};
  beforeEach(() => {
    snap = {
      MAX_UPLOAD_FILE_SIZE_BYTES: process.env.MAX_UPLOAD_FILE_SIZE_BYTES,
      MULTIPART_THRESHOLD_BYTES: process.env.MULTIPART_THRESHOLD_BYTES,
      MULTIPART_PART_SIZE_BYTES: process.env.MULTIPART_PART_SIZE_BYTES,
    };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns defaults when env is unset", () => {
    delete process.env.MAX_UPLOAD_FILE_SIZE_BYTES;
    const limits = getUploadSizeLimits();
    expect(limits.maxUploadFileSizeBytes).toBeGreaterThan(1024 * 1024);
    expect(limits.multipartThresholdBytes).toBeGreaterThan(0);
    expect(limits.multipartPartSizeBytes).toBeGreaterThan(0);
  });

  it("clamps absurdly small env to floor", () => {
    process.env.MAX_UPLOAD_FILE_SIZE_BYTES = "1";
    const limits = getUploadSizeLimits();
    expect(limits.maxUploadFileSizeBytes).toBeGreaterThanOrEqual(
      1024 * 1024,
    );
  });

  it("checkUploadSize refuses an oversize upload", () => {
    process.env.MAX_UPLOAD_FILE_SIZE_BYTES = String(10 * 1024 * 1024);
    const r = checkUploadSize(100 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("file_too_large");
  });

  it("checkUploadSize recommends multipart above the threshold", () => {
    process.env.MULTIPART_THRESHOLD_BYTES = String(50 * 1024 * 1024);
    const small = checkUploadSize(10 * 1024 * 1024);
    const big = checkUploadSize(100 * 1024 * 1024);
    if (small.ok) expect(small.recommendMultipart).toBe(false);
    if (big.ok) expect(big.recommendMultipart).toBe(true);
  });

  it("checkUploadSize accepts BigInt and unknown sizes", () => {
    const a = checkUploadSize(BigInt(123));
    const b = checkUploadSize(null);
    const c = checkUploadSize(undefined);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
  });
});

describe("stale thresholds", () => {
  let snap: Record<string, string | undefined> = {};
  beforeEach(() => {
    snap = {
      UPLOAD_STALLED_MINUTES: process.env.UPLOAD_STALLED_MINUTES,
      UPLOAD_ABANDONED_HOURS: process.env.UPLOAD_ABANDONED_HOURS,
    };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses canonical defaults", () => {
    delete process.env.UPLOAD_STALLED_MINUTES;
    delete process.env.UPLOAD_ABANDONED_HOURS;
    const t = getStaleThresholds();
    expect(t.stalledMinutes).toBeGreaterThanOrEqual(5);
    expect(t.abandonedHours).toBeGreaterThanOrEqual(1);
  });

  it("clamps env values that go past the safe ceiling", () => {
    process.env.UPLOAD_STALLED_MINUTES = "999999";
    const t = getStaleThresholds();
    expect(t.stalledMinutes).toBeLessThanOrEqual(24 * 60);
  });
});

describe("queue policies", () => {
  it("listQueuePolicies returns the three documented queues", () => {
    const policies = listQueuePolicies();
    expect(policies.map((p) => p.queueName).sort()).toEqual([
      "evidence-purge",
      "ots-upgrade",
      "report",
    ]);
  });

  it("documented retry counts match the worker source", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../../worker/src/queue.ts", import.meta.url),
      ),
      "utf8",
    );
    // Pattern: the worker file must still contain the attempts numbers
    // we describe in the policy doc. If queue settings change in
    // worker/queue.ts, this test fails and the policy doc must be
    // updated to match.
    expect(src).toMatch(/attempts:\s*5/);
    expect(src).toMatch(/attempts:\s*20/);
    // DLQ presence:
    expect(src).toMatch(/reportDlqQueue/);
    expect(REPORT_QUEUE_POLICY.deadLetterQueue).toBe("report-dlq");
    expect(REPORT_QUEUE_POLICY.attempts).toBe(5);
    expect(OTS_UPGRADE_QUEUE_POLICY.attempts).toBe(20);
  });
});

describe("upload session projection — privacy", () => {
  it("does NOT expose multipartUploadId", () => {
    const projected = projectUploadSession({
      id: "11111111-1111-4111-8111-111111111111",
      evidenceId: "22222222-2222-4222-8222-222222222222",
      teamId: "33333333-3333-4333-8333-333333333333",
      status: "PRESIGNED" as never,
      isMultipart: true,
      expectedPartCount: 4,
      completedPartCount: 1,
      multipartUploadId: "secret-upload-id-from-s3",
      retryCount: 0,
      failureReason: null,
      lastActivityAtUtc: new Date(),
      stalledAtUtc: null,
      abandonedAtUtc: null,
      completedAtUtc: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(
      (projected as Record<string, unknown>).multipartUploadId,
    ).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("secret-upload-id-from-s3");
  });

  it("flags terminal states correctly", () => {
    const completed = projectUploadSession({
      id: "11111111-1111-4111-8111-111111111111",
      evidenceId: "22222222-2222-4222-8222-222222222222",
      teamId: null,
      status: "COMPLETED" as never,
      isMultipart: false,
      expectedPartCount: null,
      completedPartCount: 0,
      multipartUploadId: null,
      retryCount: 0,
      failureReason: null,
      lastActivityAtUtc: new Date(),
      stalledAtUtc: null,
      abandonedAtUtc: null,
      completedAtUtc: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(completed.isTerminal).toBe(true);

    const stalled = projectUploadSession({
      ...{
        id: "11111111-1111-4111-8111-111111111111",
        evidenceId: "22222222-2222-4222-8222-222222222222",
        teamId: null,
        status: "STALLED" as never,
        isMultipart: false,
        expectedPartCount: null,
        completedPartCount: 0,
        multipartUploadId: null,
        retryCount: 0,
        failureReason: null,
        lastActivityAtUtc: new Date(),
        stalledAtUtc: new Date(),
        abandonedAtUtc: null,
        completedAtUtc: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(stalled.isTerminal).toBe(false);
  });
});

describe("anti-enumeration — reliability routes", () => {
  it("uses 404 (not 403) for non-admin members", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/reliability.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // The route file should never respond 403 — operators see 404 on
    // both "not a member" and "not OWNER/ADMIN".
    expect(src).not.toMatch(/reply\.code\(403\)/);
    expect(src).toMatch(/reply\.code\(404\)/);
  });
});

describe("finalize idempotency — source-level guard", () => {
  it("evidence-complete.service.ts gates the SIGNED update by status", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/evidence-complete.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The finalize SIGNED update must be conditional on the prior
    // status being CREATED or UPLOADING — defense in depth against
    // any future refactor that removes the early-return.
    expect(src).toMatch(/tx\.evidence\.updateMany/);
    expect(src).toMatch(/status:\s*\{\s*in:\s*\[/);
    expect(src).toMatch(/EVIDENCE_FINALIZE_RACE_DETECTED/);
    // Duplicate finalize is audited.
    expect(src).toMatch(/finalize_duplicate_detected/);
  });
});

describe("capture upload retry — source-level check", () => {
  it("useCaptureSessionOrchestration.ts retries transient PUT failures", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/MAX_PUT_ATTEMPTS/);
    expect(src).toMatch(/transient/);
    // 4xx is NOT retried.
    expect(src).toMatch(/NOT retryable/);
  });
});

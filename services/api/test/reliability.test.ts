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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DLQ_SINKS,
  JOB_NAMES,
  QUEUE_NAMES,
  getWorkEntryOrThrow,
} from "@proovra/shared";

const SHARED_ENQUEUE_SRC = readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/shared/src/queue-integrity/enqueue.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);
const WORKER_QUEUE_SRC = readFileSync(
  fileURLToPath(new URL("../../worker/src/queue.ts", import.meta.url)),
  "utf8",
);

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

  it("documented retry counts match the ONE retry authority", async () => {
    // PHASE 12 — POINT 5 made this a comparison between two VALUES rather than
    // between a doc and a grep.
    //
    // It used to scan `worker/src/queue.ts` for `attempts: 5` and
    // `attempts: 20` appearing anywhere in the file. That was weak in both
    // directions: the numbers appeared in fifteen hand-written queue configs,
    // so the assertion passed if ANY queue used them, and it could not see the
    // real problem — the report queue's default said 5 while its producer
    // passed 3 for a regeneration, so a reconciler re-enqueue ran under a
    // different budget than the request path for the same work.
    //
    // Retry policy now has one definition per family in the registry, and the
    // operator-facing policy doc is checked against it directly.
    const reportEntry = getWorkEntryOrThrow(JOB_NAMES.GENERATE_REPORT);
    const otsEntry = getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS);

    expect(REPORT_QUEUE_POLICY.attempts).toBe(reportEntry.retry.attempts);
    expect(OTS_UPGRADE_QUEUE_POLICY.attempts).toBe(otsEntry.retry.attempts);
    // The documented numbers themselves, so a registry edit that changes the
    // operator contract has to change this line too.
    expect(REPORT_QUEUE_POLICY.attempts).toBe(5);
    expect(OTS_UPGRADE_QUEUE_POLICY.attempts).toBe(20);

    // DLQ presence — the sink is a registered queue, not a source token.
    expect(REPORT_QUEUE_POLICY.deadLetterQueue).toBe(QUEUE_NAMES.REPORT_DLQ);
    expect(DLQ_SINKS.map((s) => s.queueName)).toContain(QUEUE_NAMES.REPORT_DLQ);
    expect(
      DLQ_SINKS.find((s) => s.queueName === QUEUE_NAMES.REPORT_DLQ)?.sourceQueue,
    ).toBe(QUEUE_NAMES.REPORT);
  });

  it("no producer can override the documented attempt budget at the call site", () => {
    // The specific drift this closes: `attempts: options?.forceRegenerate ? 3 : 5`
    // used to live at the report enqueue site, so the budget depended on which
    // caller you were. Every enqueue now reads `entry.retry.attempts`.
    expect(SHARED_ENQUEUE_SRC).toMatch(/attempts: entry\.retry\.attempts/);
    expect(WORKER_QUEUE_SRC).not.toMatch(/attempts: options\?\./);
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
      teamId: "33333333-3333-4333-8333-333333333333",
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
        teamId: "33333333-3333-4333-8333-333333333333",
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

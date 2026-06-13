/**
 * Phase CAPTURE-HARDENING — sweeper safety contract locks.
 *
 * The sweeper has dangerous adjacent code paths (it touches a write
 * path on a row type that also represents finalized evidence drafts),
 * so we lock the WHERE clause and the audit-insert shape at the
 * source level. A regression that accidentally targets the wrong
 * status, drops the audit, or removes the index hint fails CI here.
 *
 * For a real DB-backed proof, see scripts/sweep-capture-drafts.ts
 * which is exercised by the live CLI proof in the deploy report.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JOB_SRC = readFileSync(
  resolve(__dirname, "..", "src", "jobs", "capture-draft-expiry.job.ts"),
  "utf8",
);
const SERVER_SRC = readFileSync(
  resolve(__dirname, "..", "src", "server.ts"),
  "utf8",
);

describe("capture-draft-expiry sweeper — safety contract", () => {
  it("WHERE clause filters status=DRAFT only (never touches FINALIZED/DISCARDED/EXPIRED)", () => {
    expect(JOB_SRC).toMatch(/status:\s*"DRAFT"/);
    expect(JOB_SRC).not.toMatch(/status:\s*"FINALIZED"/);
    expect(JOB_SRC).not.toMatch(/status:\s*"DISCARDED"/);
  });

  it("WHERE clause requires expiresAtUtc < now AND not null", () => {
    expect(JOB_SRC).toMatch(/expiresAtUtc:\s*\{[^}]*lt:\s*now/);
    expect(JOB_SRC).toMatch(/not:\s*null/);
  });

  it("updateMany re-asserts status: DRAFT (race-safe vs concurrent FINALIZE/DISCARD)", () => {
    // The second guard prevents a rare race where a row gets
    // finalized between findMany and updateMany within the same
    // transaction window.
    expect(JOB_SRC).toMatch(/updateMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*ids\s*\}\s*,\s*status:\s*"DRAFT"\s*\}/);
  });

  it("status transition target is EXPIRED (never DELETED)", () => {
    expect(JOB_SRC).toMatch(/data:\s*\{\s*status:\s*"EXPIRED"\s*\}/);
    expect(JOB_SRC).not.toMatch(/prisma\.captureSession\.delete/);
    expect(JOB_SRC).not.toMatch(/deleteMany/);
  });

  it("appends a CaptureSessionEvent(EXPIRED) for every row transitioned", () => {
    expect(JOB_SRC).toMatch(/eventType:\s*"EXPIRED" as const/);
    expect(JOB_SRC).toMatch(/captureSessionEvent\.createMany/);
    expect(JOB_SRC).toMatch(/reason:\s*"expiresAtUtc elapsed"/);
  });

  it("update + audit run inside a single prisma.$transaction (atomic + idempotent)", () => {
    expect(JOB_SRC).toMatch(/prisma\.\$transaction/);
  });

  it("bounded batch via take: limit", () => {
    expect(JOB_SRC).toMatch(/take:\s*limit/);
  });

  it("never touches Evidence or S3 storage", () => {
    expect(JOB_SRC).not.toMatch(/prisma\.evidence\./);
    expect(JOB_SRC).not.toMatch(/storageBucket/);
    expect(JOB_SRC).not.toMatch(/s3Client|S3Client|getStorage/);
  });

  it("cron-wrapper swallows errors so a DB blip never crashes the API", () => {
    expect(JOB_SRC).toMatch(/runCaptureDraftExpirySweepSafe[\s\S]*try[\s\S]*catch/);
  });

  it("server bootstrap registers the sweeper behind an env flag and unrefs the timer", () => {
    expect(SERVER_SRC).toMatch(
      /process\.env\.CAPTURE_DRAFT_SWEEP_INPROCESS\s*===\s*"true"/,
    );
    expect(SERVER_SRC).toMatch(/setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*runCaptureDraftExpirySweepSafe/);
    expect(SERVER_SRC).toMatch(/handle as \{ unref\?: \(\) => void \}/);
    // OnClose hook clears the interval so test harnesses can close cleanly.
    expect(SERVER_SRC).toMatch(/addHook\("onClose"[\s\S]*clearInterval\(handle\)/);
  });
});

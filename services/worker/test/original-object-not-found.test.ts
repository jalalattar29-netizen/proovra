/**
 * A STORE 404 ON THE SIGNED ORIGINAL IS TERMINAL, NAMED AND NEVER RETRIED
 * (2026-09-29, incident report-8cccb175).
 *
 * The package recovery HEADed an original part, S3 answered `NotFound`, and
 * the raw error escaped as retriable: five identical 0.2 s attempts, then the
 * DLQ, recorded as `NotFound` with no component named. These tests pin:
 *
 *   1. a 404 (HEAD `NotFound`, GET `NoSuchKey`, any 404 status) becomes the
 *      non-retriable `EVIDENCE_ORIGINAL_NOT_FOUND`, naming the component and
 *      never the storage key;
 *   2. every other storage error (throttling, 5xx, access, network) passes
 *      through unchanged and stays retriable;
 *   3. every read of an ORIGINAL in `prepareReportArtifacts` goes through the
 *      wrapper — HEAD and GET, multipart and single-file, and the preview read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ORIGINAL_NOT_READABLE_TERMINAL_CODE } from "@proovra/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const {
  EVIDENCE_ORIGINAL_NOT_FOUND,
  isRetriableError,
  isStorageNotFound,
  readOriginalObject,
} = await import("../src/processor.js");

function s3Error(name: string, status: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(name === "NotFound" ? "UnknownError" : name), {
    name,
    $metadata: { httpStatusCode: status },
    ...extra,
  });
}

describe("original-object 404 classification", () => {
  it("the worker code is the one every surface's copy keys on", () => {
    expect(EVIDENCE_ORIGINAL_NOT_FOUND).toBe(ORIGINAL_NOT_READABLE_TERMINAL_CODE);
  });

  it.each([
    ["HEAD NotFound (the production shape)", s3Error("NotFound", 404)],
    ["GET NoSuchKey", s3Error("NoSuchKey", 404)],
    ["a bare 404 status", s3Error("SomethingElse", 404)],
  ])("%s is terminal EVIDENCE_ORIGINAL_NOT_FOUND", async (_label, raw) => {
    expect(isStorageNotFound(raw)).toBe(true);
    const err = await readOriginalObject("original part 3", () => Promise.reject(raw)).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe(EVIDENCE_ORIGINAL_NOT_FOUND);
    expect(isRetriableError(err)).toBe(false);
    const message = (err as Error).message;
    expect(message.startsWith(`${EVIDENCE_ORIGINAL_NOT_FOUND}:`)).toBe(true);
    expect(message).toContain("original part 3");
    // Honest about what a key-level 404 does and does not establish.
    expect(message).toMatch(/does not establish loss/);
    expect(message).toMatch(/a delete marker, a wrong key or bucket, or a missing object are all possible/);
    expect(message).toMatch(/No report or package was built from other bytes/);
    expect(message).toMatch(/its hash and its signature are unchanged/);
    // The incident bridge keeps the first 380 characters as its summary.
    expect(message.length).toBeLessThanOrEqual(380);
  });

  it.each([
    ["throttling", s3Error("SlowDown", 503)],
    ["server error", s3Error("InternalError", 500)],
    ["access denied", s3Error("AccessDenied", 403)],
    ["network", Object.assign(new Error("socket hang up"), { name: "Error" })],
  ])("%s passes through unchanged and stays retriable", async (_label, raw) => {
    expect(isStorageNotFound(raw)).toBe(false);
    const err = await readOriginalObject("the original file", () => Promise.reject(raw)).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(raw);
    expect(isRetriableError(err)).toBe(true);
  });

  it("a successful read returns its value untouched", async () => {
    await expect(readOriginalObject("the original file", async () => 42)).resolves.toBe(42);
  });

  it("the storage key never appears in the error (it carries a file name)", async () => {
    const err = (await readOriginalObject("original part 0", () =>
      Promise.reject(s3Error("NotFound", 404, { Key: "evidence/x/parts/000-secret-name.jpg" })),
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("secret-name");
    expect(err.message).not.toContain("evidence/");
  });
});

describe("every ORIGINAL read in prepareReportArtifacts is wrapped (source contract)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/processor.ts", import.meta.url)), "utf8");
  const start = src.indexOf("async function prepareReportArtifacts(");
  const end = src.indexOf("const contentArtifacts = buildReportEvidenceContent(", start);
  const body = src.slice(start, end);

  it("finds the function body", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("has no unwrapped headObject/getObjectStream call", () => {
    // Strip the wrapped forms; whatever read remains would be a raw one.
    const unwrapped = body.replace(
      /readOriginalObject\([^,]+,\s*\(\)\s*=>\s*(?:headObject|getObjectStream)\(/g,
      "WRAPPED(",
    );
    expect(unwrapped).not.toMatch(/\bawait (?:headObject|getObjectStream)\(/);
  });

  it("wraps the HEAD and GET of both the multipart and single-file branches, and the preview read", () => {
    expect(body.match(/readOriginalObject\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("the stored-report reader keeps its own REPORT_OBJECT_MISSING refusal on the shared predicate", () => {
    expect(src).toMatch(/const isNotFound = isStorageNotFound;/);
    expect(src).toMatch(/if \(isNotFound\(err\)\) throw createWorkerError\("REPORT_OBJECT_MISSING", false\);/);
  });
});

/**
 * Phase C #17 — tests for the new forensic-semantics behavior.
 *
 * These tests are intentionally pure-function focused so they can run
 * without a database / S3 fixture. Database-backed behavior (e.g. that
 * EVIDENCE_LOCKED is not appended on no-op retention; that public verify
 * rejects pre-finalized records; that the reaper marks expired drafts) is
 * exercised end-to-end in the deployed integration suite.
 */
import { describe, expect, it } from "vitest";
import { sanitizePageContextPath } from "../src/services/ai/ai-chat.service.js";

describe("ai-chat sanitizePageContextPath (Phase C #3)", () => {
  it("returns null for empty/missing input", () => {
    expect(sanitizePageContextPath(null)).toBeNull();
    expect(sanitizePageContextPath(undefined)).toBeNull();
    expect(sanitizePageContextPath("")).toBeNull();
    expect(sanitizePageContextPath("   ")).toBeNull();
  });

  it("rejects suspiciously long input", () => {
    const longPath = "/a/" + "x".repeat(300);
    expect(sanitizePageContextPath(longPath)).toBeNull();
  });

  it("redacts UUID segments to :id", () => {
    expect(
      sanitizePageContextPath(
        "/evidence/123e4567-e89b-12d3-a456-426614174000"
      )
    ).toBe("/evidence/:id");
  });

  it("redacts long hex tokens to :token", () => {
    expect(
      sanitizePageContextPath("/invite/abcdef1234567890abcdef1234567890")
    ).toBe("/invite/:token");
  });

  it("redacts other long dynamic segments to :dynamic", () => {
    expect(
      sanitizePageContextPath("/case/Long-Case-Name-That-Looks-Sensitive")
    ).toBe("/case/:dynamic");
  });

  it("preserves short, structural segments", () => {
    expect(sanitizePageContextPath("/evidence/list")).toBe("/evidence/list");
    expect(sanitizePageContextPath("/capture")).toBe("/capture");
  });
});

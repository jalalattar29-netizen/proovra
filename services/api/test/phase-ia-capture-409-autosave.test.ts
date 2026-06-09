/**
 * Phase IA-capture-409-autosave — bound the 409 → autosave fix.
 *
 * Production incident:
 *   PATCH /v1/capture/sessions/<id> returned 409 with
 *   `{ message: "Capture session is no longer editable" }` whenever the
 *   session had moved out of DRAFT (FINALIZED / DISCARDED / EXPIRED).
 *   The frontend `useCaptureDraftPersistence` hook caught the error as
 *   a generic failure, logged `web_capture_draft_persist Error`, set
 *   savingState to "error", but DID NOT clear `draftIdRef`. So every
 *   subsequent keystroke re-armed the debounce, which re-PATCHed the
 *   same locked session, which 409'd again — forever.
 *
 *   Root contributors:
 *     1. Backend 409 response had no machine-readable `code` field.
 *     2. Frontend treated all errors uniformly + never halted the loop
 *        + never cleared the stale draftId.
 *
 * Fix:
 *   * Backend: capture.routes.ts:441 sends
 *     `{ code: "CAPTURE_SESSION_NOT_EDITABLE", message, details }`.
 *   * Frontend: useCaptureDraftPersistence detects the bounded code
 *     (or 409 status as fallback), sets a `lockedRef` flag, clears
 *     the draftId, clears the pending payload + debounce timer, and
 *     surfaces `savingState: "locked"` (NOT "error").
 *     `discardDraft` + `acknowledgeFinalized` reset `lockedRef` so a
 *     fresh capture session can begin.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ============================================================================
// Backend — PATCH route emits CAPTURE_SESSION_NOT_EDITABLE on 409
// ============================================================================

describe("Phase IA-capture-409-autosave — backend response shape", () => {
  const ROUTE = readSource("../src/routes/capture.routes.ts");

  it("PATCH 409 carries the bounded code CAPTURE_SESSION_NOT_EDITABLE", () => {
    expect(ROUTE).toMatch(
      /code:\s*"CAPTURE_SESSION_NOT_EDITABLE"[\s\S]{0,400}message:\s*"Capture session is no longer editable"/,
    );
  });

  it("the 409 response is still returned with HTTP 409", () => {
    // Pin the status code — the bug fix must NOT change the 409
    // semantics to 200/400/500.
    expect(ROUTE).toMatch(
      /session\.status !== prismaPkg\.CaptureSessionStatus\.DRAFT[\s\S]{0,1500}reply\.code\(409\)/,
    );
  });

  it("the 409 body still includes the operator-readable message", () => {
    expect(ROUTE).toMatch(/message:\s*"Capture session is no longer editable"/);
  });

  it("the 409 body includes the session status in details for triage", () => {
    expect(ROUTE).toMatch(
      /details:\s*\{\s*status:\s*session\.status\s*\}/,
    );
  });
});

// ============================================================================
// Frontend — useCaptureDraftPersistence halts the autosave loop on 409
// ============================================================================

describe("Phase IA-capture-409-autosave — autosave-loop halt", () => {
  const HOOK = readSource(
    "../../../apps/web/app/(app)/capture/_hooks/useCaptureDraftPersistence.ts",
  );

  it("defines a bounded isSessionLockedError predicate", () => {
    expect(HOOK).toMatch(/function isSessionLockedError\(/);
    // Predicate detects EITHER the code OR the 409 status.
    expect(HOOK).toMatch(
      /e\.code === "CAPTURE_SESSION_NOT_EDITABLE"\s*\|\|\s*e\.statusCode === 409/,
    );
  });

  it("savingState includes the bounded 'locked' state alongside idle/saving/error", () => {
    expect(HOOK).toMatch(
      /useState<\s*"idle"\s*\|\s*"saving"\s*\|\s*"error"\s*\|\s*"locked"\s*>/,
    );
  });

  it("flush short-circuits when lockedRef is set (no further PATCH)", () => {
    // The early-return inside flush() that drops payload + exits if
    // locked. This is the primary loop-halt mechanism.
    expect(HOOK).toMatch(
      /if \(lockedRef\.current\)\s*\{[\s\S]{0,400}pendingPayloadRef\.current\s*=\s*null;[\s\S]{0,200}return;/,
    );
  });

  it("flush's catch branches into the lock path on isSessionLockedError", () => {
    expect(HOOK).toMatch(
      /catch \(err\)\s*\{\s*if \(isSessionLockedError\(err\)\)/,
    );
  });

  it("lock path sets lockedRef, clears draftId, clears pending payload + timer, surfaces 'locked' state", () => {
    expect(HOOK).toMatch(/lockedRef\.current\s*=\s*true/);
    expect(HOOK).toMatch(
      /if \(isSessionLockedError\(err\)\)\s*\{[\s\S]{0,1500}draftIdRef\.current\s*=\s*null/,
    );
    expect(HOOK).toMatch(
      /if \(isSessionLockedError\(err\)\)\s*\{[\s\S]{0,1500}setDraftId\(null\)/,
    );
    expect(HOOK).toMatch(
      /if \(isSessionLockedError\(err\)\)\s*\{[\s\S]{0,1500}setSavingState\("locked"\)/,
    );
  });

  it("lock path does NOT call logCaptureClientError (409 is a lifecycle event, not a client error)", () => {
    // Bound the lock branch and assert logCaptureClientError is NOT
    // inside it. The non-lock branch (else) still logs.
    const idx = HOOK.indexOf("if (isSessionLockedError(err))");
    expect(idx).toBeGreaterThan(-1);
    // Slice up to the matching `else` clause.
    const lockBranch = HOOK.slice(idx, idx + 2000);
    const elseIdx = lockBranch.indexOf("} else {");
    expect(elseIdx).toBeGreaterThan(-1);
    const lockOnly = lockBranch.slice(0, elseIdx);
    expect(lockOnly).not.toMatch(/logCaptureClientError\(/);
  });

  it("finally re-flush is gated on !lockedRef.current (no infinite loop)", () => {
    expect(HOOK).toMatch(
      /if \(pendingPayloadRef\.current\s*&&\s*!lockedRef\.current\)\s*\{[\s\S]{0,100}void flush\(\)/,
    );
  });

  it("scheduleSave returns early when lockedRef.current is set", () => {
    expect(HOOK).toMatch(
      /const scheduleSave[\s\S]{0,600}if \(lockedRef\.current\) return/,
    );
  });

  it("discardDraft resets lockedRef so a new session can begin", () => {
    expect(HOOK).toMatch(
      /const discardDraft[\s\S]{0,800}lockedRef\.current\s*=\s*false/,
    );
  });

  it("acknowledgeFinalized resets lockedRef so a new session can begin", () => {
    expect(HOOK).toMatch(
      /const acknowledgeFinalized[\s\S]{0,500}lockedRef\.current\s*=\s*false/,
    );
  });

  it("discardDraft does NOT log a client error when the DELETE 409s (already-locked session)", () => {
    expect(HOOK).toMatch(
      /catch \(err\)\s*\{[\s\S]{0,400}if \(!isSessionLockedError\(err\)\)\s*\{[\s\S]{0,200}logCaptureClientError\("web_capture_draft_discard"/,
    );
  });
});

// ============================================================================
// Page UI surfaces the friendly locked message (no "Internal server error")
// ============================================================================

describe("Phase IA-capture-409-autosave — page UI surface", () => {
  const PAGE = readSource("../../../apps/web/app/(app)/capture/page.tsx");

  it("the draft pill renders a friendly locked label, NOT the generic 'failed' copy", () => {
    expect(PAGE).toMatch(/savingState === "locked"/);
    expect(PAGE).toMatch(/Session finalized — start a new capture/);
  });

  it("the tooltip explains the locked state to the operator", () => {
    expect(PAGE).toMatch(
      /This capture session is already finalized or locked\. Start a new capture session to continue\./,
    );
  });

  it("the generic 'Draft save failed' copy still exists for genuine network errors", () => {
    // Pin that we did NOT remove the genuine-error path while fixing
    // the 409 misclassification.
    expect(PAGE).toMatch(/Draft save failed/);
  });
});

/**
 * Phase 31.9 — Operations actions UI source contract.
 *
 * The retry / replay-DLQ buttons land on the existing /ops/media-graph
 * page. This test set proves the UI:
 *   * Loads teamId from the canonical /v1/users/me endpoint.
 *   * Calls only the two whitelisted action endpoints
 *     (retry + replay-DLQ).
 *   * Has bounded UI state — ActionResult discriminated union with
 *     idle / pending / success / error.
 *   * Refuses to act without a workspace.
 *   * Never throws — every error path lands in the error branch with
 *     a bounded detail string.
 *   * Uses safe wording (no forbidden vocabulary; no claims of
 *     authenticity/admissibility).
 *   * No storage internals or signed URLs in any UI literal.
 *   * Buttons disabled when teamId absent or while a request is
 *     pending.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const PAGE_SRC = readSource(
  "../../../apps/web/app/(app)/admin/platform/media-graph/page.tsx",
);

// =============================================================================
// PART 1 — Endpoint surface
// =============================================================================

describe("Phase 31.9 — ops actions UI: endpoint surface", () => {
  it("loads workspace id from the canonical platform context", () => {
    // Phase 32.8 Foundation cleanup — the page no longer hits
    // /v1/users/me directly; it consumes useTeamId() from the
    // canonical platform-context module.
    expect(PAGE_SRC).toMatch(/useTeamId\(\)/);
  });

  it("calls /v1/ops/media-intelligence/runs/:runId/retry exactly", () => {
    expect(PAGE_SRC).toMatch(
      /`\/v1\/ops\/media-intelligence\/runs\/\$\{encodeURIComponent\(\w+\)\}\/retry`/,
    );
  });

  it("calls /v1/ops/media-intelligence/dlq/replay exactly", () => {
    expect(PAGE_SRC).toMatch(
      /`\/v1\/ops\/media-intelligence\/dlq\/replay`/,
    );
  });

  it("no other server endpoints called from the action handlers", () => {
    const noComments = PAGE_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const calls = noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
    const allowed = new Set([
      "/v1/users/me",
      // ADM-013 PHASE 1 — see the sibling note in
      // phase-31-7-32-6-timeline-and-ops.test.ts. The metric read moved to the
      // canonical platform namespace; the two MUTATIONS below are unchanged,
      // and they are workspace-scoped, which is why the page still resolves a
      // teamId even though the counters no longer involve one.
      "/v1/admin/platform/metrics",
      "/v1/ops/media-intelligence/runs/${encodeURIComponent(trimmed)}/retry",
      // ADM-P2-005 / ADM-P2-003 — the run listing, and the dismiss action the
      // console has been counting since before it offered it. Both spelled in
      // full: this is an exact-match set, so a fourth endpoint cannot slip in
      // behind a prefix.
      "/v1/ops/media-intelligence/runs?status=${encodeURIComponent(runStatus)}&limit=25",
      "/v1/ops/media-intelligence/runs/${encodeURIComponent(run.runId)}/dismiss",
      "/v1/ops/media-intelligence/dlq/replay",
    ]);
    for (const call of calls) {
      const path = call.match(/[`"]([^`"]+)[`"]/)?.[1] ?? "";
      expect(
        allowed.has(path),
        `unexpected endpoint called: ${path}`,
      ).toBe(true);
    }
  });
});

// =============================================================================
// PART 2 — ActionResult state machine
// =============================================================================

describe("Phase 31.9 — ops actions UI: state machine", () => {
  it("ActionResult is a bounded discriminated union", () => {
    // The discriminated union spans multiple lines with embedded `;`
    // inside each variant's record. Anchor on the leading
    // `type ActionResult =` and look at the next ~12 lines.
    const startIdx = PAGE_SRC.indexOf("type ActionResult");
    expect(startIdx).toBeGreaterThan(0);
    const decl = PAGE_SRC.slice(startIdx, startIdx + 500);
    for (const k of ["idle", "pending", "success", "error"]) {
      expect(decl, `ActionResult missing kind "${k}"`).toMatch(
        new RegExp(`kind:\\s*"${k}"`),
      );
    }
  });

  it("retry handler refuses without teamId (no-op error path)", () => {
    const fn = PAGE_SRC.match(/const runRetry\s*=[\s\S]*?\n\s*\};/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/if \(!teamId\)\s*\{[\s\S]*?Workspace context unavailable/);
  });

  it("replay handler refuses without teamId", () => {
    const fn = PAGE_SRC.match(/const runReplayDlq\s*=[\s\S]*?\n\s*\};/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/if \(!teamId\)\s*\{[\s\S]*?Workspace context unavailable/);
  });

  it("retry handler refuses on empty input", () => {
    const fn = PAGE_SRC.match(/const runRetry\s*=[\s\S]*?\n\s*\};/)?.[0];
    expect(fn!).toMatch(/!trimmed[\s\S]*?Provide a job id/);
  });

  it("both handlers wrap apiFetch in try/catch — no throws to caller", () => {
    for (const name of ["runRetry", "runReplayDlq"] as const) {
      const fn = PAGE_SRC.match(
        new RegExp(`const ${name}\\s*=[\\s\\S]*?\\n\\s*\\};`),
      )?.[0];
      expect(fn, `${name} found`).toBeTruthy();
      expect(fn!).toMatch(/try\s*\{[\s\S]*?\}\s*catch \(err\)\s*\{[\s\S]*?setActionResult/);
    }
  });

  it("bounded error detail (the sanctioned safe-error path)", () => {
    // Raw `err.message` passthrough is banned app-wide (safe-feedback
    // migration, 2026-07-06); the page previously sliced the raw message to
    // 160 chars, which bounds the length but not the CONTENT. Both handlers
    // now route the failure through toSafeUserError, which is bounded and
    // sanitised by construction.
    expect(PAGE_SRC).not.toMatch(/err\.message\.slice\(/);
    const failures = PAGE_SRC.match(/toSafeUserError\(err,/g) ?? [];
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// PART 3 — Button disablement
// =============================================================================

describe("Phase 31.9 — ops actions UI: button disablement", () => {
  /*
   * EVERY trigger, not the first one the regex happened to find.
   *
   * These two cases each matched a single block and asserted a disabled
   * expression written on one line. ADM-P2-005 added a second Retry control —
   * one per listed run — and the formatter wrapped its `disabled` across
   * lines, so the old form failed on a page where every control was correctly
   * guarded. Matching one block was also the weaker assertion: a second,
   * unguarded trigger would never have been looked at.
   *
   * Collect every `void runRetry(` / `void runReplayDlq(` call site and require
   * each one's own Button to carry the guard. Whitespace-insensitive, because
   * the guard is a fact about the code and not about the formatter.
   */
  function guardsAround(trigger: string): string[] {
    const flat = PAGE_SRC.replace(/\s+/g, " ");
    const out: string[] = [];
    let from = 0;
    for (;;) {
      const at = flat.indexOf(trigger, from);
      if (at < 0) break;
      // The Button element runs from its opening tag to the next `>` after the
      // handler; the guard sits inside that window.
      const end = flat.indexOf("<", at);
      out.push(flat.slice(at, end > at ? end : at + 400));
      from = at + trigger.length;
    }
    return out;
  }

  it("every Retry trigger is disabled while pending OR without teamId", () => {
    const sites = guardsAround("void runRetry(");
    expect(sites.length, "no Retry trigger found").toBeGreaterThan(0);
    for (const site of sites) {
      expect(site).toMatch(
        /disabled=\{ ?actionResult\.kind === "pending" \|\| !teamId ?\}/,
      );
    }
  });

  it("every Replay DLQ trigger is disabled while pending OR without teamId", () => {
    const sites = guardsAround("void runReplayDlq(");
    expect(sites.length, "no Replay DLQ trigger found").toBeGreaterThan(0);
    for (const site of sites) {
      expect(site).toMatch(
        /disabled=\{ ?actionResult\.kind === "pending" \|\| !teamId ?\}/,
      );
    }
  });

  it("every Dismiss trigger is disabled while a request is in flight", () => {
    /*
     * Dismiss is NOT gated on `teamId`, and that is deliberate rather than an
     * omission. Retry and Replay DLQ send the operator's workspace as their
     * audit scope, so they genuinely need one; dismiss sends the RUN's
     * workspace, which comes off the row. Requiring the operator's workspace
     * here would disable a control for a reason that has nothing to do with it.
     */
    const sites = guardsAround("void runDismiss(");
    expect(sites.length, "no Dismiss trigger found").toBeGreaterThan(0);
    for (const site of sites) {
      expect(site).toMatch(/disabled=\{ ?actionResult\.kind === "pending" ?\}/);
    }
  });

  it("the action controls are the canonical Button, which owns the disabled treatment", () => {
    /*
     * NO MORE `primaryButtonStyle(disabled: boolean)`.
     *
     * This case required a page-local helper that computed inline styles for a
     * disabled state. The page was migrated onto the canonical `Button`, whose
     * `disabled` prop carries that treatment for the whole product, and the
     * helper was deleted with the inline styles it existed to build — so the
     * regex reported "defensive styling missing" about a page that had stopped
     * hand-rolling it.
     *
     * The property is the same and is now stated where it lives: the action
     * controls are the shared component, they are given a real disabled
     * expression (asserted in the case above), and nothing in the page
     * re-implements a button style of its own.
     */
    expect(PAGE_SRC).toMatch(/import \{[^}]*\bButton\b[^}]*\} from/);
    expect(PAGE_SRC).toMatch(/<Button[\s\S]{0,400}?disabled=\{/);
    expect(PAGE_SRC).not.toMatch(/function \w*[Bb]uttonStyle\(/);
  });
});

// =============================================================================
// PART 4 — Safe wording
// =============================================================================

describe("Phase 31.9 — ops actions UI: safe wording", () => {
  it("no forbidden vocabulary in any UI literal", () => {
    const noComments = PAGE_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `ops UI uses forbidden wording: ${lit}`).not.toMatch(
        forbidden,
      );
    }
  });

  it("retry job-id placeholder names the id the producer actually emits", () => {
    /*
     * THIS ASSERTION WAS PINNING A RETIRED CONTRACT.
     *
     * It required `mi-extract_exif-<uuid>`, the pre-Point-5 job id built from
     * (kind, evidenceId). The producer now builds `mi-run-<runId>` through
     * `buildCanonicalJobId`, so the placeholder — and the validation message
     * beside it — were telling an operator to construct an id that matches
     * nothing, and this test was holding them there.
     *
     * The retired form is asserted ABSENT as well as the current one present.
     * Requiring only the new spelling would let both sit in the file at once,
     * which is the state that produced the confusion.
     *
     * ABSENCE IS ASSERTED AGAINST CODE, PRESENCE AGAINST THE WHOLE FILE. The
     * page deliberately NAMES the retired form in a comment, so the next
     * reader learns why it went; a bare `not.toMatch` over the file would fail
     * on the explanation, and the obvious way to make it pass is to delete the
     * explanation.
     */
    const code = PAGE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /\/\/[^\n]*/g,
      "",
    );
    expect(PAGE_SRC).toMatch(/placeholder="mi-run-<uuid>"/);
    expect(code).not.toMatch(/mi-<kind>-<evidenceId>/);
    expect(code).not.toMatch(/mi-extract_exif-/);
  });

  it("footer disclaimer uses safer wording (no 'authenticity/admissibility' even in negation)", () => {
    // JSX wraps text across lines; flatten whitespace before matching.
    const flat = PAGE_SRC.replace(/\s+/g, " ");
    expect(flat).toMatch(/do not classify the recorded material/);
    expect(flat).toMatch(/canonical custody record/);
    expect(PAGE_SRC).not.toMatch(/authenticity or admissibility/);
  });
});

// =============================================================================
// PART 5 — Anti-leak
// =============================================================================

describe("Phase 31.9 — ops actions UI: anti-leak", () => {
  it("no storage internals or signed URLs in any UI literal or string", () => {
    const noComments = PAGE_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "multipartUploadId",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "rawGps",
      "raw_gps",
      "privateNote",
      "private_note",
      "legalNoteBody",
    ]) {
      expect(noComments, `ops UI leaks ${banned}`).not.toContain(banned);
    }
  });

  it("retry job-id is URL-encoded before sending", () => {
    expect(PAGE_SRC).toMatch(
      /encodeURIComponent\(trimmed\)/,
    );
  });
});

// =============================================================================
// PART 6 — Result rendering
// =============================================================================

describe("Phase 31.9 — ops actions UI: result rendering", () => {
  it("success result displayed with safe styling", () => {
    expect(PAGE_SRC).toMatch(/actionResultSuccessStyle/);
    expect(PAGE_SRC).toMatch(/"success"/);
  });

  it("error result displayed with safe styling", () => {
    expect(PAGE_SRC).toMatch(/actionResultErrorStyle/);
    expect(PAGE_SRC).toMatch(/"error"/);
  });

  it("workspace-loading notice shown when teamId is null", () => {
    expect(PAGE_SRC).toMatch(
      /!teamId[\s\S]*?Workspace context is loading/,
    );
  });
});

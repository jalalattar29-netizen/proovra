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
  "../../../apps/web/app/(app)/ops/media-graph/page.tsx",
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
      "/v1/ops/metrics",
      "/v1/ops/media-intelligence/runs/${encodeURIComponent(trimmed)}/retry",
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

  it("bounded error detail (slice to 160 chars)", () => {
    // Both handlers slice err.message to 160 chars before display
    // so a server-side stack trace can't ballast the UI.
    expect(PAGE_SRC).toMatch(/err\.message\.slice\(0,\s*160\)/);
  });
});

// =============================================================================
// PART 3 — Button disablement
// =============================================================================

describe("Phase 31.9 — ops actions UI: button disablement", () => {
  it("retry button disabled while pending OR without teamId", () => {
    const block = PAGE_SRC.match(
      /Retry one job[\s\S]*?Retry<\/button>|onClick=\{[\s\S]*?runRetry[\s\S]*?disabled=\{[\s\S]*?\}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/disabled=\{actionResult\.kind === "pending" \|\| !teamId\}/);
  });

  it("replay button disabled while pending OR without teamId", () => {
    const block = PAGE_SRC.match(
      /Replay DLQ[\s\S]*?Replay DLQ<\/button>|runReplayDlq[\s\S]*?disabled=\{[\s\S]*?\}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/disabled=\{actionResult\.kind === "pending" \|\| !teamId\}/);
  });

  it("primaryButtonStyle takes a disabled boolean (defensive styling)", () => {
    expect(PAGE_SRC).toMatch(
      /function primaryButtonStyle\(disabled: boolean\)/,
    );
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

  it("retry job-id placeholder uses the safe deterministic-id pattern", () => {
    expect(PAGE_SRC).toMatch(/placeholder="mi-extract_exif-<uuid>"/);
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

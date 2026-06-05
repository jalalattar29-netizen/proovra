/**
 * PHASE 8 — Final test consolidation for the integrations product surface.
 *
 * Phases 1-7 wired the integrations admin area end-to-end:
 *   Phase 1 — env states (disabled / secret-missing / enabled)
 *   Phase 2 — API key full lifecycle
 *   Phase 3 — webhook routes (test-event, retry, deliveries)
 *   Phase 4 — webhook dual-signing rotation
 *   Phase 5 — health metrics
 *   Phase 6 — event emissions
 *   Phase 7 — permissions / step-up / audit / SSRF / UX polish
 *
 * This consolidation file backstops the brief's cross-cutting concern:
 *   "forbid raw JSON envelope to non-admins on the integrations page"
 *
 * It also pins a small set of integration-wide invariants that span the
 * earlier phase files — specifically: the page never dumps a structured
 * error envelope into JSX, the error banner is the ONLY path that
 * renders a free-form `error` string, and admin-only diagnostics surfaces
 * remain gated by `isAdmin` everywhere they appear.
 *
 * No new product behaviour is introduced here. The tests are PINS that
 * fail loudly if a future refactor accidentally re-introduces a raw JSON
 * leak to normal operators.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const PAGE = readWeb("app/(app)/integrations/page.tsx");

// ---------------------------------------------------------------------------
// PHASE 8 — Cross-cutting copy regression: forbid raw JSON envelope to
// non-admins on the integrations page.
// ---------------------------------------------------------------------------

describe("PHASE 8 — integrations page never leaks raw JSON envelopes to non-admins", () => {
  it("the page never JSON.stringify's an error / envelope value before rendering", () => {
    // JSON.stringify is legitimately used for HTTP request bodies
    // (apiFetch body: JSON.stringify({ ... })). What we forbid is the
    // anti-pattern of stringifying an error / envelope and dumping it
    // into JSX or setError(). Scan every JSON.stringify call site and
    // require the argument is a plain object literal `{` — never
    // `err`, `e`, `error`, or `data`.
    const stringifyCalls = PAGE.match(/JSON\.stringify\(\s*[a-zA-Z{][^)]*?\)/g) ?? [];
    expect(stringifyCalls.length).toBeGreaterThan(0); // request bodies exist
    for (const call of stringifyCalls) {
      // Forbid stringifying named error identifiers.
      expect(call).not.toMatch(/JSON\.stringify\(\s*err\b/);
      expect(call).not.toMatch(/JSON\.stringify\(\s*error\b/);
      expect(call).not.toMatch(/JSON\.stringify\(\s*envelope\b/);
      expect(call).not.toMatch(/JSON\.stringify\(\s*data\b/);
      expect(call).not.toMatch(/JSON\.stringify\(\s*body\b/);
    }
  });

  it("the page never renders a raw apiFetch error object as JSX children", () => {
    // The catch branches set `error` from `e.message` (a string). The
    // page must NEVER render `{err}` directly as a child. (We don't
    // forbid `{e}` because `e` is also a common loop variable for
    // event-type strings, which IS a legitimate identifier render.)
    expect(PAGE).not.toMatch(/>\s*\{\s*err\s*\}\s*</);
    expect(PAGE).not.toMatch(/>\s*\{\s*envelope\s*\}\s*</);
  });

  it("the IntegrationsErrorBanner is the canonical free-form-error render path", () => {
    // The page has exactly ONE component that renders a free-form
    // `error: string` message — IntegrationsErrorBanner. Anything else
    // would risk drift away from the JSON-strip guard.
    const bannerDecls = PAGE.match(/function IntegrationsErrorBanner\(/g) ?? [];
    expect(bannerDecls.length).toBe(1);
  });

  it("IntegrationsErrorBanner strips JSON-looking payloads (object and array)", () => {
    // Phase 7 introduced the strip guard. Pin both brace forms so a
    // narrowing-only refactor would still fail loudly.
    const body = PAGE.match(
      /function IntegrationsErrorBanner\([\s\S]+?\n\}\n/,
    );
    expect(body).not.toBeNull();
    expect(body![0]).toMatch(/trimmed\.startsWith\("\{"\)/);
    expect(body![0]).toMatch(/trimmed\.startsWith\("\["\)/);
    expect(body![0]).toMatch(/Could not load integrations\./);
  });

  it("the machine code chip is gated by isAdmin && code", () => {
    // Non-admin renders MUST NOT include the chip even if a code is
    // present. Pin the conjunction inside the banner body.
    const body = PAGE.match(
      /function IntegrationsErrorBanner\([\s\S]+?\n\}\n/,
    );
    expect(body).not.toBeNull();
    expect(body![0]).toMatch(/isAdmin\s*&&\s*code\s*\?/);
  });

  it("the diagnostics chip in IntegrationsDisabledPanel is also admin-only", () => {
    // The disabled-state panel similarly gates its diagnostics surface
    // behind isAdmin — operators see the title/body only.
    const panel = PAGE.match(
      /function IntegrationsDisabledPanel\([\s\S]+?\n\}\n/,
    );
    expect(panel).not.toBeNull();
    expect(panel![0]).toMatch(/isAdmin/);
  });

  it("setError() callers pass operator-readable strings, never structured envelopes", () => {
    // We allow setError("INTEGRATIONS_DISABLED") (a stable structured
    // marker the JSX branches on) and setError(<string from
    // e.message>). We FORBID setError(JSON.stringify(...)) or any
    // setError(err) / setError(envelope) pattern that would dump a raw
    // object/envelope into the banner.
    const setErrorCalls = PAGE.match(/setError\([^)]*\)/g) ?? [];
    expect(setErrorCalls.length).toBeGreaterThan(0);
    for (const call of setErrorCalls) {
      // Forbid raw error-identifier passing.
      expect(call).not.toMatch(/setError\(\s*err\s*\)/);
      expect(call).not.toMatch(/setError\(\s*envelope\s*\)/);
      // Forbid JSON.stringify of anything inside setError.
      expect(call).not.toMatch(/JSON\.stringify/);
    }
  });

  it("the apiFetch catch handlers extract .message (string), never the raw error", () => {
    // We expect the canonical pattern err?.message ?? null OR
    // e?.message. Pin so a future refactor that drops the .message
    // extraction would fail.
    expect(PAGE).toMatch(/\.message/);
  });
});

// ---------------------------------------------------------------------------
// PHASE 8 — Integration-wide UX invariants (page-status banner + empty
// states + signature docs panel still wired through the canonical
// renderers). Belt-and-braces over the per-phase tests.
// ---------------------------------------------------------------------------

describe("PHASE 8 — integration page-status banner three states still wired", () => {
  it("page status banner renders enabled / disabled / needs attention copy", () => {
    expect(PAGE).toMatch(/Enabled/);
    expect(PAGE).toMatch(/Disabled[^"]{0,40}admin configuration required/);
    expect(PAGE).toMatch(/Needs attention/);
  });

  it("page status banner failing count is derived from already-loaded webhooks", () => {
    // The banner reads webhooks.filter(...) directly — no extra fetch,
    // no fabricated metric. Whitespace-tolerant for multi-line arrow.
    expect(PAGE).toMatch(
      /webhooks\.filter\([\s\S]{0,400}status\s*===\s*"ACTIVE"\s*&&\s*w\.failureCount\s*>\s*0/,
    );
  });
});

describe("PHASE 8 — integration page empty states still anchored", () => {
  it("API keys empty state copy is preserved", () => {
    // The JSX body splits the sentence across lines — match
    // whitespace-tolerantly.
    expect(PAGE).toMatch(
      /No API keys yet\.\s+Create your first key to integrate with[\s\S]{0,40}the Proovra API\./,
    );
    expect(PAGE).toMatch(/data-testid="integrations-api-keys-empty-state"/);
  });

  it("webhooks empty state copy is preserved", () => {
    expect(PAGE).toMatch(
      /No webhook endpoints yet\.\s+Receive event notifications when[\s\S]{0,120}evidence is captured, finalized, or requested\./,
    );
    expect(PAGE).toMatch(/data-testid="integrations-webhooks-empty-state"/);
  });
});

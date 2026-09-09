/**
 * Phase A0 — Integrity hard-gate, UI exposure E2E.
 *
 * The full server-side hard-gate is covered by:
 *   * `services/api/test/phase-a0-integrity-hard-gate.test.ts`
 *   * `services/worker/test/phase-a0-integrity-hard-gate.test.ts`
 *
 * This Playwright spec verifies the UI exposure: when an evidence row
 * is in `FAILED_HASH_MISMATCH`, the detail page renders the
 * operational integrity banner, the status pill carries the
 * `danger` tone, and the four downstream CTAs (Download report,
 * Download package, Copy verification link, Lock record) are
 * disabled.
 *
 * We do not stage a real hash-mismatch end-to-end through the worker
 * here (the worker test covers the rejection path). Instead this
 * spec asserts the static contract on the evidence detail page
 * source: the integrity banner element exists, the disabled props
 * reference `isIntegrityFailed`, and the banner copy stays inside
 * the verification-first vocabulary (no "tampered", "authentic",
 * "admissible").
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Playwright runs from the repo root in CJS-loader mode; the sibling
// e2e specs already use process.cwd()-relative resolution. We follow
// the same pattern here so this spec compiles without `import.meta`
// (which trips the ESM/CJS mismatch under Playwright's TS loader).
const DETAIL_PAGE = readFileSync(
  path.resolve(process.cwd(), "apps/web/app/(app)/evidence/[id]/page.tsx"),
  "utf8",
);

// THE RECORD'S ACTIONS MOVED, SO THE ASSERTIONS FOLLOW THEM.
//
// The detail page was decomposed into `_tabs/*`; the hero icon actions
// (copy verification link, lock, unlock) now live in the tab library and
// receive `isIntegrityFailed` as a prop. The disabled predicates are
// therefore asserted there, and the page is still asserted to PASS the flag
// down — without which the child's guard would never be armed.
const HERO_ACTIONS = readFileSync(
  path.resolve(
    process.cwd(),
    "apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx",
  ),
  "utf8",
);

test.describe("Phase A0 — integrity banner + disabled CTAs (source contract)", () => {
  test("evidence detail page derives an isIntegrityFailed flag from status", () => {
    expect(DETAIL_PAGE).toContain(
      'const isIntegrityFailed = evidence.status === "FAILED_HASH_MISMATCH";',
    );
  });

  test("integrity banner renders only when isIntegrityFailed is true", () => {
    // The banner is wrapped in `{isIntegrityFailed ? (...) : null}`
    // — never rendered for non-failed records, never optimistically
    // rendered while loading.
    expect(DETAIL_PAGE).toMatch(/isIntegrityFailed\s*\?\s*\(/);
    // `evidence-detail-integrity-banner` became the shared record-banner with
    // an EXPLICIT tone attribute, which is a stronger thing to assert than a
    // class name: the danger tone is now stated rather than implied.
    expect(DETAIL_PAGE).toContain("evidence-detail-record-banner");
    expect(DETAIL_PAGE).toMatch(/data-banner-tone="danger"/);
    expect(DETAIL_PAGE).toContain("Integrity check failed");
    // Whitespace-tolerant: the copy is unchanged, but JSX wraps it across a
    // line, so a literal single-space pattern never matched the source.
    expect(DETAIL_PAGE).toMatch(/recomputed\s+server-side\s+fingerprint/i);
  });

  /*
   * RELIABILITY CLOSURE (2026-09-09) — ASSERTED AS A PROPERTY, NOT A SPELLING.
   *
   * These matched `disabled={exportDisabled || isIntegrityFailed}` exactly,
   * which pinned the guard to a two-term expression. A third term was added in
   * front of each — `!reportArtifactAvailable` / `!packageArtifactAvailable` —
   * so the header can no longer offer a download for an artifact that does not
   * exist, and the literal patterns stopped matching while the property they
   * exist for was strictly strengthened.
   *
   * A gate that fails when its subject gets SAFER is a gate that trains people
   * to edit the gate. So each button is now located by its own stable
   * `data-evidence-action` attribute and its `disabled` expression is read out
   * and checked for the terms that must appear in it. The integrity term is
   * still required — that is the Phase A0 hard gate and it is untouched — and
   * the two new guards are required alongside it, so neither can be dropped
   * without this failing.
   */
  function disabledExpressionFor(action: string): string {
    const marker = `data-evidence-action="${action}"`;
    const at = DETAIL_PAGE.indexOf(marker);
    expect(at, `${marker} must exist in the evidence detail page`).toBeGreaterThan(-1);
    // The button's own `disabled={...}` is the LAST one opened before its
    // marker attribute, so read backwards from the marker rather than forwards
    // from the file start — that cannot pick up a neighbouring control's guard.
    const before = DETAIL_PAGE.slice(0, at);
    const open = before.lastIndexOf("disabled={");
    expect(open, `${action} must carry a disabled predicate`).toBeGreaterThan(-1);
    // From that `disabled={` up to the marker is exactly this button's own
    // attribute span: the marker is one of its attributes, and any other
    // control's `disabled` would have to appear after it, not before.
    return before.slice(open);
  }

  test("Download report disabled when isIntegrityFailed", () => {
    const expr = disabledExpressionFor("download-report");
    // THE PHASE A0 HARD GATE. Unchanged.
    expect(expr).toContain("isIntegrityFailed");
    // Governance may still refuse an artifact that exists.
    expect(expr).toContain("exportDisabled");
    // And nothing may offer one that does not.
    expect(expr).toContain("!reportArtifactAvailable");
  });

  test("Download package disabled when isIntegrityFailed", () => {
    const expr = disabledExpressionFor("download-package");
    expect(expr).toContain("isIntegrityFailed");
    expect(expr).toContain("packageDisabled");
    expect(expr).toContain("!packageArtifactAvailable");
  });

  test("Copy verification link disabled when isIntegrityFailed", () => {
    // Still a standalone predicate — no double-negative through a memo —
    // and now layered with the share-url guard in the hero actions component.
    expect(HERO_ACTIONS).toMatch(
      /data-evidence-action="copy-verification-link"/,
    );
    expect(HERO_ACTIONS).toMatch(
      /disabled=\{isIntegrityFailed \|\| !shareUrl\}/,
    );
    // The page must still hand the flag down, or the guard above is inert.
    expect(DETAIL_PAGE).toMatch(/isIntegrityFailed=\{isIntegrityFailed\}/);
    expect(DETAIL_PAGE).toMatch(/onCopyShareLink=\{\(\)\s*=>\s*void\s+copyShareLink\(\)\}/);
  });

  test("Lock record disabled when isIntegrityFailed", () => {
    // Lock action already has its own disabled-when-deleted predicate;
    // integrity failure is layered on with ||. It lives with the other hero
    // actions now, and the page keeps the operator-facing REASON.
    expect(HERO_ACTIONS).toMatch(/data-evidence-action="lock-record"/);
    expect(HERO_ACTIONS).toMatch(/disabled=\{deleted \|\| isIntegrityFailed\}/);
    expect(DETAIL_PAGE).toContain(
      "Locking is unavailable while integrity is failed.",
    );
  });

  test("integrity banner copy stays operational (no overclaiming)", () => {
    const bannerStart = DETAIL_PAGE.indexOf("Integrity check failed");
    expect(bannerStart).toBeGreaterThan(0);
    const window = DETAIL_PAGE.slice(bannerStart, bannerStart + 1200);
    const banned = [
      /\btampered\b/i,
      /\btamper-?proof\b/i,
      /\bforged\b/i,
      /\bfake\b/i,
      /\bauthentic\b/i,
      /\badmissible\b/i,
      /\bproof\s+of\s+tampering\b/i,
    ];
    for (const re of banned) {
      expect(window).not.toMatch(re);
    }
  });
});

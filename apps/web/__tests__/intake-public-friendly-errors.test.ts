/**
 * Public intake page — friendly error contract.
 *
 * Pins that:
 *   - the page has a centralised `friendlyIntakeError` helper that
 *     covers every error code the public route can emit
 *   - the helper STRIPS raw JSON-shaped strings ({…} / […]) before
 *     rendering (recipients must never see raw API JSON)
 *   - every `.catch(...)` site uses the helper (no inline ternary
 *     fallbacks to `err.message ?? "default"` left behind)
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/intake/[token]/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

test("friendlyIntakeError helper exists and covers every audit-mandatory error code", () => {
  const src = read(PAGE);
  assert.match(src, /function friendlyIntakeError\(/);
  for (const code of [
    "RATE_LIMITED",
    "INVALID_OR_EXPIRED_LINK",
    "LINK_NO_LONGER_AVAILABLE",
    "FEATURE_DISABLED",
    "CONSENT_REQUIRED",
    "SESSION_TERMINAL",
    "SESSION_NOT_OPEN_FOR_UPLOAD",
    "MAX_FILES_REACHED",
    "MIME_TYPE_NOT_ALLOWED",
    "FILE_VALIDATION_BLOCKED",
    "PART_INDEX_TAKEN",
    "NOT_FOUND",
    "SUBMISSION_NOT_READY",
    "INTERNAL_ERROR",
  ]) {
    assert.ok(
      src.includes(`${code}:\n`) || src.includes(`${code}:\r\n`) || src.includes(`${code}:\n      `),
      `friendlyIntakeError missing mapping for "${code}"`,
    );
  }
});

test("friendlyIntakeError STRIPS raw JSON-shaped messages so recipients never see `{...}`", () => {
  const src = read(PAGE);
  // The guard against JSON strings is the key safety net: even if the
  // backend ships a malformed message, the helper degrades to a
  // generic safe line instead of rendering JSON.
  assert.match(
    src,
    /if \(msg\.startsWith\("\{"\) \|\| msg\.startsWith\("\["\)\) \{\s*\n?\s*return "Something went wrong/,
  );
});

test("every public-page catch site routes through friendlyIntakeError (no raw `err.message` left)", () => {
  const src = read(PAGE);
  // No catch block should set `setErrorMessage((err as ...).message)`
  // directly — that was the original bug pattern that surfaced raw
  // JSON. Every catch must use friendlyIntakeError.
  assert.ok(
    !/setErrorMessage\(\s*\n?\s*\(err as \{ message\?: string \}\)\?\.message/.test(
      src,
    ),
    "found a setErrorMessage((err as ...).message) site — must route through friendlyIntakeError",
  );
  // Positive pin: at least 4 sites use the helper (initial load + 3
  // mutation handlers).
  const helperUses = [...src.matchAll(/friendlyIntakeError\(/g)];
  assert.ok(
    helperUses.length >= 5,
    `expected ≥5 friendlyIntakeError call sites, found ${helperUses.length}`,
  );
});

/**
 * Public intake page — friendly error contract.
 *
 * Pins that:
 *   - the page has a centralised `friendlyIntakeError` helper that
 *     covers every error code the public route can emit
 *   - the helper NEVER returns the raw backend message — unmapped codes
 *     resolve to a hardcoded safe line (recipients never see raw API JSON)
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

test("friendlyIntakeError NEVER echoes the raw backend message — unmapped codes fall back to a hardcoded safe line", () => {
  const src = read(PAGE);
  // Strongest form of the JSON-safety net: the helper no longer returns
  // `err.message` at all. Any code not in the map resolves to a static
  // string literal, so a malformed or raw-JSON backend message can never
  // reach a recipient.
  const m = src.match(/function friendlyIntakeError\([\s\S]*?\n\}\r?\n/);
  const fnBody = m ? m[0] : "";
  assert.ok(fnBody.length > 0, "could not locate friendlyIntakeError body");
  assert.ok(
    !/return\s+msg\b/.test(fnBody) && !/return\s+\w+\??\.message/.test(fnBody),
    "friendlyIntakeError must not return the raw backend message",
  );
  assert.match(
    fnBody,
    /if \(code && map\[code\]\) return map\[code\];[\s\S]*?return "We couldn't complete that\./,
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

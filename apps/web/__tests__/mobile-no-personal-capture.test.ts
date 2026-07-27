/**
 * PHASE 10 CLOSURE FIX 3 (2026-07-23) — mobile contract for the citizen-
 * capture no-Personal gate (behavior E, required test 10).
 *
 * The mobile app has NO test runner of its own, but its personal-space gate
 * is a PURE module with zero react-native imports, so its decision contract
 * is pinned here in the web node harness (scripts/run-tests.mjs). This proves
 * the SAME no-silent-switch / preserve-local-draft rule the web dirty-work
 * guard enforces, expressed for a platform that has no workspace switcher.
 *
 * The rule under test (apps/mobile/src/personal-space.ts):
 *   - a policy flip to disallowed while a capture session is ACTIVE must NOT
 *     block/yank the surface — the local draft is preserved; the operator
 *     finishes (server independently 403s a disallowed finalize) or discards.
 *   - a FRESH (empty) capture surface IS blocked with the bounded copy.
 *   - there is no workspace/Personal fallback to switch into on mobile.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  shouldBlockMobileCapture,
  isPersonalSpaceDisallowed,
  PERSONAL_SPACE_UNAVAILABLE_MESSAGE,
} from "../../mobile/src/personal-space";

test("10. mobile: an ACTIVE capture session is preserved (not blocked) when Personal Space flips to disallowed", () => {
  // Disallowed policy + a staged local draft ⇒ do NOT block: the draft
  // stays on screen for the operator to finish/discard. No switch exists.
  assert.equal(
    shouldBlockMobileCapture({ loading: false, allowed: false, hasActiveDraft: true }),
    false,
  );
});

test("mobile: a FRESH (empty) capture surface IS blocked when Personal Space is disallowed", () => {
  assert.equal(
    shouldBlockMobileCapture({ loading: false, allowed: false, hasActiveDraft: false }),
    true,
  );
});

test("mobile: an allowed identity is never blocked, draft or not", () => {
  assert.equal(
    shouldBlockMobileCapture({ loading: false, allowed: true, hasActiveDraft: false }),
    false,
  );
  assert.equal(
    shouldBlockMobileCapture({ loading: false, allowed: true, hasActiveDraft: true }),
    false,
  );
});

test("mobile: the initial fetch (loading) fails OPEN — capture is never blocked on a network hiccup", () => {
  assert.equal(
    shouldBlockMobileCapture({ loading: true, allowed: false, hasActiveDraft: false }),
    false,
  );
});

test("mobile: isPersonalSpaceDisallowed only trips on an EXPLICIT false (absent = allowed)", () => {
  assert.equal(isPersonalSpaceDisallowed({ personalSpaceAllowed: false }), true);
  assert.equal(isPersonalSpaceDisallowed({ personalSpaceAllowed: true }), false);
  assert.equal(isPersonalSpaceDisallowed({}), false);
  assert.equal(isPersonalSpaceDisallowed(null), false);
  assert.equal(isPersonalSpaceDisallowed(undefined), false);
});

test("mobile: the unavailable copy is bounded — no policy internals leaked", () => {
  assert.doesNotMatch(
    PERSONAL_SPACE_UNAVAILABLE_MESSAGE,
    /identityMode|ssoRequired|MANAGED_ENTERPRISE|SCIM|managingOrganizationId/i,
  );
});

test("source contract: mobile personal-space.ts never re-derives policy signals client-side", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(
    resolve(root, "..", "mobile", "src", "personal-space.ts"),
    "utf8",
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /identityMode|ssoRequired|MANAGED_ENTERPRISE|managingOrganizationId/i);
});

/**
 * UC-LCH-001 — mobile (UC-2/UC-3/UC-5) and browser screen capture have a
 * canonical legal disclosure, like Direct Web Capture does: an authored
 * document, a registered slug (so /legal/screen-capture and
 * /settings/legal/screen-capture resolve), a hero entry, and honest
 * trust-boundary statements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWED_LEGAL_SLUGS } from "../app/legal/legal-content";
import { LEGAL_HERO_META } from "../app/legal/legal-hero-meta";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(WEB, "content/legal/en/screen-capture.md");

test("the screen-capture disclosure is authored", () => {
  assert.ok(existsSync(DOC), "content/legal/en/screen-capture.md must exist");
  const md = readFileSync(DOC, "utf8");
  assert.match(md, /^# How Screen Capture Works/m);
  assert.match(md, /^Last Updated: \d{4}-\d{2}-\d{2}$/m);
  // All three channels are named.
  assert.match(md, /MediaProjection/);
  assert.match(md, /ReplayKit/);
  assert.match(md, /browser screen recording/i);
  // The trust boundary is stated, not implied.
  assert.match(md, /No device or operating-system attestation/);
  assert.match(md, /do not record microphone or device audio/);
  for (const banned of ["Court-ready", "Legally admissible", "tamper-proof", "proves authenticity"]) {
    assert.ok(!md.includes(banned), `disclosure must not claim "${banned}"`);
  }
});

test("the screen-capture slug is registered so the link resolves", () => {
  assert.ok(
    ALLOWED_LEGAL_SLUGS.has("screen-capture"),
    "'screen-capture' must be in LEGAL_SLUGS (packages/shared/src/legal/slugs.ts) and the corpus regenerated",
  );
});

test("the legal hero carries a screen-capture entry", () => {
  assert.ok(LEGAL_HERO_META["screen-capture"], "legal-hero-meta needs a 'screen-capture' entry");
});

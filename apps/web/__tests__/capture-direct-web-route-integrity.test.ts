import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ALLOWED_LEGAL_SLUGS } from "../app/legal/legal-content";

/**
 * PERMANENT GUARDS A + B (audit §19) — Capture route + install-CTA integrity.
 *
 * These regressions reached Production once already:
 *   - the Direct Web Capture "Install" CTA fell back to /settings/legal/
 *     direct-web-capture, a slug that was never in ALLOWED_LEGAL_SLUGS, so it
 *     returned a hard 404 (F1);
 *   - the install control was rendered unconditionally, promising an install
 *     that does not exist (F2) and on platforms that can never run it (F3).
 *
 * This is a source-contract guard (environment-light, matches the repo's other
 * __tests__ contract style). Behavioural coverage of the capability states lives
 * in packages/shared/tests/capture-capability.test.mjs.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const captureLibDir = path.resolve(here, "..", "app", "(app)", "capture", "_lib");
const cardPath = path.join(captureLibDir, "CaptureDirectWebCaptureCard.tsx");
const cardSource = readFileSync(cardPath, "utf8");

const LEGAL_LINK_RE = /\/(?:settings\/)?legal\/([a-z0-9-]+)/g;

function legalSlugsIn(source: string): string[] {
  const slugs: string[] = [];
  for (const m of source.matchAll(LEGAL_LINK_RE)) slugs.push(m[1]);
  return slugs;
}

test("the Direct Web Capture card has no internal install fallback (F1 regression)", () => {
  // The exact prior defect: env-coalesce to an internal path.
  assert.doesNotMatch(
    cardSource,
    /EXTENSION_INSTALL_URL\s*\?\?\s*["']\//,
    "install URL must never coalesce to an internal path",
  );
  // No hardcoded /settings/legal/... used as the install target.
  assert.doesNotMatch(
    cardSource,
    /data-capture-direct-web-install[\s\S]*?href=["']\//,
    "the install anchor must not point at an internal route literal",
  );
});

test("the install CTA is capability-gated and bound to the external install URL (F2/F3)", () => {
  // Rendered only when the capability authority says canInstall.
  assert.match(
    cardSource,
    /canInstall\s*&&\s*installUrl\s*\?/,
    "install anchor must be guarded by canInstall && installUrl",
  );
  // Href is the capability-derived external URL, not a literal.
  assert.match(cardSource, /href=\{installUrl\}/, "install href must be {installUrl}");
  // External links are opened safely.
  assert.match(cardSource, /rel="noopener noreferrer"/);
  // It consults the canonical capability authority (not an ad-hoc check).
  assert.match(cardSource, /useCaptureCapabilities\(\)/);
});

test("every internal legal link on the capture surface resolves to a real slug (route integrity)", () => {
  // Scan the whole capture _lib surface, not only the one card.
  const files = readdirSync(captureLibDir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
  let scanned = 0;
  for (const f of files) {
    const src = readFileSync(path.join(captureLibDir, f), "utf8");
    for (const slug of legalSlugsIn(src)) {
      scanned += 1;
      assert.ok(
        ALLOWED_LEGAL_SLUGS.has(slug),
        `capture/_lib/${f} links to /legal/${slug} which is NOT in ALLOWED_LEGAL_SLUGS`,
      );
    }
  }
  // Guard the guard: the card's learn-more link must be one of the links scanned.
  assert.ok(scanned >= 1, "expected at least one internal legal link to be verified");
});

test("the Direct Web Capture disclosure slug exists (learn-more cannot 404, F9)", () => {
  assert.ok(
    ALLOWED_LEGAL_SLUGS.has("direct-web-capture"),
    "the 'direct-web-capture' disclosure slug must exist so the learn-more link resolves",
  );
});

/**
 * Canonical legal-document design system contracts (2026-07-18).
 *
 * ONE visual system for public and authenticated legal/trust documents:
 *
 *   - `legalArticleStyles.ts` is the single typography/token source;
 *   - the PUBLIC /legal/[slug] page and the AUTHENTICATED
 *     `LegalDocumentShell` both consume it (zero drift);
 *   - every retained /trust-center/* page renders through the shell
 *     (status uses the operational variant);
 *   - the legacy inline admin document styling is gone;
 *   - authorization stays with the parents (shell is presentation-only);
 *   - Settings keeps its small privacy projection (no legal dump).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGAL_ARTICLE_CARD,
  LEGAL_ARTICLE_CLASSES,
  LEGAL_ARTICLE_TYPOGRAPHY,
  LEGAL_PAGE_BG,
} from "../components/legal/legalArticleStyles";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const SHELL = read("components/legal/LegalDocumentShell.tsx");
const PUBLIC_SLUG = read("app/legal/[slug]/page.tsx");
const SECTION_LIST = read("app/(app)/trust-center/_section-list.tsx");
const SUBPROCESSORS = read("app/(app)/trust-center/subprocessors/page.tsx");
const STATUS = read("app/(app)/trust-center/status/page.tsx");
const METHODOLOGY = read("app/(app)/trust-center/methodology/page.tsx");
const SECURITY = read("app/(app)/trust-center/security/page.tsx");
const AI_DISCLOSURE = read("app/(app)/trust-center/ai-disclosure/page.tsx");
const PRIVACY_SECTION = read("app/(app)/settings/_sections/PrivacySection.tsx");

// ---------------------------------------------------------------------------
// RUNTIME — canonical token exports
// ---------------------------------------------------------------------------

test("canonical tokens: one page background, one typography chain, card is public-only", () => {
  assert.equal(LEGAL_PAGE_BG, "#F6F9FC");
  // The SHARED typography chain carries the public contract's signature
  // rules — used verbatim by both the public card article and the flat
  // internal article (zero drift).
  for (const signature of [
    "[&_h2]:text-[1.42rem]",
    "[&_p]:leading-[1.88]",
    "[&_ul>li::before]:bg-[#2563EB]",
    "[&_th]:uppercase",
  ]) {
    assert.ok(
      LEGAL_ARTICLE_TYPOGRAPHY.includes(signature),
      `typography chain carries ${signature}`,
    );
  }
  // The white document card is PUBLIC-only chrome: present in the card
  // token + the public composite, never in the typography chain.
  assert.ok(LEGAL_ARTICLE_CARD.includes("rounded-[24px]"));
  assert.ok(LEGAL_ARTICLE_CARD.includes("bg-white"));
  assert.ok(!LEGAL_ARTICLE_TYPOGRAPHY.includes("rounded-[24px]"));
  assert.ok(!LEGAL_ARTICLE_TYPOGRAPHY.includes("shadow-"));
  // The public composite is exactly card + typography.
  assert.equal(
    LEGAL_ARTICLE_CLASSES,
    `${LEGAL_ARTICLE_CARD} ${LEGAL_ARTICLE_TYPOGRAPHY}`,
  );
});

// ---------------------------------------------------------------------------
// ONE source — public page and shell both consume the shared module
// ---------------------------------------------------------------------------

test("public /legal/[slug] consumes the shared typography source (no inline fork)", () => {
  assert.match(PUBLIC_SLUG, /LEGAL_ARTICLE_CLASSES/);
  assert.match(PUBLIC_SLUG, /legalArticleStyles/);
  // The old 20-line inline class chain is gone from the page.
  assert.doesNotMatch(PUBLIC_SLUG, /\[&_h2\]:text-\[1\.42rem\]/);
});

test("the authenticated shell is FLAT: shared typography, no hero, no card, no authorization", () => {
  // Same zero-drift typography chain as the public article…
  assert.match(SHELL, /LEGAL_ARTICLE_TYPOGRAPHY/);
  // …but never the public-only chrome: no hero artwork, no white
  // document card (2026-07-19 flat enterprise-document layout).
  assert.doesNotMatch(SHELL, /LEGAL_HERO_IMAGE/);
  assert.doesNotMatch(SHELL, /LEGAL_ARTICLE_CLASSES/);
  assert.doesNotMatch(SHELL, /LEGAL_ARTICLE_CARD/);
  assert.doesNotMatch(SHELL, /legal-hero/);
  assert.doesNotMatch(SHELL, /data-legal-document-hero/);
  // The compact header replaces the hero and keeps its content.
  assert.match(SHELL, /data-legal-document-header/);
  assert.match(SHELL, /data-legal-document-title/);
  assert.match(SHELL, /data-legal-document-divider/);
  // Import-scoped (docblock prose may NAME the gates it defers to):
  // the shell never imports an authorization or data-fetch module.
  assert.doesNotMatch(
    SHELL,
    /^import[^\n]*(PageRouteGate|canAccessSurface|apiFetch|MarketingHeader)/m,
  );
  // Scope badge vocabulary is bounded.
  assert.match(SHELL, /Organization document/);
  assert.match(SHELL, /Trust documentation/);
});

// ---------------------------------------------------------------------------
// Every retained trust-center page renders through the shell
// ---------------------------------------------------------------------------

test("all trust-center document pages render through LegalDocumentShell", () => {
  assert.match(SECTION_LIST, /LegalDocumentShell/);
  assert.match(SUBPROCESSORS, /LegalDocumentShell/);
  assert.match(STATUS, /LegalDocumentShell/);
  // The three article pages go through the shared section list.
  for (const src of [METHODOLOGY, SECURITY, AI_DISCLOSURE]) {
    assert.match(src, /TrustCenterSectionList/);
    assert.match(src, /PageRouteGate/); // authorization stays on the parent
  }
});

test("status page keeps its OPERATIONAL body (variant), not policy prose", () => {
  assert.match(STATUS, /variant="operational"/);
  for (const marker of [
    "data-status-page",
    "data-status-components",
    "data-status-active-incidents",
    "data-status-recent-incidents",
    "data-status-maintenance",
    "data-status-overall",
  ]) {
    assert.ok(STATUS.includes(marker), `status keeps ${marker}`);
  }
});

// ---------------------------------------------------------------------------
// Legacy internal document styling is gone
// ---------------------------------------------------------------------------

test("legacy admin document styling is deleted from migrated pages", () => {
  for (const [name, src] of [
    ["_section-list", SECTION_LIST],
    ["subprocessors", SUBPROCESSORS],
    ["status", STATUS],
  ] as const) {
    // The old 22px inline h1 header block is gone.
    assert.doesNotMatch(src, /fontSize: 22/, `${name}: no legacy h1`);
    // The old 1320px flat admin container is gone (shell owns layout).
    assert.doesNotMatch(src, /maxWidth: 1320/, `${name}: no legacy container`);
  }
  // Article bodies are typographic paragraphs, never raw <pre> dumps.
  assert.doesNotMatch(SECTION_LIST, /<pre/);
  // The old dashboard-card article chrome is gone.
  assert.doesNotMatch(SECTION_LIST, /cases-panel/);
});

test("drift badges + references + load-state contracts survive the redesign", () => {
  for (const marker of [
    "data-trust-center-page-phase",
    "data-trust-center-page-references",
    "data-trust-article-state",
    "DriftBadge",
  ]) {
    assert.ok(SECTION_LIST.includes(marker), `section list keeps ${marker}`);
  }
  assert.ok(SUBPROCESSORS.includes("data-subprocessors-table"));
  assert.ok(SUBPROCESSORS.includes("data-subprocessors-phase"));
});

// ---------------------------------------------------------------------------
// Settings privacy projection unchanged (no legal dump returns)
// ---------------------------------------------------------------------------

test("Settings privacy keeps the small reference projection only", () => {
  assert.match(PRIVACY_SECTION, /Submit a privacy request/);
  assert.match(PRIVACY_SECTION, /public Trust Center/);
  // None of the former library documents are linked from Settings.
  for (const slug of [
    "/legal/dpa",
    "/legal/toms",
    "/legal/subprocessors",
    "/legal/impressum",
    "/legal/law-enforcement",
  ]) {
    assert.ok(
      !PRIVACY_SECTION.includes(`href="${slug}"`),
      `settings must not link ${slug}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Public canonical routes untouched
// ---------------------------------------------------------------------------

test("public legal system unchanged: slugs, hero, footer, redirect landing", () => {
  const CONTENT = read("app/legal/legal-content.tsx");
  assert.match(CONTENT, /ALLOWED_LEGAL_SLUGS/);
  assert.match(PUBLIC_SLUG, /LegalHero/);
  assert.match(PUBLIC_SLUG, /EnterpriseFooter/);
  const LANDING = read("app/(app)/trust-center/page.tsx");
  assert.match(LANDING, /redirect\("\/trust"\)/);
});

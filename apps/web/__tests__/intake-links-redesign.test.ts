/**
 * Intake-links-e2e redesign — page UX source-contract.
 *
 * Pins the new operational layout so a future refactor can't silently
 * re-introduce the giant guidance card or drop the wired tile actions:
 *
 *   - Page header carries the operational subtitle + the primary
 *     "New intake link" CTA, both with stable data-attrs.
 *   - When links EXIST: operational list renders first, then
 *     How-it-works strip + Common requests in `secondary` /
 *     `collapsed` mode (smaller / de-emphasised).
 *   - When links DON'T exist: dedicated EmptyState with two real
 *     actions (Create + Learn) and three concrete examples, plus an
 *     inline subset of the Common-requests tiles.
 *   - Every "Start" tile is wired through onPickRequestType →
 *     openCreate(slug), which carries the slug to the modal via the
 *     new `initialSlug` prop.
 *   - The create modal accepts initialSlug and resolves it against
 *     the REQUEST_TYPES catalog (invalid → falls back to default).
 *   - All existing actions (Resend / Revoke / View submissions /
 *     Delivery drawer) and API endpoints remain present.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/intake-links/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ============================================================================
// A) Header + primary CTA
// ============================================================================

test("Page header — operational subtitle + primary 'New intake link' CTA", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /Create secure links so people outside your workspace can[\s\S]{0,80}upload photos, videos, audio, or documents/,
  );
  assert.match(src, /data-intake-links-new-cta="true"/);
  // The header CTA opens the modal with NO preselected slug (so the
  // user lands on the General Evidence Request default).
  assert.match(src, /onClick=\{\(\) => openCreate\(\)\}/);
});

// ============================================================================
// B) How-it-works strip
// ============================================================================

test("HowItWorksStrip — three compact cards (Create / Share / Track)", () => {
  const src = read(PAGE);
  assert.match(src, /function HowItWorksStrip\(\{ secondary \}/);
  // The catalog must enumerate exactly these three steps in this
  // order. A future refactor that drops one would break the
  // 3-card grid layout.
  const catalogIdx = src.indexOf("const HOW_IT_WORKS_CARDS:");
  assert.ok(catalogIdx > 0, "HOW_IT_WORKS_CARDS catalog missing");
  const sliceEnd = src.indexOf("];", catalogIdx);
  const slice = src.slice(catalogIdx, sliceEnd);
  for (const title of ["Create", "Share", "Track"]) {
    assert.ok(
      slice.includes(`title: "${title}"`),
      `HOW_IT_WORKS_CARDS missing title "${title}"`,
    );
  }
  // Per-card data-attrs so each tile can be selected by e2e probes.
  assert.match(src, /data-intake-links-howitworks-card=\{c\.testId\}/);
});

test("HowItWorksStrip — `secondary` variant is wired so the strip de-emphasises when links exist", () => {
  const src = read(PAGE);
  // The prop drives a data-attr so e2e can assert the variant flip.
  assert.match(
    src,
    /data-intake-links-howitworks-secondary=\{secondary \? "true" : "false"\}/,
  );
  // The page-level render passes `secondary={(items?.length ?? 0) > 0}`,
  // so a workspace with no links sees the full-size strip; a
  // populated workspace sees the compact one.
  assert.match(
    src,
    /<HowItWorksStrip secondary=\{\(items\?\.length \?\? 0\) > 0\} \/>/,
  );
});

// ============================================================================
// C) Common requests tiles
// ============================================================================

test("CommonRequestsSection — 6 wired tiles covering all SMB request types", () => {
  const src = read(PAGE);
  const catalogIdx = src.indexOf("const COMMON_REQUEST_TILES:");
  assert.ok(catalogIdx > 0, "COMMON_REQUEST_TILES catalog missing");
  const sliceEnd = src.indexOf("];", catalogIdx);
  const slice = src.slice(catalogIdx, sliceEnd);
  for (const slug of [
    "general-evidence-record",
    "photos-videos",
    "documents",
    "insurance-claim",
    "legal-matter",
    "property-damage",
  ]) {
    assert.ok(
      slice.includes(`slug: "${slug}"`),
      `COMMON_REQUEST_TILES missing tile for "${slug}"`,
    );
  }
});

test("CommonRequestsSection — every Start button is WIRED (no fake actions)", () => {
  const src = read(PAGE);
  assert.match(src, /function CommonRequestsSection\(/);
  // The Start onClick handler must call onPick with the tile's slug
  // — pin the literal so a future refactor can't quietly drop the
  // wiring and ship a fake-button surface.
  assert.match(
    src,
    /onClick=\{\(\) => onPick\(t\.slug\)\}/,
  );
  // The tile carries the slug for the e2e probe to assert the
  // preselection.
  assert.match(
    src,
    /data-intake-links-common-tile=\{t\.slug\}/,
  );
  assert.match(
    src,
    /data-intake-links-common-tile-start=\{t\.slug\}/,
  );
});

test("CommonRequestsSection — page wires tile pick through openCreate(slug)", () => {
  const src = read(PAGE);
  // The page render must pass onPick={(slug) => openCreate(slug)} so
  // the modal opens with the slug preselected.
  assert.match(
    src,
    /<CommonRequestsSection[\s\S]{0,200}onPick=\{\(slug\) => openCreate\(slug\)\}/,
  );
  // Collapsed mode mirrors the secondary variant on the strip.
  assert.match(
    src,
    /collapsed=\{\(items\?\.length \?\? 0\) > 0\}/,
  );
});

// ============================================================================
// D) Empty state
// ============================================================================

test("EmptyState — title + body + two real actions + concrete examples + 3 quick-start tiles", () => {
  const src = read(PAGE);
  assert.match(src, /function EmptyState\(/);
  assert.match(src, /No intake links yet/);
  assert.match(
    src,
    /Create your first secure upload link to request evidence from/,
  );
  // Two real actions, each with its own data-attr.
  assert.match(src, /data-intake-links-empty-create="true"/);
  assert.match(src, /data-intake-links-empty-learn="true"/);
  // The three concrete examples from the design brief.
  for (const ex of [
    "Ask a client for accident photos",
    "Collect signed documents",
    "Request property damage evidence",
  ]) {
    assert.ok(
      src.includes(`"${ex}"`),
      `EmptyState examples missing "${ex}"`,
    );
  }
  // Inline 3-tile preview that uses the SAME onPickRequestType
  // wiring as the standalone section.
  assert.match(src, /data-intake-links-empty-tile-start=\{t\.slug\}/);
});

test("EmptyState — render gated on items === [] (truthful, not just `null`)", () => {
  const src = read(PAGE);
  // Loading (items === null) must show "Loading workspace…", NOT the
  // empty state. The render gate must check length === 0 explicitly.
  assert.match(
    src,
    /items !== null && items\.length === 0 \? \(\s*\n?\s*<EmptyState/,
  );
});

// ============================================================================
// E) Operational list prioritised when populated
// ============================================================================

test("Operational list — renders BEFORE the guidance / tiles when items exist", () => {
  const src = read(PAGE);
  // The list section must appear higher in the JSX render than the
  // HowItWorksStrip; otherwise returning users get pushed below the
  // explainer.
  const listIdx = src.indexOf('data-intake-links-list-section="true"');
  const howIdx = src.indexOf('data-intake-links-howitworks="true"');
  assert.ok(listIdx > 0 && howIdx > 0);
  assert.ok(
    listIdx < howIdx,
    "Operational list must render before HowItWorksStrip in the JSX",
  );
});

test("Operational list — gated on items.length > 0 (does not render empty <ul>)", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /items !== null && items\.length > 0 \? \(\s*\n?\s*<section data-intake-links-list-section="true">/,
  );
});

// ============================================================================
// F) Modal — initialSlug wiring
// ============================================================================

test("CreateLinkModal — accepts `initialSlug` prop and resolves against REQUEST_TYPES", () => {
  const src = read(PAGE);
  assert.match(src, /initialSlug\?: string;/);
  // Validation: a bad initialSlug must NOT land the modal on an
  // unknown template. The defaulting logic asserts the slug exists
  // in REQUEST_TYPES before using it.
  assert.match(
    src,
    /REQUEST_TYPES\.some\(\(r\) => r\.slug === initialSlug\)/,
  );
});

test("Modal open helper — clears stale error every time before opening", () => {
  const src = read(PAGE);
  assert.match(src, /const openCreate = \(initialSlug\?: string\) =>/);
  // The helper must wipe the page-level error first; otherwise a
  // failed submit from a prior attempt would still be visible on
  // re-open.
  assert.match(
    src,
    /openCreate = \(initialSlug\?: string\) => \{\s*\n?\s*setError\(null\);/,
  );
});

test("Create modal block — passes initialSlug from createOpen state to the modal", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /<CreateLinkModal[\s\S]{0,300}initialSlug=\{createOpen\.initialSlug\}/,
  );
});

// ============================================================================
// G) Safety note + no regressions in existing actions / APIs
// ============================================================================

test("Safety note — compact, explicit about what does NOT happen", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-links-safety-note="true"/);
  assert.match(
    src,
    /Contributors can submit files without accessing your[\s\S]{0,80}workspace\. You control delivery, expiration, file types, and[\s\S]{0,40}revocation\./,
  );
});

test("Existing endpoints + actions still wired (no API removal)", () => {
  const src = read(PAGE);
  // Every API path the redesign brief promised to preserve.
  for (const path of [
    "/v1/workflow/intake-links",
    "/v1/workflow/intake-links/${encodeURIComponent(linkId)}/submissions",
    "/v1/workflow/intake-links/${linkId}/revoke",
    "/v1/workflow/templates",
  ]) {
    assert.ok(
      src.includes(path),
      `redesign must not drop the "${path}" call`,
    );
  }
  // The three per-row actions must still be reachable from the card.
  assert.match(src, /data-intake-link-view-submissions=\{link\.id\}/);
  assert.match(src, /data-intake-link-delivery=\{link\.id\}/);
  assert.match(src, /data-intake-link-revoke-btn=\{link\.id\}/);
});

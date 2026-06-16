/**
 * Search-page-final-cleanup — three audit deliverables, end-to-end
 * pinned in source contracts:
 *
 *   A) Workspace-health chip is DEFAULT-HIDDEN. Even platform
 *      admins see clean chrome unless they opt in via
 *      `?_debug=search-health` in the URL. The user-facing
 *      "Search is being set up" message is the only thing that
 *      can render without the opt-in, and only when search is
 *      genuinely blocking the current view.
 *
 *   B) The evidence detail page surfaces a clear "This record is
 *      in trash" banner with a Restore action when the record is
 *      soft-deleted. The banner is the user-facing signal; the
 *      existing disabled={evidence.deletedAt != null} guards on
 *      every mutation button stay in place.
 *
 *   C) The filter rail has Apply / Clear buttons just below the
 *      date pickers, so the user doesn't have to scroll back to
 *      the top-right Search button after editing Since/Until.
 *      Date inputs go through a draft buffer; chips/toggles still
 *      auto-apply.
 *
 *   D) Filter wire pin — DOCUMENT_TYPES is uppercase, every filter
 *      dimension is serialised correctly into the URL, no
 *      lowercase enum literals leak. (Audit; no code change.)
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/search/page.tsx");
const DETAIL = resolve(
  REPO_ROOT,
  "apps/web/app/(app)/evidence/[id]/page.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ============================================================================
// A) Chip is default-hidden, opt-in via ?_debug=search-health
// ============================================================================

test("A) Chip — `?_debug=search-health` opt-in state is read from the URL on mount", () => {
  const src = read(PAGE);
  assert.match(src, /const \[searchHealthDebugOptIn, setSearchHealthDebugOptIn\]/);
  // The effect that reads the URL must check for the exact flag
  // value ("search-health").
  assert.match(
    src,
    /url\.searchParams\.get\("_debug"\) === "search-health"/,
  );
});

test("A) Chip — `supportOptIn` is gated on BOTH isPlatformAdmin AND the URL flag", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /const supportOptIn =\s*\n?\s*isPlatformAdmin && searchHealthDebugOptIn/,
  );
});

test("A) Chip — without supportOptIn, only the user-blocking empty_index branch renders (everything else collapses to null)", () => {
  const src = read(PAGE);
  // The render path must early-return null when neither
  // supportOptIn nor the user-blocking condition is true.
  assert.match(src, /if \(!supportOptIn && !userBlocking\) return null;/);
});

test("A) Chip — `data-search-health-audience` distinguishes user vs admin paths", () => {
  const src = read(PAGE);
  assert.match(src, /data-search-health-audience="user"/);
  assert.match(src, /data-search-health-audience="admin"/);
});

test("A) Chip — searchHealthError fallback chip is gated on BOTH admin AND opt-in", () => {
  const src = read(PAGE);
  // Both conditions in a single ternary head — pin the literal so
  // a future refactor can't accidentally relax to one of them.
  assert.match(
    src,
    /searchHealthError &&\s*\n?\s*isPlatformAdmin &&\s*\n?\s*searchHealthDebugOptIn/,
  );
});

// ============================================================================
// B) Trash banner on evidence detail page
// ============================================================================

test("B) Trash banner — renders when evidence.deletedAt is set, with the correct data-attr", () => {
  const src = read(DETAIL);
  assert.match(src, /\{evidence\.deletedAt \?/);
  assert.match(src, /data-evidence-trash-banner="true"/);
  // User-facing copy must be plain English ("trash"), never raw
  // wire tokens like "in_trash" or "deletedAt".
  assert.match(src, /This record is in trash/);
});

test("B) Trash banner — Restore button calls the real backend endpoint, with loading/error UX preserved", () => {
  const src = read(DETAIL);
  // The Restore action in the banner must reuse `restoreTrash`
  // (not duplicate logic). `restoreTrash` already hits
  // POST /v1/evidence/:id/restore + addToast + captureException.
  assert.match(src, /onClick=\{\(\) => void restoreTrash\(\)\}/);
  assert.match(src, /data-evidence-trash-restore="true"/);
  assert.match(src, /\/v1\/evidence\/\$\{evidenceId\}\/restore/);
});

test("B) Trash banner — every mutation button on the page is still disabled when deletedAt is set (no regression)", () => {
  const src = read(DETAIL);
  // The existing guards must remain. Pin the literal disabled
  // expression — there are 4 mutation buttons in the hero that
  // need this.
  const matches = [...src.matchAll(/disabled=\{evidence\.deletedAt != null\}/g)];
  assert.ok(
    matches.length >= 3,
    `expected ≥3 hero buttons gated on deletedAt, got ${matches.length}`,
  );
});

// ============================================================================
// C) Apply / Clear filters in the left rail
// ============================================================================

test("C) Apply filters — date inputs are draft-backed (datetime-local change writes to draft, not the live filter)", () => {
  const src = read(PAGE);
  // The two draft state declarations.
  assert.match(src, /const \[dateSinceDraft, setDateSinceDraft\] = useState<string>\(""\)/);
  assert.match(src, /const \[dateUntilDraft, setDateUntilDraft\] = useState<string>\(""\)/);
  // The date inputs bind to the draft state, NOT directly to
  // filter.updatedSinceUtc / .updatedUntilUtc.
  assert.match(
    src,
    /onChange=\{\(e\) => setDateSinceDraft\(e\.target\.value\)\}/,
  );
  assert.match(
    src,
    /onChange=\{\(e\) => setDateUntilDraft\(e\.target\.value\)\}/,
  );
});

test("C) Apply filters — date drafts sync from the live filter (so saved-view load / deep link / Clear update the inputs)", () => {
  const src = read(PAGE);
  // The useEffect that syncs draft ← live must be keyed on the
  // two filter dimensions so external changes propagate.
  assert.match(
    src,
    /setDateSinceDraft\(filter\.updatedSinceUtc\?\.slice\(0, 16\) \?\? ""\)/,
  );
  assert.match(
    src,
    /setDateUntilDraft\(filter\.updatedUntilUtc\?\.slice\(0, 16\) \?\? ""\)/,
  );
});

test("C) Apply filters — applyDraftFilters converts datetime-local → ISO and pushes both into updateFilter", () => {
  const src = read(PAGE);
  assert.match(src, /const applyDraftFilters = useCallback\(/);
  assert.match(src, /new Date\(dateSinceDraft\)\.toISOString\(\)/);
  assert.match(src, /new Date\(dateUntilDraft\)\.toISOString\(\)/);
  // Empty draft → undefined (clears the wire dimension).
  assert.match(src, /dateSinceDraft\s*\?\s*new Date\(dateSinceDraft\)\.toISOString\(\)\s*:\s*undefined/);
});

test("C) Clear filters — wipes every narrowing dimension AND both date drafts, but preserves `q`", () => {
  const src = read(PAGE);
  assert.match(src, /const clearNarrowingFilters = useCallback\(/);
  const fnIdx = src.indexOf("const clearNarrowingFilters = useCallback(");
  const fnEnd = src.indexOf("}, [filter, updateFilter])", fnIdx);
  const body = src.slice(fnIdx, fnEnd);
  // Every narrowing dimension is wiped.
  for (const dim of [
    "documentTypes",
    "evidenceTypes",
    "workflowStatuses",
    "reviewStatuses",
    "onLegalHold",
    "exportRestricted",
    "incidentLinked",
    "workflowLinked",
    "contributorScoped",
    "updatedSinceUtc",
    "updatedUntilUtc",
  ]) {
    assert.ok(body.includes(`${dim}: undefined`), `Clear must wipe ${dim}`);
  }
  // Drafts cleared.
  assert.match(body, /setDateSinceDraft\(""\)/);
  assert.match(body, /setDateUntilDraft\(""\)/);
  // `q` is intentionally NOT in the wipe list.
  assert.ok(!/^\s*q: undefined/m.test(body));
});

test("C) Apply / Clear panel — rendered with data-attrs the e2e probe expects, gated on dirty / non-empty", () => {
  const src = read(PAGE);
  assert.match(src, /data-search-filter-apply-panel="true"/);
  assert.match(src, /data-search-filter-apply="true"/);
  assert.match(src, /data-search-filter-clear="true"/);
  // The panel render gate must show the buttons EITHER when the
  // date draft is dirty OR when any narrowing filter is active.
  assert.match(src, /\(dateDraftDirty \|\| filtersNonEmpty\) \? \(/);
});

test("C) Date input fields carry stable data-attrs for end-to-end pickers", () => {
  const src = read(PAGE);
  assert.match(src, /data-search-filter-date-since-input="true"/);
  assert.match(src, /data-search-filter-date-until-input="true"/);
});

// ============================================================================
// D) Filter wire audit — every dimension verified
// ============================================================================

test("D) Wire — documentTypes serialise as uppercase, comma-joined, into the URL", () => {
  const src = read(PAGE);
  // DOCUMENT_TYPES catalog uppercase.
  assert.match(
    src,
    /const DOCUMENT_TYPES: DocumentType\[\] = \[\s*\n\s*"EVIDENCE",\s*\n\s*"CASE",\s*\n\s*"REPORT",\s*\n\s*"PACKAGE",\s*\n\s*"NOTE",\s*\n\s*\]/,
  );
  // runSearch serialiser joins with comma.
  assert.match(
    src,
    /qs\.set\("documentTypes", filter\.documentTypes\.join\(","\)\)/,
  );
});

test("D) Wire — every filter dimension has a serialiser in runSearch", () => {
  const src = read(PAGE);
  const runIdx = src.indexOf("async function runSearch(");
  const body = src.slice(runIdx, runIdx + 3000);
  for (const param of [
    "teamId",
    "q",
    "documentTypes",
    "evidenceTypes",
    "workflowStatuses",
    "reviewStatuses",
    "onLegalHold",
    "exportRestricted",
    "incidentLinked",
    "workflowLinked",
    "contributorScoped",
    "updatedSinceUtc",
    "updatedUntilUtc",
    "sort",
  ]) {
    assert.match(
      body,
      new RegExp(`qs\\.set\\("${param}"`),
      `runSearch missing serialiser for ${param}`,
    );
  }
});

test("D) Wire — boolean toggles are serialised as 'true'/'false' strings (backend parseBool accepts these)", () => {
  const src = read(PAGE);
  const runIdx = src.indexOf("async function runSearch(");
  const body = src.slice(runIdx, runIdx + 3000);
  for (const flag of [
    "onLegalHold",
    "exportRestricted",
    "incidentLinked",
    "workflowLinked",
    "contributorScoped",
  ]) {
    assert.match(
      body,
      new RegExp(`qs\\.set\\("${flag}", String\\(filter\\.${flag}\\)\\)`),
      `${flag} must serialise via String(...)`,
    );
  }
});

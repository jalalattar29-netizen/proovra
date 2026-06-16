/**
 * Search-inclusion-audit (trash decision) — frontend UI surface.
 *
 * Pins:
 *
 *   - "In trash" badge renders the friendly label (not raw
 *     "in_trash" wire token).
 *   - Open action on a trash result routes to the same record
 *     URL with `?context=trash` so the destination can switch
 *     to read-only / restore-only mode.
 *   - Open button label flips to "Open in trash" for trash rows.
 *   - Diagnostics breakdown type carries activeIncluded /
 *     trashedIncluded / hardDeletedAbsent (and no longer the
 *     stale `deletedExcluded` field).
 *   - Admin chip data-attrs surface the per-state counts.
 *   - Admin tooltip enumerates active / archived / locked / in
 *     trash / destroyed / pending destruction / hard-deleted.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/search/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

test("renderBadgeLabel maps 'in_trash' to the user-facing 'In trash' string", () => {
  const src = read(PAGE);
  assert.match(src, /function renderBadgeLabel\(/);
  // The case branch must be present + exact.
  assert.match(src, /case "in_trash":\s*\n\s*return "In trash";/);
});

test("Open action routes trash rows to the read-only context (?context=trash)", () => {
  const src = read(PAGE);
  const fnIdx = src.indexOf("function getOpenAction(");
  const fnEnd = src.indexOf("\nasync function ", fnIdx + 1);
  const body = src.slice(fnIdx, fnEnd);
  assert.match(body, /isInTrash/);
  assert.match(body, /row\.badges\.includes\("in_trash"\)/);
  assert.match(body, /\?context=trash/);
});

test("Open action label flips to 'Open in trash' for trash rows (every doc type)", () => {
  const src = read(PAGE);
  const fnIdx = src.indexOf("function getOpenAction(");
  const fnEnd = src.indexOf("\nasync function ", fnIdx + 1);
  const body = src.slice(fnIdx, fnEnd);
  // Pin the literal — used by every documentType branch.
  assert.match(body, /"Open in trash"/);
  // Make sure every existing non-trash label is still reachable.
  for (const lbl of [
    '"Open evidence"',
    '"Open case"',
    '"Open report"',
    '"Open package"',
    '"Open note"',
  ]) {
    assert.ok(body.includes(lbl), `missing fallback label ${lbl}`);
  }
});

test("Result row + Inspector render badges via renderBadgeLabel (no raw enum leak)", () => {
  const src = read(PAGE);
  // Two render sites: the result list row and the Inspector
  // "Signals" section. Both must call renderBadgeLabel.
  const occurrences = [
    ...src.matchAll(/\{renderBadgeLabel\(b\)\}/g),
  ];
  assert.ok(
    occurrences.length >= 2,
    `expected at least 2 renderBadgeLabel call sites, got ${occurrences.length}`,
  );
  // The data-attr must accompany each chip so end-to-end can
  // probe state.
  assert.match(src, /data-search-result-badge=\{b\}/);
  assert.match(src, /data-search-inspector-badge=\{b\}/);
});

test("SearchDiagnostics type declares the new breakdown fields", () => {
  const src = read(PAGE);
  assert.match(src, /activeIncluded: number;/);
  assert.match(src, /archivedIncluded: number;/);
  assert.match(src, /lockedIncluded: number;/);
  assert.match(src, /trashedIncluded: number;/);
  assert.match(src, /destroyedExcluded: number;/);
  assert.match(src, /pendingDestructionExcluded: number;/);
  assert.match(src, /hardDeletedAbsent: number \| null;/);
  // The old `deletedExcluded` is gone.
  assert.ok(
    !/deletedExcluded: number;/.test(src),
    "stale `deletedExcluded` field must be removed from the type",
  );
});

test("Admin chip data-attrs include trashed-included + active-included (and no deleted-excluded)", () => {
  const src = read(PAGE);
  assert.match(src, /data-search-health-active-included=/);
  assert.match(src, /data-search-health-trashed-included=/);
  // Pre-existing attrs that should still be there.
  assert.match(src, /data-search-health-archived-included=/);
  assert.match(src, /data-search-health-locked-included=/);
  assert.match(src, /data-search-health-destroyed-excluded=/);
  assert.match(src, /data-search-health-pending-destruction-excluded=/);
  // The stale attr is gone.
  assert.ok(
    !/data-search-health-deleted-excluded=/.test(src),
    "stale data-search-health-deleted-excluded attribute must be removed",
  );
});

test("Admin tooltip enumerates active / archived / locked / in trash / destroyed / pending destruction / hard-deleted", () => {
  const src = read(PAGE);
  const fnIdx = src.indexOf("function renderAdminChipTooltip(");
  const fnEnd = src.indexOf("\nasync function ", fnIdx + 1);
  const body = src.slice(fnIdx, fnEnd);
  assert.match(body, /active:\s+\$\{b\.activeIncluded\}/);
  assert.match(body, /archived:\s+\$\{b\.archivedIncluded\}/);
  assert.match(body, /locked:\s+\$\{b\.lockedIncluded\}/);
  assert.match(body, /in trash:\s+\$\{b\.trashedIncluded\}/);
  assert.match(body, /destroyed:\s+\$\{b\.destroyedExcluded\}/);
  assert.match(
    body,
    /pending destruction:\s+\$\{b\.pendingDestructionExcluded\}/,
  );
  assert.match(body, /hard-deleted:\s+\(n\/a/);
});

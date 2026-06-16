/**
 * Search-chip visibility — Personal/SMB users see nothing in the
 * healthy / partial / empty-workspace branches; admins see the
 * full per-state breakdown.
 *
 * Pins the audit-mandated user/admin split:
 *
 *   Normal users (isPlatformAdmin === false):
 *     - NO numeric "X records indexed" chip
 *     - NO DB host tooltip
 *     - The chip appears ONLY in the empty_index AND no-results
 *       case, with user-safe copy ("Search is being set up").
 *
 *   Admin users (isPlatformAdmin === true):
 *     - Full chip with health-coloured background
 *     - Numeric breakdown including evidenceIndexable, archived,
 *       locked, deleted/destroyed/pending-destruction counts
 *     - DB tooltip via renderAdminChipTooltip
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

test("Personal/SMB users see nothing in healthy/partial/empty-workspace branches", () => {
  const src = read(PAGE);
  // Search-page-final-cleanup (A) tightened the gate further:
  // even admins don't render the diagnostic chip unless they opt
  // in via `?_debug=search-health`. The collapsed early-return
  // now keys on `supportOptIn` (which depends on both admin AND
  // the URL flag). The user-blocking exception is preserved
  // through the dedicated `userBlocking` branch.
  assert.match(src, /if \(!supportOptIn && !userBlocking\) return null;/);
  assert.match(src, /const userBlocking = effectiveHealth === "empty_index";/);
});

test("Non-admin chip — when shown, carries data-search-health-audience='user' and user-safe copy", () => {
  const src = read(PAGE);
  assert.match(src, /data-search-health-audience="user"/);
  assert.match(src, /Search is being set up\. Try again in a moment\./);
  // The user chip must NOT contain numeric indexed counts in
  // its body. Pin via the slice between the audience attribute
  // and the closing div.
  const userBranchIdx = src.indexOf('data-search-health-audience="user"');
  const closer = src.indexOf("</div>", userBranchIdx);
  const userBranch = src.slice(userBranchIdx, closer);
  assert.ok(
    !/searchHealth\.index\.evidenceIndexed/.test(userBranch),
    "user-audience chip must NOT reference evidenceIndexed",
  );
  assert.ok(
    !/searchHealth\.index\.evidenceTotal/.test(userBranch),
    "user-audience chip must NOT reference evidenceTotal",
  );
});

test("Admin chip — surfaces the full per-state breakdown as data-attrs", () => {
  const src = read(PAGE);
  assert.match(src, /data-search-health-audience="admin"/);
  assert.match(src, /data-search-health-evidence-indexable=/);
  assert.match(src, /data-search-health-active-included=/);
  assert.match(src, /data-search-health-archived-included=/);
  assert.match(src, /data-search-health-locked-included=/);
  // Search-inclusion-audit (trash decision) — replaced
  // `data-…-deleted-excluded` with `data-…-trashed-included`
  // because soft-deleted records are now INCLUDED in the index.
  assert.match(src, /data-search-health-trashed-included=/);
  assert.match(src, /data-search-health-destroyed-excluded=/);
  assert.match(src, /data-search-health-pending-destruction-excluded=/);
});

test("Admin tooltip helper exists and consumes the breakdown envelope", () => {
  const src = read(PAGE);
  assert.match(src, /function renderAdminChipTooltip\(/);
  // The tooltip body names every breakdown axis so an operator
  // sees the deltas at a glance. Updated per the trash decision:
  // soft-deleted records are now `in trash` (an INCLUDED bucket),
  // not `deleted` (an EXCLUDED one).
  const fnIdx = src.indexOf("function renderAdminChipTooltip(");
  const fnEnd = src.indexOf("\nasync function ", fnIdx + 1);
  const body = src.slice(fnIdx, fnEnd);
  assert.match(body, /Indexable evidence/);
  assert.match(body, /active:/);
  assert.match(body, /archived:/);
  assert.match(body, /locked:/);
  assert.match(body, /in trash:/);
  assert.match(body, /Excluded by indexer/);
  assert.match(body, /destroyed:/);
  assert.match(body, /pending destruction:/);
  assert.match(body, /hard-deleted:/);
});

test("Non-admin diagnostics-error path — searchHealthError chip ONLY renders for admins", () => {
  const src = read(PAGE);
  // The fallback "Search index status unavailable" chip should
  // not interrupt a normal user's flow (the search would either
  // work or land in the error empty-state). Pin the gate.
  // Search-page-final-cleanup (A) tightened this further: even
  // admins don't see the fallback chip unless they explicitly
  // opt in with `?_debug=search-health`. Pin all three halves.
  assert.match(
    src,
    /searchHealthError &&\s*\n?\s*isPlatformAdmin &&\s*\n?\s*searchHealthDebugOptIn/,
  );
});

test("SearchDiagnostics type declares the optional breakdown envelope", () => {
  const src = read(PAGE);
  assert.match(src, /breakdown\?: \{/);
  assert.match(src, /evidenceIndexable: number;/);
  assert.match(src, /activeIncluded: number;/);
  assert.match(src, /archivedIncluded: number;/);
  assert.match(src, /lockedIncluded: number;/);
  // Search-inclusion-audit (trash decision) — `trashedIncluded`
  // replaces the stale `deletedExcluded`. Pin both.
  assert.match(src, /trashedIncluded: number;/);
  assert.match(src, /destroyedExcluded: number;/);
  assert.match(src, /pendingDestructionExcluded: number;/);
  assert.match(src, /hardDeletedAbsent: number \| null;/);
});

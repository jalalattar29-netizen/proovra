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

test("the diagnostics chip is support-only in EVERY state", () => {
  const src = read(PAGE);
  // PREVIOUS GUARANTEE: non-admins saw no numeric chip except the
  // user-blocking 'empty_index' one.
  //
  // REPLACEMENT, stronger: there is no user-facing chip left at all. The
  // one exception was the sentence that rendered in the header beside a
  // pristine panel; readiness owns that message and its region now, so the
  // header chip is unconditionally behind the support opt-in.
  assert.match(src, /const supportOptIn = isPlatformAdmin && searchHealthDebugOptIn;/);
  assert.match(src, /if \(!supportOptIn\) return null;/);
  assert.doesNotMatch(src, /userBlocking/);
  assert.doesNotMatch(src, /data-search-health-audience="user"/);
});

test("a non-admin is told the truth about readiness, without index internals", () => {
  const src = read(PAGE);
  // PREVIOUS GUARANTEE: when the user-facing chip appeared it carried
  // user-safe copy and no evidenceIndexed / evidenceTotal numbers.
  //
  // REPLACEMENT: the chip is gone, and the readiness surface that replaced
  // it is projected by the server for every actor. The honesty property is
  // preserved where it now lives — the counts a user sees are the eligible
  // population the SERVER computed for them, not raw index internals.
  assert.match(src, /indexedCount=\{readiness\.indexedCount\}/);
  assert.match(src, /eligibleCount=\{readiness\.eligibleCount\}/);
  // The raw diagnostics fields stay out of the user-facing surface.
  const noticeIdx = src.indexOf("<SearchReadinessNotice");
  const notice = src.slice(noticeIdx, src.indexOf("/>", noticeIdx));
  assert.doesNotMatch(notice, /searchHealth\.index\./);
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

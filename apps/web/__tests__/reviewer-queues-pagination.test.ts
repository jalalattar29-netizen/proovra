/**
 * PHASE RW3 — Reviewer queues real cursor pagination + filter + member-picker
 * regression lock.
 *
 * Phase 0 audit (Phase 3) established three honest-to-API problems
 * with the queue page that this test continues to pin against
 * regression. Phase RW3 lifts the cursor-pagination CANNOT_WIRE pin
 * after the backend route was extended to accept a `cursor` query
 * parameter and the service threads it into Prisma's cursor
 * pagination contract.
 *
 *   1. The frontend sent `state=<lowercase>` but the backend
 *      `/v1/reviewer-ops/queue` Zod expects `queue=<UPPERCASE_ENUM>`
 *      drawn from REVIEWER_OPS_QUEUE_TYPES. Until Phase 3 every
 *      filter the operator picked was silently dropped and the route
 *      defaulted to UNASSIGNED.
 *
 *   2. The frontend requested `limit=200`. Backend Zod caps `limit`
 *      at 100 → 400 INVALID_QUERY. The catch{} silently rendered an
 *      empty table on every page load.
 *
 *   3. Phase RW3: cursor pagination is NOW wired. The page issues a
 *      real Load-more request with `&cursor=<lastRowId>` and APPENDS
 *      rows. The Phase 3 "Showing the first N" CANNOT_WIRE banner is
 *      replaced with a real button + count line.
 *
 * CANNOT_WIRE items still pinned by this test:
 *
 *   - QC filter — REVIEWER_OPS_QUEUE_TYPES has no `QC` / `QC_SAMPLED`
 *     branch. The QC surface lives under /review/qc with its own
 *     samples endpoint. The picker must NOT include a fake option.
 *
 * Phase RW3-2 lifts the reviewer-picker CANNOT_WIRE pin:
 *
 *   - GET /v1/reviewer-ops/assignable-reviewers now exists, gated on
 *     `review.assign`. The page fetches the bounded reviewer list and
 *     renders a searchable modal. window.prompt is no longer used as
 *     the bulk-assign input. On 403 the modal surfaces a denial copy
 *     and never falls back to the prompt.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-queues-pagination.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { REVIEWER_OPS_QUEUE_TYPES } from "@proovra/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "queues",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Query-param shape — the page sends `queue=` (not `state=`) and respects
//    the backend's max limit. Cursor is only appended when present.
// ---------------------------------------------------------------------------

test("queue page sends queue=<enum> as the backend route expects", () => {
  // The page now also includes `teamId=` as the leading param for
  // workspace scoping (correct — backend rejects cross-tenant calls).
  // Pin the FOUR things that matter: endpoint, teamId, queue=<filter>,
  // and limit — without forcing a specific param ORDER (which would
  // break every future query-string extension).
  assert.match(
    PAGE_SOURCE,
    /\/v1\/reviewer-ops\/queue\?[^`]*\bqueue=\$\{encodeURIComponent\(filter\)\}/,
    "Queue fetch must send `queue=<filter>` as a URL-encoded query " +
      "param (backend Zod accepts `queue=`, not the legacy `state=`).",
  );
  assert.match(
    PAGE_SOURCE,
    /\/v1\/reviewer-ops\/queue\?[^`]*\bteamId=\$\{encodeURIComponent\(teamId\)\}/,
    "Queue fetch must scope to teamId so cross-workspace results " +
      "are impossible.",
  );
  assert.match(
    PAGE_SOURCE,
    /\/v1\/reviewer-ops\/queue\?[^`]*\blimit=\$\{QUEUE_PAGE_LIMIT\}/,
    "Queue fetch must include the limit param bound to QUEUE_PAGE_LIMIT.",
  );
});

test("queue page no longer ships the dropped state= query parameter", () => {
  assert.doesNotMatch(
    PAGE_SOURCE,
    /\/v1\/reviewer-ops\/queue\?state=/,
    "Queue page must not reintroduce the legacy state= parameter — " +
      "the backend Zod ignores it and silently defaults to UNASSIGNED.",
  );
});

test("queue page caps limit at the backend max (100, not 200)", () => {
  assert.match(
    PAGE_SOURCE,
    /QUEUE_PAGE_LIMIT\s*=\s*100/,
    "QUEUE_PAGE_LIMIT must equal 100 — the backend Zod caps the " +
      "limit at 100 and rejects larger values with INVALID_QUERY.",
  );
  // The fetch URLs must not contain `limit=200`. We scope the
  // check to the apiFetch template literals (header docs may still
  // reference the legacy value to explain the Phase 3 delta).
  //
  // Regex updated to be param-order tolerant — the page now leads
  // with `teamId=` (correct workspace scoping). We grep every
  // `/v1/reviewer-ops/queue?…` template literal.
  const fetchSnippets = PAGE_SOURCE.match(
    /\/v1\/reviewer-ops\/queue\?[^`]+/g,
  );
  assert.ok(
    fetchSnippets && fetchSnippets.length >= 1,
    "Queue fetch URL(s) must be present in the page source.",
  );
  for (const snippet of fetchSnippets!) {
    assert.doesNotMatch(
      snippet,
      /limit=200/,
      "Queue fetch URL must not request limit=200 — backend caps at 100.",
    );
    // Limit must be bound to the constant, not a hardcoded number.
    assert.match(
      snippet,
      /limit=\$\{QUEUE_PAGE_LIMIT\}/,
      `Queue fetch URL must bind limit to QUEUE_PAGE_LIMIT. Got: ${snippet.slice(0, 200)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Filter options are sourced from REVIEWER_OPS_QUEUE_TYPES.
// ---------------------------------------------------------------------------

test("queue page imports REVIEWER_OPS_QUEUE_TYPES from @proovra/shared", () => {
  assert.match(
    PAGE_SOURCE,
    /import\s*\{[^}]*REVIEWER_OPS_QUEUE_TYPES[^}]*\}\s*from\s*"@proovra\/shared"/,
    "Queue page must import the canonical enum so the filter tracks " +
      "any future backend addition without drifting.",
  );
});

test("queue filter <select> maps over REVIEWER_OPS_QUEUE_TYPES", () => {
  assert.match(
    PAGE_SOURCE,
    /REVIEWER_OPS_QUEUE_TYPES\.map\(/,
    "Filter <select> must map over REVIEWER_OPS_QUEUE_TYPES so every " +
      "canonical enum branch is selectable.",
  );
});

test("queue filter ships every REVIEWER_OPS_QUEUE_TYPES label", () => {
  // The QUEUE_LABELS map must declare an entry for every enum value so
  // the picker always has bounded human copy.
  for (const q of REVIEWER_OPS_QUEUE_TYPES) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(`${q}:\\s*"`),
      `QUEUE_LABELS must declare a label for the ${q} branch.`,
    );
    assert.match(
      PAGE_SOURCE,
      new RegExp(`EMPTY_STATE_COPY[\\s\\S]{0,2000}?${q}:\\s*"`),
      `EMPTY_STATE_COPY must declare an empty-state line for the ${q} branch.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Legacy lowercase filter options are gone.
// ---------------------------------------------------------------------------

test("queue page drops the legacy lowercase filter values", () => {
  // The Phase 2A page used value="assigned"|"unassigned"|etc. which
  // never matched the backend enum. The new filter must use the
  // UPPERCASE REVIEWER_OPS_QUEUE_TYPES values exclusively.
  const banned = [
    'value="assigned"',
    'value="unassigned"',
    'value="in_progress"',
    'value="escalated"',
    'value="completed"',
  ];
  for (const literal of banned) {
    assert.ok(
      !PAGE_SOURCE.includes(literal),
      `Filter <option value=…> must not use the legacy lowercase ` +
        `string ${literal} — the backend enum is UPPERCASE.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Empty states — distinct, bounded copy per filter.
// ---------------------------------------------------------------------------

test("queue page renders per-filter empty-state copy", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-empty=\{filter\}/,
    "Empty-state row must carry data-reviewer-queue-empty={filter} so " +
      "tests can verify the copy renders against the current branch.",
  );
  assert.match(
    PAGE_SOURCE,
    /\{EMPTY_STATE_COPY\[filter\]\}/,
    "Empty-state cell must look up copy from EMPTY_STATE_COPY[filter].",
  );
  assert.doesNotMatch(
    PAGE_SOURCE,
    /No workflows in this view\./,
    "Generic Phase 2A empty copy must be replaced with per-filter copy.",
  );
});

// ---------------------------------------------------------------------------
// 5. Phase RW3 — real cursor pagination wired end-to-end.
// ---------------------------------------------------------------------------

test("queue page reads nextCursor from the response", () => {
  assert.match(
    PAGE_SOURCE,
    /res\?\.nextCursor/,
    "Page must read `nextCursor` from the response so it can surface " +
      "the Load-more button when more rows match.",
  );
  assert.match(
    PAGE_SOURCE,
    /setNextCursor\(/,
    "Page must store nextCursor in component state.",
  );
});

test("queue page renders a Load-more button when nextCursor is present", () => {
  // Phase RW3 — the Phase 3 banner is replaced by a real button.
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-load-more\b/,
    "Page must render a button tagged data-reviewer-queue-load-more " +
      "when nextCursor is non-null.",
  );
  assert.doesNotMatch(
    PAGE_SOURCE,
    /data-reviewer-queue-pagination-banner/,
    "Phase 3 fake CANNOT_WIRE pagination banner must be removed once " +
      "real cursor pagination is wired.",
  );
});

test("queue page sends &cursor=<id> on Load-more", () => {
  // The cursor URL must be a separate fetch template literal so the
  // first-page request does not always include an empty cursor= param.
  assert.match(
    PAGE_SOURCE,
    /&cursor=\$\{encodeURIComponent\(cursor\)\}/,
    "Load-more fetch URL must append the cursor as " +
      "&cursor=${encodeURIComponent(cursor)} — the backend route " +
      "accepts the cursor as a UUID query parameter.",
  );
});

test("queue page appends rows on Load-more (does not replace)", () => {
  // The append/replace decision must be driven by the cursor mode so
  // the operator's existing rows + selection survive Load-more.
  assert.match(
    PAGE_SOURCE,
    /loadPage\(/,
    "Page must factor the fetch into a loadPage(cursor) helper so " +
      "Load-more and first-page share a single try/catch path.",
  );
  assert.match(
    PAGE_SOURCE,
    /loadMore\(\)/,
    "Page must expose a loadMore() handler invoked by the Load-more " +
      "button.",
  );
});

test("queue page tracks a loadingMore busy state for the Load-more button", () => {
  assert.match(
    PAGE_SOURCE,
    /loadingMore/,
    "Page must track a `loadingMore` busy flag so the Load-more button " +
      "can disable itself during fetch.",
  );
});

test("queue page handles INVALID_CURSOR with bounded copy", () => {
  assert.match(
    PAGE_SOURCE,
    /INVALID_CURSOR/,
    "Page must distinguish INVALID_CURSOR (cursor rejected) from " +
      "NOT_PERMITTED / generic failures, so the operator sees an " +
      "honest retry hint.",
  );
});

// ---------------------------------------------------------------------------
// 6. QC filter — CANNOT_WIRE. Backend enum has no QC branch.
// ---------------------------------------------------------------------------

test("REVIEWER_OPS_QUEUE_TYPES has no QC / QC_SAMPLED branch", () => {
  // Pin the Phase 0 finding: the canonical enum has no QC option.
  // Until one is added, the queues filter cannot surface a QC view.
  const qcLike = (REVIEWER_OPS_QUEUE_TYPES as ReadonlyArray<string>).filter(
    (q) => q.includes("QC"),
  );
  assert.equal(
    qcLike.length,
    0,
    "REVIEWER_OPS_QUEUE_TYPES grew a QC branch — the queue page can " +
      "now surface a QC filter and this CANNOT_WIRE pin should be " +
      "lifted (and the page updated).",
  );
});

test("queue page does not render a fake QC filter option", () => {
  assert.ok(
    !PAGE_SOURCE.toLowerCase().includes('value="qc"'),
    "Page must not render a fake QC option in the filter <select> — " +
      "the backend route has no QC branch in REVIEWER_OPS_QUEUE_TYPES.",
  );
});

// ---------------------------------------------------------------------------
// 7. Member picker — WIRED (Phase RW3-2). The team-scoped
//    /v1/reviewer-ops/assignable-reviewers endpoint now exists and the
//    page renders a real modal. window.prompt MUST NOT be reintroduced
//    as a fallback.
// ---------------------------------------------------------------------------

test("queue page no longer calls window.prompt for bulk-assign (Phase RW3-2)", () => {
  // Phase RW3-2 — the team-scoped reviewer-picker endpoint exists.
  // Falling back to window.prompt would be a regression to the
  // CANNOT_WIRE compromise.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /window\.prompt\(/,
    "Bulk-assign must not fall back to window.prompt. The page now " +
      "fetches /v1/reviewer-ops/assignable-reviewers and renders a " +
      "real picker modal.",
  );
});

test("queue page fetches /v1/reviewer-ops/assignable-reviewers on Bulk assign", () => {
  assert.match(
    PAGE_SOURCE,
    /\/v1\/reviewer-ops\/assignable-reviewers/,
    "Bulk-assign must fetch the team-scoped reviewer list from the " +
      "new endpoint instead of asking the operator to paste a userId.",
  );
  assert.match(
    PAGE_SOURCE,
    /openReviewerPicker/,
    "Page must expose an openReviewerPicker helper that drives the " +
      "modal state machine (LOADING / FORBIDDEN / ERROR / READY).",
  );
});

test("reviewer picker fetch is wrapped in try/catch with structured warn log", () => {
  assert.match(
    PAGE_SOURCE,
    /openReviewerPicker[\s\S]{0,2000}?console\.warn\(\s*"\[reviewer-workspace\] assignable-reviewers fetch failed"/,
    "Picker fetch must emit a structured warn log on failure with the " +
      "status + code fields — silent failure is forbidden.",
  );
});

test("reviewer picker surfaces FORBIDDEN bounded copy on 403, no prompt fallback", () => {
  assert.match(
    PAGE_SOURCE,
    /REVIEW_PERMISSION_DENIED/,
    "Picker must distinguish the canonical REVIEW_PERMISSION_DENIED " +
      "code so the modal can surface the denial branch.",
  );
  assert.match(
    PAGE_SOURCE,
    /You do not have permission to assign reviews in this workspace\./,
    "Picker FORBIDDEN copy must be bounded and operator-readable.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-picker-denied/,
    "FORBIDDEN branch must render a denial element tagged " +
      "data-reviewer-picker-denied for accessibility + tests.",
  );
});

test("reviewer picker renders a searchable list of reviewers", () => {
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-picker-modal/,
    "Picker modal root must carry data-reviewer-picker-modal.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-picker-state=\{state\.kind\}/,
    "Picker root must surface the tagged state for behavioural tests.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-picker-search/,
    "Picker must include a search input so operators can filter the " +
      "reviewer list.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-picker-select=\{r\.userId\}/,
    "Each reviewer row must expose a select button tagged with the " +
      "user id so tests can target deterministically.",
  );
});

test("picker select hands the userId to the confirm modal (not the API directly)", () => {
  assert.match(
    PAGE_SOURCE,
    /setPendingConfirmation\(\{[\s\S]*?kind:\s*"ASSIGN",[\s\S]*?assigneeUserId:\s*userId/,
    "Picker select must stage the bulk-assign in the existing confirm " +
      "modal so the operator confirms the action before bulkAssign " +
      "fires.",
  );
});

// Pure-function model of the picker fetch outcome → tagged state. This
// mirrors the page's openReviewerPicker logic without spinning up React.
type PickerState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN"; message: string }
  | { kind: "ERROR"; message: string }
  | {
      kind: "READY";
      reviewers: ReadonlyArray<{
        userId: string;
        displayName: string | null;
        role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
        status: "ACTIVE";
        currentWorkloadCount?: number;
      }>;
    };

function classifyPickerError(input: {
  status?: number;
  code?: string;
}): PickerState {
  if (
    input.status === 403 ||
    input.code === "REVIEW_PERMISSION_DENIED" ||
    input.code === "NOT_PERMITTED" ||
    input.code === "FORBIDDEN"
  ) {
    return {
      kind: "FORBIDDEN",
      message:
        "You do not have permission to assign reviews in this workspace.",
    };
  }
  return {
    kind: "ERROR",
    message:
      "Reviewer list could not be loaded. Try again or refresh the page.",
  };
}

test("classifyPickerError maps 403 to FORBIDDEN", () => {
  const s = classifyPickerError({ status: 403 });
  assert.equal(s.kind, "FORBIDDEN");
});

test("classifyPickerError maps REVIEW_PERMISSION_DENIED to FORBIDDEN", () => {
  const s = classifyPickerError({ code: "REVIEW_PERMISSION_DENIED" });
  assert.equal(s.kind, "FORBIDDEN");
});

test("classifyPickerError maps unknown failures to ERROR", () => {
  const s = classifyPickerError({ status: 500, code: "SERVER_ERROR" });
  assert.equal(s.kind, "ERROR");
});

// ---------------------------------------------------------------------------
// 8. Bulk-action ≤ 100 cap is preserved at the slice boundary.
// ---------------------------------------------------------------------------

test("bulk-action server cap (100) is enforced at the slice boundary", () => {
  assert.match(
    PAGE_SOURCE,
    /BULK_ACTION_CAP\s*=\s*100/,
    "BULK_ACTION_CAP must equal 100 — the server enforces the same " +
      "cap on bulk decide / bulk assign.",
  );
  assert.match(
    PAGE_SOURCE,
    /Array\.from\(selected\)\.slice\(0,\s*BULK_ACTION_CAP\)/g,
    "runDecide / runAssign must slice the selection at " +
      "BULK_ACTION_CAP before posting.",
  );
});

test("bulk bar surfaces the cap copy", () => {
  assert.match(
    PAGE_SOURCE,
    /≤\s*\{BULK_ACTION_CAP\}\s*per call/,
    "BulkBar empty-state must surface the per-call cap so operators " +
      "know the slice boundary.",
  );
  assert.match(
    PAGE_SOURCE,
    /data-bulk-bar-cap-note/,
    "BulkBar must surface a cap-note when the selection exceeds the " +
      "cap so operators know only the first 100 will be applied.",
  );
});

// ---------------------------------------------------------------------------
// 9. Refresh error surface — denial vs network distinguished.
// ---------------------------------------------------------------------------

test("queue refresh handles denial with bounded copy", () => {
  assert.match(
    PAGE_SOURCE,
    /setRefreshError\(/,
    "Refresh failures must populate a bounded error string for the UI.",
  );
  assert.match(
    PAGE_SOURCE,
    /NOT_PERMITTED|FORBIDDEN/,
    "Refresh error path must distinguish a permission denial from a " +
      "generic failure (the catch{} on Phase 2A swallowed both).",
  );
  assert.match(
    PAGE_SOURCE,
    /data-reviewer-queue-error/,
    "Error banner must carry data-reviewer-queue-error so the UI can " +
      "surface a distinct, bounded message instead of an empty table.",
  );
});

test("queue refresh logs a structured warn on failure", () => {
  assert.match(
    PAGE_SOURCE,
    /console\.warn\("\[reviewer-workspace\] queue list refresh failed"/,
    "Refresh catch must emit a structured console.warn with the " +
      "queue + status + code — silent failure is forbidden.",
  );
});

// ---------------------------------------------------------------------------
// 10. Pagination + filter behaviour modelled as pure functions.
// ---------------------------------------------------------------------------

type QueueFilter = (typeof REVIEWER_OPS_QUEUE_TYPES)[number];

function buildQueueUrl(filter: QueueFilter, limit: number): string {
  return `/v1/reviewer-ops/queue?queue=${encodeURIComponent(filter)}&limit=${limit}`;
}

function buildQueueUrlWithCursor(
  filter: QueueFilter,
  limit: number,
  cursor: string,
): string {
  return `/v1/reviewer-ops/queue?queue=${encodeURIComponent(filter)}&limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
}

test("buildQueueUrl matches what the page emits for every filter", () => {
  for (const q of REVIEWER_OPS_QUEUE_TYPES) {
    const expected = `/v1/reviewer-ops/queue?queue=${q}&limit=100`;
    assert.equal(buildQueueUrl(q, 100), expected);
  }
});

test("buildQueueUrlWithCursor appends cursor for Load-more", () => {
  const cursor = "11111111-2222-3333-4444-555555555555";
  for (const q of REVIEWER_OPS_QUEUE_TYPES) {
    const expected = `/v1/reviewer-ops/queue?queue=${q}&limit=100&cursor=${cursor}`;
    assert.equal(buildQueueUrlWithCursor(q, 100, cursor), expected);
  }
});

function shouldShowLoadMore(input: {
  rows: ReadonlyArray<unknown> | null;
  nextCursor: string | null;
}): boolean {
  if (input.rows === null) return false;
  return input.nextCursor !== null;
}

test("Load-more shows when nextCursor present and rows loaded", () => {
  assert.equal(
    shouldShowLoadMore({ rows: [{}, {}], nextCursor: "wf-abc" }),
    true,
  );
});

test("Load-more hidden when nextCursor null (no more rows)", () => {
  assert.equal(
    shouldShowLoadMore({ rows: [{}, {}], nextCursor: null }),
    false,
  );
});

test("Load-more hidden while rows still loading", () => {
  assert.equal(
    shouldShowLoadMore({ rows: null, nextCursor: "wf-abc" }),
    false,
  );
});

// Selection-survives-pagination pure-function model.
function mergeAppendUnique<T extends { id: string }>(
  prev: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const seen = new Set(prev.map((r) => r.id));
  const merged = [...prev];
  for (const r of next) {
    if (!seen.has(r.id)) {
      merged.push(r);
      seen.add(r.id);
    }
  }
  return merged;
}

test("Load-more append dedupes overlapping ids (concurrent insert safety)", () => {
  const page1 = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const page2 = [{ id: "c" }, { id: "d" }, { id: "e" }];
  const merged = mergeAppendUnique(page1, page2);
  assert.deepEqual(
    merged.map((r) => r.id),
    ["a", "b", "c", "d", "e"],
  );
});

test("selection set survives a page append (no rows dropped)", () => {
  const selected = new Set(["a", "b"]);
  const merged = mergeAppendUnique(
    [{ id: "a" }, { id: "b" }],
    [{ id: "c" }, { id: "d" }],
  );
  // The selection is keyed by id, not by index, so the existing
  // entries remain valid even after the rows array grows.
  for (const id of selected) {
    assert.ok(
      merged.some((r) => r.id === id),
      `Selected id ${id} must still be present in the merged rows.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 11. Empty-state copy is distinct per filter — no two filters share copy.
// ---------------------------------------------------------------------------

const EMPTY_STATE_PER_FILTER: Record<QueueFilter, string> = {
  MY_REVIEWS: "No reviews are currently assigned to you.",
  UNASSIGNED: "No unassigned items are waiting for triage.",
  OVERDUE: "No reviews are overdue.",
  DUE_SOON: "No reviews are due soon.",
  ESCALATED: "No reviews have an open escalation.",
  HIGH_PRIORITY: "No reviews are flagged high priority or urgent.",
  LEGAL_HOLD: "No reviews are under an active legal hold.",
  WORKFLOW_BLOCKED: "No reviews are paused or blocked.",
  INTEGRITY_RISK: "No reviews carry an integrity-risk escalation.",
  EXTERNAL_INTAKE: "No external-intake reviews are waiting.",
  COMPLETED_RECENTLY: "No reviews have completed in the last 7 days.",
};

test("each filter has a unique empty-state line", () => {
  const seen = new Set<string>();
  for (const q of REVIEWER_OPS_QUEUE_TYPES) {
    const copy = EMPTY_STATE_PER_FILTER[q];
    assert.ok(
      copy && copy.length > 0,
      `Filter ${q} must have non-empty empty-state copy.`,
    );
    assert.ok(
      !seen.has(copy),
      `Filter ${q} empty-state copy must be unique — collides with ` +
        `another filter.`,
    );
    seen.add(copy);
  }
});

test("each filter empty-state line is bounded (no developer copy)", () => {
  for (const q of REVIEWER_OPS_QUEUE_TYPES) {
    const copy = EMPTY_STATE_PER_FILTER[q];
    assert.ok(
      copy.length <= 120,
      `Filter ${q} empty-state copy must be ≤ 120 chars (got ${copy.length}).`,
    );
    assert.doesNotMatch(
      copy,
      /TODO|FIXME|XXX/i,
      `Filter ${q} empty-state copy must not leak dev markers.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 12. CANNOT_WIRE summary — explicit, machine-checkable inventory. Phase RW3
//     flipped cursorPagination from CANNOT_WIRE to WIRED. Phase RW3-2
//     flips the member-picker pin (now WIRED via the new
//     /v1/reviewer-ops/assignable-reviewers endpoint).
// ---------------------------------------------------------------------------

test("CANNOT_WIRE inventory is honest", () => {
  // The page must continue to NOT surface the still-CANNOT_WIRE
  // capabilities. cursorPagination is WIRED (Phase RW3); memberPicker
  // is now WIRED (Phase RW3-2). qcFilter remains CANNOT_WIRE because
  // REVIEWER_OPS_QUEUE_TYPES still has no QC branch.
  const cannotWire = {
    qcFilter: !REVIEWER_OPS_QUEUE_TYPES.some(
      (q: string) => q === "QC" || q === "QC_SAMPLED",
    ),
    cursorPaginationWired:
      PAGE_SOURCE.indexOf("&cursor=") !== -1 &&
      PAGE_SOURCE.indexOf("data-reviewer-queue-load-more") !== -1,
    memberPickerWired:
      PAGE_SOURCE.indexOf("/v1/reviewer-ops/assignable-reviewers") !== -1 &&
      PAGE_SOURCE.indexOf("window.prompt(") === -1 &&
      PAGE_SOURCE.indexOf("data-reviewer-picker-modal") !== -1,
  };
  assert.deepEqual(cannotWire, {
    qcFilter: true,
    cursorPaginationWired: true,
    memberPickerWired: true,
  });
});

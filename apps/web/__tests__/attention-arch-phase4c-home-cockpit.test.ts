/**
 * ATTENTION ARCHITECTURE — PHASE 4C (2026-08-22).
 * HOME BECOMES A COCKPIT.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS REMOVED
 * ---------------------------------------------------------------------------
 *     Home  ->  GET /v1/me/inbox  ->  buildOperationalQueue()  ->  health
 *
 * That chain read ONE PERSON'S NOTIFICATION FEED and reported the result as
 * the WORKSPACE'S operational state. Consequences, all of them live before
 * this phase:
 *
 *   * archiving a notification lowered the workspace's issue count
 *   * deferring one hid a workspace problem until tomorrow
 *   * two admins on one workspace saw two different healths
 *
 * and in none of those cases had the underlying work changed.
 *
 * ---------------------------------------------------------------------------
 * THE GATE
 * ---------------------------------------------------------------------------
 * The required proof for this phase is:
 *
 *     User A archives a notification -> Home's workspace Operations count
 *                                       is UNCHANGED.
 *
 * It is the last test in this file, and it is executed against the real
 * view-model normalizer rather than asserted about it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeHomeViewModel,
  type NormalizeInputs,
} from "../components/home-experience/home-view-model";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(resolve(APP_ROOT, rel), "utf8");

const VIEW_MODEL_SRC = readSrc("components/home-experience/home-view-model.ts");
const USE_HOME_DATA_SRC = readSrc("components/home-experience/useHomeData.ts");
const SECTIONS_SRC = readSrc("components/home-experience/HomeDashboardSections.tsx");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/** Minimal inputs; every optional source absent unless a test supplies it. */
function inputs(overrides: Partial<NormalizeInputs> = {}): NormalizeInputs {
  return {
    plan: "PRO",
    planFeatures: null,
    workspaceId: WORKSPACE_ID,
    workspaceName: "Workspace",
    activeSpaceType: "ORGANIZATION",
    commandCenter: null,
    trustSummary: null,
    billing: null,
    reports: null,
    intakeLinks: null,
    inbox: null,
    communications: null,
    orgs: [],
    ...overrides,
  } as NormalizeInputs;
}

/** A notification feed carrying two integrity failures addressed to the user. */
function feedWithFailures(archived: boolean) {
  return {
    items: [
      {
        id: "tsa_failure:evidence-aaaa",
        itemKey: "tsa_failure:evidence-aaaa",
        category: "tsa_failure",
        tone: "critical",
        priority: "P1",
        title: "Timestamp failed",
        body: "b",
        href: "/evidence/evidence-aaaa",
        occurredAt: "2026-08-22T10:00:00.000Z",
        isRead: archived,
        dismissedAt: archived ? "2026-08-22T11:00:00.000Z" : null,
        snoozedUntil: null,
        canMarkRead: true,
        canDismiss: true,
        canSnooze: true,
        context: { teamId: WORKSPACE_ID },
      },
      {
        id: "ots_failure:evidence-bbbb",
        itemKey: "ots_failure:evidence-bbbb",
        category: "ots_failure",
        tone: "critical",
        priority: "P1",
        title: "Anchor failed",
        body: "b",
        href: "/evidence/evidence-bbbb",
        occurredAt: "2026-08-22T10:00:00.000Z",
        isRead: archived,
        dismissedAt: archived ? "2026-08-22T11:00:00.000Z" : null,
        snoozedUntil: null,
        canMarkRead: true,
        canDismiss: true,
        canSnooze: true,
        context: { teamId: WORKSPACE_ID },
      },
    ],
  } as unknown as NormalizeInputs["inbox"];
}

/** The canonical workspace summary, as GET /v1/ops/summary returns it. */
const SHARED_SUMMARY = {
  open: 7,
  critical: 2,
  high: 3,
  warning: 2,
  overdue: 1,
  assignedToMe: 1,
  mayAssertAllClear: true,
};

// ============================================================================
// 4C.1 — the personal-feed-derived health path is gone
// ============================================================================

test("buildOperationalQueue no longer exists", () => {
  assert.ok(
    !/function buildOperationalQueue\(/.test(VIEW_MODEL_SRC),
    "buildOperationalQueue must be deleted, not merely unused",
  );
  // And the tombstone records why, so it is not reintroduced by someone who
  // only sees a missing helper.
  assert.match(VIEW_MODEL_SRC, /`buildOperationalQueue\(\)` IS GONE/);
});

test("the view model exposes a CONSUMED summary, not a computed queue", () => {
  const vm = normalizeHomeViewModel(inputs());
  assert.equal(
    (vm as unknown as Record<string, unknown>).operationalQueue,
    undefined,
  );
  assert.ok(vm.operations, "Home receives an Operations summary");
});

test("workspace health does not count items found in a personal feed", () => {
  // `integrityIssues` used to be `trust.needingAttention + needsFixing.length`,
  // and `needsFixing` was built from the caller's own inbox.
  // Assert over CODE. The tombstone comment quotes the old expression
  // verbatim so a reader knows what was removed, and a naive whole-file
  // search would match the explanation instead of the thing.
  const code = VIEW_MODEL_SRC.split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  assert.ok(
    !/needingAttention \+ args\.needsFixing\.length/.test(code),
    "workspace health must not add notification-feed items to a shared metric",
  );
  assert.match(
    VIEW_MODEL_SRC,
    /const integrityIssues = args\.trust\.needingAttention;/,
  );
});

// ============================================================================
// 4C.2 — one canonical summary, consumed
// ============================================================================

test("Home fetches the canonical workspace Operations summary", () => {
  assert.match(USE_HOME_DATA_SRC, /\/v1\/ops\/summary\?teamId=/);
  assert.match(USE_HOME_DATA_SRC, /operationsSummary,/);
});

test("Home projects the summary verbatim and adds nothing", () => {
  const vm = normalizeHomeViewModel(
    inputs({ operationsSummary: SHARED_SUMMARY } as Partial<NormalizeInputs>),
  );
  assert.equal(vm.operations.available, true);
  assert.equal(vm.operations.open, 7);
  assert.equal(vm.operations.critical, 2);
  assert.equal(vm.operations.high, 3);
  assert.equal(vm.operations.overdue, 1);
  assert.equal(vm.operations.assignedToMe, 1);
  assert.equal(vm.operations.mayAssertAllClear, true);
});

test("Home LINKS to Operations and never becomes a second work queue", () => {
  const vm = normalizeHomeViewModel(
    inputs({ operationsSummary: SHARED_SUMMARY } as Partial<NormalizeInputs>),
  );
  assert.equal(vm.operations.href, "/operations");
  // 4C.4 — no operational mutation on the summary Home holds. It carries
  // counts and a link, and nothing that could acknowledge, resolve, assign or
  // suppress anything.
  for (const forbidden of [
    "acknowledge",
    "resolve",
    "suppress",
    "assign",
    "retry",
  ]) {
    assert.ok(
      !(forbidden in (vm.operations as unknown as Record<string, unknown>)),
      `Home's Operations summary must carry no ${forbidden} action`,
    );
  }
});

// ============================================================================
// 4C.3 — failure behaviour
// ============================================================================

test("an unavailable summary is UNAVAILABLE, not zero", () => {
  const vm = normalizeHomeViewModel(inputs({ operationsSummary: null }));
  assert.equal(vm.operations.available, false);
  assert.equal(
    vm.operations.mayAssertAllClear,
    false,
    "an unreadable workspace is not a healthy one",
  );
});

test("an unavailable summary does NOT fall back to the notification feed", () => {
  // The failure mode this rules out: Home quietly re-deriving health from
  // /v1/me/inbox when /v1/ops/summary fails, which would restore the exact
  // coupling this phase removed — and only under failure, where nobody looks.
  const withFeed = normalizeHomeViewModel(
    inputs({ inbox: feedWithFailures(false), operationsSummary: null }),
  );
  assert.equal(withFeed.operations.available, false);
  assert.equal(
    withFeed.operations.open,
    0,
    "a rich notification feed must not populate the workspace summary",
  );
  assert.equal(withFeed.operations.critical, 0);
});

test("the priorities card may not print 'All clear' over an unknown read", () => {
  assert.match(SECTIONS_SRC, /const mayAssertAllClear = operations/);
  assert.match(SECTIONS_SRC, /data-priorities-unknown/);
  assert.match(SECTIONS_SRC, /Operations status unavailable/);
});

// ============================================================================
// THE PHASE GATE — archiving a notification cannot move Home's count
// ============================================================================

test("GATE: User A archives a notification -> Home's Operations count is unchanged", () => {
  const before = normalizeHomeViewModel(
    inputs({
      inbox: feedWithFailures(false),
      operationsSummary: SHARED_SUMMARY,
    } as Partial<NormalizeInputs>),
  );

  // A archives BOTH notifications. Nothing else changes: the workspace's
  // shared operational state is the same object, because the work is the
  // same work.
  const after = normalizeHomeViewModel(
    inputs({
      inbox: feedWithFailures(true),
      operationsSummary: SHARED_SUMMARY,
    } as Partial<NormalizeInputs>),
  );

  assert.equal(before.operations.open, 7);
  assert.equal(after.operations.open, before.operations.open);
  assert.equal(after.operations.critical, before.operations.critical);
  assert.equal(after.operations.high, before.operations.high);
  assert.equal(after.operations.overdue, before.operations.overdue);
  assert.deepEqual(after.operations, before.operations);
});

test("GATE: the same holds when the feed is EMPTY but work remains", () => {
  // The converse, and the more dangerous direction: an operator with nothing
  // in their mailbox must not be told the workspace is clear.
  const vm = normalizeHomeViewModel(
    inputs({
      inbox: { items: [] } as unknown as NormalizeInputs["inbox"],
      operationsSummary: SHARED_SUMMARY,
    } as Partial<NormalizeInputs>),
  );
  assert.equal(vm.operations.open, 7);
  assert.ok(
    vm.operations.critical > 0,
    "an empty inbox is not an empty workspace",
  );
});

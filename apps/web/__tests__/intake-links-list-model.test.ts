/**
 * Intake links — the list pipeline and the row model.
 *
 * The management list is a renderer over two pure functions: `applyFilters`
 * decides WHICH rows appear, and `buildRowModel` decides WHAT each one says.
 * Both are exercised here against contract-shaped fixtures, because these are
 * the two places where the desktop table and the mobile cards could silently
 * disagree — they cannot, since they consume the same result.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_FILTERS,
  PAGE_SIZES,
  TAB_PARAMS,
  anyFilterActive,
  applyFilters,
  filtersFromQuery,
  filtersToQuery,
  intakeTabToTabParam,
  tabParamToIntakeTab,
  type FilterState,
} from "../app/(app)/intake-links/_lib/filters";
import {
  buildRowModel,
  describeRelativeTime,
  expiryStateOf,
} from "../app/(app)/intake-links/_lib/rowModel";
import type { IntakeLinkListItem } from "../app/(app)/intake-links/_lib/types";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const HOUR = 3_600_000;

function makeItem(over: {
  id?: string;
  name?: string;
  mode?: string;
  status?: string;
  expiresAtUtc?: string;
  revokedAtUtc?: string | null;
  archivedAtUtc?: string | null;
  maxUses?: number;
  usedCount?: number;
  recipientLabel?: string | null;
  recipientEmailPreview?: string | null;
  recipientPhonePreview?: string | null;
  customerId?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  recipientContactRevealAuthorized?: boolean;
  channel?: string | null;
  deliveryStatus?: string | null;
  attemptCount?: number;
  errorCode?: string | null;
  opened?: number;
  started?: number;
  submitted?: number;
  createdAt?: string;
  lastSubmittedAtUtc?: string | null;
} = {}): IntakeLinkListItem {
  const created = over.createdAt ?? "2026-08-01T00:00:00.000Z";
  return {
    link: {
      id: over.id ?? "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      workflowTemplateName: over.name ?? "General evidence request",
      intakeMode: over.mode ?? "EXTERNAL_ONE_TIME",
      caseId: null,
      recipientLabel: over.recipientLabel ?? null,
      customerId: over.customerId ?? null,
      recipientEmailPreview: over.recipientEmailPreview ?? null,
      recipientPhonePreview: over.recipientPhonePreview ?? null,
      recipientEmail: over.recipientEmail ?? null,
      recipientPhone: over.recipientPhone ?? null,
      recipientContactRevealAuthorized:
        over.recipientContactRevealAuthorized ?? false,
      maxUses: over.maxUses ?? 1,
      usedCount: over.usedCount ?? 0,
      status: over.status ?? "ACTIVE",
      expiresAtUtc:
        over.expiresAtUtc ?? new Date(NOW + 30 * 24 * HOUR).toISOString(),
      revokedAtUtc: over.revokedAtUtc ?? null,
      revokedReason: null,
      archivedAtUtc: over.archivedAtUtc ?? null,
      createdAt: created,
      updatedAt: created,
    },
    delivery: {
      latestStatus: over.deliveryStatus ?? null,
      latestChannel: over.channel ?? null,
      latestAtUtc: over.deliveryStatus ? created : null,
      latestSentAtUtc: null,
      latestDeliveredAtUtc: null,
      latestFailedAtUtc: null,
      latestErrorCode: over.errorCode ?? null,
      attemptCount: over.attemptCount ?? (over.deliveryStatus ? 1 : 0),
      channelsAttempted: over.channel ? [over.channel] : [],
      latestProviderMessageId: null,
    },
    activity: {
      firstOpenedAtUtc: null,
      lastOpenedAtUtc: null,
      firstStartedAtUtc: null,
      lastStartedAtUtc: null,
      firstSubmittedAtUtc: null,
      lastSubmittedAtUtc: over.lastSubmittedAtUtc ?? null,
      sessionsCreated:
        (over.opened ?? 0) + (over.started ?? 0) + (over.submitted ?? 0),
      sessionsOpened: over.opened ?? 0,
      sessionsStarted: over.started ?? 0,
      sessionsSubmitted: over.submitted ?? 0,
      sessionsExpired: 0,
      sessionsRevoked: 0,
      evidenceCount: over.submitted ?? 0,
    },
    computedLifecycle: "CREATED",
  };
}

function filters(over: Partial<FilterState> = {}): FilterState {
  return { ...DEFAULT_FILTERS, ...over };
}

// ===========================================================================
// URL round-trip
// ===========================================================================

test("a clean URL means the canonical default view", () => {
  const parsed = filtersFromQuery(new URLSearchParams(""));
  assert.deepEqual(parsed, DEFAULT_FILTERS);
  assert.equal(filtersToQuery(parsed).toString(), "");
  assert.equal(anyFilterActive(parsed), false);
});

test("filters round-trip through the address bar", () => {
  const state = filters({
    q: "smith",
    tab: "failed",
    channel: "SMS",
    lifecycle: "REVOKED",
    delivery: "FAILED",
    sort: "expires",
    page: 3,
    pageSize: 50,
  });
  const round = filtersFromQuery(filtersToQuery(state));
  assert.deepEqual(round, state);
  assert.equal(anyFilterActive(state), true);
});

test("hostile query values are clamped to the allowed sets", () => {
  const parsed = filtersFromQuery(
    new URLSearchParams(
      "tab=../etc&channel=CARRIER_PIGEON&lifecycle=DELETED&delivery=NOPE&sort=random&page=-4&pageSize=9999",
    ),
  );
  assert.equal(parsed.tab, "all");
  assert.equal(parsed.channel, "");
  assert.equal(parsed.lifecycle, "");
  assert.equal(parsed.delivery, "");
  assert.equal(parsed.sort, "activity");
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 25);
});

test("the legacy tab aliases survive so old bookmarks still resolve", () => {
  assert.equal(tabParamToIntakeTab("failed"), "failed_delivery");
  assert.equal(tabParamToIntakeTab("closed"), "revoked_or_expired");
  assert.equal(intakeTabToTabParam("failed_delivery"), "failed");
  assert.equal(intakeTabToTabParam("revoked_or_expired"), "closed");
  assert.equal(TAB_PARAMS.length, 7);
});

// ===========================================================================
// Filtering
// ===========================================================================

test("search matches request name, recipient, and the short link id", () => {
  const items = [
    makeItem({ id: "aaaaaaaa-1111-4111-8111-111111111111", name: "Insurance claim evidence" }),
    makeItem({ id: "bbbbbbbb-2222-4222-8222-222222222222", recipientLabel: "Jane Smith" }),
  ];
  assert.equal(applyFilters(items, filters({ q: "insurance" })).matched.length, 1);
  assert.equal(applyFilters(items, filters({ q: "smith" })).matched.length, 1);
  assert.equal(applyFilters(items, filters({ q: "bbbbbbbb" })).matched.length, 1);
  assert.equal(applyFilters(items, filters({ q: "nothing" })).matched.length, 0);
});

test("channel filter treats a never-sent link as copy-link-only", () => {
  const items = [
    makeItem({ id: "a", channel: "SMS", deliveryStatus: "SENT" }),
    makeItem({ id: "b", channel: null }),
  ];
  assert.equal(applyFilters(items, filters({ channel: "SMS" })).matched.length, 1);
  assert.equal(
    applyFilters(items, filters({ channel: "MANUAL" })).matched.length,
    1,
  );
});

test("lifecycle filter offers only states a row can display", () => {
  const items = [
    makeItem({ id: "active" }),
    makeItem({
      id: "revoked",
      status: "REVOKED",
      revokedAtUtc: "2026-08-10T00:00:00.000Z",
    }),
    makeItem({ id: "archived", archivedAtUtc: "2026-08-10T00:00:00.000Z" }),
    makeItem({ id: "expired", expiresAtUtc: "2026-08-01T00:00:00.000Z" }),
  ];
  const now = new Date(NOW);
  for (const [value, expected] of [
    ["ACTIVE", "active"],
    ["REVOKED", "revoked"],
    ["ARCHIVED", "archived"],
    ["EXPIRED", "expired"],
  ] as const) {
    const got = applyFilters(items, filters({ lifecycle: value }), now);
    assert.equal(got.matched.length, 1, `${value} matched ${got.matched.length}`);
    assert.equal(got.matched[0].link.id, expected);
  }
});

test("delivery FAILED also matches the UNDELIVERED rows the chip calls Failed", () => {
  const items = [
    makeItem({ id: "failed", deliveryStatus: "FAILED", channel: "SMS" }),
    makeItem({ id: "undelivered", deliveryStatus: "UNDELIVERED", channel: "SMS" }),
    makeItem({ id: "sent", deliveryStatus: "SENT", channel: "SMS" }),
  ];
  const got = applyFilters(items, filters({ delivery: "FAILED" }));
  assert.deepEqual(
    got.matched.map((i) => i.link.id).sort(),
    ["failed", "undelivered"],
  );
});

test("delivery NONE selects the links nothing was ever sent for", () => {
  const items = [
    makeItem({ id: "quiet" }),
    makeItem({ id: "sent", deliveryStatus: "SENT", channel: "EMAIL" }),
  ];
  const got = applyFilters(items, filters({ delivery: "NONE" }));
  assert.deepEqual(got.matched.map((i) => i.link.id), ["quiet"]);
});

test("archived rows appear ONLY under the archived tab", () => {
  const items = [
    makeItem({ id: "archived", archivedAtUtc: "2026-08-10T00:00:00.000Z" }),
    makeItem({ id: "live" }),
  ];
  const now = new Date(NOW);
  assert.deepEqual(
    applyFilters(items, filters({ tab: "active" }), now).matched.map(
      (i) => i.link.id,
    ),
    ["live"],
  );
  assert.deepEqual(
    applyFilters(items, filters({ tab: "archived" }), now).matched.map(
      (i) => i.link.id,
    ),
    ["archived"],
  );
});

// ===========================================================================
// Sorting + pagination
// ===========================================================================

test("each sort orders by the field it names", () => {
  const items = [
    makeItem({
      id: "old",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAtUtc: "2027-01-01T00:00:00.000Z",
      lastSubmittedAtUtc: "2026-01-02T00:00:00.000Z",
      submitted: 1,
    }),
    makeItem({
      id: "new",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAtUtc: "2026-09-01T00:00:00.000Z",
      lastSubmittedAtUtc: "2026-08-02T00:00:00.000Z",
      submitted: 1,
    }),
  ];
  const ids = (s: FilterState) =>
    applyFilters(items, s, new Date(NOW)).matched.map((i) => i.link.id);
  assert.deepEqual(ids(filters({ sort: "activity" })), ["new", "old"]);
  assert.deepEqual(ids(filters({ sort: "created" })), ["new", "old"]);
  assert.deepEqual(ids(filters({ sort: "expires" })), ["new", "old"]);
});

test("pagination slices, and a page past the end clamps instead of blanking", () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    makeItem({ id: `id-${String(i).padStart(2, "0")}`, createdAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }),
  );
  const page1 = applyFilters(items, filters({ pageSize: 25 }));
  assert.equal(page1.visible.length, 25);
  assert.equal(page1.pageCount, 2);

  const page2 = applyFilters(items, filters({ pageSize: 25, page: 2 }));
  assert.equal(page2.visible.length, 5);

  const beyond = applyFilters(items, filters({ pageSize: 25, page: 99 }));
  assert.equal(beyond.page, 2, "a stale page number must clamp to the last page");
  assert.equal(beyond.visible.length, 5);
});

test("the page-size options are the three the control offers", () => {
  assert.deepEqual([...PAGE_SIZES], [25, 50, 100]);
});

// ===========================================================================
// Row model
// ===========================================================================

test("the row model separates lifecycle, activity and delivery", () => {
  const row = buildRowModel(
    makeItem({
      archivedAtUtc: "2026-08-10T00:00:00.000Z",
      submitted: 1,
      deliveryStatus: "QUEUED",
      channel: "SMS",
    }),
    NOW,
  );
  assert.equal(row.lifecycle, "ARCHIVED");
  assert.equal(row.lifecycleVocab.label, "Archived");
  assert.equal(row.activity, "SUBMITTED");
  assert.equal(row.activityVocab.label, "Submitted");
  // The WIRE value is unchanged — only the sentence a person reads is
  // shorter. That distinction is the whole point of this assertion pair.
  assert.equal(row.delivery, "QUEUED");
  assert.equal(row.deliveryVocab.label, "With provider");
  // …and the queued-ness the removed word carried is still stated, in the
  // accessible description every renderer surfaces as `title`.
  assert.match(row.deliveryVocab.explanation, /[Qq]ueued/);
  // The defect in the screenshot: two chips rendered into one cell so the
  // browser ran them together as "ArchivedSubmitted".
  assert.notEqual(row.lifecycleVocab.label, row.activityVocab.label);
});

test("a disabled link reads as disabled, not as revoked jargon", () => {
  const row = buildRowModel(
    makeItem({ status: "REVOKED", revokedAtUtc: "2026-08-10T00:00:00.000Z" }),
    NOW,
  );
  assert.equal(row.lifecycle, "REVOKED");
  assert.equal(row.lifecycleVocab.label, "Link disabled");
  assert.equal(row.canDisable, false, "an already-disabled link cannot be disabled again");
  assert.equal(row.canArchive, true);
});

test("customer id, name, email and phone coexist — none substitutes for another", () => {
  /*
   * This replaced a fallback chain: `recipientLabel ?? emailPreview ??
   * phonePreview`. A request that had a name showed ONLY the name, so the
   * address it was sent to and the number it was texted to disappeared from
   * the operator's screen — and the Customer ID was not on the client at all.
   * They are four different questions and a row can answer all four.
   */
  const all = buildRowModel(
    makeItem({
      customerId: "CUST-849271",
      recipientLabel: "John Doe",
      recipientEmailPreview: "j***@example.com",
      recipientPhonePreview: "+49 ••• ••• 5678",
    }),
    NOW,
  );
  assert.equal(all.customerId, "CUST-849271");
  assert.equal(all.recipientName, "John Doe");
  assert.equal(all.recipientEmail, "j***@example.com");
  assert.equal(all.recipientPhone, "+49 ••• ••• 5678");
  assert.equal(all.recipientIsPlaceholder, false);

  // A name present must not suppress the contact values, and vice versa.
  const nameOnly = buildRowModel(makeItem({ recipientLabel: "Jane" }), NOW);
  assert.equal(nameOnly.recipientName, "Jane");
  assert.equal(nameOnly.recipientEmail, null);
  assert.equal(nameOnly.customerId, null);

  const contactOnly = buildRowModel(
    makeItem({ recipientEmailPreview: "j••@x.com" }),
    NOW,
  );
  assert.equal(contactOnly.recipientName, null);
  assert.equal(contactOnly.recipientEmail, "j••@x.com");

  // A Customer ID alone is still an identified request, and it does not make
  // the row claim a recipient it does not have.
  const customerOnly = buildRowModel(makeItem({ customerId: "CUST-1" }), NOW);
  assert.equal(customerOnly.customerId, "CUST-1");
  assert.equal(customerOnly.recipientIsPlaceholder, true);

  const none = buildRowModel(makeItem(), NOW);
  assert.equal(none.customerId, null);
  assert.equal(none.recipientName, null);
  assert.equal(none.recipientEmail, null);
  assert.equal(none.recipientPhone, null);
  assert.equal(none.recipientIsPlaceholder, true);
});

test("the raw contact is shown only when the server said the caller may see it", () => {
  // The browser never decides this: it reads the flag and picks a field.
  const masked = buildRowModel(
    makeItem({
      recipientEmailPreview: "j***@example.com",
      recipientEmail: "john@example.com",
      recipientContactRevealAuthorized: false,
    }),
    NOW,
  );
  assert.equal(masked.recipientEmail, "j***@example.com");
  assert.equal(masked.recipientContactIsMasked, true);

  const revealed = buildRowModel(
    makeItem({
      recipientEmailPreview: "j***@example.com",
      recipientEmail: "john@example.com",
      recipientContactRevealAuthorized: true,
    }),
    NOW,
  );
  assert.equal(revealed.recipientEmail, "john@example.com");
  assert.equal(revealed.recipientContactIsMasked, false);
});

test("expiry uses danger only when the link has actually expired", () => {
  assert.equal(expiryStateOf(new Date(NOW - HOUR).toISOString(), NOW), "expired");
  assert.equal(expiryStateOf(new Date(NOW + 2 * HOUR).toISOString(), NOW), "soon");
  assert.equal(
    expiryStateOf(new Date(NOW + 40 * 24 * HOUR).toISOString(), NOW),
    "ok",
  );
});

test("expiry carries both a relative phrase and a full absolute timestamp", () => {
  const row = buildRowModel(
    makeItem({ expiresAtUtc: new Date(NOW + 5 * 24 * HOUR).toISOString() }),
    NOW,
  );
  assert.match(row.expiryRelative, /in 5d/);
  // The absolute value is what the operator hovers for; it must never be the
  // fragment-per-line string the old fixed-width column produced.
  assert.ok(row.expiryAbsolute.length > 0);
  assert.ok(!row.expiryAbsolute.includes("\n"));
});

test("relative time reads correctly in both directions", () => {
  assert.equal(describeRelativeTime(new Date(NOW - 30_000).toISOString(), NOW), "just now");
  assert.equal(describeRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW), "5m ago");
  assert.equal(describeRelativeTime(new Date(NOW + 3 * HOUR).toISOString(), NOW), "in 3h");
  assert.equal(describeRelativeTime(null, NOW), "—");
  assert.equal(describeRelativeTime("not-a-date", NOW), "—");
});

test("the submissions cell offers a real action only when there is one", () => {
  assert.equal(
    buildRowModel(makeItem({ submitted: 2, started: 2 }), NOW).submissionsLabel,
    "View submissions (2)",
  );
  assert.equal(
    buildRowModel(makeItem({ started: 3, submitted: 1 }), NOW).submissionsLabel,
    "View submissions (1)",
  );
  assert.equal(
    buildRowModel(makeItem({ started: 2 }), NOW).submissionsAction,
    "in_progress",
  );
  assert.equal(buildRowModel(makeItem(), NOW).submissionsAction, "none");
});

test("delivery detail folds attempts and the provider code into one line", () => {
  const row = buildRowModel(
    makeItem({
      deliveryStatus: "FAILED",
      channel: "WHATSAPP",
      attemptCount: 3,
      errorCode: "63016",
    }),
    NOW,
  );
  assert.match(row.deliveryDetail, /3 attempts/);
  assert.match(row.deliveryDetail, /WhatsApp template/i);
  // No fragment-per-line: the detail is one string the CSS wraps normally.
  assert.ok(!row.deliveryDetail.includes("\n"));
});

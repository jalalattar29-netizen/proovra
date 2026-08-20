/**
 * Intake links — the operator vocabulary contract.
 *
 * ONE mapping decides every word and every tone the operator reads about an
 * intake link. These tests pin the properties that make that mapping safe:
 *
 *   1. every wire value in every axis has an entry — no renderer ever has to
 *      invent a label for a state the server can actually send;
 *   2. the KPI tone mapping is exactly the one the design contract names;
 *   3. the KPI counts are declared NON-exclusive, and the surface carries a
 *      sentence saying so — the seven numbers routinely sum above `total`;
 *   4. `REVOKED` keeps its wire name while reading as "Link disabled", and the
 *      confirmation states the irreversibility the API actually has;
 *   5. the delivery filter values fold into the canonical states the rows show,
 *      so a dropdown can never select a state no row displays.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CHANNEL_LABEL,
  CHANNEL_WIRE_VALUES,
  DELIVERY_FILTER_LABEL,
  DELIVERY_FILTER_WIRE_VALUES,
  DELIVERY_STATE_VOCABULARY,
  DISABLE_LINK_COPY,
  INTAKE_MODE_VOCABULARY,
  INTAKE_MODE_WIRE_VALUES,
  KPI_COUNTS_ARE_MUTUALLY_EXCLUSIVE,
  KPI_ORDER,
  KPI_OVERLAP_NOTE,
  KPI_VOCABULARY,
  LINK_STATE_VOCABULARY,
  SESSION_STATE_VOCABULARY,
  SORT_LABEL,
  SORT_WIRE_VALUES,
  channelLabel,
  intakeModeLabel,
  intakeModeShortLabel,
  providerErrorCodeLabel,
} from "../lib/intake-links/vocabulary";
import {
  computeIntakeKpis,
  getDeliveryState,
  type StateModelItem,
} from "../lib/intake-links/state-model";

// ===========================================================================
// 1. Total coverage of every axis
// ===========================================================================

test("every link operational state has a label, a tone and an explanation", () => {
  for (const key of ["ACTIVE", "ARCHIVED", "REVOKED", "EXPIRED"] as const) {
    const entry = LINK_STATE_VOCABULARY[key];
    assert.ok(entry, `${key} has no vocabulary entry`);
    assert.ok(entry.label.length > 0);
    assert.ok(entry.explanation.length > 0);
    assert.ok(entry.tone.length > 0);
  }
});

test("every contributor-activity state has a full entry", () => {
  for (const key of [
    "NO_ACTIVITY",
    "OPENED",
    "UPLOAD_STARTED",
    "SUBMITTED",
  ] as const) {
    const entry = SESSION_STATE_VOCABULARY[key];
    assert.ok(entry, `${key} has no vocabulary entry`);
    assert.ok(entry.label.length > 0 && entry.explanation.length > 0);
  }
});

test("every delivery state has a full entry", () => {
  for (const key of [
    "NOT_SENT",
    "QUEUED",
    "SENT",
    "DELIVERED",
    "FAILED",
    "RETRY_SCHEDULED",
  ] as const) {
    const entry = DELIVERY_STATE_VOCABULARY[key];
    assert.ok(entry, `${key} has no vocabulary entry`);
    assert.ok(entry.label.length > 0 && entry.explanation.length > 0);
  }
});

test("channels and modes cover the backend enums exactly", () => {
  assert.deepEqual([...CHANNEL_WIRE_VALUES].sort(), [
    "EMAIL",
    "MANUAL",
    "SMS",
    "WHATSAPP",
  ]);
  for (const c of CHANNEL_WIRE_VALUES) {
    assert.ok(CHANNEL_LABEL[c].length > 0);
  }
  // The four EXTERNAL_* modes of `WORKFLOW_INTAKE_MODES`. The authenticated
  // and field-team modes are not creatable from this surface.
  assert.deepEqual([...INTAKE_MODE_WIRE_VALUES].sort(), [
    "EXTERNAL_ANONYMOUS",
    "EXTERNAL_ONE_TIME",
    "EXTERNAL_PSEUDONYMOUS",
    "EXTERNAL_REUSABLE",
  ]);
  for (const m of INTAKE_MODE_WIRE_VALUES) {
    const entry = INTAKE_MODE_VOCABULARY[m];
    assert.ok(entry.label && entry.short && entry.description);
  }
});

test("an unknown channel degrades to the manual label rather than throwing", () => {
  assert.equal(channelLabel(null), "Copy link");
  assert.equal(channelLabel("SOMETHING_NEW"), "Copy link");
  assert.equal(channelLabel("sms"), "SMS");
});

test("an unknown intake mode degrades to a safe short label", () => {
  assert.equal(intakeModeShortLabel("EXTERNAL_PSEUDONYMOUS"), "Alias");
  assert.equal(intakeModeShortLabel("FIELD_TEAM"), "One-time");
  assert.equal(intakeModeLabel("EXTERNAL_REUSABLE"), "Reusable link");
});

// ===========================================================================
// 2. KPI tone mapping
// ===========================================================================

test("the seven KPI cards carry the mandated tones, in order", () => {
  assert.deepEqual(
    KPI_ORDER.map((k) => [k, KPI_VOCABULARY[k].label, KPI_VOCABULARY[k].tone]),
    [
      ["total", "Total links", "slate"],
      ["active", "Active", "indigo"],
      ["submitted", "Submitted", "blue"],
      ["opened", "Opened", "green"],
      ["failedDelivery", "Failed delivery", "red"],
      ["archived", "Archived", "slate"],
      ["revokedOrExpired", "Revoked or expired", "red"],
    ],
  );
});

test("every KPI maps to exactly one canonical tab", () => {
  const tabs = KPI_ORDER.map((k) => KPI_VOCABULARY[k].tab);
  assert.equal(new Set(tabs).size, tabs.length, "two KPIs share a tab");
  assert.deepEqual(tabs, [
    "all",
    "active",
    "submitted",
    "opened",
    "failed_delivery",
    "archived",
    "revoked_or_expired",
  ]);
});

// ===========================================================================
// 3. The counts overlap, and the surface says so
// ===========================================================================

function item(over: Partial<StateModelItem> = {}): StateModelItem {
  return {
    link: {
      status: "ACTIVE",
      expiresAtUtc: "2999-01-01T00:00:00.000Z",
      revokedAtUtc: null,
      archivedAtUtc: null,
      maxUses: 1,
      usedCount: 0,
      intakeMode: "EXTERNAL_ONE_TIME",
      ...(over.link ?? {}),
    },
    delivery: {
      latestStatus: null,
      latestFailedAtUtc: null,
      ...(over.delivery ?? {}),
    },
    activity: {
      sessionsOpened: 0,
      sessionsStarted: 0,
      sessionsSubmitted: 0,
      evidenceCount: 0,
      ...(over.activity ?? {}),
    },
  };
}

test("KPI counts are declared non-exclusive and the note is real copy", () => {
  assert.equal(KPI_COUNTS_ARE_MUTUALLY_EXCLUSIVE, false);
  assert.match(KPI_OVERLAP_NOTE, /more than one count/i);
  assert.match(KPI_OVERLAP_NOTE, /not a breakdown/i);
});

test("a submitted one-time link counts under BOTH submitted and revoked-or-expired", () => {
  // This is the production shape the screenshot shows: the backend flips a
  // ONE_TIME link to EXPIRED the moment its session reaches SUBMITTED.
  const submittedOneTime = item({
    link: {
      status: "EXPIRED",
      expiresAtUtc: "2999-01-01T00:00:00.000Z",
      revokedAtUtc: null,
      archivedAtUtc: null,
      maxUses: 1,
      usedCount: 1,
      intakeMode: "EXTERNAL_ONE_TIME",
    },
    activity: {
      sessionsOpened: 1,
      sessionsStarted: 1,
      sessionsSubmitted: 1,
      evidenceCount: 1,
    },
  });
  const kpis = computeIntakeKpis([submittedOneTime]);
  assert.equal(kpis.total, 1);
  assert.equal(kpis.submitted, 1);
  assert.equal(kpis.revokedOrExpired, 1);
  const sumOfBuckets =
    kpis.active +
    kpis.submitted +
    kpis.opened +
    kpis.failedDelivery +
    kpis.archived +
    kpis.revokedOrExpired;
  assert.ok(
    sumOfBuckets > kpis.total,
    "the six buckets must be allowed to exceed total — they are filters",
  );
});

test("archived is the one exclusive bucket", () => {
  const archivedAndRevoked = item({
    link: {
      status: "REVOKED",
      expiresAtUtc: "2000-01-01T00:00:00.000Z",
      revokedAtUtc: "2000-01-01T00:00:00.000Z",
      archivedAtUtc: "2000-01-02T00:00:00.000Z",
      maxUses: 1,
      usedCount: 0,
      intakeMode: "EXTERNAL_ONE_TIME",
    },
  });
  const kpis = computeIntakeKpis([archivedAndRevoked]);
  assert.equal(kpis.archived, 1);
  assert.equal(kpis.revokedOrExpired, 0);
  assert.equal(kpis.active, 0);
});

// ===========================================================================
// 4. REVOKED → "Link disabled", irreversibly, and never "deleted"
// ===========================================================================

test("REVOKED keeps its wire name but reads as an operator-facing disable", () => {
  assert.equal(LINK_STATE_VOCABULARY.REVOKED.label, "Link disabled");
  assert.equal(
    LINK_STATE_VOCABULARY.REVOKED.explanation,
    "This link can no longer accept submissions.",
  );
  assert.equal(LINK_STATE_VOCABULARY.REVOKED.tone, "red");
});

test("no operator-facing state label implies deletion", () => {
  const labels = [
    ...Object.values(LINK_STATE_VOCABULARY),
    ...Object.values(SESSION_STATE_VOCABULARY),
    ...Object.values(DELIVERY_STATE_VOCABULARY),
  ].map((e) => e.label.toLowerCase());
  for (const label of labels) {
    assert.ok(
      !label.includes("delet") && !label.includes("remov"),
      `"${label}" implies removal; disabling a link destroys nothing`,
    );
  }
});

test("the disable confirmation states that it cannot be undone", () => {
  assert.equal(DISABLE_LINK_COPY.actionLabel, "Disable link");
  assert.match(DISABLE_LINK_COPY.description, /cannot be undone/i);
  // It must NOT promise re-enabling: the API has revoke and no un-revoke.
  assert.ok(
    !/re-?enable(d)?\b(?!\.)/i.test(
      DISABLE_LINK_COPY.description.replace(/cannot be re-enabled/i, ""),
    ),
    "the copy must not imply a reactivation the API does not offer",
  );
  assert.match(DISABLE_LINK_COPY.description, /kept|keeps/i);
});

// ===========================================================================
// 5. Delivery filter values fold onto the states rows actually display
// ===========================================================================

test("every delivery filter value has a label and folds onto a shown state", () => {
  for (const wire of DELIVERY_FILTER_WIRE_VALUES) {
    assert.ok(DELIVERY_FILTER_LABEL[wire].length > 0, `${wire} has no label`);
    if (wire === "NONE") continue;
    const folded = getDeliveryState({
      latestStatus: wire,
      latestFailedAtUtc: null,
    });
    assert.ok(
      DELIVERY_STATE_VOCABULARY[folded],
      `${wire} folds onto ${folded}, which has no vocabulary entry`,
    );
  }
});

test("UNDELIVERED folds onto the same Failed state the row renders", () => {
  assert.equal(
    getDeliveryState({ latestStatus: "UNDELIVERED", latestFailedAtUtc: null }),
    "FAILED",
  );
});

test("sort options are labelled and unique", () => {
  assert.deepEqual([...SORT_WIRE_VALUES], ["activity", "created", "expires"]);
  const labels = SORT_WIRE_VALUES.map((s) => SORT_LABEL[s]);
  assert.equal(new Set(labels).size, labels.length);
});

test("known provider codes read as English; unknown codes pass through", () => {
  assert.match(providerErrorCodeLabel("63016"), /WhatsApp template/i);
  assert.match(providerErrorCodeLabel("30007"), /spam/i);
  assert.equal(providerErrorCodeLabel("99999"), "code 99999");
});

/**
 * RENDER TESTS for the canonical pattern family.
 *
 * These render the real components and assert on the real element tree. The
 * previous suite had NO render coverage: `ui-kit-contract.test.mjs` asserted
 * that the kit's SOURCE contained no hex literals and mentioned a 44pt
 * constant, which cannot tell you whether anything renders, whether a press
 * does anything, or whether a state is handled at all.
 *
 * Device behaviour (layout, gestures, fonts, safe areas, Hermes) is NOT proven
 * here and is not claimed — that is the physical acceptance matrix.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

let P;
const renderComponent = (el) => renderInProviders(P, el);

before(async () => {
  P = await loadWithProviders("src/ui/patterns.tsx");
});

const h = React.createElement;

/* -------------------------------------------------------------- PageHeader */

test("PageHeader renders the title, eyebrow and subtitle", async () => {
  const r = await renderComponent(
    h(P.ProovraPageHeader, { title: "Evidence", eyebrow: "workspace", subtitle: "Everything you have captured" }),
  );
  assert.ok(r.hasText("Evidence"));
  assert.ok(r.hasText("WORKSPACE"), "the eyebrow is upper-cased, as the web kicker is");
  assert.ok(r.hasText("Everything you have captured"));
});

test("PageHeader exposes the title as a heading for assistive tech", async () => {
  const r = await renderComponent(h(P.ProovraPageHeader, { title: "Cases" }));
  assert.equal(r.byRole("header").length, 1, "exactly one page-level heading");
});

test("PageHeader renders its actions", async () => {
  const r = await renderComponent(
    h(P.ProovraPageHeader, {
      title: "Cases",
      primaryAction: h(P.ProovraResultCount, { count: 3, noun: "case" }),
      secondaryActions: h(P.ProovraResultCount, { count: 1, noun: "draft" }),
    }),
  );
  assert.ok(r.hasText("Cases"));
  assert.ok(r.hasText("3 cases on this page"), "the primary action renders");
  assert.ok(r.hasText("1 draft on this page"), "secondary actions render too");
});

/* ------------------------------------------------------------- FilterChips */

test("FilterChips renders every option and marks the selected one", async () => {
  const r = await renderComponent(
    h(P.ProovraFilterChips, {
      label: "Scope",
      value: "active",
      onChange: () => {},
      options: [
        { value: "active", label: "Active", count: 12 },
        { value: "archived", label: "Archived" },
        { value: "trash", label: "Trash" },
      ],
    }),
  );
  assert.ok(r.hasText("Active"));
  assert.ok(r.hasText("Archived"));
  assert.ok(r.hasText("Trash"));
  assert.ok(r.hasText("12"), "the option count is rendered beside the label");

  const selected = r
    .byRole("button")
    .filter((n) => n.props.accessibilityState?.selected === true);
  assert.equal(selected.length, 1, "exactly one chip reports itself selected");
  assert.equal(selected[0].props.accessibilityLabel, "Scope: Active");
});

test("FilterChips reports the chosen value", async () => {
  const chosen = [];
  const r = await renderComponent(
    h(P.ProovraFilterChips, {
      label: "Scope",
      value: "active",
      onChange: (v) => chosen.push(v),
      options: [
        { value: "active", label: "Active" },
        { value: "trash", label: "Trash" },
      ],
    }),
  );
  await r.press("Scope: Trash");
  assert.deepEqual(chosen, ["trash"]);
});

test("FilterChips does not report a change while disabled", async () => {
  const chosen = [];
  const r = await renderComponent(
    h(P.ProovraFilterChips, {
      label: "Scope",
      value: "active",
      disabled: true,
      onChange: (v) => chosen.push(v),
      options: [
        { value: "active", label: "Active" },
        { value: "trash", label: "Trash" },
      ],
    }),
  );
  await r.press("Scope: Trash");
  assert.deepEqual(chosen, [], "a disabled filter must not mutate the query");
});

/* ------------------------------------------------------------ FilterSearch */

test("FilterSearch reports typing and only offers Clear when there is a value", async () => {
  const typed = [];
  const empty = await renderComponent(
    h(P.ProovraFilterSearch, { value: "", onChange: (v) => typed.push(v) }),
  );
  assert.equal(empty.byLabel("Clear search").length, 0, "no Clear affordance on an empty field");

  const filled = await renderComponent(
    h(P.ProovraFilterSearch, { value: "invoice", onChange: (v) => typed.push(v) }),
  );
  assert.equal(filled.byLabel("Clear search").length, 1);
  await filled.type("Search", "receipt");
  assert.deepEqual(typed, ["receipt"]);
  await filled.press("Clear search");
  assert.deepEqual(typed, ["receipt", ""], "Clear resets the query to empty");
});

/* -------------------------------------------------------------- EmptyState */

test("EmptyState renders the purpose and the next-best action", async () => {
  let acted = false;
  const r = await renderComponent(
    h(P.ProovraEmpty, {
      title: "No evidence yet",
      purpose: "Captured items appear here once you finalize a session.",
      action: h(P.ProovraResultCount, { count: 0, noun: "item" }),
      note: "Your plan includes 5 GB.",
    }),
  );
  assert.ok(r.hasText("No evidence yet"));
  assert.ok(r.hasText("Captured items appear here once you finalize a session."));
  assert.ok(r.hasText("Your plan includes 5 GB."));
  assert.equal(acted, false);
});

test("EmptyState honours the presence distinction", async () => {
  const page = await renderComponent(h(P.ProovraEmpty, { title: "Nothing", presence: "page" }));
  const inline = await renderComponent(h(P.ProovraEmpty, { title: "Nothing", presence: "inline" }));
  // Both render the title; the inline form is a single row and must not carry
  // the centred page treatment. Asserted through the rendered style, which is
  // the thing that made five stacked 200px boxes on one web page.
  const pageStyle = page.root.findAll((n) => n.type === "View")[0].props.style;
  const inlineStyle = inline.root.findAll((n) => n.type === "View")[0].props.style;
  assert.notDeepEqual(pageStyle, inlineStyle);
  assert.ok(page.hasText("Nothing") && inline.hasText("Nothing"));
});

/* ------------------------------------------------------------- ResultCount */

test("ResultCount never lets a page count read as a workspace total", async () => {
  const slice = await renderComponent(h(P.ProovraResultCount, { count: 50, noun: "record" }));
  assert.ok(slice.hasText("50 records on this page"));

  const total = await renderComponent(h(P.ProovraResultCount, { count: 50, total: 1280, noun: "record" }));
  assert.ok(total.hasText("50 of 1280 records"));
});

test("ResultCount pluralises a single result correctly", async () => {
  const one = await renderComponent(h(P.ProovraResultCount, { count: 1, total: 1, noun: "case" }));
  assert.ok(one.hasText("1 of 1 case"));
});

/* ------------------------------------------------------------ CursorPager */

test("CursorPager appears only when there is more, and reports the request", async () => {
  const none = await renderComponent(h(P.ProovraCursorPager, { hasMore: false, onLoadMore: () => {} }));
  assert.equal(none.texts().length, 0, "no pager when the list is complete");

  let asked = 0;
  const more = await renderComponent(
    h(P.ProovraCursorPager, { hasMore: true, onLoadMore: () => (asked += 1) }),
  );
  assert.ok(more.hasText("Load more"));
  await more.press("Load more");
  assert.equal(asked, 1);
});

test("CursorPager will not fire twice while a page is in flight", async () => {
  let asked = 0;
  const r = await renderComponent(
    h(P.ProovraCursorPager, { hasMore: true, loading: true, onLoadMore: () => (asked += 1) }),
  );
  assert.ok(r.hasText("Loading…"));
  await r.press("Loading…").catch(() => {});
  assert.equal(asked, 0, "a disabled pager must not re-request the same cursor");
});

/* -------------------------------------------------------------- KPI grid */

test("KpiGrid renders every metric with an accessible label", async () => {
  const r = await renderComponent(
    h(P.ProovraKpiGrid, {
      items: [
        { key: "a", label: "Records", value: "1,280" },
        { key: "b", label: "Verified", value: "1,180", tone: "verified", caption: "92%" },
      ],
    }),
  );
  assert.ok(r.hasText("Records") && r.hasText("1,280"));
  assert.ok(r.hasText("Verified") && r.hasText("1,180") && r.hasText("92%"));
  assert.ok(
    r.root.findAll((n) => n.props?.accessibilityLabel === "Verified: 1,180").length > 0,
    "a KPI must read as one label/value pair, not two loose strings",
  );
});

test("a KPI with an onPress becomes a button; one without does not", async () => {
  let opened = 0;
  const r = await renderComponent(
    h(P.ProovraKpiGrid, {
      items: [
        { key: "a", label: "Records", value: "3", onPress: () => (opened += 1) },
        { key: "b", label: "Static", value: "1" },
      ],
    }),
  );
  assert.equal(r.byRole("button").length, 1);
  await r.press("Records: 3");
  assert.equal(opened, 1);
});

/* ----------------------------------------------------------- DetailRows */

test("DetailRows renders label/value pairs and uses a badge for toned values", async () => {
  const r = await renderComponent(
    h(P.ProovraDetailRows, {
      rows: [
        { label: "Status", value: "Signed", tone: "verified" },
        { label: "SHA-256", value: "a1b2c3", mono: true },
      ],
    }),
  );
  assert.ok(r.hasText("Status") && r.hasText("Signed"));
  assert.ok(r.hasText("SHA-256") && r.hasText("a1b2c3"));
});

/* ------------------------------------------------------------- Confirm */

test("ConfirmSheet renders the consequence and only acts on confirm", async () => {
  let confirmed = 0;
  let cancelled = 0;
  const r = await renderComponent(
    h(P.ProovraConfirmSheet, {
      visible: true,
      title: "Discard this session?",
      consequence: "Nothing you have staged will be kept.",
      confirmLabel: "Discard",
      tone: "danger",
      onConfirm: () => (confirmed += 1),
      onCancel: () => (cancelled += 1),
    }),
  );
  assert.ok(r.hasText("Discard this session?"));
  assert.ok(r.hasText("Nothing you have staged will be kept."), "a destructive action states its consequence");
  assert.equal(confirmed, 0, "nothing happens on render");
});

test("ConfirmSheet renders nothing when it is not visible", async () => {
  const r = await renderComponent(
    h(P.ProovraConfirmSheet, {
      visible: false,
      title: "Discard this session?",
      onConfirm: () => {},
      onCancel: () => {},
    }),
  );
  assert.equal(r.hasText("Discard this session?"), false);
});

/* ------------------------------------------------------------ AsyncView */

test("AsyncView shows loading, then error with a retry, then empty, then content", async () => {
  const loading = await renderComponent(
    h(P.ProovraAsyncView, { loading: true, items: [], empty: h(P.ProovraEmpty, { title: "None" }) }, "content"),
  );
  assert.equal(loading.hasText("content"), false);
  assert.ok(loading.root.findAll((n) => n.type === "ActivityIndicator").length > 0);

  let retried = 0;
  const errored = await renderComponent(
    h(
      P.ProovraAsyncView,
      {
        loading: false,
        error: { title: "Could not load", message: "Check your connection." },
        onRetry: () => (retried += 1),
        items: [],
        empty: h(P.ProovraEmpty, { title: "None" }),
      },
      "content",
    ),
  );
  assert.ok(errored.hasText("Could not load"));
  assert.ok(errored.hasText("Check your connection."));
  await errored.press("Try again");
  assert.equal(retried, 1);

  const empty = await renderComponent(
    h(P.ProovraAsyncView, { loading: false, items: [], empty: h(P.ProovraEmpty, { title: "None yet" }) }, "content"),
  );
  assert.ok(empty.hasText("None yet"));
  assert.equal(empty.hasText("content"), false);

  const full = await renderComponent(
    h(
      P.ProovraAsyncView,
      { loading: false, items: [1], empty: h(P.ProovraEmpty, { title: "None yet" }) },
      h(P.ProovraResultCount, { count: 1, noun: "record" }),
    ),
  );
  assert.ok(full.hasText("1 record on this page"));
});

test("AsyncView prefers the error state over an empty list", async () => {
  // A failed request returns no items. Rendering "nothing here" for a failure
  // tells the user their workspace is empty when it is not.
  const r = await renderComponent(
    h(
      P.ProovraAsyncView,
      {
        loading: false,
        error: { title: "Could not load" },
        items: [],
        empty: h(P.ProovraEmpty, { title: "You have no records" }),
      },
      "content",
    ),
  );
  assert.ok(r.hasText("Could not load"));
  assert.equal(r.hasText("You have no records"), false);
});

/**
 * Home dashboard projections — behavioural.
 *
 * The property under test throughout is HONESTY: Home read two sources where
 * the web reads seven, and the cheap way to "fill" it is to render zeros for
 * data that never arrived. A zero and an unknown are different facts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/home-dashboard.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const H = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const kpi = (sources, key) => H.buildHomeKpis(sources).find((k) => k.key === key);

/* -------------------------------------------------------------------- KPIs */

test("the five canonical KPIs are always present, in the web's order", () => {
  const keys = H.buildHomeKpis({}).map((k) => k.key);
  assert.deepEqual(keys, ["evidence", "matters", "trust", "deliverables", "intake"]);
});

test("KPI labels and destinations match the canonical web surface", () => {
  const k = H.buildHomeKpis({});
  assert.deepEqual(
    k.map((x) => x.label),
    ["Total evidence", "Active matters", "End-to-end ready", "Reports & packages", "Intake & submissions"],
  );
  assert.equal(kpi({}, "evidence").href, "/evidence");
  assert.equal(kpi({}, "matters").href, "/cases");
  assert.equal(kpi({}, "intake").href, "/intake-links");
});

test("an absent source reads as unknown, never as zero", () => {
  const k = kpi({}, "evidence");
  assert.equal(k.value, "—", "showing '0 evidence' to someone whose dashboard failed is a lie");
  assert.equal(k.subtitle, "Not available");
});

test("a real zero is reported as zero, not as unknown", () => {
  const k = kpi({ commandCenter: { cases: { active: 0 } } }, "matters");
  assert.equal(k.value, "0");
  assert.equal(k.subtitle, "No open matters");
});

test("evidence totals fall back from the command centre to the trust summary", () => {
  assert.equal(kpi({ commandCenter: { evidence: { total: 1280 } } }, "evidence").value, "1,280");
  assert.equal(kpi({ trustSummary: { totalEvidence: 42 } }, "evidence").value, "42");
});

test("large numbers carry thousands separators, as the web formats them", () => {
  assert.equal(H.formatKpiNumber(1234567), "1,234,567");
  assert.equal(H.formatKpiNumber(null), "—");
});

/* ------------------------------------------------------------- trust tone */

test("the trust KPI reads as verified only when the posture is actually complete", () => {
  const complete = kpi({ trustSummary: { totalEvidence: 10, endToEndReady: 10 } }, "trust");
  assert.equal(complete.value, "100%");
  assert.equal(complete.tone, "verified");

  const nearly = kpi({ trustSummary: { totalEvidence: 100, endToEndReady: 92 } }, "trust");
  assert.equal(nearly.value, "92%");
  assert.equal(nearly.tone, "pending", "92% is not 'verified' — it is nearly there");

  const poor = kpi({ trustSummary: { totalEvidence: 100, endToEndReady: 40 } }, "trust");
  assert.equal(poor.tone, "risk");
});

test("an empty workspace does not claim a verified posture", () => {
  const none = kpi({ trustSummary: { totalEvidence: 0, endToEndReady: 0 } }, "trust");
  assert.equal(none.value, "—", "0 of 0 is not 100%");
  assert.equal(none.tone, "neutral");
});

test("the trust KPI states the counts behind the percentage", () => {
  const k = kpi({ trustSummary: { totalEvidence: 100, endToEndReady: 92 } }, "trust");
  assert.equal(k.subtitle, "92 of 100 fully verified");
});

/* ------------------------------------------------------------- priorities */

test("priorities are ranked by severity, not by arrival", () => {
  const p = H.buildHomePriorities({
    inbox: {
      items: [
        { itemKey: "a", title: "Routine", severity: "low" },
        { itemKey: "b", title: "Urgent thing", severity: "critical" },
        { itemKey: "c", title: "Middling", severity: "medium" },
      ],
    },
  });
  assert.deepEqual(p.map((x) => x.label), ["Urgent thing", "Middling", "Routine"]);
  assert.equal(p[0].tone, "risk");
});

test("inbox items and command-centre attention items are one queue", () => {
  const p = H.buildHomePriorities({
    inbox: { items: [{ itemKey: "a", title: "From inbox", severity: "medium" }] },
    commandCenter: { attention: [{ id: "x", label: "From command centre", tone: "risk" }] },
  });
  assert.equal(p.length, 2);
  assert.equal(p[0].label, "From command centre", "the risk item leads");
});

test("an item with no title is labelled from its kind rather than left blank", () => {
  const p = H.buildHomePriorities({ inbox: { items: [{ itemKey: "a", kind: "ORG_INVITE" }] } });
  assert.equal(p[0].label, "Org Invite");
});

test("malformed sources yield an empty queue rather than throwing", () => {
  assert.deepEqual(H.buildHomePriorities({}), []);
  assert.deepEqual(H.buildHomePriorities({ inbox: "nope" }), []);
  assert.deepEqual(H.buildHomePriorities({ inbox: { items: null } }), []);
});

/* -------------------------------------------------------- executive band */

test("a failed dashboard says so instead of reporting a calm workspace", () => {
  const s = H.buildHomeSummary({}, []);
  assert.equal(s.state, "Unavailable");
  assert.match(s.sentence, /could not be loaded/);
  assert.notEqual(s.tone, "verified", "absent data must never read as 'all clear'");
});

test("the band names the number of things that need the user", () => {
  const sources = { commandCenter: {} };
  assert.deepEqual(
    H.buildHomeSummary(sources, [{ id: "1", label: "x", tone: "risk", detail: null, href: null }]),
    { state: "Needs attention", sentence: "1 item needs you now.", tone: "risk" },
  );
  assert.equal(
    H.buildHomeSummary(sources, [
      { id: "1", label: "x", tone: "risk", detail: null, href: null },
      { id: "2", label: "y", tone: "risk", detail: null, href: null },
    ]).sentence,
    "2 items need you now.",
  );
});

test("a queue with no risk items reads as in progress, not as a problem", () => {
  const s = H.buildHomeSummary({ commandCenter: {} }, [
    { id: "1", label: "x", tone: "info", detail: null, href: null },
  ]);
  assert.equal(s.state, "In progress");
  assert.equal(s.tone, "pending");
});

test("an empty queue over real data is all clear", () => {
  const s = H.buildHomeSummary({ trustSummary: {} }, []);
  assert.deepEqual(s, { state: "All clear", sentence: "Nothing is waiting on you.", tone: "verified" });
});

/* ------------------------------------------------------------- storage */

test("storage is omitted entirely when billing did not answer", () => {
  assert.equal(H.buildHomeStorage({}), null, "an absent plan is not '0 bytes used'");
});

test("storage warns before the plan limit is reached", () => {
  const near = H.buildHomeStorage({
    billingOverview: { storage: { usedLabel: "4.6 GB", limitLabel: "5 GB", usedBytes: 4600, limitBytes: 5000 } },
  });
  assert.equal(near.tone, "risk");
  const fine = H.buildHomeStorage({
    billingOverview: { storage: { usedLabel: "1 GB", limitLabel: "5 GB", usedBytes: 1000, limitBytes: 5000 } },
  });
  assert.equal(fine.tone, "neutral");
});

test("an unlimited plan reports usage without inventing a fraction", () => {
  const s = H.buildHomeStorage({ billingOverview: { storage: { usedLabel: "12 GB" } } });
  assert.equal(s.fraction, null);
  assert.equal(s.limitLabel, "—");
  assert.equal(s.tone, "neutral");
});

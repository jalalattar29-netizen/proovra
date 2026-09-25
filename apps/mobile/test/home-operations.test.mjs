/**
 * HOME — Operations, Analytics and Activity.
 *
 * The rule these tests hold: every number is the server's, or it is absent.
 * A zero and an unknown are different facts, and a chart that silently covers
 * part of its window is worse than one that says it is a sample.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/home-operations.ts"), "utf8");
const js = ts.transpileModule(SRC.replace(/^import type .*$/m, ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const H = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/* -------------------------------------------------------- records by type */

// The server's envelope: { records: {total, byCategory}, files: {total, byCategory} }.
test("the aggregate is read from `records`, and it is never a sample", () => {
  const d = H.parseRecordsByType({ records: { total: 10, byCategory: { Images: 6, Documents: 4 } }, files: { total: 0, byCategory: {} } });
  assert.equal(d.total, 10);
  assert.equal(d.sampled, false);
  assert.deepEqual(d.slices.map((s) => s.label), ["Images", "Documents"]);
  assert.equal(d.slices[0].percent, 60);
});

test("top-level counts are NOT the server's shape and read as empty", () => {
  const d = H.parseRecordsByType({ total: 10, byCategory: { Images: 10 } });
  assert.equal(d.total, 0);
});

test("categories render in the canonical order, not the server's key order", () => {
  const d = H.parseRecordsByType({ records: { total: 3, byCategory: { Audio: 1, Images: 1, Videos: 1 } } });
  assert.deepEqual(d.slices.map((s) => s.label), ["Images", "Videos", "Audio"]);
});

test("a category the product has no vocabulary for is dropped", () => {
  // A client cannot fabricate a slice for a category the UI does not know.
  const d = H.parseRecordsByType({ records: { total: 5, byCategory: { Images: 3, Holograms: 2 } } });
  assert.equal(d.slices.length, 1);
  assert.equal(d.total, 5);
});

test("an absent total is computed from the categories, not assumed", () => {
  const d = H.parseRecordsByType({ records: { byCategory: { Images: 2, Audio: 3 } } });
  assert.equal(d.total, 5);
});

test("an empty payload is empty, and does not throw", () => {
  const d = H.parseRecordsByType({});
  assert.deepEqual(d.slices, []);
  assert.equal(d.total, 0);
});

test("preserved files come from `files`; absent means no files view", () => {
  const f = H.parsePreservedFilesByType({ records: { total: 1, byCategory: { Images: 1 } }, files: { total: 7, byCategory: { Images: 5, Documents: 2 } } });
  assert.equal(f.total, 7);
  assert.deepEqual(f.slices.map((s) => s.count), [5, 2]);
  assert.equal(H.parsePreservedFilesByType({ records: { total: 1 } }), null);
});

/* ------------------------------------------------------- workspace health */

const health = (over = {}) =>
  H.buildWorkspaceHealth({
    commandCenter: {
      sections: { pipelineDetail: { data: { evidence: { reported: 4, signed: 6 }, reports: { missingFromSigned: 2 } } } },
    },
    trustSummary: { needingAttention: 0, signedWithoutReport: 0, reportedWithoutPackage: 0 },
    reports: { items: [{ status: "READY" }] },
    inbox: { items: [] },
    activeCases: 3,
    storageLabel: "2 GB of 100 GB",
    storagePercent: 2,
    ...over,
  });

test("the eight rows carry the web's labels, including the honest two", () => {
  const rows = health();
  const labels = rows.map((r) => r.label);
  // "Records with a report", NOT "records complete": the metric counts
  // evidence at status REPORTED, and "complete" reads as deliverable-complete.
  assert.ok(labels.includes("Records with a report"));
  assert.equal(labels.includes("Records complete"), false);
  // Delivery issues stay separate from review flags: folding one into the
  // other would imply a content-integrity problem where there is none.
  assert.ok(labels.includes("Records with delivery issues"));
  assert.ok(labels.includes("Records flagged for review"));
  assert.equal(rows.length, 8);
});

test("reports-ready warns when signed evidence exists and nothing is ready", () => {
  // Neutral at zero would hide the failure from someone who scans tones.
  const rows = health({ reports: { items: [] } });
  assert.equal(rows.find((r) => r.key === "reports_ready").tone, "warn");

  const nothingSigned = H.buildWorkspaceHealth({
    commandCenter: { sections: { pipelineDetail: { data: { evidence: { signed: 0 } } } } },
    reports: { items: [] },
  });
  assert.equal(nothingSigned.find((r) => r.key === "reports_ready").tone, "neutral");
});

test("integrity issues come from domain state, not from one person's inbox", () => {
  // The web records what happened when this read the caller's inbox: the tile
  // counted what was visible to one person and fell when they archived it.
  const rows = health({
    trustSummary: { needingAttention: 2 },
    inbox: { items: [{ type: "EVIDENCE_REVIEW" }, { type: "EVIDENCE_REVIEW" }] },
  });
  assert.equal(rows.find((r) => r.key === "integrity").value, "2");
  assert.equal(rows.find((r) => r.key === "integrity").tone, "danger");
});

test("delivery issues add the pipeline gaps and the failed reports", () => {
  // A report row's `status` is the EVIDENCE status; failure is its output lifecycle.
  const rows = health({
    trustSummary: { signedWithoutReport: 2, reportedWithoutPackage: 1, needingAttention: 0 },
    reports: { items: [{ evidenceId: "e1", status: "SIGNED", reportLifecycle: "TERMINAL_FAILURE" }, { evidenceId: "e2", status: "REPORTED", reportLifecycle: "READY" }] },
  });
  // 2 signed-without-report + 1 reported-without-package + 1 failed report.
  assert.equal(rows.find((r) => r.key === "operational").value, "4");
  assert.equal(rows.find((r) => r.key === "operational").tone, "danger");
});

test("an unknown case count is a dash, never zero", () => {
  const rows = health({ activeCases: null });
  assert.equal(rows.find((r) => r.key === "active_cases").value, "—");
  assert.equal(rows.find((r) => r.key === "active_cases").tone, "neutral");
});

test("a plan with no published limit is not a plan that is 0% full", () => {
  const rows = health({ storagePercent: null, storageLabel: null });
  const storage = rows.find((r) => r.key === "storage");
  assert.equal(storage.value, "—");
  assert.equal(storage.tone, "neutral");
});

test("storage tone steps at the web's thresholds", () => {
  const tone = (percent) =>
    health({ storagePercent: percent }).find((r) => r.key === "storage").tone;
  assert.equal(tone(50), "ok");
  assert.equal(tone(75), "warn");
  assert.equal(tone(90), "danger");
});

test("the overall word is the worst tone present", () => {
  assert.equal(H.workspaceHealthOverall([{ tone: "ok" }, { tone: "neutral" }]), "healthy");
  assert.equal(H.workspaceHealthOverall([{ tone: "ok" }, { tone: "warn" }]), "needs_attention");
  assert.equal(
    H.workspaceHealthOverall([{ tone: "warn" }, { tone: "danger" }]),
    "action_required",
  );
});

/* ------------------------------------------------------- activity series */

test("records bucket into local days, oldest first", () => {
  const now = Date.parse("2026-09-22T12:00:00");
  const today = "2026-09-22T09:00:00";
  const yesterday = "2026-09-21T09:00:00";
  const s = H.buildActivitySeries({
    createdAtIsoList: [today, today, yesterday],
    hasMore: false,
    nowMs: now,
  });
  assert.equal(s.buckets.length, 14);
  assert.equal(s.buckets[13].count, 2);
  assert.equal(s.buckets[12].count, 1);
  assert.equal(s.total, 3);
});

test("a record outside the window is not counted into the edge bucket", () => {
  // Clamping it to day one would draw a spike that never happened.
  const now = Date.parse("2026-09-22T12:00:00");
  const s = H.buildActivitySeries({
    createdAtIsoList: ["2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z"],
    hasMore: false,
    nowMs: now,
  });
  assert.equal(s.total, 0);
  assert.equal(s.buckets.every((b) => b.count === 0), true);
});

test("an unparseable or absent timestamp is skipped, not guessed", () => {
  const s = H.buildActivitySeries({
    createdAtIsoList: [null, "not a date", undefined],
    hasMore: false,
  });
  assert.equal(s.total, 0);
});

test("the sample is reported, and says what it means", () => {
  assert.equal(H.buildActivitySeries({ createdAtIsoList: [], hasMore: true }).sampled, true);
  assert.equal(H.buildActivitySeries({ createdAtIsoList: [], hasMore: false }).sampled, false);
  assert.match(H.ACTIVITY_SAMPLE_NOTE, /undercounted/i);
});

/* --------------------------------------------------------- activity feed */

test("events group by day and sort newest first", () => {
  const now = Date.parse("2026-09-22T12:00:00");
  const groups = H.buildActivityGroups({
    recentEvidence: {
      items: [
        { id: "e1", title: "Today one", createdAt: "2026-09-22T08:00:00" },
        { id: "e2", title: "Today two", createdAt: "2026-09-22T10:00:00" },
        { id: "e3", title: "Yesterday", createdAt: "2026-09-21T10:00:00" },
        { id: "e4", title: "Older", createdAt: "2026-09-01T10:00:00" },
      ],
    },
    nowMs: now,
  });
  assert.deepEqual(groups.map((g) => g.id), ["today", "yesterday", "earlier"]);
  assert.deepEqual(groups[0].events.map((e) => e.title), ["Today two", "Today one"]);
});

test("an event with no timestamp is dropped, not filed under Earlier", () => {
  // Placing it there would be a claim about when it happened.
  const groups = H.buildActivityGroups({
    recentEvidence: { items: [{ id: "e1", title: "No date" }] },
  });
  assert.deepEqual(groups, []);
});

test("an intake link reads by its recipient label, never a raw id", () => {
  const [group] = H.buildActivityGroups({
    intakeLinks: {
      links: [{ id: "l1", recipientLabel: "Ada Lovelace", createdAt: "2026-09-22T08:00:00" }],
    },
    nowMs: Date.parse("2026-09-22T12:00:00"),
  });
  assert.equal(group.events[0].title, "Intake link created — Ada Lovelace");
});

test("the feed is bounded", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: `e${i}`,
    createdAt: "2026-09-22T08:00:00",
  }));
  const groups = H.buildActivityGroups({
    recentEvidence: { items },
    nowMs: Date.parse("2026-09-22T12:00:00"),
    limit: 10,
  });
  assert.equal(groups.reduce((n, g) => n + g.events.length, 0), 10);
});

test("an empty set of sources produces no groups, and does not throw", () => {
  assert.deepEqual(H.buildActivityGroups({}), []);
});

test("the pipeline's own report counts win over the page of rows (as the web reads them)", () => {
  const rows = health({
    commandCenter: { sections: { pipelineDetail: { data: { evidence: { reported: 4, signed: 6 }, reports: { missingFromSigned: 0, ready: 7, failed: 2 } } } } },
    trustSummary: { signedWithoutReport: 0, reportedWithoutPackage: 0, needingAttention: 0 },
    reports: { items: [] },
  });
  assert.equal(rows.find((r) => r.key === "operational").value, "2", "the pipeline's failed reports were not counted");
});

test("submissions waiting counts the inbox's pending-review CATEGORY", () => {
  const rows = health({
    inbox: { items: [
      { itemKey: "a", category: "intake_submission_pending_review", tone: "warning" },
      { itemKey: "b", category: "intake_submission_pending_review", tone: "warning" },
      { itemKey: "c", category: "org_invite", tone: "info" },
    ] },
  });
  const row = rows.find((r) => /submission/i.test(r.key));
  assert.ok(row, "no submissions row");
  assert.equal(row.value, "2");
});

test("reports reach the activity feed: GET /v1/reports rows are keyed by evidenceId", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const groups = H.buildActivityGroups({
    reports: { items: [{ evidenceId: "e-1", title: "Roof photo", status: "REPORTED", createdAt: "2026-09-20T09:00:00.000Z", report: { available: true, version: 2, generatedAtUtc: "2026-09-24T10:00:00.000Z" } }] },
    nowMs: now,
  });
  const events = groups.flatMap((g) => g.events);
  assert.equal(events.length, 1, "a report row with no `id` was dropped");
  assert.equal(events[0].detail, "Roof photo");
  assert.equal(groups[0].id, "today", "the report's generation time was not used");
});

/*
 * web buildActivity — the command center's TIMELINE is the feed's source
 * (command-center.service.ts TimelineEvent { id, kind, occurredAt, label, href }),
 * plus intake deliveries (communications { messages }) and request-more inbox
 * items. The recent lists only stand in when no timeline was read.
 */
test("the timeline drives the feed, with the web's labels, and the lists do not double it", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const groups = H.buildActivityGroups({
    commandCenter: { sections: { timeline: { status: "ok", items: [
      { id: "t1", kind: "report_generated", occurredAt: "2026-09-24T10:00:00.000Z", label: "Report generated — Roof photo", href: "/evidence/e1" },
      { id: "t2", kind: "evidence_finalized", occurredAt: "2026-09-24T09:00:00.000Z", label: "Evidence finalized — Untitled", href: "/evidence/e2" },
      { id: "t3", kind: "some_unknown_kind", occurredAt: "2026-09-24T08:00:00.000Z", label: "x", href: null },
    ] } } },
    recentEvidence: { items: [{ id: "e2", title: "Duplicate", createdAt: "2026-09-24T09:00:00.000Z" }] },
    intakeLinks: { links: [{ id: "l1", recipientLabel: "Ada", createdAt: "2026-09-24T07:00:00.000Z" }] },
    communications: { messages: [
      { id: "m1", channel: "EMAIL", relatedIntakeLinkId: "l1", deliveredAtUtc: "2026-09-24T07:30:00.000Z" },
      { id: "m2", channel: "SMS", relatedIntakeLinkId: null, failedAtUtc: "2026-09-24T06:00:00.000Z" },
    ] },
    inbox: { items: [{ id: "i1", category: "intake_required_items_missing", title: "Leak photos", occurredAt: "2026-09-24T05:00:00.000Z", href: "/evidence-requests" }] },
    nowMs: now,
  });
  const titles = groups.flatMap((g) => g.events.map((e) => e.title));
  assert.deepEqual(titles, [
    "Report generated — Roof photo",
    "Evidence finalized",
    "Intake link delivered — Ada",
    "Intake link created — Ada",
    "Intake delivery failed (SMS)",
    "Request more sent — Leak photos",
  ]);
  assert.equal(groups[0].events[0].href, "/evidence/e1");
});

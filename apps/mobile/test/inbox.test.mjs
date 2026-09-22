/**
 * CONTRACT GUARD — native inbox projection vs the real GET /v1/me/inbox shape
 * (Master Program §19, M3). The unread count lives in metricSummary.unread /
 * scopeSummary.unread — NOT counts.unread or summary.unread. This guard pins that
 * so the screen can never silently regress to a page-local undercount again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/inbox.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const { resolveInboxUnread, resolveInboxRoute } = mod;

test("unread comes from metricSummary.unread (primary)", () => {
  // Shape mirrors me-inbox.routes.ts: metricSummary = { total, unread, byTone }.
  const data = { items: [], metricSummary: { total: 12, unread: 4, byTone: {} }, scopeSummary: { total: 12, unread: 4 } };
  assert.equal(resolveInboxUnread(data), 4);
});

test("falls back to scopeSummary.unread when metricSummary is absent", () => {
  assert.equal(resolveInboxUnread({ scopeSummary: { unread: 7 } }), 7);
});

test("returns null (not 0) when the server omits an unread count", () => {
  assert.equal(resolveInboxUnread({ items: [] }), null);
  assert.equal(resolveInboxUnread({ counts: { unread: 3 } }), null); // legacy field is NOT read
  assert.equal(resolveInboxUnread({ summary: { unread: 3 } }), null); // summary has no unread
  assert.equal(resolveInboxUnread(null), null);
});

test("href routing maps only to real native surfaces", () => {
  assert.equal(resolveInboxRoute("/evidence/e1"), "/evidence/e1");
  assert.equal(resolveInboxRoute("/case/c1"), "/case/c1");
  assert.equal(resolveInboxRoute("/cases/c1"), "/case/c1"); // web plural → native singular
  assert.equal(resolveInboxRoute("/reports/r1"), null); // no native surface
  assert.equal(resolveInboxRoute("https://evil.example/x"), null); // non-relative rejected
  assert.equal(resolveInboxRoute(null), null);
});

/* ------------------------------------------------------------------ added
 * Ordering, filtering and per-item actions — the canonical inbox behaviours
 * native was missing. The page renders "severity-ordered actionable rows" and
 * persists read / unread / dismiss / snooze per item; native had arrival order
 * and mark-read only.
 */

test("unread sorts above read, so acknowledging does not hide the record", () => {
  const out = mod.sortInboxItems([
    { itemKey: "a", title: "read", occurredAt: "2026-03-03T00:00:00Z", isRead: true, tone: "critical" },
    { itemKey: "b", title: "unread", occurredAt: "2026-01-01T00:00:00Z", isRead: false, tone: "low" },
  ]);
  assert.deepEqual(out.map((i) => i.itemKey), ["b", "a"]);
});

test("within the same read state, severity wins over recency", () => {
  const out = mod.sortInboxItems([
    { itemKey: "recent-low", title: "x", occurredAt: "2026-03-03T00:00:00Z", tone: "low" },
    { itemKey: "old-critical", title: "y", occurredAt: "2026-01-01T00:00:00Z", tone: "critical" },
  ]);
  assert.deepEqual(out.map((i) => i.itemKey), ["old-critical", "recent-low"]);
});

test("equal severity falls back to newest first", () => {
  const out = mod.sortInboxItems([
    { itemKey: "older", title: "x", occurredAt: "2026-01-01T00:00:00Z", tone: "medium" },
    { itemKey: "newer", title: "y", occurredAt: "2026-02-01T00:00:00Z", tone: "medium" },
  ]);
  assert.deepEqual(out.map((i) => i.itemKey), ["newer", "older"]);
});

test("an unknown tone sorts last rather than jumping the queue", () => {
  const out = mod.sortInboxItems([
    { itemKey: "weird", title: "x", occurredAt: "2026-03-01T00:00:00Z", tone: "MAUVE" },
    { itemKey: "known", title: "y", occurredAt: "2026-01-01T00:00:00Z", tone: "high" },
  ]);
  assert.deepEqual(out.map((i) => i.itemKey), ["known", "weird"]);
});

test("sorting does not mutate the caller's array", () => {
  const input = [
    { itemKey: "a", title: "x", occurredAt: "2026-01-01T00:00:00Z", tone: "low" },
    { itemKey: "b", title: "y", occurredAt: "2026-02-01T00:00:00Z", tone: "critical" },
  ];
  mod.sortInboxItems(input);
  assert.deepEqual(input.map((i) => i.itemKey), ["a", "b"]);
});

test("the unread filter shows only unread; 'all' shows everything", () => {
  const items = [
    { itemKey: "a", title: "x", occurredAt: "", isRead: true },
    { itemKey: "b", title: "y", occurredAt: "", isRead: false },
  ];
  assert.equal(mod.filterInboxItems(items, "all").length, 2);
  assert.deepEqual(mod.filterInboxItems(items, "unread").map((i) => i.itemKey), ["b"]);
});

test("a category filter matches the item's category", () => {
  const items = [
    { itemKey: "a", title: "x", occurredAt: "", category: "ORG_INVITE" },
    { itemKey: "b", title: "y", occurredAt: "", category: "SUBMISSION" },
  ];
  assert.deepEqual(mod.filterInboxItems(items, "org_invite").map((i) => i.itemKey), ["a"]);
});

test("the action path targets the canonical per-item endpoint", () => {
  assert.equal(mod.inboxItemActionPath("k1", "read"), "/v1/me/inbox/items/k1/read");
  assert.equal(mod.inboxItemActionPath("k1", "snooze"), "/v1/me/inbox/items/k1/snooze");
  assert.equal(
    mod.inboxItemActionPath("a/b c", "dismiss"),
    "/v1/me/inbox/items/a%2Fb%20c/dismiss",
    "the key is encoded — it is not guaranteed to be path-safe",
  );
});

test("a snoozed item is deferred, not gone, and returns when the time passes", () => {
  const now = Date.parse("2026-03-01T00:00:00Z");
  assert.equal(mod.isSnoozed({ snoozedUntil: "2026-03-02T00:00:00Z" }, now), true);
  assert.equal(mod.isSnoozed({ snoozedUntil: "2026-02-01T00:00:00Z" }, now), false);
  assert.equal(mod.isSnoozed({ snoozedUntil: null }, now), false);
  assert.equal(mod.isSnoozed({ snoozedUntil: "not a date" }, now), false);
});

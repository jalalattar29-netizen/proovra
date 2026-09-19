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
const { resolveInboxUnread, resolveInboxRoute } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

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

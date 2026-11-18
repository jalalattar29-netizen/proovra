/**
 * SN-0040 /evidence-archive (Free audit 0ea0, residual coverage §2.5) — the
 * Retention Archive, walked through the real screen and the real apiFetch.
 *
 * Entries: Evidence tab › scope "Trash" › "Archived evidence (retention)"
 * (app/(tabs)/evidence.tsx:773); the web link /evidence/archive
 * (src/deep-link.ts workspacePageDeepLink). Session required (route-access.ts).
 * Server (services/api/src/routes/evidence-retention-verification.routes.ts):
 *   GET  /v1/evidence/retention-archive[?cursor=]   { items, nextCursor }  (50 per page, id-ordered)
 *        ACCOUNT-wide: the caller's personal records + every workspace whose ROLE
 *        holds evidence.archive.view, each re-checked per record — it does not
 *        read the active-workspace header, so a workspace switch cannot stale it.
 *        restore.available = canRestore (evidence.archive.restore) && !inProgress.
 *   POST /v1/evidence/:id/archive-restore { clientRequestKey }
 *        202 { request, deduplicated:false } | 200 { request, deduplicated:true }
 *        403 ARCHIVE_RESTORE_NOT_PERMITTED | 404 | 409 EVIDENCE_NOT_IN_RETENTION_ARCHIVE
 *   GET  /v1/evidence/:id/archive-restore   { request: { status, failureCode, … } | null }
 *
 * Gaps (fail-first), against the web page (apps/web/app/(app)/evidence/archive/page.tsx):
 *   NAT-ARC-01 — `nextCursor` was parsed and dropped: records after the first
 *     50 could not be seen or restored (web: "Load more", :218-222).
 *   NAT-ARC-02 — "Restore" stayed pressable while its request was in flight
 *     (only the label changed): a second tap raised a second confirm and a
 *     second POST under a new key (web: loading, :201).
 *   NAT-ARC-03 — a restore in progress never updated: "Restoring" stayed until
 *     the screen was left (web polls the request every 5 s and refreshes on
 *     COMPLETED/FAILED, :78-98); nothing said the request was taken.
 *   NAT-ARC-04 — a record the caller may view but not restore showed a bare
 *     "Retained" badge; the web says why (:210).
 */
import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests;
let pages;
let restoreStatus;
let restoreAnswer;
let alerts;
const mounted = [];

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n, over = {}) => ({
  id: uuid(n),
  title: `Record ${n}`,
  verificationReference: `PRV-${n}`,
  archivedAtUtc: "2026-10-01T10:00:00.000Z",
  reason: "RETENTION",
  retentionBarrier: "APP_RETENTION",
  earliestPurgeAtUtc: "2027-10-01T10:00:00.000Z",
  legalHold: false,
  restore: { available: true, inProgress: false, lastRequest: null },
  ...over,
});

before(async () => {
  M = await loadModule("app/(stack)/evidence-archive.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  pages = { "": { items: [item(1), item(2)], nextCursor: null } };
  restoreStatus = {};
  restoreAnswer = () => reply(202, { request: { id: "req-1", status: "REQUESTED" }, deduplicated: false });
  alerts = [];
  // Confirm every system alert with its non-cancel button unless a test says otherwise.
  globalThis.__ALERT__ = (title, message, buttons) => {
    alerts.push({ title, message, buttons });
    const go = (buttons ?? []).find((b) => b.style !== "cancel");
    go?.onPress?.();
  };
  globalThis.fetch = async (url, init = {}) => {
    const full = String(url).replace(/^https?:\/\/[^/]+/, "");
    const [path, qs = ""] = full.split("?");
    const method = init.method ?? "GET";
    requests.push({ path, qs, method, body: init.body ? JSON.parse(init.body) : null, workspace: new Headers(init.headers).get("x-proovra-workspace-id") });
    if (path === "/v1/evidence/retention-archive") {
      const cursor = new URLSearchParams(qs).get("cursor") ?? "";
      return reply(200, pages[cursor] ?? { items: [], nextCursor: null });
    }
    const m = path.match(/^\/v1\/evidence\/([^/]+)\/archive-restore$/);
    if (m && method === "POST") return restoreAnswer(m[1]);
    if (m) return reply(200, { request: restoreStatus[m[1]] ?? null });
    return reply(200, {});
  };
  M.calls.reset();
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  mock.timers.reset();
  delete globalThis.__ALERT__;
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const lists = () => requests.filter((q) => q.path === "/v1/evidence/retention-archive");
const restorePosts = () => requests.filter((q) => q.method === "POST");

/* ----------------------------------------------- NAT-ARC-01 (fail-first) */

test("NAT-ARC-01 — a second page is reachable: 'Load more' reads ?cursor= and appends", async () => {
  pages = {
    "": { items: Array.from({ length: 50 }, (_, i) => item(i + 1)), nextCursor: uuid(50) },
    [uuid(50)]: { items: [item(51)], nextCursor: null },
  };
  const r = await render();
  assert.ok(r.hasText("Record 50"));
  assert.ok(!r.hasText("Record 51"));
  await r.press("Load more");
  await settle();
  assert.equal(lists().at(-1).qs, `cursor=${uuid(50)}`);
  assert.ok(r.hasText("Record 1"), "the first page was dropped");
  assert.ok(r.hasText("Record 51"), "the second page was not shown");
  assert.equal(r.byLabel("Load more").length, 0, "Load more offered past the last page");
});

/* ----------------------------------------------- NAT-ARC-02 (fail-first) */

test("NAT-ARC-02 — Restore is not pressable while its request is in flight (one confirm, one POST)", async () => {
  let release;
  restoreAnswer = () => new Promise((res) => { release = () => res(reply(202, { request: { id: "r", status: "REQUESTED" }, deduplicated: false })); });
  const r = await render();
  const firstRestore = () => r.byLabel("Restore").find((n) => n.props.onPress) ?? r.byLabel("Restore")[0];
  await act(async () => { firstRestore().props.onPress(); });
  await settle();
  assert.equal(restorePosts().length, 1);
  // The same row's button, mid-request:
  const busy = r.byTestId(`archive-restore-${uuid(1)}`)[0];
  assert.ok(busy, "the restore button carries no testID");
  assert.equal(busy.props.accessibilityState?.disabled, true, "Restore stayed pressable mid-request");
  release();
  await settle();
});

/* ----------------------------------------------- NAT-ARC-03 (fail-first) */

test("NAT-ARC-03 — a requested restore is confirmed, polled every 5 s, and the list refreshes when it completes", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const r = await render();
  pages = { "": { items: [item(1, { restore: { available: false, inProgress: true, lastRequest: { status: "REQUESTED", failureCode: null, requestedAtUtc: "2026-11-18T10:00:00.000Z" } } }), item(2)], nextCursor: null } };
  await r.press("Restore");
  await settle();
  assert.equal(restorePosts().length, 1);
  assert.match(restorePosts()[0].body.clientRequestKey, /^.{8,120}$/);
  assert.ok(r.hasText("Restore requested — verification has started"), r.texts().join(" | "));
  assert.ok(r.hasText("Verification in progress — this updates automatically."));
  const before = lists().length;
  await act(async () => { mock.timers.tick(5000); });
  await settle();
  assert.ok(requests.some((q) => q.method === "GET" && q.path === `/v1/evidence/${uuid(1)}/archive-restore`), "the restore was never polled");
  assert.equal(lists().length, before, "refreshed while still running");
  restoreStatus[uuid(1)] = { id: "req-1", status: "COMPLETED", failureCode: null };
  pages = { "": { items: [item(2)], nextCursor: null } };
  await act(async () => { mock.timers.tick(5000); });
  await settle();
  assert.equal(lists().length, before + 1);
  assert.ok(!r.hasText("Record 1"), "the restored record is still listed");
  assert.ok(r.hasText("Record restored to your Evidence library"));
  assert.ok(!r.hasText("Loading archived evidence…"), "the refresh blanked the list");
});

test("NAT-ARC-03 — a deduplicated request says a restore is already running", async () => {
  restoreAnswer = () => reply(200, { request: { id: "req-0", status: "RUNNING" }, deduplicated: true });
  const r = await render();
  await r.press("Restore");
  await settle();
  assert.ok(r.hasText("A restore is already in progress for this record"));
});

/* ----------------------------------------------- NAT-ARC-04 (fail-first) */

test("NAT-ARC-04 — a record the caller may not restore says who can", async () => {
  pages = { "": { items: [item(1, { legalHold: null, restore: { available: false, inProgress: false, lastRequest: null } })], nextCursor: null } };
  const r = await render();
  assert.equal(r.byLabel("Restore").length, 0);
  assert.ok(r.hasText("Restoring needs an owner or administrator."), r.texts().join(" | "));
});

/* --------------------------------------------- traced behaviour (pinned) */

test("trace: the list is read once on open, with no workspace filter, and renders each fact", async () => {
  pages = { "": { items: [item(1, { legalHold: true, retentionBarrier: "LEGAL_HOLD" })], nextCursor: null } };
  const r = await render();
  assert.equal(lists().length, 1);
  assert.equal(lists()[0].qs, "");
  const row = r.texts().find((t) => t.includes("Retention — Legal hold"));
  assert.ok(row, r.texts().join(" | "));
  assert.ok(r.hasText("Legal hold active"));
  assert.ok(r.texts().some((t) => t.includes("Not deletable before")));
});

test("trace: empty archive states the shared explainer", async () => {
  pages = { "": { items: [], nextCursor: null } };
  const r = await render();
  assert.ok(r.hasText("No archived evidence"));
});

test("trace: a failed read shows a retry that re-reads", async () => {
  const real = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (url, init) => (fail && String(url).includes("/v1/evidence/retention-archive") ? reply(500, { error: { code: "INTERNAL", message: "pg down" } }) : real(url, init));
  const r = await render();
  assert.ok(!r.hasText("pg down"));
  fail = false;
  await r.press("Try again");
  await settle();
  assert.ok(r.hasText("Record 1"));
});

test("trace: Cancel on the confirm posts nothing", async () => {
  globalThis.__ALERT__ = (title, message, buttons) => {
    alerts.push({ title, message, buttons });
    buttons?.find((b) => b.style === "cancel")?.onPress?.();
  };
  const r = await render();
  await r.press("Restore");
  await settle();
  assert.equal(alerts[0].title, "Restore from the retention archive?");
  assert.equal(restorePosts().length, 0);
});

test("trace: a refused restore (403 ARCHIVE_RESTORE_NOT_PERMITTED) is said, and the list stays", async () => {
  restoreAnswer = () => reply(403, { code: "ARCHIVE_RESTORE_NOT_PERMITTED", message: "You can view this record, but restoring it from the retention archive needs an owner or administrator." });
  const r = await render();
  await r.press("Restore");
  await settle();
  const refusal = alerts.find((a) => a.title === "Could not request the restore");
  assert.ok(refusal, JSON.stringify(alerts.map((a) => a.title)));
  assert.ok(r.hasText("Record 1"));
});

test("trace: a failed last restore states that nothing changed", async () => {
  pages = { "": { items: [item(1, { restore: { available: true, inProgress: false, lastRequest: { status: "FAILED", failureCode: "DIGEST_MISMATCH", requestedAtUtc: null } } })], nextCursor: null } };
  const r = await render();
  assert.ok(r.texts().some((t) => t.includes("The record stays archived and nothing was changed.")));
});

test("trace: no restore is in progress → nothing is polled", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  await render();
  await act(async () => { mock.timers.tick(20000); });
  await settle();
  assert.equal(requests.filter((q) => q.method === "GET" && q.path.endsWith("/archive-restore")).length, 0);
});

test("trace: Back leaves the screen", async () => {
  const r = await render();
  await r.press("Back");
  assert.equal(M.calls.back, 1);
});

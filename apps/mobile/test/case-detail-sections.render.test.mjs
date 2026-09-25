/**
 * Case detail — the web SimpleCaseDetail's five sections on native
 * (SimpleCaseDetail.tsx:124): Overview, Evidence, Reports & Packages, Notes,
 * Settings; the multi-select "Link evidence to case" picker (:1353); and the
 * page's access / not-found states (:267-293).
 *
 * Stubs use the server's own reply shapes:
 *   GET  /v1/cases/:id                      → { case } (cases.routes.ts:868)
 *   GET  /v1/cases/:id/matter-workspace     → envelope (matter-workspace.service.ts:62-420)
 *   GET  /v1/cases/:id/available-evidence   → { items } (cases.routes.ts:1706-1735)
 *   POST /v1/cases/:id/evidence             → { evidence } (cases.routes.ts:1477)
 *   DELETE /v1/cases/:id/evidence/:eid      → { evidence } (cases.routes.ts:1637)
 *   POST /v1/cases/:id/comments             → { comment } (case-workspace.routes.ts:1009)
 *   POST /v1/cases/:id/comments/:c/resolve  → { comment } (case-workspace.routes.ts:1043)
 *   DELETE /v1/cases/:id/comments/:c        → { removed, commentId } (case-lifecycle.service.ts:572)
 *   PATCH /v1/cases/:id                     → the row (cases.routes.ts:1155)
 *   POST /v1/cases/:id/status               → { case } (case-workspace.routes.ts:925)
 *   DELETE /v1/cases/:id                    → 204 (cases.routes.ts:1272)
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];
let viewer = {};
let items = [];
let comments = [];
const CASE = "c0ffee00-0000-4000-8000-00000000000a";
const EV1 = "e1e1e1e1-0000-4000-8000-000000000001";
const EV2 = "e2e2e2e2-0000-4000-8000-000000000002";
const CAND1 = "aaaaaaaa-0000-4000-8000-000000000001";
const CAND2 = "bbbbbbbb-0000-4000-8000-000000000002";
const ME = "user-me";
const ALL = {
  userId: ME, role: "OWNER", canManage: true, canMutate: true, canAssign: true, canChangeStatus: true,
  canLinkEvidence: true, canUnlinkEvidence: true, canUnlinkLegacyEvidence: true, canComment: true,
  canResolveComment: true, canManageAccess: true, disabledReasons: {}, activeAssignmentRoles: [],
};
const out = (report, pkg) => ({ report: { state: report }, verificationPackage: { state: pkg } });
const evidenceItem = (over) => ({
  id: EV1, title: null, displayFileName: "roof.jpg", originalFileName: "IMG_1.jpg", mimeType: "image/jpeg", itemCount: 1,
  type: "PHOTO", status: "SIGNED", verificationStatus: "RECORDED_VERIFIED", lifecycleState: "ACTIVE", createdAt: "2026-09-02T10:00:00.000Z",
  verificationPackageVersion: null, analysisRevision: `ear2_${"A".repeat(43)}`, reportReady: true, packageReady: false,
  outputs: out("READY", "ELIGIBLE_NOT_GENERATED"), linkId: "l1", linkRole: "PRIMARY", linkSource: "MANUAL", ...over,
});
const candidate = (id, over) => ({
  id, title: null, displayFileName: null, originalFileName: `${id.slice(0, 4)}.pdf`, mimeType: "application/pdf", itemCount: 1,
  type: "DOCUMENT", status: "SIGNED", verificationStatus: "FAILED", createdAt: "2026-09-01T10:00:00.000Z",
  reportReady: false, packageReady: false,
  report: { available: false, version: null, generatedAtUtc: null },
  verificationPackage: { available: false, version: null, generatedAtUtc: null },
  ...over,
});

before(async () => {
  M = await loadModule("app/(stack)/case/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { id: CASE };
  requests = [];
  viewer = { ...ALL };
  items = [evidenceItem({}), evidenceItem({ id: EV2, title: "Gutter video", type: "VIDEO", verificationStatus: null, reportReady: false, outputs: out("GENERATING", "NOT_INCLUDED") })];
  comments = [];
  M.calls.reset();
  routes = {
    ...authenticatedRoutes(),
    [`/v1/cases/${CASE}/matter-workspace`]: () => ({
      generatedAt: "2026-09-24T09:00:00.000Z",
      case: { id: CASE, name: "Leaking roof", status: "OPEN" },
      viewer,
      sections: {
        evidence: { status: "ok", items },
        notes: { status: "ok", caseComments: comments, unresolvedReviewerComments: [], unresolvedAnnotations: [] },
      },
    }),
    [`/v1/cases/${CASE}/available-evidence`]: () => ({ items: [candidate(CAND1), candidate(CAND2, { title: "Invoice", verificationStatus: null, reportReady: true })] }),
    [`/v1/cases/${CASE}/evidence`]: () => ({ evidence: { id: "x" } }),
    [`/v1/cases/${CASE}/comments`]: () => ({ comment: { id: "n-new" } }),
    [`/v1/cases/${CASE}/status`]: () => ({ case: { id: CASE, status: "CLOSED" } }),
    [`/v1/cases/${CASE}`]: (method) =>
      method === "DELETE"
        ? { __status: 204 }
        : { case: { id: CASE, name: "Leaking roof", status: "OPEN", teamId: "team-1", access: [], referenceNumber: null, priority: "P2", createdAt: "2026-09-02T10:00:00.000Z", updatedAt: "2026-09-20T08:30:00.000Z" } },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    if (!path.startsWith("/v1/me/presence")) requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method, path) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (tab) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  if (tab) {
    await r.press(tab);
    await settle();
  }
  return r;
};
const sent = (method, path) => requests.filter((q) => q.method === method && q.path === path);

/* ------------------------------------------------------------ page + tabs */

test("the five web sections are tabs; Overview is first and carries the summary and quick actions", async () => {
  const r = await render();
  for (const label of ["Overview", "Evidence", "Reports & Packages", "Notes", "Settings"]) {
    assert.equal(r.byLabel(label).filter((n) => n.props.accessibilityRole === "tab").length, 1, `${label} tab missing`);
  }
  assert.ok(r.hasText("Evidence records") && r.hasText("End-to-end ready") && r.hasText("Verification links"), "overview metrics missing");
  assert.ok(r.hasText("1 of 2"), "the report/package ratios were not computed from the envelope");
  assert.ok(r.hasText("Quick actions") && r.byLabel("Create verification package").length === 1);
  r.unmount();
});

test("a ?tab= deep link opens that section (the web row menu links to ?tab=settings)", async () => {
  globalThis.__EXPO_PARAMS__ = { id: CASE, tab: "settings" };
  const r = await render();
  assert.ok(r.hasText("Status & lifecycle") && r.hasText("Case details"));
  r.unmount();
});

test("403 and 404 are stated as themselves, not as a generic error", async () => {
  routes[`/v1/cases/${CASE}`] = () => ({ __status: 403, message: "Forbidden" });
  let r = await render();
  assert.ok(r.hasText("You don't have access to this case.") && r.hasText("Ask a workspace owner or administrator if you need access."));
  r.unmount();
  routes[`/v1/cases/${CASE}`] = () => ({ __status: 404, message: "Case not found" });
  r = await render();
  assert.ok(r.hasText("The case may have been deleted or moved."));
  await r.press("Back to cases");
  r.unmount();
});

test("a workspace envelope that fails is an error with retry, never an empty case", async () => {
  routes[`/v1/cases/${CASE}/matter-workspace`] = () => ({ __status: 500, message: "boom" });
  const r = await render();
  assert.ok(r.hasText("Could not load this case's evidence and notes."));
  assert.ok(!r.hasText("No evidence linked yet"), "a failed read was rendered as an empty case");
  r.unmount();
});

/* --------------------------------------------------------------- evidence */

test("Evidence lists the envelope's records with the web meta line, and search filters them", async () => {
  const r = await render("Evidence");
  assert.ok(r.hasText("roof.jpg"), "the title cascade was not applied");
  assert.ok(r.hasText("e1e1e1e1 • PHOTO • SIGNED • recorded verified • Report ready • Package not generated"));
  assert.ok(r.hasText("Report generating • Package not included"));
  await r.type("Search linked evidence by name, type, or record ID", "video");
  assert.equal(r.byTestId(`case-evidence-${EV1}`).length, 0, "the search did not filter");
  assert.equal(r.byTestId(`case-evidence-${EV2}`).length, 1);
  await r.type("Search linked evidence by name, type, or record ID", "nothing-like-this");
  assert.ok(r.hasText("No linked evidence matches your search."));
  r.unmount();
});

test("Remove from case confirms with the preservation sentence, then unlinks", async () => {
  const r = await render("Evidence");
  await r.press("Remove roof.jpg from case");
  assert.ok(r.hasText('Remove "roof.jpg" from this case?'));
  assert.ok(r.hasText("This removes the evidence from this case only. The evidence record itself will remain preserved."));
  await r.press("Remove from case");
  await settle();
  assert.equal(sent("DELETE", `/v1/cases/${CASE}/evidence/${EV1}`).length, 1);
  assert.ok(r.hasText("Evidence removed from this case."));
  r.unmount();
});

test("without either unlink capability Remove is disabled and the server's reason is shown", async () => {
  viewer = { ...ALL, canUnlinkEvidence: false, canUnlinkLegacyEvidence: false, disabledReasons: { unlinkEvidence: "Only editors can unlink evidence." } };
  const r = await render("Evidence");
  const btn = r.byLabel("Remove roof.jpg from case")[0];
  assert.equal(btn.props.accessibilityState.disabled, true);
  assert.ok(r.hasText("Only editors can unlink evidence."));
  r.unmount();
});

test("an empty case says how to add evidence", async () => {
  items = [];
  const r = await render("Evidence");
  assert.ok(r.hasText("No evidence linked yet.") && r.hasText("Use Add evidence above to link files, photos, videos, or documents to this case."));
  r.unmount();
});

/* ---------------------------------------------------------------- attach */

test("the picker is multi-select: one POST per record, and a failure keeps that row selected", async () => {
  let n = 0;
  routes[`/v1/cases/${CASE}/evidence`] = () => (++n === 2 ? { __status: 409, message: "conflict" } : { evidence: { id: "x" } });
  const r = await render();
  await r.press("Add evidence");
  await settle();
  assert.ok(r.hasText("Link evidence to case") && r.hasText("Choose an existing evidence record from this workspace."));
  assert.ok(r.hasText("aaaa.pdf") && r.hasText("Invoice"), "candidate titles missing");
  assert.ok(r.hasText("failed"), "the integrity state was not shown");
  assert.ok(r.hasText("Select one or more evidence records"));
  await r.press("aaaa.pdf");
  await r.press("Invoice");
  assert.ok(r.hasText("2 evidence records selected"));
  await r.press("Link 2 selected evidence records");
  await settle();
  const posts = sent("POST", `/v1/cases/${CASE}/evidence`);
  assert.deepEqual(posts.map((p) => p.body.evidenceId), [CAND1, CAND2]);
  // Partial success closes the picker (as the web does) and says what happened.
  assert.ok(r.hasText("1 evidence record linked. 1 could not be linked."));
  assert.equal(r.byTestId("case-attach-sheet").length, 0);
  r.unmount();
});

test("when every record fails the picker stays open with the selection and says so", async () => {
  routes[`/v1/cases/${CASE}/evidence`] = () => ({ __status: 409, message: "conflict" });
  const r = await render();
  await r.press("Add evidence");
  await settle();
  await r.press("Invoice");
  assert.equal(r.byLabel("Link selected evidence").length, 1, "a single selection must read Link selected evidence");
  await r.press("Link selected evidence");
  await settle();
  assert.equal(r.byTestId("case-attach-sheet").length, 1, "the picker closed on a total failure");
  assert.ok(r.hasText("One evidence record could not be linked. It is still selected — try again."));
  assert.ok(r.hasText("1 evidence record selected"));
  assert.ok(r.hasText("Could not link the selected evidence record."));
  r.unmount();
});

test("the picker separates a refusal from an empty workspace", async () => {
  routes[`/v1/cases/${CASE}/available-evidence`] = () => ({ __status: 403, message: "Forbidden" });
  let r = await render();
  await r.press("Add evidence");
  await settle();
  assert.ok(r.hasText("You do not have access to this workspace's evidence. Ask a workspace administrator for access."));
  r.unmount();
  routes[`/v1/cases/${CASE}/available-evidence`] = () => ({ items: [] });
  r = await render();
  await r.press("Add evidence");
  await settle();
  assert.ok(r.hasText("No available evidence to link. Upload or capture evidence first, then return to this case."));
  r.unmount();
});

/* ------------------------------------------------------------------ notes */

test("a note is written PRIVATE, as the web writes it", async () => {
  const r = await render("Notes");
  assert.ok(r.hasText("Private case notes") && r.hasText("Notes you add appear here, newest activity first."));
  await r.type("Write a private note for this case", "  Called the adjuster  ");
  await r.press("Add note");
  await settle();
  assert.deepEqual(sent("POST", `/v1/cases/${CASE}/comments`)[0].body, { body: "Called the adjuster", visibility: "INTERNAL" });
  assert.ok(r.hasText("Note added."));
  r.unmount();
});

test("resolve sends no body and there is no Reopen; Delete is offered only on the viewer's own notes", async () => {
  comments = [
    { id: "n1", authorUserId: ME, body: "Mine", visibility: "INTERNAL", resolvedAtUtc: null, resolvedByUserId: null, createdAt: "2026-09-20T10:00:00.000Z" },
    { id: "n2", authorUserId: "someone-else", body: "Theirs", visibility: "INTERNAL", resolvedAtUtc: "2026-09-21T10:00:00.000Z", resolvedByUserId: ME, createdAt: "2026-09-19T10:00:00.000Z" },
  ];
  const r = await render("Notes");
  assert.equal(r.byLabel("Mark resolved").length, 1, "a resolved note offered to resolve again");
  assert.equal(r.byLabel("Reopen").length, 0, "the route has no reopen");
  assert.equal(r.byLabel("Delete note").length, 1, "Delete was offered on someone else's note");
  assert.ok(r.texts().some((t) => t.includes("resolved Sep 21, 2026")));
  await r.press("Mark resolved");
  await settle();
  assert.deepEqual(sent("POST", `/v1/cases/${CASE}/comments/n1/resolve`)[0].body, {});
  await r.press("Delete note");
  assert.ok(r.hasText("Delete this note?"));
  const confirmDelete = r.byLabel("Delete note").at(-1);
  await act(async () => { await confirmDelete.props.onPress(); });
  await settle();
  assert.equal(sent("DELETE", `/v1/cases/${CASE}/comments/n1`).length, 1);
  r.unmount();
});

test("without comment permission the composer is replaced by the web's sentence", async () => {
  viewer = { ...ALL, canComment: false };
  const r = await render("Notes");
  assert.ok(r.hasText("You don't have permission to add notes on this case."));
  assert.equal(r.byLabel("Write a private note for this case").length, 0);
  r.unmount();
});

/* --------------------------------------------------------------- settings */

test("rename saves only a changed name; status changes after an organisational-only confirmation", async () => {
  const r = await render("Settings");
  const save = () => r.byLabel("Save")[0];
  assert.equal(save().props.accessibilityState.disabled, true, "Save was enabled for an unchanged name");
  await r.type("Case name", "Leaking roof — unit 4");
  await r.press("Save");
  await settle();
  assert.deepEqual(sent("PATCH", `/v1/cases/${CASE}`)[0].body, { name: "Leaking roof — unit 4" });
  assert.ok(r.hasText("Case name updated."));

  await r.press("Set status Closed");
  assert.ok(r.hasText("Change this case from Open to Closed? This only updates case organization. Linked evidence, reports, verification packages, notes, and audit history remain unchanged."));
  await r.press("Change status");
  await settle();
  assert.deepEqual(sent("POST", `/v1/cases/${CASE}/status`)[0].body, { toStatus: "CLOSED" });
  r.unmount();
});

test("delete states how many records are unlinked, is owner/admin only, and sends DELETE", async () => {
  viewer = { ...ALL, canManage: false };
  let r = await render("Settings");
  assert.ok(r.hasText("2 evidence records will be unlinked from this case but kept in the library."));
  assert.ok(r.hasText("Only the case owner or an admin can delete this case."));
  assert.equal(r.byLabel("Delete case")[0].props.accessibilityState.disabled, true);
  r.unmount();
  viewer = { ...ALL };
  r = await render("Settings");
  await r.press("Delete case");
  assert.ok(r.hasText("Delete this case?"));
  const confirm = r.byLabel("Delete case").at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.equal(sent("DELETE", `/v1/cases/${CASE}`).length, 1);
  assert.ok(r.hasText("Case deleted. Evidence records were preserved."));
  r.unmount();
});

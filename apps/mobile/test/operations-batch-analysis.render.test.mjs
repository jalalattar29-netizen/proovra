/**
 * Operations › Batch analysis — render test of the REAL screen
 * (`app/(stack)/operations/batch-analysis.tsx`, web
 * `operations/batch-analysis/page.tsx`).
 *
 * Every payload is the server's own reply, from
 * `services/api/src/routes/enterprise.routes.ts` (all behind
 * requireAuthAndLegal → 428 LEGAL_REACCEPT_REQUIRED when policies are owed):
 *   GET  /v1/batch-analysis              { data: [{ id, name, status, totalItems,
 *                                          processedItems, failedItems, createdAt,
 *                                          completedAt, progress }] }
 *   POST /v1/batch-analysis              body { evidenceIds[], name, description? }
 *                                        → { data: { id, name, status, ... }, message }
 *                                        Every id must be the caller's own undeleted
 *                                        evidence (404 EVIDENCE_NOT_FOUND otherwise) and
 *                                        all from ONE workspace (400 VALIDATION_ERROR).
 *   POST /v1/batch-analysis/:id/process  → { message, data: { jobId, status } }
 *   POST /v1/batch-analysis/:id/cancel   → { message } | 409 CONFLICT when terminal
 *   GET  /v1/batch-analysis/:id/export   text/csv
 * Statuses are the service's lower-case BatchStatus values.
 *
 * The record picker reads `GET /v1/evidence` (evidence.routes.ts), which
 * answers `{ scope, items, pageInfo }`; each item carries `teamId` and
 * `ownerUserId`, and an explicit `teamId` query pins the list to that
 * workspace.
 */
import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let jobs;
let handlers;

const reply = (status, body, contentType = "application/json") => ({ __status: status, body, contentType });
const apiError = (status, code, message) => reply(status, { error: { code, message, requestId: "req-9", timestamp: "2026-09-25T10:00:00.000Z" } });

const job = (over) => ({
  id: "job-x",
  name: "Job",
  status: "completed",
  totalItems: 2,
  processedItems: 2,
  failedItems: 0,
  createdAt: "2026-09-20T10:00:00.000Z",
  completedAt: null,
  progress: 100,
  ...over,
});
const seedJobs = () => [
  job({ id: "job-old", name: "Old completed batch", status: "completed", totalItems: 4, processedItems: 3, failedItems: 1, createdAt: "2026-09-10T10:00:00.000Z", completedAt: "2026-09-10T10:05:00.000Z", progress: 100 }),
  job({ id: "job-run", name: "Running batch", status: "processing", totalItems: 10, processedItems: 4, failedItems: 1, createdAt: "2026-09-24T10:00:00.000Z", completedAt: null, progress: 50 }),
  job({ id: "job-wait", name: "Queued batch", status: "pending", totalItems: 3, processedItems: 0, failedItems: 0, createdAt: "2026-09-22T10:00:00.000Z", completedAt: null, progress: 0 }),
];

/** A GET /v1/evidence item in mapEvidenceListItem's shape (the fields the picker can use). */
const ev = (id, title, over = {}) => ({
  id,
  title,
  type: "PHOTO",
  status: "SIGNED",
  teamId: TEST_TEAM_ID,
  ownerUserId: "user-1",
  createdAt: "2026-09-20T10:00:00.000Z",
  ...over,
});
const evidenceList = () => ({
  scope: "active",
  items: [
    ev("ev-1", "Front door photo"),
    ev("ev-2", "Hallway video", { type: "VIDEO" }),
    // A team-mate's record in the same workspace: listed by GET /v1/evidence,
    // refused by the create route (ownerUserId must be the caller).
    ev("ev-3", "Colleague upload", { ownerUserId: "user-2" }),
  ],
  pageInfo: { limit: 50, nextCursor: null, hasMore: false },
});

before(async () => {
  M = await loadModule("app/(stack)/operations/batch-analysis.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.push.length = 0;
  jobs = seedJobs();
  handlers = {
    list: () => ({ data: jobs }),
    evidence: () => evidenceList(),
    create: (body) => ({
      data: { id: "job-new", name: body.name, status: "pending", totalItems: body.evidenceIds.length, processedItems: 0, failedItems: 0, createdAt: "2026-09-25T09:00:00.000Z" },
      message: "Batch job created. Call /batch-analysis/{id}/process to start.",
    }),
    process: (id) => {
      jobs = [job({ id, name: "Created", status: "processing", totalItems: 2, processedItems: 0, failedItems: 0, createdAt: "2026-09-25T09:00:00.000Z", progress: 0 }), ...jobs];
      return { message: "Batch processing started", data: { jobId: id, status: "processing" } };
    },
    cancel: (id) => {
      jobs = jobs.map((j) => (j.id === id ? { ...j, status: "cancelled", completedAt: "2026-09-25T09:30:00.000Z" } : j));
      return { message: "Batch job cancelled" };
    },
    exportCsv: () => reply(200, "evidenceId,status\nev-1,completed\n", "text/csv"),
  };
  const auth = authenticatedRoutes();
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const bare = path.split("?")[0];
    let res;
    let m;
    if (auth[bare]) res = auth[bare]();
    else if (bare === "/v1/batch-analysis" && method === "GET") res = handlers.list();
    else if (bare === "/v1/batch-analysis" && method === "POST") res = handlers.create(body);
    else if ((m = bare.match(/^\/v1\/batch-analysis\/([^/]+)\/process$/)) && method === "POST") res = handlers.process(m[1]);
    else if ((m = bare.match(/^\/v1\/batch-analysis\/([^/]+)\/cancel$/)) && method === "POST") res = handlers.cancel(m[1]);
    else if ((m = bare.match(/^\/v1\/batch-analysis\/([^/]+)\/export$/)) && method === "GET") res = handlers.exportCsv(m[1]);
    else if (bare === "/v1/evidence" && method === "GET") res = handlers.evidence(path);
    const status = res === undefined ? 404 : res.__status ?? 200;
    const payload = res && "__status" in res ? res.body : res ?? {};
    const ct = res?.contentType ?? "application/json";
    return new Response(ct === "application/json" ? JSON.stringify(payload) : payload, { status, headers: { "content-type": ct } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
// Every rendered screen is unmounted after its test even when an assertion
// throws first: a screen left mounted with a running job keeps a real 4 s
// poll alive and the run never exits.
let mountedRenders = [];
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mountedRenders.push(r);
  await settle();
  return r;
};
afterEach(() => {
  for (const r of mountedRenders) {
    try { r.unmount(); } catch { /* already unmounted */ }
  }
  mountedRenders = [];
});
const batchCalls = () => requests.filter((q) => q.path.startsWith("/v1/batch-analysis") || q.path.startsWith("/v1/evidence"));
/** What the user can see while a sheet is open: the text INSIDE the Modal. */
const sheetTexts = (r) =>
  r.root
    .findAll((n) => n.type === "Modal")
    .flatMap((m) =>
      m
        .findAll((n) => n.type === "Text")
        .map((n) => [n.props.children].flat(4).filter((c) => typeof c === "string" || typeof c === "number").join("")),
    );
const pressLast = async (r, label) => {
  const hits = r.byLabel(label).filter((n) => n.props.onPress);
  assert.ok(hits.length > 0, `no pressable "${label}"`);
  const target = hits.at(-1);
  await act(async () => { await target.props.onPress(); });
  await settle();
};
/* ------------------------------------------------------------------ list */

test("loaded: jobs newest-first with status, counts, progress; actions only where the server acts", async () => {
  const r = await render();
  assert.deepEqual(
    batchCalls().map((q) => `${q.method} ${q.path}`),
    ["GET /v1/batch-analysis"],
    "the list is user-scoped on the server: no query, no workspace param",
  );
  assert.ok(r.hasText("3 jobs on this page"));
  const names = r.texts().filter((t) => ["Old completed batch", "Running batch", "Queued batch"].includes(t));
  assert.deepEqual(names, ["Running batch", "Queued batch", "Old completed batch"]);
  assert.ok(r.hasText("4 processed · 1 failed · 10 total"));
  assert.ok(r.hasText("3 processed · 1 failed · 4 total"));
  for (const s of ["Processing", "Pending", "Completed"]) assert.ok(r.hasText(s), s);
  const bars = r.byRole("progressbar").map((n) => n.props.accessibilityLabel).filter((l) => /complete$/.test(l));
  assert.deepEqual(bars, ["Running batch: 50% complete", "Queued batch: 0% complete", "Old completed batch: 100% complete"]);
  assert.ok(r.texts().some((t) => t.startsWith("Completed ")), "the completion time is not shown");
  // Export: COMPLETED only (the web's exact condition). Cancel: pending + processing (cancelJob acts on both).
  assert.equal(r.byLabel("Export CSV").filter((n) => n.props.onPress).length, 1);
  assert.equal(r.byLabel("Cancel job").filter((n) => n.props.onPress).length, 2);
  assert.ok(r.hasText("This batch reads each record's metadata only."));
  r.unmount();
});

test("a zero-item job states it has no progress rather than drawing a NaN bar", async () => {
  // The list route computes progress as (processed+failed)/totalItems with no
  // guard, so a zero-item job arrives as NaN — which JSON serialises to null.
  jobs = [job({ id: "job-zero", name: "Zero items", status: "completed", totalItems: 0, processedItems: 0, failedItems: 0, progress: null })];
  const r = await render();
  assert.ok(r.hasText("This job declares no items, so it has no progress to report."));
  assert.equal(r.byRole("progressbar").filter((n) => /complete$/.test(n.props.accessibilityLabel)).length, 0);
  r.unmount();
});

test("empty: no jobs shows the empty state, and its action opens the composer", async () => {
  jobs = [];
  const r = await render();
  assert.ok(r.hasText("No Batch Jobs"));
  assert.ok(r.hasText("Create your first batch job to analyze multiple evidence items"));
  await pressLast(r, "Create Batch Job");
  assert.ok(r.byLabel("Batch name").length > 0, "the composer did not open");
  r.unmount();
});

test("failure: a 500 list read is stated, and Try again re-reads", async () => {
  handlers.list = () => apiError(500, "INTERNAL_SERVER_ERROR", "Failed to list batch jobs");
  const r = await render();
  assert.ok(r.hasText("Batch jobs could not be loaded."));
  assert.ok(!r.hasText("Failed to list batch jobs"), "raw server message leaked");
  handlers.list = () => ({ data: jobs });
  await r.press("Try again");
  await settle();
  assert.equal(batchCalls().filter((q) => q.method === "GET" && q.path === "/v1/batch-analysis").length, 2);
  assert.ok(r.hasText("Running batch"));
  r.unmount();
});

test("the legal gate (428) routes to acceptance and the list states it could not load", async () => {
  handlers.list = () =>
    reply(428, { error: { code: "LEGAL_REACCEPT_REQUIRED", message: "You must accept the latest legal policies before continuing.", details: { missingPolicies: ["privacy"] } } });
  const r = await render();
  assert.ok(r.hasText("Batch jobs could not be loaded."));
  assert.ok(M.calls.push.some((c) => c && c.pathname === "/legal-acceptance" && c.params?.policies === "privacy"));
  r.unmount();
});

/* ---------------------------------------------------------------- create */

test("the picker reads the caller's own active evidence IN the active workspace — the only records the create route accepts", async () => {
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  const read = batchCalls().find((q) => q.path.startsWith("/v1/evidence"));
  assert.ok(read, "the picker never read /v1/evidence");
  const q = new URL(`http://x${read.path}`).searchParams;
  assert.equal(q.get("scope"), "active");
  assert.equal(q.get("sort"), "newest");
  assert.equal(q.get("limit"), "50");
  assert.equal(q.get("teamId"), TEST_TEAM_ID, "the picker spans every workspace, but a batch may only span one");
  assert.ok(r.byLabel("Front door photo").length > 0 && r.byLabel("Hallway video").length > 0);
  assert.equal(r.byLabel("Colleague upload").length, 0, "offered a team-mate's record the create route refuses (EVIDENCE_NOT_FOUND)");
  r.unmount();
});

test("create: validation holds the button until a name and a record are chosen", async () => {
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  assert.ok(r.hasText("Give this batch a name."));
  await r.press("Create & Start Batch");
  await r.type("Batch name", "Doorway set");
  assert.ok(r.hasText("Choose at least one evidence record."));
  await r.press("Create & Start Batch");
  assert.equal(batchCalls().filter((q) => q.method === "POST").length, 0, "a request was sent for an invalid draft");
  r.unmount();
});

test("create: posts the route's body, then starts the job, then re-reads the list", async () => {
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  await r.type("Batch name", "  Doorway set  ");
  await r.type("Batch description", "  Night of the 20th  ");
  await r.press("Front door photo");
  await r.press("Hallway video");
  assert.ok(r.hasText("2 records chosen."));
  assert.equal(r.texts().filter((t) => t === "Chosen").length, 2);
  // Unchoose and choose again: toggling works both ways.
  await r.press("Hallway video");
  assert.ok(r.hasText("1 record chosen."));
  await r.press("Hallway video");

  const before = batchCalls().length;
  await r.press("Create & Start Batch");
  await settle();
  const after = batchCalls().slice(before);
  assert.deepEqual(after.map((q) => `${q.method} ${q.path}`), [
    "POST /v1/batch-analysis",
    "POST /v1/batch-analysis/job-new/process",
    "GET /v1/batch-analysis",
  ]);
  assert.deepEqual(after[0].body, { name: "Doorway set", evidenceIds: ["ev-1", "ev-2"], description: "Night of the 20th" });
  assert.equal(after[1].body, null, "process takes no body");
  assert.ok(r.hasText("Batch job created and processing started."));
  assert.equal(r.byLabel("Batch name").length, 0, "the composer stayed open");
  assert.ok(r.hasText("Created"));
  r.unmount();
});

test("create: an empty description is absent from the body, not sent as \"\"", async () => {
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  await r.type("Batch name", "One record");
  await r.type("Batch description", "   ");
  await r.press("Front door photo");
  await r.press("Create & Start Batch");
  await settle();
  const post = batchCalls().find((q) => q.method === "POST" && q.path === "/v1/batch-analysis");
  assert.deepEqual(post.body, { name: "One record", evidenceIds: ["ev-1"] });
  assert.ok(!("description" in post.body));
  r.unmount();
});

test("create: a server refusal is shown safely, and the job is not started", async () => {
  handlers.create = () => apiError(400, "VALIDATION_ERROR", "A batch job analyses evidence from one workspace. These items span more than one.");
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  await r.type("Batch name", "Mixed");
  await r.press("Front door photo");
  await r.press("Create & Start Batch");
  await settle();
  assert.equal(batchCalls().filter((q) => q.path.endsWith("/process")).length, 0);
  assert.ok(r.byLabel("Batch name").length > 0, "the composer closed on a failure");
  // VALIDATION_ERROR is an explained code, so the canonical safe copy is shown —
  // and INSIDE the sheet, which is a Modal covering the page-level message.
  assert.ok(
    sheetTexts(r).includes("Some details need attention before we can continue."),
    `the refusal is not visible in the open sheet: ${JSON.stringify(sheetTexts(r))}`,
  );
  assert.ok(!r.texts().some((t) => t.includes("req-9")), "the request id was pasted into the message");
  assert.ok(!r.hasText("Batch job created and processing started."));

  // Closing and starting a new draft does not carry the old refusal into it.
  await pressLast(r, "Close");
  await pressLast(r, "+ New Batch Job");
  assert.ok(
    !sheetTexts(r).includes("Some details need attention before we can continue."),
    "stale message in a fresh draft",
  );
  r.unmount();
});

test("create: a create reply with no id is reported, and nothing is started", async () => {
  handlers.create = () => ({ message: "Batch job created. Call /batch-analysis/{id}/process to start." });
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  await r.type("Batch name", "No id");
  await r.press("Front door photo");
  await r.press("Create & Start Batch");
  await settle();
  assert.ok(sheetTexts(r).includes("The job was created but the server did not return its id."));
  assert.equal(batchCalls().filter((q) => q.path.endsWith("/process")).length, 0);
  r.unmount();
});

test("the picker search re-reads /v1/evidence with the search term, and an empty answer says so", async () => {
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  handlers.evidence = () => ({ scope: "active", items: [], pageInfo: { limit: 50, nextCursor: null, hasMore: false } });
  await r.type("Search evidence", "nothing here");
  await settle();
  const last = batchCalls().filter((q) => q.path.startsWith("/v1/evidence")).at(-1);
  assert.equal(new URL(`http://x${last.path}`).searchParams.get("search"), "nothing here");
  assert.ok(r.hasText("No records match that."));
  r.unmount();
});

/* ---------------------------------------------------------------- cancel */

test("cancel: confirm posts to /cancel with no body, re-reads, and says so; Keep running sends nothing", async () => {
  const r = await render();
  // Keep running first.
  await act(async () => { await r.byLabel("Cancel job").filter((n) => n.props.onPress)[0].props.onPress(); });
  assert.ok(r.hasText("Cancel this batch job?"));
  assert.ok(r.hasText("In-progress items will stop. Already completed items keep their results."));
  await pressLast(r, "Keep running");
  assert.ok(!r.hasText("Cancel this batch job?"));
  assert.equal(batchCalls().filter((q) => q.path.endsWith("/cancel")).length, 0);

  // Then the processing job ("Running batch" is first, newest).
  await act(async () => { await r.byLabel("Cancel job").filter((n) => n.props.onPress)[0].props.onPress(); });
  const before = batchCalls().length;
  await pressLast(r, "Cancel job");
  const after = batchCalls().slice(before);
  assert.deepEqual(after.map((q) => `${q.method} ${q.path}`), ["POST /v1/batch-analysis/job-run/cancel", "GET /v1/batch-analysis"]);
  assert.equal(after[0].body, null);
  assert.ok(r.hasText("That job was cancelled."));
  assert.ok(r.hasText("Cancelled"));
  // One fewer cancel; a CANCELLED job is not offered export (the web offers
  // it on `status === "completed"` only), so the count stays at 1.
  assert.equal(r.byLabel("Cancel job").filter((n) => n.props.onPress).length, 1);
  assert.equal(r.byLabel("Export CSV").filter((n) => n.props.onPress).length, 1);
  r.unmount();
});

test("cancel: the route's 409 (already finished) is shown and not reported as a cancellation", async () => {
  handlers.cancel = () => apiError(409, "CONFLICT", "This batch job has already finished and cannot be cancelled.");
  const r = await render();
  await act(async () => { await r.byLabel("Cancel job").filter((n) => n.props.onPress)[0].props.onPress(); });
  await pressLast(r, "Cancel job");
  assert.ok(!r.hasText("That job was cancelled."));
  assert.ok(!r.hasText("This batch job has already finished"), "raw server message leaked");
  assert.ok(r.hasText("Please review your input and try again."), "the refusal was not stated in the web 4xx words");
  assert.equal(batchCalls().filter((q) => q.path.endsWith("/cancel")).length, 1);
  r.unmount();
});

/* ---------------------------------------------------------------- export */

test("export: reads /:id/export as text from the server's exact path; a device-side failure is not blamed on the connection", async () => {
  globalThis.__SHARED__ = [];
  globalThis.__WRITTEN__ = {};
  const r = await render();
  await r.press("Export CSV");
  await settle();
  const exp = batchCalls().filter((q) => q.path.includes("/export"));
  assert.deepEqual(exp.map((q) => `${q.method} ${q.path}`), ["GET /v1/batch-analysis/job-old/export"]);
  // The CSV arrived (200 text/csv). Whatever the device does with it next —
  // share it, or fail to write it — is not a transport failure. (The harness
  // file-system stub has no writeAsStringAsync, which stands in for a device
  // write failure here.)
  assert.ok(!r.hasText("Check your connection and try again."), "a local write failure was reported as a network failure");
  assert.ok(!r.texts().some((t) => /JSON|Unexpected token/.test(t)), "the CSV was parsed as JSON");
  // The FILE reaches the share sheet with its type (expo-sharing) — Share.share({url})
  // shared only the file NAME on Android.
  assert.equal(globalThis.__SHARED__.length, 1, "nothing was shared");
  const shared = globalThis.__SHARED__[0];
  assert.match(shared.uri, /\.csv$/);
  assert.equal(shared.options.mimeType, "text/csv");
  assert.equal(typeof globalThis.__WRITTEN__[shared.uri], "string", "the shared file was never written");
  r.unmount();
});

test("export: a server failure is shown safely and nothing is shared", async () => {
  handlers.exportCsv = () => apiError(404, "NOT_FOUND", "Batch job not found");
  const r = await render();
  await r.press("Export CSV");
  await settle();
  assert.equal(batchCalls().filter((q) => q.path.includes("/export")).length, 1);
  assert.ok(r.hasText("The item may have moved or is no longer available. Refresh and try again."));
  assert.ok(!r.texts().some((t) => t.includes("req-9")));
  r.unmount();
});

test("Back returns to the previous screen", async () => {
  const r = await render();
  const before = M.calls.back;
  await r.press("Back");
  assert.equal(M.calls.back, before + 1);
  r.unmount();
});


test("export is offered on COMPLETED jobs only, never on failed or cancelled (web: job.status === \"completed\")", async () => {
  jobs = [
    job({ id: "job-done", name: "Done batch", status: "completed", createdAt: "2026-09-20T10:00:00.000Z" }),
    job({ id: "job-bad", name: "Failed batch", status: "failed", processedItems: 0, failedItems: 2, createdAt: "2026-09-19T10:00:00.000Z" }),
    job({ id: "job-stop", name: "Stopped batch", status: "cancelled", processedItems: 1, createdAt: "2026-09-18T10:00:00.000Z" }),
  ];
  const r = await render();
  const exports = r.byLabel("Export CSV").filter((n) => n.props.onPress);
  assert.equal(exports.length, 1, "export offered on a failed or cancelled job");
  await act(async () => { await exports[0].props.onPress(); });
  await settle();
  assert.deepEqual(
    batchCalls().filter((q) => q.path.includes("/export")).map((q) => q.path),
    ["/v1/batch-analysis/job-done/export"],
  );
  r.unmount();
});

/* --------------------------------------------------------------- polling */
// The web re-reads GET /v1/batch-analysis every 4000 ms. Only setInterval is
// mocked: `settle` and React's scheduler keep the real setTimeout.

const listReads = () => requests.filter((q) => q.method === "GET" && q.path === "/v1/batch-analysis").length;
const tick = async (ms) => {
  await act(async () => { mock.timers.tick(ms); });
  await settle();
};

afterEach(() => {
  mock.timers.reset();
});

test("polling: while a job is pending/processing the list is re-read every 4 s, silently", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const r = await render();
  assert.equal(listReads(), 1);
  await tick(3999);
  assert.equal(listReads(), 1, "re-read before the 4 s interval");
  await tick(1);
  assert.equal(listReads(), 2, "a running job did not cause a re-read after 4 s");
  assert.ok(!r.hasText("Loading jobs"), "the poll blanked the list with a loading state");
  await tick(4000);
  assert.equal(listReads(), 3);
  r.unmount();
});

test("polling: progress arrives, and polling stops once no job is running", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  jobs = [job({ id: "job-run", name: "Running batch", status: "processing", totalItems: 10, processedItems: 4, failedItems: 1, progress: 50 })];
  const r = await render();
  jobs = [job({ id: "job-run", name: "Running batch", status: "completed", totalItems: 10, processedItems: 9, failedItems: 1, progress: 100, completedAt: "2026-09-25T09:30:00.000Z" })];
  await tick(4000);
  assert.equal(listReads(), 2);
  assert.ok(r.hasText("9 processed · 1 failed · 10 total"), "the poll's answer was not rendered");
  await tick(20000);
  assert.equal(listReads(), 2, "kept polling after every job finished");
  r.unmount();
});

test("polling: a list with no running job is not polled", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  jobs = [
    job({ id: "job-a", status: "completed" }),
    job({ id: "job-b", status: "failed" }),
    job({ id: "job-c", status: "cancelled" }),
  ];
  const r = await render();
  await tick(20000);
  assert.equal(listReads(), 1);
  r.unmount();
});

test("polling: unmount stops it", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const r = await render();
  await tick(4000);
  assert.equal(listReads(), 2, "no poll ran before unmount");
  r.unmount();
  await tick(20000);
  assert.equal(listReads(), 2, "polled after unmount");
});

test("polling: a tick never overlaps a read still in flight", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const r = await render();
  const realFetch = globalThis.fetch;
  let release;
  const gate = new Promise((x) => { release = x; });
  globalThis.fetch = async (url, init) => {
    const res = realFetch(url, init);
    if (String(url).endsWith("/v1/batch-analysis") && (init?.method ?? "GET") === "GET") await gate;
    return res;
  };
  await tick(4000);
  assert.equal(listReads(), 2);
  await tick(4000);
  await tick(4000);
  assert.equal(listReads(), 2, "a poll started while the previous read was still outstanding");
  release();
  await settle();
  await tick(4000);
  assert.equal(listReads(), 3, "polling did not resume after the slow read landed");
  r.unmount();
});

/* ---- web parity (operations/batch-analysis/page.tsx: header, metrics, job counters, composer copy) ---- */

test("the web header copy and its two metric cards: Total Jobs and Active Jobs (pending or processing)", async () => {
  const r = await render();
  assert.ok(r.hasText("BATCH ANALYSIS"));
  assert.ok(r.hasText("Analyze multiple evidence items at once."));
  assert.ok(r.hasText("Create batch jobs, monitor progress, review outcomes, and export result sets for larger evidence workloads."));
  assert.ok(r.byLabel("Total Jobs: 3").length === 1, "Total Jobs card missing");
  assert.ok(r.byLabel("Active Jobs: 2").length === 1, "Active Jobs card missing");
  assert.ok(r.hasText("All batch jobs") && r.hasText("Pending or processing"));
});

test("each job shows its created time, done / total, and the Processed / Failed / Pending tiles", async () => {
  const r = await render();
  assert.ok(r.hasText("5 / 10"), "the web's (processed + failed) / total line is missing");
  const counters = r.byTestId("batch-counters-job-run");
  assert.equal(counters.length, 1);
  const texts = counters[0].findAll((n) => n.type === "Text").map((n) => [n.props.children].flat().join(""));
  assert.deepEqual(texts, ["Processed", "4", "Failed", "1", "Pending", "5"]);
});

test("the composer carries the web's field names, placeholders and submit label", async () => {
  const r = await render();
  await pressLast(r, "+ New Batch Job");
  const texts = sheetTexts(r);
  assert.ok(texts.includes("Batch Name"), texts.join(" | "));
  const name = r.byLabel("Batch name").find((n) => n.props.onChangeText);
  assert.equal(name.props.placeholder, "e.g., Q1 2026 Review");
  const desc = r.byLabel("Batch description").find((n) => n.props.onChangeText);
  assert.equal(desc.props.placeholder, "Add notes about this batch");
  assert.ok(r.byLabel("Create & Start Batch").length > 0);
});

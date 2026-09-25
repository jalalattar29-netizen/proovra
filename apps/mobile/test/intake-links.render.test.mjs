/**
 * RENDER TESTS for External intake links (the web page.tsx + _components port).
 *
 * The envelopes are the server's real shapes:
 *   - list: `{ items, links }` (workflow-intake-links.routes.ts:641), each item
 *     `{ link, delivery, activity, computedLifecycle }`
 *     (intake-link-lifecycle.service.ts projectIntakeLinkList);
 *   - submissions: `{ link, sessions, totals }` (intake-link-lifecycle.service.ts:705);
 *   - the platform envelope's `capabilities` is a `Record<CapabilityKey, boolean>`
 *     (services/platform-context/types.ts:1068) — the web gates this surface on
 *     `capabilities.INTAKE_LINKS_MANAGE === true` (page.tsx:115, useTenantModel.ts:98);
 *   - a disabled deployment answers 503 `{ error: { code: "FEATURE_DISABLED" } }`
 *     (workflow-intake-links.routes.ts:245-253).
 *
 * The screen is gated on a resolved workspace, which needs a restored session -
 * so the token is seeded into the SecureStore stub before rendering.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;

let requests = [];
let routes = {};
let mounted = [];

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ?? null });
    // Longest prefix wins: "/v1/workflow/intake-links" must not swallow
    // "/v1/workflow/intake-links/:id/submissions".
    const responder = Object.entries(routes)
      .sort(([a], [b]) => b.length - a.length)
      .find(([p]) => path.startsWith(p));
    if (!responder) {
      return new Response(JSON.stringify({ message: "unstubbed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const out = await responder[1](path, init);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

/** One enriched list item (`{ link, delivery, activity }`). */
const ITEM = (linkOver = {}, deliveryOver = {}, activityOver = {}) => ({
  link: {
    id: "link-1",
    workflowTemplateName: "Incident intake",
    workflowTemplateSlug: "incident",
    intakeMode: "EXTERNAL_REUSABLE",
    recipientLabel: "Sam Rivera",
    recipientEmailPreview: "s***@example.com",
    recipientContactRevealAuthorized: false,
    status: "ACTIVE",
    usedCount: 1,
    maxUses: 5,
    expiresAtUtc: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
    ...linkOver,
  },
  delivery: { latestStatus: "DELIVERED", latestChannel: "EMAIL", latestSentAtUtc: "2026-09-01T09:01:00.000Z", attemptCount: 2, channelsAttempted: ["EMAIL", "SMS"], ...deliveryOver },
  activity: { firstOpenedAtUtc: "2026-09-02T09:00:00.000Z", sessionsCreated: 2, sessionsOpened: 2, sessionsStarted: 2, sessionsSubmitted: 1, evidenceCount: 1, ...activityOver },
  computedLifecycle: "SUBMITTED",
});

const LIST = () => ({ items: [ITEM()], links: [] });

const SESSION = {
  id: "sess-1",
  status: "SUBMITTED",
  submitterDisplayName: "Sam Rivera",
  submitterEmailPreview: "s***@example.com",
  submitterPhonePreview: null,
  pseudonym: null,
  openedAtUtc: "2026-09-20T08:00:00.000Z",
  submittedAtUtc: "2026-09-20T09:00:00.000Z",
  abandonedAtUtc: null,
  evidenceId: "ev-9",
};

const SUBMISSIONS = {
  link: {
    id: "link-1",
    teamId: "team-1",
    intakeMode: "EXTERNAL_REUSABLE",
    recipientLabel: "Sam Rivera",
    workflowTemplateSlug: "incident",
    workflowTemplateName: "Incident intake",
  },
  sessions: [SESSION],
  totals: { sessions: 1, submitted: 1, inProgress: 0, evidenceProduced: 1 },
};

const CONTEXT = (caps = { INTAKE_LINKS_MANAGE: true }) => ({
  activeSpace: { id: "team-1", type: "ORGANIZATION", displayName: "Rivera Legal" },
  capabilities: caps,
});

const OK_ROUTES = () => ({
  "/v1/platform/context": () => ({ body: CONTEXT() }),
  "/v1/workflow/intake-links/link-1/submissions": () => ({ body: SUBMISSIONS }),
  "/v1/workflow/intake-links": () => ({ body: LIST() }),
});

before(async () => {
  M = await loadModule("app/(stack)/intake-links.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(async () => {
  requests = [];
  routes = OK_ROUTES();
  installFetch();
  M.calls.reset();
  await M.setItemAsync("proovra-token", "test-token");
});

afterEach(() => {
  for (const r of mounted) {
    try { r.unmount(); } catch { /* already unmounted */ }
  }
  mounted = [];
  delete globalThis.__EXPO_PARAMS__;
});

const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const listReads = () => requests.filter((x) => x.path.startsWith("/v1/workflow/intake-links?"));

/** Open the one link's submissions. */
const openSubmissions = (r) => r.press("View submissions (1)");

test("the screen loads the workspace's links", async () => {
  const r = await render();
  assert.ok(r.hasText("Incident intake"), "the link list never loaded");
  assert.ok(listReads().length > 0, "the list route was never requested");
});

/* ------------------------------------------------ header (page.tsx:441-479, :567) */

test("the header carries the web's intro, the workspace the links belong to, and the safety note", async () => {
  const r = await render();
  assert.ok(r.hasText("External intake links"));
  assert.ok(r.hasText("Secure links that let people outside your workspace upload photos, videos, audio, or documents — without an account."));
  assert.ok(r.hasText("Links in Rivera Legal"), "the owning workspace is not named");
  assert.ok(r.hasText("Contributors submit files without ever accessing this workspace."));
  assert.equal(r.byLabel("New intake link").length, 1);
});

/* ------------------------------------------------- states (States.tsx, page.tsx:156-173) */

test("without INTAKE_LINKS_MANAGE the surface fails CLOSED to the restricted panel, with no retry and no create", async () => {
  routes["/v1/platform/context"] = () => ({ body: CONTEXT({}) });
  const r = await render();
  assert.ok(r.hasText("You don't have access to intake links here"));
  assert.ok(r.hasText("Managing external intake links needs an admin or owner role in this workspace."));
  assert.equal(r.byLabel("Try again").length, 0, "a refusal offered a retry");
  assert.equal(r.byLabel("New intake link").length, 0);
  assert.equal(listReads().length, 0, "the list was read for a caller the surface refuses");
});

test("a 403 on the list read is restricted, not an error", async () => {
  routes["/v1/workflow/intake-links"] = () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } });
  const r = await render();
  assert.ok(r.hasText("You don't have access to intake links here"));
  assert.equal(r.byLabel("Try again").length, 0);
  assert.equal(r.byLabel("New intake link").length, 0, "create was offered beside a refusal");
});

test("a deployment without intake says 'Not enabled yet' and who to contact", async () => {
  routes["/v1/workflow/intake-links"] = () => ({
    status: 503,
    body: { error: { code: "FEATURE_DISABLED", reason: "flag_off", message: "Workflow intake links are not enabled on this deployment" } },
  });
  const r = await render();
  assert.ok(r.hasText("Not enabled yet"));
  assert.ok(r.hasText("Contact your IT administrator or your PROOVRA support contact"));
  assert.equal(r.byLabel("Try again").length, 0);
});

test("a server failure says 'Couldn't load intake links' and Try again re-reads", async () => {
  let fail = true;
  routes["/v1/workflow/intake-links"] = () => (fail ? { status: 500, body: { error: { code: "INTERNAL" } } } : { body: LIST() });
  const r = await render();
  assert.ok(r.hasText("Couldn't load intake links"));
  fail = false;
  await r.press("Try again");
  await settle();
  assert.ok(r.hasText("Incident intake"));
});

test("an empty workspace offers New intake link and the six quick-start requests, which open creation pre-filled", async () => {
  routes["/v1/workflow/intake-links"] = () => ({ body: { items: [], links: [] } });
  const r = await render();
  assert.ok(r.hasText("No intake links yet"));
  assert.ok(r.hasText("Start from a common request"));
  assert.equal(r.byLabel("Start from Insurance claim evidence").length, 1);
  assert.equal(r.byLabel("Start from Incident investigation").length, 0, "more than the web's six quick-start tiles");
  await r.press("Start from Insurance claim evidence");
  assert.equal(M.calls.push.at(-1), "/intake-link-create?purpose=insurance-claim");
});

test("?new=1 (Home's Request & collect) opens creation", async () => {
  globalThis.__EXPO_PARAMS__ = { new: "1" };
  await render();
  assert.ok(M.calls.push.includes("/intake-link-create"));
});

/* ----------------------------------------------------------- submissions drawer */

test("opening a link's submissions displays the submissions it actually has", async () => {
  const r = await render();
  await openSubmissions(r);
  await settle();
  assert.ok(requests.some((x) => x.path === "/v1/workflow/intake-links/link-1/submissions"), "the submissions were never read");
  assert.ok(r.hasText("Submission #1"));
  assert.ok(r.hasText("Contributor · Sam Rivera"));
  assert.ok(!r.hasText("No submissions yet"), "a link WITH submissions was described as unused");
});

test("a link with no submissions says so in the web's words", async () => {
  routes["/v1/workflow/intake-links/link-1/submissions"] = () => ({
    body: { ...SUBMISSIONS, sessions: [], totals: { sessions: 0, submitted: 0, inProgress: 0, evidenceProduced: 0 } },
  });
  const r = await render();
  await openSubmissions(r);
  await settle();
  assert.ok(r.hasText("No submissions yet"));
  assert.ok(r.hasText("The link is ready. Nothing has been uploaded through it so far."));
});

test("an unreadable envelope fails loudly instead of reporting an unused link", async () => {
  routes["/v1/workflow/intake-links/link-1/submissions"] = () => ({ body: { submissions: [SESSION] } }); // the key the client once invented
  const r = await render();
  await openSubmissions(r);
  await settle();
  assert.ok(!r.hasText("No submissions yet"), "an envelope this build cannot read was reported as an unused link");
});

test("a refusal on the submissions read is shown as a failure, not as emptiness", async () => {
  routes["/v1/workflow/intake-links/link-1/submissions"] = () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "You do not have access." } } });
  const r = await render();
  await openSubmissions(r);
  await settle();
  assert.ok(!r.hasText("No submissions yet"));
});

test("submissions carry the web's counts line, per-session status, waiting notes, and open the record they produced", async () => {
  routes["/v1/workflow/intake-links/link-1/submissions"] = () => ({
    body: { ...SUBMISSIONS, sessions: [SESSION, { ...SESSION, id: "sess-2", status: "UPLOAD_STARTED", evidenceId: null }, { ...SESSION, id: "sess-3", status: "ABANDONED", evidenceId: "ev-dead" }] },
  });
  const r = await render();
  await openSubmissions(r);
  await settle();
  assert.ok(r.hasText("3 total · 1 submitted · 1 in progress · 2 evidence records"));
  assert.ok(r.hasText("Submission #3"));
  assert.equal(r.byLabel("Upload started").length, 1, "the session status badge is missing");
  assert.ok(r.hasText("Waiting for files — no evidence record yet."));
  assert.ok(r.hasText("This session is closed; no evidence record was produced."));
  const opens = r.byLabel("Open evidence").filter((n) => n.props.onPress);
  assert.equal(opens.length, 1, "a terminal session or one with no record offered Open evidence");
  await act(async () => { opens[0].props.onPress(); });
  assert.equal(M.calls.push.at(-1), "/evidence/ev-9");
});

/* ---------------------------------------------------------- T-15 delivery history */

const DELIVERIES = "/v1/communications/messages?teamId=team-1&relatedIntakeLinkId=link-1&limit=50";

test("Delivery history lists each attempt in the web's words, and Retry re-drives a failed one", async () => {
  let retried = false;
  routes[DELIVERIES] = () => ({
    body: {
      messages: [
        { id: "m-ok", channel: "EMAIL", status: "DELIVERED", recipientPreview: "s***@example.com", attemptCount: 1, createdAt: "2026-09-20T09:00:00Z", deliveredAtUtc: "2026-09-20T09:01:00Z" },
        { id: "m-bad", channel: "SMS", status: retried ? "SENT" : "FAILED", recipientPreview: "+44 ••• 12", attemptCount: 2, createdAt: "2026-09-20T09:00:00Z", failedAtUtc: "2026-09-20T09:02:00Z", errorCode: "30007" },
      ],
    },
  });
  routes["/v1/communications/messages/m-bad/retry"] = () => {
    retried = true;
    return { body: {} };
  };
  const r = await render();
  await r.press("Delivery history: Incident intake");
  await settle();
  assert.ok(requests.some((x) => x.path === DELIVERIES), "the link's delivery history was never read");
  assert.ok(r.hasText("To +44 ••• 12 · attempt 2"));
  assert.ok(r.hasText("Carrier filtered the message as spam."));
  assert.equal(r.byLabel("Retry now: Email to s***@example.com").length, 0, "a delivered message offered Retry");
  await r.press("Retry now: SMS to +44 ••• 12");
  await settle();
  assert.ok(requests.some((x) => x.method === "POST" && x.path === "/v1/communications/messages/m-bad/retry"));
  assert.ok(r.hasText("Sent to provider"), "the history was not reloaded after the retry");
});

test("no attempts yet says so; a failed read is said, not shown as 'nothing sent'", async () => {
  routes[DELIVERIES] = () => ({ body: { messages: [] } });
  let r = await render();
  await r.press("Delivery history: Incident intake");
  await settle();
  assert.ok(r.hasText("Nothing sent yet"));
  r.unmount();
  routes[DELIVERIES] = () => ({ status: 500, body: {} });
  r = await render();
  await r.press("Delivery history: Incident intake");
  await settle();
  assert.ok(!r.hasText("Nothing sent yet"), "a failed read was presented as 'nothing sent'");
});

test("?linkId= (from Home's Intake status) opens that link's delivery history directly", async () => {
  routes[DELIVERIES] = () => ({ body: { messages: [] } });
  globalThis.__EXPO_PARAMS__ = { linkId: "link-1" };
  const r = await render();
  assert.ok(requests.some((x) => x.path === DELIVERIES), "the deep-linked link's history was never opened");
  assert.ok(r.hasText("Nothing sent yet"));
});

/* -------------------------------------------------------------- details drawer */

test("the details show the web's Overview, Delivery, Activity, Submissions and Access", async () => {
  const r = await render();
  await r.press("Open details for Incident intake");
  assert.ok(r.byTestId("intake-link-details").length > 0);
  assert.ok(r.hasText("Link ID link-1…"));
  assert.ok(r.hasText("This link can still accept submissions."));
  assert.ok(r.hasText("Reusable link"));
  assert.ok(r.hasText("Not set"), "an unset Customer ID was not stated");
  assert.ok(r.hasText("Sam Rivera · s***@example.com"));
  assert.ok(r.hasText("1 of 5"));
  assert.ok(r.hasText("2 attempts across 2 channels."));
  assert.ok(r.hasText("1 submitted · 1 in progress · 1 evidence record produced."));
  assert.equal(r.byLabel("Open delivery history").length, 1);
  assert.equal(r.byLabel("View submissions").length, 1, "the details did not offer the link's submissions");
  assert.equal(r.byLabel("Archive").length, 1, "the details' Access section has no Archive");
  assert.equal(r.byLabel("Disable link").length, 1);
});

test("an archived link is in the All view (as on the web), reads Archived, and is RESTORED, not archived again", async () => {
  routes["/v1/workflow/intake-links"] = () => ({ body: { items: [ITEM({ archivedAtUtc: "2026-09-10T00:00:00.000Z" })] } });
  routes["/v1/workflow/intake-links/link-1/unarchive"] = () => ({ body: {} });
  const r = await render();
  assert.equal(r.byLabel("Archived").length, 1, "an archived link was hidden from the All view or read Active");
  assert.equal(r.byLabel("Archived: 1").length, 1, "the Archived KPI did not count it");
  assert.equal(r.byLabel("Disable link: Incident intake").length, 0, "an archived link offered Disable");
  await r.press("Open details for Incident intake");
  assert.equal(r.byLabel("Disable link").length, 0, "an archived link offered Disable");
  await r.press("Restore from archive");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path.startsWith("/v1/workflow/intake-links/link-1/"));
  assert.equal(post.path, "/v1/workflow/intake-links/link-1/unarchive", "the archived link was archived again");
});

/* ------------------------------------------------------ records (RecordsSurface) */

test("each record carries the web's Recipient & reference, Delivery, Status and Timeline cells", async () => {
  routes["/v1/workflow/intake-links"] = () => ({
    body: {
      items: [
        ITEM({ customerId: "CUST-849271", recipientPhonePreview: "+44 ••• 12" }, { latestErrorCode: "30007", attemptCount: 3 }),
        ITEM({ id: "link-2", workflowTemplateName: "Claim intake", recipientLabel: null, recipientEmailPreview: null }, { latestStatus: null, latestChannel: null, attemptCount: 0, channelsAttempted: [] }, { sessionsCreated: 0, sessionsOpened: 0, sessionsStarted: 0, sessionsSubmitted: 0, evidenceCount: 0 }),
      ],
    },
  });
  const r = await render();
  assert.ok(r.hasText("Customer ID · CUST-849271"));
  assert.ok(r.hasText("+44 ••• 12"));
  assert.equal(r.byLabel("Delivery status: Delivered").length, 1);
  assert.ok(r.hasText("3 attempts · Carrier filtered the message as spam."));
  assert.equal(r.byLabel("Contributor activity: Submitted").length, 1);
  assert.ok(r.hasText("Reusable"), "the mode is missing under the request");
  assert.ok(r.texts().some((t) => t.startsWith("Latest ")));
  assert.ok(r.texts().some((t) => t.startsWith("Expires ")));
  assert.equal(r.byLabel("View submissions (1)").length, 1);
  // The manual link nobody was named on.
  assert.ok(r.hasText("No recipient") && r.hasText("Manual link"));
  assert.equal(r.byLabel("Delivery status: Manual").length, 1);
  assert.equal(r.byLabel("Contributor activity: Not opened").length, 1);
  assert.ok(r.hasText("None yet"));
});

test("Disable asks first, in the web's words, then revokes with { reason: null }", async () => {
  routes["/v1/workflow/intake-links/link-1/revoke"] = () => ({ body: {} });
  const r = await render();
  await r.press("Disable link: Incident intake");
  assert.ok(r.hasText("Disable this intake link?"));
  assert.ok(r.hasText("This cannot be undone"));
  await r.press("Disable link");
  await settle();
  const post = requests.find((q) => q.path === "/v1/workflow/intake-links/link-1/revoke");
  assert.ok(post, "the revoke was never sent");
  assert.deepEqual(JSON.parse(post.body), { reason: null });
});

test("a failed row action says WHICH action failed, inline, and can be dismissed", async () => {
  routes["/v1/workflow/intake-links/link-1/archive"] = () => ({ status: 500, body: { error: { code: "INTERNAL" } } });
  const r = await render();
  await r.press("Archive: Incident intake");
  await settle();
  assert.ok(r.texts().some((t) => t.startsWith("Couldn't archive that link.")));
  await r.press("Dismiss error");
  assert.ok(!r.texts().some((t) => t.startsWith("Couldn't archive that link.")));
});

/* ----------------------------------------------------- KPIs + toolbar + paging */

const MIXED = () => ({
  items: [
    ITEM(),
    ITEM({ id: "link-2", workflowTemplateName: "Claim intake", expiresAtUtc: "2020-01-01T00:00:00.000Z", createdAt: "2026-09-05T09:00:00.000Z" }, { latestStatus: "FAILED", latestChannel: "SMS" }, { sessionsCreated: 0, sessionsOpened: 0, sessionsStarted: 0, sessionsSubmitted: 0 }),
    ITEM({ id: "link-3", workflowTemplateName: "Roof survey" }, { latestStatus: null, latestChannel: null, attemptCount: 0, channelsAttempted: [] }, { sessionsCreated: 1, sessionsOpened: 1, sessionsStarted: 0, sessionsSubmitted: 0 }),
  ],
});

test("the KPI cards count with the web's predicates and each one IS a filter", async () => {
  routes["/v1/workflow/intake-links"] = () => ({ body: MIXED() });
  const r = await render();
  assert.equal(r.byLabel("Total links: 3").length, 1);
  assert.equal(r.byLabel("Active: 2").length, 1);
  assert.equal(r.byLabel("Failed delivery: 1").length, 1);
  assert.equal(r.byLabel("Opened: 1").length, 1);
  assert.equal(r.byLabel("Revoked or expired: 1").length, 1);
  assert.ok(r.hasText("A link can appear in more than one count — these are filters, not a breakdown of the total."));
  await r.press("Failed delivery: 1");
  assert.ok(r.hasText("Claim intake"));
  assert.equal(r.hasText("Incident intake"), false);
  assert.ok(r.hasText("1 link"));
});

test("channel and delivery-state filters narrow the rows the way the web does", async () => {
  routes["/v1/workflow/intake-links"] = () => ({ body: MIXED() });
  const r = await render();
  await r.press("Filter by delivery channel: Copy link");
  assert.ok(r.hasText("Roof survey"));
  assert.equal(r.hasText("Claim intake"), false);
  await r.press("Filter by delivery channel: Any channel");
  await r.press("Filter by delivery state: Failed");
  assert.ok(r.hasText("Claim intake"));
  assert.equal(r.hasText("Roof survey"), false);
});

test("the search term is a SERVER parameter, over every archive scope, and refreshes in place", async () => {
  let release;
  const r = await render();
  routes["/v1/workflow/intake-links"] = (path) =>
    path.includes("search=") ? new Promise((res) => { release = () => res({ body: LIST() }); }) : { body: LIST() };
  await r.type("Search intake links", "CUST-0042");
  await act(async () => { await new Promise((x) => setTimeout(x, 340)); });
  await settle();
  const last = listReads().at(-1);
  assert.ok(last.path.includes("archiveScope=all"), last.path);
  assert.ok(last.path.includes("search=CUST-0042"), "the term was filtered on the device instead of sent");
  assert.ok(r.hasText("Refreshing intake links…"), "no busy line while the term was fetched");
  assert.ok(r.hasText("Incident intake"), "the rows were torn down during a refresh");
  await act(async () => { release(); });
  await settle();
  assert.ok(!r.hasText("Refreshing intake links…"));
});

test("a lifecycle that matches nothing says so and clears back", async () => {
  routes["/v1/workflow/intake-links"] = () => ({ body: MIXED() });
  const r = await render();
  await r.press("Filter by lifecycle: Link disabled");
  assert.ok(r.hasText("No intake links match these filters"));
  const clear = r.byLabel("Clear filters").filter((n) => n.props.onPress);
  await act(async () => { clear.at(-1).props.onPress(); });
  await settle();
  assert.ok(r.hasText("Incident intake") && r.hasText("Claim intake"));
  assert.equal(r.byLabel("Clear filters").length, 0);
});

test("Expired lifecycle and Newest-created sort work over the returned rows", async () => {
  routes["/v1/workflow/intake-links"] = () => ({ body: MIXED() });
  const r = await render();
  await r.press("Sort intake links: Newest created");
  const texts = r.texts();
  assert.ok(texts.indexOf("Claim intake") < texts.indexOf("Incident intake"), "newest was not first");
  await r.press("Filter by lifecycle: Expired");
  assert.ok(r.hasText("Claim intake"));
  assert.equal(r.hasText("Incident intake"), false);
});

test("more rows than a page paginate: Rows per page, Page N of M, Next", async () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    ITEM({ id: `link-${i}`, workflowTemplateName: `Request ${String(i).padStart(2, "0")}`, createdAt: `2026-09-01T09:${String(i).padStart(2, "0")}:00.000Z` }, { latestAtUtc: null }, { lastOpenedAtUtc: null }),
  );
  routes["/v1/workflow/intake-links"] = () => ({ body: { items } });
  const r = await render();
  await r.press("Sort intake links: Newest created");
  assert.ok(r.hasText("30 links"));
  assert.ok(r.hasText("Page 1 of 2"));
  assert.ok(r.hasText("Rows per page"));
  assert.ok(r.hasText("Request 29") && !r.hasText("Request 04"));
  await r.press("Next");
  assert.ok(r.hasText("Page 2 of 2"));
  assert.ok(r.hasText("Request 04") && !r.hasText("Request 29"));
  await r.press("Rows per page: 50");
  assert.ok(!r.hasText("Page 1 of 2") && !r.hasText("Page 2 of 2"));
  assert.ok(r.hasText("Request 29") && r.hasText("Request 00"));
});

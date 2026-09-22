/**
 * RENDER TESTS for Intake links › Submissions.
 *
 * The twin of F-09, found by `tools/contract-audit.mjs` the first time it ran.
 * `parseIntakeSubmissions` read `submissions`; the route answers
 * `{ link, sessions, totals }` (intake-link-lifecycle.service.ts:685), so every
 * link that had actually been used showed "Nobody has used this link yet."
 *
 * The envelopes below are verbatim from that payload type and from the
 * enriched list projection `parseIntakeLinks` documents.
 *
 * The screen is gated on a resolved workspace, which needs a restored session -
 * so the token is seeded into the SecureStore stub before rendering. Without
 * it the screen correctly shows "No intake links" and every assertion below
 * would pass over a surface that never loaded.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React } from "./support/render.mjs";

const h = React.createElement;
let M;

let requests = [];
let routes = {};

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
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
    const out = responder[1](path, init);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** The enriched list projection: the row is nested under `link`. */
const LIST = {
  items: [
    {
      link: {
        id: "link-1",
        workflowTemplateName: "Incident intake",
        workflowTemplateSlug: "incident",
        recipientLabel: "Sam Rivera",
        status: "ACTIVE",
      },
      lifecycle: { usedCount: 1 },
    },
  ],
};

const SESSION = {
  id: "sess-1",
  status: "SUBMITTED",
  submitterDisplayName: "Sam Rivera",
  submitterEmailPreview: "s***@example.com",
  submitterPhonePreview: null,
  pseudonym: null,
  submittedAtUtc: "2026-09-20T09:00:00.000Z",
  abandonedAtUtc: null,
  evidenceId: "ev-9",
};

const SUBMISSIONS = {
  link: {
    id: "link-1",
    teamId: "team-1",
    intakeMode: "EXTERNAL_IDENTIFIED",
    recipientLabel: "Sam Rivera",
    workflowTemplateSlug: "incident",
    workflowTemplateName: "Incident intake",
  },
  sessions: [SESSION],
  totals: { sessions: 1, submitted: 1, inProgress: 0, evidenceProduced: 1 },
};

const OK_ROUTES = () => ({
  "/v1/platform/context": () => ({ body: { activeSpace: { id: "team-1", type: "PERSONAL" } } }),
  "/v1/workflow/intake-links/link-1/submissions": () => ({ body: SUBMISSIONS }),
  "/v1/workflow/intake-links": () => ({ body: LIST }),
});

before(async () => {
  M = await loadModule("app/(stack)/intake-links.tsx", [
    "test/support/providers.tsx",
    // The SecureStore stub, from the SAME bundle graph the screen resolves
    // `expo-secure-store` to, so seeding it is seeding the app's own store.
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(async () => {
  requests = [];
  routes = OK_ROUTES();
  installFetch();
  await M.setItemAsync("proovra-token", "test-token");
});

const render = () => renderComponent(h(M.TestProviders, null, h(M.default, {})));

/** Open the one link in the list. */
async function open(r) {
  await r.press("Incident intake");
}

test("the screen loads the workspace's links", async () => {
  const r = await render();
  assert.ok(r.hasText("Incident intake"), "the link list never loaded");
  assert.ok(
    requests.some((x) => x.path.startsWith("/v1/workflow/intake-links?")),
    "the list route was never requested",
  );
});

test("opening a link displays the submissions it actually has", async () => {
  // THE REGRESSION. Not "does the parser return a row" but "does the row reach
  // the screen" - the only level at which this defect was ever visible.
  const r = await render();
  await open(r);
  assert.ok(
    requests.some((x) => x.path === "/v1/workflow/intake-links/link-1/submissions"),
    "opening a link did not read its submissions",
  );
  assert.ok(r.hasText("Sam Rivera"), "the submission is not on screen");
  assert.ok(
    !r.hasText("Nobody has used this link yet."),
    "a link WITH submissions was described as unused",
  );
});

test("a submission shows the masked contact preview and nothing rawer", async () => {
  const r = await render();
  await open(r);
  assert.ok(r.hasText("s***@example.com"));
});

test("a link with no submissions says so", async () => {
  routes["/v1/workflow/intake-links/link-1/submissions"] = () => ({
    body: {
      ...SUBMISSIONS,
      sessions: [],
      totals: { sessions: 0, submitted: 0, inProgress: 0, evidenceProduced: 0 },
    },
  });
  const r = await render();
  await open(r);
  assert.ok(r.hasText("Nobody has used this link yet."));
});

test("an unreadable envelope fails loudly instead of reporting an unused link", async () => {
  // A well-formed 200 carrying the key the parser used to read. Reporting it
  // as "nobody has used this link" IS the defect, restated.
  routes["/v1/workflow/intake-links/link-1/submissions"] = () => ({
    body: { submissions: [SESSION] }, // the key the client invented
  });
  const r = await render();
  await open(r);
  assert.ok(
    !r.hasText("Nobody has used this link yet."),
    "an envelope this build cannot read was reported as an unused link",
  );
});

test("a refusal on the submissions read is shown as a failure, not as emptiness", async () => {
  routes["/v1/workflow/intake-links/link-1/submissions"] = () => ({
    status: 403,
    body: { error: { code: "FORBIDDEN", message: "You do not have access." } },
  });
  const r = await render();
  await open(r);
  assert.ok(!r.hasText("Nobody has used this link yet."));
});

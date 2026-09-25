/**
 * RENDER TESTS for Home.
 *
 * Two things these pin, because both were defects:
 *   - Home read two of the seven canonical sources, so it was data-starved;
 *   - the hero carried UC-2/UC-3/UC-5 screen-capture buttons, turning the
 *     canonical landing page into a native-capability launcher.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React } from "./support/render.mjs";
import {
  authenticatedRoutes,
  signIn,
  assertScopedRequests,
  TEST_TEAM_ID,
} from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) {
      return new Response(JSON.stringify({ message: "unstubbed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(hit[1]()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/*
 * Every stub is the route's REAL reply shape: command-center.service.ts
 * (sections.caseOperations / pipelineDetail), trust-summary.service.ts,
 * billing-overview.service.ts (workspaces.personal.storage),
 * reports.routes.ts ({ items, nextCursor }), ops.routes.ts:936 ({ summary }).
 */
const OK = () => ({
  ...authenticatedRoutes(),
  "/v1/evidence": () => ({
    items: [
      {
        id: "ev-1",
        type: "PHOTO",
        status: "SIGNED",
        createdAt: "2026-02-02T10:00:00.000Z",
        displayTitle: "IMG_0042.jpg",
      },
    ],
    nextCursor: null,
  }),
  // Active matters come from the ACTIVE workspace's caseOperations projection.
  "/v1/dashboard/command-center": () => ({
    sections: {
      caseOperations: {
        status: "ok",
        data: { activeCasesCount: 4, topCases: [{ caseId: "c-1", caseName: "Leaking roof", evidenceCount: 0, lastActivityAtUtc: "2026-02-02T10:00:00.000Z" }] },
      },
      pipelineDetail: {
        status: "ok",
        data: {
          evidence: { created: 0, uploading: 0, uploaded: 0, signed: 100, reported: 1180, stuckUploading: 0 },
          reports: { ready: 12, versionsTotal: 14, queued: 0, failed: 0, missingFromSigned: 0 },
          packages: { ready: 3, versionsTotal: 3, queued: 0, blocked: 0, failed: 0, missingFromReported: 0 },
          publicVerify: { published: 0, unpublished: 0, suspended: 0 },
        },
      },
    },
  }),
  "/v1/dashboard/trust-summary": () => ({
    totalEvidence: 1280,
    endToEndReady: 1180,
    signed: 1280,
    tsa: { stamped: 1278, pending: 0, failed: 2, none: 0 },
    ots: { anchored: 1276, pending: 4, failed: 0, none: 0 },
    publicVerify: { published: 0, unpublished: 1280, suspended: 0 },
    intake: { submissionsAwaitingReview: 0 },
  }),
  "/v1/billing/overview": () => ({
    workspaces: { personal: { storage: { usedLabel: "1.2 GB", limitLabel: "5 GB", usagePercent: 24, nearLimit: false, limitReached: false } } },
  }),
  "/v1/reports": () => ({ items: [], nextCursor: null }),
  "/v1/workflow/intake-links": () => ({ links: [{ id: "l1", status: "ACTIVE" }, { id: "l2", status: "ACTIVE" }] }),
  "/v1/me/inbox": () => ({ items: [] }),
  "/v1/ops/summary": () => ({ summary: { mayAssertAllClear: true, clearRefusalReason: null }, workspace: { operatorCount: 1 } }),
  // The legacy cross-workspace list. Home must NOT read it (T-14).
  "/v1/cases": () => ({ items: [{ id: "c-other", title: "Another workspace's matter", status: "OPEN" }] }),
});

before(async () => {
  M = await loadModule("app/(tabs)/index.tsx", [
    "test/support/providers.tsx",
    // The SecureStore the screen itself resolves to, so seeding it is
    // seeding the app's own store rather than a second copy.
    "test/support/expo-stub.mjs",
  ]);
});
beforeEach(async () => {
  requests = [];
  routes = OK();
  installFetch();
  // Without this every test below renders the SIGNED-OUT branch while
  // reading as coverage of the signed-in screen.
  await signIn(M);
});

const render = () => renderComponent(h(M.TestProviders, null, h(M.default, {})));

test("Home reads the canonical dashboard sources, not just two", async () => {
  await render();
  const paths = requests.map((r) => r.path.split("?")[0]);
  for (const p of [
    "/v1/evidence",
    "/v1/billing/overview",
    "/v1/me/inbox",
  ]) {
    assert.ok(paths.includes(p), `Home never requested ${p}`);
  }
  assert.equal(paths.includes("/v1/cases"), false, "Home read the legacy cross-workspace case list");
});

/*
 * THE TEST THE SUITE DID NOT HAVE.
 *
 * Six of Home's ten requests are written as
 * `teamId ? apiFetch(scoped(path)) : Promise.resolve(null)`. With a null
 * activeTeamId they are never SENT, and the screen renders a plausible
 * empty workspace. Every test in this file used to run in exactly that
 * state, so none of them touched the path a signed-in person uses.
 */
test("the workspace-scoped requests actually execute", async () => {
  await render();

  const scoped = assertScopedRequests(assert, requests, [
    "/v1/dashboard/command-center",
    "/v1/dashboard/trust-summary",
    "/v1/reports",
    "/v1/workflow/intake-links",
  ]);

  assert.ok(
    scoped.every((p) => p.includes(`teamId=${TEST_TEAM_ID}`)),
    "a scoped request without the workspace id is a cross-workspace read",
  );
});

test("Home renders the five canonical KPIs", async () => {
  const r = await render();
  for (const label of [
    "Total evidence",
    "Active matters",
    "End-to-end ready",
    "Reports & packages",
    "Intake & submissions",
  ]) {
    assert.ok(r.hasText(label), `missing KPI: ${label}`);
  }
});

test("Home renders the canonical overview sections", async () => {
  const r = await render();
  assert.ok(r.hasText("What needs you now"));
  assert.ok(r.hasText("Active matters"));
});

test("the priority queue leads with the critical workspace fact, with why and what to do", async () => {
  const r = await render();
  // trust-summary tsa.failed 2 (critical) outranks ots.pending 4 (warning).
  assert.ok(r.hasText("2 TSA timestamps failed"));
  assert.ok(r.hasText("4 OTS proofs are still pending"));
  const texts = r.texts();
  assert.ok(
    texts.indexOf("2 TSA timestamps failed") < texts.indexOf("4 OTS proofs are still pending"),
    "a queue ordered by arrival buries the thing that matters",
  );
  assert.ok(r.hasText("Failed timestamping weakens time-based evidence confidence for these records."));
  await r.press("Open affected records →");
  assert.equal(M.calls.push.at(-1), "/evidence?tsaStatus=FAILED,REJECTED,ERROR");
});

test("recent evidence and active matters both render", async () => {
  const r = await render();
  assert.ok(r.hasText("IMG_0042.jpg"));
  assert.ok(r.hasText("Leaking roof"));
  assert.equal(r.hasText("Another workspace's matter"), false, "a matter from another workspace reached Home");
});

test("UC screen capture is NOT on Home", async () => {
  const r = await render();
  // These were in the hero. Home is the canonical PROOVRA Home, not a list of
  // platform capabilities; screen capture is an acquisition SOURCE and belongs
  // in Capture's source chooser.
  for (const banned of ["Direct Screen Capture", "Continuous Screen Capture", "Screen capture"]) {
    assert.equal(r.hasText(banned), false, `"${banned}" is on Home`);
  }
});

test("the header greets the operator and offers All evidence once work exists", async () => {
  const r = await render();
  assert.ok(r.texts().some((t) => /^Good (morning|afternoon|evening)$/.test(t)), "the time-of-day greeting is missing");
  assert.ok(r.hasText("Here's what's happening across your digital evidence operations today."));
  await r.press("All evidence");
  assert.equal(M.calls.push.at(-1), "/evidence");
});

test("the summary band states the workspace, its top cause, Also:, and one action", async () => {
  const r = await render();
  assert.ok(r.byLabel("Critical").length >= 1, "TSA failures make the workspace critical");
  assert.ok(r.hasText("2 TSA timestamps failed — Failed timestamping weakens time-based evidence confidence for these records."));
  assert.ok(r.texts().some((t) => t.startsWith("Also: 4 OTS proofs are still pending")));
});

test("Workspace views: Overview, Operations and Analytics each carry the web's modules", async () => {
  const r = await render();
  assert.ok(r.byLabel("Workspace views: Overview").length === 1);
  assert.ok(r.hasText("Workspace health and the priorities ranked by severity."));
  assert.ok(r.hasText("The latest evidence you captured and the matters in progress."));
  assert.equal(r.hasText("Verification summary"), false, "the Operations modules leaked onto Overview");

  await r.press("Workspace views: Operations");
  assert.ok(r.hasText("Verification & production"));
  assert.ok(r.hasText("Verification summary"));
  assert.ok(r.hasText("PROOVRA records integrity signals; it does not determine factual truth or legal admissibility."));
  assert.ok(r.hasText("Report production"));
  assert.equal(r.hasText("What needs attention"), false);

  await r.press("Workspace views: Analytics");
  assert.ok(r.hasText("Workspace analytics"));
  assert.ok(r.hasText("Recent activity"));
  assert.ok(r.hasText("Storage"), "storage now reads workspaces.personal.storage");
  assert.ok(r.texts().some((t) => t.includes("1.2 GB")));
});

test("an empty workspace offers the first workflow, not a verdict", async () => {
  routes["/v1/evidence"] = () => ({ items: [], nextCursor: null });
  routes["/v1/dashboard/command-center"] = () => ({ sections: { caseOperations: { status: "ok", data: { activeCasesCount: 0, topCases: [] } } } });
  routes["/v1/dashboard/trust-summary"] = () => ({ totalEvidence: 0, publicVerify: { published: 0, unpublished: 0, suspended: 0 } });
  const r = await render();
  assert.ok(r.hasText("Your newest records appear here after the first capture."));
  assert.ok(r.hasText("Start your first evidence workflow"));
  assert.ok(r.hasText("Capture your first record or create a case to get started."));
  assert.ok(r.byLabel("Getting started").length >= 1);
  assert.ok(r.hasText("No active matters yet"));
  // The header CTA switches to capture for a brand-new workspace.
  const capture = r.byRole("button").filter((n) => n.props.accessibilityLabel === "Capture evidence");
  assert.ok(capture.length >= 2, "header and onboarding both offer Capture evidence");
  await r.press("Create a case");
  assert.equal(M.calls.push.at(-1), "/cases");
});

test("All clear is said only when the Operations summary allows it", async () => {
  routes["/v1/dashboard/trust-summary"] = () => ({ totalEvidence: 5, signed: 5, endToEndReady: 5, tsa: { stamped: 5 }, ots: { anchored: 5 } });
  routes["/v1/dashboard/command-center"] = () => ({ sections: { caseOperations: { status: "ok", data: { activeCasesCount: 0, topCases: [] } } } });
  routes["/v1/workflow/intake-links"] = () => ({ links: [] });
  let r = await render();
  assert.ok(r.hasText("All clear"));
  assert.ok(r.hasText("No workspace priorities need attention right now."));
  r.unmount();

  routes["/v1/ops/summary"] = () => ({ summary: { mayAssertAllClear: false, clearRefusalReason: "UNRESOLVED_CONDITIONS" }, workspace: { operatorCount: 1 } });
  r = await render();
  assert.equal(r.hasText("All clear"), false, "a refused all-clear was printed anyway");
  assert.ok(r.hasText("Open operational conditions"));
  r.unmount();

  delete routes["/v1/ops/summary"];
  r = await render();
  assert.ok(r.hasText("Operations status unavailable"));
  assert.ok(r.hasText("Operations status"), "the failed source is named");
});

test("a failed evidence read shows an error with a retry, not an empty workspace", async () => {
  delete routes["/v1/evidence"];
  const r = await render();
  assert.equal(r.hasText("No evidence yet"), false, "a failure must not read as 'you have nothing'");
  assert.ok(r.byLabel("Try again").length > 0);
});

test("one failed dashboard source does not blank the page", async () => {
  delete routes["/v1/dashboard/command-center"];
  delete routes["/v1/reports"];
  const r = await render();
  assert.ok(r.hasText("IMG_0042.jpg"), "recent work still renders");
  assert.ok(r.hasText("Total evidence"), "the KPI row still renders");
});

test("KPIs show an em dash, never a fabricated zero, when a source is missing", async () => {
  routes = {
    "/v1/platform/context": OK()["/v1/platform/context"],
    "/v1/evidence": () => ({ items: [] }),
    "/v1/me/inbox": () => ({ items: [] }),
    "/v1/cases": () => ({ items: [] }),
  };
  const r = await render();
  assert.ok(r.hasText("Not available"), "an unknown metric says so");
});

/*
 * A FAILED SOURCE MUST NAME ITSELF.
 *
 * The KPI tiles were already honest about the VALUE — "—" and "Not
 * available", never a fabricated zero. What Home could not say was WHY, and
 * a 401, a 403, a 500 and a dropped connection all reached the tile as the
 * same silence: `Promise.allSettled` rejections were mapped to `undefined`.
 *
 * On a physical iPad on 2026-09-24 that read as a page of empty cards with
 * no way to tell "this workspace is empty" from "the request failed".
 */
test("a failed source is NAMED, and the page is still not blanked", async () => {
  // The stub answers 500 for anything unstubbed, so deleting a route is a
  // real server failure rather than an absent response.
  delete routes["/v1/me/inbox"];
  const r = await render();

  assert.ok(
    r.hasText("Inbox"),
    "the failed source is named in the words a person can act on",
  );
  assert.ok(
    r.hasText("Total evidence"),
    "the KPI row still renders — a failure must not blank the page",
  );
  assert.ok(
    r.hasText("IMG_0042.jpg"),
    "recent work, which did load, is still shown",
  );
});

/*
 * NO WORKSPACE IS A THIRD STATE, NOT AN EMPTY ONE.
 *
 * Six of the ten requests short-circuit to `Promise.resolve(null)` when
 * there is no active workspace — they are never SENT. That used to look
 * exactly like a workspace with nothing in it.
 */
test("with no workspace, Home says so rather than showing nothing", async () => {
  routes["/v1/platform/context"] = () => ({ context: {} });
  const r = await render();

  assert.ok(
    r.hasText("No workspace is selected"),
    "the screen distinguishes an unchosen workspace from an empty one",
  );
  assert.ok(
    !r.hasText("Some figures could not be loaded"),
    "nothing failed here, so nothing should claim it did",
  );
});

test("Home does not carry its own search card — the shell header owns it", async () => {
  /*
   * T-09a / RC-10 — this test used to assert a search card ON HOME, which Home
   * satisfied and which hid the actual defect: that card was the app's ONLY
   * route to `/search`, so five of the seven primary destinations had no search
   * at all. Asserting it here made the narrow implementation look correct.
   *
   * The affordance moved UP into `src/ui/header.tsx`, which `ProovraShell`
   * renders on every surface. The requirement — "search is reachable" — is now
   * strictly better satisfied, and it is verified where it actually lives:
   * `test/header-search.test.mjs` asserts the rendered control, that the shell
   * mounts the header in BOTH nav modes, and that every tab renders through
   * the shell.
   *
   * What this test now guards is that the duplicate does not come back: two
   * search entry points on one screen is not what the web does, and it would
   * let someone "fix" a future header regression by re-adding a Home-only card.
   */
  const r = await render();
  assert.equal(
    r.byLabel("Search evidence and cases").length,
    0,
    "Home re-grew its own search card. Search belongs to the shell header so " +
      "it is reachable from every destination, not just this one.",
  );
});

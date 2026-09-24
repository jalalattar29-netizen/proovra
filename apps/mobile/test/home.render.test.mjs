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
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

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

const OK = () => ({
  /*
   * THE ENVELOPE SHAPE THE SERVER ACTUALLY SENDS.
   *
   * This stub nested `activeSpace` under a `context` key. The route answers
   * `reply.code(200).send(result.envelope)` with `activeSpace` at the TOP
   * level, and `projectPlatformContext` reads it there.
   *
   * So `activeTeamId` was null in every test in this file: six of the ten Home
   * requests short-circuited to `Promise.resolve(null)` and the
   * workspace-scoped path — the one a signed-in person actually uses — was
   * never exercised at all.
   */
  "/v1/platform/context": () => ({ activeSpace: { id: "team-1", type: "ORGANIZATION" } }),
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
  }),
  "/v1/dashboard/command-center": () => ({ evidence: { total: 1280 }, cases: { active: 4 } }),
  "/v1/dashboard/trust-summary": () => ({ totalEvidence: 1280, endToEndReady: 1180 }),
  "/v1/billing/overview": () => ({ storage: { usedLabel: "1.2 GB", limitLabel: "5 GB" } }),
  "/v1/reports": () => ({ readyCount: 12, packagesReady: 3 }),
  "/v1/workflow/intake-links": () => ({ items: [{ id: "l1" }, { id: "l2" }] }),
  "/v1/me/inbox": () => ({
    items: [
      { itemKey: "i1", title: "Submission awaiting review", severity: "critical" },
      { itemKey: "i2", title: "Invitation pending", severity: "low" },
    ],
  }),
  "/v1/cases": () => ({ items: [{ id: "c-1", title: "Leaking roof", status: "OPEN" }] }),
});

before(async () => {
  M = await loadWithProviders("app/(tabs)/index.tsx");
});
beforeEach(() => {
  requests = [];
  routes = OK();
  installFetch();
});

const render = () => renderInProviders(M, h(M.default, {}));

test("Home reads the canonical dashboard sources, not just two", async () => {
  await render();
  const paths = requests.map((r) => r.path.split("?")[0]);
  for (const p of [
    "/v1/evidence",
    "/v1/billing/overview",
    "/v1/me/inbox",
    "/v1/cases",
  ]) {
    assert.ok(paths.includes(p), `Home never requested ${p}`);
  }
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

test("the priority queue leads with the urgent item", async () => {
  const r = await render();
  assert.ok(r.hasText("Submission awaiting review"));
  assert.ok(r.hasText("Invitation pending"));
  const texts = r.texts();
  assert.ok(
    texts.indexOf("Submission awaiting review") < texts.indexOf("Invitation pending"),
    "a queue ordered by arrival buries the thing that matters",
  );
});

test("recent evidence and active matters both render", async () => {
  const r = await render();
  assert.ok(r.hasText("IMG_0042.jpg"));
  assert.ok(r.hasText("Leaking roof"));
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

test("the capture CTA is not double-prefixed", async () => {
  // The canonical string IS "+ Capture Evidence" — the plus is part of it.
  // Prepending another rendered "+ + Capture Evidence" on the landing page.
  const r = await render();
  assert.ok(r.hasText("+ Capture Evidence"));
  assert.equal(r.hasText("+ + Capture Evidence"), false);
});

test("Home has its own capture CTA, in addition to the nav destination", async () => {
  const r = await render();
  const capture = r
    .byRole("button")
    .filter((n) => String(n.props.accessibilityLabel ?? "").includes("Capture"));
  // One in the summary band, one in the shell nav — the same split the web has
  // between its Home hero and its sidebar.
  assert.equal(capture.length, 2);
});

test("an empty workspace explains what belongs here and offers the next action", async () => {
  routes["/v1/evidence"] = () => ({ items: [] });
  routes["/v1/cases"] = () => ({ items: [] });
  routes["/v1/me/inbox"] = () => ({ items: [] });
  const r = await render();
  assert.ok(r.hasText("No evidence yet"));
  assert.ok(r.hasText("Capture your first record to see it here."));
  assert.ok(r.hasText("No open matters"));
  assert.ok(r.hasText("Nothing is waiting on you"));
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

test("the search entry point is present and reachable", async () => {
  const r = await render();
  assert.equal(r.byLabel("Search evidence and cases").length, 1);
});

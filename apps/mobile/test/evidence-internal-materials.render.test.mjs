/**
 * RENDER TESTS for Evidence Detail › Internal materials.
 *
 * The surface F-09 was found on. The parsers read `notes` and `annotations`
 * while both routes have always answered `{ items }`, so the tab rendered "No
 * legal notes on this record." for every record that had them - and 2156 unit
 * assertions passed, because the fixtures were written from the same guess as
 * the code.
 *
 * A unit test over a pure parser could never catch that, and neither could the
 * contract audit on its own: it compares key sets, not what a person sees. So
 * this drives the REAL component through the REAL apiFetch with
 * `globalThis.fetch` stubbed to return the REAL response envelopes, and asserts
 * the rows reach the screen.
 *
 * The envelopes below are verbatim from the handlers:
 *   evidence.routes.ts:7515  legal notes   { items: [...] }
 *   evidence.routes.ts:7673  annotations   { items: [...] }
 * with the author object as mapCollaborativeAuthor builds it (:3213).
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
    const responder = Object.entries(routes).find(([p]) => path.startsWith(p));
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

const AUTHOR = { id: "u-1", displayName: "Ada Lovelace", email: "ada@example.com" };

const NOTE = {
  id: "3f1c2a6e-1111-4a2b-8c3d-000000000001",
  evidenceId: "ev-1",
  noteType: "PRIVILEGED",
  body: "Counsel reviewed the chain of custody.",
  createdAt: "2026-09-20T10:15:00.000Z",
  updatedAt: "2026-09-20T10:15:00.000Z",
  edited: false,
  author: AUTHOR,
};

const ANNOTATION = {
  id: "7b2d4f80-2222-4c3d-9e0f-000000000002",
  evidenceId: "ev-1",
  evidencePartId: null,
  annotationType: "TIMESTAMP",
  body: "The timestamp overlay is legible here.",
  pageNumber: null,
  mediaTimestampMs: 125000,
  x: null,
  y: null,
  width: null,
  height: null,
  coordinateSpace: "TIME_ONLY",
  createdAt: "2026-09-20T10:16:00.000Z",
  updatedAt: "2026-09-20T10:16:00.000Z",
  edited: false,
  author: AUTHOR,
};

const POPULATED = () => ({
  "/v1/evidence/ev-1/legal-notes": () => ({ body: { items: [NOTE] } }),
  "/v1/evidence/ev-1/annotations": () => ({ body: { items: [ANNOTATION] } }),
});

before(async () => {
  M = await loadWithProviders("src/ui/evidence-internal-materials.tsx");
});

beforeEach(() => {
  requests = [];
  routes = POPULATED();
  installFetch();
});

const render = () => renderInProviders(M, h(M.EvidenceInternalMaterials, { evidenceId: "ev-1" }));

test("it reads both internal-materials routes", async () => {
  await render();
  const paths = requests.map((r) => r.path);
  assert.ok(paths.includes("/v1/evidence/ev-1/legal-notes"));
  assert.ok(paths.includes("/v1/evidence/ev-1/annotations"));
});

test("a record WITH legal notes and annotations displays them", async () => {
  // THE F-09 REGRESSION, at the only level that could have caught it: not
  // "does the parser return a row" but "does the row reach the screen".
  const r = await render();
  assert.ok(r.hasText("Counsel reviewed the chain of custody."), "the legal note is not on screen");
  assert.ok(r.hasText("The timestamp overlay is legible here."), "the annotation is not on screen");
  assert.ok(
    !r.hasText("No legal notes on this record."),
    "a record WITH notes was described as having none - this is F-09",
  );
  assert.ok(!r.hasText("No annotations on this record."));
});

test("the author is shown by name, never by user id", async () => {
  const r = await render();
  assert.ok(r.hasText("Ada Lovelace"), "the author's name is missing");
  assert.ok(
    !r.texts().some((t) => t.includes("u-1")),
    "a raw user id reached the screen where an author belongs",
  );
});

test("privilege is stated on the row, not only in the section header", async () => {
  const r = await render();
  assert.ok(r.hasText("Privileged"));
  assert.ok(
    r.hasText("not included in public verification"),
    "the internal-materials boundary must be stated where the notes are",
  );
});

test("an empty list says the record has none", async () => {
  routes = {
    "/v1/evidence/ev-1/legal-notes": () => ({ body: { items: [] } }),
    "/v1/evidence/ev-1/annotations": () => ({ body: { items: [] } }),
  };
  const r = await render();
  assert.ok(r.hasText("No legal notes on this record."));
  assert.ok(r.hasText("No annotations on this record."));
});

test("an authorization refusal is not reported as an empty record", async () => {
  routes = {
    "/v1/evidence/ev-1/legal-notes": () => ({
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "You do not have access to this record." } },
    }),
    "/v1/evidence/ev-1/annotations": () => ({ body: { items: [ANNOTATION] } }),
  };
  const r = await render();
  assert.ok(r.hasText("Legal notes could not be loaded."), "a refusal must be visible as a failure");
  assert.ok(
    !r.hasText("No legal notes on this record."),
    "a refusal was rendered as a record with no notes on it",
  );
  // A refusal on one must not hide the other.
  assert.ok(r.hasText("The timestamp overlay is legible here."));
});

test("a response this build cannot read fails loudly", async () => {
  // Exactly the F-09 shape: a well-formed 200 carrying an envelope we do not
  // recognise. Silently reporting an empty list is what shipped.
  routes = {
    "/v1/evidence/ev-1/legal-notes": () => ({ body: { rows: [NOTE] } }),
    "/v1/evidence/ev-1/annotations": () => ({ body: { rows: [ANNOTATION] } }),
  };
  const r = await render();
  assert.ok(r.hasText("Legal notes could not be loaded."));
  assert.ok(r.hasText("Annotations could not be loaded."));
  assert.ok(!r.hasText("No legal notes on this record."));
  assert.ok(!r.hasText("No annotations on this record."));
});

test("a failure offers a retry that re-reads both routes", async () => {
  routes = {
    "/v1/evidence/ev-1/legal-notes": () => ({ status: 500, body: { message: "boom" } }),
    "/v1/evidence/ev-1/annotations": () => ({ body: { items: [] } }),
  };
  const r = await render();
  const before = requests.length;
  await r.press("Try again");
  assert.ok(requests.length > before, "Try again sent no request");
});

test("adding a note posts the canonical body and re-reads the list", async () => {
  const r = await render();
  await r.type("Legal note", "A new note.");
  const before = requests.filter((x) => x.path === "/v1/evidence/ev-1/legal-notes").length;
  await r.press("Add legal note");
  const posts = requests.filter(
    (x) => x.method === "POST" && x.path === "/v1/evidence/ev-1/legal-notes",
  );
  assert.equal(posts.length, 1);
  assert.ok(
    requests.filter((x) => x.path === "/v1/evidence/ev-1/legal-notes").length > before + 1,
    "the list must be re-read after a write, not left stale",
  );
});

/**
 * CANONICAL CAPTURE DRAFT — the convergence, tested at the level that matters.
 *
 * The defect was never "Discard is buggy". It was that native staged into a
 * UC-0 direct-session which RESERVES the Evidence record on the first item,
 * while the canonical lifecycle (`/v1/capture/sessions`) stages into a DRAFT
 * that holds no Evidence at all and creates it once, at finalize. Two
 * consequences fell out of that one difference: Discard left an orphan, and a
 * session was locked to the first item's media type.
 *
 * These cover the shaping rules. `capture-lifecycle.render.test.mjs` covers the
 * lifecycle itself, against the real screen and the real requests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/capture/capture-draft.ts"), "utf8").replace(
  /^import \{ apiFetch \}.*$/m,
  // Lazily, so a test can install its handler AFTER the module is evaluated.
  "const apiFetch = (...a) => globalThis.__apiFetch(...a);",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const D = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/* ------------------------------------------------------- type derivation */

test("a uniform session keeps its kind", () => {
  assert.equal(D.deriveBatchEvidenceType(["image/jpeg", "image/png"]), "PHOTO");
  assert.equal(D.deriveBatchEvidenceType(["video/mp4"]), "VIDEO");
  assert.equal(D.deriveBatchEvidenceType(["audio/mp4", "audio/mpeg"]), "AUDIO");
  assert.equal(D.deriveBatchEvidenceType(["application/pdf"]), "DOCUMENT");
});

test("a MIXED session is DOCUMENT — the canonical rule, not an invention", () => {
  // deriveBatchEvidenceType in apps/web/app/(app)/capture/_lib/file-utils.ts:
  // one kind → that kind; more than one → DOCUMENT. Mirrored exactly, because
  // this is what makes mixed media expressible at all.
  assert.equal(D.deriveBatchEvidenceType(["audio/mp4", "image/jpeg"]), "DOCUMENT");
  assert.equal(D.deriveBatchEvidenceType(["image/jpeg", "video/mp4", "application/pdf"]), "DOCUMENT");
});

test("an empty session falls back to DOCUMENT rather than throwing", () => {
  assert.equal(D.deriveBatchEvidenceType([]), "DOCUMENT");
});

test("MIME inference matches the canonical mapping", () => {
  assert.equal(D.inferKindFromMimeType("image/heic"), "PHOTO");
  assert.equal(D.inferKindFromMimeType("VIDEO/QUICKTIME"), "VIDEO", "case-insensitive");
  assert.equal(D.inferKindFromMimeType("audio/x-m4a"), "AUDIO");
  assert.equal(D.inferKindFromMimeType("application/octet-stream"), "DOCUMENT");
  assert.equal(D.inferKindFromMimeType(""), "DOCUMENT", "an unknown type is a document, not a crash");
});

test("the primary item is the first staged one — it names the Evidence", () => {
  const items = [{ mimeType: "audio/mp4" }, { mimeType: "image/jpeg" }];
  assert.equal(D.primaryItem(items).mimeType, "audio/mp4");
  assert.equal(D.primaryItem([]), null);
});

/* ------------------------------------------------------------- item shape */

test("staged items are shaped for the canonical itemsSnapshot", () => {
  const out = D.toDraftItems([
    {
      clientItemId: "a1",
      fileName: "IMG_0042.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 12345,
      durationMs: null,
      sourceLabel: "CAMERA",
    },
  ]);
  assert.deepEqual(out, [
    {
      clientItemId: "a1",
      fileName: "IMG_0042.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 12345,
      durationMs: null,
      sourceLabel: "CAMERA",
      // The plan fields the canonical schema has always accepted. The native
      // draft was not sending them, so a role and a context note the operator
      // typed were lost at unmount and readiness had nothing to read.
      role: null,
      privateNote: null,
      checklistStepId: null,
      uploadState: "pending",
    },
  ]);
});

test("the plan fields travel when the operator has set them", () => {
  const [out] = D.toDraftItems([
    {
      clientItemId: "a1",
      fileName: "f",
      mimeType: "image/jpeg",
      sizeBytes: 1,
      role: "Primary evidence",
      privateNote: "Taken from the doorway",
      checklistStepId: "primary_overview_media",
    },
  ]);
  assert.equal(out.role, "Primary evidence");
  assert.equal(out.privateNote, "Taken from the doorway");
  assert.equal(out.checklistStepId, "primary_overview_media");
});

test("a missing or negative size is normalised — the schema requires int >= 0", () => {
  const out = D.toDraftItems([
    { clientItemId: "a", fileName: "f", mimeType: "image/jpeg", sizeBytes: undefined },
    { clientItemId: "b", fileName: "f", mimeType: "image/jpeg", sizeBytes: -5 },
    { clientItemId: "c", fileName: "f", mimeType: "image/jpeg", sizeBytes: 10.7 },
  ]);
  assert.deepEqual(out.map((i) => i.sizeBytes), [0, 0, 10]);
});

/* ------------------------------------------------------------- resumability */

test("only a DRAFT is resumable", () => {
  assert.equal(D.isDraftResumable("DRAFT"), true);
  for (const s of ["FINALIZED", "DISCARDED", "EXPIRED", null, undefined]) {
    assert.equal(D.isDraftResumable(s), false, `${s} must not be offered for resume`);
  }
});

/* ----------------------------------------------------------------- calls */

function withApi(handler) {
  globalThis.__apiFetch = handler;
}

test("opening a draft sends no bytes and creates no Evidence", async () => {
  const calls = [];
  withApi(async (path, init) => {
    calls.push({ path, method: init?.method, body: JSON.parse(init?.body ?? "{}") });
    return { session: { id: "draft-1", status: "DRAFT" } };
  });
  const draft = await D.openCaptureDraft({ teamId: "t1", useLocation: true });
  assert.deepEqual(draft, { id: "draft-1", status: "DRAFT" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/capture/sessions");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.teamId, "t1");
  assert.deepEqual(calls[0].body.items, []);
  // The thing that matters: no evidence endpoint was touched.
  assert.equal(calls.some((c) => c.path.includes("/evidence")), false);
});

test("an omitted teamId is left out entirely, so the server resolves personal scope", () => {
  return (async () => {
    let sent = null;
    withApi(async (_p, init) => {
      sent = JSON.parse(init.body);
      return { session: { id: "d", status: "DRAFT" } };
    });
    await D.openCaptureDraft({});
    assert.equal("teamId" in sent, false, "sending null would fail the uuid schema");
  })();
});

test("a server response without a session id is a loud failure", async () => {
  withApi(async () => ({}));
  await assert.rejects(() => D.openCaptureDraft({}), /Could not start the capture session/);
});

test("discarding a draft deletes it — there is no Evidence to release", async () => {
  const calls = [];
  withApi(async (path, init) => {
    calls.push({ path, method: init?.method });
    return {};
  });
  await D.discardCaptureDraft("draft-1");
  assert.deepEqual(calls, [{ path: "/v1/capture/sessions/draft-1", method: "DELETE" }]);
});

test("reading a draft tolerates either itemsSnapshot shape and never throws", async () => {
  withApi(async () => ({ session: { id: "d1", status: "DRAFT", itemsSnapshot: [{ clientItemId: "a" }] } }));
  assert.equal((await D.readCaptureDraft("d1")).items.length, 1);

  withApi(async () => ({ session: { id: "d1", status: "DRAFT", itemsSnapshot: { items: [{ clientItemId: "a" }] } } }));
  assert.equal((await D.readCaptureDraft("d1")).items.length, 1);

  withApi(async () => ({ session: { id: "d1", status: "DRAFT" } }));
  assert.deepEqual((await D.readCaptureDraft("d1")).items, []);

  withApi(async () => {
    throw new Error("network");
  });
  assert.equal(await D.readCaptureDraft("d1"), null, "a failed read is not a crash");
});

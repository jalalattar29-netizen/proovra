/**
 * B4-F-201 (Free-user audit 0ea0) — a native Finish retried after a failed
 * upload reuses the part it already declared for the SAME file.
 *
 * `uploadDirectCaptureItemAllocated` allocated `max + 1` over every part the
 * server held. A Finish that declared part 0 and then lost its PUT left part 0
 * DECLARED; the next Finish re-read the parts and declared the same file again
 * at part 1. The seal expects every declaration to be stored, so the record
 * never sealed (or, had the first PUT landed, sealed the file twice) — and it
 * kept one of the three Free slots.
 *
 * Run as real code (esbuild bundle) over in-memory files and the fake capture
 * server that enforces declaration idempotency (fake-capture-server.mjs).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";
import { installFakeCaptureServer } from "./support/fake-capture-server.mjs";

let M;
let server;
const FAST = { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, random: () => 0 };
const FILE = "file:///cache/clip.mp4";
const OTHER = "file:///cache/other.jpg";
const ITEM = { uri: FILE, mimeType: "video/mp4", source: "CAMERA" };

before(async () => {
  M = await loadModule("src/direct-capture.ts", [
    "src/capture/capture-retry.ts",
    "src/upload-utils.ts",
    "src/errors/safe-error.ts",
    "src/capture/capture-session-store.ts",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(() => {
  globalThis.__FS__ = new Map([
    [FILE, "clip bytes"],
    [OTHER, "other bytes"],
  ]);
  server = installFakeCaptureServer();
});

async function openAndReserve() {
  const session = await M.openDirectCaptureSession("PROOVRA_MOBILE_APP");
  const evidenceId = await M.reserveDirectCaptureEvidence(session, {
    type: "VIDEO",
    mimeType: "video/mp4",
    deviceTimeIso: "2026-11-15T09:00:00.000Z",
  });
  return { session, evidenceId };
}

/** The server's part list as `GET …/parts` reports it (contract C). */
function partsOf(evidenceId) {
  return async (session) =>
    [...server.state.sessions.get(session.captureSessionId).declarations.entries()].map(([partIndex, sha256]) => ({
      partIndex,
      sha256,
      state: server.state.storage.has(`${evidenceId}/${partIndex}`) ? "UPLOADED" : "DECLARED",
      source: "CAMERA",
    }));
}

/** A first Finish that declares the item and then loses every PUT. */
async function failedFinish(session, evidenceId) {
  server.failNext(/^PUT /, "network", FAST.attempts);
  await assert.rejects(() => M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, { freshSession: true, retry: FAST }));
  assert.equal(server.declarations(session.captureSessionId).length, 1, "the first Finish declared part 0");
  assert.equal(server.state.storage.size, 0, "and stored nothing");
}

test("B4-F-201: the next Finish reuses the DECLARED part for the same file — one declaration, one object", async () => {
  const { session, evidenceId } = await openAndReserve();
  await failedFinish(session, evidenceId);

  const up = await M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, { retry: FAST, listParts: partsOf(evidenceId) });

  assert.equal(up.partIndex, 0, "the retry re-uses part 0 instead of declaring part 1");
  assert.equal(server.declarations(session.captureSessionId).length, 1, "no second declaration of the same file");
  assert.deepEqual([...server.state.storage.keys()], [`${evidenceId}/0`]);
});

test("B4-F-201: a part already UPLOADED for the same file is not uploaded again", async () => {
  const { session, evidenceId } = await openAndReserve();
  await M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, { freshSession: true, retry: FAST });
  const putsBefore = server.state.requests.filter((r) => r.method === "PUT").length;

  // The app was killed before it recorded the success; the next Finish sees part 0 UPLOADED.
  const up = await M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, { retry: FAST, listParts: partsOf(evidenceId) });

  assert.equal(up.partIndex, 0);
  assert.equal(server.state.requests.filter((r) => r.method === "PUT").length, putsBefore, "no second PUT");
  assert.equal(server.declarations(session.captureSessionId).length, 1);
});

test("B4-F-201: a different file still takes the next free index, and a part another item holds is never reused", async () => {
  const { session, evidenceId } = await openAndReserve();
  await failedFinish(session, evidenceId);

  const other = await M.uploadDirectCaptureItemAllocated(
    session,
    evidenceId,
    { uri: OTHER, mimeType: "image/jpeg", source: "CAMERA" },
    { retry: FAST, listParts: partsOf(evidenceId) },
  );
  assert.equal(other.partIndex, 1, "a different digest never takes part 0");

  // Same bytes as part 0, but part 0 is already held by another item of this
  // capture (taken): a duplicate photo is its own part.
  globalThis.__FS__.set("file:///cache/clip-copy.mp4", "clip bytes");
  const copy = await M.uploadDirectCaptureItemAllocated(
    session,
    evidenceId,
    { uri: "file:///cache/clip-copy.mp4", mimeType: "video/mp4", source: "CAMERA" },
    { retry: FAST, taken: [0, 1], listParts: partsOf(evidenceId) },
  );
  assert.equal(copy.partIndex, 2);
});

/*
 * Re-verification (WEB-C2A-CAPTURE) of the acceptance criteria: one-to-one
 * reuse, duplicate content kept as separate parts, and a RESUMED session (the
 * app relaunched; items restored from the persisted record, some uploaded
 * with their server part index, some not yet uploaded with only the local
 * placeholder index) reuses correctly and never double-declares.
 */

/** The /capture Finish loop (app/(stack)/capture.tsx) over restored items. */
async function finishLoop(session, evidenceId, items) {
  for (const item of items) {
    if (item.uploaded) continue;
    const declared = await M.uploadDirectCaptureItemAllocated(
      session,
      evidenceId,
      { uri: item.uri, mimeType: item.mimeType, source: item.source },
      { taken: items.filter((c) => c.uploaded).map((c) => c.partIndex), retry: FAST, listParts: partsOf(evidenceId) },
    );
    item.partIndex = declared.partIndex;
    item.uploaded = true;
  }
  return items;
}

/** Persist and restore through the real capture-session store (app relaunch). */
function relaunch(session, evidenceId, items) {
  const stored = JSON.parse(
    JSON.stringify(
      M.serializeSession({
        captureSessionId: session.captureSessionId,
        expiresAtUtc: session.expiresAtUtc ?? "",
        evidenceId,
        type: "VIDEO",
        items,
      }),
    ),
  );
  const restored = M.validatePersisted(stored);
  assert.ok(restored, "the persisted record is valid");
  return restored.items.map((it) => ({ ...it }));
}

function assertOneToOne(session, evidenceId, items) {
  const indices = items.map((i) => i.partIndex);
  assert.equal(new Set(indices).size, items.length, `every item has its own part (${indices})`);
  const declared = server.declarations(session.captureSessionId).map((d) => d.partIndex).sort((a, b) => a - b);
  assert.deepEqual(declared, [...indices].sort((a, b) => a - b), "exactly one declaration per item — none orphaned, none doubled");
  for (const i of indices) assert.ok(server.state.storage.has(`${evidenceId}/${i}`), `part ${i} is stored`);
}

test("B4-F-201 resume: two identical files — one uploaded but not recorded, one declared with a lost PUT — map one-to-one after a relaunch", async () => {
  const { session, evidenceId } = await openAndReserve();
  globalThis.__FS__.set("file:///cache/a.jpg", "same bytes");
  globalThis.__FS__.set("file:///cache/b.jpg", "same bytes");
  const A = { id: "a", uri: "file:///cache/a.jpg", mimeType: "image/jpeg", source: "CAMERA", partIndex: 0, uploaded: false };
  const B = { id: "b", uri: "file:///cache/b.jpg", mimeType: "image/jpeg", source: "CAMERA", partIndex: 1, uploaded: false };

  // First Finish: A declared + stored at part 0, the app is killed before it records the success.
  await M.uploadDirectCaptureItemAllocated(session, evidenceId, A, { freshSession: true, retry: FAST });
  // B declared at part 1 (part 0 is A's now), its PUT is lost.
  server.failNext(/^PUT /, "network", FAST.attempts);
  await assert.rejects(() => M.uploadDirectCaptureItemAllocated(session, evidenceId, B, { taken: [0], retry: FAST }));
  assert.equal(server.declarations(session.captureSessionId).length, 2);
  const putsBefore = server.state.requests.filter((r) => r.method === "PUT").length;

  // Relaunch: both restored NOT uploaded, with their local placeholder indices.
  const restored = relaunch(session, evidenceId, [A, B]);
  assert.deepEqual(restored.map((i) => i.uploaded), [false, false]);
  await finishLoop(session, evidenceId, restored);

  assert.deepEqual(restored.map((i) => i.partIndex), [0, 1], "A takes the stored part, B its own declared part");
  assertOneToOne(session, evidenceId, restored);
  assert.equal(server.state.requests.filter((r) => r.method === "PUT").length, putsBefore + 1, "only B's bytes are sent again");
});

test("B4-F-201 resume: an item persisted WITH its server part index keeps it; identical-content items stay separate parts and never double-declare", async () => {
  const { session, evidenceId } = await openAndReserve();
  for (const n of ["a", "b", "c"]) globalThis.__FS__.set(`file:///cache/${n}.jpg`, "same bytes");
  const A = { id: "a", uri: "file:///cache/a.jpg", mimeType: "image/jpeg", source: "CAMERA", partIndex: 0, uploaded: false };
  const B = { id: "b", uri: "file:///cache/b.jpg", mimeType: "image/jpeg", source: "CAMERA", partIndex: 1, uploaded: false };
  const C = { id: "c", uri: "file:///cache/c.jpg", mimeType: "image/jpeg", source: "CAMERA", partIndex: 2, uploaded: false };

  // A uploaded and RECORDED (uploaded, server part index persisted).
  const a = await M.uploadDirectCaptureItemAllocated(session, evidenceId, A, { freshSession: true, retry: FAST });
  A.partIndex = a.partIndex;
  A.uploaded = true;
  // B declared, PUT lost; C never reached.
  server.failNext(/^PUT /, "network", FAST.attempts);
  await assert.rejects(() => M.uploadDirectCaptureItemAllocated(session, evidenceId, B, { taken: [A.partIndex], retry: FAST }));

  const restored = relaunch(session, evidenceId, [A, B, C]);
  assert.deepEqual(restored.map((i) => [i.uploaded, i.partIndex]), [[true, 0], [false, 1], [false, 2]]);
  await finishLoop(session, evidenceId, restored);

  assert.deepEqual(restored.map((i) => i.partIndex), [0, 1, 2]);
  assertOneToOne(session, evidenceId, restored);

  // A second retry of the whole Finish (nothing left to upload) declares nothing new.
  const again = relaunch(session, evidenceId, restored);
  await finishLoop(session, evidenceId, again);
  assert.equal(server.declarations(session.captureSessionId).length, 3, "a repeated Finish never double-declares");
});

test("B4-F-201 one-to-one: two identical files both left DECLARED each reuse ONE declared part, lowest first", async () => {
  const { session, evidenceId } = await openAndReserve();
  globalThis.__FS__.set("file:///cache/a.jpg", "same bytes");
  globalThis.__FS__.set("file:///cache/b.jpg", "same bytes");
  const A = { id: "a", uri: "file:///cache/a.jpg", mimeType: "image/jpeg", source: "CAMERA", partIndex: 0, uploaded: false };
  const B = { id: "b", uri: "file:///cache/b.jpg", mimeType: "image/jpeg", source: "CAMERA", partIndex: 1, uploaded: false };
  server.failNext(/^PUT /, "network", FAST.attempts * 2);
  await assert.rejects(() => M.uploadDirectCaptureItemAllocated(session, evidenceId, A, { freshSession: true, retry: FAST }));
  // A's index was held by this Finish when B was tried (it was never "uploaded" though).
  await assert.rejects(() => M.uploadDirectCaptureItemAllocated(session, evidenceId, B, { taken: [0], retry: FAST, listParts: partsOf(evidenceId) }));
  assert.equal(server.declarations(session.captureSessionId).length, 2, "two declarations of the same digest, nothing stored");

  const restored = relaunch(session, evidenceId, [A, B]);
  await finishLoop(session, evidenceId, restored);
  assert.deepEqual(restored.map((i) => i.partIndex), [0, 1]);
  assertOneToOne(session, evidenceId, restored);
});

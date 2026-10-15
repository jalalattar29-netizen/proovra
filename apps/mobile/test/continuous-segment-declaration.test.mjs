/**
 * AUD-017 — a continuous segment's declaration carries the recorder's running
 * count (`recordedThrough`), so the server can refuse a manifest that later
 * states fewer recorded segments than the client already declared (a hidden
 * tail). Run as real code (esbuild bundle) over a scripted API.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let C;
let declarations = [];

before(async () => {
  C = await loadModule("src/continuous-capture.ts", ["test/support/expo-stub.mjs"]);
});

beforeEach(() => {
  declarations = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    let body = {};
    if (path.includes("/declaration")) {
      declarations.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
      body = { declaration: { partIndex: 0 }, session: { expiresAtUtc: "2026-10-15T11:30:00.000Z" } };
    } else if (path.endsWith("/parts")) {
      body = { upload: { putUrl: "https://store.invalid/put", bucket: "b", key: "k" } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
});

const session = () => ({ captureSessionId: "cs-1", expiresAtUtc: "2026-10-15T11:00:00.000Z" });
const seg = (sequence) => ({
  uri: `file:///cache/segment-${sequence}.mp4`,
  sequence,
  startedAtOffsetMs: sequence * 6000,
  durationMs: 6000,
  widthPx: 1080,
  heightPx: 2400,
  orientation: "portrait",
});

test("AUD-017: the segment declaration sends recordedThrough = the segment's own count by default", async () => {
  await C.uploadContinuousSegment(session(), "ev-1", seg(3), 0);
  assert.equal(declarations.length, 1);
  assert.match(declarations[0].path, /\/parts\/3\/declaration$/);
  assert.equal(declarations[0].body.clientReportedSource, "SCREEN_SEGMENT");
  assert.equal(declarations[0].body.recordedThrough, 4);
});

test("AUD-017: a higher recorder count at declaration time is sent; a lower one never undercuts the segment", async () => {
  await C.uploadContinuousSegment(session(), "ev-1", seg(1), 0, {}, 7);
  await C.uploadContinuousSegment(session(), "ev-1", seg(5), 0, {}, 2);
  assert.deepEqual(declarations.map((d) => d.body.recordedThrough), [7, 6]);
  assert.equal(C.continuousRecordedThrough({ sequence: 0 }), 1);
  assert.equal(C.continuousRecordedThrough({ sequence: 0 }, Number.NaN), 1);
});

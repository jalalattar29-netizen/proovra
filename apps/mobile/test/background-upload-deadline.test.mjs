/**
 * F-P1-17 — an iOS BACKGROUND-session PUT is no longer cancelled by a JS timer
 * while it is still progressing.
 *
 * Run as real code (esbuild bundle): the real upload layer and deadline rule,
 * over the expo-file-system stub's opt-in upload tasks (progress callback +
 * cancellable task + session types) and the react-native AppState stub.
 *
 * RED on the pre-remediation tree: `uploadWithPut({ background: true })` was
 * bounded by the same absolute `withTimeout` as a foreground PUT, so a
 * transfer that kept reporting progress — or one that moved while the app was
 * suspended and the timer fired late on resume — was cancelled with TIMEOUT.
 *
 * What a node test cannot show (EXTERNALLY-UNVERIFIED): that iOS delivers the
 * queued progress events on resume, and how RN timers behave while suspended.
 * The rule is written so that neither matters: no cancel while not active,
 * and the window restarts when the app becomes active.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let M;
const FILE = "file:///cache/recording.mp4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  M = await loadModule("src/upload-utils.ts", ["src/capture/capture-retry.ts", "test/support/expo-stub.mjs"]);
});

let tasks;
beforeEach(() => {
  globalThis.__FS__ = new Map([[FILE, "recording bytes"]]);
  globalThis.__APP_STATE__ = "active";
  tasks = [];
});
afterEach(() => {
  M.__disableUploadTasks();
  delete globalThis.__FS__;
  globalThis.__APP_STATE__ = "active";
});

/**
 * A scripted upload task: `script(onProgress)` resolves the transfer's result
 * (or never does); `cancelAsync` records the cancel and resolves the transfer
 * with nothing, as expo-file-system does.
 */
function useTasks(script) {
  M.__enableUploadTasks((url, uri, options, onProgress) => {
    let finish;
    const done = new Promise((r) => (finish = r));
    const task = {
      options,
      onProgress,
      cancelled: false,
      uploadAsync: () => {
        void Promise.resolve(script(onProgress ?? (() => {}), task)).then((v) => finish(v));
        return done;
      },
      cancelAsync: async () => {
        task.cancelled = true;
        finish(undefined);
      },
    };
    tasks.push(task);
    return task;
  });
}

const put = (extra) =>
  M.uploadWithPut({
    putUrl: "https://storage.test/put",
    uri: FILE,
    mimeType: "video/mp4",
    checksumSha256Base64: "c2hh",
    contentMd5Base64: "bWQ1",
    ...extra,
  });

test("F-P1-17: a background PUT that keeps progressing outlives its window (no cancel, 200)", async () => {
  useTasks(async (progress) => {
    for (let sent = 1; sent <= 6; sent += 1) {
      await sleep(25);
      progress({ totalBytesSent: sent * 1000, totalBytesExpectedToSend: 6000 });
    }
    return { status: 200 };
  });
  const res = await put({ background: true, timeoutMs: 60 });
  assert.equal(res.status, 200);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].cancelled, false, "a progressing background upload was cancelled");
  assert.equal(tasks[0].options.sessionType, 0, "the PUT did not run in a BACKGROUND session");
  assert.equal(typeof tasks[0].onProgress, "function", "the background task reports no progress");
});

test("F-P1-17: while the app is suspended the deadline never cancels; on resume the window restarts", async () => {
  globalThis.__APP_STATE__ = "background";
  useTasks(async () => {
    // No progress is delivered while suspended (JS does not run then).
    await sleep(150);
    globalThis.__emitAppState("active");
    await sleep(30);
    return { status: 200 };
  });
  const res = await put({ background: true, timeoutMs: 50 });
  assert.equal(res.status, 200);
  assert.equal(tasks[0].cancelled, false, "the late timer cancelled a background upload on resume");
});

test("F-P1-17: a background PUT that STALLS in the foreground is still cancelled (TIMEOUT)", async () => {
  useTasks(() => new Promise(() => {}));
  await assert.rejects(put({ background: true, timeoutMs: 40 }), (err) => err?.code === "TIMEOUT");
  assert.equal(tasks[0].cancelled, true, "a stalled background task was left running");
});

test("F-P1-17: a FOREGROUND PUT keeps its absolute deadline even while progressing", async () => {
  useTasks(async (progress) => {
    for (let sent = 1; sent <= 6; sent += 1) {
      await sleep(25);
      progress({ totalBytesSent: sent * 1000 });
    }
    return { status: 200 };
  });
  await assert.rejects(put({ timeoutMs: 60 }), (err) => err?.code === "TIMEOUT");
  assert.equal(tasks[0].cancelled, true);
  assert.equal(tasks[0].options.sessionType, undefined, "a foreground PUT ran in a background session");
});

test("F-P1-17: the stall verdict (pure)", () => {
  const v = M.backgroundDeadlineVerdict;
  assert.deepEqual(v({ nowMs: 10_000, lastEvidenceMs: 0, windowMs: 1_000, appActive: false }), { cancel: false, recheckInMs: 1_000 });
  assert.deepEqual(v({ nowMs: 1_400, lastEvidenceMs: 1_000, windowMs: 1_000, appActive: true }), { cancel: false, recheckInMs: 600 });
  assert.deepEqual(v({ nowMs: 2_000, lastEvidenceMs: 1_000, windowMs: 1_000, appActive: true }), { cancel: true });
});

/**
 * B4-F-205 (Free-user audit 0ea0) — a continuous recording opens its session
 * with a per-recording attempt id (C-09 / AUD-026, as /capture does), adopts
 * the record a replayed open already reserved, and releases a session nothing
 * holds; a HELD segment refusal stops the recording once.
 *
 * Runs the real beginContinuousSession over the in-memory capture server
 * (fake-capture-server.mjs, which replays an open by clientAttemptId like the
 * API), plus the real screen source wiring.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule } from "./support/render.mjs";
import { installFakeCaptureServer } from "./support/fake-capture-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let M;
let server;

before(async () => {
  globalThis.__NATIVE_MODULES__ = { ProovraScreenCapture: {} };
  M = await loadModule("src/continuous-capture.ts", ["test/support/expo-stub.mjs", "src/capture/capture-retry.ts"]);
});

beforeEach(() => {
  globalThis.__RN_OS__ = "android";
  server = installFakeCaptureServer();
});

const opens = () => server.state.requests.filter((r) => r.method === "POST" && r.path === "/v1/capture/direct-sessions");

test("B4-F-205: the open carries the recording's attempt id", async () => {
  const opened = await M.beginContinuousSession({ clientAttemptId: "att-1" });
  assert.equal(opens()[0].body.clientAttemptId, "att-1");
  assert.equal(opened.evidenceId, "ev-cs-1");
});

test("B4-F-205: a lost reservation answer replays the open and adopts the record it reserved — no second session", async () => {
  server.failNext(/direct-sessions\/[^/]+\/evidence$/, "lost", 1);
  const opened = await M.beginContinuousSession({ clientAttemptId: "att-2" });
  assert.equal(opened.session.captureSessionId, "cs-1", "the same session");
  assert.equal(opened.evidenceId, "ev-cs-1", "the record the lost answer reserved");
  assert.equal(server.state.sessions.size, 1, "no second session, no second reserved record");
  assert.equal(opens().length, 2);
  assert.equal(opens()[1].body.clientAttemptId, "att-2", "the SAME attempt id");
  assert.equal(server.state.sessions.get("cs-1").status, "ACTIVE");
});

test("B4-F-205: a reservation that cannot be completed releases the opened session (no stranded slot)", async () => {
  server.failNext(/direct-sessions\/[^/]+\/evidence$/, { status: 409, code: "STORAGE_LIMIT_REACHED" }, 1);
  await assert.rejects(() => M.beginContinuousSession({ clientAttemptId: "att-3" }), (e) => e.code === "STORAGE_LIMIT_REACHED");
  assert.equal(server.state.sessions.get("cs-1").status, "DISCARDED", "the session nothing holds is released");
});

test("B4-F-205: the screen mints one attempt id per recording and stops ONCE on a HELD segment refusal", () => {
  const src = readFileSync(resolve(ROOT, "app/(stack)/continuous-capture.tsx"), "utf8");
  assert.match(src, /beginContinuousSession\(\{[^}]*clientAttemptId: Crypto\.randomUUID\(\)/s);
  const pump = src.slice(src.indexOf("const pump = useCallback("), src.indexOf("const onSegment = useCallback("));
  assert.match(pump, /classifyCaptureError\(err\) === "HELD"[\s\S]*?if \(stopRequestedRef\.current\) return;[\s\S]*?requestControlledStop\(/);
});

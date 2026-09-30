/**
 * ET-DC-08 — a screen capture opens its session in the ACTIVE workspace.
 *
 * UC-2 (Android single), UC-3 (Android continuous) and UC-5 (iOS continuous)
 * opened their direct-capture session with no teamId, so the server filed
 * every screen capture in the personal workspace (misfiling team work, and
 * refusing an identity that has no personal space). /capture has passed the
 * active workspace since 2026-09-29 (D13).
 *
 * The real `stageScreenCapture` / `beginContinuousSession` run against stubbed
 * native and transport modules; the test asserts on what they asked the
 * session opener for.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const HERE = dirname(fileURLToPath(import.meta.url));

const compile = (file) =>
  ts.transpileModule(readFileSync(resolve(HERE, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (code) => "data:text/javascript," + encodeURIComponent(code);

/** Every openDirectCaptureSession call: [mode, options]. */
globalThis.__opened = [];

const DIRECT_CAPTURE_STUB = dataUrl(`
  export const openDirectCaptureSession = async (mode, options) => {
    globalThis.__opened.push([mode, options ?? null]);
    return { captureSessionId: "cs-1", nonce: "n", expiresAtUtc: null, deviceBound: false };
  };
  export const reserveDirectCaptureEvidence = async () => { throw new Error("STOP_AFTER_OPEN"); };
  export const uploadDirectCaptureItem = async () => { throw new Error("STOP_AFTER_OPEN"); };
  export const sealDirectCapture = async (_s, fn) => fn();
  export const discardDirectCaptureSession = async () => ({});
  export const completeDirectCaptureSession = async () => { throw new Error("STOP_AFTER_OPEN"); };
  export const declareDirectCapturePart = async () => { throw new Error("STOP_AFTER_OPEN"); };
`);
const RN_STUB = dataUrl(`export const Platform = { OS: "android" };`);
const FS_STUB = dataUrl(`export const getInfoAsync = async () => ({ exists: true, size: 1 }); export const deleteAsync = async () => {};`);
const SHARED_STUB = dataUrl(`export const SCREEN_CONTINUOUS_STREAM_BOUNDS = {};`);

const load = async (file) => {
  const src = compile(file)
    .replace(/from ["']\.\/direct-capture["']/g, `from "${DIRECT_CAPTURE_STUB}"`)
    .replace(/from ["']react-native["']/g, `from "${RN_STUB}"`)
    .replace(/from ["']expo-file-system["']/g, `from "${FS_STUB}"`)
    .replace(/from ["']@proovra\/shared["']/g, `from "${SHARED_STUB}"`);
  return import(dataUrl(src));
};

const screen = await load("../src/screen-capture.ts");
const continuous = await load("../src/continuous-capture.ts");

beforeEach(() => {
  globalThis.__opened = [];
});

test("UC-2: a single screen capture opens its session in the active workspace", async () => {
  await assert.rejects(
    () => screen.stageScreenCapture({ frames: [{ uri: "file:///f0.png" }], stopReason: "USER" }, { teamId: "team-1" }),
    /STOP_AFTER_OPEN/,
  );
  assert.deepEqual(globalThis.__opened, [["DIRECT_SCREEN_CAPTURE_ANDROID", { teamId: "team-1" }]]);
});

test("UC-3 / UC-5: a continuous capture opens its session in the active workspace", async () => {
  await assert.rejects(() => continuous.beginContinuousSession({ teamId: "team-1" }), /STOP_AFTER_OPEN/);
  assert.deepEqual(globalThis.__opened, [["DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS", { teamId: "team-1" }]]);
});

test("both screens pass the platform context's active workspace", () => {
  for (const [screenFile, call] of [
    ["../app/(stack)/screen-capture.tsx", "stageScreenCapture(result, { teamId })"],
    ["../app/(stack)/continuous-capture.tsx", "beginContinuousSession({ teamId })"],
  ]) {
    const src = readFileSync(resolve(HERE, screenFile), "utf8");
    assert.match(src, /const teamId = usePlatformContext\(\)\.context\?\.activeTeamId \?\? null;/, screenFile);
    assert.ok(src.includes(call), `${screenFile} passes the active workspace`);
  }
});

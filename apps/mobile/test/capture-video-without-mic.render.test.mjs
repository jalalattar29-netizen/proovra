/**
 * F-P1-09 — VIDEO WITHOUT A MICROPHONE (product decision 2026-11-15), through
 * the real Capture screen over a scripted API (the real apiFetch, fetch
 * replaced) and the expo-camera stub's opt-in permission answers.
 *
 *   - microphone denied: the OS is still asked, the video camera opens MUTED
 *     (CameraView `mute`), a notice says so BEFORE Record, and the recorded
 *     clip's part declares `clientSignals.audioTracks = []` with the reason;
 *   - ordinary recording (microphone granted): no notice, not muted, and the
 *     part claims nothing about audio;
 *   - restoration: the microphone allowed in Settings and the app back in the
 *     foreground → the open camera records with sound again, notice gone;
 *   - camera denied: still refused, nothing opened (unchanged).
 *
 * RED on the pre-remediation tree: a microphone denial set "Microphone
 * permission denied" and never opened the camera.
 *
 * EXTERNALLY-UNVERIFIED: that a muted expo-camera recording on a real Android
 * / iOS device contains no audio track (read from expo-camera 16.0.18 source:
 * Android skips `withAudioEnabled()`, iOS removes the audio input).
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let mounted = [];

before(async () => {
  M = await loadModule("app/(stack)/capture.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/capture/capture-session-store.ts",
    "src/capture/video-audio.ts",
  ]);
});

beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/capture/intake-templates": () => ({ templates: [] }),
    "/v1/capture/sessions?status=DRAFT": () => ({ sessions: [] }),
    "/v1/capture/sessions": () => ({ session: { id: "draft-new", status: "DRAFT" } }),
    "/v1/evidence?scope=active": () => ({ items: [] }),
    "/v1/capture/direct-sessions": (p) => {
      if (p === "/v1/capture/direct-sessions") return { session: { captureSessionId: "cs-new", expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
      if (p.endsWith("/evidence")) return { evidence: { evidenceId: "ev-1" } };
      if (p.endsWith("/declaration")) return { declaration: {} };
      if (p.endsWith("/complete")) return { result: { evidenceId: "ev-1" } };
      return undefined;
    },
    "/v1/evidence/ev-1/parts": () => ({ upload: { putUrl: "https://storage.test/put" } }),
    "/v1/evidence/ev-1/artifacts/status": () => ({ outputs: { report: { state: "READY" } } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", tsaStatus: "STAMPED", tsaTokenPresent: true } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), {
      status: res === undefined ? 500 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.__UPLOAD_ASYNC__ = async (putUrl) => {
    requests.push({ path: putUrl, method: "PUT" });
    return { status: 200 };
  };
  globalThis.__CAMERA_RECORD__ = async () => ({ uri: "file:///cache/clip.mp4", duration: 4 });
  await M.AsyncStorage.__reset?.();
  M.calls.reset();
  await signIn(M);
  M.setCaptureSessionOwner("user-1");
});

afterEach(() => {
  delete globalThis.__UPLOAD_ASYNC__;
  delete globalThis.__CAMERA_RECORD__;
  delete globalThis.__CAMERA_PROPS__;
  delete globalThis.__MIC_GRANTED__;
  delete globalThis.__CAMERA_GRANTED__;
  globalThis.__APP_STATE__ = "active";
  for (const r of mounted) r.unmount();
  mounted = [];
});

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r.renderer);
  await settle();
  return r;
};
const notice = (r) => r.byTestId("capture-video-no-audio-notice");
const partBodies = () => requests.filter((q) => q.method === "POST" && q.path === "/v1/evidence/ev-1/parts").map((q) => q.body);

async function recordAndFinish(r) {
  await r.press("Record");
  await settle();
  assert.ok(r.byLabel("Finish & Sign (1)").length > 0, `the clip was not staged: ${r.texts().join(" / ")}`);
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  for (let i = 0; i < 30 && !requests.some((q) => q.path.endsWith("/complete")); i += 1) {
    await act(async () => { await new Promise((x) => setTimeout(x, 50)); });
  }
  await settle();
}

test("F-P1-09: microphone denied → muted camera, notice before Record, part states no audio was recorded", async () => {
  globalThis.__MIC_GRANTED__ = false;
  const r = await render();
  await r.press("Video");
  await settle();
  assert.ok(r.byTestId("capture-camera").length > 0, `the camera did not open: ${r.texts().join(" / ")}`);
  assert.ok(!r.texts().some((t) => t.includes("Microphone permission denied")), "the denial still refuses the camera");
  assert.equal(globalThis.__CAMERA_PROPS__?.mode, "video");
  assert.equal(globalThis.__CAMERA_PROPS__?.mute, true, "the camera was not muted");
  assert.ok(notice(r).length > 0, "no pre-recording notice");
  assert.ok(r.texts().some((t) => t.includes(M.VIDEO_WITHOUT_AUDIO_NOTICE)), r.texts().join(" / "));
  assert.ok(r.byLabel("Open Settings").length > 0, "no way to restore the microphone");

  await recordAndFinish(r);
  const parts = partBodies();
  assert.equal(parts.length, 1, `expected one part, got ${parts.length}`);
  assert.deepEqual(parts[0].clientSignals, { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" });
  assert.equal(parts[0].mimeType, "video/mp4");
  assert.equal(requests.filter((q) => q.path === "/v1/capture/direct-sessions/cs-new/complete").length, 1, "the record was not sealed");
});

test("F-P1-09: ordinary recording (microphone granted) → no notice, not muted, no audio claim", async () => {
  const r = await render();
  await r.press("Video");
  await settle();
  assert.ok(r.byTestId("capture-camera").length > 0);
  assert.equal(globalThis.__CAMERA_PROPS__?.mute, false);
  assert.equal(notice(r).length, 0, "a notice on an ordinary recording");
  await recordAndFinish(r);
  const parts = partBodies();
  assert.equal(parts.length, 1);
  assert.equal(parts[0].clientSignals, undefined, "an ordinary clip claimed something about audio");
});

test("F-P1-09: restoration — microphone allowed in Settings, app back → camera records with sound again", async () => {
  globalThis.__MIC_GRANTED__ = false;
  const r = await render();
  await r.press("Video");
  await settle();
  assert.equal(globalThis.__CAMERA_PROPS__?.mute, true);
  // The person allows the microphone in Settings and returns to PROOVRA.
  globalThis.__MIC_GRANTED__ = true;
  await act(async () => { globalThis.__emitAppState("background"); });
  await act(async () => { globalThis.__emitAppState("active"); });
  await settle();
  assert.equal(globalThis.__CAMERA_PROPS__?.mute, false, "the camera stayed muted after the microphone was allowed");
  assert.equal(notice(r).length, 0, "the no-audio notice outlived the restored microphone");
  await recordAndFinish(r);
  assert.equal(partBodies()[0]?.clientSignals, undefined);
});

test("F-P1-09: camera denied is still refused — nothing opens, Open Settings offered", async () => {
  globalThis.__CAMERA_GRANTED__ = false;
  const r = await render();
  await r.press("Video");
  await settle();
  assert.equal(r.byTestId("capture-camera").length, 0, "the camera opened without camera permission");
  assert.ok(r.texts().some((t) => t.includes("Camera permission denied")), r.texts().join(" / "));
  assert.ok(r.byLabel("Open Settings").length > 0);
});

test("F-P1-09: the persisted session keeps the muted-clip fact for a resumed upload", () => {
  const s = M.serializeSession({
    captureSessionId: "cs-1",
    expiresAtUtc: "2099-01-01T00:00:00.000Z",
    evidenceId: "ev-1",
    type: "VIDEO",
    items: [
      { id: "a", uri: "file:///a.mp4", mimeType: "video/mp4", partIndex: 0, source: "CAMERA", uploaded: false, audioRecorded: false },
      { id: "b", uri: "file:///b.mp4", mimeType: "video/mp4", partIndex: 1, source: "CAMERA", uploaded: false },
    ],
  });
  const back = M.validatePersisted(JSON.parse(JSON.stringify(s)));
  assert.equal(back.items[0].audioRecorded, false);
  assert.equal("audioRecorded" in back.items[1], false);
  assert.deepEqual(M.videoAudioClientSignals(back.items[0].audioRecorded), { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" });
  assert.equal(M.videoAudioClientSignals(back.items[1].audioRecorded), undefined);
});

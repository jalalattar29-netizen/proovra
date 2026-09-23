/**
 * THE TEN CAPTURE SCENARIOS — ONE LIFECYCLE, END TO END.
 *
 * F-08 was not that the product had two session models. It has one:
 * `openDirectCaptureSession` writes to the same `CaptureSession` table the
 * staging flow uses and the status enum spans both (schema.prisma:3583). It was
 * that the product had two USER-FACING ENDINGS — `/capture` staged into a draft
 * and created Evidence at an explicit Finish & Sign, while the two screen
 * surfaces acquired, sealed and produced Evidence on their own.
 *
 * These drive the REAL modules against a recording transport: the real
 * `stageScreenCapture`, the real `completeAcquisition`, the real durable store,
 * the real draft client. Assertions are on the REQUESTS that reached the wire
 * and on the state that survived, because the defect being guarded against is
 * precisely "which call happened, and when".
 *
 * Where a scenario needs a device, the repository-level integration is
 * exercised here and the physical half is recorded in docs/physical-acceptance
 * as pending. Nothing here claims hardware was run.
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

const compile = (rel) =>
  ts.transpileModule(readFileSync(resolve(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const dataUrl = (code) => `data:text/javascript,${encodeURIComponent(code)}`;

/**
 * Source with its comments removed.
 *
 * Asserting on a screen's SOURCE is asserting on what it does, and this
 * file's own history includes an assertion that matched prose in a comment
 * and passed while the code said otherwise.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------- transport -- */

/** Every request the real modules made, in order. */
let requests = [];
/** Path fragments that must fail, and how. */
let failures = new Map();

globalThis.__tx = async (path, init) => {
  const method = init?.method ?? "GET";
  requests.push({ path, method, body: init?.body ? JSON.parse(init.body) : null });
  for (const [fragment, error] of failures) {
    if (path.includes(fragment)) throw new Error(error);
  }
  if (path === "/v1/capture/direct-sessions") {
    return { session: { captureSessionId: "cs-1", expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
  }
  if (/\/evidence$/.test(path)) return { evidence: { evidenceId: "ev-1" } };
  if (/\/v1\/evidence\/.*\/parts$/.test(path)) {
    return { upload: { putUrl: "https://storage.test/put" } };
  }
  if (/screen-complete|continuous-complete|\/complete$/.test(path)) {
    return { result: { evidenceId: "ev-1" } };
  }
  if (/\/discard$/.test(path)) return { result: { discarded: true, releasedEvidenceId: "ev-1" } };
  if (path === "/v1/capture/sessions") return { session: { id: "draft-1", status: "DRAFT" } };
  return {};
};

const API_STUB = dataUrl(
  "export const apiFetch = async (path, init) => globalThis.__tx(path, init);",
);
const UPLOAD_STUB = dataUrl(
  [
    "export const computeFileIntegrityBase64 = async () => ({",
    "  sha256Hex: 'a'.repeat(64), checksumSha256Base64: 'c', contentMd5Base64: 'm', fileUri: 'file://x',",
    "});",
    "export const uploadWithPut = async () => {};",
  ].join("\n"),
);
const FS_STUB = dataUrl(
  [
    "export const cacheDirectory = 'file:///cache/';",
    "export const writeAsStringAsync = async () => {};",
    "export const deleteAsync = async () => {};",
    "export const getInfoAsync = async () => ({ exists: true, size: 1024 });",
  ].join("\n"),
);

const ACQUISITION_URL = dataUrl(compile("../src/capture/screen-acquisition.ts"));

const directCapture = await import(
  dataUrl(
    compile("../src/direct-capture.ts")
      .replace(/from ["']\.\/api["']/g, `from "${API_STUB}"`)
      .replace(/from ["']\.\/upload-utils["']/g, `from "${UPLOAD_STUB}"`)
      .replace('from "./capture/screen-acquisition"', `from "${ACQUISITION_URL}"`),
  )
);

const screenCapture = await import(
  dataUrl(
    compile("../src/screen-capture.ts")
      .replace(/from ["']expo-file-system["']/g, `from "${FS_STUB}"`)
      .replace(/from ["']\.\/direct-capture["']/g, `from "${dataUrl(
        compile("../src/direct-capture.ts")
          .replace(/from ["']\.\/api["']/g, `from "${API_STUB}"`)
          .replace(/from ["']\.\/upload-utils["']/g, `from "${UPLOAD_STUB}"`)
          .replace('from "./capture/screen-acquisition"', `from "${ACQUISITION_URL}"`),
      )}"`)
      .replace(/from ["']\.\.\/modules\/proovra-screen-capture["']/g, `from "${dataUrl("export {};")}"`),
  )
);

const acquisition = await import(ACQUISITION_URL);
const draft = await import(
  dataUrl(compile("../src/capture/capture-draft.ts").replace(/from ["']\.\.\/api["']/g, `from "${API_STUB}"`))
);
const store = await import(
  dataUrl(
    compile("../src/capture/capture-session-store.ts")
      .replace(/^import AsyncStorage.*$/m, "")
      .replace('from "./screen-acquisition"', `from "${ACQUISITION_URL}"`)
      .replace(/export async function saveCaptureSession[\s\S]*$/m, ""),
  )
);

const SESSION = { captureSessionId: "cs-1", expiresAtUtc: "2099-01-01T00:00:00.000Z" };

function frames(n) {
  return Array.from({ length: n }, (_, i) => ({
    uri: `file:///f${i}.png`,
    frameIndex: i,
    widthPx: 1080,
    heightPx: 2400,
    capturedAtOffsetMs: i * 1000,
  }));
}

const result = (n, over = {}) => ({
  frames: frames(n),
  captureStartedAtUtc: "2026-09-22T10:00:00.000Z",
  captureEndedAtUtc: "2026-09-22T10:01:00.000Z",
  stopReason: "USER_STOPPED",
  limitations: [],
  ...over,
});

const paths = () => requests.map((r) => `${r.method} ${r.path}`);
const sealCalls = () =>
  requests.filter((r) => /screen-complete|continuous-complete|\/complete$/.test(r.path));
const discards = () => requests.filter((r) => /direct-sessions\/.*\/discard$/.test(r.path));

beforeEach(() => {
  requests = [];
  failures = new Map();
});

/* ==========================================================================
 * 1. Mixed media in one session
 * ======================================================================== */

test("1. a session mixing acquisition origins is refused, and says why", () => {
  // One Evidence record states ONE origin — acquisitionMode is stamped on the
  // session at open and read back to stamp the record
  // (direct-capture-ingest.service.ts:251, :378). A photo from the camera and a
  // recording from MediaProjection therefore cannot share a record.
  //
  // Mixing media WITHIN an origin is what the product supports and what
  // deriveBatchEvidenceType is for; this is the boundary, stated rather than
  // silently sealed as one or the other.
  const photo = { sourceLabel: "CAMERA" };
  const screen = { sourceLabel: "DIRECT_SCREEN_CAPTURE_ANDROID" };

  assert.deepEqual(acquisition.resolveDraftAcquisition([photo, { sourceLabel: "PICKER" }]), {
    kind: "MOBILE_APP",
  });
  assert.deepEqual(acquisition.resolveDraftAcquisition([screen]), {
    kind: "SCREEN",
    mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
  });

  const mixed = acquisition.resolveDraftAcquisition([photo, screen]);
  assert.equal(mixed.kind, "MIXED_ORIGIN");
  assert.deepEqual(mixed.modes, ["DIRECT_SCREEN_CAPTURE_ANDROID", "PROOVRA_MOBILE_APP"]);
  assert.match(acquisition.MIXED_ORIGIN_REFUSAL, /one origin/i);

  // Two different screen modes are equally two origins.
  assert.equal(
    acquisition.resolveDraftAcquisition([screen, { sourceLabel: "DIRECT_SCREEN_CAPTURE_IOS" }]).kind,
    "MIXED_ORIGIN",
  );
});

/* ==========================================================================
 * 2. Standalone screen recording enters canonical Capture
 * ======================================================================== */

test("2. a standalone screen capture stages and does NOT create Evidence", async () => {
  const staged = await screenCapture.stageScreenCapture(result(3));

  // It opened the session, reserved, declared and uploaded every frame plus
  // the manifest — and stopped.
  assert.ok(paths().includes("POST /v1/capture/direct-sessions"));
  assert.ok(paths().includes("POST /v1/capture/direct-sessions/cs-1/evidence"));
  assert.equal(
    requests.filter((r) => /\/parts\/\d+\/declaration$/.test(r.path)).length,
    4,
    "three frames and one manifest are declared",
  );

  // THE POINT OF F-08: no completion, so no Evidence exists yet.
  assert.deepEqual(sealCalls(), [], "staging must not seal");
  assert.equal(staged.frameCount, 3);
  assert.ok(staged.manifestJson.length > 0, "the manifest travels with the session");
});

test("2b. the staged item is one row an operator can read, not one per frame", () => {
  const item = acquisition.toScreenDraftItem({
    mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
    clientItemId: "cs-1",
    partCount: 42,
    sizeBytes: 4096,
  });
  assert.match(item.fileName, /Screen capture \(42 frames\)/);
  assert.equal(item.sourceLabel, "DIRECT_SCREEN_CAPTURE_ANDROID");
  assert.equal(item.uploadState, "pending");
  // One item, standing for the recording. The frames are PARTS at finalize.
  assert.equal(item.mimeType, "image/png");
});

/* ==========================================================================
 * 3. Continuous recording with multiple segments
 * ======================================================================== */

test("3. a continuous recording seals through ITS route, not the frame route", () => {
  // continuous-complete carries the completeness that says whether the
  // recording was interrupted. Sealing it as a frame capture would throw that
  // away, which is why the route is chosen by the acquisition and never by a
  // default.
  assert.equal(
    acquisition.screenSealPath("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS", "cs-1"),
    "/v1/capture/direct-sessions/cs-1/continuous-complete",
  );
  assert.equal(
    acquisition.screenSealPath("DIRECT_SCREEN_CAPTURE_ANDROID", "cs-1"),
    "/v1/capture/direct-sessions/cs-1/screen-complete",
  );
  assert.equal(acquisition.screenPartUnit("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS"), "segment");
});

/* ==========================================================================
 * 4. ReplayKit (UC-5) output enters canonical Capture
 * ======================================================================== */

test("4. an Apple system broadcast seals through the continuous route", async () => {
  // UC-5 uses the CONTINUOUS transport (beginContinuousSession opens it with
  // the iOS mode), so it is the same sealing shape with a different origin.
  assert.equal(
    acquisition.screenSealPath("DIRECT_SCREEN_CAPTURE_IOS", "cs-9"),
    "/v1/capture/direct-sessions/cs-9/continuous-complete",
  );

  await directCapture.completeAcquisition(SESSION, {
    mode: "DIRECT_SCREEN_CAPTURE_IOS",
    manifestJson: '{"segments":2}',
  });
  assert.equal(sealCalls().length, 1);
  assert.equal(sealCalls()[0].path, "/v1/capture/direct-sessions/cs-1/continuous-complete");
  assert.deepEqual(sealCalls()[0].body, { manifestJson: '{"segments":2}' });
});

/* ==========================================================================
 * 5. Discard before finalization commits nothing
 * ======================================================================== */

test("5. discarding before finalize commits no Evidence and releases the session", async () => {
  await screenCapture.stageScreenCapture(result(2));
  assert.deepEqual(sealCalls(), [], "nothing was sealed by staging");

  await directCapture.discardDirectCaptureSession(SESSION);
  assert.equal(discards().length, 1);
  // A draft holds no Evidence, so discarding it releases nothing and
  // tombstones nothing — that is why staging moved onto the canonical session.
  await draft.discardCaptureDraft("draft-1");
  assert.ok(paths().includes("DELETE /v1/capture/sessions/draft-1"));
  assert.deepEqual(sealCalls(), []);
});

/* ==========================================================================
 * 6. Interrupted acquisition and recovery
 * ======================================================================== */

test("6. an interrupted session is resumable, and remembers what acquired it", () => {
  const persisted = store.serializeSession({
    captureSessionId: "cs-1",
    expiresAtUtc: "2099-01-01T00:00:00.000Z",
    evidenceId: "ev-1",
    type: "VIDEO",
    items: [{ id: "i1", uri: "", mimeType: "video/mp4", partIndex: 0, source: "SCREEN_SEGMENT", uploaded: true }],
    acquisition: {
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      manifestJson: '{"segments":3}',
    },
    now: Date.parse("2026-09-22T10:00:00Z"),
  });

  assert.equal(store.isSessionResumable(persisted, Date.parse("2026-09-22T10:05:00Z")), true);

  // Round-trips through the defensive parser — a resumed recording must seal
  // through its own route or it loses its continuity claim.
  const parsed = store.validatePersisted(JSON.parse(JSON.stringify(persisted)));
  assert.equal(parsed.acquisition.mode, "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS");
  assert.equal(parsed.acquisition.manifestJson, '{"segments":3}');
});

test("6b. an acquisition naming a mode this build cannot map is dropped, not guessed", () => {
  const parsed = store.validatePersisted({
    captureSessionId: "cs-1",
    evidenceId: "ev-1",
    type: "VIDEO",
    items: [{ id: "i1", uri: "", mimeType: "video/mp4", partIndex: 0 }],
    acquisition: { mode: "DIRECT_SCREEN_CAPTURE_HOLOLENS", manifestJson: "{}" },
    updatedAtIso: new Date().toISOString(),
  });
  // Sealing by an unmappable mode would fall through to a default route, and
  // the default is the wrong one for a continuous recording.
  assert.equal(parsed.acquisition, null);
});

/* ==========================================================================
 * 7. Upload failure and safe retry
 * ======================================================================== */

test("7. a staging failure releases the reservation and keeps the real reason", async () => {
  failures.set("/parts/1/declaration", "the network went away");

  await assert.rejects(() => screenCapture.stageScreenCapture(result(3)), /the network went away/);

  // The reservation is released rather than left as a custody-logged empty
  // record, and the caller is told the CAPTURE failed — not that a cleanup did.
  assert.equal(discards().length, 1, "a failed stage must release its reservation");
  assert.deepEqual(sealCalls(), []);
});

/* ==========================================================================
 * 8. Duplicate finalization and idempotency
 * ======================================================================== */

test("8. finalizing twice sends exactly one completion per call, to one route", async () => {
  const acq = { mode: "DIRECT_SCREEN_CAPTURE_ANDROID", manifestJson: "{}" };
  await directCapture.completeAcquisition(SESSION, acq);
  await directCapture.completeAcquisition(SESSION, acq);

  // The client never fans out: two taps are two requests to the SAME route,
  // and the server's reservation lock is what makes the second one refuse.
  // A client that silently swallowed the second would hide that answer.
  assert.equal(sealCalls().length, 2);
  for (const call of sealCalls()) {
    assert.equal(call.path, "/v1/capture/direct-sessions/cs-1/screen-complete");
  }
});

test("8b. an ordinary capture completes through /complete, not a screen route", async () => {
  await directCapture.completeAcquisition(SESSION, null);
  assert.equal(sealCalls().length, 1);
  assert.equal(sealCalls()[0].path, "/v1/capture/direct-sessions/cs-1/complete");
});

/* ==========================================================================
 * 9. Revoked permissions and inactive membership
 * ======================================================================== */

test("9. a refusal at reserve surfaces the refusal and leaves nothing behind", async () => {
  // An inactive membership or a revoked workspace is refused by the canonical
  // primitive at reserve, before a single byte moves.
  failures.set("/evidence", "FORBIDDEN");

  await assert.rejects(() => screenCapture.stageScreenCapture(result(2)), /FORBIDDEN/);
  assert.deepEqual(sealCalls(), []);
  // The session was opened, so it is released.
  assert.equal(discards().length, 1);
});

test("9b. a refusal at session open never reaches a reservation", async () => {
  failures.set("/v1/capture/direct-sessions", "FORBIDDEN");
  await assert.rejects(() => screenCapture.stageScreenCapture(result(2)), /FORBIDDEN/);
  assert.equal(
    requests.filter((r) => /\/evidence$/.test(r.path)).length,
    0,
    "nothing was reserved",
  );
});

/* ==========================================================================
 * 10. Provenance, report-readiness and custody
 * ======================================================================== */

test("10. the origin claim travels with the session and is never invented", async () => {
  await screenCapture.stageScreenCapture(result(1));
  const open = requests.find((r) => r.path === "/v1/capture/direct-sessions");
  // The mode is stated at open — it is what the server stamps the record with.
  assert.equal(open.body.mode, "DIRECT_SCREEN_CAPTURE_ANDROID");

  // And the staged row carries the same claim, so the draft and the session
  // cannot disagree about where the recording came from.
  const item = acquisition.toScreenDraftItem({
    mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
    clientItemId: "cs-1",
    partCount: 1,
    sizeBytes: 1,
  });
  assert.equal(item.sourceLabel, open.body.mode);
});

test("10b. no completion route is called by acquisition — custody records one finalize", async () => {
  // A GET or POST that writes to the custody chain must happen when the
  // operator acts, not while a screen loads. Staging touches no completion.
  await screenCapture.stageScreenCapture(result(2));
  assert.deepEqual(
    requests.filter((r) => /complete/.test(r.path)),
    [],
    "acquisition must not complete anything",
  );
});

/* ==========================================================================
 * 11. Mixed origin — the refusal reaches the person, with a way forward
 * ======================================================================== */

test("11. adding an item of another origin is refused BEFORE it is staged", () => {
  // THE DEFECT THIS CLOSES. `resolveDraftAcquisition` and the refusal copy
  // existed, were tested, and were consumed by no screen — so a staged screen
  // recording plus a camera photo uploaded into the ONE reserved Evidence and
  // sealed through the screen route. The record then claimed a screen-capture
  // origin for a photograph.
  const screen = acquisition.toScreenDraftItem({
    mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
    clientItemId: "cs-1",
    partCount: 2,
    sizeBytes: 10,
  });

  assert.equal(acquisition.wouldMixOrigins([screen], "CAMERA"), true);
  assert.equal(acquisition.wouldMixOrigins([screen], "DIRECT_SCREEN_CAPTURE_ANDROID"), false);
  // An empty draft mixes nothing — the first item decides the origin.
  assert.equal(acquisition.wouldMixOrigins([], "CAMERA"), false);
  // Two ordinary items are one origin, whatever their media type.
  assert.equal(
    acquisition.wouldMixOrigins([{ sourceLabel: "CAMERA" }], "PICKER"),
    false,
    "mixed MEDIA from one origin is supported and must not be refused",
  );
});

test("11b. the refusal names a next step the product can actually perform", () => {
  const staged = acquisition.resolveDraftAcquisition([
    acquisition.toScreenDraftItem({
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
      clientItemId: "cs-1",
      partCount: 1,
      sizeBytes: 1,
    }),
    { sourceLabel: "CAMERA" },
  ]);
  assert.equal(staged.kind, "MIXED_ORIGIN");

  const prompt = acquisition.mixedOriginPrompt(staged);
  assert.match(prompt.title, /separate evidence records/i);
  // It says WHY, and it says that nothing is lost — both are the difference
  // between a refusal and a dead end.
  assert.match(prompt.message, /one origin/i);
  assert.match(prompt.message, /nothing you have staged is lost/i);
  // Finishing the current capture is something the product can do: it seals
  // this record and leaves the next acquisition free to open its own session.
  assert.ok(prompt.finishLabel.length > 0);
  assert.ok(prompt.cancelLabel.length > 0);
  assert.ok(!/error|failed|invalid/i.test(prompt.title), "this is not a failure");
});

test("11c. the capture screen consults the guard on BOTH the add and the seal", () => {
  // A UI affordance is not the claim. The add-path keeps a person from
  // building an unsealable draft; the seal-path is where the origin is
  // actually stated, and it refuses independently.
  // Comments stripped: the point is what the screen DOES, and this file's
  // own history includes an assertion that matched prose in a comment.
  const raw = readFileSync(resolve(HERE, "../app/(stack)/capture.tsx"), "utf8");
  const screen = stripComments(raw);
  assert.match(screen, /wouldMixOrigins\(/, "the add path does not consult the guard");
  assert.match(
    screen,
    /sealing\.kind === "MIXED_ORIGIN"/,
    "the finalize path seals without checking the origin",
  );
  assert.match(screen, /setMixedOrigin\(/, "the refusal never reaches the person");
});

/**
 * AUD-004 — recovering an Android continuous recording after process death,
 * driven as real code (esbuild bundle): the real recovery planner/executor,
 * the real segment upload + manifest staging, the real direct-capture client
 * and the real native binding, over
 *
 *   - an in-memory fake of the native module whose ledger follows the Kotlin
 *     rules (ContinuousLedger.kt: binding check, confirm-then-delete, commit
 *     only for the bound session, process-death recovery as INTERRUPTED), and
 *   - a fake server enforcing the real idempotency (fake-capture-server.mjs).
 *
 * RED on the pre-remediation tree: after a process death the native stop
 * resolved `{}`, buildContinuousManifest threw on the missing device block, the
 * only action was Discard, and recorded-but-unuploaded segments were invisible.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";
import { installFakeCaptureServer } from "./support/fake-capture-server.mjs";

let M;
let server;

const DEVICE = { platform: "android", osVersion: "14", model: "Pixel 8", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" };
const START = Date.parse("2026-10-15T09:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/* ---------------------------------------------------- the fake native ledger */

const native = { ledger: null, active: false, calls: [] };

function nativeOutcome(l) {
  const finished = l.state === "FINISHED";
  const limitations = finished || l.state === "INTERRUPTED" ? l.limitations : [...new Set([...l.limitations, "CAPTURE_INTERRUPTED"])];
  return {
    osConsentGranted: true,
    captureStartedAtUtc: iso(START),
    captureEndedAtUtc: l.endedAtUtc ?? iso(START + l.totalDurationMs),
    device: DEVICE,
    totalDurationMs: l.totalDurationMs,
    segmentCount: l.segments.length,
    sessionCompleteness: finished && l.sessionCompleteness === "COMPLETE_SESSION" ? "COMPLETE_SESSION" : "INTERRUPTED_SESSION",
    terminationReason: l.terminationReason ?? "UNKNOWN",
    terminationDetail: null,
    limitations,
    interruption: l.interruption,
  };
}

/** recoverLedger (ContinuousLedger.kt): RECORDING with no recorder = process death. */
function recovered() {
  const l = native.ledger;
  if (!l) return null;
  if (l.state === "RECORDING" && !native.active) {
    native.ledger = {
      ...l,
      state: "INTERRUPTED",
      interruption: "PROCESS_DEATH",
      terminationReason: "UNKNOWN",
      limitations: [...new Set([...l.limitations, "CAPTURE_INTERRUPTED"])],
      endedAtUtc: iso(START + l.totalDurationMs),
    };
  }
  return native.ledger;
}

function installNative() {
  globalThis.__NATIVE_MODULES__ = {
    ProovraScreenCapture: {
      isSupported: () => true,
      isContinuousSupported: () => true,
      getContinuousState: () => ({ active: native.active, segmentCount: native.ledger?.segments.length ?? 0 }),
      getContinuousSegments: () => (native.ledger?.segments ?? []).filter((s) => s.uploadState === "RECORDED"),
      getContinuousLedger: () => {
        const l = recovered();
        if (!l) return null;
        return {
          recordingId: l.recordingId,
          captureSessionId: l.captureSessionId,
          evidenceId: l.evidenceId,
          ownerUserId: l.ownerUserId,
          state: l.state,
          active: native.active,
          interruption: l.interruption,
          outcome: nativeOutcome(l),
          segments: l.segments.map((s) => ({ ...s })),
        };
      },
      bindContinuousSession: async ({ captureSessionId, evidenceId, ownerUserId }) => {
        const l = native.ledger;
        if (l.captureSessionId && (l.captureSessionId !== captureSessionId || l.evidenceId !== evidenceId)) {
          throw Object.assign(new Error("This recording belongs to another capture session."), { code: "BINDING_MISMATCH" });
        }
        native.ledger = { ...l, captureSessionId, evidenceId, ownerUserId };
        return true;
      },
      markContinuousSegmentUploaded: async ({ captureSessionId, sequence, sha256Hex, sizeBytes }) => {
        native.calls.push(`mark:${sequence}`);
        const l = native.ledger;
        if (!l || l.captureSessionId !== captureSessionId) return false;
        const seg = l.segments.find((s) => s.sequence === sequence);
        if (!seg) return false;
        if (seg.uploadState === "UPLOADED") return seg.sha256Hex === sha256Hex;
        native.ledger = {
          ...l,
          segments: l.segments.map((s) => (s.sequence === sequence ? { ...s, uploadState: "UPLOADED", sha256Hex, sizeBytes } : s)),
        };
        // Confirmed first, THEN the redundant local copy goes.
        globalThis.__FS__.delete(seg.uri);
        return true;
      },
      commitContinuousSpool: async ({ captureSessionId }) => {
        native.calls.push("commit");
        if (native.active || !native.ledger || native.ledger.captureSessionId !== captureSessionId) return false;
        for (const s of native.ledger.segments) globalThis.__FS__.delete(s.uri);
        native.ledger = null;
        return true;
      },
      discardContinuousSpool: async () => {
        native.calls.push("discard");
        for (const s of native.ledger?.segments ?? []) globalThis.__FS__.delete(s.uri);
        native.ledger = null;
      },
      stopContinuousCapture: async () => {
        const l = recovered();
        if (!l) throw Object.assign(new Error("no recording"), { code: "NO_RECORDING" });
        return nativeOutcome(l);
      },
    },
  };
}

/** The service: start, then N segment closes, each durable before JS hears of it. */
function recordSegments(n, { finished = false } = {}) {
  const segments = Array.from({ length: n }, (_, i) => {
    const uri = `file:///data/files/proovra-continuous/proovra-continuous-${START}-${i}.mp4`;
    globalThis.__FS__.set(uri, `mp4 bytes of segment ${i}`);
    return {
      uri, sequence: i, startedAtOffsetMs: i * 6000, durationMs: 6000, widthPx: 1072, heightPx: 2384,
      orientation: "portrait", sizeBytes: 23, sha256Hex: null, uploadState: "RECORDED",
    };
  });
  native.ledger = {
    recordingId: `${START}-r`, captureSessionId: null, evidenceId: null, ownerUserId: null,
    state: finished ? "FINISHED" : "RECORDING", sessionCompleteness: finished ? "COMPLETE_SESSION" : null,
    terminationReason: finished ? "USER_STOPPED" : null, interruption: null, endedAtUtc: null,
    limitations: [], segments, totalDurationMs: n * 6000,
  };
}

/* ------------------------------------------------------------------ helpers */

before(async () => {
  M = await loadModule("src/capture/continuous-recovery.ts", [
    "src/continuous-capture.ts",
    "src/continuous-capture-flow.ts",
    "modules/proovra-screen-capture/index.ts",
    "src/capture/continuous-session-store.ts",
    "src/capture/capture-session-store.ts",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(() => {
  globalThis.__RN_OS__ = "android";
  globalThis.__FS__ = new Map();
  globalThis.__DELETED__ = [];
  native.ledger = null;
  native.active = false;
  native.calls = [];
  installNative();
  server = installFakeCaptureServer();
  M.AsyncStorage.__reset();
  M.setCaptureSessionOwner("user-1");
});

/** What the screen does before recording starts streaming: open, reserve, bind, persist. */
async function openAndBind() {
  const opened = await M.beginContinuousSession({});
  await M.bindContinuousSession({ captureSessionId: opened.session.captureSessionId, evidenceId: opened.evidenceId, ownerUserId: "user-1" });
  await M.saveLiveContinuousSession({
    captureSessionId: opened.session.captureSessionId, evidenceId: opened.evidenceId,
    expiresAtUtc: opened.session.expiresAtUtc, platform: "android", declared: [], clientLimitations: [],
    openedAtIso: iso(START),
  });
  return opened;
}

/** The live pump for one segment: upload, durable confirm, JS record. */
async function streamSegment(opened, i, { persist = true } = {}) {
  const seg = native.ledger.segments.find((s) => s.sequence === i);
  const declared = await M.uploadContinuousSegment(opened.session, opened.evidenceId, seg, 0);
  await M.confirmContinuousSegment(opened.session, seg, declared);
  if (persist) {
    const live = await M.loadLiveContinuousSession();
    await M.saveLiveContinuousSession({ ...live, declared: [...live.declared, declared] });
  }
  return declared;
}

/** EXACTLY what the screen runs on Recover + Continue (and nothing else). */
async function recoverAndStage() {
  const plan = M.planContinuousRecovery(M.getContinuousLedger(), await M.loadLiveContinuousSession(), "user-1");
  if (plan.kind !== "RECOVER") return { plan };
  const deps = M.continuousRecoveryDeps(async (state) => {
    const live = (await M.loadLiveContinuousSession()) ?? {
      captureSessionId: plan.session.captureSessionId, evidenceId: plan.evidenceId, expiresAtUtc: "",
      platform: "android", clientLimitations: [], openedAtIso: iso(START),
    };
    await M.saveLiveContinuousSession({ ...live, declared: state.declared, stagedManifest: state.stagedManifest });
  });
  const outcome = await M.recoverOnce(plan.session.captureSessionId, () => M.executeContinuousRecovery(plan, deps));
  if (outcome.kind === "STAGED") {
    await M.clearLiveContinuousSession();
    await M.releaseStagedContinuousSpool(plan.session.captureSessionId);
  }
  return { plan, outcome };
}

const manifestOf = (outcome) => JSON.parse(outcome.staged.manifestJson);

/* -------------------------------------------------------------------- tests */

test("AUD-004: process death after N segments — every recorded segment is recovered, sealed as INTERRUPTED", async () => {
  recordSegments(4);
  const opened = await openAndBind();
  await streamSegment(opened, 0); // declared + persisted in JS
  await streamSegment(opened, 1, { persist: false }); // confirmed natively; JS died before persisting
  // Segments 2 and 3 were recorded and never uploaded. The process dies here.

  const ledger = M.getContinuousLedger();
  assert.equal(ledger.state, "INTERRUPTED");
  assert.equal(ledger.interruption, "PROCESS_DEATH");
  assert.deepEqual(M.getContinuousSegments().map((s) => s.sequence), [2, 3], "the unuploaded segments are visible again");

  const { outcome } = await recoverAndStage();
  assert.equal(outcome.kind, "STAGED");
  const m = manifestOf(outcome);
  assert.equal(m.sessionCompleteness, "INTERRUPTED_SESSION", "never COMPLETE after a process death");
  assert.ok(m.limitations.includes("CAPTURE_INTERRUPTED"));
  assert.equal(m.terminationReason, "UNKNOWN");
  assert.equal(m.recordedSegmentCount, 4, "the tail is counted from the ledger");
  assert.deepEqual(m.segments.map((s) => s.sequence), [0, 1, 2, 3]);
  assert.deepEqual(m.device, DEVICE, "the device block comes from the ledger");
  assert.equal(m.totalDurationMs, 24000);

  // One declaration (custody event) per segment + the manifest, no duplicates.
  const decl = server.declarations(opened.session.captureSessionId);
  assert.deepEqual(decl.map((d) => d.partIndex), [0, 1, 2, 3, 4]);
  assert.equal(server.opens().length, 1, "no second session");
  assert.equal(server.reservations().length, 1, "no second evidence");
  // Staged: the spool is released through the bound ledger.
  assert.equal(M.getContinuousLedger(), null);
  assert.equal(globalThis.__FS__.size, 0);
});

test("AUD-004: a JS reload while recording is a reattach, never a recovery", async () => {
  recordSegments(2);
  const opened = await openAndBind();
  native.active = true; // the service is alive; only JS was reloaded
  const plan = M.planContinuousRecovery(M.getContinuousLedger(), await M.loadLiveContinuousSession(), "user-1");
  assert.equal(plan.kind, "ACTIVE");
  assert.equal(M.getContinuousLedger().state, "RECORDING", "an active recorder is not marked interrupted");
  assert.equal(server.declarations(opened.session.captureSessionId).length, 0);
});

test("AUD-004: retry — a network failure during recovery loses nothing, and the retry adds no duplicate", async () => {
  recordSegments(3);
  const opened = await openAndBind();
  await streamSegment(opened, 0);
  server.failNext(/declaration$/, "network", 10); // the connection is gone

  await assert.rejects(() => recoverAndStage());
  assert.equal(globalThis.__FS__.size, 2, "the unconfirmed segments stay on the device");
  assert.ok(M.getContinuousLedger(), "the ledger is kept");

  server.state.faults = []; // back online
  const { outcome } = await recoverAndStage();
  assert.equal(outcome.kind, "STAGED");
  assert.deepEqual(manifestOf(outcome).segments.map((s) => s.sequence), [0, 1, 2]);
  assert.deepEqual(server.declarations(opened.session.captureSessionId).map((d) => d.partIndex), [0, 1, 2, 3]);
});

test("AUD-004: partial upload — declared but never stored is re-sent idempotently (same index + digest)", async () => {
  recordSegments(2);
  const opened = await openAndBind();
  server.failNext(/^PUT https:\/\/storage\.test\/.*\/1$/, "network", 10);
  await streamSegment(opened, 0);
  await assert.rejects(() => streamSegment(opened, 1));
  assert.equal(server.declarations(opened.session.captureSessionId).length, 2, "segment 1 was declared before its PUT failed");
  assert.ok(globalThis.__FS__.has(native.ledger.segments[1].uri), "its local copy is kept");

  server.state.faults = [];
  const { outcome } = await recoverAndStage();
  assert.equal(outcome.kind, "STAGED");
  assert.equal(server.state.storage.get(`${opened.evidenceId}/1`), "mp4 bytes of segment 1", "the bytes reached storage");
  assert.deepEqual(server.declarations(opened.session.captureSessionId).map((d) => d.partIndex), [0, 1, 2], "no second declaration of segment 1");
});

test("AUD-004: restart during finalization — the fixed manifest is staged again byte-for-byte", async () => {
  recordSegments(3);
  const opened = await openAndBind();
  await streamSegment(opened, 0);
  // Finalization dies after the manifest was FIXED and declared, before its PUT.
  server.failNext(/^PUT https:\/\/storage\.test\/.*\/3$/, "network", 10);
  await assert.rejects(() => recoverAndStage());
  const fixed = (await M.loadLiveContinuousSession()).stagedManifest;
  assert.ok(fixed, "the manifest was persisted before its upload");

  // The restart, with the JS-side context drifted meanwhile (a limitation was
  // recorded late). A rebuilt manifest would differ and the server would
  // refuse it at index 3 (PART_ALREADY_DECLARED): the fixed one is reused.
  const live = await M.loadLiveContinuousSession();
  await M.saveLiveContinuousSession({ ...live, clientLimitations: ["SEGMENT_UPLOAD_BACKPRESSURE"] });
  server.state.faults = [];
  const { outcome } = await recoverAndStage();
  assert.equal(outcome.kind, "STAGED");
  assert.equal(outcome.staged.manifestJson, fixed.manifestJson);
  assert.equal(outcome.staged.manifestPartIndex, fixed.manifestPartIndex);
  const decl = server.declarations(opened.session.captureSessionId);
  assert.equal(decl.filter((d) => d.partIndex === 3).length, 1, "the manifest was declared once");
});

test("AUD-004: a reaper before recovery — a confirmed-only cleanup and a reaped session never delete the recording", async () => {
  recordSegments(3);
  const opened = await openAndBind();
  await streamSegment(opened, 0);
  // The device-side cleanup consults the ledger: only confirmed segments went.
  assert.deepEqual([...globalThis.__FS__.keys()].map((u) => u.slice(-5)), ["1.mp4", "2.mp4"]);
  // The server reaped the session before the app came back.
  server.reap(opened.session.captureSessionId);

  const { outcome } = await recoverAndStage();
  assert.equal(outcome.kind, "SESSION_GONE");
  assert.equal(outcome.code, "SESSION_EXPIRED");
  assert.equal(globalThis.__FS__.size, 2, "nothing was deleted");
  assert.ok(M.getContinuousLedger(), "the ledger awaits the user's explicit decision");
  assert.ok(!native.calls.includes("discard") && !native.calls.includes("commit"));
});

test("AUD-004: a double recovery request runs ONCE and the second call after staging finds nothing", async () => {
  recordSegments(2);
  const opened = await openAndBind();
  const [a, b] = await Promise.all([recoverAndStage(), recoverAndStage()]);
  assert.equal(a.outcome.kind, "STAGED");
  assert.equal(b.outcome.kind, "STAGED");
  assert.equal(a.outcome.staged.manifestJson, b.outcome.staged.manifestJson);
  assert.deepEqual(server.declarations(opened.session.captureSessionId).map((d) => d.partIndex), [0, 1, 2]);
  assert.equal(
    server.state.requests.filter((r) => /\/declaration$/.test(r.path)).length,
    3,
    "the second request joined the first: each part was declared once, not twice",
  );
  const again = await recoverAndStage();
  assert.equal(again.plan.kind, "NONE", "staged and committed: nothing left to recover");
});

test("AUD-004: a recording is never merged into another session", async () => {
  recordSegments(2);
  await openAndBind();
  // A stale JS record names a different session.
  const live = await M.loadLiveContinuousSession();
  await M.saveLiveContinuousSession({ ...live, captureSessionId: "cs-other", evidenceId: "ev-other" });
  const { plan } = await recoverAndStage();
  assert.equal(plan.kind, "MISMATCH");
  await assert.rejects(
    () => M.bindContinuousSession({ captureSessionId: "cs-other", evidenceId: "ev-other", ownerUserId: "user-1" }),
    /another capture session/,
  );
  assert.equal(await M.commitContinuousSpool({ captureSessionId: "cs-other" }), false, "commit refused for another session");
  assert.equal(globalThis.__FS__.size, 2);
  // Without the JS record, only the user who bound it may recover it.
  await M.clearLiveContinuousSession();
  assert.equal(M.planContinuousRecovery(M.getContinuousLedger(), null, "user-2").kind, "MISMATCH");
  assert.equal(M.planContinuousRecovery(M.getContinuousLedger(), null, "user-1").kind, "RECOVER");
});

test("AUD-004: a recording made before any session existed is never uploaded — explicit discard only", async () => {
  recordSegments(2);
  const plan = M.planContinuousRecovery(M.getContinuousLedger(), null, "user-1");
  assert.deepEqual(plan, { kind: "UNBOUND", segmentCount: 2 });
});

test("AUD-004: a clean finish before the death keeps the recorder's own COMPLETE claim", async () => {
  recordSegments(2, { finished: true });
  const opened = await openAndBind();
  await streamSegment(opened, 0);
  await streamSegment(opened, 1);
  const { outcome } = await recoverAndStage();
  assert.equal(manifestOf(outcome).sessionCompleteness, "COMPLETE_SESSION");
});

/* ------------------------------------------------------ drain (stuck queue) */

test("drainUploads: a queue that can never drain ends at the deadline, not never", async () => {
  let t = 0;
  const outcome = await M.drainUploadQueue({
    pending: () => 3,
    inFlight: () => 1, // a stuck upload
    hasSession: () => true,
    pump: () => {},
    deadlineMs: 1000,
    pollMs: 100,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  assert.equal(outcome, "DEADLINE");
  assert.ok(t >= 1000 && t <= 1100);
});

test("drainUploads: with no session the loop exits at once (pump() takes nothing)", async () => {
  let slept = 0;
  const outcome = await M.drainUploadQueue({
    pending: () => 2,
    inFlight: () => 0,
    hasSession: () => false,
    pump: () => {},
    deadlineMs: 60_000,
    sleep: async () => {
      slept += 1;
    },
  });
  assert.equal(outcome, "NO_SESSION");
  assert.equal(slept, 0);
});

test("drainUploads: an empty queue is drained", async () => {
  let pumped = 0;
  const outcome = await M.drainUploadQueue({
    pending: () => 0, inFlight: () => 0, hasSession: () => true, pump: () => { pumped += 1; }, deadlineMs: 10,
  });
  assert.equal(outcome, "DRAINED");
  assert.equal(pumped, 1);
});

test("AUD-004: a hung segment upload times out instead of hanging its worker", async () => {
  recordSegments(1);
  const opened = await openAndBind();
  server.failNext(/declaration$/, "hang", 1);
  const seg = native.ledger.segments[0];
  await assert.rejects(
    () => M.uploadContinuousSegment(opened.session, opened.evidenceId, seg, 0, { requestMs: 50, putMs: 50 }),
    (err) => err.code === "TIMEOUT",
  );
  assert.ok(globalThis.__FS__.has(seg.uri), "a timed-out segment stays recoverable");
});

test("AUD-004: the screen recovers from the ledger and never deletes by prefix without a commit", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/(stack)/continuous-capture.tsx", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /planContinuousRecovery\(getContinuousLedger\(\), await loadLiveContinuousSession\(\), userId\)/);
  assert.match(src, /executeContinuousRecovery\(/);
  assert.match(src, /recoverOnce\(active\.session\.captureSessionId/);
  assert.match(src, /await releaseStagedContinuousSpool\(active\.session\.captureSessionId\)/);
  assert.match(src, /await bindContinuousSession\(\{/);
  assert.match(src, /drainUploadQueue\(\{/);
  assert.ok(!/while \(queueRef\.current\.length > 0 \|\| workersRef\.current > 0\)/.test(src), "the unbounded drain loop is back");
});

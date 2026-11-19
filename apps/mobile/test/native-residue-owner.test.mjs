/**
 * PRO-NBC-03 (review gaps 1 and 2) / DEC-24 — native recovery is owner-gated on
 * every read path.
 *
 * Sign-out no longer deletes captured evidence, so on a shared device the
 * native recorders can still hold the signed-out person's material when the
 * next account signs in. These run the REAL gates (native-residue-owner.ts)
 * and the real sign-out teardown over a scripted native module:
 *
 *   - another account's recovered screen frames are never returned;
 *   - another account's frame ledger is never cleared;
 *   - another account's continuous recording is never reported as discardable;
 *   - what an earlier build (no native owner) or iOS left behind is claimed
 *     for the account that signs out, so the next account is refused too.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let M;
const native = { recovered: null, owner: undefined, ledger: null, recordings: [], calls: [] };
const FRAMES = {
  osConsentGranted: true,
  captureStartedAtUtc: "2026-11-19T10:00:00.000Z",
  captureEndedAtUtc: "2026-11-19T10:00:05.000Z",
  frames: [{ uri: "file:///files/proovra-frames/f0.png", frameIndex: 0, widthPx: 1, heightPx: 1, capturedAtOffsetMs: 0 }],
  stopReason: "INTERRUPTED",
  limitations: ["CAPTURE_INTERRUPTED"],
};
const LEDGER = { recordingId: "rec-1", captureSessionId: null, evidenceId: null, ownerUserId: null, state: "INTERRUPTED", active: false, segments: [] };

function install(os = "android") {
  globalThis.__RN_OS__ = os;
  const mod = {
    isSupported: () => true,
    isContinuousSupported: () => true,
    getState: () => ({ active: false, frameCount: 0 }),
    getContinuousState: () => ({ active: false, segmentCount: 0 }),
    getContinuousSegments: () => [],
    getRecoveredScreenCapture: () => native.recovered,
    clearScreenCaptureLedger: async () => {
      native.calls.push("clearScreenCaptureLedger");
      native.recovered = null;
    },
    getContinuousLedger: () => native.ledger,
    listContinuousRecordings: () => native.recordings,
    stopContinuousCapture: async () => native.calls.push("stopContinuousCapture"),
    discardContinuousSpool: async () => native.calls.push("discardContinuousSpool"),
  };
  // `undefined` models a native build from before the frame ledger carried its owner.
  if (native.owner !== undefined) mod.getRecoveredScreenCaptureOwner = () => native.owner;
  globalThis.__NATIVE_MODULES__ = { ProovraScreenCapture: mod };
}

before(async () => {
  M = await loadModule("src/capture/native-residue-owner.ts", [
    "src/capture/capture-teardown.ts",
    "src/capture/capture-session-store.ts",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(() => {
  Object.assign(native, { recovered: null, owner: undefined, ledger: null, recordings: [], calls: [] });
  M.AsyncStorage.__reset();
  install();
});

test("the verdict: the native owner wins, a claim is next, nothing at all is unclaimed", () => {
  assert.equal(M.residueOwnership({ nativeOwner: "a", claimedOwner: "b", userId: "a" }), "own");
  assert.equal(M.residueOwnership({ nativeOwner: "a", claimedOwner: "b", userId: "b" }), "foreign");
  assert.equal(M.residueOwnership({ nativeOwner: null, claimedOwner: "a", userId: "b" }), "foreign");
  assert.equal(M.residueOwnership({ nativeOwner: null, claimedOwner: null, userId: "b" }), "unclaimed");
  assert.equal(M.residueOwnership({ nativeOwner: "a", userId: null }), "foreign", "no known viewer never owns anything");
});

test("gap 1: frames the native ledger wrote for another account are never returned, and their ledger is never cleared", async () => {
  native.recovered = FRAMES;
  native.owner = "user-a";
  install();

  assert.deepEqual(await M.ownedRecoveredScreenCapture("user-b"), { kind: "foreign" });
  assert.equal(await M.clearOwnedScreenCaptureLedger("user-b"), false);
  assert.deepEqual(native.calls, [], "account B cleared account A's frame ledger");
  assert.ok(native.recovered, "account A's frames are still held");

  const own = await M.ownedRecoveredScreenCapture("user-a");
  assert.equal(own.kind, "own");
  assert.equal(own.result.frames.length, 1);
  assert.equal(await M.clearOwnedScreenCaptureLedger("user-a"), true);
  assert.deepEqual(native.calls, ["clearScreenCaptureLedger"]);
});

test("gap 1: a signed-out viewer is offered nothing", async () => {
  native.recovered = FRAMES;
  native.owner = "user-a";
  install();
  assert.deepEqual(await M.ownedRecoveredScreenCapture(null), { kind: "none" });
});

test("an earlier build's frames (no native owner): sign-out claims them, so the next account is refused and the owner is offered them again", async () => {
  native.recovered = FRAMES; // no getRecoveredScreenCaptureOwner on this native build
  install();
  M.setCaptureSessionOwner("user-a");
  await M.teardownCaptureOnSignOut();

  assert.deepEqual(await M.ownedRecoveredScreenCapture("user-b"), { kind: "foreign" });
  assert.equal(await M.clearOwnedScreenCaptureLedger("user-b"), false);
  // user-b signing out later cannot take the claim over.
  M.setCaptureSessionOwner("user-b");
  await M.teardownCaptureOnSignOut();
  assert.equal((await M.ownedRecoveredScreenCapture("user-a")).kind, "own");
});

test("unclaimed frames belong to the account that never signed out, and are claimed for it on sight", async () => {
  native.recovered = FRAMES;
  install();
  assert.equal((await M.ownedRecoveredScreenCapture("user-a")).kind, "own");
  assert.deepEqual(await M.ownedRecoveredScreenCapture("user-b"), { kind: "foreign" }, "the first account's claim stands");
});

test("gap 2 (Android): another account's continuous recording is foreign and may never be discarded from here", async () => {
  native.ledger = { ...LEDGER, captureSessionId: "cs-a", evidenceId: "ev-a", ownerUserId: "user-a" };
  install();
  assert.deepEqual(await M.foreignContinuousResidue("user-b", { adopt: true }), { ledger: true, recordingIds: [] });
  assert.equal(await M.mayDiscardContinuousResidue("user-b", null), false);
  assert.deepEqual(await M.foreignContinuousResidue("user-a", { adopt: true }), { ledger: false, recordingIds: [] });
  assert.equal(await M.mayDiscardContinuousResidue("user-a", null), true);
});

test("gap 2 (Android): a recording that never reached its session is claimed at sign-out; the next account cannot discard it", async () => {
  native.ledger = { ...LEDGER };
  install();
  M.setCaptureSessionOwner("user-a");
  await M.teardownCaptureOnSignOut();
  assert.equal((await M.foreignContinuousResidue("user-b", { adopt: true })).ledger, true);
  assert.equal(await M.mayDiscardContinuousResidue("user-b", null), false);
  assert.equal(await M.mayDiscardContinuousResidue("user-a", null), true);
});

test("gap 2 (iOS): each broadcast recording has its own owner; only the other account's are refused", async () => {
  native.recordings = [
    { recordingId: "rec-a", active: false, segmentCount: 2 },
    { recordingId: "rec-b", active: false, segmentCount: 1 },
  ];
  install("ios");
  await M.claimResidue(M.continuousResidueId("rec-a"), "user-a");
  await M.claimResidue(M.continuousResidueId("rec-b"), "user-b");
  assert.deepEqual(await M.foreignContinuousResidue("user-b"), { ledger: false, recordingIds: ["rec-a"] });
  assert.equal(await M.mayDiscardContinuousResidue("user-b", "rec-a"), false);
  assert.equal(await M.mayDiscardContinuousResidue("user-b", "rec-b"), true);
  assert.equal(await M.mayDiscardContinuousResidue("user-b", null), false, "a discard of every recording never includes another account's");
});

test("a claim is forgotten with its residue, and the claim record stays bounded", async () => {
  await M.claimResidue("frame:x", "user-a");
  assert.equal(await M.claimedResidueOwner("frame:x"), "user-a");
  await M.forgetResidueClaim("frame:x");
  assert.equal(await M.claimedResidueOwner("frame:x"), null);
  for (let i = 0; i < 80; i += 1) await M.claimResidue(`continuous:${i}`, "user-a");
  assert.equal(await M.claimedResidueOwner("continuous:79"), "user-a");
  assert.equal(await M.claimedResidueOwner("continuous:0"), null, "the oldest claims are dropped first");
});

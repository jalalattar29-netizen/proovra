/**
 * B4-F-101 (Free-user audit 0ea0, native half) — a stale persisted capture is
 * released on the server (the existing discard route) before the device
 * clears it, so its reserved record does not hold a Free slot for 24 h.
 *
 * Runs the real helper and the real /capture source wiring.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule } from "./support/render.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let M;

before(async () => {
  M = await loadModule("src/capture/stale-capture-release.ts", ["test/support/expo-stub.mjs"]);
});

const STALE = {
  captureSessionId: "cs-1",
  expiresAtUtc: "2026-11-01T00:00:00.000Z",
  evidenceId: "ev-1",
  draftId: null,
  type: "PHOTO",
  items: [{ id: "i1", uri: "file:///x.jpg", mimeType: "image/jpeg", partIndex: 0, source: "CAMERA", uploaded: false }],
  updatedAtIso: "2026-11-01T00:00:00.000Z",
};

function deps({ fail } = {}) {
  const calls = { discard: [], clear: [] };
  return {
    calls,
    discard: async (s) => {
      calls.discard.push(s.captureSessionId);
      if (fail) throw fail;
      return { discarded: true };
    },
    clear: async (k) => {
      calls.clear.push(k.captureSessionId);
    },
  };
}

test("B4-F-101: a stale record with a direct session is discarded on the server, then cleared", async () => {
  const d = deps();
  assert.equal(await M.releaseStaleCaptureRecord(STALE, d), "released");
  assert.deepEqual(d.calls.discard, ["cs-1"], "the existing discard route releases the reservation");
  assert.deepEqual(d.calls.clear, ["cs-1"]);
});

test("B4-F-101: a release that could not be answered keeps the record for the next visit", async () => {
  for (const fail of [new TypeError("Network request failed"), { code: "TIMEOUT" }, { statusCode: 503 }, { statusCode: 401, code: "TOKEN_EXPIRED", sessionEnded: "expired" }]) {
    const d = deps({ fail });
    assert.equal(await M.releaseStaleCaptureRecord(STALE, d), "kept", JSON.stringify(fail));
    assert.deepEqual(d.calls.clear, [], "not forgotten while the reservation may still be open");
  }
});

test("B4-F-101: a session the server already ended (or a final refusal) is cleared", async () => {
  for (const fail of [{ statusCode: 409, code: "SESSION_NOT_ACTIVE" }, { statusCode: 404, code: "SESSION_NOT_FOUND" }]) {
    const d = deps({ fail });
    assert.equal(await M.releaseStaleCaptureRecord(STALE, d), "cleared");
    assert.deepEqual(d.calls.clear, ["cs-1"]);
  }
});

test("B4-F-101: a draft-only record has no session to release", async () => {
  const d = deps();
  const draftOnly = { ...STALE, captureSessionId: "dr-1", evidenceId: "dr-1", draftId: "dr-1" };
  assert.equal(await M.releaseStaleCaptureRecord(draftOnly, d), "cleared");
  assert.deepEqual(d.calls.discard, []);
  assert.equal(M.holdsDirectSession(draftOnly), false);
  assert.equal(M.holdsDirectSession({ ...STALE, draftId: "dr-1" }), true, "a draft-bound record with its own session still releases it");
});

test("B4-F-101: /capture releases stale records through the helper instead of clearing them locally only", () => {
  const src = readFileSync(resolve(ROOT, "app/(stack)/capture.tsx"), "utf8");
  const start = src.indexOf("const refreshPendingRecords = useCallback(");
  const body = src.slice(start, src.indexOf("}, [captureOwnerId, isLiveRecord]);", start));
  assert.ok(start > 0 && body.length > 0);
  assert.match(body, /releaseStaleCaptureRecord\(r,\s*\{\s*discard: discardDirectCaptureSession,/);
  assert.doesNotMatch(body, /else \{\s*stale \+= 1;\s*await clearCaptureSession/);
});

// PRO-NB-03 — an abandoned reservation whose release got no answer is KEPT as a
// record the next Capture visit releases; an answered release keeps nothing.
test("PRO-NB-03: an unanswered release keeps a releasable record; an answered one keeps nothing", async () => {
  const kept = [];
  const session = { captureSessionId: "cs-9", expiresAtUtc: "" };
  const offline = await M.releaseDirectSessionOrKeep(session, "ev-9", {
    discard: async () => {
      throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
    },
    keep: async (r) => kept.push(r),
  });
  assert.equal(offline, "kept");
  assert.deepEqual(kept, [{ captureSessionId: "cs-9", expiresAtUtc: "", evidenceId: "ev-9" }]);
  // The kept record is one the stale release recognises as holding a session.
  assert.equal(M.holdsDirectSession({ ...kept[0], draftId: null }), true);

  kept.length = 0;
  const online = await M.releaseDirectSessionOrKeep(session, null, {
    discard: async () => ({ discarded: true }),
    keep: async (r) => kept.push(r),
  });
  assert.equal(online, "released");
  assert.deepEqual(kept, []);
});

test("PRO-NB-01: a discard the server answered with keptStagedContent keeps the device record (never forgotten)", async () => {
  const calls = { discard: [], clear: [], keep: [] };
  const d = {
    discard: async (s) => {
      calls.discard.push(s.captureSessionId);
      return { discarded: false, releasedEvidenceId: null, keptStagedContent: true, keptUntilUtc: "2026-11-02T00:00:00.000Z" };
    },
    clear: async (k) => {
      calls.clear.push(k.captureSessionId);
    },
    keep: async (r) => {
      calls.keep.push(r);
    },
  };
  assert.equal(await M.releaseStaleCaptureRecord(STALE, d), "kept");
  assert.deepEqual(calls.clear, [], "the device does not forget a session the server still holds");

  assert.equal(await M.releaseDirectSessionOrKeep({ captureSessionId: "cs-2", expiresAtUtc: "" }, "ev-2", d), "kept");
  assert.deepEqual(calls.keep.map((r) => [r.captureSessionId, r.evidenceId]), [["cs-2", "ev-2"]]);

  // An older API never answers the field: behaviour unchanged.
  assert.equal(M.serverKeptStagedContent({ discarded: true }), false);
  assert.equal(M.serverKeptStagedContent(undefined), false);
});

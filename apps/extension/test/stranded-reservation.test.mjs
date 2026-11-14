/**
 * Free audit F-12 — a 401 after the session opened left the reserved record
 * holding one of the account's slots until the server sweep (up to 24 h):
 * the discard needs a token and was skipped. The session is now remembered and
 * the SAME discard runs once the user has signed in again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, NetworkError } from "./dist/api-client.js";
import { runPreserveFlow } from "./dist/preserve-flow.js";
import { PENDING_RELEASE_MAX_AGE_MS, rememberUnreleased, releasePending } from "./dist/pending-release.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const REQ = { mode: "VIEWPORT", teamId: "team-1", caseId: null, tabId: 7, windowId: 1, evidenceType: "PHOTO" };
const HEX = "a".repeat(64);

function memoryStore(initial = []) {
  let entries = initial;
  return {
    read: async () => entries,
    write: async (e) => {
      entries = e;
    },
    get entries() {
      return entries;
    },
  };
}

function deps(api, remembered) {
  return {
    api: {
      openWebSession: async () => ({ session: { captureSessionId: SESSION, expiresAtUtc: "" } }),
      reserveEvidence: async () => ({ evidence: { evidenceId: "ev-1" } }),
      createPart: async () => ({ upload: { putUrl: "http://s3.local/put" } }),
      putBytes: async () => undefined,
      declarePart: async () => undefined,
      webComplete: async () => ({ result: { evidenceId: "ev-1" } }),
      discardSession: async () => {
        throw new Error("discard must not run with a refused token");
      },
      ...api,
    },
    getToken: async () => "tok",
    clearToken: async () => undefined,
    prepare: async () => undefined,
    capture: async () => ({
      artifacts: [{ role: "viewport_screenshot", mediaType: "image/png", blob: new Blob(["png"]), sha256: HEX }],
      pageInfo: { url: "https://example.com/", title: "t", viewportW: 1, viewportH: 1, devicePixelRatio: 1 },
      pageMutatedDuringCapture: false,
      limitations: [],
      domSnapshotMissing: true,
      notes: [],
    }),
    sha256Hex: async () => HEX,
    progress: () => undefined,
    browser: { name: "Chrome", versionBucket: "153", os: "Windows" },
    extensionVersion: "test",
    attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tabUrl: "https://example.com/",
    sleep: async () => undefined,
    rememberUnreleased: async (id) => void remembered.push(id),
  };
}

test("F-12: a 401 after the record was reserved remembers the session for release", async () => {
  const remembered = [];
  const r = await runPreserveFlow(
    deps(
      {
        createPart: async () => {
          throw new ApiError(401, null, "POST parts -> 401");
        },
      },
      remembered,
    ),
    REQ,
    new AbortController().signal,
  );
  assert.equal(r.reason, "SIGNED_OUT");
  assert.deepEqual(remembered, [SESSION]);
});

test("F-12: a 401 before any session opened remembers nothing", async () => {
  const remembered = [];
  const r = await runPreserveFlow(
    deps(
      {
        openWebSession: async () => {
          throw new ApiError(401, null, "open -> 401");
        },
      },
      remembered,
    ),
    REQ,
    new AbortController().signal,
  );
  assert.equal(r.reason, "SIGNED_OUT");
  assert.deepEqual(remembered, []);
});

test("F-12: after sign-in the existing discard releases it once; a definite answer forgets it", async () => {
  const store = memoryStore();
  await rememberUnreleased(store, SESSION, 1_000);
  await rememberUnreleased(store, SESSION, 2_000);
  assert.equal(store.entries.length, 1, "one entry per session");
  const sent = [];
  const settled = await releasePending(store, "new-token", async (t, id) => void sent.push([t, id]), 3_000);
  assert.equal(settled, 1);
  assert.deepEqual(sent, [["new-token", SESSION]]);
  assert.deepEqual(store.entries, []);
  // Idempotent: nothing left to send.
  await releasePending(store, "new-token", async () => assert.fail("sent twice"), 4_000);
});

test("F-12: a session of another account (403/404) or a sealed one (409) is forgotten; no answer or 401 keeps it", async () => {
  for (const status of [403, 404, 409]) {
    const store = memoryStore([{ captureSessionId: SESSION, atMs: 0 }]);
    await releasePending(
      store,
      "t",
      async () => {
        throw new ApiError(status, "SESSION_NOT_ACTIVE", "x");
      },
      1,
    );
    assert.deepEqual(store.entries, [], `status ${status} settles it`);
  }
  for (const err of [
    new NetworkError("offline"),
    new ApiError(401, null, "x"),
    new ApiError(503, null, "x"),
    new ApiError(409, "SESSION_BUSY", "x"),
  ]) {
    const store = memoryStore([{ captureSessionId: SESSION, atMs: 0 }]);
    await releasePending(
      store,
      "t",
      async () => {
        throw err;
      },
      1,
    );
    assert.equal(store.entries.length, 1, `${err.name} ${err.status ?? ""} keeps it`);
  }
});

test("F-12: entries older than the server sweep window, or malformed, are dropped", async () => {
  const store = memoryStore([
    { captureSessionId: SESSION, atMs: 0 },
    { captureSessionId: "../../evil", atMs: PENDING_RELEASE_MAX_AGE_MS },
  ]);
  const sent = [];
  await releasePending(store, "t", async (_t, id) => void sent.push(id), PENDING_RELEASE_MAX_AGE_MS + 1);
  assert.deepEqual(sent, []);
});

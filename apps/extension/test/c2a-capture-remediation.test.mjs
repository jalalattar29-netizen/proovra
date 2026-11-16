/**
 * Free-user audit 0ea0 — WEB-C2A-CAPTURE, extension rows.
 *
 *   B4-F-100  a commercial refusal (lapsed plan, credits, a flat storage
 *             refusal from the part presign, the personal-space refusal) shows
 *             its own sentence and remedy — never "Nothing was saved. Please
 *             try again" with Retry;
 *   B4-F-101  a reservation the flow abandons is remembered and released
 *             (discard without an answer, a stopped service worker);
 *   B4-F-102  the recorded page URL loses its fragment and its credential
 *             parameters;
 *   B4-F-103  the capture window is stated on the server's clock;
 *   B4-F-104  the case selector reads every page of GET /v1/cases;
 *   B4-F-105  release refuses non-https / off-origin OAuth endpoints;
 *   B4-F-106  the terms refusal links to PROOVRA and hides Retry;
 *   B4-F-107  an UNKNOWN outcome hides Retry and links to the record.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError, NetworkError, apiClient, denialOf, serverDateMsOf } from "./dist/api-client.js";
import { runPreserveFlow, clockCorrectionNote } from "./dist/preserve-flow.js";
import { statusLine, CAPTURE_FAILED } from "./dist/status-copy.js";
import { denialToMessage } from "./dist/denial-copy.js";
import {
  ACCEPT_TERMS_LABEL,
  CHECK_LIBRARY_LABEL,
  VIEW_PLANS_LABEL,
  followUpLink,
  retryOffered,
} from "./dist/popup-links.js";
import { buildWebCaptureManifest, recordedPageUrl } from "./dist/manifest-builder.js";
import { loadAllEligibleCases } from "./dist/popup-context.js";
import { createCaptureRegistry } from "./dist/capture-registry.js";
import { releaseAuthUrlProblems } from "../scripts/manifest-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = "11111111-1111-4111-8111-111111111111";
const HEX = "a".repeat(64);
const REQ = { mode: "VIEWPORT", teamId: "t1", caseId: null, tabId: 3, windowId: 1, evidenceType: "PHOTO" };
const WEB = "https://www.proovra.test";

const base = {
  attemptId: "a",
  tabId: 1,
  mode: "VIEWPORT",
  teamId: "t",
  caseId: null,
  step: null,
  detail: null,
  outcome: null,
  reason: null,
  denial: null,
  evidenceId: null,
  cancelRequested: false,
  startedAtMs: 0,
  updatedAtMs: 0,
};
const failed = (over) => ({ ...base, state: "FAILED", outcome: "NOTHING_SAVED", ...over });

function deps(api = {}, extra = {}) {
  return {
    api: {
      openWebSession: async () => ({ session: { captureSessionId: SESSION, expiresAtUtc: "" } }),
      reserveEvidence: async () => ({ evidence: { evidenceId: "ev-1" } }),
      createPart: async () => ({ upload: { putUrl: "http://s3.local/put" } }),
      putBytes: async () => undefined,
      declarePart: async () => undefined,
      webComplete: async () => ({ result: { evidenceId: "ev-1" } }),
      discardSession: async () => ({ result: { discarded: true } }),
      ...api,
    },
    getToken: async () => "tok",
    clearToken: async () => undefined,
    prepare: async () => undefined,
    capture: async () => ({
      artifacts: [{ role: "viewport_screenshot", mediaType: "image/png", blob: new Blob(["png"]), sha256: HEX }],
      pageInfo: { url: "https://example.com/a?token=abc&q=1#access_token=z", title: "t", viewportW: 1, viewportH: 1, devicePixelRatio: 1 },
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
    ...extra,
  };
}

/* ------------------------------------------------------------- B4-F-100 -- */

test("B4-F-100: a flat {code} refusal (part presign 409 STORAGE_LIMIT_REACHED) is carried as the denial", async () => {
  assert.equal(denialOf({ code: "STORAGE_LIMIT_REACHED", message: "Storage limit reached" }), "STORAGE_LIMIT_REACHED");
  assert.equal(denialOf({ denial: "FREE_LIMIT_REACHED", code: "X" }), "FREE_LIMIT_REACHED");
  assert.equal(denialOf({ error: { code: "LEGAL_REACCEPT_REQUIRED" } }), "LEGAL_REACCEPT_REQUIRED");
  assert.equal(denialOf({ message: "no code" }), null);

  // The real createPart over a mocked fetch answering the canonical presign refusal.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: "STORAGE_LIMIT_REACHED", message: "Storage limit reached", billingWall: {} }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  try {
    const r = await runPreserveFlow(deps({ createPart: (...a) => apiClient.createPart(...a) }), REQ, new AbortController().signal);
    assert.equal(r.status, "FAILED");
    assert.equal(r.reason, "DENIED");
    assert.equal(r.denial, "STORAGE_LIMIT_REACHED");
    const s = failed({ reason: r.reason, denial: r.denial });
    assert.notEqual(statusLine(s).text, CAPTURE_FAILED, "not the generic 'Nothing was saved. Please try again'");
    assert.match(statusLine(s).text, /storage/i);
    assert.equal(retryOffered(s, true), false, "no Retry for a storage refusal");
    assert.deepEqual(followUpLink(s, WEB), { label: VIEW_PLANS_LABEL, url: `${WEB}/billing` });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("B4-F-100: lapsed-plan and no-allowance credit refusals say what they are, link to plans, offer no Retry", () => {
  for (const denial of ["PLAN_LAPSED_ALLOWANCE_EXHAUSTED", "CREDIT_REQUIRED_NONE_AVAILABLE"]) {
    const s = failed({ reason: "DENIED", denial });
    const line = statusLine(s).text;
    assert.notEqual(line, CAPTURE_FAILED, denial);
    assert.doesNotMatch(line, /Please try again/, denial);
    assert.equal(retryOffered(s, true), false, denial);
    assert.equal(followUpLink(s, WEB)?.label, VIEW_PLANS_LABEL, denial);
  }
  assert.match(denialToMessage("PLAN_LAPSED_ALLOWANCE_EXHAUSTED"), /lapsed/i);
  assert.match(denialToMessage("CREDIT_REQUIRED_NONE_AVAILABLE"), /credits/i);
});

test("B4-F-100: the personal-space refusal names the remedy and offers no Retry", () => {
  const s = failed({ reason: "DENIED", denial: "MANAGED_IDENTITY_NO_PERSONAL_SPACE" });
  assert.match(statusLine(s).text, /organization's workspaces/);
  assert.equal(retryOffered(s, true), false);
  assert.equal(followUpLink(s, WEB), null, "not a plans refusal");
});

/* ------------------------------------------------------------- B4-F-106 -- */

test("B4-F-106: the terms refusal links to PROOVRA to accept, and hides Retry", () => {
  const s = failed({ reason: "DENIED", denial: "LEGAL_REACCEPT_REQUIRED" });
  assert.equal(retryOffered(s, true), false);
  assert.deepEqual(followUpLink(s, WEB), { label: ACCEPT_TERMS_LABEL, url: `${WEB}/home` });
});

/* ------------------------------------------------------------- B4-F-107 -- */

test("B4-F-107: an UNKNOWN outcome offers no Retry and links to the reserved record (or the library)", () => {
  const known = failed({ outcome: "UNKNOWN", reason: "ERROR", evidenceId: "ev 9" });
  assert.equal(retryOffered(known, true), false);
  assert.deepEqual(followUpLink(known, WEB), { label: CHECK_LIBRARY_LABEL, url: `${WEB}/evidence/ev%209` });
  const interrupted = failed({ outcome: "UNKNOWN", reason: "INTERRUPTED" });
  assert.equal(retryOffered(interrupted, true), false);
  assert.deepEqual(followUpLink(interrupted, WEB), { label: CHECK_LIBRARY_LABEL, url: `${WEB}/evidence` });
  // A definite failure keeps Retry.
  assert.equal(retryOffered(failed({ reason: "ERROR" }), true), true);
});

/* ------------------------------------------------------------- B4-F-101 -- */

test("B4-F-101: a discard without an answer remembers the session for release; the open is noted at once", async () => {
  const remembered = [];
  const noted = [];
  const r = await runPreserveFlow(
    deps(
      {
        createPart: async () => {
          throw new ApiError(422, "PART_REFUSED", "refused");
        },
        discardSession: async () => {
          throw new NetworkError("offline");
        },
      },
      {
        rememberUnreleased: async (id) => void remembered.push(id),
        noteSession: async (id) => void noted.push(id),
      },
    ),
    REQ,
    new AbortController().signal,
  );
  assert.equal(r.status, "FAILED");
  assert.deepEqual(noted, [SESSION], "the session id is persisted as soon as the open answers");
  assert.deepEqual(remembered, [SESSION], "the unreleased reservation is remembered");
});

test("B4-F-101: a discard that does not settle the session is remembered too; a settled one is not", async () => {
  for (const [discard, expected] of [
    [async () => ({ result: { discarded: false, status: "ACTIVE" } }), [SESSION]],
    [async () => ({ result: { discarded: true } }), []],
  ]) {
    const remembered = [];
    await runPreserveFlow(
      deps(
        {
          createPart: async () => {
            throw new ApiError(422, "PART_REFUSED", "refused");
          },
          discardSession: discard,
        },
        { rememberUnreleased: async (id) => void remembered.push(id) },
      ),
      REQ,
      new AbortController().signal,
    );
    assert.deepEqual(remembered, expected);
  }
});

test("B4-F-101: the registry persists the session id and hands an INTERRUPTED attempt's session to the release", async () => {
  let data = {};
  const store = { read: async () => data, write: async (all) => void (data = all) };
  const interrupted = [];
  let release;
  const reg = createCaptureRegistry({
    store,
    newId: () => "att-1",
    run: () => new Promise((r) => (release = r)),
    onInterrupted: (s) => interrupted.push(s.captureSessionId),
  });
  const started = await reg.start(REQ);
  await reg.noteSession(REQ.tabId, started.attemptId, SESSION);
  assert.equal(data[String(REQ.tabId)].captureSessionId, SESSION);

  // A NEW worker (the old one stopped): same storage, no live attempt.
  const reg2 = createCaptureRegistry({ store, newId: () => "att-2", run: async () => ({}), onInterrupted: (s) => interrupted.push(s.captureSessionId) });
  const found = await reg2.reconcileInterrupted();
  assert.equal(found.length, 1);
  assert.equal(found[0].reason, "INTERRUPTED");
  assert.equal(found[0].outcome, "UNKNOWN");
  assert.deepEqual(interrupted, [SESSION]);
  release({ status: "FAILED", outcome: "NOTHING_SAVED", reason: "ERROR", denial: null, evidenceId: null, detail: "" });
});

test("B4-F-101: the worker releases remembered reservations at start and when the popup opens", () => {
  const src = readFileSync(resolve(HERE, "../src/background.ts"), "utf8");
  assert.match(src, /void registry\s*\.reconcileInterrupted\(\)\s*\.catch\(\(\) => \[\]\)\s*\.then\(\(\) => releaseStranded\(\)\);/);
  const status = src.slice(src.indexOf('if (message.kind === "GET_CAPTURE_STATUS")'), src.indexOf('if (message.kind === "CANCEL_CAPTURE")'));
  assert.match(status, /void releaseStranded\(\);/);
  assert.match(src, /noteSession: \(captureSessionId\) => registry\.noteSession\(req\.tabId, attemptId, captureSessionId\)/);
  assert.match(src, /onInterrupted: \(status\) => \{[\s\S]*?rememberStranded\(status\.captureSessionId\)/);
});

/* ------------------------------------------------------------- B4-F-102 -- */

test("B4-F-102: the recorded page URL has no fragment and its credential parameters are REDACTED", () => {
  assert.equal(recordedPageUrl("https://x.test/y?token=abc#access_token=z"), "https://x.test/y?token=REDACTED");
  assert.equal(recordedPageUrl("https://x.test/y?q=hello#section"), "https://x.test/y?q=hello");
  const { manifest } = buildWebCaptureManifest({
    captureMode: "VIEWPORT",
    captureSessionId: SESSION,
    captureStartedAtUtc: "2026-11-15T09:00:00.000Z",
    captureEndedAtUtc: "2026-11-15T09:00:01.000Z",
    sourceUrl: "https://x.test/y?token=abc&X-Amz-Signature=s#access_token=z",
    title: null,
    browser: { name: "Chrome", versionBucket: "153", os: "Windows", viewportW: 1, viewportH: 1, devicePixelRatio: 1 },
    extensionVersion: "test",
    artifacts: [{ role: "viewport_screenshot", partIndex: 0, expectedSha256: HEX, sizeBytes: 3, mediaType: "image/png", completeness: "CAPTURED" }],
    pageMutatedDuringCapture: false,
    limitations: [],
    domSnapshotMissing: true,
    notes: [],
  });
  assert.equal(manifest.page.sourceUrlPrivate, "https://x.test/y?token=REDACTED&X-Amz-Signature=REDACTED");
  assert.doesNotMatch(manifest.page.sourceUrlPrivate, /#|abc|access_token/);
  assert.equal(manifest.page.domain, "x.test");
});

/* ------------------------------------------------------------- B4-F-103 -- */

test("B4-F-103: the open's Date header is read, and a fast computer clock is corrected in the manifest", async () => {
  assert.equal(serverDateMsOf(new Headers({ date: "Sun, 15 Nov 2026 09:00:00 GMT" })), Date.parse("2026-11-15T09:00:00Z"));
  assert.equal(serverDateMsOf(new Headers()), null);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ session: { captureSessionId: SESSION, expiresAtUtc: "" } }), {
      status: 200,
      headers: { "content-type": "application/json", date: "Sun, 15 Nov 2026 09:00:00 GMT" },
    });
  let opened;
  try {
    opened = await apiClient.openWebSession("tok", "t1", null, "att");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(opened.serverDateMs, Date.parse("2026-11-15T09:00:00Z"));

  // The computer is 10 minutes FAST: the server would refuse the end time.
  const local = Date.parse("2026-11-15T09:10:00Z");
  let manifestJson = null;
  const r = await runPreserveFlow(
    deps({
      openWebSession: async () => ({ session: { captureSessionId: SESSION, expiresAtUtc: "" }, serverDateMs: Date.parse("2026-11-15T09:00:00Z") }),
      webComplete: async (_t, _s, json) => {
        manifestJson = json;
        return { result: { evidenceId: "ev-1" } };
      },
    }, { now: () => new Date(local) }),
    REQ,
    new AbortController().signal,
  );
  assert.equal(r.status, "SUCCEEDED");
  const m = JSON.parse(manifestJson);
  assert.equal(m.captureStartedAtUtc, "2026-11-15T09:00:00.000Z");
  assert.equal(m.captureEndedAtUtc, "2026-11-15T09:00:00.000Z");
  assert.ok(m.notes.includes(clockCorrectionNote(-600_000)), "the correction is disclosed");
  assert.match(clockCorrectionNote(-600_000), /600 s fast/);
});

test("B4-F-103: a refused capture window names the clock, not a generic retry sentence", () => {
  const s = failed({ reason: "DENIED", denial: "WEB_MANIFEST_INVALID" });
  assert.notEqual(statusLine(s).text, CAPTURE_FAILED);
  assert.match(statusLine(s).text, /clock|date, time/i);
});

/* ------------------------------------------------------------- B4-F-104 -- */

test("B4-F-104: the case selector pages through GET /v1/cases; the oldest case of the chosen workspace appears", async () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, name: `Case ${i}`, teamId: i % 2 ? "t1" : "t2", status: "OPEN" }));
  const pages = [];
  const fetchPage = async (cursor) => {
    pages.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + 200);
    const next = start + 200 < all.length ? String(start + 200) : null;
    return { status: 200, body: { items, nextCursor: next, hasMore: next !== null } };
  };
  const r = await loadAllEligibleCases(fetchPage, "t1");
  assert.equal(r.kind, "ok");
  assert.deepEqual(pages, [null, "200"]);
  assert.equal(r.cases.length, 125);
  assert.ok(r.cases.some((c) => c.id === "c249"), "a case beyond the first page is offered");
  assert.deepEqual(await loadAllEligibleCases(async () => ({ status: 401, body: null }), "t1"), { kind: "signed_out" });
});

/* ------------------------------------------------------------- B4-F-105 -- */

test("B4-F-105: release refuses non-https or off-origin OAuth endpoint overrides", () => {
  const apiOrigin = "https://api.proovra.com";
  assert.deepEqual(releaseAuthUrlProblems({ apiOrigin }), []);
  assert.deepEqual(
    releaseAuthUrlProblems({ apiOrigin, authorizeUrl: `${apiOrigin}/v1/oauth/extension/authorize`, tokenUrl: `${apiOrigin}/v1/oauth/extension/token` }),
    [],
  );
  assert.ok(releaseAuthUrlProblems({ apiOrigin, tokenUrl: "http://example.test/token" }).length >= 1);
  assert.ok(releaseAuthUrlProblems({ apiOrigin, authorizeUrl: "https://evil.test/authorize" }).some((p) => /API origin/.test(p)));
  assert.ok(releaseAuthUrlProblems({ apiOrigin, tokenUrl: "https://localhost/token" }).some((p) => /local/.test(p)));
  const release = readFileSync(resolve(HERE, "../release.mjs"), "utf8");
  assert.match(release, /releaseAuthUrlProblems\(\{\s*apiOrigin,\s*authorizeUrl: env\.PROOVRA_AUTH_AUTHORIZE_URL,\s*tokenUrl: env\.PROOVRA_AUTH_TOKEN_URL,/);
});

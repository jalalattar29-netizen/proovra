/**
 * THE CUSTODY GUARD FOR DIRECT CAPTURE.
 *
 * Sealing a direct-capture session reserves an Evidence record BEFORE the
 * first part is uploaded and completes it LAST. A failure anywhere between the
 * two leaves a reserved, custody-logged record with nothing in it —
 * `discardDirectCaptureSession`'s own docstring calls it "a custody-logged,
 * empty record in the owner's library".
 *
 * `/capture` has always released it on failure (capture.tsx:697, :744). The
 * two screen-capture surfaces did not, so every failed screen capture left one
 * and nothing in the product ever removed it. That is the F-08 defect with
 * teeth: not a second domain model — `openDirectCaptureSession` writes to the
 * same CaptureSession table and the status enum spans both flows
 * (schema.prisma:3583) — but one lifecycle that two surfaces only half
 * implemented.
 *
 * These tests drive the real `sealDirectCapture` against a stubbed transport,
 * and assert on the REQUESTS. A seal that fails must release; a seal that
 * succeeds must not.
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

/** Requests the real module made through apiFetch, in order. */
let requests = [];
/** Path fragments that should answer with a failure. */
let failing = new Set();

const compile = (file) =>
  ts.transpileModule(readFileSync(resolve(HERE, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/*
 * `./api` is replaced by a RECORDING apiFetch rather than the whole HTTP
 * stack. What is under test is which request the rule makes and whether the
 * original error survives — not how a response is parsed, which api.ts has its
 * own tests for. The path itself is still built by the real
 * `discardDirectCaptureSession`.
 */
globalThis.__record = (path, init) => {
  requests.push({ path, method: init?.method ?? "GET" });
  if ([...failing].some((f) => path.includes(f))) throw new Error("transport refused");
  return { result: { discarded: true, releasedEvidenceId: "ev-1" } };
};

const API_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "export const apiFetch = async (path, init) => globalThis.__record(path, init);",
  );

// `./upload-utils` drives expo-file-system and cannot load under node; nothing
// in this file reaches it, so it is stubbed rather than compiled.
const UPLOAD_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "export const computeFileIntegrityBase64 = async () => ({});\nexport const uploadWithPut = async () => {};",
  );

const ACQUISITION_URL =
  "data:text/javascript," + encodeURIComponent(compile("../src/capture/screen-acquisition.ts"));

const src = compile("../src/direct-capture.ts")
  .replace('from "./capture/screen-acquisition"', `from "${ACQUISITION_URL}"`)
  .replace(/from ["']\.\/api["']/g, `from "${API_STUB}"`)
  .replace(/from ["']\.\/upload-utils["']/g, `from "${UPLOAD_STUB}"`);
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const SESSION = { captureSessionId: "cs-1", nonce: "n", expiresAtUtc: null, deviceBound: false };

beforeEach(() => {
  requests = [];
  failing = new Set();
});

const discards = () =>
  requests.filter(
    (r) => r.method === "POST" && r.path === "/v1/capture/direct-sessions/cs-1/discard",
  );

test("a seal that succeeds releases nothing", () => {
  return mod.sealDirectCapture(SESSION, async () => "sealed").then((out) => {
    assert.equal(out, "sealed");
    assert.deepEqual(discards(), [], "a successful seal must not discard its own session");
  });
});

test("a seal that FAILS releases the reservation", async () => {
  // THE REGRESSION. Without this the failure leaves a reserved, custody-logged
  // Evidence record that nothing in the product ever removes.
  await assert.rejects(
    () =>
      mod.sealDirectCapture(SESSION, async () => {
        throw new Error("upload failed");
      }),
    /upload failed/,
  );
  assert.equal(discards().length, 1, "a failed seal must release its reservation");
});

test("the original error survives — the caller is told the capture failed", async () => {
  // Not that the cleanup failed. A caller that learned only about the discard
  // would report the wrong thing to the person who was standing there.
  await assert.rejects(
    () =>
      mod.sealDirectCapture(SESSION, async () => {
        throw new Error("the distinctive original reason");
      }),
    /the distinctive original reason/,
  );
});

test("a release that itself fails does not mask the capture failure", async () => {
  failing.add("/discard");
  await assert.rejects(
    () =>
      mod.sealDirectCapture(SESSION, async () => {
        throw new Error("the distinctive original reason");
      }),
    /the distinctive original reason/,
  );
  assert.equal(discards().length, 1, "the release is still attempted");
});

test("the discard is addressed to the session's own route", async () => {
  await assert.rejects(
    () => mod.sealDirectCapture(SESSION, async () => { throw new Error("x"); }),
    /x/,
  );
  assert.equal(discards()[0].path, "/v1/capture/direct-sessions/cs-1/discard");
});

/* ------------------------------- every direct surface obeys the rule ----- */

test("every surface that seals a direct capture goes through the rule", () => {
  // A rule that works proves nothing if a surface does not use it. These are
  // the three places a direct-capture session is sealed; /capture has always
  // released on failure, and the other two are why this file exists.
  const read = (rel) => readFileSync(resolve(HERE, rel), "utf8");

  const sealers = [
    ["../src/screen-capture.ts", "UC-2 screen capture"],
    ["../app/(stack)/continuous-capture.tsx", "UC-3 continuous capture"],
  ];
  for (const [file, what] of sealers) {
    assert.match(
      read(file),
      /sealDirectCapture\(/,
      `${what} seals a direct session without going through sealDirectCapture`,
    );
  }

  // /capture releases through the primitive directly, in its own failure and
  // discard paths. Either route to the release is fine; having none is not.
  assert.match(read("../app/(stack)/capture.tsx"), /discardDirectCaptureSession\(/);
});

test("only the canonical surface finalizes — the screens stage", () => {
  /*
   * F-08. This used to assert that all three surfaces said "Finish & Sign",
   * which was the best available guard while all three FINISHED. The screens
   * no longer do: they acquire, upload and stage, and the one finalization is
   * Capture's.
   *
   * So the invariant is stronger now, and this asserts the stronger one —
   * a screen that called a completion route would be the second ending
   * growing back.
   */
  const read = (rel) => readFileSync(resolve(HERE, rel), "utf8");
  // Comments DISCUSS the completion routes — that is what they are for. The
  // question is whether the code calls one, so the prose is stripped first.
  const code = (rel) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  for (const file of [
    "../app/(stack)/screen-capture.tsx",
    "../app/(stack)/continuous-capture.tsx",
    "../src/screen-capture.ts",
    "../src/continuous-capture.ts",
  ]) {
    const src = code(file);
    assert.ok(
      !/screen-complete|continuous-complete|completeDirectCapture\s*\(/.test(src),
      `${file} completes a session itself — finalization belongs to Capture`,
    );
    assert.ok(!/Finalize Evidence/.test(src), `${file} still calls it "Finalize Evidence"`);
    assert.ok(!/"Evidence saved\./.test(src), `${file} still says "Evidence saved."`);
  }

  // The canonical surface is the only one that completes, and it does so
  // through the one function that picks the route by acquisition.
  const capture = read("../app/(stack)/capture.tsx");
  assert.match(capture, /completeAcquisition\(captureSession, acquisitionRef\.current\)/);

  // And the screens say what they actually did.
  for (const file of [
    "../app/(stack)/screen-capture.tsx",
    "../app/(stack)/continuous-capture.tsx",
  ]) {
    assert.match(read(file), /review and finish in Capture|Go to Capture/);
  }
});

/**
 * B7A-F-006 (free-audit 0ea0) — SIGNING-KEY COMPROMISE, NATIVE.
 *
 * When PROOVRA withdraws a signing key, the record's artifact status carries
 * `keyCompromise` (additive; null = nothing of this record was made by the
 * withdrawn material). The record screen states it with the SHARED sentences
 * (`describeRecordKeyCompromise`, the same the web renders) and offers the
 * linked replacement ONLY when the server says it is AVAILABLE to THIS caller.
 * The control posts the existing regenerate route with
 * `{ intent: "KEY_COMPROMISE_REPLACEMENT" }`; each bounded 409 refusal (a FLAT
 * `{ code, message }` body) reads as the shared dictionary's copy for that code.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { USER_FACING_ERRORS, describeRecordKeyCompromise } from "@proovra/shared";
import { loadModule } from "./support/render.mjs";

let R; // evidence-record (status projection)
let K; // key-compromise (request + refusal copy)

before(async () => {
  R = await loadModule("src/product/evidence-record.ts", []);
  K = await loadModule("src/product/key-compromise.ts", []);
});

const AVAILABLE = {
  outputs: { recordSignature: false, packageSeal: true, latestPackageSeal: true, custodyAttestations: false },
  replacement: "AVAILABLE",
  replacesReportVersion: 3,
  callerMayRequest: true,
};

test("the artifact status carries keyCompromise: null when absent or malformed, parsed when valid", () => {
  // An older API sends nothing; the field is null, never a guessed state.
  assert.equal(R.projectArtifactOutputs(null).keyCompromise, null);
  assert.equal(R.projectArtifactOutputs({ outputs: {} }).keyCompromise, null);
  assert.equal(R.projectArtifactOutputs({ keyCompromise: null }).keyCompromise, null);
  // Malformed: not an object, an unknown state, no state at all.
  assert.equal(R.projectArtifactOutputs({ keyCompromise: "AVAILABLE" }).keyCompromise, null);
  assert.equal(R.projectArtifactOutputs({ keyCompromise: { ...AVAILABLE, replacement: "MAYBE" } }).keyCompromise, null);
  assert.equal(R.projectArtifactOutputs({ keyCompromise: { outputs: AVAILABLE.outputs } }).keyCompromise, null);
  // Valid: read from the TOP LEVEL of the status, beside `outputs`.
  assert.deepEqual(R.projectArtifactOutputs({ outputs: {}, keyCompromise: AVAILABLE }).keyCompromise, AVAILABLE);
  // A non-boolean permission is not a permission.
  assert.equal(
    R.projectArtifactOutputs({ keyCompromise: { ...AVAILABLE, callerMayRequest: "yes" } }).keyCompromise.callerMayRequest,
    false,
  );
});

test("the replacement is offered only for AVAILABLE and callerMayRequest", () => {
  const view = (raw) => K.keyCompromiseNotice(R.projectArtifactOutputs({ keyCompromise: raw }).keyCompromise);
  assert.equal(view(null), null, "null field: no notice at all");
  const offered = view(AVAILABLE);
  assert.equal(offered.actionLabel, "Request replacement");
  assert.equal(offered.offered, true);
  // Same state, caller without the generate-outputs permission: stated, no control.
  const notPermitted = view({ ...AVAILABLE, callerMayRequest: false });
  assert.equal(notPermitted.offered, false);
  assert.equal(notPermitted.actionLabel, null);
  for (const state of ["IN_PROGRESS", "FAILED", "LATEST_UNAFFECTED", "RECORD_SIGNATURE_NOT_REPLACEABLE", "NO_TRUSTWORTHY_SIGNER", "NOT_OFFERED"]) {
    const v = view({ ...AVAILABLE, replacement: state });
    assert.equal(v.offered, false, state);
    assert.equal(v.actionLabel, null, state);
  }
  // The sentences are the SHARED ones, verbatim.
  const k = R.projectArtifactOutputs({ keyCompromise: AVAILABLE }).keyCompromise;
  const d = describeRecordKeyCompromise(k);
  assert.equal(offered.title, d.title);
  assert.equal(offered.message, d.message);
  assert.equal(offered.replacementLine, d.replacementLine);
  assert.deepEqual(offered.notReplaced, d.notReplaced);
});

test("a record whose own signature used the withdrawn key states both outputs no replacement restores, and offers nothing", () => {
  const k = R.projectArtifactOutputs({
    keyCompromise: {
      outputs: { recordSignature: true, packageSeal: true, latestPackageSeal: true, custodyAttestations: true },
      replacement: "RECORD_SIGNATURE_NOT_REPLACEABLE",
      replacesReportVersion: null,
      callerMayRequest: true,
    },
  }).keyCompromise;
  const v = K.keyCompromiseNotice(k);
  assert.equal(v.offered, false);
  assert.equal(v.actionLabel, null);
  assert.equal(v.notReplaced.length, 2);
  assert.match(v.notReplaced[0], /own signature was made with the withdrawn key/);
  assert.match(v.notReplaced[1], /Custody-event attestations made with the withdrawn key are not re-signed/);
  assert.equal(v.replacementLine, "No replacement can restore this record's signature.");
});

test("the request is POST /v1/evidence/<id>/reports/regenerate with exactly the intent", () => {
  const req = K.buildKeyCompromiseReplacementRequest("ev-1");
  assert.equal(req.path, "/v1/evidence/ev-1/reports/regenerate");
  assert.equal(req.init.method, "POST");
  // No reason and no idempotency key: the server mints its own.
  assert.deepEqual(JSON.parse(req.init.body), { intent: "KEY_COMPROMISE_REPLACEMENT" });
  // The id is a path segment, never a path.
  assert.equal(K.buildKeyCompromiseReplacementRequest("a/b").path, "/v1/evidence/a%2Fb/reports/regenerate");
});

/** What the native apiFetch throws for a FLAT `{ code, message }` 409. */
const flat409 = (code) =>
  Object.assign(new Error("raw server sentence that must not be shown (requestId: rq-1)"), {
    statusCode: 409,
    requestId: "rq-1",
    code,
    body: { code, message: "raw server sentence that must not be shown" },
  });

test("each 409 refusal reads as the SHARED copy for its code — not the raw message, not a generic 409 bucket", () => {
  const codes = [
    "KEY_COMPROMISE_REPLACEMENT_NOT_AFFECTED",
    "KEY_COMPROMISE_REPLACEMENT_RECORD_SIGNATURE_NOT_REPLACEABLE",
    "KEY_COMPROMISE_REPLACEMENT_NO_TRUSTWORTHY_SIGNER",
    "KEY_COMPROMISE_REPLACEMENT_NOT_REQUESTED",
  ];
  for (const code of codes) {
    const want = USER_FACING_ERRORS[code];
    assert.ok(want, `shared copy exists for ${code}`);
    const got = K.keyCompromiseReplacementError(flat409(code));
    assert.equal(got.title, want.title, code);
    assert.equal(got.message, want.message, code);
    assert.doesNotMatch(got.message, /raw server sentence/);
    assert.doesNotMatch(got.message, /review your input/i);
    // The same answer when only the flat BODY carries the code (the transport
    // placeholder in `code`): the flat `code` is what decides.
    const bodyOnly = Object.assign(new Error("HTTP 409: API error"), { statusCode: 409, code: "API_ERROR", body: { code, message: "x" } });
    assert.equal(K.keyCompromiseReplacementError(bodyOnly).message, want.message, `${code} (body only)`);
  }
});

test("success is the minimal acknowledgement; a repeat (REPLAYED) reads the same", () => {
  // ENQUEUED and REPLAYED (a repeat) are acknowledged identically: the body's
  // outcome is not re-worded on the device.
  assert.equal(
    K.keyCompromiseReplacementRequested(),
    "Replacement requested. It will appear in this record's versions when it is issued.",
  );
  assert.equal(K.KEY_COMPROMISE_REPLACEMENT_REQUESTED, K.keyCompromiseReplacementRequested());
});

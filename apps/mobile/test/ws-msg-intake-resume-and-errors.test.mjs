/**
 * PRO-NC-06 / PRO-NC-07 — native public intake.
 *   - a re-picked unfinished file reuses ITS declared part index (the server
 *     then returns the same part with a fresh upload URL), so the resumed
 *     submission can be completed;
 *   - an identity/consent error that is not a link-state answer keeps the
 *     contributor on the step with an inline message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/external-intake.ts"), "utf8").replace(/^import type .*$/m, "");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const I = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const held = (over) => ({
  uri: "", name: "photo.jpg", mimeType: "image/jpeg", size: 1000, sent: false,
  partId: "p-0", stepId: null, partIndex: 0, unfinished: true, ...over,
});

test("re-picking the unfinished file reuses its part index; another file gets the next index", () => {
  const out = I.mergePickedIntakeFiles(
    [held({}), held({ name: "done.pdf", partId: "p-1", partIndex: 1, sent: true, unfinished: false })],
    [
      { uri: "file:///photo.jpg", name: "photo.jpg", mimeType: "image/jpeg", size: 1000 },
      { uri: "file:///other.png", name: "other.png", mimeType: "image/png", size: 5 },
    ],
    98,
  );
  assert.equal(out.length, 3);
  assert.deepEqual(
    { uri: out[0].uri, partIndex: out[0].partIndex, partId: out[0].partId, unfinished: out[0].unfinished },
    { uri: "file:///photo.jpg", partIndex: 0, partId: "p-0", unfinished: false },
  );
  assert.equal(out[2].partIndex, 2);
  assert.equal(out[2].unfinished, false);
});

test("a different file of the same name but another size does not take the unfinished part", () => {
  const out = I.mergePickedIntakeFiles([held({})], [{ uri: "u", name: "photo.jpg", mimeType: "image/jpeg", size: 999 }], 99);
  assert.equal(out.length, 2);
  assert.equal(out[0].unfinished, true);
  assert.equal(out[1].partIndex, 1);
});

test("identity/consent failures: only link-state answers are terminal", () => {
  assert.deepEqual(I.intakeStepFailure({ statusCode: 400, code: "SUBMITTER_IDENTITY_INVALID" }).terminal, false);
  assert.match(I.intakeStepFailure({ statusCode: 400, code: "INVALID_BODY" }).message, /email/);
  assert.match(I.intakeStepFailure({ statusCode: 429, code: "RATE_LIMITED" }).message, /Wait a moment/);
  assert.match(I.intakeStepFailure(new Error("offline")).message, /connection/);
  const gone = I.intakeStepFailure({ statusCode: 410, code: "LINK_NO_LONGER_AVAILABLE" });
  assert.equal(gone.terminal, true);
  assert.equal(gone.failure, "NO_LONGER_AVAILABLE");
  assert.equal(I.intakeStepFailure({ statusCode: 404, code: "INVALID_OR_EXPIRED_LINK" }).terminal, true);
});

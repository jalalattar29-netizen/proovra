/**
 * UC-WEB-003 — the public intake page resumes its own open session after a
 * reload instead of opening a fresh one. Source contract for the page (the
 * server half is proven by services/api/test/completion-cross-channel.
 * integration.test.ts "a reload resumes the contributor's open intake session").
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync(
  fileURLToPath(new URL("../app/intake/[token]/page.tsx", import.meta.url)),
  "utf8",
);

test("the session id is presented back in a header, never in the URL", () => {
  assert.match(SRC, /"x-proovra-intake-session": resumeId/);
  assert.doesNotMatch(SRC, /external-intake\/\$\{encodeURIComponent\(token\)\}\?/);
});

test("the open session id is remembered per tab and forgotten on submit", () => {
  assert.match(SRC, /window\.sessionStorage\.setItem\(intakeSessionStorageKey\(token\), sessionId\)/);
  assert.match(SRC, /writeStoredIntakeSession\(token, res\.session\.id\)/);
  assert.match(SRC, /writeStoredIntakeSession\(token, null\);\s*setPhase\("submitted"\)/);
});

test("a resumed session restores its staged files, honestly marking ones that never reached storage", () => {
  assert.match(SRC, /res\.resumed && Array\.isArray\(res\.parts\)/);
  assert.match(SRC, /uploadedAtUtc: p\.stored \?/);
  assert.match(SRC, /This file did not finish uploading/);
});

test("leaving with staged, unsubmitted files is warned", () => {
  assert.match(SRC, /addEventListener\("beforeunload", onBeforeUnload\)/);
});

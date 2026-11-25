/**
 * Intake-link multi-file upload — partIndex assignment and the client rules
 * the public intake page applies.
 *
 * History: stageFile() once read `parts.length` from a stale closure, so a
 * multi-select sent partIndex 0 for every file. The caller then seeded a local
 * counter from `parts.length` — which still targeted an OCCUPIED index after a
 * middle file was removed (Team audit JRN-05 / T-128), and files refused
 * client-side advanced the counter anyway.
 *
 * Now (stage F): the next index is one past the highest index the session
 * holds (`nextPartIndex`), only a file the server reserved advances it, the
 * file cap counts files, and the per-submission byte allowance is computed
 * before anything is sent (T-127). These are behavioural tests of the rules
 * (`intake-client-model.ts`), plus the page wiring that calls them.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { functionSource } from "../../../scripts/source-contract/index.mjs";
import {
  INTAKE_PUBLIC_FETCH,
  acceptAttributeForKinds,
  intakeLoadErrorClass,
  intakeLoadErrorRetryable,
  nextPartIndex,
  remainingSessionBytes,
} from "../app/intake/[token]/intake-client-model";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const INTAKE_PAGE = resolve(REPO_ROOT, "apps/web/app/intake/[token]/page.tsx");
const SRC = readFileSync(INTAKE_PAGE, "utf8");

test("T-128: after removing the middle of three files the next index is 3, not 2 (an occupied index)", () => {
  const afterRemoval = [{ partIndex: 0 }, { partIndex: 2 }];
  assert.equal(afterRemoval.length, 2); // the old `parts.length` answer — index 2 is taken
  assert.equal(nextPartIndex(afterRemoval), 3);
});

test("T-128: a fresh session starts at 0; resumed parts out of order still give max+1", () => {
  assert.equal(nextPartIndex([]), 0);
  assert.equal(nextPartIndex([{ partIndex: 4 }, { partIndex: 1 }]), 5);
  assert.equal(nextPartIndex([{ partIndex: undefined }, { partIndex: 0 }]), 1);
});

test("T-127: the remaining allowance is the cap minus what is staged, never negative; no cap is null", () => {
  assert.equal(remainingSessionBytes("200", [{ sizeBytes: 150 }]), 50);
  assert.equal(remainingSessionBytes(200, [{ sizeBytes: 150 }, { sizeBytes: 100 }]), 0);
  assert.equal(remainingSessionBytes(null, [{ sizeBytes: 1 }]), null);
  assert.equal(remainingSessionBytes(undefined, []), null);
});

test("T-130: the page's transport is anonymous (no bearer, no cookies, no workspace header)", () => {
  assert.deepEqual(INTAKE_PUBLIC_FETCH, { auth: false, anonymous: true });
  assert.doesNotMatch(SRC, /\{ auth: false \}/);
});

test("T-151: the load error class comes from the code; LINK_REVOKED is expired-or-revoked", () => {
  assert.equal(intakeLoadErrorClass("LINK_REVOKED"), "expired-or-revoked");
  assert.equal(intakeLoadErrorClass("LINK_NO_LONGER_AVAILABLE"), "expired-or-revoked");
  assert.equal(intakeLoadErrorClass("INVALID_OR_EXPIRED_LINK"), "invalid");
  assert.equal(intakeLoadErrorClass("RATE_LIMITED"), "rate-limited");
  assert.equal(intakeLoadErrorClass("NETWORK_ERROR"), "network");
  assert.equal(intakeLoadErrorClass("FEATURE_DISABLED"), "feature-disabled");
  assert.equal(intakeLoadErrorClass(undefined), "generic");
  assert.equal(intakeLoadErrorRetryable("rate-limited"), true);
  assert.equal(intakeLoadErrorRetryable("network"), true);
  assert.equal(intakeLoadErrorRetryable("expired-or-revoked"), false);
  assert.equal(intakeLoadErrorRetryable("invalid"), false);
});

test("T-154: a DOCUMENT-only link filters the picker to document types; no restriction means no filter", () => {
  const accept = acceptAttributeForKinds(["DOCUMENT"]) ?? "";
  assert.match(accept, /application\/pdf/);
  assert.doesNotMatch(accept, /image\/\*/);
  assert.equal(acceptAttributeForKinds([]), undefined);
  assert.equal(acceptAttributeForKinds(["PHOTO", "VIDEO"]), "image/*,video/*");
});

test("the picker and the drop area share one selection path (addFiles), which seeds from nextPartIndex", () => {
  const add = functionSource(SRC, "addFiles", "page.tsx");
  assert.match(add, /let nextIndex = nextPartIndex\(parts\);/);
  assert.match(add, /if \(await stageFile\(f, nextIndex\)\) \{\s*nextIndex \+= 1;/);
  assert.match(add, /This link accepts up to \$\{cap\} files\./);
  assert.match(SRC, /await addFiles\(Array\.from\(e\.target\.files \?\? \[\]\)\)/);
  assert.match(SRC, /void addFiles\(Array\.from\(e\.dataTransfer\?\.files \?\? \[\]\)\)/);
  assert.match(SRC, /<input[\s\S]{0,300}type="file"[\s\S]{0,200}multiple/);
});

test("intake part submission includes silent captureTimezone + captureLocale", () => {
  assert.match(
    SRC,
    /captureTimezone:[\s\S]{0,160}Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/,
    "intake POST body must send captureTimezone from Intl",
  );
  assert.match(
    SRC,
    /captureLocale:[\s\S]{0,120}navigator\.language/,
    "intake POST body must send captureLocale from navigator.language",
  );
  const stageBody = functionSource(SRC, "stageFile", "page.tsx");
  assert.ok(
    !/rawIp\b|rawUserAgent\b/.test(stageBody),
    "intake stageFile must not send raw IP / raw User-Agent in the body",
  );
});

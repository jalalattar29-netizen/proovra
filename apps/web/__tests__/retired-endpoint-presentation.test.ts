/**
 * A RETIRED ENDPOINT IS NOT A FAILED ONE.
 *
 * Twenty-two routes answer HTTP 410 with a `*_RETIRED` code — `NL_SEARCH_RETIRED`,
 * `COLLABORATION_TEAM_INVITE_RETIRED`, `INGEST_RETIRED` and the rest. Each one
 * carries a truthful sentence written at the route, and every one of them was
 * being discarded: `SERVER_MESSAGE_ERROR_CODES` admits exactly one code
 * (`TEAM_CONFLICT`), so a retirement fell through to the generic
 * `status >= 400` bucket and told the reader to "review your input and try
 * again". No input reaches a withdrawn endpoint, and it will never succeed.
 *
 * The presentation is keyed on the CODE SUFFIX rather than on 410, and this
 * file holds that distinction: `external-intake.routes.ts` also answers 410,
 * for an expired or already-used link, which is a different sentence and one
 * the public intake page already writes for itself.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { toSafeUserError } from "../lib/feedback/toSafeUserError";
import { USER_FACING_ERRORS } from "@proovra/shared/user-facing-errors";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const ROUTES_DIR = resolve(REPO_ROOT, "services/api/src/routes");

/** Every `*_RETIRED` code the API can actually answer with. */
function retiredCodes(): string[] {
  const codes = new Set<string>();
  for (const file of readdirSync(ROUTES_DIR).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(resolve(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/"([A-Z][A-Z0-9_]*_RETIRED)"/g)) codes.add(m[1]);
  }
  return [...codes].sort();
}

test("a retirement is presented as retired, not as bad input", () => {
  const found = retiredCodes();
  assert.ok(found.length > 0, "no *_RETIRED codes found in the route layer");

  for (const code of found) {
    const safe = toSafeUserError({ statusCode: 410, code });
    assert.equal(
      safe.title,
      USER_FACING_ERRORS.FEATURE_RETIRED.title,
      `${code} is not presented as a retirement`,
    );
    assert.equal(safe.severity, "info", `${code} is not an error; nothing broke`);
    assert.doesNotMatch(
      safe.message,
      /review your input|please try again/i,
      `${code}: a withdrawn endpoint cannot be reached by correcting input, ` +
        "and will not succeed on a retry",
    );
  }
});

test("the retired copy never leaks the backend sentence", () => {
  const safe = toSafeUserError({
    statusCode: 410,
    code: "INGEST_RETIRED",
    message: "internal: ingest pipeline v1 decommissioned, see runbook 42",
  });

  assert.doesNotMatch(safe.message, /runbook|internal:|pipeline v1/i);
  assert.equal(safe.message, USER_FACING_ERRORS.FEATURE_RETIRED.message);
});

test("a 410 that is NOT a retirement keeps its own meaning", () => {
  // `external-intake.routes.ts` answers 410 for an expired or already-used
  // link. Keying the presentation on the status would have relabelled that as
  // "this feature is no longer available — update the app", which is a new
  // wrong answer in place of an old one.
  for (const code of ["LINK_NO_LONGER_AVAILABLE", "LINK_ALREADY_SUBMITTED"]) {
    const safe = toSafeUserError({ statusCode: 410, code });
    assert.notEqual(
      safe.title,
      USER_FACING_ERRORS.FEATURE_RETIRED.title,
      `${code} is an expired link, not a retired feature`,
    );
  }
});

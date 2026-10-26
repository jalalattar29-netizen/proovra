/**
 * THIRD RE-AUDIT N-7 — web and mobile must agree on what is an expected
 * business refusal. There is no shared module both clients own, so each keeps
 * a `GENERIC_NON_BUSINESS_CODES` list; this test loads the REAL web classifier
 * (apps/web/lib/feedback/toSafeUserError.ts) and the REAL mobile one
 * (src/sentry.ts) and requires:
 *
 *   - the two lists are the same set, and exactly the agreed set;
 *   - both classifiers give the same answer for every code on the list, the
 *     business / auth codes, and the code-less case, at every status that
 *     matters, both as a bare coded error and inside the server's nested
 *     `{ error: { code } }` body.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let MOBILE;
let WEB;

const AGREED = [
  "API_ERROR",
  "NETWORK_ERROR",
  "PARSE_ERROR",
  "ROUTE_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INTERNAL_ERROR",
  "INTERNAL_SERVER_ERROR",
  "DATABASE_ERROR",
  "SCHEMA_NOT_READY",
];

before(async () => {
  MOBILE = await loadModule("src/sentry.ts");
  WEB = await loadModule("../web/lib/feedback/toSafeUserError.ts");
});

test("the web and mobile generic-code lists are the same, agreed set", () => {
  assert.ok(MOBILE.GENERIC_NON_BUSINESS_CODES instanceof Set);
  assert.ok(WEB.GENERIC_NON_BUSINESS_CODES instanceof Set);
  assert.deepEqual([...MOBILE.GENERIC_NON_BUSINESS_CODES].sort(), [...AGREED].sort());
  assert.deepEqual([...WEB.GENERIC_NON_BUSINESS_CODES].sort(), [...AGREED].sort());
});

test("both classifiers agree on every code × status × body shape", () => {
  const codes = [
    ...AGREED,
    "NOT_FOUND",
    "FORBIDDEN",
    "UNAUTHORIZED",
    "VALIDATION_ERROR",
    "validation_error",
    "INVALID_INPUT",
    "INVALID_REQUEST",
    "BAD_REQUEST",
    "CONFLICT",
    "WORKSPACE_SEAT_LIMIT_REACHED",
    "PERMISSION_REQUIRED",
    "TEAM_NOT_FOUND",
    "RATE_LIMITED",
    undefined,
  ];
  const statuses = [400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 429, 500, 503];
  const verdict = {};
  for (const code of codes) {
    for (const status of statuses) {
      for (const nested of [false, true]) {
        const err = Object.assign(new Error("x"), {
          statusCode: status,
          ...(code ? { code } : {}),
          ...(code && nested ? { body: { error: { code } } } : {}),
        });
        const web = WEB.isExpectedBusinessRefusal(err);
        const mobile = MOBILE.isExpectedBusinessRefusal(err);
        assert.equal(mobile, web, `${code ?? "<none>"} @ ${status} nested=${nested}: web=${web} mobile=${mobile}`);
        verdict[`${code}@${status}@${nested}`] = web;
      }
    }
  }
  // Controls: the parity is not vacuous.
  assert.equal(verdict["ROUTE_NOT_FOUND@404@true"], false);
  assert.equal(verdict["INTERNAL_SERVER_ERROR@500@true"], false);
  assert.equal(verdict["NOT_FOUND@404@true"], true);
  assert.equal(verdict["FORBIDDEN@403@true"], true);
  assert.equal(verdict["UNAUTHORIZED@401@true"], true);
  assert.equal(verdict["VALIDATION_ERROR@400@true"], true);
  // A bare UNAUTHORIZED with no server envelope is the transport's code-less 401.
  assert.equal(verdict["UNAUTHORIZED@401@false"], false);
  assert.equal(verdict["TEAM_NOT_FOUND@404@false"], true);
});

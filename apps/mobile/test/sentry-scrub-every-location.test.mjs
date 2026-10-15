/**
 * AUD-022 — the app's Sentry hooks (the exact functions `initSentry` installs)
 * remove every sensitive kind from every event location. The old scrubber
 * covered request URLs/headers and breadcrumb DATA only: breadcrumb messages,
 * extra, user and exception values reached Sentry verbatim.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";
import { SENSITIVE_KINDS, eventsCarrying, leaks } from "../../../packages/shared/tests/telemetry-scrub-fixtures.mjs";

let S;
before(async () => {
  S = await loadModule("src/sentry.ts");
});

test("no sensitive value escapes any event location", () => {
  const failures = [];
  for (const { kind, text, needles } of SENSITIVE_KINDS) {
    for (const [location, event] of eventsCarrying(text)) {
      const out = S.mobileSentryBeforeSend(structuredClone(event));
      if (out === null) failures.push(`${kind} @ ${location}: dropped`);
      const leaked = leaks(out, needles);
      if (leaked.length > 0) failures.push(`${kind} @ ${location}: ${leaked.join(", ")}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("breadcrumb messages are scrubbed, not only breadcrumb data", () => {
  const out = S.mobileSentryBeforeBreadcrumb({
    category: "console",
    message: "upload failed for jane.doe@example.com with Bearer abcSecretBearer",
  });
  assert.doesNotMatch(JSON.stringify(out), /jane\.doe@example\.com|abcSecretBearer/);
});

test("fails closed: an unreadable event is dropped", () => {
  const hostile = { message: "x" };
  Object.defineProperty(hostile, "user", { enumerable: true, get() { throw new Error("boom"); } });
  assert.equal(S.mobileSentryBeforeSend(hostile), null);
});

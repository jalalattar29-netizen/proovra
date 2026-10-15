/**
 * AUD-022 — the web's Sentry hooks (webSentryBeforeSend / BeforeBreadcrumb,
 * the exact functions `initSentry` installs) remove every sensitive kind from
 * every event location, and fail CLOSED (the old scrubber returned the raw
 * event when it threw).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { webSentryBeforeBreadcrumb, webSentryBeforeSend } from "../lib/sentry";
// Test-only matrix shared by every Sentry surface.
import { SENSITIVE_KINDS, eventsCarrying, leaks } from "../../../packages/shared/tests/telemetry-scrub-fixtures.mjs";

type Kind = { kind: string; text: string; needles: string[] };

test("no sensitive value escapes any event location", () => {
  const failures: string[] = [];
  for (const { kind, text, needles } of SENSITIVE_KINDS as Kind[]) {
    for (const [location, event] of eventsCarrying(text) as Array<[string, Record<string, unknown>]>) {
      const out = webSentryBeforeSend(structuredClone(event));
      if (out === null) failures.push(`${kind} @ ${location}: dropped`);
      const leaked = leaks(out, needles) as string[];
      if (leaked.length > 0) failures.push(`${kind} @ ${location}: ${leaked.join(", ")}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("identifiers never leave the browser (web privacy policy)", () => {
  const id = "3f2c1a9e-1b2c-4d5e-8f90-1234567890ab";
  const out = webSentryBeforeSend({ message: `evidence ${id} failed`, extra: { evidenceId: id } });
  assert.ok(out);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(id));
});

test("breadcrumbs are scrubbed before they are recorded", () => {
  const out = webSentryBeforeBreadcrumb({
    category: "fetch",
    message: "GET https://app.proovra.com/verify/pvs_secretShare99999999?x=1",
    data: { url: "https://bucket/x?X-Amz-Signature=abcdefsig", authorization: "Bearer zzz" },
  });
  assert.doesNotMatch(JSON.stringify(out), /pvs_secretShare99999999|abcdefsig|zzz/);
});

test("fails closed: an event the scrubber cannot read is dropped, not sent raw", () => {
  const hostile: Record<string, unknown> = { message: "x" };
  Object.defineProperty(hostile, "extra", { enumerable: true, get() { throw new Error("boom"); } });
  assert.equal(webSentryBeforeSend(hostile), null);
});

test("sensitive route errors keep no free-form fields", () => {
  const out = webSentryBeforeSend({
    message: "boom",
    request: { url: "https://app.proovra.com/verify/abc" },
    extra: { anything: "x" },
  }) as Record<string, unknown>;
  assert.equal(out.message, "[redacted: sensitive route error]");
  assert.equal(out.extra, undefined);
});

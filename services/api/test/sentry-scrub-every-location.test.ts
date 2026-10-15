/**
 * AUD-022 — the API's Sentry hooks (the exact functions `initSentry` installs)
 * remove every sensitive kind from every event location. `beforeSend` used to
 * filter only and send error events unscrubbed; `beforeSendTransaction`
 * stripped a few header names.
 */
import { describe, expect, it } from "vitest";

import {
  apiSentryBeforeBreadcrumb,
  apiSentryBeforeSend,
  apiSentryBeforeSendTransaction,
} from "../src/observability/sentry.js";
// Test-only matrix shared by every Sentry surface.
import {
  SENSITIVE_KINDS,
  eventsCarrying,
  leaks,
} from "../../../packages/shared/tests/telemetry-scrub-fixtures.mjs";

type Kind = { kind: string; text: string; needles: string[] };

describe("API Sentry scrubbing", () => {
  for (const [name, hook] of [
    ["beforeSend", (e: unknown) => apiSentryBeforeSend(e, { originalException: new Error("server fault") })],
    ["beforeSendTransaction", (e: unknown) => apiSentryBeforeSendTransaction(e)],
  ] as const) {
    it(`${name}: no sensitive value escapes any event location`, () => {
      const failures: string[] = [];
      for (const { kind, text, needles } of SENSITIVE_KINDS as Kind[]) {
        for (const [location, event] of eventsCarrying(text) as Array<[string, Record<string, unknown>]>) {
          const out = hook(structuredClone(event));
          if (out === null) failures.push(`${kind} @ ${location}: dropped`);
          const leaked = leaks(out, needles) as string[];
          if (leaked.length > 0) failures.push(`${kind} @ ${location}: ${leaked.join(", ")}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("breadcrumbs are scrubbed before they are recorded", () => {
    const out = apiSentryBeforeBreadcrumb({
      category: "http",
      message: "POST /v1/external-intake/intakeTok123456/files",
      data: { url: "https://s3/x?X-Amz-Signature=sigsig", cookie: "proovra_session=abc" },
    });
    expect(JSON.stringify(out)).not.toMatch(/intakeTok123456|sigsig|proovra_session=abc/);
  });

  it("the capture decision still runs first: expected denials are dropped", () => {
    const denial = Object.assign(new Error("Free evidence limit reached"), { statusCode: 409 });
    expect(apiSentryBeforeSend({ message: "x" }, { originalException: denial })).toBeNull();
  });

  it("fails closed: an unreadable event is dropped, never sent raw", () => {
    const hostile: Record<string, unknown> = { message: "x" };
    Object.defineProperty(hostile, "contexts", { enumerable: true, get() { throw new Error("boom"); } });
    expect(apiSentryBeforeSend(hostile, { originalException: new Error("fault") })).toBeNull();
  });

  it("server telemetry keeps record identifiers (no client identifier policy)", () => {
    const id = "3f2c1a9e-1b2c-4d5e-8f90-1234567890ab";
    const out = apiSentryBeforeSend({ extra: { evidenceId: id } }, { originalException: new Error("fault") });
    expect(JSON.stringify(out)).toContain(id);
  });
});

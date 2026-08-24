/**
 * WHAT THE STORAGE LAYER ACTUALLY SENDS TO S3, WITH OBJECT LOCK CONFIGURED.
 *
 * The companion source-contract suite proves no code path can REACH
 * `PutObjectLegalHold`. This one proves the other half behaviourally: with
 * Object Lock switched on exactly as production has it — COMPLIANCE, 2920 days
 * — and with the legacy variable set to each of its dangerous values, the
 * commands that leave the process still carry retention and never carry a
 * legal hold.
 *
 * The S3 client's `send` is replaced, so this reaches no network and no bucket.
 * What is captured is the command objects themselves, which is the thing under
 * test: the argument PROOVRA builds, not what a server does with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyDefaultObjectRetention, s3 } from "../src/storage.js";

/** Every command the storage layer handed to the client during one case. */
let sent: Array<{ name: string; input: Record<string, unknown> }> = [];
const ENV_KEYS = [
  "S3_OBJECT_LOCK_ENABLED",
  "S3_OBJECT_LOCK_MODE",
  "S3_OBJECT_LOCK_RETAIN_DAYS",
  "S3_OBJECT_LOCK_LEGAL_HOLD",
] as const;
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  sent = [];
  previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  vi.spyOn(s3, "send").mockImplementation((async (command: unknown) => {
    const c = command as { constructor: { name: string }; input: Record<string, unknown> };
    sent.push({ name: c.constructor.name, input: c.input });
    return {};
  }) as never);
  // Production's storage posture, restated here rather than inherited from the
  // ambient environment: the case is about THIS configuration.
  process.env.S3_OBJECT_LOCK_ENABLED = "true";
  process.env.S3_OBJECT_LOCK_MODE = "COMPLIANCE";
  process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "2920";
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k]!;
  }
});

const names = () => sent.map((c) => c.name);
const retention = () =>
  sent.find((c) => c.name === "PutObjectRetentionCommand");

describe("applying default Object Lock retention", () => {
  for (const legacy of ["OFF", "ON", undefined] as const) {
    const label =
      legacy === undefined ? "unset" : `S3_OBJECT_LOCK_LEGAL_HOLD=${legacy}`;

    it(`with ${label}: retention is applied and NO legal hold is sent`, async () => {
      if (legacy === undefined) delete process.env.S3_OBJECT_LOCK_LEGAL_HOLD;
      else process.env.S3_OBJECT_LOCK_LEGAL_HOLD = legacy;

      const result = await applyDefaultObjectRetention({
        bucket: "disposable-test-bucket",
        key: "fictional/object-lock-probe.bin",
      });

      expect(result.applied).toBe(true);

      // RETENTION — unchanged, and this is the assertion that stops the
      // foot-gun removal from quietly taking Object Lock with it.
      const put = retention();
      expect(put, "PutObjectRetention must still be sent").toBeTruthy();
      expect((put!.input.Retention as { Mode: string }).Mode).toBe("COMPLIANCE");
      const until = (put!.input.Retention as { RetainUntilDate: Date })
        .RetainUntilDate;
      expect(until).toBeInstanceOf(Date);
      // ~2920 days out. Bounded rather than exact: the value is computed from
      // the clock, and pinning it to the millisecond would test the clock.
      const days = (until.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(2919);
      expect(days).toBeLessThan(2921);

      // LEGAL HOLD — never, for any value of the legacy variable. `ON` is the
      // case that used to place unreleasable native holds on a COMPLIANCE
      // bucket; it now sends nothing.
      expect(names()).not.toContain("PutObjectLegalHoldCommand");
      for (const c of sent) {
        expect(
          JSON.stringify(c.input),
          `${c.name} must carry no legal-hold field`,
        ).not.toContain("LegalHold");
      }
    });
  }

  it("with Object Lock disabled, nothing is sent at all", async () => {
    process.env.S3_OBJECT_LOCK_ENABLED = "false";
    process.env.S3_OBJECT_LOCK_LEGAL_HOLD = "ON";

    const result = await applyDefaultObjectRetention({
      bucket: "disposable-test-bucket",
      key: "fictional/object-lock-probe.bin",
    });

    expect(result.applied).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

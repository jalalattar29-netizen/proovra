/**
 * Intake-links-e2e Phase 1 — lifecycle priority + masking unit tests.
 *
 * The lifecycle deriver is the heart of the list UI: it decides whether
 * each row reads "Sent", "Opened", "Submitted", "Expired", etc. The
 * priority order is auditable and pinned here so a future refactor of
 * the deriver can't silently change what users see.
 *
 * Priority (highest first):
 *   SUBMITTED > REVOKED > EXPIRED > STARTED > OPENED >
 *   DELIVERY_FAILED > SENT > CREATED
 *
 * Carve-out: SUBMITTED outranks REVOKED/EXPIRED because the
 * contributor's upload already exists and the lifecycle chip should
 * reflect work done, not the door being closed afterward. (The list UI
 * still surfaces the REVOKED/EXPIRED status as a separate chip.)
 */

import { strict as assert } from "node:assert";
import { describe, it } from "vitest";

import {
  computeIntakeLinkLifecycle,
  maskEmailForList,
  maskPhoneForList,
} from "../src/services/intake-link-lifecycle.service.js";

const FUTURE = new Date("2099-01-01T00:00:00Z");
const PAST = new Date("2000-01-01T00:00:00Z");
const NOW = new Date("2026-06-16T00:00:00Z");

function baseInput(): Parameters<typeof computeIntakeLinkLifecycle>[0] {
  return {
    linkStatus: "ACTIVE",
    expiresAtUtc: FUTURE,
    sessionCounts: { submitted: 0, started: 0, opened: 0 },
    latestDeliveryStatus: null,
    now: NOW,
  };
}

describe("computeIntakeLinkLifecycle — priority order", () => {
  it("returns CREATED when nothing has happened", () => {
    assert.equal(computeIntakeLinkLifecycle(baseInput()), "CREATED");
  });

  it("returns SENT when delivery succeeded but no contributor activity", () => {
    for (const s of ["SENT", "DELIVERED", "QUEUED", "RETRY_SCHEDULED"] as const) {
      assert.equal(
        computeIntakeLinkLifecycle({
          ...baseInput(),
          latestDeliveryStatus: s,
        }),
        "SENT",
        `latest delivery=${s} should map to SENT`,
      );
    }
  });

  it("returns DELIVERY_FAILED when the latest send failed and there's no activity", () => {
    for (const s of ["FAILED", "UNDELIVERED"] as const) {
      assert.equal(
        computeIntakeLinkLifecycle({
          ...baseInput(),
          latestDeliveryStatus: s,
        }),
        "DELIVERY_FAILED",
      );
    }
  });

  it("OPENED beats SENT and DELIVERY_FAILED", () => {
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        latestDeliveryStatus: "SENT",
        sessionCounts: { submitted: 0, started: 0, opened: 1 },
      }),
      "OPENED",
    );
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        latestDeliveryStatus: "FAILED",
        sessionCounts: { submitted: 0, started: 0, opened: 1 },
      }),
      "OPENED",
    );
  });

  it("STARTED beats OPENED", () => {
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        sessionCounts: { submitted: 0, started: 1, opened: 1 },
      }),
      "STARTED",
    );
  });

  it("EXPIRED beats STARTED/OPENED/SENT (but NOT SUBMITTED)", () => {
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        expiresAtUtc: PAST,
        sessionCounts: { submitted: 0, started: 1, opened: 1 },
        latestDeliveryStatus: "SENT",
      }),
      "EXPIRED",
    );
    // Explicit linkStatus=EXPIRED also maps.
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        linkStatus: "EXPIRED",
        sessionCounts: { submitted: 0, started: 0, opened: 1 },
      }),
      "EXPIRED",
    );
  });

  it("REVOKED beats EXPIRED / STARTED / OPENED / SENT (but NOT SUBMITTED)", () => {
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        linkStatus: "REVOKED",
        expiresAtUtc: PAST,
        sessionCounts: { submitted: 0, started: 1, opened: 1 },
        latestDeliveryStatus: "SENT",
      }),
      "REVOKED",
    );
  });

  it("SUBMITTED is the absolute winner — outranks REVOKED + EXPIRED", () => {
    // Revoked + Expired + a successful submission → SUBMITTED.
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        linkStatus: "REVOKED",
        expiresAtUtc: PAST,
        sessionCounts: { submitted: 1, started: 1, opened: 1 },
        latestDeliveryStatus: "FAILED",
      }),
      "SUBMITTED",
    );
  });

  it("respects the `now` override for deterministic tests", () => {
    // Link expires "tomorrow" by reference; pin `now` AFTER that point.
    const tomorrow = new Date("2026-06-17T00:00:00Z");
    assert.equal(
      computeIntakeLinkLifecycle({
        ...baseInput(),
        expiresAtUtc: tomorrow,
        now: new Date("2026-06-18T00:00:00Z"),
      }),
      "EXPIRED",
    );
  });
});

describe("PII masking helpers", () => {
  it("maskEmailForList returns null for null", () => {
    assert.equal(maskEmailForList(null), null);
  });
  it("maskEmailForList masks the local part keeping the first + last char + the @domain", () => {
    assert.equal(maskEmailForList("jane@example.com"), "j••e@example.com");
    assert.equal(maskEmailForList("jo@example.com"), "j•@example.com");
    assert.equal(maskEmailForList("a@example.com"), "a•@example.com");
  });
  it("maskEmailForList returns null on malformed input (defense in depth)", () => {
    assert.equal(maskEmailForList("not-an-email"), null);
    assert.equal(maskEmailForList("@domain.only"), null);
  });
  it("maskPhoneForList preserves the leading + and last two digits", () => {
    // 12 digits — head=+141, masked middle, tail=23.
    assert.equal(maskPhoneForList("+14155550123"), "+141••23");
    // Already short — passes through.
    assert.equal(maskPhoneForList("123"), "123");
  });
  it("maskPhoneForList strips non-digits before masking", () => {
    assert.equal(maskPhoneForList("+1 (415) 555-0123"), "+141••23");
  });
  it("maskPhoneForList returns null on null", () => {
    assert.equal(maskPhoneForList(null), null);
  });
});

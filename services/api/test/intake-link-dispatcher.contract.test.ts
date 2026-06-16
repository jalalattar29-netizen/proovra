/**
 * Intake-links-e2e Phase 5 — dispatcher source-contract.
 *
 * Pins the idempotency + retry-cap invariants of
 * `dispatchIntakeLinkDelivery` so a refactor can't silently regress
 * the double-click protection. Behavioural tests with a stubbed
 * Prisma + send-helper live alongside; this file is the cheap belt
 * that fails CI fast if the contract is broken.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildIntakeIdempotencyHash, MAX_INTAKE_DELIVERY_ATTEMPTS, INTAKE_IDEM_PREFIX } from "../src/services/intake-link-delivery-dispatcher.service.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/intake-link-delivery-dispatcher.service.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("buildIntakeIdempotencyHash", () => {
  it("is deterministic for the same inputs", () => {
    const a = buildIntakeIdempotencyHash({
      intakeLinkId: "link-1",
      channel: "EMAIL",
      idempotencyKey: "nonce-x",
    });
    const b = buildIntakeIdempotencyHash({
      intakeLinkId: "link-1",
      channel: "EMAIL",
      idempotencyKey: "nonce-x",
    });
    assert.equal(a, b);
  });

  it("changes when ANY of (linkId, channel, idempotencyKey) changes", () => {
    const base = buildIntakeIdempotencyHash({
      intakeLinkId: "link-1",
      channel: "EMAIL",
      idempotencyKey: "nonce-x",
    });
    assert.notEqual(
      base,
      buildIntakeIdempotencyHash({
        intakeLinkId: "link-2",
        channel: "EMAIL",
        idempotencyKey: "nonce-x",
      }),
    );
    assert.notEqual(
      base,
      buildIntakeIdempotencyHash({
        intakeLinkId: "link-1",
        channel: "SMS",
        idempotencyKey: "nonce-x",
      }),
    );
    assert.notEqual(
      base,
      buildIntakeIdempotencyHash({
        intakeLinkId: "link-1",
        channel: "EMAIL",
        idempotencyKey: "nonce-y",
      }),
    );
  });

  it("returns a 32-char hex string (fits providerMessageId column with prefix)", () => {
    const h = buildIntakeIdempotencyHash({
      intakeLinkId: "link-1",
      channel: "EMAIL",
      idempotencyKey: "nonce-x",
    });
    assert.equal(h.length, 32);
    assert.match(h, /^[0-9a-f]{32}$/);
    // With the `intake-idem:` prefix the total length must stay
    // within the VarChar(96) limit of providerMessageId.
    assert.ok(INTAKE_IDEM_PREFIX.length + h.length <= 96);
  });
});

test("MAX_INTAKE_DELIVERY_ATTEMPTS is a sensible small cap", () => {
  // Operator UX: 3 attempts per (link, channel) is enough for a
  // double-click + one explicit resend. More than that and the user
  // should be routed to a different channel or have a real
  // conversation about what's going wrong.
  assert.equal(MAX_INTAKE_DELIVERY_ATTEMPTS, 3);
});

describe("dispatcher source-contract", () => {
  it("looks up prior attempts by (linkId, channel, providerMessageId=marker)", () => {
    const src = read(SERVICE);
    assert.match(
      src,
      /client\.communicationMessage\.findFirst\(\{[\s\S]{0,200}relatedIntakeLinkId: input\.intakeLinkId/,
    );
    assert.match(src, /channel: input\.channel/);
    assert.match(src, /providerMessageId: idemMarker/);
  });

  it("returns deduped=true with the prior message ID when an in-flight attempt exists", () => {
    const src = read(SERVICE);
    assert.match(
      src,
      /return \{\s*\n?\s*ok: true,\s*\n?\s*deduped: true,/,
    );
    assert.match(src, /communicationMessageId: prior\.id/);
  });

  it("enforces the attempt cap BEFORE making a fresh provider call", () => {
    const src = read(SERVICE);
    // The count() call must be present and gated against
    // MAX_INTAKE_DELIVERY_ATTEMPTS.
    assert.match(
      src,
      /attemptCount = await client\.communicationMessage\.count/,
    );
    assert.match(
      src,
      /attemptCount >= MAX_INTAKE_DELIVERY_ATTEMPTS/,
    );
    assert.match(src, /reason: "max_attempts_exceeded"/);
  });

  it("never leaks the synthetic idempotency marker as a provider ID to callers", () => {
    const src = read(SERVICE);
    // The dedupe success path explicitly returns providerMessageId: null
    // — confirm this stays explicit rather than echoing the marker.
    const dedupedReturnIdx = src.indexOf("deduped: true,");
    assert.ok(dedupedReturnIdx > 0);
    const slice = src.slice(dedupedReturnIdx, dedupedReturnIdx + 500);
    assert.match(slice, /providerMessageId: null/);
  });

  it("re-uses the existing send-via-X helpers for the real provider call", () => {
    const src = read(SERVICE);
    assert.match(src, /sendIntakeLinkViaEmail\(/);
    assert.match(src, /sendIntakeLinkViaSms\(/);
  });

  it("dispatches on the channel discriminator (EMAIL → Email helper, else SMS helper handles SMS/WHATSAPP)", () => {
    const src = read(SERVICE);
    assert.match(src, /if \(input\.channel === "EMAIL"\)/);
  });
});

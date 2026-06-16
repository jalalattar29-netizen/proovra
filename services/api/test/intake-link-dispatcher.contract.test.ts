/**
 * Intake-links-e2e Phase 5 — dispatcher source-contract.
 *
 * Pins the idempotency + retry-cap invariants of
 * `dispatchIntakeLinkDelivery` so a refactor can't silently regress
 * the double-click protection.
 *
 * Forensic P0 update — idempotency MUST live in its own column
 * (`deliveryIdempotencyKey`) and NEVER hijack `providerMessageId`.
 * Production-DB audit on 2026-06-16 found rows with
 * `provider_message_id = "intake-idem:<hex>"`, clobbering the real
 * Twilio SID and breaking webhook correlation + UI delivery tracking.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildIntakeIdempotencyHash,
  MAX_INTAKE_DELIVERY_ATTEMPTS,
} from "../src/services/intake-link-delivery-dispatcher.service.js";

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

  it("returns a bare 32-char hex string (NO prefix — stored in its own column)", () => {
    const h = buildIntakeIdempotencyHash({
      intakeLinkId: "link-1",
      channel: "EMAIL",
      idempotencyKey: "nonce-x",
    });
    assert.equal(h.length, 32);
    assert.match(h, /^[0-9a-f]{32}$/);
    // The hash is stored in delivery_idempotency_key VARCHAR(128) —
    // plenty of room without a prefix.
    assert.ok(h.length <= 128);
    // Forensic P0 invariant: the hash MUST NOT carry an `intake-idem:`
    // prefix any more. That string was clobbering the real Twilio SID.
    assert.ok(!h.startsWith("intake-idem"));
  });
});

test("MAX_INTAKE_DELIVERY_ATTEMPTS is a sensible small cap", () => {
  assert.equal(MAX_INTAKE_DELIVERY_ATTEMPTS, 3);
});

describe("dispatcher source-contract", () => {
  it("looks up prior attempts by (linkId, channel, deliveryIdempotencyKey)", () => {
    const src = read(SERVICE);
    assert.match(
      src,
      /client\.communicationMessage\.findFirst\(\{[\s\S]{0,400}relatedIntakeLinkId: input\.intakeLinkId/,
    );
    assert.match(src, /channel: input\.channel/);
    assert.match(src, /deliveryIdempotencyKey: idemHash/);
  });

  it("returns deduped=true with the REAL prior providerMessageId when an in-flight attempt exists", () => {
    const src = read(SERVICE);
    assert.match(
      src,
      /return \{\s*\n?\s*ok: true,\s*\n?\s*deduped: true,/,
    );
    assert.match(src, /communicationMessageId: prior\.id/);
    // The dedupe path now echoes the REAL provider SID from the prior
    // row (the send-helper wrote it via updateAfterProviderAttempt).
    // We never substitute the synthetic idempotency hash.
    assert.match(src, /providerMessageId: prior\.providerMessageId \?\? null/);
  });

  it("enforces the attempt cap BEFORE making a fresh provider call", () => {
    const src = read(SERVICE);
    assert.match(
      src,
      /attemptCount = await client\.communicationMessage\.count/,
    );
    assert.match(src, /attemptCount >= MAX_INTAKE_DELIVERY_ATTEMPTS/);
    assert.match(src, /reason: "max_attempts_exceeded"/);
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

describe("Forensic P0 — providerMessageId integrity", () => {
  it("the dispatcher NEVER writes to providerMessageId (would clobber real Twilio SID)", () => {
    const src = read(SERVICE);
    // Locate the entrypoint body and scan every CommunicationMessage
    // write inside it. None may target providerMessageId.
    const startIdx = src.indexOf("export async function dispatchIntakeLinkDelivery");
    assert.ok(startIdx > 0, "entrypoint not found");
    const body = src.slice(startIdx);
    // No update-data block in the dispatcher may set providerMessageId.
    assert.ok(
      !/data:\s*\{\s*[\s\S]{0,200}providerMessageId\s*:/.test(body),
      "dispatcher must not write providerMessageId — the send-helper sets the real SID via updateAfterProviderAttempt",
    );
  });

  it("the synthetic `intake-idem:` prefix is completely removed from the dispatcher", () => {
    const src = read(SERVICE);
    // The prefix was the source of the bug; it must not appear in
    // any code path (string literal or constant).
    // Allow it only inside comments documenting the historical bug
    // and in the migration backfill description.
    const codeLines = src
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//");
      })
      .join("\n");
    assert.ok(
      !codeLines.includes("intake-idem"),
      "the `intake-idem:` marker must not appear in dispatcher code (it was clobbering Twilio SIDs in prod)",
    );
    assert.ok(
      !codeLines.includes("INTAKE_IDEM_PREFIX"),
      "INTAKE_IDEM_PREFIX constant must be removed; the hash is stored bare in deliveryIdempotencyKey",
    );
  });

  it("the dispatcher writes deliveryIdempotencyKey on BOTH the success and failure paths", () => {
    const src = read(SERVICE);
    // Two patch sites: post-success and post-failure. Both must
    // target deliveryIdempotencyKey (so a retry with the same nonce
    // finds the row), neither may touch providerMessageId.
    const matches = src.match(/data:\s*\{\s*deliveryIdempotencyKey:\s*idemHash\s*\}/g);
    assert.ok(
      matches && matches.length >= 2,
      `expected 2 writes to deliveryIdempotencyKey (success + failure), got ${matches?.length ?? 0}`,
    );
  });
});

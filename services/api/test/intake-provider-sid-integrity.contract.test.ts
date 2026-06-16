/**
 * Intake-links forensic P0 — providerMessageId / Twilio SID integrity.
 *
 * Production-DB audit on 2026-06-16 surfaced this row shape:
 *   communication_messages.provider_message_id = 'intake-idem:<hex>'
 *
 * That is the dispatcher's own idempotency hash, NOT the real Twilio
 * Message SID (SM…/MM…). Consequences:
 *   • Twilio's status webhook (StatusCallback) matches by SID, so
 *     QUEUED rows could never advance to SENT/DELIVERED.
 *   • The operator UI's delivery drawer surfaced our internal nonce
 *     to humans.
 *   • There was no way to correlate WhatsApp failures (errorCode 63016
 *     "no joined sandbox" etc.) back to the row.
 *
 * Pins (1:1 with user-requested invariants):
 *   1) `providerMessageId` stores the real Twilio SID (the provider
 *      returns it as `sid` on POST /Messages.json).
 *   2) Idempotency key has its own column `deliveryIdempotencyKey`.
 *   3) WhatsApp send uses `whatsapp:` prefix on BOTH `from` and `to`.
 *   4) Twilio `accepted` / `queued` / `sending` do NOT collapse to
 *      SENT — they map to QUEUED until the webhook upgrades.
 *   5) Status webhook matches by real Twilio SID (`MessageSid` from
 *      Twilio → our `providerMessageId` lookup).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const DISPATCHER = resolve(
  REPO_ROOT,
  "services/api/src/services/intake-link-delivery-dispatcher.service.ts",
);
const TWILIO = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/twilio-provider.ts",
);
const COMM_SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/communication.service.ts",
);
const SCHEMA = resolve(REPO_ROOT, "services/api/prisma/schema.prisma");
const MIGRATION = resolve(
  REPO_ROOT,
  "services/api/prisma/migrations/20270823000000_communication_message_idem_key_split/migration.sql",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — providerMessageId stores the real Twilio SID", () => {
  it("Twilio provider returns ProviderSendResult.providerMessageId = response.sid", () => {
    const src = read(TWILIO);
    // The Messages.json response is parsed and `sid` is plumbed into
    // `providerMessageId` on the OK result.
    assert.match(src, /body\["sid"\]/);
    assert.match(src, /providerMessageId: sid/);
  });

  it("communication.service.ts persists provider.providerMessageId onto the CommunicationMessage row", () => {
    const src = read(COMM_SERVICE);
    assert.match(src, /providerMessageId: result\.providerMessageId/);
  });

  it("Twilio fails the send when the response carries no SID (defence-in-depth)", () => {
    const src = read(TWILIO);
    assert.match(src, /missing_sid/);
    assert.match(src, /Twilio did not return a message SID/);
  });
});

describe("Pin 2 — idempotency lives in its own column", () => {
  it("Prisma schema declares CommunicationMessage.deliveryIdempotencyKey VARCHAR(128)", () => {
    const src = read(SCHEMA);
    assert.match(
      src,
      /deliveryIdempotencyKey\s+String\?\s+@map\("delivery_idempotency_key"\)\s+@db\.VarChar\(128\)/,
    );
  });

  it("Prisma schema indexes (relatedIntakeLinkId, channel, deliveryIdempotencyKey)", () => {
    const src = read(SCHEMA);
    assert.match(
      src,
      /@@index\(\[relatedIntakeLinkId, channel, deliveryIdempotencyKey\]/,
    );
  });

  it("Migration adds the column AND backfills hijacked rows AND nulls their provider_message_id", () => {
    const src = read(MIGRATION);
    assert.match(src, /ADD COLUMN IF NOT EXISTS "delivery_idempotency_key" VARCHAR\(128\)/);
    // Backfill: strip the prefix and move the hash into the new column.
    assert.match(src, /SUBSTRING\(\s*"provider_message_id"\s+FROM\s+\(LENGTH\('intake-idem:'\)\s+\+\s+1\)\s*\)/);
    // Real SID is unrecoverable for hijacked rows — set NULL so the
    // operator UI shows "Provider tracking unavailable" rather than
    // displaying the internal nonce.
    assert.match(src, /"provider_message_id"\s*=\s*NULL/);
    assert.match(src, /WHERE\s+"provider_message_id"\s+LIKE\s+'intake-idem:%'/);
  });

  it("dispatcher writes the bare hash into deliveryIdempotencyKey (NEVER providerMessageId)", () => {
    const src = read(DISPATCHER);
    const writes = src.match(/data:\s*\{\s*deliveryIdempotencyKey:\s*idemHash\s*\}/g);
    assert.ok(
      writes && writes.length >= 2,
      `expected ≥2 dispatcher writes to deliveryIdempotencyKey, got ${writes?.length ?? 0}`,
    );
    // And critically — no provider-id writes in the dispatcher.
    const entrypoint = src.slice(src.indexOf("export async function dispatchIntakeLinkDelivery"));
    assert.ok(
      !/data:\s*\{[^}]*providerMessageId\s*:/.test(entrypoint),
      "dispatcher must NOT write providerMessageId — that clobbers the real Twilio SID",
    );
  });
});

describe("Pin 3 — WhatsApp send uses whatsapp: prefix on both from and to", () => {
  it("Twilio sendMessage sets To = whatsapp:<E164> for the WHATSAPP channel", () => {
    const src = read(TWILIO);
    assert.match(
      src,
      /channel === "WHATSAPP" \? `whatsapp:\$\{input\.toE164\}`/,
    );
  });

  it("Twilio sendMessage sets From = whatsapp:<configured number> when no MessagingServiceSid", () => {
    const src = read(TWILIO);
    assert.match(
      src,
      /channel === "WHATSAPP" && this\.cfg\.whatsappNumber[\s\S]{0,80}params\.set\("From", `whatsapp:\$\{this\.cfg\.whatsappNumber\}`\)/,
    );
  });
});

describe("Pin 4 — Twilio accepted/queued/sending do NOT mean delivered", () => {
  it("Only 'sent' or 'delivered' collapse to SENT — everything else stays QUEUED", () => {
    const src = read(TWILIO);
    assert.match(
      src,
      /lower === "sent" \|\| lower === "delivered" \? "SENT" : "QUEUED"/,
    );
  });

  it("sentAtUtc is only stamped when mappedStatus is SENT", () => {
    const src = read(TWILIO);
    assert.match(
      src,
      /sentAtUtc: mappedStatus === "SENT" \? new Date\(\) : null/,
    );
  });
});

describe("Pin 5 — Status webhook correlates by real Twilio SID", () => {
  it("parseDeliveryWebhook extracts providerMessageId from MessageSid (the SID Twilio sends back)", () => {
    const src = read(TWILIO);
    // The webhook parser pulls `MessageSid` from the form body and
    // exposes it as `providerMessageId` so the route can do a
    // CommunicationMessage.findFirst({where: {providerMessageId}}).
    assert.match(src, /providerMessageId:\s*\(fields\.MessageSid\s*\?\?\s*""\)\.trim\(\)/);
  });
});

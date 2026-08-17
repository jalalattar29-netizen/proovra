/**
 * PROOVRA Phase 4B — Signed delivery primitives.
 *
 * Bounded HMAC-SHA256 manifest signing for the Evidence Exchange
 * Packages surface. Pure utility: no Prisma writes (read-only
 * projection helpers only). The actual signed-URL persistence lives
 * with the exchange service.
 *
 * Hard rules:
 *   * Tokens are bounded base64url, time-limited, never log-leaked.
 *   * Verification is constant-time on the HMAC compare path.
 *   * This module emits nothing. Audit emission was once described here as
 *     "forward-declared via the webhook platform"; the only emitter was the
 *     verification event, which no code path ever fired (Phase 13 §4,
 *     2026-08-17). Signing, verification and the delivery projection are all
 *     it does.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// PHASE 13 §4 (2026-08-17) — the forward-declared webhook emitter was REMOVED
// here, with the only thing that used it.
//
// `tryEmitWebhookEvent` and its `WebhookEmitter` type existed for exactly one
// caller: `emitTransferVerificationEvent`, which fired an `EVIDENCE_VERIFIED`
// webhook when a recipient verified a signed delivery. That writer is gone —
// there is no verify endpoint, nothing ever called it, and the note below the
// projection helper records why — so the "forward declaration" was forward to
// nothing. The lint error it left (`tryEmitWebhookEvent is defined but never
// used`) was the accurate report of a half-applied removal, and the answer is
// to finish the removal rather than to silence the import.
//
// The module docblock's line about audit emission being "forward-declared via
// the webhook platform" is corrected with it: this file signs and verifies
// manifests and projects deliveries. It emits nothing.
//
// If recipient-side verification is built (BACKLOG-13-3 in
// docs/architecture/program-ledger.md), the emitter comes back WITH the route
// that needs it, in one piece, rather than waiting here for a caller.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HMAC primitives
// ---------------------------------------------------------------------------

function resolveSecret(secret?: string): string {
  const env = process.env.WEBHOOK_SIGNING_SECRET;
  const resolved = secret ?? env ?? "proovra-exchange-dev-secret";
  // Bounded length to keep the HMAC input deterministic.
  return resolved.slice(0, 256);
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmacFor(
  packageId: string,
  payloadHash: string,
  expiresAtUtc: string,
  secret: string,
): Buffer {
  const h = createHmac("sha256", secret);
  h.update(`${packageId}\n${payloadHash}\n${expiresAtUtc}`);
  return h.digest();
}

// ---------------------------------------------------------------------------
// signPackageManifest
// ---------------------------------------------------------------------------

export type SignPackageManifestInput = {
  packageId: string;
  payloadHash: string;
  ttlSeconds: number;
  secret?: string;
};

export type SignPackageManifestResult = {
  token: string;
  expiresAtUtc: string;
};

export async function signPackageManifest(
  input: SignPackageManifestInput,
): Promise<SignPackageManifestResult> {
  const ttl = Math.max(60, Math.min(input.ttlSeconds, 7 * 24 * 60 * 60));
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const secret = resolveSecret(input.secret);
  const mac = hmacFor(input.packageId, input.payloadHash, expiresAt, secret);
  // Bounded token = base64url(expiresAt | macTag). The packageId is
  // already on the URL path, so it does NOT need to round-trip in the
  // token itself — verification re-derives the MAC from (packageId,
  // payloadHash, expiresAt).
  const composed = Buffer.concat([
    Buffer.from(`${expiresAt}|`, "utf8"),
    mac,
  ]);
  return { token: b64url(composed).slice(0, 400), expiresAtUtc: expiresAt };
}

// ---------------------------------------------------------------------------
// verifySignedManifest
// ---------------------------------------------------------------------------

export type VerifySignedManifestInput = {
  token: string;
  packageId: string;
  payloadHash: string;
  secret?: string;
};

export type VerifySignedManifestResult = {
  ok: boolean;
  reason?:
    | "TOKEN_MALFORMED"
    | "TOKEN_EXPIRED"
    | "SIGNATURE_MISMATCH";
};

export async function verifySignedManifest(
  input: VerifySignedManifestInput,
): Promise<VerifySignedManifestResult> {
  let decoded: Buffer;
  try {
    decoded = b64urlDecode(input.token);
  } catch {
    return { ok: false, reason: "TOKEN_MALFORMED" };
  }
  const sepIdx = decoded.indexOf(0x7c); // '|'
  if (sepIdx <= 0 || sepIdx >= decoded.length - 1) {
    return { ok: false, reason: "TOKEN_MALFORMED" };
  }
  const expiresAtUtc = decoded.slice(0, sepIdx).toString("utf8");
  const macTag = decoded.slice(sepIdx + 1);
  const parsed = Date.parse(expiresAtUtc);
  if (!Number.isFinite(parsed)) {
    return { ok: false, reason: "TOKEN_MALFORMED" };
  }
  if (parsed <= Date.now()) {
    return { ok: false, reason: "TOKEN_EXPIRED" };
  }
  const secret = resolveSecret(input.secret);
  const expected = hmacFor(
    input.packageId,
    input.payloadHash,
    expiresAtUtc,
    secret,
  );
  if (macTag.length !== expected.length) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }
  if (!timingSafeEqual(macTag, expected)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// listDeliveryActivity — read projection used by the Exchange console.
// ---------------------------------------------------------------------------

export type ListDeliveryActivityInput = {
  prisma?: PrismaClient;
  teamId: string;
  packageId?: string;
  limit?: number;
  /** Opaque forward cursor — the `id` of the last row of the previous page. */
  cursorId?: string | null;
};

export type DeliveryActivityRow = {
  id: string;
  packageId: string;
  recipientEmail: string | null;
  recipientOrgSlug: string | null;
  channel: string | null;
  deliveredAtUtc: string;
  downloadedAtUtc: string | null;
  verifiedAtUtc: string | null;
  /**
   * PHASE 12 VERTICAL C — bounded delivery state derived SERVER-SIDE from the
   * recorded timestamps. The console never re-derives it, so "authorized"
   * (a recipient recorded) can never be rendered as "completed".
   *
   * PHASE 13 §4 (2026-08-17) — TWO members, not three. The union carried
   * "VERIFIED", derived from `verifiedAtUtc`, and no code path in this system has
   * ever written that column: recipient-side verification is unbuilt and its
   * only writer was removed above. A state a delivery cannot reach must not be
   * part of the vocabulary the operator console reads, and a type that offers it
   * invites a consumer to render a lifecycle this product does not implement.
   * The COLUMN is retained on the row below — dropping it needs a migration for
   * storage nothing is spending — and BACKLOG-13-3 records what restoring the
   * rung would require.
   */
  state: "RECORDED" | "DOWNLOADED";
};

export type ListDeliveryActivityPage = {
  deliveries: ReadonlyArray<DeliveryActivityRow>;
  nextCursor: string | null;
};

/**
 * PHASE 12 VERTICAL C — the ONE delivery-history read.
 *
 * Deterministic pagination: ordered by `(deliveredAtUtc DESC, id DESC)` so
 * ties never reshuffle between pages, with an id-keyed forward cursor.
 * Tenancy is a DATABASE predicate (`teamId` in the `where`), never an
 * in-memory filter. No provider secret, signing key, signature, header or
 * signed URL is part of the projection — the row model does not carry them
 * and nothing here reads the token store.
 */
export async function listDeliveryActivity(
  input: ListDeliveryActivityInput,
): Promise<ListDeliveryActivityPage> {
  const prisma = input.prisma ?? defaultPrisma;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  const rows = await prisma.evidenceExchangePackageDelivery.findMany({
    where: {
      teamId: input.teamId,
      ...(input.packageId ? { packageId: input.packageId } : {}),
    },
    orderBy: [{ deliveredAtUtc: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(input.cursorId
      ? { cursor: { id: input.cursorId }, skip: 1 }
      : {}),
  });
  const page = rows.slice(0, limit);
  return {
    deliveries: page.map((r) => ({
      id: r.id,
      packageId: r.packageId,
      recipientEmail: r.recipientEmail,
      recipientOrgSlug: r.recipientOrgSlug,
      channel: r.channel,
      deliveredAtUtc: (r.deliveredAtUtc ?? r.deliveredAt).toISOString(),
      downloadedAtUtc: r.downloadedAtUtc?.toISOString() ?? null,
      verifiedAtUtc: r.verifiedAtUtc?.toISOString() ?? null,
      // PHASE 13 §4 (2026-08-17) — two rungs, not three. The `VERIFIED` rung
      // was derived from `verifiedAtUtc`, and no code path in this system has
      // ever written that column: recipient-side verification is unbuilt (see
      // the note where its writer used to live). A state a delivery cannot
      // reach must not be part of the vocabulary the operator console reads.
      state: r.downloadedAtUtc
        ? ("DOWNLOADED" as const)
        : ("RECORDED" as const),
    })),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// PHASE 13 §4 (2026-08-17) — `emitTransferVerificationEvent` was REMOVED here,
// and the `VERIFIED` rung was removed from the ladder above with it.
//
// Its docblock described "a recipient hits the verify endpoint with a signed
// token". There is no verify endpoint. The exchange lifecycle stops at
// DOWNLOADED: the routes are record-delivery, download, revoke, accept-transfer
// and complete-transfer, and none of them is recipient-facing verification. The
// token verifier that such an endpoint would need — `verifySignedManifestToken`
// in this same module — has no caller either, so what existed was not a wiring
// gap in one function but an entire unbuilt half of the module, of which this
// was the writer.
//
// The claim in PHASE_4B_PRODUCT_PACKAGING_AND_LIFECYCLE_FINAL_REPORT.md that
// "every transition is mirrored ... via emitTransferVerificationEvent" was false
// twice over: the transitions it names call `emitTransferCustodyEvents`, a
// different helper, and this one was called by nothing. That line has been
// corrected rather than left to be read as a description of behaviour.
//
// The `verifiedAtUtc` COLUMN stays — dropping it needs a migration for storage
// nothing is spending — but nothing now derives a customer-visible "VERIFIED"
// state from a column no code path can write. A ladder whose top rung is
// unreachable reports a lifecycle this product does not implement.
//
// If recipient-side verification is built, it is one unit of work: the verify
// route, `verifySignedManifestToken`, the `verifiedAtUtc` stamp, the ladder rung
// and the exchange page's rendering of it. Half of it is not worth keeping warm.
// ---------------------------------------------------------------------------

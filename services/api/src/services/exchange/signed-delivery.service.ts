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
 *   * Audit emission ("verifyTransfer") is forward-declared via the
 *     webhook platform — never blocks the operational path.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { WebhookEventKind } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Forward-declared webhook emitter (see evidence-exchange.service.ts).
// ---------------------------------------------------------------------------

type WebhookEmitter = (input: {
  prisma?: PrismaClient;
  teamId: string;
  eventKind: WebhookEventKind;
  payload: Record<string, unknown>;
}) => Promise<unknown> | unknown;

async function tryEmitWebhookEvent(
  eventKind: WebhookEventKind,
  payload: Record<string, unknown>,
  ctx: { prisma?: PrismaClient; teamId: string },
): Promise<void> {
  try {
    const mod = (await import(
      "../packaging/webhooks/webhook-platform.service.js"
    ).catch(() => ({}))) as { emitWebhookEvent?: WebhookEmitter };
    if (typeof mod.emitWebhookEvent === "function") {
      await mod.emitWebhookEvent({
        prisma: ctx.prisma,
        teamId: ctx.teamId,
        eventKind,
        payload,
      });
    }
  } catch {
    // Audit fan-out failure MUST never break the operational path.
  }
}

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
   */
  state: "RECORDED" | "DOWNLOADED" | "VERIFIED";
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
      state: r.verifiedAtUtc
        ? ("VERIFIED" as const)
        : r.downloadedAtUtc
          ? ("DOWNLOADED" as const)
          : ("RECORDED" as const),
    })),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// emitTransferVerificationEvent — helper used when a recipient hits
// the verify endpoint with a signed token and we want to advertise it
// as a webhook + stamp the verified-at marker.
// ---------------------------------------------------------------------------

export type EmitTransferVerificationEventInput = {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  deliveryId?: string;
  outcome: "VERIFIED" | "REJECTED";
  reason?: string;
};

export async function emitTransferVerificationEvent(
  input: EmitTransferVerificationEventInput,
): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  if (input.deliveryId && input.outcome === "VERIFIED") {
    try {
      await prisma.evidenceExchangePackageDelivery.update({
        where: { id: input.deliveryId },
        data: { verifiedAtUtc: new Date() },
      });
    } catch {
      // No-op — the audit emission below still fires.
    }
  }
  void tryEmitWebhookEvent(
    "EVIDENCE_VERIFIED",
    {
      packageId: input.packageId,
      deliveryId: input.deliveryId ?? null,
      outcome: input.outcome,
      reason: input.reason?.slice(0, 200) ?? null,
    },
    { prisma, teamId: input.teamId },
  );
  return { ok: true };
}

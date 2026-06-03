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
import { prisma as defaultPrisma } from "../../db.js";
async function tryEmitWebhookEvent(eventKind, payload, ctx) {
    try {
        const mod = (await import("../packaging/webhooks/webhook-platform.service.js").catch(() => ({})));
        if (typeof mod.emitWebhookEvent === "function") {
            await mod.emitWebhookEvent({
                prisma: ctx.prisma,
                teamId: ctx.teamId,
                eventKind,
                payload,
            });
        }
    }
    catch {
        // Audit fan-out failure MUST never break the operational path.
    }
}
// ---------------------------------------------------------------------------
// HMAC primitives
// ---------------------------------------------------------------------------
function resolveSecret(secret) {
    const env = process.env.WEBHOOK_SIGNING_SECRET;
    const resolved = secret ?? env ?? "proovra-exchange-dev-secret";
    // Bounded length to keep the HMAC input deterministic.
    return resolved.slice(0, 256);
}
function b64url(buf) {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
function b64urlDecode(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
function hmacFor(packageId, payloadHash, expiresAtUtc, secret) {
    const h = createHmac("sha256", secret);
    h.update(`${packageId}\n${payloadHash}\n${expiresAtUtc}`);
    return h.digest();
}
export async function signPackageManifest(input) {
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
export async function verifySignedManifest(input) {
    let decoded;
    try {
        decoded = b64urlDecode(input.token);
    }
    catch {
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
    const expected = hmacFor(input.packageId, input.payloadHash, expiresAtUtc, secret);
    if (macTag.length !== expected.length) {
        return { ok: false, reason: "SIGNATURE_MISMATCH" };
    }
    if (!timingSafeEqual(macTag, expected)) {
        return { ok: false, reason: "SIGNATURE_MISMATCH" };
    }
    return { ok: true };
}
export async function listDeliveryActivity(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const limit = Math.min(input.limit ?? 200, 1000);
    const rows = await prisma.evidenceExchangePackageDelivery.findMany({
        where: {
            teamId: input.teamId,
            ...(input.packageId ? { packageId: input.packageId } : {}),
        },
        orderBy: { deliveredAtUtc: "desc" },
        take: limit,
    });
    return rows.map((r) => ({
        id: r.id,
        packageId: r.packageId,
        recipientEmail: r.recipientEmail,
        recipientOrgSlug: r.recipientOrgSlug,
        channel: r.channel,
        deliveredAtUtc: (r.deliveredAtUtc ?? r.deliveredAt).toISOString(),
        downloadedAtUtc: r.downloadedAtUtc?.toISOString() ?? null,
        verifiedAtUtc: r.verifiedAtUtc?.toISOString() ?? null,
    }));
}
export async function emitTransferVerificationEvent(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (input.deliveryId && input.outcome === "VERIFIED") {
        try {
            await prisma.evidenceExchangePackageDelivery.update({
                where: { id: input.deliveryId },
                data: { verifiedAtUtc: new Date() },
            });
        }
        catch {
            // No-op — the audit emission below still fires.
        }
    }
    void tryEmitWebhookEvent("EVIDENCE_VERIFIED", {
        packageId: input.packageId,
        deliveryId: input.deliveryId ?? null,
        outcome: input.outcome,
        reason: input.reason?.slice(0, 200) ?? null,
    }, { prisma, teamId: input.teamId });
    return { ok: true };
}

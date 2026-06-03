/**
 * PROOVRA Phase 4B — Webhook Platform Service.
 *
 * Outbound webhook lifecycle for the Phase 4B lifecycle product line:
 *   * Endpoint CRUD (create / deactivate / list).
 *   * Event emission (one canonical-JSON payload, HMAC-SHA256 signed
 *     per endpoint, one row per (endpoint, event) inserted PENDING).
 *   * Single-attempt delivery worker entry point with bounded
 *     exponential backoff (cap 1h) and dead-letter after 8 attempts.
 *   * Static verification helper for downstream consumers.
 *
 * Hard rules:
 *   * Workspace-anchored. Every read/write filters teamId.
 *   * Bounded vocabularies — eventKind MUST be in WEBHOOK_EVENT_KINDS.
 *   * HTTPS-only endpoint URLs (length-bounded).
 *   * Secrets are 32 random bytes (base64). Raw secret returned ONLY
 *     at endpoint creation; never read back.
 *   * No PII in error logs / response previews. Response bodies are
 *     truncated to 400 chars (matches schema column width).
 *   * Delivery is at-least-once with bounded retries
 *     (PRODUCT_AND_LIFECYCLE_LIMITATIONS standing limitation).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_EVENT_KINDS, canonicalJson, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../../db.js";
// -----------------------------------------------------------------------------
// Bounded constants — keep all magic numbers here.
// -----------------------------------------------------------------------------
const URL_MAX_LENGTH = 1024;
const SECRET_RANDOM_BYTES = 32;
const RESPONSE_PREVIEW_MAX_CHARS = 400;
const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 8;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 60 * 60; // 1h
const SUBSCRIBED_EVENTS_MAX = 64;
const SIGNATURE_HEX_LENGTH = 64; // sha256 hex
const VALID_EVENT_KINDS = new Set(WEBHOOK_EVENT_KINDS);
// -----------------------------------------------------------------------------
// Helpers — pure, deterministic, NO PII.
// -----------------------------------------------------------------------------
function isValidEventKind(s) {
    return VALID_EVENT_KINDS.has(s);
}
function isValidHttpsUrl(raw) {
    if (typeof raw !== "string")
        return false;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > URL_MAX_LENGTH)
        return false;
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return false;
    }
    return parsed.protocol === "https:";
}
function truncatePreview(s) {
    if (s.length <= RESPONSE_PREVIEW_MAX_CHARS)
        return s;
    return s.slice(0, RESPONSE_PREVIEW_MAX_CHARS);
}
function computeBackoffSeconds(attemptCount) {
    const exp = Math.min(attemptCount, 16);
    const raw = Math.pow(2, exp) * BACKOFF_BASE_SECONDS;
    return Math.min(raw, BACKOFF_CAP_SECONDS);
}
function signPayload(secretBase64, canonicalPayload) {
    const key = Buffer.from(secretBase64, "base64");
    return createHmac("sha256", key).update(canonicalPayload, "utf8").digest("hex");
}
export async function createWebhookEndpoint(input) {
    if (!isValidHttpsUrl(input.url)) {
        throw new Error("webhook_endpoint_invalid_url");
    }
    if (!Array.isArray(input.subscribedEvents) ||
        input.subscribedEvents.length === 0 ||
        input.subscribedEvents.length > SUBSCRIBED_EVENTS_MAX) {
        throw new Error("webhook_endpoint_invalid_subscribed_events");
    }
    for (const ev of input.subscribedEvents) {
        if (!isValidEventKind(ev)) {
            throw new Error("webhook_endpoint_unknown_event_kind");
        }
    }
    const prisma = input.prisma ?? defaultPrisma;
    const secret = randomBytes(SECRET_RANDOM_BYTES).toString("base64");
    const row = await prisma.lifecycleWebhookEndpoint.create({
        data: {
            teamId: input.teamId,
            url: input.url.trim(),
            secret,
            subscribedEvents: Array.from(input.subscribedEvents),
            state: "ACTIVE",
            createdByUserId: input.createdByUserId,
        },
        select: { id: true },
    });
    return { ok: true, endpointId: row.id, secret };
}
export async function deactivateWebhookEndpoint(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const existing = await prisma.lifecycleWebhookEndpoint.findFirst({
        where: { id: input.endpointId, teamId: input.teamId },
        select: { id: true, state: true },
    });
    if (!existing)
        return { ok: false };
    if (existing.state === "DEACTIVATED")
        return { ok: true };
    await prisma.lifecycleWebhookEndpoint.update({
        where: { id: existing.id },
        data: { state: "DEACTIVATED", deactivatedAtUtc: new Date() },
    });
    return { ok: true };
}
export async function listWebhookEndpoints(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.lifecycleWebhookEndpoint.findMany({
        where: {
            teamId: input.teamId,
            ...(input.state ? { state: input.state } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    return rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        url: r.url,
        subscribedEvents: normalizeSubscribedEvents(r.subscribedEvents),
        state: r.state,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt.toISOString(),
        deactivatedAtUtc: r.deactivatedAtUtc?.toISOString() ?? null,
    }));
}
function normalizeSubscribedEvents(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const v of raw) {
        if (typeof v === "string" && isValidEventKind(v))
            out.push(v);
    }
    return out;
}
export async function emitWebhookEvent(input) {
    if (!isValidEventKind(input.eventKind)) {
        throw new Error("webhook_event_invalid_kind");
    }
    const prisma = input.prisma ?? defaultPrisma;
    const endpoints = await prisma.lifecycleWebhookEndpoint.findMany({
        where: { teamId: input.teamId, state: "ACTIVE" },
        select: {
            id: true,
            secret: true,
            subscribedEvents: true,
        },
    });
    if (endpoints.length === 0)
        return { deliveryIds: [] };
    const canonical = canonicalJson(input.payload);
    const deliveryIds = [];
    for (const ep of endpoints) {
        const subs = normalizeSubscribedEvents(ep.subscribedEvents);
        if (!subs.includes(input.eventKind))
            continue;
        const signature = signPayload(ep.secret, canonical);
        const row = await prisma.lifecycleWebhookDelivery
            .create({
            data: {
                teamId: input.teamId,
                endpointId: ep.id,
                eventKind: input.eventKind,
                payload: input.payload,
                signature,
                state: "PENDING",
                attemptCount: 0,
            },
            select: { id: true },
        })
            .catch(() => null);
        if (row)
            deliveryIds.push(row.id);
    }
    return { deliveryIds };
}
export async function deliverWebhookDelivery(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const delivery = await prisma.lifecycleWebhookDelivery.findUnique({
        where: { id: input.deliveryId },
        include: {
            endpoint: {
                select: { id: true, url: true, state: true },
            },
        },
    });
    if (!delivery)
        return { ok: false };
    if (delivery.state === "DELIVERED" || delivery.state === "DEAD_LETTERED") {
        return { ok: delivery.state === "DELIVERED" };
    }
    if (!delivery.endpoint || delivery.endpoint.state !== "ACTIVE") {
        await prisma.lifecycleWebhookDelivery
            .update({
            where: { id: delivery.id },
            data: { state: "FAILED", lastAttemptAtUtc: new Date() },
        })
            .catch(() => null);
        return { ok: false };
    }
    const nextAttemptCount = delivery.attemptCount + 1;
    const eventKind = delivery.eventKind;
    const signature = delivery.signature;
    const canonical = canonicalJson(delivery.payload);
    let responseStatus = null;
    let responseBodyPreview = null;
    let networkError = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
        const res = await fetch(delivery.endpoint.url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-proovra-event": eventKind,
                "x-proovra-signature": signature,
                "x-proovra-delivery": delivery.id,
            },
            body: canonical,
            signal: controller.signal,
        });
        responseStatus = res.status;
        try {
            const text = await res.text();
            responseBodyPreview = truncatePreview(text);
        }
        catch {
            responseBodyPreview = null;
        }
    }
    catch {
        networkError = true;
    }
    finally {
        clearTimeout(timer);
    }
    const now = new Date();
    const baseUpdate = {
        attemptCount: nextAttemptCount,
        lastAttemptAtUtc: now,
        responseStatus,
        responseBodyPreview,
    };
    const success = !networkError &&
        responseStatus !== null &&
        responseStatus >= 200 &&
        responseStatus < 300;
    const isRetryable = networkError ||
        responseStatus === 429 ||
        (responseStatus !== null && responseStatus >= 500);
    const isHardFailure = !success &&
        !isRetryable &&
        responseStatus !== null &&
        responseStatus >= 400 &&
        responseStatus < 500;
    if (success) {
        await prisma.lifecycleWebhookDelivery
            .update({
            where: { id: delivery.id },
            data: {
                ...baseUpdate,
                state: "DELIVERED",
                deliveredAtUtc: now,
            },
        })
            .catch(() => null);
        return { ok: true };
    }
    if (isHardFailure) {
        await prisma.lifecycleWebhookDelivery
            .update({
            where: { id: delivery.id },
            data: { ...baseUpdate, state: "FAILED" },
        })
            .catch(() => null);
        return { ok: false };
    }
    // Retryable path (5xx / 429 / network).
    if (nextAttemptCount >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER) {
        await prisma.lifecycleWebhookDelivery
            .update({
            where: { id: delivery.id },
            data: {
                ...baseUpdate,
                state: "DEAD_LETTERED",
                deadLetteredAtUtc: now,
            },
        })
            .catch(() => null);
        // Bounded audit signal — no PII, only ids.
        // eslint-disable-next-line no-console
        console.warn(`webhook_dead_lettered:${delivery.id}`);
        return { ok: false };
    }
    const nextRetryAtUtc = new Date(now.getTime() + computeBackoffSeconds(nextAttemptCount) * 1000);
    await prisma.lifecycleWebhookDelivery
        .update({
        where: { id: delivery.id },
        data: { ...baseUpdate, state: "RETRYING" },
    })
        .catch(() => null);
    return { ok: false, nextRetryAtUtc };
}
export async function getDeliveryAudit(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const row = await prisma.lifecycleWebhookDelivery.findFirst({
        where: { id: input.deliveryId, teamId: input.teamId },
        select: {
            id: true,
            teamId: true,
            endpointId: true,
            eventKind: true,
            state: true,
            attemptCount: true,
            signature: true,
            responseStatus: true,
            responseBodyPreview: true,
            enqueuedAtUtc: true,
            lastAttemptAtUtc: true,
            deliveredAtUtc: true,
            deadLetteredAtUtc: true,
        },
    });
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.teamId,
        endpointId: row.endpointId,
        eventKind: row.eventKind,
        state: row.state,
        attemptCount: row.attemptCount,
        signature: row.signature,
        responseStatus: row.responseStatus,
        responseBodyPreview: row.responseBodyPreview,
        enqueuedAtUtc: row.enqueuedAtUtc.toISOString(),
        lastAttemptAtUtc: row.lastAttemptAtUtc?.toISOString() ?? null,
        deliveredAtUtc: row.deliveredAtUtc?.toISOString() ?? null,
        deadLetteredAtUtc: row.deadLetteredAtUtc?.toISOString() ?? null,
    };
}
// -----------------------------------------------------------------------------
// Public API — verifyIncomingSignature (downstream consumer helper)
// -----------------------------------------------------------------------------
export function verifyIncomingSignature(input) {
    if (typeof input.rawBody !== "string" ||
        typeof input.signature !== "string" ||
        typeof input.secret !== "string") {
        return false;
    }
    if (input.signature.length !== SIGNATURE_HEX_LENGTH)
        return false;
    let expectedBuf;
    let providedBuf;
    try {
        expectedBuf = Buffer.from(signPayload(input.secret, input.rawBody), "hex");
        providedBuf = Buffer.from(input.signature, "hex");
    }
    catch {
        return false;
    }
    if (expectedBuf.length !== providedBuf.length)
        return false;
    try {
        return timingSafeEqual(expectedBuf, providedBuf);
    }
    catch {
        return false;
    }
}

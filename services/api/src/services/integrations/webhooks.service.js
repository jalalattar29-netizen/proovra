/**
 * Phase 10 — Webhook endpoint service.
 *
 * Manages outbound webhook endpoints (CRUD), generates per-endpoint
 * HMAC signing secrets, and signs payloads on dispatch. Mirrors the
 * api-credentials service in shape: raw secrets are never stored, the
 * raw value is shown once on creation, only the hash is persisted.
 *
 * Signing scheme (canonical, see @proovra/shared/integrations.ts):
 *   - HMAC-SHA256 keyed by the endpoint's raw secret
 *   - signed value = `${timestampMs}.${requestBody}`
 *   - header: X-Proovra-Signature: v1=<hex>
 *
 * Feature flag: `INTEGRATIONS_ENABLED=true`.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, } from "node:crypto";
import { Prisma } from "@prisma/client";
import { WEBHOOK_EVENT_TYPES, WebhookEventTypeSchema, buildWebhookSignatureBase, validateWebhookUrl, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { integrationsFeatureDisabledReason, isIntegrationsFeatureEnabled, } from "./api-keys.service.js";
const WEBHOOK_SECRET_ENV = "API_KEY_SECRET";
const WEBHOOK_SECRET_RANDOM_BYTES = 32;
const WEBHOOK_SECRET_PREFIX = "pwhsec";
const WEBHOOK_SECRET_VERSION = 1;
const ALLOW_PRIVATE_NETWORKS_ENV = "WEBHOOK_ALLOW_PRIVATE_NETWORKS";
export function webhookAllowPrivateNetworks() {
    return process.env[ALLOW_PRIVATE_NETWORKS_ENV] === "true";
}
function readWebhookHmacKey() {
    const raw = process.env[WEBHOOK_SECRET_ENV];
    if (!raw || raw.trim().length < 32)
        return null;
    if (/^[a-fA-F0-9]+$/.test(raw) && raw.length % 2 === 0) {
        return Buffer.from(raw, "hex");
    }
    return Buffer.from(raw, "utf8");
}
/**
 * Derive a fixed 32-byte AES key from API_KEY_SECRET via SHA-256.
 * Distinct from the HMAC use of API_KEY_SECRET so the two domains
 * don't share key material exactly.
 */
function deriveWebhookWrapKey() {
    const base = readWebhookHmacKey();
    if (!base)
        return null;
    return createHash("sha256")
        .update("proovra-webhook-secret-wrap-v1", "utf8")
        .update(base)
        .digest();
}
function encryptRawWebhookSecret(rawSecret) {
    const key = deriveWebhookWrapKey();
    if (!key)
        return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([
        cipher.update(rawSecret, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]).toString("base64");
}
/**
 * Decrypt the stored ciphertext back to the raw signing secret.
 * Returns null if API_KEY_SECRET is missing or the ciphertext is
 * malformed / authentication fails.
 */
export function decryptWebhookSecret(ciphertext) {
    const key = deriveWebhookWrapKey();
    if (!key)
        return null;
    let buf;
    try {
        buf = Buffer.from(ciphertext, "base64");
    }
    catch {
        return null;
    }
    if (buf.length < 12 + 16 + 1)
        return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString("utf8");
    }
    catch {
        return null;
    }
}
function base64url(buf) {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
/**
 * Issue a fresh signing secret. The raw secret is encrypted with the
 * server-side wrap key (AES-256-GCM) for storage and ALSO returned to
 * the caller exactly once so it can be shown to the operator.
 */
export function issueWebhookSecret() {
    const body = base64url(randomBytes(WEBHOOK_SECRET_RANDOM_BYTES));
    const rawSecret = `${WEBHOOK_SECRET_PREFIX}_v${WEBHOOK_SECRET_VERSION}_${body}`;
    const ciphertext = encryptRawWebhookSecret(rawSecret);
    if (!ciphertext)
        return null;
    const secretPrefix = `${WEBHOOK_SECRET_PREFIX}_v${WEBHOOK_SECRET_VERSION}_${body.slice(0, 8)}`;
    return { rawSecret, secretCiphertext: ciphertext, secretPrefix };
}
/**
 * Sign a webhook payload with a raw endpoint secret. Returns the
 * value to place in the `X-Proovra-Signature` header (with the `v1=`
 * prefix).
 */
export function signWebhookPayload(rawSecret, timestampMs, rawBody) {
    const base = buildWebhookSignatureBase(timestampMs, rawBody);
    const sig = createHmac("sha256", rawSecret).update(base, "utf8").digest("hex");
    return `v1=${sig}`;
}
// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------
export class WebhookEndpointError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "WebhookEndpointError";
    }
}
// -----------------------------------------------------------------------------
// Event-type validation
// -----------------------------------------------------------------------------
const EVENT_TYPE_SET = new Set(WEBHOOK_EVENT_TYPES);
export function isValidWebhookEventType(s) {
    return EVENT_TYPE_SET.has(s);
}
export function filterValidEventTypes(raw) {
    const out = [];
    for (const s of raw) {
        const p = WebhookEventTypeSchema.safeParse(s);
        if (p.success)
            out.push(p.data);
    }
    return out;
}
export async function createWebhookEndpoint(input, client = defaultPrisma) {
    if (integrationsFeatureDisabledReason()) {
        throw new WebhookEndpointError("feature_disabled");
    }
    const urlCheck = validateWebhookUrl(input.url, {
        allowPrivateNetworks: webhookAllowPrivateNetworks(),
    });
    if (!urlCheck.ok) {
        throw new WebhookEndpointError("invalid_url", { reason: urlCheck.reason });
    }
    // Empty array is permitted and means "all events". Anything non-empty
    // must be a subset of the canonical catalog.
    let eventTypes = [];
    if (input.eventTypes.length > 0) {
        eventTypes = filterValidEventTypes(input.eventTypes);
        if (eventTypes.length !== input.eventTypes.length) {
            throw new WebhookEndpointError("invalid_event_types", {
                provided: input.eventTypes,
            });
        }
    }
    const issued = issueWebhookSecret();
    if (!issued)
        throw new WebhookEndpointError("secret_missing");
    const endpoint = await client.webhookEndpoint.create({
        data: {
            teamId: input.teamId,
            url: urlCheck.normalized,
            description: input.description?.slice(0, 400) ?? null,
            status: "ACTIVE",
            secretCiphertext: issued.secretCiphertext,
            secretPrefix: issued.secretPrefix,
            eventTypes,
            createdByUserId: input.actorUserId,
        },
    });
    return { endpoint, rawSecret: issued.rawSecret };
}
export async function listWebhookEndpoints(input, client = defaultPrisma) {
    return client.webhookEndpoint.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
export async function getWebhookEndpoint(input, client = defaultPrisma) {
    return client.webhookEndpoint.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
}
export async function updateWebhookEndpoint(input, client = defaultPrisma) {
    const existing = await getWebhookEndpoint({ id: input.id, teamId: input.teamId }, client);
    if (!existing)
        throw new WebhookEndpointError("endpoint_not_found");
    let eventTypes;
    if (input.eventTypes !== undefined) {
        if (input.eventTypes.length === 0) {
            eventTypes = [];
        }
        else {
            const filtered = filterValidEventTypes(input.eventTypes);
            if (filtered.length !== input.eventTypes.length) {
                throw new WebhookEndpointError("invalid_event_types", {
                    provided: input.eventTypes,
                });
            }
            eventTypes = filtered;
        }
    }
    return client.webhookEndpoint.update({
        where: { id: existing.id },
        data: {
            ...(input.description !== undefined
                ? { description: input.description?.slice(0, 400) ?? null }
                : {}),
            ...(eventTypes !== undefined ? { eventTypes } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
        },
    });
}
export async function rotateWebhookSecret(input, client = defaultPrisma) {
    if (integrationsFeatureDisabledReason()) {
        throw new WebhookEndpointError("feature_disabled");
    }
    const existing = await getWebhookEndpoint({ id: input.id, teamId: input.teamId }, client);
    if (!existing)
        throw new WebhookEndpointError("endpoint_not_found");
    const issued = issueWebhookSecret();
    if (!issued)
        throw new WebhookEndpointError("secret_missing");
    const endpoint = await client.webhookEndpoint.update({
        where: { id: existing.id },
        data: {
            secretCiphertext: issued.secretCiphertext,
            secretPrefix: issued.secretPrefix,
        },
    });
    return { endpoint, rawSecret: issued.rawSecret };
}
export async function disableWebhookEndpoint(input, client = defaultPrisma) {
    const existing = await getWebhookEndpoint({ id: input.id, teamId: input.teamId }, client);
    if (!existing)
        throw new WebhookEndpointError("endpoint_not_found");
    if (existing.status === "DISABLED")
        return existing;
    return client.webhookEndpoint.update({
        where: { id: existing.id },
        data: { status: "DISABLED" },
    });
}
// -----------------------------------------------------------------------------
// Operational counters — called by the dispatcher / retry processor on
// success / failure. Failures bump a counter; the retry processor uses
// the counter to determine when to auto-disable a bad endpoint.
// -----------------------------------------------------------------------------
export const ENDPOINT_AUTO_DISABLE_FAILURE_THRESHOLD = 20;
export async function recordWebhookEndpointSuccess(id, client = defaultPrisma) {
    await client.webhookEndpoint
        .update({
        where: { id },
        data: {
            failureCount: 0,
            lastSuccessAtUtc: new Date(),
        },
    })
        .catch(() => null);
}
export async function recordWebhookEndpointFailure(id, client = defaultPrisma) {
    try {
        const updated = await client.webhookEndpoint.update({
            where: { id },
            data: {
                failureCount: { increment: 1 },
                lastFailureAtUtc: new Date(),
            },
        });
        if (updated.status === "ACTIVE" &&
            updated.failureCount >= ENDPOINT_AUTO_DISABLE_FAILURE_THRESHOLD) {
            await client.webhookEndpoint
                .update({
                where: { id },
                data: { status: "DISABLED" },
            })
                .catch(() => null);
            return { autoDisabled: true };
        }
        return { autoDisabled: false };
    }
    catch {
        return { autoDisabled: false };
    }
}
// -----------------------------------------------------------------------------
// Safe projection — never returns secretHash or the raw secret.
// -----------------------------------------------------------------------------
export function projectWebhookEndpoint(e) {
    return {
        id: e.id,
        teamId: e.teamId,
        url: e.url,
        description: e.description,
        status: e.status,
        secretPrefix: e.secretPrefix,
        eventTypes: e.eventTypes,
        failureCount: e.failureCount,
        lastSuccessAtUtc: e.lastSuccessAtUtc?.toISOString() ?? null,
        lastFailureAtUtc: e.lastFailureAtUtc?.toISOString() ?? null,
        createdByUserId: e.createdByUserId,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
        // Deliberately NOT returned: secretCiphertext (and never the raw secret).
    };
}
void Prisma;
void isIntegrationsFeatureEnabled;

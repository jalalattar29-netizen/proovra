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

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  WebhookEndpoint as DbWebhookEndpoint,
} from "@prisma/client";
import {
  WEBHOOK_EVENT_TYPES,
  WebhookEventType,
  WebhookEventTypeSchema,
  buildWebhookSignatureBase,
  validateWebhookUrl,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  integrationsFeatureDisabledReason,
  isIntegrationsFeatureEnabled,
} from "./api-keys.service.js";

const WEBHOOK_SECRET_ENV = "API_KEY_SECRET";
const WEBHOOK_SECRET_RANDOM_BYTES = 32;
const WEBHOOK_SECRET_PREFIX = "pwhsec";
const WEBHOOK_SECRET_VERSION = 1;

const ALLOW_PRIVATE_NETWORKS_ENV = "WEBHOOK_ALLOW_PRIVATE_NETWORKS";

export function webhookAllowPrivateNetworks(): boolean {
  return process.env[ALLOW_PRIVATE_NETWORKS_ENV] === "true";
}

function readWebhookHmacKey(): Buffer | null {
  const raw = process.env[WEBHOOK_SECRET_ENV];
  if (!raw || raw.trim().length < 32) return null;
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
function deriveWebhookWrapKey(): Buffer | null {
  const base = readWebhookHmacKey();
  if (!base) return null;
  return createHash("sha256")
    .update("proovra-webhook-secret-wrap-v1", "utf8")
    .update(base)
    .digest();
}

function encryptRawWebhookSecret(rawSecret: string): string | null {
  const key = deriveWebhookWrapKey();
  if (!key) return null;
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
export function decryptWebhookSecret(ciphertext: string): string | null {
  const key = deriveWebhookWrapKey();
  if (!key) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(ciphertext, "base64");
  } catch {
    return null;
  }
  if (buf.length < 12 + 16 + 1) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// -----------------------------------------------------------------------------
// Secret issuance / signing
// -----------------------------------------------------------------------------

export type IssuedWebhookSecret = {
  rawSecret: string;
  secretCiphertext: string;
  secretPrefix: string;
};

/**
 * Issue a fresh signing secret. The raw secret is encrypted with the
 * server-side wrap key (AES-256-GCM) for storage and ALSO returned to
 * the caller exactly once so it can be shown to the operator.
 */
export function issueWebhookSecret(): IssuedWebhookSecret | null {
  const body = base64url(randomBytes(WEBHOOK_SECRET_RANDOM_BYTES));
  const rawSecret = `${WEBHOOK_SECRET_PREFIX}_v${WEBHOOK_SECRET_VERSION}_${body}`;
  const ciphertext = encryptRawWebhookSecret(rawSecret);
  if (!ciphertext) return null;
  const secretPrefix = `${WEBHOOK_SECRET_PREFIX}_v${WEBHOOK_SECRET_VERSION}_${body.slice(0, 8)}`;
  return { rawSecret, secretCiphertext: ciphertext, secretPrefix };
}

/**
 * Sign a webhook payload with a raw endpoint secret. Returns the
 * value to place in the `X-Proovra-Signature` header (with the `v1=`
 * prefix).
 */
export function signWebhookPayload(
  rawSecret: string,
  timestampMs: number,
  rawBody: string,
): string {
  const base = buildWebhookSignatureBase(timestampMs, rawBody);
  const sig = createHmac("sha256", rawSecret).update(base, "utf8").digest("hex");
  return `v1=${sig}`;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class WebhookEndpointError extends Error {
  constructor(
    public readonly code:
      | "feature_disabled"
      | "secret_missing"
      | "invalid_url"
      | "invalid_event_types"
      | "endpoint_not_found"
      | "endpoint_already_disabled",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "WebhookEndpointError";
  }
}

// -----------------------------------------------------------------------------
// Event-type validation
// -----------------------------------------------------------------------------

const EVENT_TYPE_SET = new Set<string>(WEBHOOK_EVENT_TYPES);

export function isValidWebhookEventType(s: string): s is WebhookEventType {
  return EVENT_TYPE_SET.has(s);
}

export function filterValidEventTypes(
  raw: ReadonlyArray<string>,
): WebhookEventType[] {
  const out: WebhookEventType[] = [];
  for (const s of raw) {
    const p = WebhookEventTypeSchema.safeParse(s);
    if (p.success) out.push(p.data);
  }
  return out;
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

export type CreateWebhookEndpointInput = {
  teamId: string;
  url: string;
  description?: string | null;
  eventTypes: ReadonlyArray<string>;
  actorUserId: string;
};

export type CreateWebhookEndpointResult = {
  endpoint: DbWebhookEndpoint;
  rawSecret: string;
};

export async function createWebhookEndpoint(
  input: CreateWebhookEndpointInput,
  client: PrismaClient = defaultPrisma,
): Promise<CreateWebhookEndpointResult> {
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
  let eventTypes: WebhookEventType[] = [];
  if (input.eventTypes.length > 0) {
    eventTypes = filterValidEventTypes(input.eventTypes);
    if (eventTypes.length !== input.eventTypes.length) {
      throw new WebhookEndpointError("invalid_event_types", {
        provided: input.eventTypes,
      });
    }
  }

  const issued = issueWebhookSecret();
  if (!issued) throw new WebhookEndpointError("secret_missing");

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

export async function listWebhookEndpoints(
  input: { teamId: string; status?: "ACTIVE" | "DISABLED"; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<DbWebhookEndpoint[]> {
  return client.webhookEndpoint.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

export async function getWebhookEndpoint(
  input: { id: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbWebhookEndpoint | null> {
  return client.webhookEndpoint.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
}

export type UpdateWebhookEndpointInput = {
  id: string;
  teamId: string;
  description?: string | null;
  eventTypes?: ReadonlyArray<string>;
  status?: "ACTIVE" | "DISABLED";
};

export async function updateWebhookEndpoint(
  input: UpdateWebhookEndpointInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWebhookEndpoint> {
  const existing = await getWebhookEndpoint(
    { id: input.id, teamId: input.teamId },
    client,
  );
  if (!existing) throw new WebhookEndpointError("endpoint_not_found");

  let eventTypes: WebhookEventType[] | undefined;
  if (input.eventTypes !== undefined) {
    if (input.eventTypes.length === 0) {
      eventTypes = [];
    } else {
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

export async function rotateWebhookSecret(
  input: { id: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ endpoint: DbWebhookEndpoint; rawSecret: string }> {
  if (integrationsFeatureDisabledReason()) {
    throw new WebhookEndpointError("feature_disabled");
  }
  const existing = await getWebhookEndpoint(
    { id: input.id, teamId: input.teamId },
    client,
  );
  if (!existing) throw new WebhookEndpointError("endpoint_not_found");

  const issued = issueWebhookSecret();
  if (!issued) throw new WebhookEndpointError("secret_missing");

  const endpoint = await client.webhookEndpoint.update({
    where: { id: existing.id },
    data: {
      secretCiphertext: issued.secretCiphertext,
      secretPrefix: issued.secretPrefix,
    },
  });
  return { endpoint, rawSecret: issued.rawSecret };
}

export async function disableWebhookEndpoint(
  input: { id: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbWebhookEndpoint> {
  const existing = await getWebhookEndpoint(
    { id: input.id, teamId: input.teamId },
    client,
  );
  if (!existing) throw new WebhookEndpointError("endpoint_not_found");
  if (existing.status === "DISABLED") return existing;

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

export async function recordWebhookEndpointSuccess(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
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

export async function recordWebhookEndpointFailure(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ autoDisabled: boolean }> {
  try {
    const updated = await client.webhookEndpoint.update({
      where: { id },
      data: {
        failureCount: { increment: 1 },
        lastFailureAtUtc: new Date(),
      },
    });
    if (
      updated.status === "ACTIVE" &&
      updated.failureCount >= ENDPOINT_AUTO_DISABLE_FAILURE_THRESHOLD
    ) {
      await client.webhookEndpoint
        .update({
          where: { id },
          data: { status: "DISABLED" },
        })
        .catch(() => null);
      return { autoDisabled: true };
    }
    return { autoDisabled: false };
  } catch {
    return { autoDisabled: false };
  }
}

// -----------------------------------------------------------------------------
// Safe projection — never returns secretHash or the raw secret.
// -----------------------------------------------------------------------------

export function projectWebhookEndpoint(e: DbWebhookEndpoint): {
  id: string;
  teamId: string;
  url: string;
  description: string | null;
  status: string;
  secretPrefix: string;
  eventTypes: string[];
  failureCount: number;
  lastSuccessAtUtc: string | null;
  lastFailureAtUtc: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
} {
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

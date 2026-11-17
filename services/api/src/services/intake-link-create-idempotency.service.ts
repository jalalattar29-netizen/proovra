/**
 * B3B-F-102 (free-audit 0ea0) — IDEMPOTENT INTAKE-LINK CREATE, ON AN EXISTING
 * DURABLE RECORD.
 *
 * `POST /v1/workflow/intake-links` accepted an `idempotencyKey`, but only the
 * delivery dispatcher read it, hashed with the NEW link's id — so a retried
 * create (lost response, double submit, a client retry) minted a second link
 * and sent a second message.
 *
 * WHERE THE KEY LIVES (no schema change). The create already writes ONE
 * tenant-audit row, `intake.link.created`, naming the link it made. A keyed
 * create now writes that row INSIDE the same transaction as the link, carrying
 * two digests in its metadata:
 *
 *   createIdempotencyHash   sha256(team, actor, key)   — the scope + key
 *   createRequestHash       sha256(canonical payload)  — what was asked for
 *
 * so the link and its receipt commit or roll back together. A retry finds the
 * receipt by (workspace, actor, action, hash) inside a 24-hour window.
 *
 * CONCURRENCY. Lookup and create run under `pg_advisory_xact_lock` on the
 * scope hash, so two simultaneous requests with one key serialise in the
 * database (not in Redis, so a store outage cannot let both through): the
 * second sees the first one's committed receipt and replays it.
 *
 * WHAT A REPLAY RETURNS. The original link's CURRENT projection and its
 * delivery outcome — never the raw token, which is not stored and is shown
 * exactly once (`rawToken: null`, `tokenRevealed: false`). A replay never
 * sends: it does not hold the token a send needs, so a retry cannot be a
 * second provider call by construction.
 *
 * NOT IN SCOPE. A create without a key is unchanged. The raw key is never
 * stored, only its scoped digest.
 */

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { emitTenantAudit } from "./audit/tenant-audit.service.js";

export const INTAKE_LINK_CREATED_AUDIT_ACTION = "intake.link.created";
/** A key answers its first request for this long; afterwards it is a new request. */
export const INTAKE_CREATE_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Both clients compute `expiresAtUtc` as "now + N hours" at submit time, so a
 * retry carries a later expiry by about the time since the first attempt.
 * That drift (plus this slack for clock and latency) is the same request; any
 * other difference in expiry is a different one.
 */
export const INTAKE_CREATE_EXPIRY_SLACK_MS = 5 * 60 * 1000;

/** Fields that do not change what is created: the key itself, the scope, the retired URL base, the drifting expiry. */
const NON_FINGERPRINT_FIELDS = new Set(["idempotencyKey", "teamId", "intakeUrlBase", "expiresAtUtc"]);

export type KeyedIntakeCreateScope = {
  teamId: string;
  actorUserId: string;
  keyHash: string;
  requestHash: string;
};

export type PriorKeyedIntakeCreate = {
  linkId: string;
  requestHash: string | null;
  deliveryMethod: "MANUAL" | "EMAIL" | "SMS";
};

export type KeyedIntakeCreateDecision =
  | { kind: "replay"; prior: PriorKeyedIntakeCreate }
  | { kind: "conflict"; prior: PriorKeyedIntakeCreate };

function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      // Absent and null are one value: a field omitted on one attempt and sent
      // as null on the next is the same request.
      if (v === undefined || v === null) continue;
      out[k] = canonical(v);
    }
    return out;
  }
  // A size limit arrives as a number or a digit string — one value either way.
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return value;
}

/** sha256 over the payload fields that decide what is created. */
export function intakeCreateRequestHash(payload: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (NON_FINGERPRINT_FIELDS.has(k)) continue;
    subset[k] = k === "maxBytesPerSession" && v !== null && v !== undefined ? String(v) : v;
  }
  return createHash("sha256").update(JSON.stringify(canonical(subset))).digest("hex");
}

/** sha256 over (workspace, actor, key): another actor's or workspace's identical key is a different request. */
export function intakeCreateKeyHash(input: { teamId: string; actorUserId: string; idempotencyKey: string }): string {
  return createHash("sha256")
    .update("intake-link-create\x00")
    .update(input.teamId)
    .update("\x00")
    .update(input.actorUserId)
    .update("\x00")
    .update(input.idempotencyKey)
    .digest("hex");
}

export function prepareKeyedIntakeCreate(input: {
  teamId: string;
  actorUserId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}): KeyedIntakeCreateScope {
  return {
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    keyHash: intakeCreateKeyHash(input),
    requestHash: intakeCreateRequestHash(input.payload),
  };
}

/** The audit-metadata fields that make the create receipt findable. Digests only. */
export function keyedIntakeCreateAuditMetadata(scope: KeyedIntakeCreateScope): Record<string, string> {
  return { createIdempotencyHash: scope.keyHash, createRequestHash: scope.requestHash };
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function findPriorKeyedIntakeCreate(
  client: Db,
  scope: KeyedIntakeCreateScope,
  now: Date = new Date(),
): Promise<PriorKeyedIntakeCreate | null> {
  const row = await client.adminAuditLog.findFirst({
    where: {
      action: INTAKE_LINK_CREATED_AUDIT_ACTION,
      workspaceId: scope.teamId,
      userId: scope.actorUserId,
      resourceType: "workflow_intake_link",
      createdAt: { gte: new Date(now.getTime() - INTAKE_CREATE_REPLAY_WINDOW_MS) },
      metadata: { path: ["createIdempotencyHash"], equals: scope.keyHash },
    },
    orderBy: { createdAt: "asc" },
    select: { resourceId: true, metadata: true },
  });
  if (!row?.resourceId) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const method = meta.deliveryMethod;
  return {
    linkId: row.resourceId,
    requestHash: typeof meta.createRequestHash === "string" ? meta.createRequestHash : null,
    deliveryMethod: method === "EMAIL" || method === "SMS" ? method : "MANUAL",
  };
}

/**
 * Same request or not. The payload digest must match, and the requested
 * expiry may differ from the stored one only by the time that has passed since
 * the link was created (a client recomputing "now + N hours") plus slack.
 */
export function decideKeyedIntakeReplay(input: {
  prior: PriorKeyedIntakeCreate;
  scope: KeyedIntakeCreateScope;
  link: { expiresAtUtc: Date; createdAt: Date };
  requestedExpiresAt: Date;
  now?: Date;
}): KeyedIntakeCreateDecision {
  const now = (input.now ?? new Date()).getTime();
  if (input.prior.requestHash !== input.scope.requestHash) return { kind: "conflict", prior: input.prior };
  const drift = Math.abs(input.requestedExpiresAt.getTime() - input.link.expiresAtUtc.getTime());
  const allowed = Math.max(0, now - input.link.createdAt.getTime()) + INTAKE_CREATE_EXPIRY_SLACK_MS;
  return drift <= allowed ? { kind: "replay", prior: input.prior } : { kind: "conflict", prior: input.prior };
}

/** Prior receipt + its link, decided. Null when there is no usable receipt. */
export async function resolvePriorKeyedIntakeCreate(
  client: Db,
  scope: KeyedIntakeCreateScope,
  requestedExpiresAt: Date,
): Promise<KeyedIntakeCreateDecision | null> {
  const prior = await findPriorKeyedIntakeCreate(client, scope);
  if (!prior) return null;
  const link = await client.workflowIntakeLink.findFirst({
    where: { id: prior.linkId, teamId: scope.teamId },
    select: { expiresAtUtc: true, createdAt: true },
  });
  if (!link) return null;
  return decideKeyedIntakeReplay({ prior, scope, link, requestedExpiresAt });
}

export type KeyedIntakeCreateOutcome<T> =
  | { kind: "created"; created: T }
  | KeyedIntakeCreateDecision;

/**
 * Lock the scope, look for the receipt, and otherwise create the link and its
 * receipt in ONE transaction. `create` runs on the transaction client; the
 * caller sends nothing until this has committed.
 */
export async function runKeyedIntakeCreate<T extends { link: { id: string } }>(
  client: PrismaClient,
  scope: KeyedIntakeCreateScope,
  options: {
    requestedExpiresAt: Date;
    create: (tx: Prisma.TransactionClient) => Promise<T>;
    /** The create audit's own metadata (no raw contact values); the digests are added here. */
    auditMetadata?: Record<string, unknown>;
    correlationId?: string | null;
  },
): Promise<KeyedIntakeCreateOutcome<T>> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`intake-link-create:${scope.keyHash}`}))`;
    const decided = await resolvePriorKeyedIntakeCreate(tx, scope, options.requestedExpiresAt);
    if (decided) return decided;
    const created = await options.create(tx);
    // The receipt IS the create audit row, written on the same transaction.
    await emitTenantAudit(
      {
        action: INTAKE_LINK_CREATED_AUDIT_ACTION,
        outcome: "success",
        sourceApp: "API",
        actorUserId: scope.actorUserId,
        workspaceId: scope.teamId,
        resourceType: "workflow_intake_link",
        resourceId: created.link.id,
        correlationId: options.correlationId ?? null,
        metadata: { teamId: scope.teamId, ...(options.auditMetadata ?? {}), ...keyedIntakeCreateAuditMetadata(scope) },
      },
      tx as unknown as PrismaClient,
    );
    return { kind: "created" as const, created };
  });
}

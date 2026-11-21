/**
 * FINAL-VERIFY-2 closure — DERIVED WRITES HELD BY DURABLE INTENTS.
 *
 * M676 reserved a derived job's bytes on its row; the reservation stopped
 * counting at its TTL. That freed capacity while bytes could still exist:
 *   (a) the settling write and the fallback (retained) row both failed;
 *   (b) the upload's answer was lost (version unknown) under a hold / Object
 *       Lock, so the object could be neither deleted nor recorded;
 *   (c) the settling write stalled past the reservation's window.
 *
 * Every worker producer now declares its target when it reserves, which
 * writes an OPEN intent (shared-runtime derived-storage) counted by both
 * meters until PROVEN resolved. This module holds the worker's three ways out:
 *
 *   settleDerivedAssetUnderIntent — the canonical record, in ONE transaction
 *     with the intent's resolution, fenced on the live reservation and on the
 *     intent still OPEN, and BOUNDED BY THE DATABASE: every statement runs
 *     under `statement_timeout` / `lock_timeout` (and the gaps under
 *     `idle_in_transaction_session_timeout`) set to what is left of the
 *     reservation's window, so a stalled settle is cancelled and rolled back
 *     by the server, never merely abandoned by the client;
 *   adoptDerivedObjectVersionsTx — stored versions counted on their own
 *     retained rows in the same transaction that resolves the intent;
 *   reconcileDerivedAssetStorageIntents — for intents whose holders' write
 *     windows have all closed: abort incomplete multipart uploads, list the
 *     key's versions, delete what may be deleted (proven by listing again),
 *     adopt what may not, and only then resolve. Every store call carries an
 *     AbortSignal (real request cancellation) bounded below the claim lease.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import {
  DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS,
  DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS,
  claimReconcilableDerivedAssetStorageIntents,
  evaluateEffectiveLegalHold,
  noteDerivedAssetStorageIntentReconcileError,
  resolveDerivedAssetStorageIntentsTx,
  type DerivedAssetIntentResolution,
  type ReconcilableDerivedAssetStorageIntent,
} from "@proovra/shared-runtime";
import { recordDerivedAsset, type DerivedAssetKind } from "@proovra/shared-runtime/media-intelligence";

import { prisma as defaultPrisma } from "./db.js";
import { logger } from "./logger.js";

type Client = PrismaClient;
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
type RecordInput = Parameters<typeof recordDerivedAsset>[0];

/** A hold as this module needs it (the worker's DerivedArtifactReservationHold). */
export type IntentHold = {
  key: { teamId: string; evidenceId: string; evidencePartId: string; assetKind: string; variantKey: string };
  reservedAtUtc: Date;
  writeDeadlineAt: number;
  intentId?: string | null;
};

/** Slack kept between the bounded settle and the reservation's end. */
export const DERIVED_SETTLE_SLACK_MS = 15_000;

/** The bound of a disposal / adoption transaction (outside the reservation window). */
export const DERIVED_DISPOSAL_TRANSACTION_MS = 15_000;

// -----------------------------------------------------------------------------
// Database-bounded transactions
// -----------------------------------------------------------------------------

/** Raised when a bounded transaction has no time left before a statement. */
export class DerivedBoundedTransactionExpired extends Error {
  constructor() {
    super("derived_bounded_transaction_expired");
  }
}

/**
 * Before each statement of a bounded transaction: the server cancels the
 * statement (57014) or the lock wait (55P03) when what is left of `deadlineAt`
 * runs out, and terminates the session if the client stalls between
 * statements. This is cancellation the database performs, not a client that
 * stops waiting.
 */
export async function boundNextStatement(tx: Pick<Tx, "$queryRaw">, deadlineAt: number): Promise<void> {
  const left = Math.floor(deadlineAt - Date.now());
  if (left < 1) throw new DerivedBoundedTransactionExpired();
  const ms = String(left);
  await tx.$queryRaw`SELECT set_config('statement_timeout', ${ms}, true),
                            set_config('lock_timeout', ${ms}, true),
                            set_config('idle_in_transaction_session_timeout', ${ms}, true)`;
}

/** Run `fn` in a transaction every statement of which is bounded by `deadlineAt`. */
export async function boundedTransaction<T>(
  client: Client,
  deadlineAt: number,
  fn: (tx: Tx, bound: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const left = Math.floor(deadlineAt - Date.now());
  if (left < 1) throw new DerivedBoundedTransactionExpired();
  return client.$transaction(
    async (tx) => {
      const bound = () => boundNextStatement(tx, deadlineAt);
      await bound();
      return fn(tx, bound);
    },
    // Prisma's own bounds back the server's: the wait for a connection (no
    // statement sent yet) and an interactive-transaction ceiling.
    { maxWait: Math.max(1, Math.min(left, 10_000)), timeout: left + 1_000 },
  );
}

/** True when an error is the server cancelling a bounded statement or lock wait. */
export function isDatabaseCancellation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 6; depth++) {
    const o = e as { code?: unknown; message?: unknown; cause?: unknown; meta?: unknown };
    const text = `${String(o.code ?? "")} ${String(o.message ?? "")} ${JSON.stringify(o.meta ?? "")}`;
    if (/57014|55P03|statement timeout|lock timeout|canceling statement/i.test(text)) return true;
    e = o.cause;
  }
  return false;
}

// -----------------------------------------------------------------------------
// (c) The settle: fenced, atomic with the intent, bounded by the database
// -----------------------------------------------------------------------------

export type DerivedSettleOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: string };

class SettleRefused extends Error {}

/**
 * The canonical record of a written derived object, under its intent. In ONE
 * transaction: the reservation must still be this holder's and live (row
 * locked), the intent must still be OPEN (resolved SETTLED here), and the row
 * is recorded. Any failure rolls all of it back: the intent stays OPEN and
 * keeps the bytes counted. Every statement is bounded by the database to what
 * is left of the reservation's window, so a stall is cancelled by the server
 * before the reservation could lapse (never a commit after the reconciler
 * judged the key).
 */
export async function settleDerivedAssetUnderIntent(input: {
  hold: IntentHold;
  record: RecordInput;
  client?: Client;
  /** Test seam / caller cap: settle no later than this local epoch-ms. */
  deadlineAt?: number;
}): Promise<DerivedSettleOutcome> {
  const { hold } = input;
  const client = input.client ?? (defaultPrisma as unknown as Client);
  if (!hold.intentId) return { ok: false, reason: "settle_without_intent" };
  const windowEnd = hold.writeDeadlineAt + DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS - DERIVED_SETTLE_SLACK_MS;
  const deadlineAt = Math.min(windowEnd, input.deadlineAt ?? Number.POSITIVE_INFINITY);
  const ttlSeconds = DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS / 1000;
  const intentId = hold.intentId;
  try {
    const id = await boundedTransaction(client, deadlineAt, async (tx, bound) => {
      const fence = (await tx.$queryRaw`
        SELECT d."id" FROM "evidence_part_derived_assets" d
         WHERE d."team_id" = ${hold.key.teamId}::uuid
           AND d."evidence_part_id" = ${hold.key.evidencePartId}::uuid
           AND d."asset_kind" = ${hold.key.assetKind}::varchar
           AND d."variant_key" = ${hold.key.variantKey}::varchar
           AND d."storage_reserved_bytes" IS NOT NULL
           AND d."storage_reserved_at_utc" = ${hold.reservedAtUtc}::timestamptz
           AND d."storage_reservation_token" = ${intentId}::uuid
           AND d."storage_reserved_at_utc" > clock_timestamp() - make_interval(secs => ${ttlSeconds}::double precision)
         FOR UPDATE`) as Array<{ id: string }>;
      if (fence.length !== 1) throw new SettleRefused("storage_reservation_lost_at_settle");
      await bound();
      const resolved = await resolveDerivedAssetStorageIntentsTx(tx, {
        intentIds: [intentId],
        state: "SETTLED",
        resolution: "settled",
        resolvedBytes: input.record.sizeBytes ?? null,
      });
      if (resolved !== 1) throw new SettleRefused("storage_intent_not_open_at_settle");
      await bound();
      const r = await recordDerivedAsset(input.record, tx as unknown as Client);
      // The writer's own reason, unchanged (callers prefix it as before).
      if (!r.ok) throw new SettleRefused(r.reason);
      await bound();
      await tx.$executeRaw`UPDATE "derived_asset_storage_intents" SET "resolved_asset_id" = ${r.id}::uuid WHERE "id" = ${intentId}::uuid`;
      return r.id;
    });
    return { ok: true, id };
  } catch (err) {
    if (err instanceof SettleRefused) return { ok: false, reason: err.message };
    if (err instanceof DerivedBoundedTransactionExpired) return { ok: false, reason: "settle_window_exhausted" };
    if (isDatabaseCancellation(err)) return { ok: false, reason: "settle_cancelled_by_database" };
    return { ok: false, reason: `settle_failed:${err instanceof Error ? err.message.slice(0, 80) : "unknown"}` };
  }
}

// -----------------------------------------------------------------------------
// Adoption: stored versions counted on their own rows, atomically with the intent
// -----------------------------------------------------------------------------

/** The retained row variant of one stored VERSION (≤ 64 chars). */
export function adoptedDerivedVariantKey(variantKey: string, versionId: string): string {
  return `${variantKey.slice(0, 48)}~v${createHash("sha256").update(versionId).digest("hex").slice(0, 12)}`;
}

export type AdoptableVersion = {
  bucket: string;
  key: string;
  versionId: string;
  sizeBytes: number;
  /** Variant of the retained row (defaults to the per-version variant). */
  variantKey?: string;
};

/**
 * Inside a transaction: record each version on its own FAILED retained row
 * (pointer, version and the STORED size, so the meters count what exists),
 * then resolve the intents. Throws (rolling all back) when the intents are no
 * longer all OPEN (and leased to `reconcileToken`, when given).
 */
export async function adoptDerivedObjectVersionsTx(
  tx: Tx,
  input: {
    owner: { teamId: string; evidenceId: string; evidencePartId: string; assetKind: string; variantKey: string };
    versions: AdoptableVersion[];
    derivedSha256: string | null;
    contentType: string | null;
    engineVersion?: string;
    reason: string;
    intentIds: string[];
    state: DerivedAssetIntentResolution;
    reconcileToken?: string | null;
    bound?: () => Promise<void>;
  },
): Promise<string[]> {
  const ids: string[] = [];
  for (const v of input.versions) {
    await input.bound?.();
    const r = await recordDerivedAsset(
      {
        teamId: input.owner.teamId,
        evidenceId: input.owner.evidenceId,
        evidencePartId: input.owner.evidencePartId,
        assetKind: input.owner.assetKind as DerivedAssetKind,
        status: "FAILED",
        variantKey: v.variantKey ?? adoptedDerivedVariantKey(input.owner.variantKey, v.versionId),
        derivedSha256: input.derivedSha256,
        sizeBytes: v.sizeBytes,
        contentType: input.contentType,
        storageBucket: v.bucket,
        storageKey: v.key,
        storageVersionId: v.versionId,
        lastError: `unsettled_object_retained:${input.reason}`.slice(0, 200),
        ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
      },
      tx as unknown as Client,
    );
    if (!r.ok) throw new Error(`adopt_failed:${r.reason}`);
    ids.push(r.id);
  }
  await input.bound?.();
  const total = input.versions.reduce((n, v) => n + BigInt(Math.max(0, Math.trunc(v.sizeBytes))), 0n);
  const resolved = await resolveDerivedAssetStorageIntentsTx(tx, {
    intentIds: input.intentIds,
    state: input.state,
    resolution: input.reason,
    resolvedBytes: total,
    resolvedAssetId: ids[0] ?? null,
    reconcileToken: input.reconcileToken ?? null,
  });
  if (resolved !== input.intentIds.length) throw new Error("adopt_intent_fence_lost");
  return ids;
}

// -----------------------------------------------------------------------------
// The store, as the reconciler needs it (every call cancellable)
// -----------------------------------------------------------------------------

export type DerivedStoredVersion = {
  versionId: string;
  sizeBytes: number;
  legalHold: boolean;
  retainUntil: Date | null;
};

export interface DerivedObjectStore {
  /** Data versions of EXACTLY this key (delete markers excluded), with lock state. */
  listVersions(target: { bucket: string; key: string }, signal: AbortSignal): Promise<DerivedStoredVersion[]>;
  /** Delete one version; false when the store refused it. */
  deleteVersion(target: { bucket: string; key: string; versionId: string }, signal: AbortSignal): Promise<boolean>;
  /** Incomplete multipart uploads of EXACTLY this key. */
  listMultipartUploads(target: { bucket: string; key: string }, signal: AbortSignal): Promise<string[]>;
  abortMultipartUpload(target: { bucket: string; key: string; uploadId: string }, signal: AbortSignal): Promise<void>;
}

type S3Sender = { send(command: never, options?: { abortSignal?: AbortSignal }): Promise<unknown> };

/** The S3 implementation: every request carries the caller's AbortSignal. */
export function s3DerivedObjectStore(client: S3Sender): DerivedObjectStore {
  const send = (command: unknown, signal: AbortSignal) => client.send(command as never, { abortSignal: signal });
  return {
    async listVersions({ bucket, key }, signal) {
      const out: DerivedStoredVersion[] = [];
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      for (let page = 0; page < 100; page++) {
        const res = (await send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: key,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
          signal,
        )) as {
          Versions?: Array<{ Key?: string; VersionId?: string; Size?: number }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextVersionIdMarker?: string;
        };
        for (const v of res.Versions ?? []) {
          if (v.Key !== key) continue;
          const versionId = v.VersionId ?? "null";
          const head = (await send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), signal)) as {
            ObjectLockRetainUntilDate?: Date;
            ObjectLockLegalHoldStatus?: string;
          };
          out.push({
            versionId,
            sizeBytes: Number(v.Size ?? 0),
            legalHold: String(head.ObjectLockLegalHoldStatus ?? "").toUpperCase() === "ON",
            retainUntil: head.ObjectLockRetainUntilDate ?? null,
          });
        }
        if (!res.IsTruncated) return out;
        if (!res.NextKeyMarker && !res.NextVersionIdMarker) throw new Error("OBJECT_VERSION_LISTING_PARTIAL");
        keyMarker = res.NextKeyMarker;
        versionIdMarker = res.NextVersionIdMarker;
      }
      throw new Error("OBJECT_VERSION_LISTING_UNBOUNDED");
    },
    async deleteVersion({ bucket, key, versionId }, signal) {
      try {
        await send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), signal);
        return true;
      } catch (err) {
        if (signal.aborted) throw err;
        return false;
      }
    },
    async listMultipartUploads({ bucket, key }, signal) {
      const ids: string[] = [];
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      for (let page = 0; page < 100; page++) {
        const res = (await send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: key,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
          }),
          signal,
        )) as {
          Uploads?: Array<{ Key?: string; UploadId?: string }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextUploadIdMarker?: string;
        };
        for (const u of res.Uploads ?? []) if (u.Key === key && u.UploadId) ids.push(u.UploadId);
        if (!res.IsTruncated) return ids;
        if (!res.NextKeyMarker && !res.NextUploadIdMarker) throw new Error("MULTIPART_LISTING_PARTIAL");
        keyMarker = res.NextKeyMarker;
        uploadIdMarker = res.NextUploadIdMarker;
      }
      throw new Error("MULTIPART_LISTING_UNBOUNDED");
    },
    async abortMultipartUpload({ bucket, key, uploadId }, signal) {
      await send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), signal);
    },
  };
}

// -----------------------------------------------------------------------------
// The reconciler
// -----------------------------------------------------------------------------

export type DerivedIntentReconcileResult = {
  claimed: number;
  resolved: number;
  absent: number;
  deleted: number;
  adopted: number;
  /** Intents left OPEN (still counted) this tick. */
  kept: number;
};

export const DERIVED_INTENT_RECONCILE_LEASE_MS = 5 * 60 * 1000;

/**
 * Judge OPEN intents whose holders can no longer write (claimed by
 * `claimReconcilableDerivedAssetStorageIntents`), one object key at a time:
 *   1. abort every incomplete multipart upload of the key (proven by listing
 *      again — parts that may remain keep the intent OPEN);
 *   2. list the key's data versions; a version referenced by a derived row is
 *      counted by it;
 *   3. an unreferenced version is deleted only when neither the record's
 *      legal hold (fail closed) nor the version's own hold / retention stops
 *      it, and the next listing must prove it gone; every other unreferenced
 *      version is ADOPTED on its own retained row with its stored size;
 *   4. one bounded transaction records the adoptions and resolves the key's
 *      claimed intents (fenced on the lease token): ADOPTED, DELETED or ABSENT.
 * Anything that cannot be proven leaves the intents OPEN — still counted.
 */
export async function reconcileDerivedAssetStorageIntents(input: {
  store: DerivedObjectStore;
  client?: Client;
  limit?: number;
  leaseMs?: number;
  graceMs?: number;
  now?: () => Date;
}): Promise<DerivedIntentReconcileResult> {
  const client = input.client ?? (defaultPrisma as unknown as Client);
  const leaseMs = input.leaseMs ?? DERIVED_INTENT_RECONCILE_LEASE_MS;
  const token = randomUUID();
  const result: DerivedIntentReconcileResult = { claimed: 0, resolved: 0, absent: 0, deleted: 0, adopted: 0, kept: 0 };
  const claimed = await claimReconcilableDerivedAssetStorageIntents(client, {
    token,
    limit: input.limit ?? 50,
    leaseMs,
    graceMs: input.graceMs,
  });
  result.claimed = claimed.length;
  const groups = new Map<string, ReconcilableDerivedAssetStorageIntent[]>();
  for (const i of claimed) {
    const k = `${i.storageBucket}\u0000${i.storageKey}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  // Store work for the whole tick is cancelled well inside the lease.
  const leaseEnd = Date.now() + leaseMs - 30_000;
  for (const intents of groups.values()) {
    const ids = intents.map((i) => i.id);
    try {
      const outcome = await reconcileKey({ client, store: input.store, intents, token, leaseEnd, now: input.now });
      result.resolved += ids.length;
      result[outcome] += ids.length;
    } catch (err) {
      result.kept += ids.length;
      const error = err instanceof Error ? err.message.slice(0, 200) : "unknown";
      await noteDerivedAssetStorageIntentReconcileError(client, { intentIds: ids, token, error }).catch(() => undefined);
      logger.warn(
        { intents: ids.length, bucket: intents[0]!.storageBucket, error },
        "derived.storage_intent_kept",
      );
    }
  }
  return result;
}

async function reconcileKey(input: {
  client: Client;
  store: DerivedObjectStore;
  intents: ReconcilableDerivedAssetStorageIntent[];
  token: string;
  leaseEnd: number;
  now?: () => Date;
}): Promise<"absent" | "deleted" | "adopted"> {
  const { client, store, intents, token } = input;
  const first = intents[0]!;
  const target = { bucket: first.storageBucket, key: first.storageKey };
  const left = input.leaseEnd - Date.now();
  if (left < 1_000) throw new Error("reconcile_lease_exhausted");
  const signal = AbortSignal.timeout(left);

  // 1. Incomplete multipart uploads (a died upload's parts).
  for (const uploadId of await store.listMultipartUploads(target, signal)) {
    await store.abortMultipartUpload({ ...target, uploadId }, signal);
  }
  if ((await store.listMultipartUploads(target, signal)).length > 0) throw new Error("multipart_parts_remain");

  // 2. What is stored, and what a row already counts.
  const versions = await store.listVersions(target, signal);
  const referenced = new Set(
    (
      await client.evidencePartDerivedAsset.findMany({
        where: { storageBucket: target.bucket, storageKey: target.key, storageVersionId: { in: versions.map((v) => v.versionId) } },
        select: { storageVersionId: true },
      })
    ).map((r) => r.storageVersionId),
  );
  const unreferenced = versions.filter((v) => !referenced.has(v.versionId));

  // 3. Delete what may be deleted (record hold fails closed), proven by listing.
  let deletedAny = false;
  let toAdopt = unreferenced;
  if (unreferenced.length > 0) {
    let recordHeld = true;
    try {
      recordHeld = (await evaluateEffectiveLegalHold(client as never, { teamId: first.teamId, evidenceId: first.evidenceId })).held;
    } catch {
      recordHeld = true;
    }
    const nowMs = (input.now?.() ?? new Date()).getTime();
    const deletable = recordHeld
      ? []
      : unreferenced.filter((v) => !v.legalHold && !(v.retainUntil && v.retainUntil.getTime() > nowMs));
    for (const v of deletable) await store.deleteVersion({ ...target, versionId: v.versionId }, signal);
    if (deletable.length > 0) {
      const after = new Set((await store.listVersions(target, signal)).map((v) => v.versionId));
      deletedAny = deletable.some((v) => !after.has(v.versionId));
      toAdopt = unreferenced.filter((v) => after.has(v.versionId));
    }
  }

  // 4. Adopt the rest and resolve the key's intents, atomically.
  const state: DerivedAssetIntentResolution = toAdopt.length > 0 ? "ADOPTED" : deletedAny ? "DELETED" : "ABSENT";
  const reason =
    state === "ADOPTED" ? "reconciled_adopted" : state === "DELETED" ? "reconciled_deleted" : "reconciled_absent";
  const deadlineAt = Math.min(input.leaseEnd, Date.now() + DERIVED_DISPOSAL_TRANSACTION_MS);
  await boundedTransaction(client, deadlineAt, async (tx, bound) => {
    if (toAdopt.length > 0) {
      await adoptDerivedObjectVersionsTx(tx, {
        owner: first,
        versions: toAdopt.map((v) => ({ ...target, versionId: v.versionId, sizeBytes: v.sizeBytes })),
        derivedSha256: first.derivedSha256,
        contentType: first.contentType,
        reason,
        intentIds: intents.map((i) => i.id),
        state,
        reconcileToken: token,
        bound,
      });
      return;
    }
    const resolved = await resolveDerivedAssetStorageIntentsTx(tx, {
      intentIds: intents.map((i) => i.id),
      state,
      resolution: reason,
      resolvedBytes: 0,
      reconcileToken: token,
    });
    if (resolved !== intents.length) throw new Error("reconcile_intent_fence_lost");
  });
  logger.info({ intents: intents.length, state, adopted: toAdopt.length }, "derived.storage_intent_reconciled");
  return state === "ADOPTED" ? "adopted" : state === "DELETED" ? "deleted" : "absent";
}

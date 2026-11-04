/**
 * THE AUTHORITY ON WHETHER A SIGNER MAY STILL SIGN.
 *
 * =============================================================================
 * WHAT WENT WRONG
 * =============================================================================
 * `revokeSigner()` was, in full: check the reason is non-empty, bump a counter,
 * emit a security event, return `{ ok: true }`. It wrote no state, verified no
 * signer existed, and the route accepted any string as a signer id. `retireSigner`
 * was the same shape.
 *
 * The read model could not have shown a revocation even if one had been written:
 * `getCurrentActiveSigners()` recomputes the active set FROM ENVIRONMENT
 * VARIABLES on every request, with `status: "active"` hardcoded. So after
 * step-up and a typed `REVOKE`, the page refetched and the signer reappeared
 * ACTIVE — while the dialog said it "is withdrawn immediately and cannot be
 * used again. This cannot be undone."
 *
 * The environment is where signer configuration LIVES, and an operator cannot
 * edit it from a console. That is why this module exists as an OVERLAY rather
 * than a replacement: the env says which keys the deployment HAS, this says
 * which of them may still be USED. The overlay is in PostgreSQL, so it survives
 * an API restart, a worker restart, a deploy and any cache refresh — which is
 * precisely what the previous implementation could not do.
 *
 * =============================================================================
 * DISCOVERY IS DETERMINISTIC, AND NEVER RESETS A DECISION
 * =============================================================================
 * A configured signer with no row is ACTIVE: a deployment that has never used
 * this console must keep signing. Registration therefore inserts an ACTIVE row
 * on first sight and does nothing at all when a row already exists. It is an
 * `ON CONFLICT DO NOTHING`, never an upsert — an upsert would resurrect a
 * revoked signer on the next boot, which is the original defect wearing a
 * different hat.
 */

import { revokeSigningKeyMaterial } from "@proovra/shared-runtime";
import { prisma } from "../../db.js";

export const SIGNER_CONTROL_STATUSES = ["ACTIVE", "RETIRED", "REVOKED"] as const;
export type SignerControlStatus = (typeof SIGNER_CONTROL_STATUSES)[number];

export type SignerControlRow = {
  signerId: string;
  status: SignerControlStatus;
  stateVersion: number;
  /**
   * When discovery FIRST observed this signer configured.
   *
   * Written once, by the column default, on the insert that registers the
   * signer — and never rewritten, because registration is
   * `ON CONFLICT DO NOTHING` rather than an upsert. That is what makes it a
   * durable fact rather than a restatement of "now".
   *
   * It is the honest answer to "since when has this signer been in use by this
   * deployment", and it is NOT a claim about when the key itself was created.
   * For a signer configured before this table existed it is the registration
   * date, not the true activation date, and the console must say so rather
   * than relabelling one claim as the other.
   */
  firstSeenAtUtc: Date;
  statusChangedAtUtc: Date | null;
  actorUserId: string | null;
  reason: string | null;
  transitionSource: string | null;
};

/**
 * The transitions the domain permits. Anything not listed is refused.
 *
 * REVOKED is terminal in both directions on purpose: "revoked" is the word the
 * UI uses for a suspected compromise, and a compromise is not undone by a
 * button. Reinstating a key means configuring it as a new signer identity,
 * which is a deployment action with its own review — not a console click.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<SignerControlStatus, ReadonlySet<SignerControlStatus>>> = {
  ACTIVE: new Set<SignerControlStatus>(["RETIRED", "REVOKED"]),
  RETIRED: new Set<SignerControlStatus>(["REVOKED"]),
  REVOKED: new Set<SignerControlStatus>([]),
};

export function isTransitionAllowed(
  from: SignerControlStatus,
  to: SignerControlStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/** A signer in this state may be selected for NEW signing operations. */
export function statusPermitsSigning(status: SignerControlStatus): boolean {
  return status === "ACTIVE";
}

/**
 * Register configured signers as ACTIVE on first sight. Idempotent, and it
 * NEVER overwrites an existing row — see the header.
 */
export async function registerDiscoveredSigners(
  signerIds: ReadonlyArray<string>,
): Promise<void> {
  const ids = [...new Set(signerIds.filter((s) => typeof s === "string" && s.length > 0))];
  if (ids.length === 0) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "signer_control_state" ("signer_id")
     SELECT UNNEST($1::text[])
     ON CONFLICT ("signer_id") DO NOTHING`,
    ids,
  );
}

/** Persisted states for the given ids. Absent ids are simply not returned. */
export async function getSignerControlStates(
  signerIds: ReadonlyArray<string>,
): Promise<Map<string, SignerControlRow>> {
  const ids = [...new Set(signerIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.signerControlState.findMany({
    where: { signerId: { in: ids } },
  });
  const out = new Map<string, SignerControlRow>();
  for (const r of rows) {
    out.set(r.signerId, {
      signerId: r.signerId,
      status: r.status as SignerControlStatus,
      stateVersion: r.stateVersion,
      firstSeenAtUtc: r.firstSeenAtUtc,
      statusChangedAtUtc: r.statusChangedAtUtc,
      actorUserId: r.actorUserId,
      reason: r.reason,
      transitionSource: r.transitionSource,
    });
  }
  return out;
}

/**
 * The effective status of one signer.
 *
 * An unregistered signer reads ACTIVE: this is the discovery default, and it is
 * what keeps a deployment that has never opened the console signing normally.
 * It is safe because the only way to leave ACTIVE is to write a row.
 */
export async function getEffectiveSignerStatus(
  signerId: string,
): Promise<SignerControlStatus> {
  const row = await prisma.signerControlState.findUnique({ where: { signerId } });
  return (row?.status as SignerControlStatus | undefined) ?? "ACTIVE";
}

export class SignerNotUsableError extends Error {
  readonly code = "signer_not_usable";
  constructor(
    readonly signerId: string,
    readonly status: SignerControlStatus,
  ) {
    super(
      `Signer ${signerId} is ${status} and may not be used for new signatures.`,
    );
    this.name = "SignerNotUsableError";
  }
}

/**
 * THE SIGNING BOUNDARY.
 *
 * Called immediately before a signature is produced, by every path that can
 * produce one. It is deliberately a read of the DATABASE and not of a cached
 * value: a job queued before a revocation and executed after it must observe
 * the revocation, and an in-memory cache is exactly how that guarantee is lost.
 */
export async function assertSignerUsable(signerId: string): Promise<void> {
  const status = await getEffectiveSignerStatus(signerId);
  if (!statusPermitsSigning(status)) {
    throw new SignerNotUsableError(signerId, status);
  }
}

export type TransitionOutcome =
  | { ok: true; state: "changed"; from: SignerControlStatus; to: SignerControlStatus; stateVersion: number }
  | { ok: true; state: "already"; status: SignerControlStatus }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "transition_not_allowed"; from: SignerControlStatus; to: SignerControlStatus }
  | { ok: false; code: "stale_state" };

/**
 * Move one signer to a new status.
 *
 * The write is a compare-and-set on `state_version`, so two concurrent
 * transitions cannot both report themselves as the first: the loser sees zero
 * affected rows and returns `stale_state`. Re-running a transition that already
 * holds returns `already`, which the caller must NOT audit as a fresh
 * transition — one successful change, one canonical audit event.
 */
export async function transitionSignerControlState(input: {
  signerId: string;
  to: SignerControlStatus;
  actorUserId: string | null;
  reason: string;
  transitionSource?: string;
  /** When supplied, the caller's view of the row it intends to replace. */
  expectedStateVersion?: number;
}): Promise<TransitionOutcome> {
  const current = await prisma.signerControlState.findUnique({
    where: { signerId: input.signerId },
  });
  if (!current) return { ok: false, code: "not_found" };

  const from = current.status as SignerControlStatus;
  if (from === input.to) return { ok: true, state: "already", status: from };

  if (!isTransitionAllowed(from, input.to)) {
    return { ok: false, code: "transition_not_allowed", from, to: input.to };
  }
  if (
    input.expectedStateVersion !== undefined &&
    input.expectedStateVersion !== current.stateVersion
  ) {
    return { ok: false, code: "stale_state" };
  }

  // Compare-and-set. `updateMany` matches on the version we read, so a
  // concurrent winner leaves us with count 0 rather than a second "success".
  //
  // This is an AUTHORIZATION transition: it decides whether this one signer
  // (one purpose of one key identity) may sign from now on. It never touches
  // `signing_keys` — signatures already made stay verifiable, and another
  // purpose served by the same key material keeps working. A compromised key is
  // `declareSigningKeyCompromise`, below.
  const res = await prisma.signerControlState.updateMany({
    where: { signerId: input.signerId, stateVersion: current.stateVersion },
    data: {
      status: input.to,
      stateVersion: current.stateVersion + 1,
      statusChangedAtUtc: new Date(),
      actorUserId: input.actorUserId,
      reason: input.reason.trim().slice(0, 400),
      transitionSource: (input.transitionSource ?? "admin_console").slice(0, 64),
      updatedAtUtc: new Date(),
    },
  });
  if (res.count === 0) return { ok: false, code: "stale_state" };

  return {
    ok: true,
    state: "changed",
    from,
    to: input.to,
    stateVersion: current.stateVersion + 1,
  };
}

export type KeyCompromiseOutcome =
  | {
      ok: true;
      state: "changed" | "already";
      /** The key material reached (SPKI SHA-256). Empty: the identity had no registered key. */
      fingerprints: string[];
      revokedKeyRows: number;
      /** Every signer withdrawn by this call (the named one included, when it changed). */
      revokedSignerIds: string[];
      keyIdentities: Array<{ keyId: string; version: number }>;
      keyRows: Array<{ keyId: string; version: number; purpose: string }>;
    }
  | { ok: false; code: "stale_state" };

/**
 * DECLARE A SIGNING KEY COMPROMISED (CRYPTO-001, scoped 2026-11-04).
 *
 * The scope is the KEY MATERIAL, not one signer. In one transaction:
 *   1. every `signing_keys` row of the material behind (keyId, version) is
 *      revoked — under any key id, version or purpose, the package seal
 *      included — so every verifier reports those signatures as made by a
 *      revoked key, and a later registration of that material is born revoked;
 *   2. every signer that names one of the key identities holding that material
 *      is withdrawn (REVOKED), for every purpose and provider, so nothing signs
 *      with it again — including a signer that was already withdrawn for one
 *      purpose only.
 *
 * Allowed from any status: an authorization revoked yesterday does not stop a
 * compromise being declared today. A repeat changes nothing and says so.
 */
export async function declareSigningKeyCompromise(input: {
  signerId: string;
  keyId: string;
  version: number;
  actorUserId: string | null;
  reason: string;
  expectedStateVersion?: number;
  /** Every signer id that names one of these key identities. */
  signerIdsForIdentities: (identities: ReadonlyArray<{ keyId: string; version: number }>) => string[];
}): Promise<KeyCompromiseOutcome> {
  const reason = input.reason.trim().slice(0, 400);
  return prisma.$transaction(async (tx) => {
    // One compromise at a time, so two declarations cannot interleave their
    // cascades. The lock is released with the transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('signing-key-compromise'))`;
    if (input.expectedStateVersion !== undefined) {
      const current = await tx.signerControlState.findUnique({ where: { signerId: input.signerId } });
      if ((current?.stateVersion ?? 0) !== input.expectedStateVersion) return { ok: false as const, code: "stale_state" as const };
    }
    const material = await revokeSigningKeyMaterial(tx as never, { keyId: input.keyId, version: input.version });
    const signerIds = [...new Set([input.signerId, ...input.signerIdsForIdentities(material.identities)])];
    const changed = await tx.$queryRawUnsafe<Array<{ signer_id: string }>>(
      `INSERT INTO "signer_control_state"
         ("signer_id", "status", "state_version", "status_changed_at_utc", "actor_user_id", "reason", "transition_source", "updated_at_utc")
       SELECT s, 'REVOKED', 2, NOW(), $2::uuid, $3, 'key_compromise', NOW() FROM UNNEST($1::text[]) AS s
       ON CONFLICT ("signer_id") DO UPDATE SET
         "status" = 'REVOKED',
         "state_version" = "signer_control_state"."state_version" + 1,
         "status_changed_at_utc" = NOW(),
         "actor_user_id" = EXCLUDED."actor_user_id",
         "reason" = EXCLUDED."reason",
         "transition_source" = 'key_compromise',
         "updated_at_utc" = NOW()
       WHERE "signer_control_state"."status" <> 'REVOKED'
       RETURNING "signer_id"`,
      signerIds,
      input.actorUserId,
      reason,
    );
    const revokedSignerIds = changed.map((r) => r.signer_id).sort();
    return {
      ok: true as const,
      state: material.revokedRows > 0 || revokedSignerIds.length > 0 ? ("changed" as const) : ("already" as const),
      fingerprints: material.fingerprints,
      revokedKeyRows: material.revokedRows,
      revokedSignerIds,
      keyIdentities: material.identities,
      keyRows: material.rows,
    };
  });
}

/**
 * How many signers could still sign for this purpose if `excluding` were
 * removed. Used to refuse a transition that would leave a purpose unable to
 * sign at all, rather than discovering it at the next upload.
 */
export async function countRemainingUsableSigners(input: {
  candidateSignerIds: ReadonlyArray<string>;
  excluding: string;
}): Promise<number> {
  const others = input.candidateSignerIds.filter((id) => id !== input.excluding);
  if (others.length === 0) return 0;
  const states = await getSignerControlStates(others);
  return others.filter((id) => {
    const row = states.get(id);
    return statusPermitsSigning((row?.status as SignerControlStatus) ?? "ACTIVE");
  }).length;
}

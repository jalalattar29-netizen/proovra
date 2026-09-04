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

import { prisma } from "../../db.js";

export const SIGNER_CONTROL_STATUSES = ["ACTIVE", "RETIRED", "REVOKED"] as const;
export type SignerControlStatus = (typeof SIGNER_CONTROL_STATUSES)[number];

export type SignerControlRow = {
  signerId: string;
  status: SignerControlStatus;
  stateVersion: number;
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

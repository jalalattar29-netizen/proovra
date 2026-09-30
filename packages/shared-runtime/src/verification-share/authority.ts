/**
 * THE VERIFICATION-SHARE AUTHORITY (ET-PKG-07, owner decision 2026-09-30).
 *
 * Evidence is private and unpublished by default, and a permanent raw
 * Evidence UUID is not a public capability. Public verification used to be
 * reachable at /verify/<evidence id>: the primary key, which also appears in
 * reports, packages, storage keys, internal URLs and audit data — published
 * by default, with no expiry, no rotation and no way to withdraw one
 * recipient's access without unpublishing the record for everyone.
 *
 * A public link is now an OPAQUE SHARE TOKEN:
 *
 *   - 256 bits from the CSPRNG, carried as `pvs_<43 base64url chars>`;
 *   - only its SHA-256 is stored — a database read cannot recover a link;
 *   - scoped to exactly one Evidence and one allowed public projection;
 *   - with an audience label, a purpose, who created it and when;
 *   - optionally expiring, optionally limited to a number of uses;
 *   - revocable and rotatable on its own, leaving every other link intact;
 *   - carrying last-used time and a use count.
 *
 * This module is the one place that mints, hashes, resolves, revokes and
 * rotates them, for the API (owner controls, Public Verify) and the worker
 * (the link a report or package carries). A token is NECESSARY, not
 * sufficient: the record must also be PUBLISHED by its owner, which is the
 * publication authority's decision and is checked by the route.
 *
 * LEGACY RECORD-ID LINKS. Records published before this existed are reachable
 * by their id for a bounded grace period (`legacyVerifyUuidUntilUtc`, set once
 * by the migration's backfill). An owner can end it earlier; nothing extends
 * it; a record created after the migration never has one.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

export const VERIFICATION_SHARE_TOKEN_PREFIX = "pvs_";
/** 32 random bytes → 43 base64url characters. */
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

/** How long a record-ID link minted before tokens existed keeps working. */
export const LEGACY_VERIFY_LINK_GRACE_DAYS = 180;

export const VERIFICATION_SHARE_PURPOSES = [
  /** Created by the owner for a named audience. */
  "OWNER_SHARE",
  /** Carried by one issued report version (its QR code and link). */
  "REPORT",
  /** Carried by one issued verification package. */
  "PACKAGE",
] as const;
export type VerificationSharePurpose = (typeof VERIFICATION_SHARE_PURPOSES)[number];

/**
 * What a link may show. BASIC is the original-integrity result only; STANDARD
 * is whatever the record's public projection allows (rich when the record is
 * entitled and not restricted, basic otherwise). A link can narrow the
 * projection, never widen it.
 */
export const VERIFICATION_SHARE_PROJECTIONS = ["BASIC", "STANDARD"] as const;
export type VerificationShareProjection = (typeof VERIFICATION_SHARE_PROJECTIONS)[number];

export const VERIFICATION_SHARE_AUDIENCE_MAX = 120;
/** Active owner-created links one record may hold at a time. */
export const VERIFICATION_SHARE_MAX_ACTIVE_OWNER_LINKS = 25;

export function generateVerificationShareToken(): string {
  return `${VERIFICATION_SHARE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Is this string SHAPED like a share token? (Shape only; it proves nothing.) */
export function isVerificationShareTokenShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(VERIFICATION_SHARE_TOKEN_PREFIX) &&
    TOKEN_BODY.test(value.slice(VERIFICATION_SHARE_TOKEN_PREFIX.length))
  );
}

/** SHA-256 (hex) of the full token — the only form that is ever stored. */
export function hashVerificationShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type VerificationShareState = "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";

export type VerificationShareRow = {
  id: string;
  evidenceId: string;
  teamId: string | null;
  tokenHash: string;
  purpose: string;
  projection: string;
  audience: string | null;
  reportVersion: number | null;
  createdByUserId: string | null;
  createdAtUtc: Date;
  expiresAtUtc: Date | null;
  revokedAtUtc: Date | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  rotatedFromId: string | null;
  maxUses: number | null;
  useCount: number;
  lastUsedAtUtc: Date | null;
};

export function verificationShareStateOf(
  row: Pick<VerificationShareRow, "revokedAtUtc" | "expiresAtUtc" | "maxUses" | "useCount">,
  now: Date = new Date(),
): VerificationShareState {
  if (row.revokedAtUtc) return "REVOKED";
  if (row.expiresAtUtc && row.expiresAtUtc.getTime() <= now.getTime()) return "EXPIRED";
  if (row.maxUses !== null && row.useCount >= row.maxUses) return "EXHAUSTED";
  return "ACTIVE";
}

type ShareTx = Pick<Prisma.TransactionClient, "verificationShareToken">;
type ShareClient = Pick<PrismaClient, "verificationShareToken">;

export type MintVerificationShareInput = {
  evidenceId: string;
  teamId: string | null;
  purpose: VerificationSharePurpose;
  projection?: VerificationShareProjection;
  audience?: string | null;
  reportVersion?: number | null;
  createdByUserId?: string | null;
  expiresAtUtc?: Date | null;
  maxUses?: number | null;
  rotatedFromId?: string | null;
  /**
   * A token generated earlier by the caller (the worker embeds the link in a
   * PDF before the report row exists). When omitted one is generated here.
   */
  token?: string;
  now?: Date;
};

/**
 * Mint a link: store the hash, return the token. The token is returned HERE
 * and nowhere else — it cannot be read back.
 */
export async function mintVerificationShareTokenTx(
  tx: ShareTx,
  input: MintVerificationShareInput,
): Promise<{ id: string; token: string }> {
  const token = input.token ?? generateVerificationShareToken();
  if (!isVerificationShareTokenShape(token)) {
    throw new Error("verification share token has the wrong shape");
  }
  const row = await tx.verificationShareToken.create({
    data: {
      evidenceId: input.evidenceId,
      teamId: input.teamId,
      tokenHash: hashVerificationShareToken(token),
      purpose: input.purpose,
      projection: input.projection ?? "STANDARD",
      audience: input.audience ? input.audience.trim().slice(0, VERIFICATION_SHARE_AUDIENCE_MAX) : null,
      reportVersion: input.reportVersion ?? null,
      createdByUserId: input.createdByUserId ?? null,
      createdAtUtc: input.now ?? new Date(),
      expiresAtUtc: input.expiresAtUtc ?? null,
      maxUses: input.maxUses ?? null,
      rotatedFromId: input.rotatedFromId ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, token };
}

export type ResolvedVerificationShare =
  | { outcome: "UNKNOWN" }
  | { outcome: "GONE"; state: Exclude<VerificationShareState, "ACTIVE">; row: VerificationShareRow }
  | { outcome: "ACTIVE"; row: VerificationShareRow };

/**
 * Resolve a presented token. UNKNOWN covers a wrong shape and a token that
 * was never issued — the caller answers both identically. GONE is a token
 * that WAS issued and is no longer valid; only someone who held a real link
 * can reach it, so saying so enumerates nothing.
 */
export async function resolveVerificationShareToken(
  client: ShareClient,
  presented: unknown,
  now: Date = new Date(),
): Promise<ResolvedVerificationShare> {
  if (!isVerificationShareTokenShape(presented)) return { outcome: "UNKNOWN" };
  const tokenHash = hashVerificationShareToken(presented);
  const row = (await client.verificationShareToken.findUnique({ where: { tokenHash } })) as VerificationShareRow | null;
  if (!row) return { outcome: "UNKNOWN" };
  // Defence in depth: the lookup was by hash; compare it in constant time too.
  const a = Buffer.from(row.tokenHash, "hex");
  const b = Buffer.from(tokenHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { outcome: "UNKNOWN" };
  const state = verificationShareStateOf(row, now);
  return state === "ACTIVE" ? { outcome: "ACTIVE", row } : { outcome: "GONE", state, row };
}

/**
 * Record one use: last-used time and the use count. With `maxUses` set, the
 * increment is conditional, so concurrent requests cannot take a link past its
 * limit — the loser gets `false` and the caller answers "gone".
 */
export async function recordVerificationShareUse(
  client: ShareClient,
  row: Pick<VerificationShareRow, "id" | "maxUses">,
  now: Date = new Date(),
): Promise<boolean> {
  const used = await client.verificationShareToken.updateMany({
    where: {
      id: row.id,
      revokedAtUtc: null,
      ...(row.maxUses !== null ? { useCount: { lt: row.maxUses } } : {}),
    },
    data: { useCount: { increment: 1 }, lastUsedAtUtc: now },
  });
  return used.count === 1;
}

/** Revoke one link. Idempotent: an already-revoked link stays as it was. */
export async function revokeVerificationShareTokenTx(
  tx: ShareTx,
  input: { id: string; evidenceId: string; revokedByUserId: string | null; reason: string; now?: Date },
): Promise<boolean> {
  const done = await tx.verificationShareToken.updateMany({
    where: { id: input.id, evidenceId: input.evidenceId, revokedAtUtc: null },
    data: {
      revokedAtUtc: input.now ?? new Date(),
      revokedByUserId: input.revokedByUserId,
      revocationReason: input.reason.slice(0, 64),
    },
  });
  return done.count === 1;
}

/**
 * Rotate one link: revoke it and mint its replacement with the same audience,
 * purpose, projection and limits, in the caller's transaction. The old token
 * stops working at once; the new one is returned once.
 */
export async function rotateVerificationShareTokenTx(
  tx: ShareTx,
  input: { id: string; evidenceId: string; actorUserId: string | null; expiresAtUtc?: Date | null; now?: Date },
): Promise<{ id: string; token: string } | null> {
  const now = input.now ?? new Date();
  const current = (await tx.verificationShareToken.findFirst({
    where: { id: input.id, evidenceId: input.evidenceId },
  })) as VerificationShareRow | null;
  if (!current || current.revokedAtUtc) return null;
  const revoked = await revokeVerificationShareTokenTx(tx, {
    id: current.id,
    evidenceId: current.evidenceId,
    revokedByUserId: input.actorUserId,
    reason: "ROTATED",
    now,
  });
  if (!revoked) return null;
  return mintVerificationShareTokenTx(tx, {
    evidenceId: current.evidenceId,
    teamId: current.teamId,
    purpose: current.purpose as VerificationSharePurpose,
    projection: current.projection as VerificationShareProjection,
    audience: current.audience,
    reportVersion: current.reportVersion,
    createdByUserId: input.actorUserId,
    expiresAtUtc: input.expiresAtUtc === undefined ? current.expiresAtUtc : input.expiresAtUtc,
    maxUses: current.maxUses,
    rotatedFromId: current.id,
    now,
  });
}

/** Is the record-ID link of a record published before tokens existed still inside its grace? */
export function legacyVerifyLinkActive(
  row: { legacyVerifyUuidUntilUtc: Date | null },
  now: Date = new Date(),
): boolean {
  return row.legacyVerifyUuidUntilUtc !== null && row.legacyVerifyUuidUntilUtc.getTime() > now.getTime();
}

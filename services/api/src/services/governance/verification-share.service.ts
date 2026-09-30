/**
 * OWNER CONTROLS FOR PUBLIC VERIFICATION LINKS (ET-PKG-07, 2026-09-30).
 *
 * The API's binding over the verification-share authority
 * (@proovra/shared-runtime). It owns nothing about tokens — generation,
 * hashing, resolution, revocation and rotation are the authority's — and adds
 * what only the API knows: the record it is for, the limits an owner-made link
 * must respect, and the projection an owner is shown (never a token hash;
 * the token itself exists only in the response that creates or rotates it).
 *
 * A link is necessary, not sufficient: the record must also be PUBLISHED.
 * Publishing stays with the publication authority (publication.service.ts);
 * the route decides when creating a link publishes.
 */
import type { PrismaClient } from "@prisma/client";
import {
  LEGACY_VERIFY_LINK_GRACE_DAYS,
  VERIFICATION_SHARE_AUDIENCE_MAX,
  VERIFICATION_SHARE_MAX_ACTIVE_OWNER_LINKS,
  legacyVerifyLinkActive,
  mintVerificationShareTokenTx,
  revokeVerificationShareTokenTx,
  rotateVerificationShareTokenTx,
  verificationShareStateOf,
  type VerificationShareProjection,
  type VerificationShareRow,
  type VerificationShareState,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

export const VERIFICATION_LINK_MAX_EXPIRY_DAYS = 365;
export const VERIFICATION_LINK_MAX_USES_CEILING = 100_000;

export class VerificationShareError extends Error {
  constructor(
    public readonly code:
      | "link_not_found"
      | "link_not_active"
      | "too_many_active_links"
      | "record_not_shareable"
      | "legacy_link_not_active",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "VerificationShareError";
  }
}

/** What an owner is shown about one link. No hash, no token. */
export type VerificationLinkView = {
  id: string;
  purpose: string;
  projection: string;
  audience: string | null;
  reportVersion: number | null;
  state: VerificationShareState;
  createdAtUtc: string;
  createdByUserId: string | null;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  rotatedFromId: string | null;
  maxUses: number | null;
  useCount: number;
  lastUsedAtUtc: string | null;
};

export type LegacyVerifyLinkView = {
  /** True while the record can still be verified by its id. */
  active: boolean;
  /** When the record-id link stops (or stopped) working. */
  expiresAtUtc: string;
  graceDays: number;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function projectVerificationLink(row: VerificationShareRow, now: Date = new Date()): VerificationLinkView {
  return {
    id: row.id,
    purpose: row.purpose,
    projection: row.projection,
    audience: row.audience,
    reportVersion: row.reportVersion,
    state: verificationShareStateOf(row, now),
    createdAtUtc: row.createdAtUtc.toISOString(),
    createdByUserId: row.createdByUserId,
    expiresAtUtc: iso(row.expiresAtUtc),
    revokedAtUtc: iso(row.revokedAtUtc),
    revokedByUserId: row.revokedByUserId,
    revocationReason: row.revocationReason,
    rotatedFromId: row.rotatedFromId,
    maxUses: row.maxUses,
    useCount: row.useCount,
    lastUsedAtUtc: iso(row.lastUsedAtUtc),
  };
}

type RecordForShare = {
  id: string;
  teamId: string | null;
  status: string;
  lifecycleState: string;
  deletedAt: Date | null;
  publicVerifyState: string;
  legacyVerifyUuidUntilUtc: Date | null;
};

export async function loadRecordForShare(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<RecordForShare | null> {
  return client.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      teamId: true,
      status: true,
      lifecycleState: true,
      deletedAt: true,
      publicVerifyState: true,
      legacyVerifyUuidUntilUtc: true,
    },
  });
}

/** A record that can be publicly verified at all: signed, and not trashed or destroyed. */
export function recordIsShareable(record: RecordForShare): boolean {
  return (
    (record.status === "SIGNED" || record.status === "REPORTED") &&
    record.deletedAt === null &&
    record.lifecycleState !== "TRASHED" &&
    record.lifecycleState !== "DESTROYED" &&
    record.lifecycleState !== "PENDING_DESTRUCTION"
  );
}

export async function listVerificationLinks(
  record: RecordForShare,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{
  publicVerifyState: string;
  links: VerificationLinkView[];
  legacy: LegacyVerifyLinkView | null;
}> {
  const rows = (await client.verificationShareToken.findMany({
    where: { evidenceId: record.id },
    orderBy: [{ createdAtUtc: "desc" }, { id: "desc" }],
    take: 500,
  })) as VerificationShareRow[];
  return {
    publicVerifyState: record.publicVerifyState,
    links: rows.map((r) => projectVerificationLink(r, now)),
    legacy: record.legacyVerifyUuidUntilUtc
      ? {
          active: legacyVerifyLinkActive(record, now),
          expiresAtUtc: record.legacyVerifyUuidUntilUtc.toISOString(),
          graceDays: LEGACY_VERIFY_LINK_GRACE_DAYS,
        }
      : null,
  };
}

export type CreateVerificationLinkInput = {
  record: RecordForShare;
  actorUserId: string;
  audience: string;
  /** Days until the link expires; null = no expiry. */
  expiresInDays: number | null;
  projection: VerificationShareProjection;
  maxUses: number | null;
};

/**
 * Create an owner link. The ONLY response that ever carries the token.
 *
 * The active-link ceiling is checked under a per-record advisory lock, so
 * concurrent creates cannot take a record past it.
 */
export async function createVerificationLink(
  input: CreateVerificationLinkInput,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ link: VerificationLinkView; token: string }> {
  const { record } = input;
  if (!recordIsShareable(record)) throw new VerificationShareError("record_not_shareable");
  const expiresAtUtc =
    input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000);

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verification-share:${record.id}`}))`;
    const existing = (await tx.verificationShareToken.findMany({
      where: { evidenceId: record.id, purpose: "OWNER_SHARE", revokedAtUtc: null },
    })) as VerificationShareRow[];
    const active = existing.filter((r) => verificationShareStateOf(r, now) === "ACTIVE").length;
    if (active >= VERIFICATION_SHARE_MAX_ACTIVE_OWNER_LINKS) {
      throw new VerificationShareError("too_many_active_links", {
        limit: VERIFICATION_SHARE_MAX_ACTIVE_OWNER_LINKS,
      });
    }
    const minted = await mintVerificationShareTokenTx(tx, {
      evidenceId: record.id,
      teamId: record.teamId,
      purpose: "OWNER_SHARE",
      projection: input.projection,
      audience: input.audience.trim().slice(0, VERIFICATION_SHARE_AUDIENCE_MAX),
      createdByUserId: input.actorUserId,
      expiresAtUtc,
      maxUses: input.maxUses,
      now,
    });
    const row = (await tx.verificationShareToken.findUniqueOrThrow({
      where: { id: minted.id },
    })) as VerificationShareRow;
    return { link: projectVerificationLink(row, now), token: minted.token };
  });
}

export async function revokeVerificationLink(
  input: { record: RecordForShare; linkId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ link: VerificationLinkView; changed: boolean }> {
  return client.$transaction(async (tx) => {
    const current = (await tx.verificationShareToken.findFirst({
      where: { id: input.linkId, evidenceId: input.record.id },
    })) as VerificationShareRow | null;
    if (!current) throw new VerificationShareError("link_not_found");
    const changed = await revokeVerificationShareTokenTx(tx, {
      id: current.id,
      evidenceId: input.record.id,
      revokedByUserId: input.actorUserId,
      reason: "OWNER_REVOKED",
      now,
    });
    const row = (await tx.verificationShareToken.findUniqueOrThrow({
      where: { id: current.id },
    })) as VerificationShareRow;
    return { link: projectVerificationLink(row, now), changed };
  });
}

export async function rotateVerificationLink(
  input: { record: RecordForShare; linkId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ link: VerificationLinkView; token: string; replacedLinkId: string }> {
  if (!recordIsShareable(input.record)) throw new VerificationShareError("record_not_shareable");
  return client.$transaction(async (tx) => {
    const current = (await tx.verificationShareToken.findFirst({
      where: { id: input.linkId, evidenceId: input.record.id },
    })) as VerificationShareRow | null;
    if (!current) throw new VerificationShareError("link_not_found");
    // Only a link that still works is rotated. A revoked one stays revoked; an
    // expired or used-up one is replaced by creating a new link on purpose.
    if (verificationShareStateOf(current, now) !== "ACTIVE") {
      throw new VerificationShareError("link_not_active", { state: verificationShareStateOf(current, now) });
    }
    const minted = await rotateVerificationShareTokenTx(tx, {
      id: current.id,
      evidenceId: input.record.id,
      actorUserId: input.actorUserId,
      now,
    });
    if (!minted) throw new VerificationShareError("link_not_active");
    const row = (await tx.verificationShareToken.findUniqueOrThrow({
      where: { id: minted.id },
    })) as VerificationShareRow;
    return { link: projectVerificationLink(row, now), token: minted.token, replacedLinkId: current.id };
  });
}

/**
 * End a record's legacy record-id link now. One-way: the date can only move
 * earlier, and a record with no legacy link never gains one.
 */
export async function revokeLegacyVerifyLink(
  input: { record: RecordForShare },
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ legacy: LegacyVerifyLinkView; changed: boolean }> {
  if (!input.record.legacyVerifyUuidUntilUtc) throw new VerificationShareError("legacy_link_not_active");
  const ended = await client.evidence.updateMany({
    where: { id: input.record.id, legacyVerifyUuidUntilUtc: { gt: now } },
    data: { legacyVerifyUuidUntilUtc: now },
  });
  const until = ended.count === 1 ? now : input.record.legacyVerifyUuidUntilUtc;
  return {
    legacy: { active: false, expiresAtUtc: until.toISOString(), graceDays: LEGACY_VERIFY_LINK_GRACE_DAYS },
    changed: ended.count === 1,
  };
}

/**
 * THE INVENTORY of legacy record-id links in one workspace: how many records
 * are still reachable by their id, and until when. Read-only.
 */
export async function legacyVerifyLinkInventory(
  input: { teamId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{
  activeCount: number;
  earliestExpiryUtc: string | null;
  latestExpiryUtc: string | null;
  graceDays: number;
  records: Array<{ evidenceId: string; title: string | null; expiresAtUtc: string }>;
}> {
  const where = {
    teamId: input.teamId,
    legacyVerifyUuidUntilUtc: { gt: now },
    publicVerifyState: "PUBLISHED" as const,
    lifecycleState: { notIn: ["TRASHED" as const, "DESTROYED" as const] },
  };
  const [activeCount, bounds, records] = await Promise.all([
    client.evidence.count({ where }),
    client.evidence.aggregate({ where, _min: { legacyVerifyUuidUntilUtc: true }, _max: { legacyVerifyUuidUntilUtc: true } }),
    client.evidence.findMany({
      where,
      orderBy: [{ legacyVerifyUuidUntilUtc: "asc" }, { id: "asc" }],
      take: Math.max(1, Math.min(input.limit ?? 50, 200)),
      select: { id: true, title: true, legacyVerifyUuidUntilUtc: true },
    }),
  ]);
  return {
    activeCount,
    earliestExpiryUtc: iso(bounds._min.legacyVerifyUuidUntilUtc),
    latestExpiryUtc: iso(bounds._max.legacyVerifyUuidUntilUtc),
    graceDays: LEGACY_VERIFY_LINK_GRACE_DAYS,
    records: records.map((r) => ({
      evidenceId: r.id,
      title: r.title,
      expiresAtUtc: r.legacyVerifyUuidUntilUtc!.toISOString(),
    })),
  };
}

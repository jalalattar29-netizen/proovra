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
 * (2026-10-18) A reviewer share (pvs_) is its own capability: it never
 * depends on — and never changes — the record's disclosure policy, and it never
 * weakens the record's canonical access state (a withdrawn, suspended or
 * retained page answers the same for every identifier). What it discloses is
 * its own profile: STANDARD (content preview) or BASIC (verification only),
 * plus an explicit original-download grant.
 */
import type { PrismaClient } from "@prisma/client";
import {
  LEGACY_VERIFY_LINK_GRACE_DAYS,
  VERIFICATION_SHARE_AUDIENCE_MAX,
  VERIFICATION_SHARE_MAX_ACTIVE_OWNER_LINKS,
  legacyVerifyLinkActive,
  mintVerificationShareTokenTx,
  resolveEvidenceWorkspaceId,
  revokeVerificationShareTokenTx,
  rotateVerificationShareTokenTx,
  verificationShareStateOf,
  type VerificationShareProjection,
  type VerificationShareRow,
  type VerificationShareState,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { SHARE_GRANT_DEFAULT_LIFETIME_DAYS, SHARE_GRANT_MAX_LIFETIME_DAYS } from "@proovra/shared";

/** Members audit SEC-08 — an owner link lives at most 30 days per issue or renewal. */
export const VERIFICATION_LINK_MAX_EXPIRY_DAYS = SHARE_GRANT_MAX_LIFETIME_DAYS;
export const VERIFICATION_LINK_DEFAULT_EXPIRY_DAYS = SHARE_GRANT_DEFAULT_LIFETIME_DAYS;
export const VERIFICATION_LINK_MAX_USES_CEILING = 100_000;

export class VerificationShareError extends Error {
  constructor(
    public readonly code:
      | "link_not_found"
      | "link_not_active"
      | "too_many_active_links"
      | "record_not_shareable"
      | "legacy_link_not_active"
      | "link_lifetime_invalid"
      | "link_not_renewable",
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
  /**
   * Does following this link answer right now? An ACTIVE link on a record
   * whose verification page is withdrawn or suspended answers what the page
   * answers, and the owner is told so instead of a green "Active".
   */
  usable: boolean;
  /** Why an ACTIVE link does not answer; null when usable or not ACTIVE. */
  inactiveReason: "PAGE_NOT_AVAILABLE" | null;
  /** OWNER_SHARE only: may this link hand out the original files? */
  allowOriginalDownload: boolean;
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

export function projectVerificationLink(
  row: VerificationShareRow,
  now: Date = new Date(),
  record: { verificationAccessState: string } | null = null,
): VerificationLinkView {
  const state = verificationShareStateOf(row, now);
  // Every identifier answers the page's access state (withdrawn/suspended).
  const pageUnavailable = record !== null && record.verificationAccessState !== "AVAILABLE";
  return {
    id: row.id,
    purpose: row.purpose,
    projection: row.projection,
    audience: row.audience,
    reportVersion: row.reportVersion,
    state,
    usable: state === "ACTIVE" && !pageUnavailable,
    inactiveReason: state === "ACTIVE" && pageUnavailable ? "PAGE_NOT_AVAILABLE" : null,
    allowOriginalDownload: row.purpose === "OWNER_SHARE" && row.allowOriginalDownload === true,
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
  ownerUserId?: string | null;
  status: string;
  lifecycleState: string;
  deletedAt: Date | null;
  verificationAccessState: string;
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
      ownerUserId: true,
      status: true,
      lifecycleState: true,
      deletedAt: true,
      verificationAccessState: true,
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
  /** The canonical page's access state (AVAILABLE / WITHDRAWN / SUSPENDED). */
  verificationAccessState: string;
  links: VerificationLinkView[];
  legacy: LegacyVerifyLinkView | null;
}> {
  const rows = (await client.verificationShareToken.findMany({
    where: { evidenceId: record.id },
    orderBy: [{ createdAtUtc: "desc" }, { id: "desc" }],
    take: 500,
  })) as VerificationShareRow[];
  return {
    verificationAccessState: record.verificationAccessState,
    links: rows.map((r) => projectVerificationLink(r, now, record)),
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
  /** Days until the link expires (1..30). There is no "no expiry" (SEC-08). */
  expiresInDays: number;
  projection: VerificationShareProjection;
  maxUses: number | null;
  /** An explicit grant to hand out the original files (STANDARD links only). */
  allowOriginalDownload?: boolean;
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
  if (
    !Number.isInteger(input.expiresInDays) ||
    input.expiresInDays < 1 ||
    input.expiresInDays > VERIFICATION_LINK_MAX_EXPIRY_DAYS
  ) {
    throw new VerificationShareError("link_lifetime_invalid", { maxDays: VERIFICATION_LINK_MAX_EXPIRY_DAYS });
  }
  const expiresAtUtc = new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000);

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
      // Originals only with content: a BASIC link never downloads.
      allowOriginalDownload: input.projection === "STANDARD" && input.allowOriginalDownload === true,
      now,
    });
    const row = (await tx.verificationShareToken.findUniqueOrThrow({
      where: { id: minted.id },
    })) as VerificationShareRow;
    return { link: projectVerificationLink(row, now, record), token: minted.token };
  });
}

/**
 * UC-OUT-005 — THE WORKSPACE a record is published in: its team, or — for a
 * legacy Personal record stored with team_id NULL — its owner's personal
 * workspace (the rule the report and package writers already use). Null only
 * when neither exists.
 */
export async function resolveShareWorkspaceId(
  record: Pick<RecordForShare, "teamId" | "ownerUserId">,
  client: PrismaClient = defaultPrisma,
): Promise<string | null> {
  if (record.teamId) return record.teamId;
  return resolveEvidenceWorkspaceId({ teamId: null, ownerUserId: record.ownerUserId ?? null }, client);
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
    return { link: projectVerificationLink(row, now, input.record), changed };
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
    return { link: projectVerificationLink(row, now, input.record), token: minted.token, replacedLinkId: current.id };
  });
}

/**
 * RENEW an owner link (members audit SEC-08): an explicit, audited act that
 * sets its expiry to `days` from now (1..30). Only an owner link that has not
 * been revoked may be renewed; an expired one may be renewed by its record's
 * manager (the token is unchanged), a revoked one never.
 */
export async function renewVerificationLink(
  input: { record: RecordForShare; linkId: string; actorUserId: string; days: number },
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ link: VerificationLinkView; previousExpiresAtUtc: string | null }> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > VERIFICATION_LINK_MAX_EXPIRY_DAYS) {
    throw new VerificationShareError("link_lifetime_invalid", { maxDays: VERIFICATION_LINK_MAX_EXPIRY_DAYS });
  }
  return client.$transaction(async (tx) => {
    const current = (await tx.verificationShareToken.findFirst({
      where: { id: input.linkId, evidenceId: input.record.id },
    })) as VerificationShareRow | null;
    if (!current) throw new VerificationShareError("link_not_found");
    if (current.purpose !== "OWNER_SHARE" || current.revokedAtUtc !== null) {
      throw new VerificationShareError("link_not_renewable");
    }
    const expiresAtUtc = new Date(now.getTime() + input.days * 24 * 60 * 60 * 1000);
    const moved = await tx.verificationShareToken.updateMany({
      where: { id: current.id, revokedAtUtc: null },
      data: { expiresAtUtc },
    });
    if (moved.count === 0) throw new VerificationShareError("link_not_renewable");
    const row = (await tx.verificationShareToken.findUniqueOrThrow({
      where: { id: current.id },
    })) as VerificationShareRow;
    return {
      link: projectVerificationLink(row, now, input.record),
      previousExpiresAtUtc: current.expiresAtUtc ? current.expiresAtUtc.toISOString() : null,
    };
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
  // UC-OUT-005 — a personal workspace also owns its owner's legacy records
  // stored with team_id NULL (the resolveEvidenceWorkspaceId rule).
  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { isPersonal: true, ownerUserId: true },
  });
  const scope =
    team?.isPersonal && team.ownerUserId
      ? { OR: [{ teamId: input.teamId }, { teamId: null, ownerUserId: team.ownerUserId }] }
      : { teamId: input.teamId };
  const where = {
    ...scope,
    legacyVerifyUuidUntilUtc: { gt: now },
    // A record-id link opens the canonical page, so only a record holding its
    // reference is reachable by its id (GET /public/verify/:id).
    verificationRef: { not: null },
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

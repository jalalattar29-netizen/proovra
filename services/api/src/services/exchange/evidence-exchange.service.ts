/**
 * PROOVRA Phase 4B — Evidence Exchange Packages.
 *
 * Workspace-anchored, append-mostly lifecycle for signed, time-limited
 * evidence exchange packages. State machine:
 *
 *   DRAFT → BUILDING → READY → DELIVERED → (EXPIRED | REVOKED)
 *
 *   DRAFT → BUILDING is the build REQUEST (`requestExchangePackageBuild`),
 *   made by `createExchangePackage` and — D59 — by an operator's
 *   "Build again" on a DRAFT package (`requestExchangePackageRebuild`,
 *   POST /v1/exchange/packages/:id/build). The worker's package builder only
 *   picks up BUILDING packages, and a failed build returns the package to
 *   DRAFT (its build tracker row says FAILED; the list projects that as the
 *   bounded `lastBuild`).
 *
 * Hard rules:
 *   * Every entry point is workspace-anchored (teamId).
 *   * Bounded kind vocabulary from `EXCHANGE_PACKAGE_KINDS`.
 *   * Signed URLs are deterministic, time-bound, and persisted with
 *     their expiry — clients NEVER mint them.
 *   * Webhook emission is forward-declared (best-effort) and MUST
 *     never break the operational write.
 */

import type { PrismaClient } from "@prisma/client";
import {
  EXCHANGE_PACKAGE_KINDS,
  type ExchangePackageKind,
  type ExchangePackageProjection,
  type ExchangePackageState,
  type WebhookEventKind,
} from "@proovra/shared";
import {
  releaseExportPackageUnit,
  reserveExportPackageUnit,
  workspaceCaseWhere,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";
import { resolveEntitlement } from "../packaging/entitlement.service.js";
import { allOpen, hiddenRecordIdsInWorkspace } from "../access/record-reach.js";

import { caseVisibleToWhere, evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";

import { prisma as defaultPrisma } from "../../db.js";
import { signPackageManifest } from "./signed-delivery.service.js";
import { checkExportEligibility } from "../governance-lifecycle/export-governance.service.js";
import { presignGetObject } from "../../storage.js";
import { enforceSensitiveAction } from "../governance.service.js";

/**
 * PRO-O1Z-02 (RG-18) — an exchange package releases its records' material to
 * another party, so every included record answers THE byte-boundary verdict
 * (checkExportEligibility: effective legal hold, trash, destruction,
 * on-hold / retention-locked lifecycle, approved destruction review) with the
 * strictest audience. Asked at create, again at sign-url (a hold placed after
 * creation, or a READY package of a record trashed since, releases nothing).
 * Returns the first refusal, or null when every record may leave custody.
 */
export async function exchangeExportRefusal(
  prisma: PrismaClient,
  evidenceIds: ReadonlyArray<string>,
  actorUserId: string | null,
): Promise<{ evidenceIndex: number; outcome: string } | null> {
  const ids = [...new Set(evidenceIds)];
  const rows = await prisma.evidence.findMany({
    where: { id: { in: ids } },
    select: { id: true, teamId: true },
  });
  const teamOf = new Map(rows.map((r) => [r.id, r.teamId]));
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    if (!teamOf.has(id)) return { evidenceIndex: i, outcome: "BLOCKED_BY_POLICY" };
    const verdict = await checkExportEligibility(
      { teamId: teamOf.get(id) ?? null, evidenceId: id, actorUserId, audience: "public" },
      prisma,
    );
    if (verdict.outcome !== "ALLOWED") return { evidenceIndex: i, outcome: verdict.outcome };
  }
  return null;
}

/**
 * PRO-O1Z-02 (RG-18) — THE WORKSPACE'S PACKAGE-DOWNLOAD POLICY, for the
 * exchange package too. Every other package release asks the canonical
 * sensitive-action gate (`download_package`: the actor's role, the
 * workspace's allowPackageDownload switch and, per record, the workflow
 * template's export overlay); the exchange release asked none of it, so a
 * workspace that had turned package downloads off still handed its records
 * out through an exchange link. Asked for the ACTOR, once per included
 * record, wherever the package's bytes are released or a download is
 * authorised. Returns the first refusal, or null.
 */
export async function exchangeDownloadPolicyRefusal(
  prisma: PrismaClient,
  input: { teamId: string; actorUserId: string; evidenceIds: ReadonlyArray<string> },
): Promise<{ code: string; reason: string } | null> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: input.actorUserId } },
    select: { role: true, status: true },
  });
  const role = membership?.status === "ACTIVE" ? membership.role : undefined;
  const ids = [...new Set(input.evidenceIds)];
  // A package with no stored selection still answers the role and the switch.
  for (const id of ids.length > 0 ? ids : [""]) {
    const decision = await enforceSensitiveAction(
      "download_package",
      {
        teamId: input.teamId,
        role,
        evidence: { id, teamId: input.teamId, retentionUntilUtc: null },
        consultTemplatePolicy: id !== "",
      },
      prisma,
    );
    if (!decision.allowed) return { code: decision.code, reason: decision.reason };
  }
  return null;
}

/** PRO-BL2-07 — the one state predicate for custody records on a package. */
const RELEASABLE_PACKAGE_STATES = ["READY", "DELIVERED"] as const;

// ---------------------------------------------------------------------------
// Forward-declared webhook emitter (implemented by the webhook-platform
// service in a sibling change set). Wrapped in try/catch so we degrade
// silently if the module is not yet present at runtime.
// ---------------------------------------------------------------------------

type WebhookEmitter = (input: {
  prisma?: PrismaClient;
  teamId: string;
  eventKind: WebhookEventKind;
  payload: Record<string, unknown>;
}) => Promise<unknown> | unknown;

async function tryEmitWebhookEvent(
  eventKind: WebhookEventKind,
  payload: Record<string, unknown>,
  ctx: { prisma?: PrismaClient; teamId: string },
): Promise<void> {
  try {
    const mod = (await import(
      "../packaging/webhooks/webhook-platform.service.js"
    ).catch(() => ({}))) as { emitWebhookEvent?: WebhookEmitter };
    if (typeof mod.emitWebhookEvent === "function") {
      await mod.emitWebhookEvent({
        prisma: ctx.prisma,
        teamId: ctx.teamId,
        eventKind,
        payload,
      });
    }
  } catch {
    // Audit / fan-out failure MUST never break the operational write.
  }
}

// ---------------------------------------------------------------------------
// createExchangePackage
// ---------------------------------------------------------------------------

export type CreateExchangePackageInput = {
  prisma?: PrismaClient;
  teamId: string;
  kind: ExchangePackageKind;
  evidenceIds: ReadonlyArray<string>;
  caseId?: string | null;
  createdByUserId: string;
  scopeNote?: string | null;
  /** PRO-W1C-05 — the disclosure profile the package is built under (default FULL_FORENSIC). */
  disclosureProfile?: "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE";
};

export type CreateExchangePackageResult =
  | { ok: true; packageId: string }
  | { ok: false; denial: "INVALID_KIND" | "INVALID_EVIDENCE" | "INVALID_CASE" | "QUOTA_EXCEEDED" }
  | { ok: false; denial: "EXPORT_BLOCKED"; outcome: string };

/**
 * WS-SCHED / PRO-BL2-02 — reserve one unit of the workspace's monthly
 * export-package allowance (the conditional upsert in shared-runtime), against
 * the limit the canonical entitlement resolver answers. Null = refused.
 */
async function reserveExportUnit(prisma: PrismaClient, teamId: string): Promise<Date | null> {
  const projection = await resolveEntitlement({
    prisma,
    teamId,
    key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
  });
  const limit = typeof projection.value === "number" ? projection.value : 0;
  const res = await reserveExportPackageUnit({ prisma, teamId, limit });
  return res.reserved ? res.periodStartUtc : null;
}

/**
 * May this caller act on this package? It holds records, so it is open only if
 * every record in it is. A package built before a case was restricted closes
 * with the case. False for a package that does not exist, so a caller answers
 * both the same way.
 */
export async function exchangePackageOpenTo(input: {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  userId: string;
}): Promise<boolean> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { evidenceIds: true },
  });
  if (!row) return false;
  const ids = Array.isArray(row.evidenceIds) ? (row.evidenceIds as string[]) : [];
  const closed = await hiddenRecordIdsInWorkspace(input.teamId, input.userId, prisma);
  return allOpen(ids, closed.evidenceIds);
}

export async function createExchangePackage(
  input: CreateExchangePackageInput,
): Promise<CreateExchangePackageResult> {
  if (!(EXCHANGE_PACKAGE_KINDS as ReadonlyArray<string>).includes(input.kind)) {
    return { ok: false, denial: "INVALID_KIND" };
  }
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
    return { ok: false, denial: "INVALID_EVIDENCE" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  // Every id must belong to THIS workspace (2026-09-29). The answer does not
  // say which id failed, so it cannot be used to probe other tenants. The
  // canonical scope, not a bare `teamId`: a personal workspace's records may
  // carry team_id NULL and are still its own.
  const uniqueIds = [...new Set(input.evidenceIds)];
  const scope = await workspaceEvidenceWhere(input.teamId, prisma);
  // Reach as well as tenancy: a package hands out the record's bytes, and a
  // named caseId never stood in for the rule on the ids themselves (AUTHZ-002).
  const owned = await prisma.evidence.count({
    where: {
      AND: [
        { id: { in: uniqueIds } },
        scope,
        evidenceVisibleThroughCasesWhere(input.createdByUserId),
      ],
    },
  });
  if (owned !== uniqueIds.length) {
    return { ok: false, denial: "INVALID_EVIDENCE" };
  }
  // PRO-O1Z-02 — held, trashed or destruction-bound records do not leave
  // custody through an exchange package (the rule every other export obeys).
  const blocked = await exchangeExportRefusal(prisma, uniqueIds, input.createdByUserId);
  if (blocked) return { ok: false, denial: "EXPORT_BLOCKED", outcome: blocked.outcome };
  // A NAMED CASE must be in this workspace and visible to the requester — a
  // restricted case is visible only to its owner and its access list
  // (2026-09-29). Same answer for "absent" and "not yours".
  if (input.caseId) {
    const caseScope = await workspaceCaseWhere(input.teamId, prisma);
    const visible = await prisma.case.count({
      where: { AND: [{ id: input.caseId }, caseScope, caseVisibleToWhere(input.createdByUserId)] },
    });
    if (visible !== 1) return { ok: false, denial: "INVALID_CASE" };
  }
  // PRO-BL2-02 — the allowance is RESERVED here, before anything is written;
  // the worker's READY step does not meter a reserved package again, and a
  // failed build gives the unit back.
  const reservedPeriod = await reserveExportUnit(prisma, input.teamId);
  if (!reservedPeriod) return { ok: false, denial: "QUOTA_EXCEEDED" };
  let row: { id: string };
  try {
    row = await prisma.evidenceExchangePackage.create({
      data: {
        teamId: input.teamId,
        kind: input.kind,
        state: "DRAFT",
        evidenceIds: input.evidenceIds as unknown as object,
        caseId: input.caseId ?? null,
        scopeNote: input.scopeNote?.slice(0, 400) ?? null,
        createdByUserId: input.createdByUserId,
        quotaReservedPeriodStartUtc: reservedPeriod,
        disclosureProfile: input.disclosureProfile === "EXTERNAL_DISCLOSURE" ? "EXTERNAL_DISCLOSURE" : "FULL_FORENSIC",
      },
      select: { id: true },
    });
  } catch (err) {
    await releaseExportPackageUnit({ prisma, teamId: input.teamId, periodStartUtc: reservedPeriod });
    throw err;
  }

  // Seed the build tracker row so the worker can pick it up immediately.
  // EvidenceExchangePackageBuild is in the schema but the Prisma client has
  // not been re-generated yet — use raw SQL to avoid a blocker.
  await prisma
    .$executeRaw`
      INSERT INTO evidence_exchange_package_builds
        (id, team_id, package_id, state, created_at)
      VALUES
        (gen_random_uuid(), ${input.teamId}::uuid, ${row.id}, 'PENDING', NOW())
      ON CONFLICT (package_id) DO NOTHING
    `
    .catch(() => {
      // Non-fatal — the worker will upsert the row when it picks up the job.
    });
  // Creating a package IS the product's build request: the Exchange page has
  // no separate "build" action, and the worker only builds BUILDING packages.
  // Without this transition every package stayed DRAFT forever.
  await requestExchangePackageBuild({
    prisma,
    teamId: input.teamId,
    packageId: row.id,
  });
  void tryEmitWebhookEvent(
    "PACKAGE_CREATED",
    {
      packageId: row.id,
      teamId: input.teamId,
      kind: input.kind,
      evidenceCount: input.evidenceIds.length,
      caseId: input.caseId ?? null,
      createdByUserId: input.createdByUserId,
    },
    { prisma, teamId: input.teamId },
  );
  return { ok: true, packageId: row.id };
}

// ---------------------------------------------------------------------------
// requestExchangePackageBuild — DRAFT → BUILDING
// ---------------------------------------------------------------------------

/**
 * Hand a DRAFT package to the worker's package builder.
 *
 * Conditional on the current state, so a package that is already BUILDING,
 * READY or later is never pulled back, and two concurrent requests move it
 * once. Returns `requested: false` when nothing moved.
 */
export async function requestExchangePackageBuild(input: {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  /** PRO-BL2-02 — a reservation taken for THIS build (rebuild path). */
  reservedPeriodStartUtc?: Date;
}): Promise<{ requested: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const moved = await prisma.evidenceExchangePackage.updateMany({
    where: { id: input.packageId, teamId: input.teamId, state: "DRAFT" },
    data: input.reservedPeriodStartUtc
      ? { state: "BUILDING", quotaReservedPeriodStartUtc: input.reservedPeriodStartUtc }
      : { state: "BUILDING" },
  });
  return { requested: moved.count === 1 };
}

// ---------------------------------------------------------------------------
// requestExchangePackageRebuild — operator "Build again" (D59)
// ---------------------------------------------------------------------------

export type RequestExchangePackageRebuildResult =
  | { ok: true; previousState: "DRAFT" }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "QUOTA_EXCEEDED" }
  | { ok: false; reason: "NOT_DRAFT"; state: ExchangePackageState };

/**
 * Ask the builder to build a DRAFT package again (a failed build returns the
 * package to DRAFT, and until this existed nothing could move it on).
 *
 * Workspace-anchored: a package in another workspace is NOT_FOUND, exactly
 * like a missing one. The transition is the same conditional DRAFT → BUILDING
 * write the creation path uses, so a concurrent request or a package that
 * moved on meanwhile is reported as NOT_DRAFT with the state it is in now.
 */
export async function requestExchangePackageRebuild(input: {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
}): Promise<RequestExchangePackageRebuildResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const current = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { state: true, quotaReservedPeriodStartUtc: true },
  });
  if (!current) return { ok: false, reason: "NOT_FOUND" };
  if (current.state !== "DRAFT") {
    return { ok: false, reason: "NOT_DRAFT", state: current.state as ExchangePackageState };
  }
  // PRO-BL2-02 — "Build again" re-reserves the unit the failed build gave back.
  // A DRAFT that still holds its reservation (a failure recorded by an older
  // worker image) keeps it rather than taking a second unit.
  const held = current.quotaReservedPeriodStartUtc ?? null;
  const reservedPeriodStartUtc = held ?? (await reserveExportUnit(prisma, input.teamId));
  if (!reservedPeriodStartUtc) return { ok: false, reason: "QUOTA_EXCEEDED" };
  const { requested } = await requestExchangePackageBuild({ ...input, reservedPeriodStartUtc });
  if (requested) return { ok: true, previousState: "DRAFT" };
  if (!held) {
    await releaseExportPackageUnit({ prisma, teamId: input.teamId, periodStartUtc: reservedPeriodStartUtc });
  }
  const now = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { state: true },
  });
  if (!now) return { ok: false, reason: "NOT_FOUND" };
  return { ok: false, reason: "NOT_DRAFT", state: now.state as ExchangePackageState };
}

// ---------------------------------------------------------------------------
// generateSignedUrl
// ---------------------------------------------------------------------------

export type GenerateSignedUrlInput = {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  ttlSeconds: number;
  baseUrl?: string;
  /**
   * PRO-O1Z-02 — who is asking for the bytes. The route always names the
   * caller; the workspace package-download policy is then decided for them.
   */
  actorUserId?: string;
};

export type GenerateSignedUrlResult =
  | { ok: true; signedUrl: string; expiresAtUtc: string }
  | { ok: false; denial: "PACKAGE_NOT_FOUND" | "PACKAGE_NOT_READY" | "DOWNLOAD_UNAVAILABLE" }
  | { ok: false; denial: "EXPORT_BLOCKED"; outcome: string }
  | { ok: false; denial: "POLICY_BLOCKED"; code: string; reason: string };

export async function generateSignedUrl(
  input: GenerateSignedUrlInput,
): Promise<GenerateSignedUrlResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, state: true, packageSha256: true, evidenceIds: true, storageKey: true },
  });
  if (!row) return { ok: false, denial: "PACKAGE_NOT_FOUND" };
  if (row.state !== "READY" && row.state !== "DELIVERED") {
    return { ok: false, denial: "PACKAGE_NOT_READY" };
  }
  // PRO-O1Z-02 — re-checked at release: a READY package of a record held,
  // trashed or bound for destruction since it was built is not handed out.
  const included = Array.isArray(row.evidenceIds) ? (row.evidenceIds as string[]) : [];
  // PRO-O1Z-02 — the workspace's package-download policy, before anything
  // is minted, recorded or announced.
  if (input.actorUserId) {
    const policy = await exchangeDownloadPolicyRefusal(prisma, {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      evidenceIds: included,
    });
    if (policy) return { ok: false, denial: "POLICY_BLOCKED", ...policy };
  }
  const blocked = await exchangeExportRefusal(prisma, included, input.actorUserId ?? null);
  if (blocked) return { ok: false, denial: "EXPORT_BLOCKED", outcome: blocked.outcome };
  const ttlSeconds = Math.max(60, Math.min(input.ttlSeconds, 7 * 24 * 60 * 60));
  /*
   * PRO-O1Z-03 (RG-18) — A LINK THAT RESOLVES. The URL used to point at
   * EXCHANGE_DOWNLOAD_BASE_URL, defaulting to a host nothing serves
   * (download.proovra.local), so the flow ended in a link that delivered
   * nothing. An operator-configured download host keeps the signed-token
   * contract; without one the stored ZIP itself is presigned (bounded expiry,
   * stated truthfully), and with neither nothing is minted.
   */
  const configuredBase = input.baseUrl ?? process.env.EXCHANGE_DOWNLOAD_BASE_URL ?? null;
  let signedUrl: string;
  let expiresAt: Date;
  let expiresAtUtc: string;
  if (configuredBase) {
    const signed = await signPackageManifest({
      packageId: row.id,
      payloadHash: row.packageSha256 ?? "",
      ttlSeconds,
    });
    const base = configuredBase.replace(/\/$/, "/");
    signedUrl = `${base}${row.id}?token=${signed.token}`.slice(0, 1024);
    expiresAtUtc = signed.expiresAtUtc;
    expiresAt = new Date(signed.expiresAtUtc);
  } else {
    const bucket = process.env.S3_BUCKET?.trim();
    if (!row.storageKey || !bucket) return { ok: false, denial: "DOWNLOAD_UNAVAILABLE" };
    const presignSeconds = Math.min(ttlSeconds, 600);
    signedUrl = await presignGetObject({
      bucket,
      key: row.storageKey,
      expiresInSeconds: presignSeconds,
      responseContentType: "application/zip",
      responseContentDisposition: `attachment; filename="exchange-package-${row.id}.zip"`,
    });
    expiresAt = new Date(Date.now() + presignSeconds * 1000);
    expiresAtUtc = expiresAt.toISOString();
  }
  // ET-SEC-19 — the bearer URL is handed to the privileged caller that minted
  // it (generate_package + step-up) and NEVER stored: the list projection is
  // readable by every evidence.read member, and a stored URL leaked a 7-day
  // package token to all of them. Only the expiry is kept, and any URL a
  // previous release stored is cleared on the next mint.
  await prisma.evidenceExchangePackage.update({
    where: { id: row.id },
    data: {
      signedUrl: null,
      signedUrlExpiresAtUtc: expiresAt,
    },
  });
  void tryEmitWebhookEvent(
    "PACKAGE_CREATED",
    {
      packageId: row.id,
      teamId: input.teamId,
      lifecycle: "PACKAGE_READY",
      expiresAtUtc,
    },
    { prisma, teamId: input.teamId },
  );
  return { ok: true, signedUrl, expiresAtUtc };
}

// ---------------------------------------------------------------------------
// recordPackageDelivery
// ---------------------------------------------------------------------------

export type RecordPackageDeliveryInput = {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  recipientEmail?: string | null;
  recipientOrgSlug?: string | null;
  channel?: string | null;
  ipAddressHash?: string | null;
};

export async function recordPackageDelivery(
  input: RecordPackageDeliveryInput,
): Promise<{ ok: boolean; deliveryId?: string; denial?: "PACKAGE_NOT_READY" }> {
  const prisma = input.prisma ?? defaultPrisma;
  const pkg = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!pkg) return { ok: false };
  // PRO-BL2-07 (RG-18) — a delivery is recorded only for a package that can
  // be released (READY / DELIVERED), never a revoked, expired, draft or
  // building one. Re-checked inside the write below under a row lock, so a
  // revoke that commits first refuses the delivery.
  if (!(RELEASABLE_PACKAGE_STATES as ReadonlyArray<string>).includes(pkg.state)) {
    return { ok: false, denial: "PACKAGE_NOT_READY" };
  }
  const recorded = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ state: string }>>`
      SELECT state FROM evidence_exchange_packages WHERE id = ${pkg.id}::uuid FOR UPDATE`;
    if (!locked[0] || !(RELEASABLE_PACKAGE_STATES as ReadonlyArray<string>).includes(locked[0].state)) return null;
    const created = await tx.evidenceExchangePackageDelivery.create({
    data: {
      teamId: input.teamId,
      packageId: pkg.id,
      recipientEmail: input.recipientEmail?.slice(0, 320) ?? null,
      recipientOrgSlug: input.recipientOrgSlug?.slice(0, 120) ?? null,
      channel: (input.channel ?? "SIGNED_URL").slice(0, 20),
      ipAddressHash: input.ipAddressHash?.slice(0, 64) ?? null,
    },
    select: { id: true },
  });
    if (locked[0].state === "READY") {
      await tx.evidenceExchangePackage.updateMany({
        where: { id: pkg.id, state: "READY" },
        data: { state: "DELIVERED", deliveredAtUtc: new Date() },
      });
    }
    return created;
  });
  if (!recorded) return { ok: false, denial: "PACKAGE_NOT_READY" };
  return { ok: true, deliveryId: recorded.id };
}

// ---------------------------------------------------------------------------
// listPackageDeliveries
//
// PHASE 12B — DURABLE delivery history. The Exchange surface previously held
// deliveries only in session state, so a reload lost the record of who a
// package was released to. This is the canonical read.
//
// Safety contract:
//   * The PACKAGE is resolved from persistence and its teamId is what scopes
//     the query — the caller's claimed tenant never widens the result set.
//   * The projection carries NO bucket, key, signed URL or provider secret.
//   * `downloadedAtUtc` is emitted only when a transfer was actually
//     confirmed; authorisation is reported separately and honestly.
//   * A package in another workspace is indistinguishable from a missing one
//     (no existence leak).
// ---------------------------------------------------------------------------

export type PackageDeliveryProjection = {
  id: string;
  channel: string;
  recipientEmail: string | null;
  recipientOrgSlug: string | null;
  deliveredAtUtc: string | null;
  /** Authorisation / link issuance — NOT proof of transfer. */
  downloadAuthorizedAtUtc: string | null;
  /** Confirmed transfer completion only; null while unproven. */
  downloadedAtUtc: string | null;
  verifiedAtUtc: string | null;
};

const DELIVERY_PAGE_MAX = 100;

export async function listPackageDeliveries(input: {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  /** Opaque cursor = last delivery id from the previous page. */
  cursor?: string | null;
  limit?: number;
}): Promise<
  | { ok: true; deliveries: PackageDeliveryProjection[]; nextCursor: string | null }
  | { ok: false }
> {
  const prisma = input.prisma ?? defaultPrisma;
  const take = Math.min(Math.max(input.limit ?? 25, 1), DELIVERY_PAGE_MAX);

  // Authoritative package → workspace resolution from persistence.
  const pkg = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, teamId: true },
  });
  if (!pkg) return { ok: false };

  // Stable deterministic ordering: newest first, id as the tiebreak so the
  // cursor can never skip or repeat a row when timestamps collide.
  const rows = await prisma.evidenceExchangePackageDelivery.findMany({
    where: { packageId: pkg.id, teamId: pkg.teamId },
    orderBy: [{ deliveredAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      channel: true,
      recipientEmail: true,
      recipientOrgSlug: true,
      deliveredAtUtc: true,
      downloadAuthorizedAtUtc: true,
      downloadedAtUtc: true,
      verifiedAtUtc: true,
    },
  });

  const page = rows.slice(0, take);
  return {
    ok: true,
    deliveries: page.map((r) => ({
      id: r.id,
      channel: r.channel,
      recipientEmail: r.recipientEmail,
      recipientOrgSlug: r.recipientOrgSlug,
      deliveredAtUtc: r.deliveredAtUtc?.toISOString() ?? null,
      downloadAuthorizedAtUtc: r.downloadAuthorizedAtUtc?.toISOString() ?? null,
      downloadedAtUtc: r.downloadedAtUtc?.toISOString() ?? null,
      verifiedAtUtc: r.verifiedAtUtc?.toISOString() ?? null,
    })),
    nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// recordPackageDownload
//
// PHASE 12B — truthful audit semantics. This path runs when the server
// AUTHORISES a delivery download and (separately) a short-lived link is
// minted. It has NO transfer-completion signal: the bytes move from storage
// to the recipient without passing through here, and the link may never be
// used. It therefore emits PACKAGE_DOWNLOAD_AUTHORIZED, not
// PACKAGE_DOWNLOADED. PACKAGE_DOWNLOADED is reserved for a real completion
// signal (server streaming/proxy completion or a verified storage-access
// event); emitting it here would assert a transfer that may not have
// happened. `downloadedAtUtc` is preserved as the FIRST-authorisation
// timestamp (unchanged column semantics, still first-write-wins).
// ---------------------------------------------------------------------------

export type RecordPackageDownloadInput = {
  prisma?: PrismaClient;
  teamId: string;
  deliveryId: string;
  ipAddressHash?: string | null;
  /** PRO-O1Z-02 — who is authorising the download (policy is decided for them). */
  actorUserId?: string;
};

export async function recordPackageDownload(
  input: RecordPackageDownloadInput,
): Promise<{ ok: boolean; denial?: "PACKAGE_NOT_READY" | "POLICY_BLOCKED"; code?: string; reason?: string }> {
  const prisma = input.prisma ?? defaultPrisma;
  const delivery = await prisma.evidenceExchangePackageDelivery.findFirst({
    where: { id: input.deliveryId, teamId: input.teamId },
    select: { id: true, packageId: true, downloadAuthorizedAtUtc: true },
  });
  if (!delivery) return { ok: false };
  // PRO-BL2-07 — no download authorisation (nor its webhook) for a package
  // that is revoked, expired or was never built.
  const pkgState = await prisma.evidenceExchangePackage.findFirst({
    where: { id: delivery.packageId, teamId: input.teamId },
    select: { state: true, evidenceIds: true },
  });
  if (!pkgState || !(RELEASABLE_PACKAGE_STATES as ReadonlyArray<string>).includes(pkgState.state)) {
    return { ok: false, denial: "PACKAGE_NOT_READY" };
  }
  // PRO-O1Z-02 — no download is authorised (and no webhook says one was)
  // where the workspace's package-download policy refuses the caller.
  if (input.actorUserId) {
    const policy = await exchangeDownloadPolicyRefusal(prisma, {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      evidenceIds: Array.isArray(pkgState.evidenceIds) ? (pkgState.evidenceIds as string[]) : [],
    });
    if (policy) return { ok: false, denial: "POLICY_BLOCKED", ...policy };
  }
  // Record the AUTHORISATION (first one wins). `downloadedAtUtc` is
  // deliberately NOT written here: this path has no transfer-completion
  // signal, and setting it would assert a download that may never occur.
  if (!delivery.downloadAuthorizedAtUtc) {
    await prisma.evidenceExchangePackageDelivery.update({
      where: { id: delivery.id },
      data: {
        downloadAuthorizedAtUtc: new Date(),
        ipAddressHash:
          input.ipAddressHash?.slice(0, 64) ?? undefined,
      },
    });
  }
  void tryEmitWebhookEvent(
    "PACKAGE_DOWNLOAD_AUTHORIZED",
    {
      packageId: delivery.packageId,
      deliveryId: delivery.id,
      teamId: input.teamId,
    },
    { prisma, teamId: input.teamId },
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// revokePackage
// ---------------------------------------------------------------------------

export type RevokePackageInput = {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  actorUserId: string;
};

/**
 * `revoked` is true only for the call that actually moved the package to
 * REVOKED (conditional on the state it read), so the caller audits a real
 * change once and a replay as a no-op.
 */
export async function revokePackage(
  input: RevokePackageInput,
): Promise<{ ok: boolean; revoked?: boolean; previousState?: string }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, state: true, quotaReservedPeriodStartUtc: true },
  });
  if (!row) return { ok: false };
  if (row.state === "REVOKED") {
    return { ok: true, revoked: false, previousState: row.state };
  }
  // PRO-BL2-02 — a package revoked before READY never consumed its reserved
  // unit; the move that revokes it gives the unit back (once: the update is
  // conditional on the state and reservation it read).
  const releases =
    (row.state === "DRAFT" || row.state === "BUILDING") && row.quotaReservedPeriodStartUtc !== null;
  const moved = await prisma.evidenceExchangePackage.updateMany({
    where: {
      id: row.id,
      teamId: input.teamId,
      state: row.state,
      ...(releases ? { quotaReservedPeriodStartUtc: row.quotaReservedPeriodStartUtc } : {}),
    },
    data: {
      state: "REVOKED",
      revokedAtUtc: new Date(),
      signedUrl: null,
      signedUrlExpiresAtUtc: null,
      ...(releases ? { quotaReservedPeriodStartUtc: null } : {}),
    },
  });
  if (releases && moved.count === 1 && row.quotaReservedPeriodStartUtc) {
    await releaseExportPackageUnit({
      prisma,
      teamId: input.teamId,
      periodStartUtc: row.quotaReservedPeriodStartUtc,
    });
  }
  return { ok: true, revoked: moved.count === 1, previousState: row.state };
}

// ---------------------------------------------------------------------------
// listPackages
// ---------------------------------------------------------------------------

export type ListPackagesInput = {
  prisma?: PrismaClient;
  teamId: string;
  /** The reader: a package holding a record closed to them is not listed. */
  viewerUserId: string;
  kind?: ExchangePackageKind;
  state?: ExchangePackageState;
  limit?: number;
};

/**
 * D59 — the bounded outcome of a package's most recent build, when it failed.
 * Read from the build tracker's state + completion time only: the tracker's
 * free-text `failure_reason` is an internal error message and never leaves
 * the API.
 */
export type ExchangePackageLastBuild = {
  state: "FAILED";
  failedAtUtc: string | null;
};

export type ExchangePackageListItem = ExchangePackageProjection & {
  lastBuild: ExchangePackageLastBuild | null;
};

export async function listPackages(
  input: ListPackagesInput,
): Promise<ReadonlyArray<ExchangePackageListItem>> {
  const prisma = input.prisma ?? defaultPrisma;
  const limit = Math.min(input.limit ?? 100, 500);
  const closed = await hiddenRecordIdsInWorkspace(input.teamId, input.viewerUserId, prisma);
  const rows = (
    await prisma.evidenceExchangePackage.findMany({
      where: {
        teamId: input.teamId,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.state ? { state: input.state } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { _count: { select: { deliveries: true } } },
    })
  ).filter((r) => allOpen(Array.isArray(r.evidenceIds) ? (r.evidenceIds as string[]) : [], closed.evidenceIds));
  const failedBuilds =
    rows.length === 0
      ? []
      : await prisma.evidenceExchangePackageBuild.findMany({
          where: {
            teamId: input.teamId,
            packageId: { in: rows.map((r) => r.id) },
            state: "FAILED",
          },
          select: { packageId: true, completedAtUtc: true },
        });
  const failedAt = new Map(
    failedBuilds.map((b) => [b.packageId, b.completedAtUtc?.toISOString() ?? null]),
  );
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    kind: r.kind as ExchangePackageKind,
    state: r.state as ExchangePackageState,
    evidenceIds: Array.isArray(r.evidenceIds)
      ? (r.evidenceIds as ReadonlyArray<string>)
      : [],
    caseId: r.caseId,
    scopeNote: r.scopeNote,
    // ET-SEC-19 — no bearer URL in a member-readable projection (rows written
    // before this release may still carry one until it expires).
    signedUrlExpiresAtUtc: r.signedUrlExpiresAtUtc?.toISOString() ?? null,
    packageSha256: r.packageSha256,
    packageSizeBytes:
      r.packageSizeBytes === null ? null : Number(r.packageSizeBytes),
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    readyAtUtc: r.readyAtUtc?.toISOString() ?? null,
    deliveredAtUtc: r.deliveredAtUtc?.toISOString() ?? null,
    expiredAtUtc: r.expiredAtUtc?.toISOString() ?? null,
    revokedAtUtc: r.revokedAtUtc?.toISOString() ?? null,
    deliveryCount: r._count?.deliveries ?? 0,
    lastBuild: failedAt.has(r.id)
      ? { state: "FAILED" as const, failedAtUtc: failedAt.get(r.id) ?? null }
      : null,
  }));
}

// Compile-time guard.
function _assertEnumsIntact(): void {
  const _k: ExchangePackageKind = "EVIDENCE";
  void _k;
  void EXCHANGE_PACKAGE_KINDS;
}
void _assertEnumsIntact;

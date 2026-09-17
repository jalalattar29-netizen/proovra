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

import { prisma as defaultPrisma } from "../../db.js";
import { signPackageManifest } from "./signed-delivery.service.js";

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
};

export type CreateExchangePackageResult =
  | { ok: true; packageId: string }
  | { ok: false; denial: "INVALID_KIND" | "INVALID_EVIDENCE" };

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
  const row = await prisma.evidenceExchangePackage.create({
    data: {
      teamId: input.teamId,
      kind: input.kind,
      state: "DRAFT",
      evidenceIds: input.evidenceIds as unknown as object,
      caseId: input.caseId ?? null,
      scopeNote: input.scopeNote?.slice(0, 400) ?? null,
      createdByUserId: input.createdByUserId,
    },
    select: { id: true },
  });

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
}): Promise<{ requested: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const moved = await prisma.evidenceExchangePackage.updateMany({
    where: { id: input.packageId, teamId: input.teamId, state: "DRAFT" },
    data: { state: "BUILDING" },
  });
  return { requested: moved.count === 1 };
}

// ---------------------------------------------------------------------------
// requestExchangePackageRebuild — operator "Build again" (D59)
// ---------------------------------------------------------------------------

export type RequestExchangePackageRebuildResult =
  | { ok: true; previousState: "DRAFT" }
  | { ok: false; reason: "NOT_FOUND" }
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
    select: { state: true },
  });
  if (!current) return { ok: false, reason: "NOT_FOUND" };
  if (current.state !== "DRAFT") {
    return { ok: false, reason: "NOT_DRAFT", state: current.state as ExchangePackageState };
  }
  const { requested } = await requestExchangePackageBuild(input);
  if (requested) return { ok: true, previousState: "DRAFT" };
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
};

export type GenerateSignedUrlResult =
  | { ok: true; signedUrl: string; expiresAtUtc: string }
  | { ok: false; denial: "PACKAGE_NOT_FOUND" | "PACKAGE_NOT_READY" };

export async function generateSignedUrl(
  input: GenerateSignedUrlInput,
): Promise<GenerateSignedUrlResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, state: true, packageSha256: true },
  });
  if (!row) return { ok: false, denial: "PACKAGE_NOT_FOUND" };
  if (row.state !== "READY" && row.state !== "DELIVERED") {
    return { ok: false, denial: "PACKAGE_NOT_READY" };
  }
  const ttlSeconds = Math.max(60, Math.min(input.ttlSeconds, 7 * 24 * 60 * 60));
  const signed = await signPackageManifest({
    packageId: row.id,
    payloadHash: row.packageSha256 ?? "",
    ttlSeconds,
  });
  const base = (input.baseUrl ?? process.env.EXCHANGE_DOWNLOAD_BASE_URL ?? "https://download.proovra.local/exchange/").replace(/\/$/, "/");
  const signedUrl = `${base}${row.id}?token=${signed.token}`.slice(0, 1024);
  const expiresAt = new Date(signed.expiresAtUtc);
  await prisma.evidenceExchangePackage.update({
    where: { id: row.id },
    data: {
      signedUrl,
      signedUrlExpiresAtUtc: expiresAt,
    },
  });
  void tryEmitWebhookEvent(
    "PACKAGE_CREATED",
    {
      packageId: row.id,
      teamId: input.teamId,
      lifecycle: "PACKAGE_READY",
      expiresAtUtc: signed.expiresAtUtc,
    },
    { prisma, teamId: input.teamId },
  );
  return { ok: true, signedUrl, expiresAtUtc: signed.expiresAtUtc };
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
): Promise<{ ok: boolean; deliveryId?: string }> {
  const prisma = input.prisma ?? defaultPrisma;
  const pkg = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!pkg) return { ok: false };
  const delivery = await prisma.evidenceExchangePackageDelivery.create({
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
  if (pkg.state === "READY") {
    await prisma.evidenceExchangePackage.update({
      where: { id: pkg.id },
      data: { state: "DELIVERED", deliveredAtUtc: new Date() },
    });
  }
  return { ok: true, deliveryId: delivery.id };
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
};

export async function recordPackageDownload(
  input: RecordPackageDownloadInput,
): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const delivery = await prisma.evidenceExchangePackageDelivery.findFirst({
    where: { id: input.deliveryId, teamId: input.teamId },
    select: { id: true, packageId: true, downloadAuthorizedAtUtc: true },
  });
  if (!delivery) return { ok: false };
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
    select: { id: true, state: true },
  });
  if (!row) return { ok: false };
  if (row.state === "REVOKED") {
    return { ok: true, revoked: false, previousState: row.state };
  }
  const moved = await prisma.evidenceExchangePackage.updateMany({
    where: { id: row.id, teamId: input.teamId, state: row.state },
    data: {
      state: "REVOKED",
      revokedAtUtc: new Date(),
      signedUrl: null,
      signedUrlExpiresAtUtc: null,
    },
  });
  return { ok: true, revoked: moved.count === 1, previousState: row.state };
}

// ---------------------------------------------------------------------------
// listPackages
// ---------------------------------------------------------------------------

export type ListPackagesInput = {
  prisma?: PrismaClient;
  teamId: string;
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
  const rows = await prisma.evidenceExchangePackage.findMany({
    where: {
      teamId: input.teamId,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { _count: { select: { deliveries: true } } },
  });
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
    signedUrl: r.signedUrl,
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

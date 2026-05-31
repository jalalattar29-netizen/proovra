/**
 * PROOVRA Phase 4B — Evidence Exchange Packages.
 *
 * Workspace-anchored, append-mostly lifecycle for signed, time-limited
 * evidence exchange packages. State machine:
 *
 *   DRAFT → READY → DELIVERED → (EXPIRED | REVOKED)
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
// markPackageReady
// ---------------------------------------------------------------------------

export type MarkPackageReadyInput = {
  prisma?: PrismaClient;
  teamId: string;
  packageId: string;
  storageKey: string;
  packageSha256: string;
  packageSizeBytes: number | bigint;
};

export async function markPackageReady(
  input: MarkPackageReadyInput,
): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!row) return { ok: false };
  if (row.state !== "DRAFT" && row.state !== "BUILDING") return { ok: false };
  await prisma.evidenceExchangePackage.update({
    where: { id: row.id },
    data: {
      state: "READY",
      storageKey: input.storageKey.slice(0, 400),
      packageSha256: input.packageSha256.slice(0, 64),
      packageSizeBytes: BigInt(input.packageSizeBytes),
      readyAtUtc: new Date(),
    },
  });
  return { ok: true };
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
// recordPackageDownload
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
    select: { id: true, packageId: true, downloadedAtUtc: true },
  });
  if (!delivery) return { ok: false };
  if (!delivery.downloadedAtUtc) {
    await prisma.evidenceExchangePackageDelivery.update({
      where: { id: delivery.id },
      data: {
        downloadedAtUtc: new Date(),
        ipAddressHash:
          input.ipAddressHash?.slice(0, 64) ?? undefined,
      },
    });
  }
  void tryEmitWebhookEvent(
    "PACKAGE_DOWNLOADED",
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

export async function revokePackage(
  input: RevokePackageInput,
): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.evidenceExchangePackage.findFirst({
    where: { id: input.packageId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!row) return { ok: false };
  if (row.state === "REVOKED") return { ok: true };
  await prisma.evidenceExchangePackage.update({
    where: { id: row.id },
    data: {
      state: "REVOKED",
      revokedAtUtc: new Date(),
      signedUrl: null,
      signedUrlExpiresAtUtc: null,
    },
  });
  return { ok: true };
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

export async function listPackages(
  input: ListPackagesInput,
): Promise<ReadonlyArray<ExchangePackageProjection>> {
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
  }));
}

// Compile-time guard.
function _assertEnumsIntact(): void {
  const _k: ExchangePackageKind = "EVIDENCE";
  void _k;
  void EXCHANGE_PACKAGE_KINDS;
}
void _assertEnumsIntact;

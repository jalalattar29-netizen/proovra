/**
 * Phase P3.1 — Canonical signer registry (read-model).
 *
 * Single source of truth for signer state across PROOVRA.
 *
 * Design choice: this is a DETERMINISTIC READ-MODEL combining:
 *   * env-resolved current configuration (`SIGNER_PROVIDER`,
 *     `SIGNING_KEY_ID`, `SIGNING_KEY_VERSION`,
 *     `PACKAGE_SIGNING_KEY_ID`, `PACKAGE_SIGNING_KEY_VERSION`,
 *     `KMS_KEY_ID`)
 *   * audit-event history (`signer_staged`, `signer_promoted`,
 *     `signer_retired`, `signer_revoked`) read from `SecurityEvent`
 *
 * A dedicated `Signer` Prisma model is **deferred** — adding it
 * requires a coordinated migration + worker redeploy. The read-model
 * approach gives us:
 *   * an honest current-active answer (from env)
 *   * a verified rotation history (from audit events)
 *   * no fake state when AWS / KMS is unreachable
 *
 * Migration plan: see `docs/security/signer-governance.md` §8.
 *
 * Hard rules:
 *   * Historical artifacts (Report.pdfSignerKeyId,
 *     VerificationPackage.* signing fields) are NEVER mutated.
 *   * The registry tracks FUTURE signing only.
 *   * No private key material is ever returned.
 *   * KMS ARNs / region are operator-safe to expose.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

export const SIGNER_PURPOSES = [
  "report_pdf",
  "verification_package",
  "export_manifest",
  "custody_event",
] as const;
export type SignerPurpose = (typeof SIGNER_PURPOSES)[number];

export const SIGNER_PROVIDERS = [
  "aws_kms",
  "local_pem",
  "disabled",
] as const;
export type SignerProvider = (typeof SIGNER_PROVIDERS)[number];

export const SIGNER_STATUSES = [
  "active",
  "staged",
  "retiring",
  "retired",
  "revoked",
  "degraded",
] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export type SignerRecord = {
  /** Stable composite id: `${purpose}:${provider}:${keyId}:${keyVersion}`. */
  signerId: string;
  signerPurpose: SignerPurpose;
  provider: SignerProvider;
  keyId: string | null;
  keyVersion: string | null;
  kmsKeyArn: string | null;
  algorithm: string | null;
  status: SignerStatus;
  activatedAtUtc: string | null;
  retiredAtUtc: string | null;
  lastUsedAtUtc: string | null;
  createdByUserId: string | null;
  rotatedByUserId: string | null;
  notes: string | null;
  /** Operator-safe public material reference. NEVER private key. */
  verificationMaterialRef: string | null;
  /** null = platform-wide; populated when a workspace overrides. */
  teamId: string | null;
};

// ---------------------------------------------------------------------------
// Env-derived current active signer per purpose
// ---------------------------------------------------------------------------

function envProvider(): SignerProvider {
  const raw = (process.env.SIGNER_PROVIDER ?? "local-pem")
    .trim()
    .toLowerCase();
  if (raw === "aws-kms" || raw === "aws_kms") return "aws_kms";
  if (raw === "disabled") return "disabled";
  return "local_pem";
}

function envValue(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : null;
}

function buildSignerId(
  purpose: SignerPurpose,
  provider: SignerProvider,
  keyId: string | null,
  keyVersion: string | null,
): string {
  return `${purpose}:${provider}:${keyId ?? "_"}:${keyVersion ?? "_"}`;
}

function evidenceAlgorithm(provider: SignerProvider): string | null {
  if (provider === "aws_kms") return "ED25519_SHA_512";
  if (provider === "local_pem") return "ED25519";
  return null;
}

/**
 * The current ACTIVE signer per purpose. Derived from env. This is
 * what subsequent signing operations will use.
 */
export function getCurrentActiveSigners(): ReadonlyArray<SignerRecord> {
  const provider = envProvider();
  const now = new Date().toISOString();
  const kmsArn =
    provider === "aws_kms" ? envValue("KMS_KEY_ID") : null;

  // Evidence fingerprint / report PDF / custody — all use the
  // canonical SIGNING_KEY_ID + SIGNING_KEY_VERSION env pair today.
  const evidKeyId = envValue("SIGNING_KEY_ID");
  const evidKeyVersion = envValue("SIGNING_KEY_VERSION");

  // Verification Package uses dedicated env vars when set; falls
  // back to the canonical pair.
  const pkgKeyId =
    envValue("PACKAGE_SIGNING_KEY_ID") ?? evidKeyId;
  const pkgKeyVersion =
    envValue("PACKAGE_SIGNING_KEY_VERSION") ?? evidKeyVersion;

  // Export manifests use the same canonical key (no separate env).
  const exportKeyId = evidKeyId;
  const exportKeyVersion = evidKeyVersion;

  const verificationRef =
    provider === "aws_kms"
      ? "kms://GetPublicKey"
      : provider === "local_pem"
        ? envValue("SIGNING_PUBLIC_KEY_PATH") ?? "local-pem"
        : null;

  const base = {
    activatedAtUtc: now,
    retiredAtUtc: null,
    lastUsedAtUtc: null,
    createdByUserId: null,
    rotatedByUserId: null,
    notes: null,
    verificationMaterialRef: verificationRef,
    teamId: null as string | null,
    algorithm: evidenceAlgorithm(provider),
    kmsKeyArn: kmsArn,
    status: provider === "disabled" ? ("degraded" as SignerStatus) : "active",
  };

  const list: SignerRecord[] = [
    {
      ...base,
      signerId: buildSignerId(
        "report_pdf",
        provider,
        evidKeyId,
        evidKeyVersion,
      ),
      signerPurpose: "report_pdf",
      provider,
      keyId: evidKeyId,
      keyVersion: evidKeyVersion,
    },
    {
      ...base,
      signerId: buildSignerId(
        "verification_package",
        provider,
        pkgKeyId,
        pkgKeyVersion,
      ),
      signerPurpose: "verification_package",
      provider,
      keyId: pkgKeyId,
      keyVersion: pkgKeyVersion,
    },
    {
      ...base,
      signerId: buildSignerId(
        "export_manifest",
        provider,
        exportKeyId,
        exportKeyVersion,
      ),
      signerPurpose: "export_manifest",
      provider,
      keyId: exportKeyId,
      keyVersion: exportKeyVersion,
    },
    {
      ...base,
      signerId: buildSignerId(
        "custody_event",
        provider,
        evidKeyId,
        evidKeyVersion,
      ),
      signerPurpose: "custody_event",
      provider,
      keyId: evidKeyId,
      keyVersion: evidKeyVersion,
    },
  ];
  return list;
}

// ---------------------------------------------------------------------------
// Staged / retired tracking via SecurityEvent
// ---------------------------------------------------------------------------

const STAGED_EVENT_TYPES = [
  "signer_staged",
  "signer_promoted",
  "signer_retired",
  "signer_revoked",
] as const;

export type StagedSigner = {
  signerId: string;
  signerPurpose: SignerPurpose;
  provider: SignerProvider;
  keyId: string | null;
  keyVersion: string | null;
  kmsKeyArn: string | null;
  algorithm: string | null;
  status: "staged" | "retiring" | "retired" | "revoked";
  stagedAtUtc: string;
  stagedByUserId: string;
  notes: string | null;
};

export async function listStagedSigners(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<StagedSigner>> {
  const rows = await client.securityEvent.findMany({
    where: {
      teamId: input.teamId,
      eventType: { in: STAGED_EVENT_TYPES as unknown as string[] },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, eventType: true, createdAt: true, details: true },
  });

  // Build a map keyed on signerId; the most recent event determines
  // the visible status.
  const map = new Map<string, StagedSigner>();
  for (const row of rows.reverse()) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const purpose = String(d.signerPurpose ?? "");
    const provider = String(d.provider ?? "");
    if (
      !(SIGNER_PURPOSES as readonly string[]).includes(purpose) ||
      !(SIGNER_PROVIDERS as readonly string[]).includes(provider)
    ) {
      continue;
    }
    const keyId = typeof d.keyId === "string" ? d.keyId : null;
    const keyVersion =
      typeof d.keyVersion === "string" ? d.keyVersion : null;
    const signerId =
      typeof d.signerId === "string"
        ? d.signerId
        : buildSignerId(
            purpose as SignerPurpose,
            provider as SignerProvider,
            keyId,
            keyVersion,
          );
    const existing = map.get(signerId);
    const status: StagedSigner["status"] =
      row.eventType === "signer_promoted"
        ? "retiring"
        : row.eventType === "signer_retired"
          ? "retired"
          : row.eventType === "signer_revoked"
            ? "revoked"
            : "staged";
    map.set(signerId, {
      signerId,
      signerPurpose: purpose as SignerPurpose,
      provider: provider as SignerProvider,
      keyId,
      keyVersion,
      kmsKeyArn: typeof d.kmsKeyArn === "string" ? d.kmsKeyArn : null,
      algorithm: typeof d.algorithm === "string" ? d.algorithm : null,
      status: existing ? statusTransition(existing.status, status) : status,
      stagedAtUtc:
        existing?.stagedAtUtc ?? row.createdAt.toISOString(),
      stagedByUserId:
        typeof d.actorUserId === "string"
          ? d.actorUserId
          : existing?.stagedByUserId ?? "unknown",
      notes:
        typeof d.notes === "string" ? d.notes : existing?.notes ?? null,
    });
  }
  return Array.from(map.values());
}

function statusTransition(
  prev: StagedSigner["status"],
  next: StagedSigner["status"],
): StagedSigner["status"] {
  // Status monotonically widens toward "revoked" — never goes back to "staged".
  const order: StagedSigner["status"][] = [
    "staged",
    "retiring",
    "retired",
    "revoked",
  ];
  return order.indexOf(next) >= order.indexOf(prev) ? next : prev;
}

// ---------------------------------------------------------------------------
// Public projection — active + staged combined
// ---------------------------------------------------------------------------

export async function listAllSigners(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<SignerRecord>> {
  const active = getCurrentActiveSigners();
  const staged = await listStagedSigners(input, client);
  const out: SignerRecord[] = [...active];
  for (const s of staged) {
    out.push({
      signerId: s.signerId,
      signerPurpose: s.signerPurpose,
      provider: s.provider,
      keyId: s.keyId,
      keyVersion: s.keyVersion,
      kmsKeyArn: s.kmsKeyArn,
      algorithm: s.algorithm,
      status: s.status,
      activatedAtUtc: null,
      retiredAtUtc:
        s.status === "retired" || s.status === "revoked"
          ? s.stagedAtUtc
          : null,
      lastUsedAtUtc: null,
      createdByUserId: s.stagedByUserId,
      rotatedByUserId: null,
      notes: s.notes,
      verificationMaterialRef: null,
      teamId: input.teamId,
    });
  }
  return out;
}

export async function getSignerById(
  input: { teamId: string; signerId: string },
  client: PrismaClient = defaultPrisma,
): Promise<SignerRecord | null> {
  const all = await listAllSigners(input, client);
  return all.find((s) => s.signerId === input.signerId) ?? null;
}

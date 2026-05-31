/**
 * PROOVRA Phase 4A — Subprocessor registry service.
 *
 * Versioned subprocessor list. Each entry carries purpose / region
 * / data categories / state / effective date / contract ref. Every
 * change writes a SubprocessorVersion row for the audit trail.
 *
 * Bounded providers (seeded by default):
 *   AWS, Azure, Deepgram, OpenAI, Better Stack, Sentry, Cloudflare.
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import {
  SUBPROCESSOR_DATA_CATEGORIES,
  SUBPROCESSOR_STATES,
  type SubprocessorDataCategory,
  type SubprocessorProjection,
  type SubprocessorState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitSubprocessorEvent } from "./trust-and-governance-audit.service.js";

export type UpsertSubprocessorInput = {
  prisma?: PrismaClient;
  teamId: string;
  slug: string;
  name: string;
  vendor: string;
  purpose: string;
  region: string;
  state?: SubprocessorState;
  dataCategories: ReadonlyArray<SubprocessorDataCategory>;
  documentationUrl?: string | null;
  contractRef?: string | null;
  changeSummary: string;
  effectiveAtUtc?: Date;
  authoredByUserId: string;
};

export type UpsertSubprocessorResult =
  | { ok: true; subprocessorId: string; version: number }
  | { ok: false; denial: "POLICY_REJECTED" };

export async function upsertSubprocessor(
  input: UpsertSubprocessorInput,
): Promise<UpsertSubprocessorResult> {
  const state: SubprocessorState = input.state ?? "ACTIVE";
  if (!(SUBPROCESSOR_STATES as ReadonlyArray<string>).includes(state)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  for (const c of input.dataCategories) {
    if (!(SUBPROCESSOR_DATA_CATEGORIES as ReadonlyArray<string>).includes(c)) {
      return { ok: false, denial: "POLICY_REJECTED" };
    }
  }
  const prisma = input.prisma ?? defaultPrisma;
  const effective = input.effectiveAtUtc ?? new Date();
  const sp = await prisma.subprocessor.upsert({
    where: { teamId_slug: { teamId: input.teamId, slug: input.slug } },
    create: {
      teamId: input.teamId,
      slug: input.slug,
      name: input.name.slice(0, 120),
      vendor: input.vendor.slice(0, 120),
      purpose: input.purpose.slice(0, 600),
      region: input.region.slice(0, 80),
      state,
      version: 1,
      dataCategories: input.dataCategories as readonly string[] as Prisma.InputJsonValue,
      documentationUrl: input.documentationUrl ?? null,
      contractRef: input.contractRef ?? null,
      changeHistorySummary: input.changeSummary.slice(0, 600),
      effectiveAtUtc: effective,
    },
    update: {
      name: input.name.slice(0, 120),
      vendor: input.vendor.slice(0, 120),
      purpose: input.purpose.slice(0, 600),
      region: input.region.slice(0, 80),
      state,
      version: { increment: 1 },
      dataCategories: input.dataCategories as readonly string[] as Prisma.InputJsonValue,
      documentationUrl: input.documentationUrl ?? null,
      contractRef: input.contractRef ?? null,
      changeHistorySummary: input.changeSummary.slice(0, 600),
      effectiveAtUtc: effective,
    },
    select: { id: true, version: true },
  });
  await prisma.subprocessorVersion.create({
    data: {
      teamId: input.teamId,
      subprocessorId: sp.id,
      version: sp.version,
      changeSummary: input.changeSummary.slice(0, 600),
      snapshot: {
        name: input.name,
        vendor: input.vendor,
        purpose: input.purpose,
        region: input.region,
        state,
        dataCategories: input.dataCategories,
        documentationUrl: input.documentationUrl ?? null,
        contractRef: input.contractRef ?? null,
        effectiveAtUtc: effective.toISOString(),
      } as Prisma.InputJsonValue,
      authoredByUserId: input.authoredByUserId,
    },
  });
  // Emit audit lifecycle event — best-effort.
  const isFirstVersion = sp.version === 1;
  void emitSubprocessorEvent({
    prisma,
    teamId: input.teamId,
    subprocessorId: sp.id,
    code: isFirstVersion ? "SUBPROCESSOR_CREATED" : "SUBPROCESSOR_UPDATED",
    actorUserId: input.authoredByUserId,
  }).catch(() => {});
  if (!isFirstVersion && state === "DEPRECATED") {
    void emitSubprocessorEvent({
      prisma,
      teamId: input.teamId,
      subprocessorId: sp.id,
      code: "SUBPROCESSOR_DEPRECATED",
      actorUserId: input.authoredByUserId,
    }).catch(() => {});
  }

  return { ok: true, subprocessorId: sp.id, version: sp.version };
}

export async function listSubprocessors(input: {
  prisma?: PrismaClient;
  teamId: string;
  state?: SubprocessorState;
}): Promise<ReadonlyArray<SubprocessorProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.subprocessor.findMany({
    where: {
      teamId: input.teamId,
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug ?? "",
    vendor: r.vendor ?? "",
    purpose: r.purpose ?? "",
    region: r.region ?? "",
    dataCategories: Array.isArray(r.dataCategories)
      ? (r.dataCategories as ReadonlyArray<SubprocessorDataCategory>)
      : [],
    state: r.state as SubprocessorState,
    effectiveAtUtc: r.effectiveAtUtc.toISOString(),
    documentationUrl: r.documentationUrl,
    contractRef: r.contractRef,
    version: r.version,
    changeHistorySummary: r.changeHistorySummary ?? "",
  }));
}

export async function listSubprocessorVersions(input: {
  prisma?: PrismaClient;
  teamId: string;
  subprocessorId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.subprocessorVersion.findMany({
    where: { teamId: input.teamId, subprocessorId: input.subprocessorId },
    orderBy: { version: "asc" },
  });
}

/**
 * Idempotent seed of the canonical seven subprocessors PROOVRA
 * uses today.
 */
export async function ensureSubprocessorSeed(input: {
  prisma?: PrismaClient;
  teamId: string;
  systemUserId: string;
}): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const seed of SEED_SUBPROCESSORS) {
    const existing = await (input.prisma ?? defaultPrisma).subprocessor.findFirst({
      where: { teamId: input.teamId, slug: seed.slug },
      select: { id: true },
    });
    const res = await upsertSubprocessor({
      prisma: input.prisma,
      teamId: input.teamId,
      slug: seed.slug,
      name: seed.name,
      vendor: seed.vendor,
      purpose: seed.purpose,
      region: seed.region,
      state: "ACTIVE",
      dataCategories: seed.dataCategories,
      documentationUrl: seed.documentationUrl,
      contractRef: null,
      changeSummary: existing ? "seed re-applied" : "initial registration",
      authoredByUserId: input.systemUserId,
    });
    if (!res.ok) continue;
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated };
}

type SeedSubprocessor = {
  slug: string;
  name: string;
  vendor: string;
  purpose: string;
  region: string;
  dataCategories: ReadonlyArray<SubprocessorDataCategory>;
  documentationUrl: string | null;
};

const SEED_SUBPROCESSORS: ReadonlyArray<SeedSubprocessor> = [
  {
    slug: "aws",
    name: "Amazon Web Services",
    vendor: "Amazon Web Services, Inc.",
    purpose:
      "Compute (Lambda / Fargate), storage (S3 with Object Lock), KMS, queue infrastructure.",
    region: "US / EU regions, customer-selectable",
    dataCategories: ["EVIDENCE_BYTES", "METADATA", "AUDIT_LOGS"],
    documentationUrl: "https://aws.amazon.com/compliance/",
  },
  {
    slug: "azure",
    name: "Azure Document Intelligence",
    vendor: "Microsoft Corporation",
    purpose: "Document OCR, layout, tables, forms, entity extraction.",
    region: "Region selectable per workspace",
    dataCategories: ["EVIDENCE_BYTES", "OCR_TEXT"],
    documentationUrl: "https://learn.microsoft.com/azure/ai-services/document-intelligence/",
  },
  {
    slug: "deepgram",
    name: "Deepgram",
    vendor: "Deepgram, Inc.",
    purpose: "Speech-to-text, speaker diarisation.",
    region: "US (primary), EU when selected",
    dataCategories: ["EVIDENCE_BYTES", "TRANSCRIPT_TEXT"],
    documentationUrl: "https://deepgram.com/security",
  },
  {
    slug: "openai",
    name: "OpenAI",
    vendor: "OpenAI, L.L.C.",
    purpose: "Bounded entity extraction + document summary (REGEX_PII fallback runs locally when not bound).",
    region: "US",
    dataCategories: ["OCR_TEXT", "METADATA"],
    documentationUrl: "https://openai.com/policies",
  },
  {
    slug: "aws-rekognition",
    name: "AWS Rekognition",
    vendor: "Amazon Web Services, Inc.",
    purpose: "Image face detection, text detection, label detection (used for redaction tier).",
    region: "Region selectable per workspace",
    dataCategories: ["IMAGE_PIXELS", "METADATA"],
    documentationUrl: "https://aws.amazon.com/rekognition/faqs/",
  },
  {
    slug: "better-stack",
    name: "Better Stack",
    vendor: "Better Stack",
    purpose: "Uptime monitoring, status page upstream signals.",
    region: "EU",
    dataCategories: ["STATUS_PROBES"],
    documentationUrl: "https://betterstack.com/legal",
  },
  {
    slug: "sentry",
    name: "Sentry",
    vendor: "Functional Software, Inc. (Sentry)",
    purpose: "Application error telemetry.",
    region: "US / EU (configurable)",
    dataCategories: ["ERROR_TELEMETRY"],
    documentationUrl: "https://sentry.io/security/",
  },
  {
    slug: "cloudflare",
    name: "Cloudflare",
    vendor: "Cloudflare, Inc.",
    purpose: "Edge network, DDoS mitigation, TLS termination.",
    region: "Global",
    dataCategories: ["METADATA"],
    documentationUrl: "https://www.cloudflare.com/trust-hub/",
  },
];

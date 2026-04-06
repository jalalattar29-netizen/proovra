import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import {
  REQUIRED_LEGAL_VERSIONS,
  type RequiredLegalPolicyKey,
} from "../legal/legal-versioning.js";

function readUserAgent(req?: FastifyRequest): string | null {
  if (!req) return null;
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

export type LegalAcceptanceInput = {
  policyKey: RequiredLegalPolicyKey | string;
  policyVersion: string;
};

export async function recordLegalAcceptances(params: {
  userId: string;
  acceptances: LegalAcceptanceInput[];
  source?: string | null;
  req?: FastifyRequest;
  db?: PrismaClient;
}): Promise<void> {
  const db = params.db ?? prisma;

  if (!params.acceptances.length) return;

  await db.$transaction(
    params.acceptances.map((item) =>
      db.userLegalAcceptance.upsert({
        where: {
          userId_policyKey: {
            userId: params.userId,
            policyKey: item.policyKey,
          },
        },
        update: {
          policyVersion: item.policyVersion,
          source: params.source ?? null,
          ipAddress: params.req?.ip ?? null,
          userAgent: readUserAgent(params.req),
          acceptedAt: new Date(),
        },
        create: {
          userId: params.userId,
          policyKey: item.policyKey,
          policyVersion: item.policyVersion,
          source: params.source ?? null,
          ipAddress: params.req?.ip ?? null,
          userAgent: readUserAgent(params.req),
        },
      })
    )
  );
}

export async function getUserLegalAcceptanceStatus(params: {
  userId: string;
  db?: PrismaClient;
}) {
  const db = params.db ?? prisma;

  const rows = await db.userLegalAcceptance.findMany({
    where: { userId: params.userId },
    select: {
      policyKey: true,
      policyVersion: true,
      acceptedAt: true,
    },
  });

  const acceptedVersions = Object.fromEntries(
    rows.map((row) => [row.policyKey, row.policyVersion])
  ) as Partial<Record<string, string>>;

  const missingPolicies = Object.entries(REQUIRED_LEGAL_VERSIONS)
    .filter(([policyKey, requiredVersion]) => acceptedVersions[policyKey] !== requiredVersion)
    .map(([policyKey]) => policyKey as RequiredLegalPolicyKey);

  return {
    ok: missingPolicies.length === 0,
    requiresReacceptance: missingPolicies.length > 0,
    missingPolicies,
    acceptedVersions,
    requiredVersions: REQUIRED_LEGAL_VERSIONS,
  };
}

export async function assertUserHasRequiredLegalAcceptances(params: {
  userId: string;
  db?: PrismaClient;
}) {
  const status = await getUserLegalAcceptanceStatus(params);

  if (!status.ok) {
    const error = new Error("LEGAL_REACCEPT_REQUIRED") as Error & {
      code?: string;
      details?: unknown;
      statusCode?: number;
    };

    error.code = "LEGAL_REACCEPT_REQUIRED";
    error.statusCode = 428;
    error.details = {
      missingPolicies: status.missingPolicies,
      acceptedVersions: status.acceptedVersions,
      requiredVersions: status.requiredVersions,
    };

    throw error;
  }

  return status;
}
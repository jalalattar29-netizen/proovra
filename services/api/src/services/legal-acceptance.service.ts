import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import { emitTenantAudit } from "./audit/tenant-audit.service.js";
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

  /*
   * PRO-A1-07 — ACCEPTANCE HISTORY. The row per (user, policy) is the CURRENT
   * acceptance; it used to be overwritten in place, losing when, from where
   * and through which surface an earlier version was accepted. Every new
   * acceptance (a version not already on the row) is now also written to the
   * append-only audit chain with the version it replaces, so the facts of
   * every accepted version stay retrievable. Re-accepting the SAME version
   * changes nothing (no overwrite of the original moment, no second event).
   */
  const existing = await db.userLegalAcceptance.findMany({
    where: { userId: params.userId, policyKey: { in: params.acceptances.map((a) => a.policyKey) } },
    select: { policyKey: true, policyVersion: true, acceptedAt: true, source: true },
  });
  const byKey = new Map(existing.map((r) => [r.policyKey, r]));
  const changed = params.acceptances.filter((a) => byKey.get(a.policyKey)?.policyVersion !== a.policyVersion);
  if (changed.length === 0) return;

  /*
   * PRO-A1-07 (closure) — the history row and the change it records commit in
   * ONE transaction: the upsert overwrites the previous acceptance, so if the
   * audit row cannot be written the change is rolled back and the request
   * fails, instead of committing the overwrite and losing the replaced version
   * silently (the PRO-G2-08 critical-audit pattern).
   */
  await db.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;
    for (const item of changed) {
      await client.userLegalAcceptance.upsert({
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
      });
    }
    for (const item of changed) {
      const previous = byKey.get(item.policyKey) ?? null;
      await emitTenantAudit(
        {
          action: "identity.legal_accepted",
          outcome: "success",
          sourceApp: "API",
          actorUserId: params.userId,
          workspaceId: null,
          resourceType: "legal_policy",
          resourceId: item.policyKey,
          metadata: {
            policyKey: item.policyKey,
            acceptedVersion: item.policyVersion,
            source: params.source ?? null,
            previousVersion: previous?.policyVersion ?? null,
            previousAcceptedAt: previous?.acceptedAt ? previous.acceptedAt.toISOString() : null,
            previousSource: previous?.source ?? null,
          },
        },
        client,
      );
    }
  });
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
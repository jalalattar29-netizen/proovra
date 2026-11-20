/**
 * PROOVRA Phase 2B — Portal activity emitter.
 *
 * Bounded append-only activity log keyed by `grantId`. Each event is
 * also mirrored into the existing custody/audit chain via the
 * platform-audit-log service when an `evidenceId` is present.
 *
 * Hard rules:
 *   * Bounded code (EXTERNAL_PORTAL_ACTIVITY_CODES).
 *   * Bounded payload — no decisions; no raw bytes.
 *   * NEVER a parallel audit system — emits through the existing
 *     custody chain when the event is evidence-scoped.
 */

import type { PrismaClient } from "@prisma/client";
import {
  EXTERNAL_PORTAL_ACTIVITY_CODES,
  type ExternalPortalActivityCode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type EmitPortalActivityInput = {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  code: ExternalPortalActivityCode;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payload?: Record<string, unknown>;
};

export async function emitPortalActivity(
  input: EmitPortalActivityInput,
): Promise<{ id: string }> {
  if (!(EXTERNAL_PORTAL_ACTIVITY_CODES as ReadonlyArray<string>).includes(input.code)) {
    throw new Error(`portal-activity: unknown code "${input.code}"`);
  }
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.externalReviewActivity.create({
    data: {
      teamId: input.teamId,
      grantId: input.grantId,
      code: input.code,
      sessionId: input.sessionId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      payload: (input.payload ?? null) as never,
    },
    select: { id: true },
  });
  return { id: row.id };
}

export type ListPortalActivityInput = {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  limit?: number;
};

/**
 * PRO-NC-09 (matrix review NEW-RG-27-3) — THE "material opened" fact. A review
 * is marked viewed, and a decision is recorded, only after the review material
 * (the record's disclosure package) was actually released to THIS grant for
 * THIS workflow. The release route records `DOWNLOAD_PERMITTED` with the
 * workflow in its payload, after the custody authorization and before the URL
 * is returned; this asks for that row. The web portal posted "viewed" on mount
 * and offered a decision with no material, and the server took both: the rule
 * existed only in the native client. Fails closed: no row, no material.
 */
export const REVIEW_MATERIAL_RELEASED_CODE = "DOWNLOAD_PERMITTED" as const;

export async function hasReleasedReviewMaterial(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  workflowId: string;
}): Promise<boolean> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.externalReviewActivity.findFirst({
    where: {
      teamId: input.teamId,
      grantId: input.grantId,
      code: REVIEW_MATERIAL_RELEASED_CODE,
      payload: { path: ["workflowId"], equals: input.workflowId },
    },
    select: { id: true },
  });
  return row !== null;
}

export async function listPortalActivity(input: ListPortalActivityInput) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.externalReviewActivity.findMany({
    where: { teamId: input.teamId, grantId: input.grantId },
    orderBy: { occurredAtUtc: "desc" },
    take: Math.min(input.limit ?? 100, 500),
    select: {
      id: true,
      code: true,
      sessionId: true,
      payload: true,
      occurredAtUtc: true,
      ip: true,
    },
  });
}

/**
 * B4-F-300 (free audit 0ea0) — facts BOTH upload doors share: the ordinary
 * part presign (evidence.routes.ts) and the resumable upload session
 * (upload-sessions.routes.ts). Moved here verbatim from evidence.routes.ts so
 * the two doors answer a storage refusal with the same body and store a file
 * name by the same rule.
 */
import type { FastifyRequest } from "fastify";
import * as prismaPkg from "@prisma/client";

import { readBillingOverview } from "../billing-overview.service.js";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";

export async function buildStorageLimitPayload(params: {
  ownerUserId: string;
  evidenceId?: string | null;
  teamId?: string | null;
  req?: FastifyRequest;
  reason?: string | null;
  incomingBytes?: string | null;
}) {
  // COMMERCIAL AUTHORITY (2026-09-03) — the wall names ONE workspace, and it
  // resolves that one canonically instead of scanning an account-wide rollup
  // to find it. `summary` and `storageAddons` stay: those ARE account-level
  // facts, and they are what the wall offers the customer next to the refusal.
  const [overview, scope] = await Promise.all([
    readBillingOverview(params.ownerUserId),
    params.teamId != null
      ? resolveCommercialContext({
          type: "WORKSPACE",
          teamId: params.teamId,
          requesterUserId: params.ownerUserId,
        }).then((c) => c.scope)
      : Promise.resolve(null),
  ]);

  const workspace = scope
    ? {
        id: params.teamId,
        billingShape: scope.billingShape,
        plan: scope.plan,
      }
    : overview.workspaces.personal;

  const upgradeSuggestion =
    workspace && workspace.billingShape === "SINGLE_OCCUPANT"
      ? workspace.plan === prismaPkg.PlanType.PAYG
        ? "Upgrading to PRO may be more cost-effective if you need recurring storage."
        : workspace.plan === prismaPkg.PlanType.PRO
          ? "If you need much larger storage, upgrading to TEAM may be more cost-effective."
          : "Upgrade your base plan to unlock more storage options."
      : workspace && workspace.billingShape === "SHARED"
        ? "If your team keeps growing, a larger recurring storage add-on may be more cost-effective."
        : null;

  return {
    code: "STORAGE_LIMIT_REACHED",
    message: "Storage limit reached",
    billingWall: {
      type: "storage_limit_reached",
      reason: params.reason ?? "workspace_storage_exhausted",
      evidenceId: params.evidenceId ?? null,
      workspace,
      summary: overview.summary,
      storageAddons: overview.storageAddons,
      suggestedActions: [
        "add_storage",
        "upgrade_plan",
        "review_archived_evidence",
      ],
      upgradeSuggestion,
      incomingBytes: params.incomingBytes ?? null,
    },
  };
}

export function sanitizeFileName(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const normalized = raw.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!normalized || normalized === "." || normalized === "..") return null;

  return normalized;
}

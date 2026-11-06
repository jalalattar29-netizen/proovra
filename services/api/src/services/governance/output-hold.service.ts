/**
 * REPORT-004 — THE OUTPUT HOLD, LIFTED ON THE SAME DECISION THAT SET IT.
 *
 * A record finalized while the workspace output policy refused its report or
 * package is sealed and its first outputs are HELD (`evidence.outputsHeldAtUtc`,
 * see finalization-governance.service.ts). This module answers one question:
 * does the policy, read LIVE through the same `decideGovernedOutputActions`,
 * for the same actor's role, now allow them? If so it clears the hold — one
 * conditional write, so concurrent callers lift it exactly once — and audits
 * the release. Issuing is the caller's (output-hold-release.service).
 */
import { prisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { FINALIZATION_GOVERNED_ACTIONS, decideGovernedOutputActions } from "./finalization-governance.service.js";

export type OutputHoldLift = "not_held" | "lifted" | "still_held";

export async function tryLiftOutputHold(evidenceId: string): Promise<OutputHoldLift> {
  const row = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      teamId: true,
      ownerUserId: true,
      outputsHeldAtUtc: true,
      outputsHeldActorUserId: true,
      outputsHeldReason: true,
    },
  });
  if (!row?.outputsHeldAtUtc) return "not_held";
  const decision = await decideGovernedOutputActions({
    evidenceId,
    actorUserId: row.outputsHeldActorUserId ?? row.ownerUserId,
    actions: FINALIZATION_GOVERNED_ACTIONS,
  }).catch(() => null);
  if (!decision || !decision.allowed) {
    // Still refused (or unreadable): the hold stands, with the current reason.
    const reason = decision && !decision.allowed ? decision.reason.slice(0, 64) : "policy_lookup_failed";
    if (reason !== row.outputsHeldReason) {
      await prisma.evidence.updateMany({
        where: { id: evidenceId, outputsHeldAtUtc: row.outputsHeldAtUtc },
        data: { outputsHeldReason: reason },
      });
    }
    return "still_held";
  }
  const cleared = await prisma.evidence.updateMany({
    where: { id: evidenceId, outputsHeldAtUtc: row.outputsHeldAtUtc },
    data: { outputsHeldAtUtc: null, outputsHeldReason: null, outputsHeldActorUserId: null },
  });
  if (cleared.count !== 1) return "not_held"; // another caller lifted it first
  await emitTenantAudit({
    action: "evidence.outputs_hold_released",
    outcome: "success",
    sourceApp: "API",
    actorUserId: null,
    serviceActor: "output_hold_release",
    workspaceId: row.teamId,
    resourceType: "evidence",
    resourceId: evidenceId,
    metadata: { heldReason: row.outputsHeldReason ?? null, heldAtUtc: row.outputsHeldAtUtc.toISOString() },
  }).catch(() => null);
  return "lifted";
}

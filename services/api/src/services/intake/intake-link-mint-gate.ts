/**
 * ET-INT-07 — THE gate every intake-link mint on behalf of a workspace member
 * passes: the secure-intake PLAN (assertWorkspaceAllowsIntake on the
 * workspace's commercial scope) and the workspace GOVERNANCE policy
 * (canCreateIntakeLink with the actor's role and the link's intake mode).
 *
 * On a40ca76f the evidence-request SEND and REQUEST-MORE flows called
 * createWorkflowIntakeLink directly, so a workspace that had disabled external
 * or anonymous intake — or had been downgraded off a plan that includes it —
 * still minted public links through them.
 *
 * Returns the refusal (or null); callers map it to their own error vocabulary.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { assertWorkspaceAllowsIntake } from "../billing-enforcement.service.js";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";

export type IntakeLinkMintRefusal =
  | { kind: "plan"; code: "INTAKE_NOT_INCLUDED" | "COMMERCIAL_LIFECYCLE_RESTRICTED"; message: string }
  | { kind: "policy"; reason: string };

export async function intakeLinkMintRefusal(
  input: { teamId: string; actorUserId: string; intakeMode: string },
  client: PrismaClient = defaultPrisma,
): Promise<IntakeLinkMintRefusal | null> {
  const { scope } = await resolveCommercialContext({
    type: "WORKSPACE",
    teamId: input.teamId,
    requesterUserId: input.actorUserId,
  });
  try {
    await assertWorkspaceAllowsIntake(scope);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === "INTAKE_NOT_INCLUDED" || e?.code === "COMMERCIAL_LIFECYCLE_RESTRICTED") {
      return { kind: "plan", code: e.code, message: e.message ?? e.code };
    }
    throw err;
  }
  // Lazy: governance.service is a large module the request service does not
  // otherwise need at load time.
  const { canCreateIntakeLink, loadWorkspaceGovernancePolicy } = await import("../governance.service.js");
  const policy = await loadWorkspaceGovernancePolicy(input.teamId, client);
  const membership = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: input.actorUserId } },
    select: { role: true },
  });
  const decision = canCreateIntakeLink({ role: membership?.role, intakeMode: input.intakeMode, policy });
  return decision.allowed ? null : { kind: "policy", reason: decision.reason ?? "intake_blocked_by_policy" };
}

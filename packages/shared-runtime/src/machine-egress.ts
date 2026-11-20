/**
 * PRO-LEAD-02 / B7B-F01 — THE ONE MACHINE-EGRESS RULE (AZ-R04). A machine
 * channel (integration webhook, lifecycle webhook, automation webhook) is on no
 * access list: an event naming, directly or through the object it is about, a
 * record or case a restricted case closes to "nobody" (`null`) does not leave.
 * Resolves every id kind a channel carries: a record, a case, a legal hold (its
 * record or case), an exchange package (its records and case), a review
 * workflow or escalation (its record), an external-review grant (its record,
 * case or package's record). Fails closed: a reach that cannot be read withholds.
 *
 * WHY IT LIVES HERE (matrix review NEW-RG-11-2). The API's emit paths and the
 * integration retry processor asked it (services/api record-reach.ts, which
 * re-exports this), but the Worker's lifecycle-webhook dispatcher may not
 * import the API and asked nothing, so a delivery queued or retrying when its
 * subject became restricted was still sent. One implementation, both hosts,
 * over the shared restricted-case predicate (`case-visibility.ts`).
 */
import type { PrismaClient } from "@prisma/client";

import { caseVisibleToWhere, evidenceVisibleThroughCasesWhere } from "./case-visibility.js";

export type MachineEgressTarget = {
  evidenceId?: string | null;
  caseId?: string | null;
  /** A scope-generic target (legal hold); its kind is tried as a record and a case. */
  scopeTargetId?: string | null;
  holdId?: string | null;
  packageId?: string | null;
  workflowId?: string | null;
  escalationId?: string | null;
  grantId?: string | null;
};

/** Structural client: the API's or the Worker's PrismaClient (or a transaction client). */
export type MachineEgressClient = Pick<
  PrismaClient,
  | "evidence"
  | "case"
  | "evidenceLegalHold"
  | "evidenceExchangePackage"
  | "verificationPackage"
  | "reviewEscalation"
  | "evidenceReviewWorkflow"
  | "$queryRaw"
>;

export function machineEgressTargetOf(payload: Record<string, unknown>): MachineEgressTarget {
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : null);
  return {
    evidenceId: str("evidenceId"),
    caseId: str("caseId"),
    scopeTargetId: str("scopeTargetId"),
    holdId: str("holdId"),
    packageId: str("packageId"),
    workflowId: str("workflowId"),
    escalationId: str("escalationId"),
    grantId: str("grantId"),
  };
}

/** True when this record exists and a restricted case closes it to nobody. */
async function evidenceClosedToMachines(evidenceId: string, client: Pick<PrismaClient, "evidence">): Promise<boolean> {
  return (await client.evidence.count({ where: { id: evidenceId, NOT: evidenceVisibleThroughCasesWhere(null) } })) > 0;
}

/** True when this case exists and is restricted (closed to nobody). */
async function caseClosedToMachines(caseId: string, client: Pick<PrismaClient, "case">): Promise<boolean> {
  return (await client.case.count({ where: { id: caseId, NOT: caseVisibleToWhere(null) } })) > 0;
}

export async function machineEgressRestricted(
  target: MachineEgressTarget,
  client: MachineEgressClient,
): Promise<boolean> {
  try {
    const evidenceIds = new Set<string>();
    const caseIds = new Set<string>();
    if (target.evidenceId) evidenceIds.add(target.evidenceId);
    if (target.caseId) caseIds.add(target.caseId);
    if (target.scopeTargetId) {
      evidenceIds.add(target.scopeTargetId);
      caseIds.add(target.scopeTargetId);
    }
    if (target.holdId) {
      const hold = await client.evidenceLegalHold.findUnique({
        where: { id: target.holdId },
        select: { evidenceId: true, caseId: true },
      });
      if (hold?.evidenceId) evidenceIds.add(hold.evidenceId);
      if (hold?.caseId) caseIds.add(hold.caseId);
    }
    if (target.packageId) {
      const pkg = await client.evidenceExchangePackage.findUnique({
        where: { id: target.packageId },
        select: { evidenceIds: true, caseId: true },
      });
      if (pkg) {
        for (const id of Array.isArray(pkg.evidenceIds) ? (pkg.evidenceIds as unknown[]) : []) {
          if (typeof id === "string") evidenceIds.add(id);
        }
        if (pkg.caseId) caseIds.add(pkg.caseId);
      } else {
        const vp = await client.verificationPackage.findUnique({
          where: { id: target.packageId },
          select: { evidenceId: true },
        });
        if (vp?.evidenceId) evidenceIds.add(vp.evidenceId);
      }
    }
    const workflowIds = new Set<string>();
    if (target.workflowId) workflowIds.add(target.workflowId);
    if (target.escalationId) {
      const esc = await client.reviewEscalation.findUnique({
        where: { id: target.escalationId },
        select: { workflowId: true },
      });
      if (esc?.workflowId) workflowIds.add(esc.workflowId);
    }
    for (const wid of workflowIds) {
      const wf = await client.evidenceReviewWorkflow.findUnique({ where: { id: wid }, select: { evidenceId: true } });
      if (wf?.evidenceId) evidenceIds.add(wf.evidenceId);
    }
    if (target.grantId) {
      const rows = await client.$queryRaw<Array<{ evidence_id: string | null; case_id: string | null; package_id: string | null }>>`
        SELECT "evidence_id", "case_id", "package_id" FROM "external_review_grants" WHERE "id" = ${target.grantId}::uuid
      `;
      const g = rows[0];
      if (g?.evidence_id) evidenceIds.add(g.evidence_id);
      if (g?.case_id) caseIds.add(g.case_id);
      if (g?.package_id) {
        const vp = await client.verificationPackage.findUnique({ where: { id: g.package_id }, select: { evidenceId: true } });
        if (vp?.evidenceId) evidenceIds.add(vp.evidenceId);
      }
    }
    for (const id of evidenceIds) if (await evidenceClosedToMachines(id, client)) return true;
    for (const id of caseIds) if (await caseClosedToMachines(id, client)) return true;
    return false;
  } catch {
    return true;
  }
}

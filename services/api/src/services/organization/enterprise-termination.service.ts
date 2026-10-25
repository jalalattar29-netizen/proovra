/**
 * ENTERPRISE ORGANIZATION OFFBOARDING — the contract termination writer
 * (members audit LIFE-16, 2026-10-25).
 *
 * The contract vocabulary had SUSPENDED and TERMINATED states and no code that
 * could write them: an Enterprise customer could be suspended (platform
 * operator, `suspendOrganization`) but never ended, and its workspaces, members
 * and credentials could not be retired through any canonical path. This is that
 * path, and it introduces no second lifecycle — it composes the ones that
 * exist:
 *
 *   ACTIVE       the contract is ACTIVE and the organization operates.
 *   SUSPENDED    the organization is SUSPENDED (`suspendOrganization`).
 *   TERMINATING  `beginEnterpriseTermination` has run: the contract is
 *                SUSPENDED (it grants nothing from this moment) and an
 *                organization closure is SCHEDULED for the effective date,
 *                marked as a termination.
 *   TERMINATED   the closure executed — the ONE closure leg set retired every
 *                workspace, membership, invitation, credential, webhook and
 *                external grant — and the contract is TERMINATED.
 *
 * What termination never does: delete or destroy anything. Evidence, custody,
 * reports, packages, legal holds, retention and audit history are untouched,
 * and an ACTIVE legal hold BLOCKS the termination closure exactly as it blocks
 * any closure: it waits (TERMINATING, contract granting nothing) until the
 * hold is released. Custodial accountability survives offboarding intent.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import { emitOrgAuditEvent } from "./org-audit.service.js";
import { transitionEnterpriseContractStatusTx } from "./enterprise-contract.service.js";

/** Marks an OrganizationClosureRequest that executes a contract termination. */
export const CONTRACT_TERMINATION_REASON_PREFIX = "contract_termination:";

export function isContractTerminationClosure(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(CONTRACT_TERMINATION_REASON_PREFIX);
}

export type OrganizationLifecycleState = "ACTIVE" | "SUSPENDED" | "TERMINATING" | "TERMINATED";

/** THE projection of an organization's lifecycle state, from the rows that hold it. */
export function resolveOrganizationLifecycleState(input: {
  organizationStatus: string;
  contractStatus: string | null;
  openTerminationClosure: boolean;
}): OrganizationLifecycleState {
  if (input.contractStatus === "TERMINATED") return "TERMINATED";
  if (input.openTerminationClosure) return "TERMINATING";
  if (input.organizationStatus === "SUSPENDED" || input.contractStatus === "SUSPENDED") return "SUSPENDED";
  return "ACTIVE";
}

export class EnterpriseTerminationError extends Error {
  constructor(
    readonly code:
      | "ORGANIZATION_NOT_FOUND"
      | "ENTERPRISE_CONTRACT_REQUIRED"
      | "TERMINATION_ALREADY_SCHEDULED"
      | "CONTRACT_ALREADY_TERMINATED"
      | "TERMINATION_NOT_SCHEDULED",
    readonly httpStatus: 404 | 409,
  ) {
    super(code);
    this.name = "EnterpriseTerminationError";
  }
}

const OPEN_CLOSURE_STATUSES = ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED", "PROCESSING"];

export async function beginEnterpriseTermination(input: {
  organizationId: string;
  actorUserId: string;
  reason: string;
  effectiveAtUtc?: Date | null;
}): Promise<{ closureRequestId: string; effectiveAtUtc: Date }> {
  const effectiveAtUtc = input.effectiveAtUtc ?? new Date();
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    });
    if (!org) throw new EnterpriseTerminationError("ORGANIZATION_NOT_FOUND", 404);
    // Serialise every termination writer of this organization.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enterprise-termination:${input.organizationId}`}))`;
    const contract = await tx.enterpriseContract.findUnique({
      where: { organizationId: input.organizationId },
      select: { status: true },
    });
    if (!contract) throw new EnterpriseTerminationError("ENTERPRISE_CONTRACT_REQUIRED", 409);
    if (contract.status === "TERMINATED") throw new EnterpriseTerminationError("CONTRACT_ALREADY_TERMINATED", 409);
    const open = await tx.organizationClosureRequest.findFirst({
      where: { organizationId: input.organizationId, status: { in: OPEN_CLOSURE_STATUSES } },
      select: { id: true, reason: true },
    });
    if (open && isContractTerminationClosure(open.reason)) {
      throw new EnterpriseTerminationError("TERMINATION_ALREADY_SCHEDULED", 409);
    }
    // A self-service closure already in flight is superseded by the termination.
    if (open) {
      await tx.organizationClosureRequest.update({
        where: { id: open.id },
        data: { status: "CANCELLED", cancelledAtUtc: new Date() },
      });
    }

    // The contract grants nothing from this moment.
    await transitionEnterpriseContractStatusTx(tx as never, {
      organizationId: input.organizationId,
      to: "SUSPENDED",
      terminationReason: input.reason,
    });
    const row = await tx.organizationClosureRequest.create({
      data: {
        organizationId: input.organizationId,
        requestedByUserId: input.actorUserId,
        status: "SCHEDULED",
        reason: `${CONTRACT_TERMINATION_REASON_PREFIX} ${input.reason}`.slice(0, 500),
        coolingOffEndsAtUtc: effectiveAtUtc,
      },
      select: { id: true },
    });
    await emitOrgAuditEvent(tx as Prisma.TransactionClient, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      eventType: "ORG_CLOSURE_REQUESTED",
      targetType: "organization",
      targetId: input.organizationId,
      metadata: { kind: "contract_termination", closureRequestId: row.id, effectiveAtUtc: effectiveAtUtc.toISOString() },
    });
    return { closureRequestId: row.id, effectiveAtUtc };
  });
}

/**
 * Withdraw a termination that has not executed. The organization returns to
 * SUSPENDED (the contract stays SUSPENDED); an operator resumes it explicitly,
 * so withdrawing a termination never silently restores access.
 */
export async function cancelEnterpriseTermination(input: {
  organizationId: string;
  actorUserId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enterprise-termination:${input.organizationId}`}))`;
    const open = await tx.organizationClosureRequest.findFirst({
      where: {
        organizationId: input.organizationId,
        status: { in: ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED"] },
      },
      select: { id: true, reason: true },
    });
    if (!open || !isContractTerminationClosure(open.reason)) {
      throw new EnterpriseTerminationError("TERMINATION_NOT_SCHEDULED", 409);
    }
    await tx.organizationClosureRequest.update({
      where: { id: open.id },
      data: { status: "CANCELLED", cancelledAtUtc: new Date() },
    });
    await emitOrgAuditEvent(tx as Prisma.TransactionClient, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      eventType: "ORG_CLOSURE_CANCELLED",
      targetType: "organization",
      targetId: input.organizationId,
      metadata: { kind: "contract_termination", closureRequestId: open.id },
    });
  });
}

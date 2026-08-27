/**
 * PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2).
 *
 * ONE resolver for "what is this CUSTOMER Organization's commercial
 * contract". Everything commercial about an Enterprise customer (status,
 * activation, seats, storage, region, billing refs, contract owner) reads
 * through here — never from plan strings or `pendingEnterpriseSeats`
 * directly.
 *
 * COMPATIBILITY FALLBACK (owner: billing domain; removal condition: the
 * 20270920300000 backfill applied everywhere): a CUSTOMER organization
 * with no contract row resolves a LEGACY projection derived from the same
 * deterministic signals the backfill uses (pendingEnterpriseSeats →
 * seats; billingOwnerUserId → contract owner; createdAt → effective).
 * SYSTEM organizations NEVER resolve a contract (null — they are not
 * customers by definition).
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import type { TxClient } from "../identity/membership-provisioning.service.js";
// Runtime audit of remaining legacy-fallback use (Phase 12 retirement metric).
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

export type EnterpriseContractProjection = {
  organizationId: string;
  status: "DRAFT" | "PENDING_ACTIVATION" | "ACTIVE" | "SUSPENDED" | "TERMINATED";
  activationState: "PENDING_OWNER" | "OWNER_INVITED" | "ACTIVATED" | null;
  effectiveAtUtc: Date | null;
  endsAtUtc: Date | null;
  seatCount: number | null;
  storageGb: number | null;
  /**
   * BILLING PRODUCTION CLOSURE (2026-08-27) — contracted usage allowances.
   *
   * The columns existed and the resolver that consumes them existed; the
   * projection between them did not carry the values, so
   * `resolveEnterpriseContractLimits` reached them through a cast that always
   * read `undefined`. A contract stating 25,000 records a month was silently
   * ignored and the catalog default applied instead.
   *
   * `null` means the contract is SILENT on the allowance — the catalog
   * default governs and Billing must say so rather than presenting the
   * fallback as a contracted number.
   */
  evidenceRecordsPerMonth: number | null;
  aiOperationsPerMonth: number | null;
  region: string | null;
  planVersion: string | null;
  billingCustomerRef: string | null;
  billingSubscriptionRef: string | null;
  contractOwnerUserId: string | null;
  /** True when this projection came from the legacy fallback, not a row. */
  legacyDerived: boolean;
};

/**
 * BILLING PRODUCTION CLOSURE (2026-08-27) — validate ONE contracted allowance
 * on the way in.
 *
 * A contract term is a positive whole number of operations. Zero, a negative
 * number and a fraction are not smaller contracts — they are data errors, and
 * the resolver downstream reads any non-positive value as "the contract is
 * silent", which promotes the error into the catalog default. Rejecting at the
 * writer keeps the ambiguity out of the database entirely.
 *
 * `null` is legitimate and distinct: it records that the contract does not
 * state this allowance.
 */
function normalizeContractAllowance(
  value: number | null | undefined,
  field: "evidenceRecordsPerMonth" | "aiOperationsPerMonth",
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Enterprise contract ${field} must be a positive whole number or null`,
    );
  }
  return value;
}

export async function resolveEnterpriseContract(
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<EnterpriseContractProjection | null> {
  const org = await client.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      kind: true,
      status: true,
      createdAt: true,
      billingOwnerUserId: true,
      pendingEnterpriseSeats: true,
    },
  });
  if (!org || org.kind !== "CUSTOMER") return null;

  // Canonical row (migration-window tolerant: table may not exist yet).
  const delegate = (client as { enterpriseContract?: unknown }).enterpriseContract;
  if (delegate) {
    try {
      const row = await client.enterpriseContract.findUnique({
        where: { organizationId },
      });
      if (row) {
        return {
          organizationId,
          status: row.status as EnterpriseContractProjection["status"],
          activationState:
            (row.activationState as EnterpriseContractProjection["activationState"]) ??
            null,
          effectiveAtUtc: row.effectiveAtUtc,
          endsAtUtc: row.endsAtUtc,
          seatCount: row.seatCount,
          storageGb: row.storageGb,
          evidenceRecordsPerMonth: row.evidenceRecordsPerMonth,
          aiOperationsPerMonth: row.aiOperationsPerMonth,
          region: row.region,
          planVersion: row.planVersion,
          billingCustomerRef: row.billingCustomerRef,
          billingSubscriptionRef: row.billingSubscriptionRef,
          contractOwnerUserId: row.contractOwnerUserId,
          legacyDerived: false,
        };
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "P2021" && code !== "P2022") throw err;
    }
  }

  // TEMPORARY COMPATIBILITY_INPUT_ADAPTER (classified 2026-07-23) — legacy
  // fallback synthesizing contract INPUT from the same deterministic signals
  // as the 20270920300000 backfill. Constraints (machine-tested):
  // CUSTOMER-only (SYSTEM returned null above); a non-ACTIVE legacy org can
  // NEVER synthesize ACTIVE (else-branch → SUSPENDED, fail closed incl.
  // null/unknown status); every result is legacyDerived-marked; no
  // production writer creates fallback-dependent rows (provisioning upserts
  // real contract rows). Runtime audit below tracks remaining fallback use
  // so Phase 12 can retire it on zero-use + applied backfill.
  emitTenantAudit({
    action: "billing.enterprise_contract_legacy_fallback",
    outcome: "success",
    sourceApp: "API",
    actorUserId: org.billingOwnerUserId ?? null,
    serviceActor: org.billingOwnerUserId ? null : "enterprise_contract_resolver",
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    metadata: { legacyDerived: true, orgStatus: org.status },
  }).catch(() => null);
  return {
    organizationId,
    status: org.status === "ACTIVE" ? "ACTIVE" : "SUSPENDED",
    activationState: "ACTIVATED",
    effectiveAtUtc: org.createdAt,
    endsAtUtc: null,
    seatCount: org.pendingEnterpriseSeats ?? null,
    storageGb: null,
    // The legacy fallback synthesises contract INPUT from deterministic org
    // signals. There is no signal for a usage allowance, so it states none —
    // the catalog default governs, honestly labelled.
    evidenceRecordsPerMonth: null,
    aiOperationsPerMonth: null,
    region: null,
    planVersion: null,
    billingCustomerRef: null,
    billingSubscriptionRef: null,
    contractOwnerUserId: org.billingOwnerUserId ?? null,
    legacyDerived: true,
  };
}

/**
 * Idempotent contract activation — called by enterprise provisioning
 * inside its transaction. Upserts the single contract row for the org.
 * Migration-window tolerant (skips when the table is not applied yet;
 * the backfill then covers the org).
 */
export async function upsertEnterpriseContract(
  tx: TxClient,
  input: {
    organizationId: string;
    status: EnterpriseContractProjection["status"];
    activationState: NonNullable<EnterpriseContractProjection["activationState"]>;
    seatCount?: number | null;
    /**
     * Contracted usage allowances. Omitted leaves the stored value untouched;
     * an explicit `null` clears it back to the catalog default. Values are
     * validated by `normalizeContractAllowance` — a zero or negative
     * allowance is not a contract term, it is a data error, and it must not
     * silently become "unlimited".
     */
    evidenceRecordsPerMonth?: number | null;
    aiOperationsPerMonth?: number | null;
    contractOwnerUserId?: string | null;
    effectiveAtUtc?: Date | null;
    region?: string | null;
  },
): Promise<void> {
  const delegate = (tx as { enterpriseContract?: unknown }).enterpriseContract;
  if (!delegate) return;
  try {
    await tx.enterpriseContract.upsert({
      where: { organizationId: input.organizationId },
      update: {
        status: input.status,
        activationState: input.activationState,
        ...(input.seatCount !== undefined ? { seatCount: input.seatCount } : {}),
        ...(input.evidenceRecordsPerMonth !== undefined
          ? {
              evidenceRecordsPerMonth: normalizeContractAllowance(
                input.evidenceRecordsPerMonth,
                "evidenceRecordsPerMonth",
              ),
            }
          : {}),
        ...(input.aiOperationsPerMonth !== undefined
          ? {
              aiOperationsPerMonth: normalizeContractAllowance(
                input.aiOperationsPerMonth,
                "aiOperationsPerMonth",
              ),
            }
          : {}),
        ...(input.contractOwnerUserId !== undefined
          ? { contractOwnerUserId: input.contractOwnerUserId }
          : {}),
        ...(input.effectiveAtUtc !== undefined
          ? { effectiveAtUtc: input.effectiveAtUtc }
          : {}),
      },
      create: {
        organizationId: input.organizationId,
        status: input.status,
        activationState: input.activationState,
        seatCount: input.seatCount ?? null,
        evidenceRecordsPerMonth: normalizeContractAllowance(
          input.evidenceRecordsPerMonth ?? null,
          "evidenceRecordsPerMonth",
        ),
        aiOperationsPerMonth: normalizeContractAllowance(
          input.aiOperationsPerMonth ?? null,
          "aiOperationsPerMonth",
        ),
        contractOwnerUserId: input.contractOwnerUserId ?? null,
        effectiveAtUtc: input.effectiveAtUtc ?? new Date(),
        region: input.region ?? null,
      },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "P2021" && code !== "P2022") throw err;
  }
}

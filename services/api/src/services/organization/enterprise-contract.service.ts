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

import { isReadOnlyScan } from "../../lib/read-only-scan.js";
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
  /**
   * WCR-07 (2026-09-07) — CONTRACTED COLLABORATION CAPACITY.
   *
   * Seats and storage resolved from the contract; collaboration did not, so
   * an Enterprise group ceiling came from a flat catalog constant that could
   * sit BELOW the contracted seat count. `null` means the contract is silent
   * and the catalog default governs (decision CT-10) — the same meaning the two
   * allowances above carry, deliberately, so there is one convention to learn.
   */
  collaborationTeamsMax: number | null;
  collaborationTeamMembersMax: number | null;
  /**
   * LEGAL HOLD — a CONTRACTUAL capability, not an allowance.
   *
   * The four fields above read `null` as "the contract is SILENT, so the
   * catalog default governs". That is right for a number with a published
   * default and wrong for a capability grant: reading silence as "granted"
   * would hand Legal Hold to every Enterprise contract, which is the
   * plan-shortcut the product decision forbids.
   *
   * So here `null` and `false` both mean NOT GRANTED, and only `true`
   * grants — and only while the contract is ACTIVE, because
   * `resolveEnterpriseContractLimits` fails closed on status before reading
   * it.
   */
  legalHoldEnabled: boolean | null;
  /**
   * REVIEWER OPERATIONS — the contract may EXCLUDE them; it is not needed to
   * grant them. `null` (silent) and `true` keep the ENTERPRISE catalog answer
   * (included); only an explicit `false` excludes, and only while the
   * contract is ACTIVE.
   */
  reviewerOperationsEnabled: boolean | null;
  region: string | null;
  planVersion: string | null;
  billingCustomerRef: string | null;
  billingSubscriptionRef: string | null;
  contractOwnerUserId: string | null;
  /** The sales or CRM reference the contract was signed under. */
  externalContractRef: string | null;
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
  field:
    | "storageGb"
    | "evidenceRecordsPerMonth"
    | "aiOperationsPerMonth"
    | "collaborationTeamsMax"
    | "collaborationTeamMembersMax",
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Enterprise contract ${field} must be a positive whole number or null`,
    );
  }
  return value;
}

export class EnterpriseContractError extends Error {
  constructor(
    readonly code:
      | "ENTERPRISE_CONTRACT_REQUIRED"
      | "CONTRACT_ALREADY_TERMINATED"
      | "INVALID_CONTRACT_TERM",
    readonly httpStatus: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseContractError";
  }
}

/**
 * The terms of a sold contract. Everything a sales agreement states and an
 * enforcement path reads. Omitted leaves a term as it is. `null` clears one back
 * to what silence means for it: the published catalogue default for an allowance
 * (CT-10), not granted for Legal Hold, included for reviewer operations. Seats
 * have no null: an Enterprise contract with no seat count admits nobody, which
 * is a state a contract can be left in but never one an operator writes.
 */
export type EnterpriseContractTerms = {
  seatCount?: number;
  storageGb?: number | null;
  evidenceRecordsPerMonth?: number | null;
  aiOperationsPerMonth?: number | null;
  collaborationTeamsMax?: number | null;
  collaborationTeamMembersMax?: number | null;
  legalHoldEnabled?: boolean | null;
  reviewerOperationsEnabled?: boolean | null;
  assignmentRequiresTeamPlacement?: boolean | null;
  effectiveAtUtc?: Date | null;
  endsAtUtc?: Date | null;
  region?: string | null;
  planVersion?: string | null;
  billingCustomerRef?: string | null;
  billingSubscriptionRef?: string | null;
  externalContractRef?: string | null;
};

const CONTRACT_TERM_FIELDS = [
  "seatCount",
  "storageGb",
  "evidenceRecordsPerMonth",
  "aiOperationsPerMonth",
  "collaborationTeamsMax",
  "collaborationTeamMembersMax",
  "legalHoldEnabled",
  "reviewerOperationsEnabled",
  "assignmentRequiresTeamPlacement",
  "effectiveAtUtc",
  "endsAtUtc",
  "region",
  "planVersion",
  "billingCustomerRef",
  "billingSubscriptionRef",
  "externalContractRef",
] as const;

function normalizeContractTerms(terms: EnterpriseContractTerms): EnterpriseContractTerms {
  const seatCount = terms.seatCount;
  if (seatCount !== undefined && (!Number.isInteger(seatCount) || seatCount <= 0)) {
    throw new EnterpriseContractError(
      "INVALID_CONTRACT_TERM",
      400,
      "Seats must be a positive whole number.",
    );
  }
  const normalized: EnterpriseContractTerms = { ...terms };
  try {
    for (const field of [
      "storageGb",
      "evidenceRecordsPerMonth",
      "aiOperationsPerMonth",
      "collaborationTeamsMax",
      "collaborationTeamMembersMax",
    ] as const) {
      if (terms[field] !== undefined) {
        normalized[field] = normalizeContractAllowance(terms[field], field);
      }
    }
  } catch (err) {
    throw new EnterpriseContractError("INVALID_CONTRACT_TERM", 400, (err as Error).message);
  }
  return normalized;
}

/** The fields this write actually names, in the row's own shape. */
function stateTerms(terms: EnterpriseContractTerms): Partial<EnterpriseContractTerms> {
  return Object.fromEntries(
    CONTRACT_TERM_FIELDS.filter((field) => terms[field] !== undefined).map((field) => [
      field,
      terms[field],
    ]),
  );
}

/**
 * THE operator writer of contract terms (BILLING-002, PROV-002).
 *
 * Enforcement of every term existed and nothing could set one, so a sold Legal
 * Hold, a contracted storage figure or a stated collaboration limit needed direct
 * production SQL. The route in front of this is platform admin plus step-up, and
 * the terms and their before-and-after go into the organization's audit in the
 * same transaction. A TERMINATED contract is final and takes no more terms.
 */
export async function updateEnterpriseContractTermsTx(
  tx: TxClient,
  input: { organizationId: string; terms: EnterpriseContractTerms },
): Promise<{
  changed: Partial<Record<keyof EnterpriseContractTerms, { from: unknown; to: unknown }>>;
  seatCountChanged: boolean;
}> {
  const terms = normalizeContractTerms(input.terms);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enterprise-termination:${input.organizationId}`}))`;
  const row = await tx.enterpriseContract.findUnique({
    where: { organizationId: input.organizationId },
  });
  if (!row) {
    throw new EnterpriseContractError(
      "ENTERPRISE_CONTRACT_REQUIRED",
      409,
      "This organization has no contract.",
    );
  }
  if (row.status === "TERMINATED") {
    throw new EnterpriseContractError(
      "CONTRACT_ALREADY_TERMINATED",
      409,
      "A terminated contract is final.",
    );
  }
  const effective = terms.effectiveAtUtc !== undefined ? terms.effectiveAtUtc : row.effectiveAtUtc;
  const ends = terms.endsAtUtc !== undefined ? terms.endsAtUtc : row.endsAtUtc;
  if (effective && ends && ends.getTime() <= effective.getTime()) {
    throw new EnterpriseContractError(
      "INVALID_CONTRACT_TERM",
      400,
      "A contract must end after it takes effect.",
    );
  }

  const stated = stateTerms(terms);
  const changed: Partial<Record<keyof EnterpriseContractTerms, { from: unknown; to: unknown }>> = {};
  for (const [field, to] of Object.entries(stated) as Array<[keyof EnterpriseContractTerms, unknown]>) {
    const from = (row as unknown as Record<string, unknown>)[field] ?? null;
    const same =
      from instanceof Date && to instanceof Date ? from.getTime() === to.getTime() : from === to;
    if (!same) changed[field] = { from, to };
  }
  if (Object.keys(changed).length > 0) {
    await tx.enterpriseContract.update({
      where: { organizationId: input.organizationId },
      data: stated as never,
    });
  }
  return { changed, seatCountChanged: changed.seatCount !== undefined };
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
          collaborationTeamsMax: row.collaborationTeamsMax,
          collaborationTeamMembersMax: row.collaborationTeamMembersMax,
          legalHoldEnabled: row.legalHoldEnabled,
          reviewerOperationsEnabled: row.reviewerOperationsEnabled,
          region: row.region,
          planVersion: row.planVersion,
          billingCustomerRef: row.billingCustomerRef,
          billingSubscriptionRef: row.billingSubscriptionRef,
          contractOwnerUserId: row.contractOwnerUserId,
          externalContractRef: row.externalContractRef,
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
  // Not recorded inside a read-only scan (an operator's dry run): that is not
  // a use of the fallback by a customer, and a dry run writes nothing.
  if (!isReadOnlyScan()) emitTenantAudit({
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
    // Nor is there any org signal for contracted collaboration capacity.
    collaborationTeamsMax: null,
    collaborationTeamMembersMax: null,
    // Nor any signal for a contracted capability. A synthesised contract
    // grants nothing: the legacy fallback exists to describe an organization
    // that has no contract row, and "no contract row" cannot have bought
    // Legal Hold.
    legalHoldEnabled: null,
    // Silent: the catalog answer governs, as it did before the term existed.
    reviewerOperationsEnabled: null,
    region: null,
    planVersion: null,
    billingCustomerRef: null,
    billingSubscriptionRef: null,
    contractOwnerUserId: org.billingOwnerUserId ?? null,
    externalContractRef: null,
    legacyDerived: true,
  };
}

/**
 * THE contract status transition for offboarding (members audit LIFE-16).
 *
 * Termination writes two states: SUSPENDED when it is scheduled (the contract
 * grants nothing from that moment) and TERMINATED when the organization
 * closure that executes it commits. Both go through here, beside the
 * activation upsert below, so the contract keeps one canonical writer module.
 * TERMINATED is final: a transition never leaves it.
 */
export async function transitionEnterpriseContractStatusTx(
  tx: TxClient,
  input: {
    organizationId: string;
    to: "SUSPENDED" | "TERMINATED";
    terminationReason?: string | null;
    /** What the contract was, recorded when a termination begins. */
    statusBeforeTermination?: EnterpriseContractProjection["status"];
  },
): Promise<void> {
  await tx.enterpriseContract.updateMany({
    where: { organizationId: input.organizationId, status: { not: "TERMINATED" } },
    data: {
      status: input.to,
      ...(input.to === "TERMINATED"
        ? { terminatedAtUtc: new Date(), statusBeforeTermination: null }
        : {}),
      ...(input.statusBeforeTermination !== undefined
        ? { statusBeforeTermination: input.statusBeforeTermination }
        : {}),
      ...(input.terminationReason !== undefined
        ? { terminationReason: input.terminationReason?.slice(0, 400) ?? null }
        : {}),
    },
  });
}

/**
 * The way back from a withdrawn termination (PROV-009, BILLING-005): an explicit
 * operator act, through `resumeOrganization`. Seats and terms were never touched,
 * so restoring the status restores the contract. Nothing leaves TERMINATED.
 */
export async function reinstateEnterpriseContractTx(
  tx: TxClient,
  input: { organizationId: string },
): Promise<{ reinstatedTo: EnterpriseContractProjection["status"] } | null> {
  const row = await tx.enterpriseContract.findUnique({
    where: { organizationId: input.organizationId },
    select: { status: true, activationState: true, statusBeforeTermination: true },
  });
  if (row?.status !== "SUSPENDED") return null;
  // A termination withdrawn before this column existed recorded no prior status.
  const to =
    row.statusBeforeTermination ??
    (row.activationState === "ACTIVATED" ? "ACTIVE" : "PENDING_ACTIVATION");
  await tx.enterpriseContract.update({
    where: { organizationId: input.organizationId },
    data: { status: to, statusBeforeTermination: null, terminationReason: null },
  });
  return { reinstatedTo: to };
}

/** PROV-011 — the contract owner follows an organization ownership transfer. */
export async function transferEnterpriseContractOwnerTx(
  tx: TxClient,
  input: { organizationId: string; fromUserId: string; toUserId: string },
): Promise<boolean> {
  const moved = await tx.enterpriseContract.updateMany({
    where: { organizationId: input.organizationId, contractOwnerUserId: input.fromUserId },
    data: { contractOwnerUserId: input.toUserId },
  });
  return moved.count > 0;
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
    /** WCR-07 — contracted collaboration capacity. Same omit/null/value
     *  semantics as the two allowances above. */
    collaborationTeamsMax?: number | null;
    collaborationTeamMembersMax?: number | null;
    /**
     * The contracted Legal Hold capability. Omitted leaves the stored term
     * untouched; `false` or `null` records that the contract does not grant
     * it. No normaliser: a boolean has no ambiguous zero to reject.
     */
    legalHoldEnabled?: boolean | null;
    /**
     * The contracted reviewer-operations term. Omitted leaves it untouched;
     * `null` records silence (included), `false` excludes.
     */
    reviewerOperationsEnabled?: boolean | null;
    contractOwnerUserId?: string | null;
    effectiveAtUtc?: Date | null;
    region?: string | null;
    externalContractRef?: string | null;
  },
): Promise<void> {
  const delegate = (tx as { enterpriseContract?: unknown }).enterpriseContract;
  if (!delegate) return;
  try {
    // TERMINATED is final, and this writer used to step straight over it.
    const existing = await tx.enterpriseContract.findUnique({
      where: { organizationId: input.organizationId },
      select: { status: true },
    });
    if (existing?.status === "TERMINATED") {
      throw new EnterpriseContractError(
        "CONTRACT_ALREADY_TERMINATED",
        409,
        "A terminated contract is final.",
      );
    }
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
        ...(input.collaborationTeamsMax !== undefined
          ? {
              collaborationTeamsMax: normalizeContractAllowance(
                input.collaborationTeamsMax,
                "collaborationTeamsMax",
              ),
            }
          : {}),
        ...(input.collaborationTeamMembersMax !== undefined
          ? {
              collaborationTeamMembersMax: normalizeContractAllowance(
                input.collaborationTeamMembersMax,
                "collaborationTeamMembersMax",
              ),
            }
          : {}),
        ...(input.legalHoldEnabled !== undefined
          ? { legalHoldEnabled: input.legalHoldEnabled }
          : {}),
        ...(input.reviewerOperationsEnabled !== undefined
          ? { reviewerOperationsEnabled: input.reviewerOperationsEnabled }
          : {}),
        ...(input.contractOwnerUserId !== undefined
          ? { contractOwnerUserId: input.contractOwnerUserId }
          : {}),
        ...(input.effectiveAtUtc !== undefined
          ? { effectiveAtUtc: input.effectiveAtUtc }
          : {}),
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.externalContractRef !== undefined
          ? { externalContractRef: input.externalContractRef }
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
        collaborationTeamsMax: normalizeContractAllowance(
          input.collaborationTeamsMax ?? null,
          "collaborationTeamsMax",
        ),
        collaborationTeamMembersMax: normalizeContractAllowance(
          input.collaborationTeamMembersMax ?? null,
          "collaborationTeamMembersMax",
        ),
        legalHoldEnabled: input.legalHoldEnabled ?? null,
        reviewerOperationsEnabled: input.reviewerOperationsEnabled ?? null,
        contractOwnerUserId: input.contractOwnerUserId ?? null,
        effectiveAtUtc: input.effectiveAtUtc ?? new Date(),
        region: input.region ?? null,
        externalContractRef: input.externalContractRef ?? null,
      },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "P2021" && code !== "P2022") throw err;
  }
}

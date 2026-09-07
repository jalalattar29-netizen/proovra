/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — ENTERPRISE CONTRACT LIMITS
 * BECOME ENFORCEMENT.
 *
 * The defect this closes
 * ---------------------------------------------------------------------------
 * `resolveEnterpriseContract` already returned `seatCount` and `storageGb`, and
 * `resolveCommercialContext` already carried the projection on its envelope —
 * but NOTHING read either one. Storage came from
 * `PLAN_CAPABILITIES.ENTERPRISE.includedStorageBytes` (a flat 500 GB
 * placeholder) and seats from `input.seats ?? caps.includedSeats` (5). An
 * Enterprise customer contracted for 20 TB and 400 seats was enforced at
 * 500 GB and 5. The contract was displayed, never applied.
 *
 * The rule, stated once
 * ---------------------------------------------------------------------------
 * A contract value that is PRESENT is the limit. A contract value that is
 * ABSENT falls back to the canonical ENTERPRISE catalog default — never to a
 * guess, and never to "unlimited" invented at the call site.
 *
 * FAIL CLOSED FOR INCREASED PRIVILEGE: a contract that is not ACTIVE grants
 * nothing. `contractGovernsCapability` is false for DRAFT, PENDING_ACTIVATION,
 * SUSPENDED and TERMINATED, and callers must resolve those subjects at the
 * non-Enterprise baseline rather than honouring stale contract numbers.
 *
 * This module holds NO limit literals of its own. It converts one contract row
 * into the shape the enforcement paths already speak.
 */

import { getPlanCapabilities } from "../plan-catalog.service.js";
import type { EnterpriseContractProjection } from "../organization/enterprise-contract.service.js";

const BYTES_PER_GB = 1024n * 1024n * 1024n;

export type EnterpriseContractLimits = {
  /**
   * True only when the contract is ACTIVE. False means the subject must be
   * resolved at the non-Enterprise baseline: a suspended or terminated
   * contract may not keep granting Enterprise capability.
   */
  contractGovernsCapability: boolean;
  /** Contracted cumulative storage, or null when the contract is silent. */
  storageBytes: bigint | null;
  /** Contracted workspace seats, or null when the contract is silent. */
  seats: number | null;
  /** Contracted evidence records per rolling window, or null. */
  evidenceRecordsPerMonth: number | null;
  /** Contracted AI operations per calendar month, or null. */
  aiOperationsPerMonth: number | null;
  /**
   * WCR-07 — contracted collaboration capacity, or null when the contract is
   * silent. Two dimensions, kept apart for the same reason seats and groups
   * are kept apart everywhere else: one counts GROUPS in a workspace, the
   * other counts PEOPLE inside one group, and multiplying them was never the
   * commercial model.
   */
  collaborationTeams: number | null;
  collaborationTeamMembers: number | null;
  /**
   * True when this projection came from the legacy fallback rather than a real
   * contract row. Surfaces are required to say "Contract-managed — contact
   * your account manager" instead of publishing a number derived from a guess.
   */
  legacyDerived: boolean;
};

/**
 * A contract that grants nothing. The fail-closed default.
 *
 * The readers below also accept `null`/`undefined` and treat it identically.
 * A scope that predates the `contractLimits` field — a hand-built test double,
 * or a caller mid-migration — must therefore resolve at the catalog baseline,
 * never crash and never accidentally grant Enterprise capacity.
 */
export const NO_CONTRACT_LIMITS: EnterpriseContractLimits = {
  contractGovernsCapability: false,
  storageBytes: null,
  seats: null,
  evidenceRecordsPerMonth: null,
  aiOperationsPerMonth: null,
  collaborationTeams: null,
  collaborationTeamMembers: null,
  legacyDerived: false,
};

function positiveOrNull(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Project one canonical contract into enforceable limits.
 *
 * `null` in means "this workspace has no CUSTOMER organization contract", which
 * is the ordinary case for Personal and self-serve Owned workspaces.
 */
export function resolveEnterpriseContractLimits(
  contract: EnterpriseContractProjection | null,
): EnterpriseContractLimits {
  if (!contract) return NO_CONTRACT_LIMITS;

  // FAIL CLOSED. DRAFT / PENDING_ACTIVATION have not begun; SUSPENDED and
  // TERMINATED have ended. None of them may grant capability, and none of
  // their stored numbers may raise a limit.
  if (contract.status !== "ACTIVE") {
    return { ...NO_CONTRACT_LIMITS, legacyDerived: contract.legacyDerived };
  }

  const storageGb = positiveOrNull(contract.storageGb);

  return {
    contractGovernsCapability: true,
    storageBytes: storageGb === null ? null : BigInt(storageGb) * BYTES_PER_GB,
    seats: positiveOrNull(contract.seatCount),
    // BILLING PRODUCTION CLOSURE (2026-08-27) — read straight off the
    // projection. These two used to be reached through
    // `(contract as { evidenceRecordsPerMonth?: number })`, a cast asserting a
    // field the projection type did not declare and the reader never selected.
    // It compiled, it never threw, and it always produced `undefined` — so a
    // contracted allowance could not reach enforcement at all.
    evidenceRecordsPerMonth: positiveOrNull(contract.evidenceRecordsPerMonth),
    aiOperationsPerMonth: positiveOrNull(contract.aiOperationsPerMonth),
    collaborationTeams: positiveOrNull(contract.collaborationTeamsMax),
    collaborationTeamMembers: positiveOrNull(contract.collaborationTeamMembersMax),
    legacyDerived: contract.legacyDerived,
  };
}

/**
 * The effective cumulative storage capacity for a workspace, BEFORE add-ons.
 *
 * A contracted figure wins outright — it is neither floored nor maxed against
 * the catalog default, because the contract IS the purchased right and taking
 * `max()` with a placeholder would silently sell capacity nobody agreed to.
 */
export function resolveEffectiveBaseStorageBytes(input: {
  plan: Parameters<typeof getPlanCapabilities>[0];
  contract: EnterpriseContractLimits | null | undefined;
}): bigint {
  if (input.contract?.contractGovernsCapability && input.contract?.storageBytes !== null) {
    return input.contract?.storageBytes;
  }
  return getPlanCapabilities(input.plan).includedStorageBytes;
}

/** The effective seat ceiling for one shared workspace, contract first. */
export function resolveEffectiveContractSeats(input: {
  plan: Parameters<typeof getPlanCapabilities>[0];
  contract: EnterpriseContractLimits | null | undefined;
  /** Seats already persisted on the workspace row. */
  persistedSeats: number;
}): number {
  if (input.contract?.contractGovernsCapability && input.contract?.seats !== null) {
    return input.contract?.seats;
  }
  const caps = getPlanCapabilities(input.plan);
  return Math.max(0, caps.maxWorkspaceSeats, caps.includedSeats, input.persistedSeats);
}

/**
 * WCR-07 — the effective ceiling on ACTIVE Collaboration Teams in one
 * workspace.
 *
 * The catalog's ENTERPRISE row carries 1000, which is a placeholder standing in
 * for "a lot", not a term anybody signed. Where the contract states a number it
 * wins outright — above OR below the placeholder — for the same reason the
 * storage resolver does not take a `max()`: a contract is the purchased right,
 * and reconciling it against a placeholder either sells capacity nobody agreed
 * to or withholds capacity somebody paid for.
 *
 * Silence still means the catalog default, so an existing Enterprise contract
 * that says nothing about collaboration behaves exactly as it did before the
 * column existed.
 */
export function resolveEffectiveCollaborationTeamLimit(input: {
  plan: Parameters<typeof getPlanCapabilities>[0];
  contract: EnterpriseContractLimits | null | undefined;
}): number {
  if (
    input.contract?.contractGovernsCapability &&
    input.contract?.collaborationTeams !== null &&
    input.contract?.collaborationTeams !== undefined
  ) {
    return input.contract.collaborationTeams;
  }
  return getPlanCapabilities(input.plan).maxCollaborationTeamsPerWorkspace;
}

/**
 * WCR-07 — the effective SAFETY ceiling on ACTIVE members inside ONE group.
 *
 * This is not a seat pool and never was: the commercial boundary is the set of
 * distinct ACTIVE workspace memberships, and a person in five groups is one
 * seat. What this bounds is how large a single group may grow, and the caller
 * (`assertCollaborationTeamMemberLimit`) still reconciles the answer down to
 * the workspace's actual seat entitlement, so a group can never be told it may
 * hold more people than the workspace has.
 *
 * Before this existed the reconciliation ran against a flat catalog 500, which
 * meant an organization contracted for 800 seats could put only 500 of them in
 * a group — a self-serve placeholder capping a signed agreement.
 */
export function resolveEffectiveCollaborationMemberLimit(input: {
  plan: Parameters<typeof getPlanCapabilities>[0];
  contract: EnterpriseContractLimits | null | undefined;
}): number {
  if (
    input.contract?.contractGovernsCapability &&
    input.contract?.collaborationTeamMembers !== null &&
    input.contract?.collaborationTeamMembers !== undefined
  ) {
    return input.contract.collaborationTeamMembers;
  }
  return getPlanCapabilities(input.plan).maxAcceptedMembersPerCollaborationTeam;
}

/**
 * The effective rolling-window evidence-record cap. `null` = no cap.
 * A contract figure wins; otherwise the catalog default applies.
 */
export function resolveEffectiveContractEvidenceCap(input: {
  plan: Parameters<typeof getPlanCapabilities>[0];
  contract: EnterpriseContractLimits | null | undefined;
}): number | null {
  if (
    input.contract?.contractGovernsCapability &&
    input.contract?.evidenceRecordsPerMonth !== null
  ) {
    return input.contract?.evidenceRecordsPerMonth;
  }
  return getPlanCapabilities(input.plan).maxEvidenceRecordsPerMonth;
}

/**
 * The effective monthly AI-operation cap. `null` = contract-managed / no cap.
 */
export function resolveEffectiveContractAiCap(input: {
  plan: Parameters<typeof getPlanCapabilities>[0];
  contract: EnterpriseContractLimits | null | undefined;
}): number | null {
  if (
    input.contract?.contractGovernsCapability &&
    input.contract?.aiOperationsPerMonth !== null
  ) {
    return input.contract?.aiOperationsPerMonth;
  }
  return getPlanCapabilities(input.plan).aiAdvisoryMonthlyOperations;
}

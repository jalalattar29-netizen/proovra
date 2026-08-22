/**
 * CANONICAL ENTERPRISE COMMERCIAL AUTHORITY (Attention Architecture, 2026-08-22).
 *
 * THE DEFECT THIS REPLACES
 * ------------------------
 * `isEnterpriseWorkspace` was computed as
 * `ENTERPRISE_PLAN_KEYS.has(workspace.plan)` — a string comparison against
 * `Team.billingPlan`. The schema is explicit that this is the wrong
 * authority:
 *
 *   "PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2).
 *    ONE authoritative record of an Enterprise customer's commercial scope.
 *    Plan strings on workspaces and `pendingEnterpriseSeats` are LEGACY
 *    signals consumed only by the resolver's compatibility fallback until
 *    the contract backfill migration is applied."
 *
 * A plan string is a BILLING PACKAGE fact. "Is this customer Enterprise?"
 * is a COMMERCIAL CONTRACT fact, and the two answer different questions:
 * a workspace can carry an ENTERPRISE package while its organization's
 * contract is TERMINATED, and an ACTIVE contract can exist over a
 * workspace whose plan string was never migrated.
 *
 * THE FIVE CONCEPTS, KEPT APART
 * -----------------------------
 * This module exists to stop these from being used interchangeably:
 *
 *   workspaceKind        structural  — PERSONAL | OWNED | ORGANIZATION
 *   organizationKind     structural  — SYSTEM | CUSTOMER
 *   accountEntitlement   commercial  — follows the USER (Entitlement)
 *   workspaceBillingPlan commercial  — follows the WORKSPACE (Team.billingPlan)
 *   enterpriseContract   commercial  — follows the CUSTOMER ORGANIZATION
 *
 * Capabilities are derived FROM these; they are not one of them.
 *
 * FAIL-CLOSED POSTURE
 * -------------------
 * An unprovable contract is not an Enterprise contract. When the contract
 * row cannot be read, `isEnterpriseCustomer` is false and `source` records
 * why, so a degraded read can never silently promote a tenant into the
 * Enterprise surface.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import type { WorkspacePlan } from "./types.js";

/**
 * How the Enterprise verdict was reached. Recorded on the envelope so a
 * support engineer can tell a contract-backed Enterprise from a legacy
 * plan-string one without opening the database.
 */
export type EnterpriseAuthoritySource =
  /** An EnterpriseContract row in a live state governs this workspace. */
  | "contract"
  /**
   * COMPATIBILITY. No contract row exists yet, and the workspace carries
   * the legacy ENTERPRISE plan string. Retained until the contract
   * backfill lands; the schema documents this exact fallback.
   */
  | "legacy_plan"
  /** Neither authority reports Enterprise. */
  | "none"
  /** The contract could not be read. Fails closed to NOT enterprise. */
  | "unavailable";

export type EnterpriseAuthority = {
  /**
   * THE canonical answer to "is this an Enterprise customer context?".
   * Consumed by capability resolution and by any surface that scales its
   * density with commercial tier.
   */
  isEnterpriseCustomer: boolean;
  /** Which authority decided, for observability and support. */
  source: EnterpriseAuthoritySource;
  /** Raw contract status when a contract row exists. */
  contractStatus: string | null;
  /**
   * Whether the contract is within its effective window. Null when no
   * contract row exists.
   */
  contractInEffect: boolean | null;
  /** The CUSTOMER organization the contract belongs to, when known. */
  organizationId: string | null;
};

export const NO_ENTERPRISE_AUTHORITY: EnterpriseAuthority = {
  isEnterpriseCustomer: false,
  source: "none",
  contractStatus: null,
  contractInEffect: null,
  organizationId: null,
};

/**
 * Contract states that grant Enterprise scope.
 *
 * DRAFT and PENDING_ACTIVATION deliberately do NOT: a contract that has
 * not been activated has not yet bought anything, and provisioning must
 * not be able to hand out the surface before activation. SUSPENDED and
 * TERMINATED do not either — a suspended customer keeps their data and
 * loses their tier.
 */
const LIVE_CONTRACT_STATUSES: ReadonlySet<string> = new Set(["ACTIVE"]);

/**
 * LEGACY. The plan string that used to be the only Enterprise signal.
 * Referenced in exactly one place — the compatibility branch below — so
 * that deleting the fallback after the contract backfill is a one-line
 * change rather than a repository-wide hunt.
 */
const LEGACY_ENTERPRISE_PLAN_KEYS: ReadonlySet<string> = new Set(["ENTERPRISE"]);

export type EnterpriseAuthorityInput = {
  /** Resolved structural kind of the ACTIVE workspace. */
  workspaceKind: "PERSONAL" | "OWNED" | "ORGANIZATION" | "UNKNOWN";
  /** Structural kind of the workspace's parent organization. */
  organizationKind: "SYSTEM" | "CUSTOMER" | null;
  organizationId: string | null;
  /** LEGACY billing-package string on the workspace. */
  workspaceBillingPlan: WorkspacePlan | null;
  /** The contract row, when one was read. `undefined` means "not read". */
  contract:
    | {
        status: string;
        effectiveAtUtc: Date | null;
        endsAtUtc: Date | null;
      }
    | null
    | undefined;
  /** True when the contract lookup threw. Forces the fail-closed branch. */
  contractReadFailed: boolean;
  now: Date;
};

/**
 * PURE derivation, exported so the rules are unit-testable without a
 * database — the same split `operational-eligibility.ts` uses.
 */
export function deriveEnterpriseAuthority(
  input: EnterpriseAuthorityInput,
): EnterpriseAuthority {
  // A read failure can never promote. State it explicitly rather than
  // letting it fall through to the legacy branch, which would turn a
  // transient database error into a tier upgrade.
  if (input.contractReadFailed) {
    return {
      isEnterpriseCustomer: false,
      source: "unavailable",
      contractStatus: null,
      contractInEffect: null,
      organizationId: input.organizationId,
    };
  }

  // ---------------------------------------------------------------------
  // Authority 1 — the EnterpriseContract. Only a CUSTOMER organization can
  // hold one; a SYSTEM container is an internal bootstrap object and is
  // never a commercial counterparty.
  // ---------------------------------------------------------------------
  if (input.contract && input.organizationKind === "CUSTOMER") {
    const statusLive = LIVE_CONTRACT_STATUSES.has(input.contract.status);
    const nowMs = input.now.getTime();
    const started =
      input.contract.effectiveAtUtc === null ||
      input.contract.effectiveAtUtc.getTime() <= nowMs;
    const notEnded =
      input.contract.endsAtUtc === null ||
      input.contract.endsAtUtc.getTime() > nowMs;
    const inEffect = statusLive && started && notEnded;
    return {
      isEnterpriseCustomer: inEffect,
      source: "contract",
      contractStatus: input.contract.status,
      contractInEffect: inEffect,
      organizationId: input.organizationId,
    };
  }

  // ---------------------------------------------------------------------
  // Authority 2 — LEGACY compatibility. No contract row exists yet.
  //
  // Bounded by BOTH structural facts, deliberately:
  //
  //   workspaceKind === "ORGANIZATION"  — a PERSONAL or OWNED workspace
  //     carrying an ENTERPRISE plan string is data drift, not a customer.
  //     Promoting it is exactly the "commercial upgrade becomes a silent
  //     tenancy change" failure the workspaceKind migration was written
  //     to stop.
  //
  //   organizationKind === "CUSTOMER"   — REQUIRED for the same reason the
  //     contract branch requires it. A SYSTEM organization is the internal
  //     1:1 bootstrap container every workspace receives; it is never a
  //     commercial counterparty, so no plan string on a workspace beneath
  //     one can make it an Enterprise customer.
  //
  // The second condition was missing when this resolver was first written,
  // and the policy revalidation matrix caught it: a SYSTEM-backed workspace
  // classified ORGANIZATION with a drifted ENTERPRISE plan was promoted.
  // That is the fallback quietly becoming a second enterprise authority,
  // which is the precise failure this branch must not be allowed to become.
  // ---------------------------------------------------------------------
  if (
    input.workspaceKind === "ORGANIZATION" &&
    input.organizationKind === "CUSTOMER" &&
    input.workspaceBillingPlan !== null &&
    LEGACY_ENTERPRISE_PLAN_KEYS.has(input.workspaceBillingPlan)
  ) {
    return {
      isEnterpriseCustomer: true,
      source: "legacy_plan",
      contractStatus: null,
      contractInEffect: null,
      organizationId: input.organizationId,
    };
  }

  return { ...NO_ENTERPRISE_AUTHORITY, organizationId: input.organizationId };
}

/**
 * Load the contract and derive the verdict. Never throws — a failed read
 * becomes `source: "unavailable"` and a false verdict.
 */
export async function resolveEnterpriseAuthority(
  input: Omit<EnterpriseAuthorityInput, "contract" | "contractReadFailed" | "now"> & {
    now?: Date;
  },
  client: PrismaClient = defaultPrisma,
): Promise<EnterpriseAuthority> {
  const now = input.now ?? new Date();

  // No organization, or an internal SYSTEM container: there is nothing to
  // read. This is not a failure — it is a definitive "not a customer".
  if (!input.organizationId || input.organizationKind !== "CUSTOMER") {
    return deriveEnterpriseAuthority({
      ...input,
      contract: null,
      contractReadFailed: false,
      now,
    });
  }

  let contract: EnterpriseAuthorityInput["contract"] = null;
  let contractReadFailed = false;
  try {
    contract = await client.enterpriseContract.findUnique({
      where: { organizationId: input.organizationId },
      select: { status: true, effectiveAtUtc: true, endsAtUtc: true },
    });
  } catch {
    contractReadFailed = true;
  }

  return deriveEnterpriseAuthority({
    ...input,
    contract,
    contractReadFailed,
    now,
  });
}

/**
 * Phase 2 — Enterprise activation & provisioning keystone.
 *
 * Two platform-admin-only operations that let an enterprise customer be
 * activated WITHOUT a manual DB edit, reusing the LOCKED org/workspace/
 * invite primitives (Organization, Team, OrganizationInvite,
 * OrganizationMembership). No parallel models are introduced.
 *
 *   grantEnterprisePlanToOrg   — flip every workspace (Team) of an org
 *                                to a billing plan (ENTERPRISE) so the
 *                                existing capability gates auto-unlock
 *                                (getPlanCapabilities(plan).enterpriseFeatures).
 *   provisionEnterpriseCustomer — create a new Organization and either
 *                                (a) attach an enterprise workspace to an
 *                                existing owner, or (b) mint a canonical
 *                                ORG_OWNER invite for a not-yet-existing
 *                                owner (no workspace — ownerUserId is
 *                                required on Team).
 *
 * Hard rules:
 *   - This is the ONLY path (besides the locked billing checkout/webhook,
 *     which we never touch) that assigns ENTERPRISE.
 *   - Every mutation writes its audit rows INSIDE the same transaction
 *     (org audit) plus a platform audit-log row (chain-hashed) after
 *     commit. Effect-without-audit is unacceptable.
 *   - Invite tokens: raw 32-byte hex returned ONCE; only the SHA-256
 *     hash is persisted (mirrors organizations.routes.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { TeamBillingStatus, TeamRole } from "@prisma/client";

import { prisma as defaultPrisma } from "../db.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
// PHASE 12 POINT 4 PASS C — the ONE seat-limit policy lives with the canonical
// commercial authority; this module must not re-implement it.
import { refreshTeamSeatState } from "./billing.service.js";
import { hashInviteToken } from "../routes/organizations.routes.js";
import { emitOrgAuditEvent } from "./organization/org-audit.service.js";
import { emitTenantAudit } from "./audit/tenant-audit.service.js";
// PHASE 3 (2026-07-21) — canonical membership orchestrator.
import { provisionMembership } from "./identity/membership-provisioning.service.js";
// PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2).
import {
  updateEnterpriseContractTermsTx,
  upsertEnterpriseContract,
  type EnterpriseContractTerms,
} from "./organization/enterprise-contract.service.js";
// Macro-Wave A2 — durable owner-invite delivery: outbox row committed in
// the SAME transaction as the ORG_OWNER invite, inline first email attempt
// after commit (raw token in memory only), worker-driven rotation retries
// for stranded rows. Same chain as the org single/bulk invite paths.
import {
  attemptInitialOrgInviteDelivery,
  recordOrgInviteDeliveryPending,
} from "./organization/org-invite-delivery.service.js";

/** Plans this admin path is allowed to grant. ENTERPRISE only for now. */
export type GrantablePlan = "ENTERPRISE";

/** 7-day invite expiry (mirrors organizations.routes.ts inviteExpiresAt). */
function inviteExpiresAt(now = Date.now()): Date {
  return new Date(now + 7 * 24 * 60 * 60 * 1000);
}

/** 32 random bytes hex-encoded (mirrors organizations.routes.ts newInviteToken). */
function newInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export class EnterpriseProvisioningError extends Error {
  code:
    | "ORG_NOT_FOUND"
    | "ORG_HAS_NO_WORKSPACES"
    // The organization exists but is not a customer. Distinct from
    // ORG_NOT_FOUND, which would tell an operator to go looking for a row
    // that is right there.
    | "NOT_CUSTOMER_ORGANIZATION"
    // PROV-010 / BILLING-006 — a plan grant is not a way round the lifecycle.
    | "ORG_NOT_ACTIVE"
    | "OWNER_NOT_PENDING"
    | "CONTRACT_NOT_GRANTABLE"
    | "SEATS_REQUIRED"
    // PHASE 4 §7.1 (2026-07-22) — idempotency outcomes.
    | "IDEMPOTENCY_CONFLICT"
    | "PROVISIONING_IN_PROGRESS";
  constructor(code: EnterpriseProvisioningError["code"], message: string) {
    super(message);
    this.name = "EnterpriseProvisioningError";
    this.code = code;
  }
}

export type GrantEnterprisePlanInput = {
  orgId: string;
  plan?: GrantablePlan;
  seats?: number;
  actorUserId: string;
};

export type GrantEnterprisePlanResult = {
  organizationId: string;
  plan: GrantablePlan;
  seats: number;
  workspacesUpdated: number;
};

/**
 * Grant a billing plan (ENTERPRISE) to EVERY workspace (Team) of an org.
 *
 * For each workspace:
 *   billingPlan   = plan
 *   includedSeats = seats ?? getPlanCapabilities(plan).includedSeats
 *   billingStatus = ACTIVE
 *   overSeatLimit — persisted after commit by refreshTeamSeatState (the one
 *                   seat answer; members re-audit ENT-05 / defect 14)
 *
 * Setting billingPlan=ENTERPRISE auto-unlocks SSO/SCIM/legalHold/etc via
 * getPlanCapabilities(plan).enterpriseFeatures — no separate feature flags.
 */
export async function grantEnterprisePlanToOrg(
  input: GrantEnterprisePlanInput,
  client: PrismaClient = defaultPrisma,
): Promise<GrantEnterprisePlanResult> {
  const plan: GrantablePlan = input.plan ?? "ENTERPRISE";

  const result = await client.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: input.orgId },
      select: { id: true, status: true },
    });
    if (!org) {
      throw new EnterpriseProvisioningError(
        "ORG_NOT_FOUND",
        "Organization not found.",
      );
    }
    // Serialise with termination, which holds this lock while it writes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enterprise-termination:${input.orgId}`}))`;
    /*
     * PROV-010 / BILLING-006 — A PLAN GRANT IS NOT A WAY ROUND THE LIFECYCLE.
     *
     * This checked only that the organization existed, then wrote ACTIVE over a
     * TERMINATED contract, over closed workspaces and over a termination still
     * running. And it read seats only from an ACTIVE contract, so repairing a
     * suspended 400-seat customer without repeating the number made them a
     * 5-seat one. The grant applies to an operating organization whose contract
     * can take it, and silence about seats means what the contract says, or
     * nothing: the catalog placeholder is never a contract term.
     */
    if (org.status !== "ACTIVE") {
      throw new EnterpriseProvisioningError(
        "ORG_NOT_ACTIVE",
        "The plan can be granted only to an active organization.",
      );
    }
    const contract = await tx.enterpriseContract.findUnique({
      where: { organizationId: input.orgId },
      select: { status: true, seatCount: true },
    });
    if (contract?.status === "TERMINATED" || contract?.status === "SUSPENDED") {
      throw new EnterpriseProvisioningError(
        "CONTRACT_NOT_GRANTABLE",
        contract.status === "TERMINATED"
          ? "A terminated contract is final."
          : "This contract is suspended. Resume the organization to reinstate it.",
      );
    }
    /*
     * A PERSONAL SPACE'S CONTAINER IS NOT AN ENTERPRISE CUSTOMER.
     *
     * The guard here is NOT `kind !== "CUSTOMER"`. This function is the act
     * that MAKES an organization a customer — it promotes `kind` to CUSTOMER
     * below, which is the whole point of the P1 domain remediation. Refusing a
     * SYSTEM organization would refuse every legitimate first grant.
     *
     * What must never happen is granting an org-wide enterprise plan to the
     * 1:1 container behind somebody's PERSONAL space. `Team.isPersonal` is the
     * property that distinguishes the two, and it is the one this checks: a
     * personal space is bootstrapped for an individual and is not a purchased
     * organization, so rewriting its `billingPlan`, `includedSeats` and
     * `billingStatus` through a customer control would silently move an
     * individual onto an enterprise plan they never bought — and the customer
     * roster would never show it, because a personal container is not a
     * customer and never becomes one this way.
     */

    const workspaces = await tx.team.findMany({
      where: { organizationId: input.orgId, closedAtUtc: null },
      select: {
        id: true,
        isPersonal: true,
      },
    });
    if (workspaces.length === 0) {
      throw new EnterpriseProvisioningError(
        "ORG_HAS_NO_WORKSPACES",
        "This organization has no workspace yet. Its owner's acceptance creates it.",
      );
    }

    /*
     * The guard reads the workspaces this grant is about to rewrite, rather
     * than asking a second question of the database.
     */
    if (workspaces.some((ws) => ws.isPersonal)) {
      throw new EnterpriseProvisioningError(
        "NOT_CUSTOMER_ORGANIZATION",
        "Plan grants apply to customer organizations, not to a personal space container.",
      );
    }

    const seats = input.seats ?? contract?.seatCount ?? null;
    if (seats === null || seats <= 0) {
      throw new EnterpriseProvisioningError(
        "SEATS_REQUIRED",
        "This contract states no seats. State how many were sold.",
      );
    }

    for (const ws of workspaces) {
      // The seat posture is NOT computed here: it is persisted after commit
      // by the one canonical writer (members re-audit ENT-05 / defect 14).
      await tx.team.update({
        where: { id: ws.id },
        data: {
          billingPlan: plan,
          includedSeats: seats,
          billingStatus: TeamBillingStatus.ACTIVE,
          // P1 domain remediation (2026-07-21) — an org-plan grant makes
          // these workspaces enterprise-organization operational contexts.
          ...(plan === "ENTERPRISE"
            ? { workspaceKind: "ORGANIZATION" as const }
            : {}),
        },
      });
    }

    // P1 domain remediation (2026-07-21) — granting ENTERPRISE promotes the
    // org itself to a real CUSTOMER organization.
    if (plan === "ENTERPRISE") {
      await tx.organization.update({
        where: { id: input.orgId },
        data: { kind: "CUSTOMER" },
      });
      // PHASE 10 §1.4 — promotion to CUSTOMER must ensure an EXPLICIT baseline
      // security policy exists (idempotent: create only if the org has none).
      const existingPolicy = await (
        tx.organizationSecurityPolicy.findUnique as unknown as (a: unknown) => Promise<{ organizationId: string | null } | null>
      )({ where: { organizationId: input.orgId }, select: { organizationId: true } });
      if (!existingPolicy) {
        await (tx.organizationSecurityPolicy.create as unknown as (a: unknown) => Promise<unknown>)({
          data: { organizationId: input.orgId, policyVersion: 1 },
        });
      }
      // PHASE 4 (2026-07-22) — the plan grant is a contract event (§7.2).
      await upsertEnterpriseContract(tx, {
        organizationId: input.orgId,
        status: "ACTIVE",
        activationState: "ACTIVATED",
        seatCount: seats,
      });
    }

    await emitOrgAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.actorUserId,
      eventType: "ORG_PLAN_GRANTED",
      targetType: "organization",
      targetId: input.orgId,
      metadata: {
        plan,
        seats,
        workspacesUpdated: workspaces.length,
      },
    });

    return { workspacesUpdated: workspaces.length, workspaceIds: workspaces.map((w) => w.id), seats };
  });
  const { seats } = result;

  // Members re-audit ENT-05 / defect 14 — one seat answer. The canonical
  // resolver reads the commercial context the grant just committed, so it runs
  // after the transaction, never inside it (it would read the pre-grant plan).
  for (const workspaceId of result.workspaceIds) {
    await refreshTeamSeatState(workspaceId, client as never);
  }

  await emitTenantAudit({
    action: "ORG_PLAN_GRANTED",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    organizationId: input.orgId,
    resourceType: "organization",
    resourceId: input.orgId,
    metadata: {
      plan,
      seats,
      workspacesUpdated: result.workspacesUpdated,
    },
  }, client);

  return {
    organizationId: input.orgId,
    plan,
    seats,
    workspacesUpdated: result.workspacesUpdated,
  };
}

/**
 * BILLING-002 — state the terms of a sold contract, for every workspace of the
 * organization. Seats also move `Team.includedSeats`, and the seat posture is
 * persisted after commit by the one canonical writer, like a plan grant.
 */
export async function updateEnterpriseContractTerms(
  input: {
    organizationId: string;
    actorUserId: string;
    terms: EnterpriseContractTerms;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ organizationId: string; changed: string[] }> {
  const result = await client.$transaction(async (tx) => {
    const { changed, seatCountChanged } = await updateEnterpriseContractTermsTx(tx, {
      organizationId: input.organizationId,
      terms: input.terms,
    });
    const workspaces = await tx.team.findMany({
      where: { organizationId: input.organizationId, closedAtUtc: null },
      select: { id: true },
    });
    if (seatCountChanged) {
      await tx.team.updateMany({
        where: { id: { in: workspaces.map((w) => w.id) } },
        data: { includedSeats: input.terms.seatCount as number },
      });
    }
    if (Object.keys(changed).length > 0) {
      await emitOrgAuditEvent(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        eventType: "ENTERPRISE_CONTRACT_TERMS_UPDATED",
        targetType: "organization",
        targetId: input.organizationId,
        metadata: { changed: JSON.parse(JSON.stringify(changed)) },
      });
    }
    return { changed, seatCountChanged, workspaceIds: workspaces.map((w) => w.id) };
  });

  if (result.seatCountChanged) {
    for (const workspaceId of result.workspaceIds) {
      await refreshTeamSeatState(workspaceId, client as never);
    }
  }
  const changed = Object.keys(result.changed);
  if (changed.length > 0) {
    await emitTenantAudit({
      action: "ENTERPRISE_CONTRACT_TERMS_UPDATED",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      actorAuthority: "PLATFORM_ADMIN",
      organizationId: input.organizationId,
      resourceType: "enterprise_contract",
      resourceId: input.organizationId,
      metadata: { changed: JSON.parse(JSON.stringify(result.changed)) },
    }, client).catch(() => null);
  }
  return { organizationId: input.organizationId, changed };
}

// =============================================================================
// PHASE 4 §7.1 (2026-07-22) — idempotent Enterprise provisioning.
//
// The canonical duplicate-prevention identity is the IMMUTABLE caller-
// supplied `idempotencyKey` (provisioning-request id / CRM contract ref) with
// a DB unique constraint — NEVER normalized names/emails. Behavior:
//   1. same key + same payload      → the ORIGINAL result is returned
//      (idempotentReplay: true). One-time secrets (the raw owner-invite
//      token) are NOT re-returned — the locked invite-token contract says
//      raw tokens are surfaced exactly once and never persisted plaintext.
//   2. same key + different payload → IDEMPOTENCY_CONFLICT, no mutation.
//   3. different keys + same name/email → NOT merged; advisory
//      `possibleDuplicateOrganizationIds` is returned for operator review.
//   4. concurrent same-key requests → the DB unique constraint collapses
//      them: one runs, the loser replays/receives PROVISIONING_IN_PROGRESS.
//   5. failed attempt → the request row is FAILED; a same-key+same-payload
//      retry re-runs the (single-transaction) provisioning safely — a
//      failed attempt leaves no partial customer. The COMPLETED row commits in
//      the provisioning transaction (PROV-006), so there is no moment at which a
//      customer exists and the request says otherwise, and nothing after that
//      commit can fail the request.
// =============================================================================

/** Deterministic hash of the provisioning payload (identity-relevant fields). */
function provisioningPayloadHash(input: {
  organizationName: string;
  ownerEmail: string;
  seats?: number;
  workspaceName?: string;
  region?: string | null;
  externalContractRef?: string | null;
  terms?: ProvisioningContractTerms;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationName: input.organizationName.trim(),
        ownerEmail: input.ownerEmail.trim().toLowerCase(),
        seats: input.seats ?? null,
        workspaceName: input.workspaceName?.trim() ?? null,
        region: input.region ?? null,
        externalContractRef: input.externalContractRef ?? null,
        ...(input.terms ? { terms: input.terms } : {}),
      }),
    )
    .digest("hex");
}

/** Redact one-time secrets before persisting a replayable result snapshot. */
function redactProvisioningResult(
  result: ProvisionEnterpriseCustomerResult,
): Record<string, unknown> {
  // Macro-Wave A2 — `inviteUrl` EMBEDS the raw token, so it is redacted
  // from the durable snapshot exactly like `ownerInviteToken` (raw
  // acceptance tokens must never persist in any durable metadata).
  const rest: Record<string, unknown> = { ...result };
  delete rest.ownerInviteToken;
  delete rest.inviteUrl;
  return {
    ...rest,
    ownerInviteToken: null,
    inviteUrl: null,
    oneTimeSecretRedacted: true,
  };
}

/** In-flight takeover threshold for crashed PENDING rows (single-tx safe). */
const PENDING_TAKEOVER_MS = 60_000;

export type ProvisionEnterpriseCustomerIdempotentInput =
  ProvisionEnterpriseCustomerInput & {
    idempotencyKey: string;
    externalContractRef?: string | null;
    region?: string | null;
  };

export type ProvisionEnterpriseCustomerIdempotentResult = {
  result: ProvisionEnterpriseCustomerResult | Record<string, unknown>;
  idempotentReplay: boolean;
  /** Advisory only — same-name CUSTOMER orgs for operator duplicate review. */
  possibleDuplicateOrganizationIds: string[];
};

export async function provisionEnterpriseCustomerIdempotent(
  input: ProvisionEnterpriseCustomerIdempotentInput,
  client: PrismaClient = defaultPrisma,
  // Injectable for tests — production always uses the real single-tx
  // provisioning implementation below.
  deps: { provision?: typeof provisionEnterpriseCustomer } = {},
): Promise<ProvisionEnterpriseCustomerIdempotentResult> {
  const payloadHash = provisioningPayloadHash(input);

  // ---- claim or load the request row (DB-unique on the key) -------------
  let requestId: string;
  try {
    const created = await client.enterpriseProvisioningRequest.create({
      data: {
        idempotencyKey: input.idempotencyKey.slice(0, 120),
        payloadHash,
        status: "PENDING",
        externalContractRef: input.externalContractRef ?? null,
        requestedByUserId: input.actorUserId,
      },
      select: { id: true },
    });
    requestId = created.id;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "P2002") throw err;
    // Key already claimed — same-key path.
    const existing = await client.enterpriseProvisioningRequest.findUnique({
      where: { idempotencyKey: input.idempotencyKey.slice(0, 120) },
    });
    if (!existing) {
      // Extremely unlikely (deleted between); retry once via recursion-free error.
      throw new EnterpriseProvisioningError(
        "PROVISIONING_IN_PROGRESS",
        "Provisioning request is being processed. Retry shortly.",
      );
    }
    if (existing.payloadHash !== payloadHash) {
      throw new EnterpriseProvisioningError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used with a different payload. Nothing was changed.",
      );
    }
    if (existing.status === "COMPLETED") {
      return {
        result: (existing.resultJson as Record<string, unknown>) ?? {
          organizationId: existing.resultOrganizationId,
        },
        idempotentReplay: true,
        possibleDuplicateOrganizationIds: [],
      };
    }
    if (existing.status === "PENDING") {
      const age = Date.now() - existing.updatedAt.getTime();
      if (age < PENDING_TAKEOVER_MS) {
        throw new EnterpriseProvisioningError(
          "PROVISIONING_IN_PROGRESS",
          "A provisioning request with this key is in progress. Retry shortly.",
        );
      }
      // Crashed attempt: single-tx provisioning left no partial customer —
      // take over the SAME request row (guarded so only one taker wins).
      const takeover = await client.enterpriseProvisioningRequest.updateMany({
        where: { id: existing.id, status: "PENDING", updatedAt: existing.updatedAt },
        data: { failureReason: "takeover after stale PENDING" },
      });
      if (takeover.count !== 1) {
        throw new EnterpriseProvisioningError(
          "PROVISIONING_IN_PROGRESS",
          "A provisioning request with this key is in progress. Retry shortly.",
        );
      }
      requestId = existing.id;
    } else {
      // FAILED — retry resumes the same workflow.
      requestId = existing.id;
      await client.enterpriseProvisioningRequest.update({
        where: { id: existing.id },
        data: { status: "PENDING", failureReason: null },
      });
    }
  }

  // ---- run the (single-transaction) provisioning ------------------------
  try {
    // PHASE 13 §4 (2026-08-17) — the production call is now written OUT, and the
    // test injection is a branch rather than a default.
    //
    // This read `const provision = deps.provision ?? provisionEnterpriseCustomer`
    // and then called `provision(...)`. Behaviourally identical; as a statement
    // about the system, not identical at all. The only call expression in the
    // file named a local variable, so no static reader — the capability
    // analyzer, a reviewer, an IDE's "find usages" — could see that
    // `POST /v1/admin/enterprise/provision` reaches `provisionEnterpriseCustomer`,
    // and the writer-preservation manifest recorded it as reached by "no
    // platform-admin route or CLI", which was simply false: this route has
    // reached it since Phase 2. The seam is worth keeping and was worth costing
    // nothing to state plainly.
    const args = {
      organizationName: input.organizationName,
      ownerEmail: input.ownerEmail,
      seats: input.seats,
      workspaceName: input.workspaceName,
      actorUserId: input.actorUserId,
      region: input.region,
      externalContractRef: input.externalContractRef,
      terms: input.terms,
      provisioningRequestId: requestId,
    };
    const result = deps.provision
      ? await deps.provision(args, client)
      : await provisionEnterpriseCustomer(args, client);

    // The request completed with the customer; this adds what only the send
    // could know. Best effort, because everything that matters has committed.
    await client.enterpriseProvisioningRequest
      .update({
        where: { id: requestId },
        data: {
          status: "COMPLETED",
          resultOrganizationId: result.organizationId,
          resultJson: redactProvisioningResult(result) as never,
        },
      })
      .catch(() => null);

    // Advisory duplicate report (rule 3): same normalized name among
    // OTHER CUSTOMER orgs — never auto-merged, operator reviews.
    const dupes = await client.organization.findMany({
      where: {
        kind: "CUSTOMER",
        id: { not: result.organizationId },
        name: { equals: input.organizationName.trim(), mode: "insensitive" },
      },
      select: { id: true },
      take: 10,
    });

    return {
      result,
      idempotentReplay: false,
      possibleDuplicateOrganizationIds: dupes.map((d) => d.id),
    };
  } catch (err) {
    await client.enterpriseProvisioningRequest
      .update({
        where: { id: requestId },
        data: {
          status: "FAILED",
          failureReason:
            err instanceof Error ? err.message.slice(0, 400) : "unknown",
        },
      })
      .catch(() => null);
    throw err;
  }
}

export type ProvisioningContractTerms = Pick<
  EnterpriseContractTerms,
  | "evidenceRecordsPerMonth"
  | "aiOperationsPerMonth"
  | "collaborationTeamsMax"
  | "collaborationTeamMembersMax"
  | "legalHoldEnabled"
  | "reviewerOperationsEnabled"
>;

export type ProvisionEnterpriseCustomerInput = {
  organizationName: string;
  ownerEmail: string;
  seats?: number;
  workspaceName?: string;
  actorUserId: string;
  region?: string | null;
  externalContractRef?: string | null;
  /** What the contract sold, recorded with the customer. */
  terms?: ProvisioningContractTerms;
  /** The idempotent request this run completes, in its own transaction. */
  provisioningRequestId?: string;
};

export type ProvisionEnterpriseCustomerResult = {
  organizationId: string;
  ownerInviteToken: string;
  inviteUrl: string;
  /** Macro-Wave A2 — durable delivery state of the owner invite
   *  (PENDING/SENT/FAILED + attempts). Safe: never a token/URL. */
  ownerInviteDelivery?: {
    deliveryId: string;
    status: "PENDING" | "SENT" | "FAILED" | "CANCELLED";
    attempts: number;
    lastError: string | null;
  } | null;
  provisioned: false;
  pendingOwner: true;
};

/**
 * Provision a brand-new enterprise customer in ONE transaction: the
 * Organization (billingOwnerUserId null), its PENDING_ACTIVATION contract and
 * a canonical ORG_OWNER invite for ownerEmail. No workspace
 * (Team.ownerUserId is required); acceptance creates it. Returns
 * provisioned:false, the raw invite token (once), and pendingOwner:true.
 */
export async function provisionEnterpriseCustomer(
  input: ProvisionEnterpriseCustomerInput,
  client: PrismaClient = defaultPrisma,
): Promise<ProvisionEnterpriseCustomerResult> {
  const seats = input.seats ?? getPlanCapabilities("ENTERPRISE").includedSeats;
  const email = input.ownerEmail.trim().toLowerCase();

  /*
   * PROV-001 — OWNERSHIP IS NEVER BOUND BY MATCHING AN ADDRESS.
   *
   * This looked the address up in `users` and, on a match, made that account
   * ORG_OWNER, workspace OWNER and contract owner on the spot. `users.email` is
   * neither unique nor proven: anyone can register a customer's address before
   * the customer does, so the operator's own typing handed the organization to
   * a stranger. Even with no attacker the owner was whichever row the database
   * returned first, and nobody told them they owned anything.
   *
   * There is one path now. Every first owner, with or without an account,
   * receives the ORG_OWNER invitation at that address, and acceptance is where
   * mailbox control, a verified account and a proven credential are checked.
   */

  // No workspace yet: Team.ownerUserId is a required non-null column, so the
  // workspace is created when the owner accepts.
  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = inviteExpiresAt();

  const result = await client.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.organizationName,
        billingOwnerUserId: null,
        status: "ACTIVE",
        // P1 domain remediation (2026-07-21) — sales-provisioned orgs are
        // REAL customer Enterprise Organizations.
        kind: "CUSTOMER",
        // Phase 2 Blocker 1 — persist the provisioning intent on the org.
        // When this ORG_OWNER invite is accepted, the accept handler mints
        // the ENTERPRISE workspace with these seats and clears the marker.
        pendingEnterpriseSeats: seats,
        pendingEnterpriseWorkspaceName: input.workspaceName?.trim() || null,
      },
      select: { id: true },
    });

    // PHASE 10 §1.4 — every CUSTOMER Organization gets an EXPLICIT baseline
    // security policy transactionally (a missing policy fails closed at read).
    await (tx.organizationSecurityPolicy.create as unknown as (a: unknown) => Promise<unknown>)({
      data: { organizationId: org.id, policyVersion: 1 },
    });

    // PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2):
    // owner not yet on the platform → contract is provisioned but waits
    // for owner activation.
    await upsertEnterpriseContract(tx, {
      organizationId: org.id,
      status: "PENDING_ACTIVATION",
      activationState: "OWNER_INVITED",
      seatCount: seats,
      contractOwnerUserId: null,
      ...(input.region ? { region: input.region.slice(0, 40) } : {}),
      ...(input.externalContractRef ? { externalContractRef: input.externalContractRef } : {}),
      ...input.terms,
    });

    const invite = await tx.organizationInvite.create({
      data: {
        organizationId: org.id,
        email,
        role: "ORG_OWNER",
        token: null,
        tokenHash,
        invitedByUserId: input.actorUserId,
        expiresAt,
      },
      select: { id: true },
    });

    await emitOrgAuditEvent(tx, {
      organizationId: org.id,
      actorUserId: input.actorUserId,
      eventType: "ENTERPRISE_PROVISIONED",
      targetType: "organization",
      targetId: org.id,
      metadata: {
        organizationName: input.organizationName,
        inviteId: invite.id,
        email,
        seats,
        provisioned: false,
        pendingOwner: true,
      },
    });

    // Record the invite lifecycle event too, mirroring the org-invite path.
    await emitOrgAuditEvent(tx, {
      organizationId: org.id,
      actorUserId: input.actorUserId,
      eventType: "ORG_MEMBER_INVITED",
      targetType: "organization_invite",
      targetId: invite.id,
      metadata: {
        inviteId: invite.id,
        email,
        role: "ORG_OWNER",
        expiresAt: expiresAt.toISOString(),
        invitedByUserId: input.actorUserId,
      },
    });

    // Macro-Wave A2 — durable delivery outbox committed WITH the invite
    // (activation → owner invite → durable delivery is one atomic intent).
    // Ids only; the raw token is never persisted.
    const { deliveryId } = await recordOrgInviteDeliveryPending(tx, {
      inviteId: invite.id,
      organizationId: org.id,
      email,
      initiatedByUserId: input.actorUserId,
    });

    // PROV-006 — the customer and the record that it exists commit as one, so a
    // crash after this point replays the customer instead of creating another.
    if (input.provisioningRequestId) {
      await tx.enterpriseProvisioningRequest.update({
        where: { id: input.provisioningRequestId },
        data: {
          status: "COMPLETED",
          resultOrganizationId: org.id,
          resultJson: {
            organizationId: org.id,
            ownerInviteToken: null,
            inviteUrl: null,
            oneTimeSecretRedacted: true,
            provisioned: false,
            pendingOwner: true,
          },
        },
      });
    }

    return { organizationId: org.id, inviteId: invite.id, deliveryId };
  });

  // Nothing after the commit can fail provisioning: the customer exists.
  await emitTenantAudit({
    action: "ENTERPRISE_PROVISIONED",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    organizationId: result.organizationId,
    resourceType: "organization",
    resourceId: result.organizationId,
    metadata: {
      ownerEmail: email,
      seats,
      provisioned: false,
      pendingOwner: true,
    },
  }, client).catch(() => null);

  // Macro-Wave A2 — inline FIRST delivery attempt (never throws; on
  // failure the outbox row stays PENDING and the worker-driven sweep
  // retries with token rotation).
  const ownerInviteDelivery = await attemptInitialOrgInviteDelivery(
    {
      deliveryId: result.deliveryId,
      rawToken: token,
      organizationName: input.organizationName,
      role: "ORG_OWNER",
      inviterDisplay: null,
      expiresAt,
    },
    client,
  );

  return {
    organizationId: result.organizationId,
    ownerInviteToken: token,
    // Macro-Wave A2 — CANONICAL org-invite accept path. The previous
    // `/invite/{token}` path belonged to the TEAM invite journey and could
    // never accept an OrganizationInvite (broken journey). This is the
    // exact path the delivery emails contain and the web app serves at
    // apps/web/app/(app)/org-invites/[token]/accept.
    inviteUrl: `/org-invites/${token}/accept`,
    ownerInviteDelivery,
    provisioned: false,
    pendingOwner: true,
  };
}

// ---------------------------------------------------------------------------
// PROV-005 — the operator's way back when a first owner's invitation fails.
// ---------------------------------------------------------------------------

/**
 * Invitation routes are scoped to organization members, and a pending-owner
 * organization has none, so nobody at all could resend or revoke its invitation.
 * Once it expired or bounced, the customer was stranded, and provisioning again
 * made a second organization. This revokes what is open and mints a new
 * invitation, optionally to a corrected address. It applies only while the
 * contract is still waiting for its first owner.
 */
export async function reissueEnterpriseOwnerInvite(
  input: { organizationId: string; actorUserId: string; ownerEmail?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<{
  organizationId: string;
  email: string;
  inviteUrl: string;
  ownerInviteDelivery: Awaited<ReturnType<typeof attemptInitialOrgInviteDelivery>>;
}> {
  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = inviteExpiresAt();

  const issued = await client.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true, name: true, status: true, pendingEnterpriseSeats: true },
    });
    if (!org) {
      throw new EnterpriseProvisioningError("ORG_NOT_FOUND", "Organization not found.");
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enterprise-termination:${input.organizationId}`}))`;
    const contract = await tx.enterpriseContract.findUnique({
      where: { organizationId: input.organizationId },
      select: { status: true },
    });
    const workspaces = await tx.team.count({ where: { organizationId: input.organizationId } });
    if (
      org.status !== "ACTIVE" ||
      org.pendingEnterpriseSeats === null ||
      contract?.status !== "PENDING_ACTIVATION" ||
      workspaces !== 0
    ) {
      throw new EnterpriseProvisioningError(
        "OWNER_NOT_PENDING",
        "This organization is not waiting for its first owner.",
      );
    }
    const open = await tx.organizationInvite.findMany({
      where: {
        organizationId: input.organizationId,
        role: "ORG_OWNER",
        acceptedAt: null,
        revokedAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true },
    });
    const email = input.ownerEmail?.trim().toLowerCase() || open[0]?.email;
    if (!email) {
      throw new EnterpriseProvisioningError(
        "OWNER_NOT_PENDING",
        "State the owner's address: no invitation is open.",
      );
    }
    if (open.length > 0) {
      // The delivery sweeper cancels a revoked invitation's outbox row.
      await tx.organizationInvite.updateMany({
        where: { id: { in: open.map((i) => i.id) } },
        data: { revokedAt: new Date(), revokedByUserId: input.actorUserId },
      });
    }
    const invite = await tx.organizationInvite.create({
      data: {
        organizationId: input.organizationId,
        email,
        role: "ORG_OWNER",
        token: null,
        tokenHash,
        invitedByUserId: input.actorUserId,
        expiresAt,
      },
      select: { id: true },
    });
    await emitOrgAuditEvent(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      eventType: "ENTERPRISE_OWNER_INVITE_REISSUED",
      targetType: "organization_invite",
      targetId: invite.id,
      metadata: { inviteId: invite.id, revokedInviteIds: open.map((i) => i.id), email },
    });
    const { deliveryId } = await recordOrgInviteDeliveryPending(tx, {
      inviteId: invite.id,
      organizationId: input.organizationId,
      email,
      initiatedByUserId: input.actorUserId,
    });
    return { deliveryId, email, organizationName: org.name };
  });

  await emitTenantAudit({
    action: "ENTERPRISE_OWNER_INVITE_REISSUED",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    actorAuthority: "PLATFORM_ADMIN",
    organizationId: input.organizationId,
    resourceType: "organization",
    resourceId: input.organizationId,
    metadata: { email: issued.email },
  }, client).catch(() => null);

  const ownerInviteDelivery = await attemptInitialOrgInviteDelivery(
    {
      deliveryId: issued.deliveryId,
      rawToken: token,
      organizationName: issued.organizationName,
      role: "ORG_OWNER",
      inviterDisplay: null,
      expiresAt,
    },
    client,
  );
  return {
    organizationId: input.organizationId,
    email: issued.email,
    inviteUrl: `/org-invites/${token}/accept`,
    ownerInviteDelivery,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 Blocker 1 — brand-new-owner enterprise auto-completion.
// ---------------------------------------------------------------------------

export type CompleteEnterpriseProvisioningInput = {
  /** The org the accepted invite belongs to. */
  organizationId: string;
  /** The accepting user (the invited ORG_OWNER). Becomes workspace OWNER. */
  userId: string;
  /** The invite role. Completion only runs for ORG_OWNER. */
  inviteRole: string;
  /** Actor for the audit row (the accepting user). */
  actorUserId: string;
};

export type CompleteEnterpriseProvisioningResult = {
  /** The newly-minted ENTERPRISE workspace, when completion ran. */
  enterpriseWorkspaceId: string;
  /** Where the frontend should land the owner (setup wizard). */
  setupRedirect: string;
  /** Resolved seats applied to the workspace. */
  seats: number;
} | null;

/**
 * Consume the `pendingEnterpriseSeats` provisioning marker when the
 * invited ORG_OWNER accepts, completing the enterprise workspace setup
 * with NO manual admin follow-up.
 *
 * MUST be called INSIDE the accept transaction, AFTER the ORG_OWNER
 * membership has been created. It is fully guarded so it is a no-op for
 * every non-enterprise accept:
 *
 *   (a) inviteRole === "ORG_OWNER", AND
 *   (b) org.pendingEnterpriseSeats != null, AND
 *   (c) the org has ZERO workspaces (Team.count === 0).
 *
 * When all three hold, in the SAME tx it:
 *   - creates an ENTERPRISE Team owned by the accepter (billingStatus
 *     ACTIVE, includedSeats = pendingEnterpriseSeats, OWNER membership),
 *   - sets org.billingOwnerUserId (only when currently null) and clears
 *     pendingEnterpriseSeats,
 *   - emits an ENTERPRISE_PROVISIONED org audit event,
 *   - returns { enterpriseWorkspaceId, setupRedirect, seats }.
 *
 * Otherwise it returns null and writes nothing — the normal accept
 * behaviour is entirely unchanged.
 */
export async function completeEnterpriseProvisioningOnOwnerAccept(
  tx: Prisma.TransactionClient,
  input: CompleteEnterpriseProvisioningInput,
): Promise<CompleteEnterpriseProvisioningResult> {
  // Guard (a): only the ORG_OWNER accept can complete provisioning.
  if (input.inviteRole !== "ORG_OWNER") {
    return null;
  }

  const org = await tx.organization.findUnique({
    where: { id: input.organizationId },
    select: {
      id: true,
      name: true,
      billingOwnerUserId: true,
      pendingEnterpriseSeats: true,
      pendingEnterpriseWorkspaceName: true,
    },
  });

  // Guard (b): a pending enterprise provisioning marker must exist.
  if (!org || org.pendingEnterpriseSeats == null) {
    return null;
  }

  // Guard (c): the org must have ZERO workspaces (idempotency — if a
  // workspace already exists, provisioning already happened).
  const workspaceCount = await tx.team.count({
    where: { organizationId: input.organizationId },
  });
  if (workspaceCount !== 0) {
    return null;
  }

  const seats = org.pendingEnterpriseSeats;

  const workspace = await tx.team.create({
    data: {
      name: org.pendingEnterpriseWorkspaceName ?? org.name,
      ownerUserId: input.userId,
      billingOwnerUserId: input.userId,
      organizationId: input.organizationId,
      billingPlan: "ENTERPRISE",
      billingStatus: TeamBillingStatus.ACTIVE,
      includedSeats: seats,
      overSeatLimit: false,
      // P1 domain remediation (2026-07-21) — explicit canonical kind.
      workspaceKind: "ORGANIZATION",
    },
    select: { id: true },
  });

  // PROV-023 — through the orchestrator, so the first owner's membership has
  // its provenance row like every other grant. The ORG_OWNER membership already
  // exists; this adds the workspace leg.
  await provisionMembership(tx, {
    intent: "ENTERPRISE_FIRST_OWNER",
    source: "ENTERPRISE_BOOTSTRAP",
    userId: input.userId,
    organizationId: input.organizationId,
    organizationRole: "ORG_OWNER",
    workspace: { teamId: workspace.id, role: TeamRole.OWNER },
    actorUserId: input.actorUserId,
    externalRef: `enterprise-provisioning:${input.organizationId}`,
    accessReason: "enterprise first owner",
  });

  // PROV-004 — the owner lands in the organization they just took on. The setup
  // wizard is an Enterprise surface gated on the ACTIVE workspace, which would
  // still be their Personal space, and it answered them with an upgrade prompt.
  await tx.user.update({
    where: { id: input.userId },
    data: { currentWorkspaceId: workspace.id },
  });

  await tx.organization.update({
    where: { id: input.organizationId },
    data: {
      // Only claim billing ownership if the org has none yet.
      billingOwnerUserId: org.billingOwnerUserId ?? input.userId,
      pendingEnterpriseSeats: null,
      pendingEnterpriseWorkspaceName: null,
    },
  });

  // PHASE 4 (2026-07-22) — owner activation completes the contract (§7.1
  // activation chain): PENDING_ACTIVATION/OWNER_INVITED → ACTIVE/ACTIVATED
  // with the accepting owner recorded as contract owner.
  await upsertEnterpriseContract(tx, {
    organizationId: input.organizationId,
    status: "ACTIVE",
    activationState: "ACTIVATED",
    seatCount: seats,
    contractOwnerUserId: input.userId,
  });

  await emitOrgAuditEvent(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    eventType: "ENTERPRISE_PROVISIONED",
    targetType: "organization",
    targetId: input.organizationId,
    metadata: {
      ownerUserId: input.userId,
      workspaceId: workspace.id,
      seats,
      provisioned: true,
      completedOnOwnerAccept: true,
    },
  });

  return {
    enterpriseWorkspaceId: workspace.id,
    setupRedirect: `/organizations/${input.organizationId}/setup`,
    seats,
  };
}

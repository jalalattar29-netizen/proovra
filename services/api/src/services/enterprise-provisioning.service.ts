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
import { computeOverSeatLimit } from "./billing.service.js";
import { hashInviteToken } from "../routes/organizations.routes.js";
import { emitOrgAuditEvent } from "./organization/org-audit.service.js";
import { emitTenantAudit } from "./audit/tenant-audit.service.js";
// PHASE 3 (2026-07-21) — canonical membership orchestrator.
import { grantOrganizationMembership } from "./identity/membership-provisioning.service.js";
// PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2).
import { upsertEnterpriseContract } from "./organization/enterprise-contract.service.js";
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
 *   overSeatLimit = (active member count > seats)
 *
 * Setting billingPlan=ENTERPRISE auto-unlocks SSO/SCIM/legalHold/etc via
 * getPlanCapabilities(plan).enterpriseFeatures — no separate feature flags.
 */
export async function grantEnterprisePlanToOrg(
  input: GrantEnterprisePlanInput,
  client: PrismaClient = defaultPrisma,
): Promise<GrantEnterprisePlanResult> {
  const plan: GrantablePlan = input.plan ?? "ENTERPRISE";

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — seats come from the
  // CONTRACT when one states them.
  //
  // This was `input.seats ?? getPlanCapabilities(plan).includedSeats`, so an
  // Enterprise organization whose contract said 400 seats was provisioned with
  // the catalog placeholder of 5 unless the caller happened to repeat the
  // number. The contract is the purchased right; the catalog default applies
  // only when neither the caller nor the contract states one.
  const contractSeats = await (async () => {
    try {
      const row = await client.enterpriseContract.findUnique({
        where: { organizationId: input.orgId },
        select: { status: true, seatCount: true },
      });
      if (row && row.status === "ACTIVE" && (row.seatCount ?? 0) > 0) {
        return row.seatCount as number;
      }
    } catch {
      // Migration-window tolerant: a missing table means no contract yet.
    }
    return null;
  })();

  const seats =
    input.seats ?? contractSeats ?? getPlanCapabilities(plan).includedSeats;

  const result = await client.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: input.orgId },
      select: { id: true },
    });
    if (!org) {
      throw new EnterpriseProvisioningError(
        "ORG_NOT_FOUND",
        "Organization not found.",
      );
    }

    const workspaces = await tx.team.findMany({
      where: { organizationId: input.orgId },
      select: {
        id: true,
        _count: {
          // PHASE 12 POINT 4 PASS C — ACTIVE-only, matching the canonical seat
          // authority. This counted ALL members, so a suspended or revoked
          // member inflated the count and could mark a workspace over its seat
          // limit during an org-plan grant when it was not.
          select: { members: { where: { status: "ACTIVE" } } },
        },
      },
    });

    for (const ws of workspaces) {
      // One seat-limit policy, shared with refreshTeamSeatState. The inline
      // comparison this replaces also lacked the `includedSeats > 0` unlimited
      // guard, so the two paths could disagree about the same workspace.
      const overSeatLimit = computeOverSeatLimit({
        activeMemberCount: ws._count.members,
        includedSeats: seats,
      });
      await tx.team.update({
        where: { id: ws.id },
        data: {
          billingPlan: plan,
          includedSeats: seats,
          billingStatus: TeamBillingStatus.ACTIVE,
          overSeatLimit,
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

    return { workspacesUpdated: workspaces.length };
  });

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
//      failed attempt leaves no partial customer.
// =============================================================================

/** Deterministic hash of the provisioning payload (identity-relevant fields). */
function provisioningPayloadHash(input: {
  organizationName: string;
  ownerEmail: string;
  seats?: number;
  workspaceName?: string;
  region?: string | null;
  externalContractRef?: string | null;
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
      }),
    )
    .digest("hex");
}

/** Redact one-time secrets before persisting a replayable result snapshot. */
function redactProvisioningResult(
  result: ProvisionEnterpriseCustomerResult,
): Record<string, unknown> {
  if (result.provisioned) return { ...result };
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
    };
    const result = deps.provision
      ? await deps.provision(args, client)
      : await provisionEnterpriseCustomer(args, client);

    // Region is contract state (§7.2) — record it on the contract row.
    if (input.region) {
      const delegate = (client as { enterpriseContract?: unknown }).enterpriseContract;
      if (delegate) {
        try {
          await client.enterpriseContract.update({
            where: { organizationId: result.organizationId },
            data: { region: input.region.slice(0, 40) },
          });
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code !== "P2021" && code !== "P2022" && code !== "P2025") throw err;
        }
      }
    }

    await client.enterpriseProvisioningRequest.update({
      where: { id: requestId },
      data: {
        status: "COMPLETED",
        resultOrganizationId: result.organizationId,
        resultJson: redactProvisioningResult(result) as never,
      },
    });

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

export type ProvisionEnterpriseCustomerInput = {
  organizationName: string;
  ownerEmail: string;
  seats?: number;
  workspaceName?: string;
  actorUserId: string;
};

export type ProvisionEnterpriseCustomerResult =
  | {
      organizationId: string;
      workspaceId: string;
      ownerUserId: string;
      provisioned: true;
    }
  | {
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
 * Provision a brand-new enterprise customer in ONE transaction.
 *
 *   - Owner user EXISTS   → create Organization + enterprise Team(workspace)
 *                           owned by that user, ORG_OWNER membership, set
 *                           org.billingOwnerUserId. Returns provisioned:true.
 *   - Owner user MISSING  → create Organization (billingOwnerUserId null) +
 *                           a canonical ORG_OWNER invite for ownerEmail. No
 *                           workspace (Team.ownerUserId is required). Returns
 *                           provisioned:false, the raw invite token (once),
 *                           and pendingOwner:true.
 */
export async function provisionEnterpriseCustomer(
  input: ProvisionEnterpriseCustomerInput,
  client: PrismaClient = defaultPrisma,
): Promise<ProvisionEnterpriseCustomerResult> {
  const seats = input.seats ?? getPlanCapabilities("ENTERPRISE").includedSeats;
  const email = input.ownerEmail.trim().toLowerCase();

  // `email` is not a unique column on User in this schema (auth is by
  // provider), so we resolve by findFirst — the same lookup SCIM uses.
  const owner = await client.user.findFirst({
    where: { email },
    select: { id: true },
  });

  if (owner) {
    const result = await client.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.organizationName,
          billingOwnerUserId: owner.id,
          status: "ACTIVE",
          // P1 domain remediation (2026-07-21) — sales-provisioned orgs are
          // REAL customer Enterprise Organizations.
          kind: "CUSTOMER",
        },
        select: { id: true },
      });

      // PHASE 10 §3 (2026-07-23) — every CUSTOMER Organization MUST have an
      // EXPLICIT provisioned security policy (a missing policy fails closed at
      // read time). Create the baseline STANDARD posture transactionally so the
      // org is never left in a fail-closed state. Idempotent-safe: one row per
      // org (unique organizationId). The org admin tightens it via the policy
      // routes; the fields default to the explicit STANDARD baseline.
      await (tx.organizationSecurityPolicy.create as unknown as (a: unknown) => Promise<unknown>)({
        data: { organizationId: org.id, policyVersion: 1 },
      });

      // PHASE 3 (2026-07-21) — canonical orchestrator: enterprise first owner.
      await grantOrganizationMembership(tx, {
        organizationId: org.id,
        userId: owner.id,
        role: "ORG_OWNER",
        source: "ENTERPRISE_BOOTSTRAP",
        intent: "ENTERPRISE_FIRST_OWNER",
        actorUserId: null,
        externalRef: `enterprise-provisioning:${org.id}`,
      });

      // PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2):
      // owner exists → the contract is ACTIVE and ACTIVATED at provisioning.
      await upsertEnterpriseContract(tx, {
        organizationId: org.id,
        status: "ACTIVE",
        activationState: "ACTIVATED",
        seatCount: seats,
        contractOwnerUserId: owner.id,
      });

      const workspace = await tx.team.create({
        data: {
          name: input.workspaceName ?? input.organizationName,
          ownerUserId: owner.id,
          billingOwnerUserId: owner.id,
          organizationId: org.id,
          billingPlan: "ENTERPRISE",
          billingStatus: TeamBillingStatus.ACTIVE,
          includedSeats: seats,
          // P1 domain remediation (2026-07-21) — explicit canonical kind.
          workspaceKind: "ORGANIZATION",
          members: {
            create: {
              userId: owner.id,
              role: TeamRole.OWNER,
            },
          },
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
          ownerUserId: owner.id,
          workspaceId: workspace.id,
          seats,
          provisioned: true,
        },
      });

      return { organizationId: org.id, workspaceId: workspace.id };
    });

    await emitTenantAudit({
      action: "ENTERPRISE_PROVISIONED",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      organizationId: result.organizationId,
      workspaceId: result.workspaceId,
      resourceType: "organization",
      resourceId: result.organizationId,
      metadata: {
        ownerUserId: owner.id,
        ownerEmail: email,
        seats,
        provisioned: true,
      },
    }, client);

    return {
      organizationId: result.organizationId,
      workspaceId: result.workspaceId,
      ownerUserId: owner.id,
      provisioned: true,
    };
  }

  // Owner does not exist yet — create the org and a canonical ORG_OWNER
  // invite. No workspace: Team.ownerUserId is a required non-null column,
  // so we cannot create a workspace before an owner exists.
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

    return { organizationId: org.id, inviteId: invite.id, deliveryId };
  });

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
  }, client);

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
      name: org.name,
      ownerUserId: input.userId,
      billingOwnerUserId: input.userId,
      organizationId: input.organizationId,
      billingPlan: "ENTERPRISE",
      billingStatus: TeamBillingStatus.ACTIVE,
      includedSeats: seats,
      overSeatLimit: false,
      // P1 domain remediation (2026-07-21) — explicit canonical kind.
      workspaceKind: "ORGANIZATION",
      members: {
        create: {
          userId: input.userId,
          role: TeamRole.OWNER,
        },
      },
    },
    select: { id: true },
  });

  await tx.organization.update({
    where: { id: input.organizationId },
    data: {
      // Only claim billing ownership if the org has none yet.
      billingOwnerUserId: org.billingOwnerUserId ?? input.userId,
      pendingEnterpriseSeats: null,
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

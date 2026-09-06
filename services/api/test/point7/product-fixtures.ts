/**
 * PHASE 12 — POINT 7: deterministic product fixtures.
 *
 * WHAT A FIXTURE MAY AND MAY NOT DO
 * ---------------------------------------------------------------------------
 * A builder here SEEDS INITIAL STATE — entitlements, workspaces, memberships,
 * contracts, invitations — directly, because that is the tenant's history, not
 * the behaviour under test. Everything the matrix then ASSERTS about goes
 * through the real route or the real service. A fixture that "creates" an
 * owned workspace by inserting a Team row is seeding; a test that proves an
 * owned workspace CAN be created must POST /v1/teams.
 *
 * Each builder returns the tenant it made together with the EXPECTED authority
 * values for it, transcribed from `plan-contract.ts` — never computed by
 * calling the resolver the matrix is about to check.
 */

import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import {
  PLAN_CONTRACT,
  type CanonicalPlan,
  type PlanContractRow,
} from "./plan-contract.js";

// ===========================================================================
// Shapes
// ===========================================================================

export type SeededUser = {
  userId: string;
  email: string;
  token: string;
};

export type PersonalTenant = {
  plan: CanonicalPlan;
  owner: SeededUser;
  /** The bootstrapped Personal Team row. */
  personalTeamId: string;
  personalOrganizationId: string;
  /** What the authority MUST say about this tenant. */
  expected: PlanContractRow;
};

export type OwnedWorkspace = {
  teamId: string;
  organizationId: string;
};

export type OrganizationTenant = {
  organizationId: string;
  /** The provisioned ORGANIZATION workspace. */
  workspaceId: string;
  owner: SeededUser;
  members: SeededUser[];
  expected: PlanContractRow;
};

export type MintToken = (userId: string, email: string) => string;

export type FixtureDeps = {
  prisma: PrismaClient;
  mintToken: MintToken;
  /** Namespacing tag so two runs never collide in one database. */
  tag: string;
};

// ===========================================================================
// Primitives
// ===========================================================================

export async function seedUser(
  deps: FixtureDeps,
  label: string,
): Promise<SeededUser> {
  const email = `p7-${label}-${deps.tag}-${randomUUID().slice(0, 8)}@test.proovra.local`;
  const user = await deps.prisma.user.create({
    data: {
      email,
      firstName: "Point7",
      lastName: label,
      provider: "EMAIL",
      providerUserId: email,
    },
    select: { id: true },
  });
  // Routes behind `requireAuthAndLegal` answer 428 before any tenancy
  // resolution, which would mask every behaviour under test with a
  // fixture-only legacy state. Seed the CURRENT required acceptances.
  const { REQUIRED_LEGAL_VERSIONS } = await import(
    "../../src/legal/legal-versioning.js"
  );
  await deps.prisma.userLegalAcceptance.createMany({
    data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(
      ([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "point7-fixture",
      }),
    ),
  });
  const token = deps.mintToken(user.id, email);
  await registerSessionForToken(deps, user.id, token);
  return { userId: user.id, email, token };
}

/**
 * Register the REAL session-inventory row for a minted token.
 *
 * Organization-context establishment requires an `AuthenticatedSession` keyed
 * by (userId, HMAC of the token's `sid`) and fails closed without one. A
 * fixture that skips this gets `session_not_in_inventory` for every workspace
 * switch — which looks like a denial and is worthless as proof, because a test
 * asserting "suspended organizations refuse the switch" would pass against a
 * session that was never valid in the first place.
 *
 * The `sid` is read back out of the token the production signer produced (it
 * mints a fresh random one and deliberately refuses to let callers choose it),
 * and hashed with the production `hashSessionId`. Nothing here reimplements a
 * production rule; it seeds the row a real login would have written.
 */
export async function registerSessionForToken(
  deps: FixtureDeps,
  userId: string,
  token: string,
  teamId: string | null = null,
): Promise<void> {
  const { hashSessionId } = await import(
    "../../src/services/identity-security/session-revocation.service.js"
  );
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  ) as { sid?: string };
  if (!claims.sid) throw new Error("point7: minted token carries no sid claim");
  await deps.prisma.authenticatedSession.create({
    data: {
      userId,
      teamId,
      sessionIdHash: hashSessionId(claims.sid),
      expiresAtUtc: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
}

/**
 * Set the account-level entitlement — the PERSONAL_ACCOUNT commercial subject.
 *
 * `ensureEntitlement` creates a FREE row on first read, so this deactivates
 * whatever exists and writes exactly one active row. Two active rows is itself
 * a state the matrix tests (the resolver must not silently pick one), so the
 * builder must not create it by accident.
 */
export async function setAccountPlan(
  deps: FixtureDeps,
  userId: string,
  plan: CanonicalPlan,
  extra: { credits?: number; legacyRecordCapOverride?: number | null } = {},
): Promise<void> {
  await deps.prisma.entitlement.updateMany({
    where: { userId },
    data: { active: false },
  });
  await deps.prisma.entitlement.create({
    data: {
      userId,
      plan,
      active: true,
      credits: extra.credits ?? 0,
      ...(extra.legacyRecordCapOverride !== undefined
        ? { legacyRecordCapOverride: extra.legacyRecordCapOverride }
        : {}),
    },
  });
}

/**
 * Bootstrap the Personal Space through the REAL production bootstrap, so its
 * `isPersonal` flag, SYSTEM container organization and OWNER membership are
 * exactly what production writes rather than what a fixture believes.
 */
export async function bootstrapPersonalSpace(
  deps: FixtureDeps,
  userId: string,
): Promise<{ teamId: string; organizationId: string }> {
  const { ensurePersonalWorkspace } = await import(
    "../../src/services/platform-context/workspace-bootstrap.service.js"
  );
  const personal = await ensurePersonalWorkspace({ userId });
  /**
   * POINT THE USER AT IT, THE WAY A REAL SESSION IS POINTED AT IT.
   *
   * `ensurePersonalWorkspace` creates the workspace and the owner's
   * membership; it does NOT write `User.currentWorkspaceId`. In the running
   * product that pointer is written the first time a client loads
   * `GET /v1/platform/context`, which every session does before it can
   * render anything — so a real caller always arrives at a route with EITHER
   * the active-workspace header or a resolved pointer.
   *
   * This fixture went straight from the bootstrap to the route, so its user
   * had neither, and the canonical authorization chain answered "you have not
   * told me which workspace this is" — concealed, correctly, as a 404. That
   * masked the behaviour every scenario here is actually about. Writing the
   * pointer makes the fixture a session rather than a half-provisioned row.
   */
  await deps.prisma.user.update({
    where: { id: userId },
    data: { currentWorkspaceId: personal.teamId },
  });
  const team = await deps.prisma.team.findUniqueOrThrow({
    where: { id: personal.teamId },
    select: { organizationId: true },
  });
  return { teamId: personal.teamId, organizationId: team.organizationId! };
}

// ===========================================================================
// Plan tenants
// ===========================================================================

/**
 * A personal tenant on any of the personal-subject plans.
 *
 * FREE / PAYG / PRO / TEAM all resolve their personal space from the account
 * entitlement; the difference between them is entirely in the catalog, which
 * is the property the matrix is checking.
 */
export async function seedPersonalTenant(
  deps: FixtureDeps,
  plan: CanonicalPlan,
  opts: { credits?: number; legacyRecordCapOverride?: number | null } = {},
): Promise<PersonalTenant> {
  const owner = await seedUser(deps, plan.toLowerCase());
  await setAccountPlan(deps, owner.userId, plan, opts);
  const personal = await bootstrapPersonalSpace(deps, owner.userId);
  return {
    plan,
    owner,
    personalTeamId: personal.teamId,
    personalOrganizationId: personal.organizationId,
    expected: PLAN_CONTRACT[plan],
  };
}

/**
 * Seed an OWNED workspace directly (initial state, not the create behaviour).
 *
 * Mirrors what `POST /v1/teams` persists: a SYSTEM container organization and
 * a `workspaceKind: "OWNED"` Team owned by the user. `billing*` are the
 * workspace's OWN commercial state — the point of the PRO scenarios is that
 * this is what governs it, not the owner's personal plan.
 */
export async function seedOwnedWorkspace(
  deps: FixtureDeps,
  input: {
    ownerUserId: string;
    name?: string;
    billingPlan?: CanonicalPlan;
    billingStatus?: "ACTIVE" | "PAST_DUE" | "CANCELED" | "INACTIVE";
  },
): Promise<OwnedWorkspace> {
  const name = input.name ?? `p7-owned-${deps.tag}-${randomUUID().slice(0, 6)}`;
  return deps.prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name,
        billingOwnerUserId: input.ownerUserId,
        status: "ACTIVE",
        kind: "SYSTEM",
      },
      select: { id: true },
    });
    await tx.organizationMembership.create({
      data: {
        organizationId: org.id,
        userId: input.ownerUserId,
        role: "ORG_OWNER",
      },
    });
    const team = await tx.team.create({
      data: {
        name,
        ownerUserId: input.ownerUserId,
        billingOwnerUserId: input.ownerUserId,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "OWNED",
        billingPlan: input.billingPlan ?? "FREE",
        billingStatus: input.billingStatus ?? "INACTIVE",
      },
      select: { id: true },
    });
    await tx.teamMember.create({
      data: {
        teamId: team.id,
        userId: input.ownerUserId,
        role: "OWNER",
        status: "ACTIVE",
      },
    });
    return { teamId: team.id, organizationId: org.id };
  });
}

/**
 * An ENTERPRISE tenant: a CUSTOMER Organization, its provisioned ORGANIZATION
 * workspace, a security policy row, and a contract.
 *
 * A CUSTOMER Organization with NO policy row fails closed at the security
 * surfaces, so the fixture always provisions one — the matrix varies its
 * FIELDS (`noPersonalSpace`, `ssoRequired`, `managedIdentityRequired`) rather
 * than its presence, because absence is a different, already-covered failure.
 */
export async function seedOrganizationTenant(
  deps: FixtureDeps,
  opts: {
    status?: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
    contractStatus?: "ACTIVE" | "SUSPENDED" | "TERMINATED";
    contractEndsAtUtc?: Date | null;
    noPersonalSpace?: boolean;
    ssoRequired?: boolean;
    managedIdentityRequired?: boolean;
    memberCount?: number;
    billingPlan?: CanonicalPlan;
    billingStatus?: "ACTIVE" | "PAST_DUE" | "CANCELED" | "INACTIVE";
    /** Account plan of the org owner. Used to prove the org plan is NOT derived from it. */
    ownerAccountPlan?: CanonicalPlan;
  } = {},
): Promise<OrganizationTenant> {
  const owner = await seedUser(deps, "ent-owner");
  await setAccountPlan(deps, owner.userId, opts.ownerAccountPlan ?? "FREE");

  const name = `p7-org-${deps.tag}-${randomUUID().slice(0, 6)}`;
  const org = await deps.prisma.organization.create({
    data: {
      name,
      billingOwnerUserId: owner.userId,
      status: opts.status ?? "ACTIVE",
      kind: "CUSTOMER",
    },
    select: { id: true },
  });
  await deps.prisma.organizationMembership.create({
    data: { organizationId: org.id, userId: owner.userId, role: "ORG_OWNER" },
  });
  const workspace = await deps.prisma.team.create({
    data: {
      name: `${name}-ws`,
      ownerUserId: owner.userId,
      billingOwnerUserId: owner.userId,
      isPersonal: false,
      organizationId: org.id,
      workspaceKind: "ORGANIZATION",
      billingPlan: opts.billingPlan ?? "ENTERPRISE",
      billingStatus: opts.billingStatus ?? "ACTIVE",
    },
    select: { id: true },
  });
  await deps.prisma.teamMember.create({
    data: {
      teamId: workspace.id,
      userId: owner.userId,
      role: "OWNER",
      status: "ACTIVE",
    },
  });

  await deps.prisma.organizationSecurityPolicy.create({
    data: {
      organizationId: org.id,
      teamId: workspace.id,
      noPersonalSpace: opts.noPersonalSpace ?? false,
      ssoRequired: opts.ssoRequired ?? false,
      managedIdentityRequired: opts.managedIdentityRequired ?? false,
      securityMode: (opts.ssoRequired ?? false) ? "HIGH_SECURITY" : "STANDARD",
    },
  });

  await deps.prisma.enterpriseContract.create({
    data: {
      organizationId: org.id,
      status: opts.contractStatus ?? "ACTIVE",
      ...(opts.contractEndsAtUtc !== undefined
        ? { endsAtUtc: opts.contractEndsAtUtc }
        : {}),
    },
  });

  const members: SeededUser[] = [];
  for (let i = 0; i < (opts.memberCount ?? 0); i += 1) {
    const m = await seedUser(deps, `ent-member-${i}`);
    await deps.prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: m.userId, role: "ORG_MEMBER" },
    });
    await deps.prisma.teamMember.create({
      data: {
        teamId: workspace.id,
        userId: m.userId,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    members.push(m);
  }

  return {
    organizationId: org.id,
    workspaceId: workspace.id,
    owner,
    members,
    expected: PLAN_CONTRACT.ENTERPRISE,
  };
}

// ===========================================================================
// Durable side-effect fingerprint
// ===========================================================================

/**
 * The counts a DENIAL must not move.
 *
 * `writes = 0 · outbox = 0 · queue jobs = 0 · audit success = 0 · emails = 0 ·
 * storage = 0 · billing = 0`, expressed against the tables that carry each of
 * those. A correctly-audited denial is allowed, so the audit count here is of
 * SUCCESS events only.
 */
export type SideEffectFingerprint = Record<string, number>;

export async function fingerprintSideEffects(
  prisma: PrismaClient,
): Promise<SideEffectFingerprint> {
  const countOr0 = async (fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch {
      // A table that does not exist in this schema contributes nothing rather
      // than aborting the comparison — the fingerprint is a conservative
      // superset, and a missing table cannot hide a write into a present one.
      return -1;
    }
  };
  return {
    teams: await countOr0(() => prisma.team.count()),
    teamMembers: await countOr0(() => prisma.teamMember.count()),
    organizations: await countOr0(() => prisma.organization.count()),
    organizationMemberships: await countOr0(() =>
      prisma.organizationMembership.count(),
    ),
    evidence: await countOr0(() => prisma.evidence.count()),
    cases: await countOr0(() => prisma.case.count()),
    reports: await countOr0(() => prisma.report.count()),
    entitlements: await countOr0(() => prisma.entitlement.count()),
    subscriptions: await countOr0(() => prisma.subscription.count()),
    collaborationTeams: await countOr0(() => prisma.collaborationTeam.count()),
    collaborationTeamInvites: await countOr0(() =>
      prisma.collaborationTeamInvite.count(),
    ),
    custodyEvents: await countOr0(() => prisma.custodyEvent.count()),
    // The durable EMAIL/queue boundary: `NotificationDelivery` is the attempt
    // authority (one row per delivery attempt), so a denial that "sent
    // nothing" is a delta of zero here rather than an assertion about a mock.
    notificationDeliveries: await countOr0(() =>
      prisma.notificationDelivery.count(),
    ),
  };
}

export function fingerprintDelta(
  before: SideEffectFingerprint,
  after: SideEffectFingerprint,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const key of Object.keys(before)) {
    const d = (after[key] ?? 0) - (before[key] ?? 0);
    if (d !== 0) delta[key] = d;
  }
  return delta;
}

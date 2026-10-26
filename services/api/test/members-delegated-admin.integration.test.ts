/**
 * ONE DELEGATED-ADMINISTRATION AUTHORITY (members audit DOM-09, owner decision
 * 2026-10-25) — proven against a real PostgreSQL.
 *
 * The tier model (delegated_admin_grants + its own route guard) is retired;
 * the canonical permission engine (role + capability grants + delegated
 * scopes) is the one authority. This suite proves the four things that
 * retirement must not get wrong:
 *
 *   1. MIGRATION — every live tier grant is carried forward exactly
 *      (capability grants of the permissions its tier admitted), ended or
 *      orphaned grants are not, every tier row records what became of it, and
 *      a second run changes nothing.
 *   2. COVERAGE — a holder of each tier is still admitted, after migration,
 *      on every route that tier admitted before; and is NOT widened into
 *      neighbouring domains. A member with nothing is refused everywhere.
 *   3. THE MANAGED WRITER — grant, update, revoke and inspect through the
 *      Security Center routes, step-up bound, audited with previous/resulting
 *      terms; revocation (direct or by access review) takes effect at once;
 *      the retired tier routes answer 410.
 *   4. CONCURRENCY — two simultaneous grants of one scope: exactly one wins,
 *      the other is the typed refusal, one live row remains.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DELEGATED_ADMIN_SCOPE_KINDS,
  listPermissionsForDelegatedAdminScope,
  roleHasPermission,
  type Permission,
} from "@proovra/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  "../prisma/migrations/20281026000500_delegated_admin_convergence/migration.sql",
);
// Re-audit N-2 (suspended holders) and N-1 (the delegated-administration floor).
const SUSPENDED_MIGRATION = path.resolve(
  HERE,
  "../prisma/migrations/20281026001000_delegated_admin_suspended_holders/migration.sql",
);
const FLOOR_MIGRATION = path.resolve(
  HERE,
  "../prisma/migrations/20281026001100_delegated_admin_floor/migration.sql",
);

type Tier =
  | "GLOBAL_ADMIN"
  | "ORG_ADMIN"
  | "DEPARTMENT_ADMIN"
  | "WORKSPACE_ADMIN"
  | "REVIEWER_LEAD"
  | "SECURITY_OFFICER"
  | "COMPLIANCE_OFFICER";

const ORG_SET = [
  "audit.read",
  "billing.manage",
  "governance.department.manage",
  "governance.exchange.manage",
  "governance.legal_hold.manage",
  "governance.policy.manage",
  "governance.retention.manage",
  "identity.access_review.action",
  "identity.org_policy.manage",
  "integration.webhook.manage",
];

/** What each tier must be carried as — independent of the migration's text. */
const EXPECTED: Record<Tier, string[]> = {
  GLOBAL_ADMIN: ORG_SET,
  ORG_ADMIN: ORG_SET,
  DEPARTMENT_ADMIN: ["governance.department.manage"],
  WORKSPACE_ADMIN: [],
  REVIEWER_LEAD: ["governance.exchange.manage"],
  SECURITY_OFFICER: ["audit.read", "governance.policy.manage", "identity.access_review.action", "identity.org_policy.manage"],
  COMPLIANCE_OFFICER: [
    "audit.read",
    "governance.legal_hold.manage",
    "governance.policy.manage",
    "governance.retention.manage",
    "identity.access_review.action",
  ],
};

/**
 * Re-audit N-1 — the precise permissions each tier's former routes now ask
 * for, beyond what the convergence carried. Derived from GATES below (which
 * tier admitted which route), independent of the floor migration's text.
 */
const ORG_FLOOR = [
  "audit.lifecycle_package.preview",
  "audit.verification_package.preview",
  "governance.access_review.decide",
  "governance.archive.transition",
  "governance.department.define",
  "governance.destruction.approve",
  "governance.destruction.request",
  "governance.exchange.decide",
  "governance.policy.assign",
  "governance.retention_policy.manage",
  "integration.lifecycle_webhook.manage",
  "trust.article.publish",
  "trust.status.manage",
  "trust.subprocessor.manage",
];
const FLOOR: Record<Tier, string[]> = {
  GLOBAL_ADMIN: ORG_FLOOR,
  ORG_ADMIN: ORG_FLOOR,
  DEPARTMENT_ADMIN: [],
  WORKSPACE_ADMIN: [],
  REVIEWER_LEAD: [],
  SECURITY_OFFICER: [
    "audit.verification_package.preview",
    "governance.access_review.campaign.manage",
    "governance.access_review.decide",
    "governance.destruction.approve",
    "governance.policy.author",
    "governance.trust_scan.run",
    "trust.article.ai_disclosure.publish",
    "trust.article.publish",
    "trust.article.security.publish",
    "trust.status.manage",
  ],
  COMPLIANCE_OFFICER: [
    "audit.lifecycle_package.preview",
    "audit.verification_package.preview",
    "governance.access_review.campaign.manage",
    "governance.access_review.decide",
    "governance.destruction.approve",
    "governance.destruction.execute",
    "governance.destruction.request",
    "governance.policy.author",
    "governance.retention_policy.manage",
    "governance.trust_scan.run",
    "trust.article.ai_disclosure.publish",
    "trust.article.publish",
    "trust.subprocessor.manage",
  ],
};

/** Every permission a former tier route now asks for (none is role-held but the OWNER's). */
const DELEGATED_ONLY = [
  ...new Set([...ORG_FLOOR, ...FLOOR.SECURITY_OFFICER, ...FLOOR.COMPLIANCE_OFFICER, "governance.exchange.manage", "governance.department.manage"]),
] as Permission[];

// The tier gates as they stood before retirement (git HEAD of the release
// before this one), with the ORG-chain ladder applied: a route requiring
// ORG_ADMIN admitted GLOBAL_ADMIN too; DEPARTMENT_ADMIN admitted ORG and
// GLOBAL. Cross-cutting tiers admitted only themselves.
const ORG = ["GLOBAL_ADMIN", "ORG_ADMIN"] as const;
const DEPT = ["GLOBAL_ADMIN", "ORG_ADMIN", "DEPARTMENT_ADMIN"] as const;
type Gate = { method: "GET" | "POST"; path: string; tiers: readonly Tier[] };
const GATES: Gate[] = [
  { method: "POST", path: "/v1/packaging/entitlements/apply-product-line", tiers: ORG },
  { method: "POST", path: "/v1/packaging/entitlements/grant", tiers: ORG },
  { method: "POST", path: "/v1/exchange/packages/:id/revoke", tiers: ORG },
  { method: "POST", path: "/v1/exchange/chain-transfers", tiers: [...ORG, "REVIEWER_LEAD"] },
  { method: "POST", path: "/v1/exchange/chain-transfers/:id/accept", tiers: ORG },
  { method: "POST", path: "/v1/exchange/chain-transfers/:id/reject", tiers: ORG },
  { method: "POST", path: "/v1/exchange/chain-transfers/:id/revoke", tiers: ORG },
  { method: "POST", path: "/v1/exchange/chain-transfers/:id/complete", tiers: ORG },
  { method: "POST", path: "/v1/integrations/webhooks/endpoints", tiers: ORG },
  { method: "POST", path: "/v1/integrations/webhooks/endpoints/:id/deactivate", tiers: ORG },
  { method: "POST", path: "/v1/integrations/webhooks/lifecycle-deliveries/:id/replay", tiers: ORG },
  { method: "POST", path: "/v1/lifecycle/retention/policies", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/lifecycle/retention/policies/:id/release", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/lifecycle/legal-holds", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/lifecycle/legal-holds/:id/release", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/lifecycle/archive/transition", tiers: ORG },
  { method: "POST", path: "/v1/lifecycle/destruction/requests", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  {
    method: "POST",
    path: "/v1/lifecycle/destruction/requests/:id/approve",
    tiers: [...ORG, "COMPLIANCE_OFFICER", "SECURITY_OFFICER"],
  },
  { method: "POST", path: "/v1/lifecycle/destruction/requests/:id/reject", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/lifecycle/destruction/requests/:id/execute", tiers: ["COMPLIANCE_OFFICER"] },
  { method: "GET", path: "/v1/lifecycle/verification-package/preview", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/trust/articles", tiers: [...ORG, "SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/trust/subprocessors", tiers: [...ORG, "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/trust/status/incidents", tiers: [...ORG, "SECURITY_OFFICER"] },
  { method: "POST", path: "/v1/trust/status/incidents/:id/updates", tiers: [...ORG, "SECURITY_OFFICER"] },
  { method: "POST", path: "/v1/trust/status/maintenance", tiers: [...ORG, "SECURITY_OFFICER"] },
  { method: "POST", path: "/v1/governance/departments", tiers: ORG },
  { method: "POST", path: "/v1/governance/departments/:id/archive", tiers: ORG },
  { method: "POST", path: "/v1/governance/policies", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/governance/policies/:id/activate", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/governance/policies/:id/deprecate", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/governance/policies/:id/assignments", tiers: ORG },
  { method: "POST", path: "/v1/governance/access-reviews/campaigns", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/governance/access-reviews/campaigns/:id/open", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/governance/access-reviews/campaigns/:id/close", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  {
    method: "POST",
    path: "/v1/governance/access-reviews/items/:id/decision",
    tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER", ...ORG],
  },
  { method: "POST", path: "/v1/governance/cross-org-review", tiers: [...ORG, "REVIEWER_LEAD"] },
  { method: "POST", path: "/v1/governance/cross-org-review/:id/accept", tiers: ORG },
  { method: "POST", path: "/v1/governance/cross-org-review/:id/decline", tiers: ORG },
  { method: "POST", path: "/v1/governance/cross-org-review/:id/revoke", tiers: ORG },
  { method: "POST", path: "/v1/trust/drift/scan", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/trust/security-claims/scan", tiers: ["SECURITY_OFFICER", "COMPLIANCE_OFFICER"] },
  { method: "POST", path: "/v1/governance/departments/:id/memberships", tiers: DEPT },
  { method: "POST", path: "/v1/governance/departments/memberships/:id/revoke", tiers: DEPT },
  {
    method: "GET",
    path: "/v1/trust/verification-package/preview",
    tiers: [...ORG, "SECURITY_OFFICER", "COMPLIANCE_OFFICER"],
  },
];

const TIERS: Tier[] = [
  "GLOBAL_ADMIN",
  "ORG_ADMIN",
  "DEPARTMENT_ADMIN",
  "WORKSPACE_ADMIN",
  "REVIEWER_LEAD",
  "SECURITY_OFFICER",
  "COMPLIANCE_OFFICER",
];

describe("DOM-09 — one delegated-admin authority (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let access: typeof import("../src/services/identity/access-policy.service.js");
  let accessReview: typeof import("../src/services/governance/access-review.service.js");
  const A = () => h.fixtures.teamA;

  type Person = { id: string; memberId: string; token: string };
  const holders = new Map<Tier, Person>();
  let nobody: Person;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    rbac = await import("../src/services/identity/rbac.service.js");
    access = await import("../src/services/identity/access-policy.service.js");
    accessReview = await import("../src/services/governance/access-review.service.js");
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    // Collection routes (the member listing) derive the workspace from the
    // caller's persisted pointer.
    await prisma.user.update({ where: { id: A().ownerUserId }, data: { currentWorkspaceId: A().teamId } });
    for (const tier of TIERS) holders.set(tier, await person(A().teamId, "VIEWER"));
    nobody = await person(A().teamId, "VIEWER");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function person(teamId: string, role: "ADMIN" | "MEMBER" | "VIEWER"): Promise<Person> {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `dom09-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "Delegate", provider: "EMAIL", providerUserId: email, currentWorkspaceId: teamId },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    const m = await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, memberId: m.id, token };
  }

  async function tierGrant(granteeUserId: string, tier: Tier, extra: { expiresAtUtc?: Date; revokedAtUtc?: Date; state?: string } = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return prisma.delegatedAdminGrant.create({
      data: {
        teamId: A().teamId,
        organizationId: team.organizationId,
        granteeUserId,
        grantedByUserId: A().ownerUserId,
        tier,
        state: extra.state ?? "ACTIVE",
        expiresAtUtc: extra.expiresAtUtc ?? null,
        revokedAtUtc: extra.revokedAtUtc ?? null,
      },
      select: { id: true },
    });
  }

  async function runMigration(file: string = MIGRATION): Promise<void> {
    // The whole file, exactly as `prisma migrate deploy` would run it (simple
    // query protocol: every statement, in order).
    const sql = readFileSync(file, "utf8");
    const conn = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await conn.connect();
    try {
      await conn.query(sql);
    } finally {
      await conn.end();
    }
  }

  async function liveCapabilities(memberId: string): Promise<string[]> {
    const rows = await prisma.memberCapabilityGrant.findMany({
      where: { teamMemberId: memberId, revokedAtUtc: null, OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: new Date() } }] },
      select: { permission: true },
    });
    return rows.map((r) => r.permission).sort();
  }

  const concrete = (p: string) => p.replace(/:id/g, randomUUID());
  async function call(gate: Gate, token: string) {
    return h.app.inject({
      method: gate.method,
      url: concrete(gate.path),
      headers: { ...bearer(token), "content-type": "application/json" },
      ...(gate.method === "GET" ? {} : { payload: {} }),
    });
  }
  const isPermissionRefusal = (res: { statusCode: number; body: string }) => {
    if (res.statusCode !== 403) return false;
    try {
      return (JSON.parse(res.body) as { denial?: string }).denial === "PERMISSION_REQUIRED";
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------------
  // 1. Migration
  // -------------------------------------------------------------------------

  const tierRows = new Map<Tier, string>();
  let revokedRow: string;
  let expiredRow: string;
  let orphanRow: string;
  let orphanUser: string;

  it("carries every live tier grant forward exactly, and records what became of each row", async () => {
    for (const tier of TIERS) tierRows.set(tier, (await tierGrant(holders.get(tier)!.id, tier)).id);
    // Ended grants are history, never carried.
    const ended = await person(A().teamId, "VIEWER");
    revokedRow = (await tierGrant(ended.id, "ORG_ADMIN", { state: "REVOKED", revokedAtUtc: new Date() })).id;
    expiredRow = (await tierGrant(ended.id, "COMPLIANCE_OFFICER", { expiresAtUtc: new Date(Date.now() - 60_000) })).id;
    // A live grant whose grantee is no longer a member has nothing to carry to.
    const gone = await person(A().teamId, "VIEWER");
    orphanUser = gone.id;
    orphanRow = (await tierGrant(gone.id, "ORG_ADMIN")).id;
    await prisma.teamMember.update({ where: { id: gone.memberId }, data: { status: "REVOKED" } });

    await runMigration();

    for (const tier of TIERS) {
      expect(await liveCapabilities(holders.get(tier)!.memberId), tier).toEqual([...EXPECTED[tier]].sort());
    }
    expect(await liveCapabilities(ended.memberId)).toEqual([]);
    expect(await prisma.memberCapabilityGrant.count({ where: { teamMember: { userId: orphanUser } } })).toBe(0);

    const states = new Map(
      (await prisma.delegatedAdminGrant.findMany({ where: { teamId: A().teamId }, select: { id: true, state: true } })).map(
        (r) => [r.id, r.state],
      ),
    );
    for (const tier of TIERS) {
      expect(states.get(tierRows.get(tier)!), tier).toBe(tier === "WORKSPACE_ADMIN" ? "RETIRED_NO_EFFECT" : "CONVERGED");
    }
    expect(states.get(revokedRow)).toBe("REVOKED");
    expect(states.get(expiredRow)).toBe("ACTIVE"); // already ended by time; left as written
    expect(states.get(orphanRow)).toBe("RETIRED_NO_MEMBER");

    // The carried grant names its origin, grantor and tier row.
    const carried = await prisma.memberCapabilityGrant.findFirstOrThrow({
      where: { teamMemberId: holders.get("SECURITY_OFFICER")!.memberId, permission: "identity.org_policy.manage" },
    });
    expect(carried.reason).toContain("SECURITY_OFFICER");
    expect(carried.reason).toContain(tierRows.get("SECURITY_OFFICER")!);
    expect(carried.grantedByUserId).toBe(A().ownerUserId);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = await prisma.memberCapabilityGrant.findMany({
      where: { teamId: A().teamId },
      orderBy: { id: "asc" },
      select: { id: true, permission: true, revokedAtUtc: true, expiresAtUtc: true, updatedAt: true },
    });
    await runMigration();
    const after = await prisma.memberCapabilityGrant.findMany({
      where: { teamId: A().teamId },
      orderBy: { id: "asc" },
      select: { id: true, permission: true, revokedAtUtc: true, expiresAtUtc: true, updatedAt: true },
    });
    expect(after).toEqual(before);
  });

  it("re-issues a revoked capability and extends a shorter one; keeps a longer live one", async () => {
    const p = await person(A().teamId, "VIEWER");
    const soon = new Date(Date.now() + 2 * 86_400_000);
    const later = new Date(Date.now() + 90 * 86_400_000);
    await prisma.memberCapabilityGrant.createMany({
      data: [
        { teamMemberId: p.memberId, teamId: A().teamId, permission: "audit.read", grantedByUserId: A().ownerUserId, revokedAtUtc: new Date() },
        { teamMemberId: p.memberId, teamId: A().teamId, permission: "governance.policy.manage", grantedByUserId: A().ownerUserId, expiresAtUtc: soon },
        { teamMemberId: p.memberId, teamId: A().teamId, permission: "identity.org_policy.manage", grantedByUserId: A().ownerUserId, expiresAtUtc: later, reason: "kept" },
      ],
    });
    await tierGrant(p.id, "SECURITY_OFFICER", { expiresAtUtc: new Date(Date.now() + 30 * 86_400_000) });
    await runMigration();
    const rows = new Map(
      (await prisma.memberCapabilityGrant.findMany({ where: { teamMemberId: p.memberId } })).map((r) => [r.permission, r]),
    );
    expect(rows.get("audit.read")!.revokedAtUtc).toBeNull();
    expect(rows.get("governance.policy.manage")!.expiresAtUtc!.getTime()).toBeGreaterThan(soon.getTime());
    expect(rows.get("identity.org_policy.manage")!.reason).toBe("kept");
    expect(rows.get("identity.org_policy.manage")!.expiresAtUtc!.getTime()).toBe(later.getTime());
    expect(rows.get("identity.access_review.action")!.revokedAtUtc).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 1b. Re-audit N-2 and N-1 — suspended holders, and the floor
  // -------------------------------------------------------------------------

  let suspendedHolder: Person;
  let suspendedRow: string;
  let revokedAnchorHolder: Person;
  let plainAdmin: Person;

  it("N-1: the floor migration grants each tier holder exactly the precise permissions of its tier — and nobody else", async () => {
    // A tier holder whose carried anchor an administrator has since revoked
    // keeps nothing further on that anchor's routes.
    revokedAnchorHolder = await person(A().teamId, "VIEWER");
    await tierGrant(revokedAnchorHolder.id, "COMPLIANCE_OFFICER");
    // A workspace ADMIN with no tier, and the holders of ended grants: nothing.
    plainAdmin = await person(A().teamId, "ADMIN");
    await runMigration();
    await prisma.memberCapabilityGrant.updateMany({
      where: { teamMemberId: revokedAnchorHolder.memberId, permission: "governance.retention.manage" },
      data: { revokedAtUtc: new Date(), revokedReason: "test" },
    });

    await runMigration(SUSPENDED_MIGRATION);
    await runMigration(FLOOR_MIGRATION);

    for (const tier of TIERS) {
      expect(await liveCapabilities(holders.get(tier)!.memberId), tier).toEqual(
        [...new Set([...EXPECTED[tier], ...FLOOR[tier]])].sort(),
      );
    }
    expect(await liveCapabilities(plainAdmin.memberId)).toEqual([]);
    expect(await liveCapabilities(nobody.memberId)).toEqual([]);
    const partial = await liveCapabilities(revokedAnchorHolder.memberId);
    for (const p of ["governance.destruction.execute", "governance.destruction.request", "governance.retention_policy.manage"]) {
      expect(partial, p).not.toContain(p);
    }
    expect(partial).toContain("governance.policy.author"); // its own anchor is live

    // The floor grant names its tier row and grantor, and never outlives the tier.
    const g = await prisma.memberCapabilityGrant.findFirstOrThrow({
      where: { teamMemberId: holders.get("COMPLIANCE_OFFICER")!.memberId, permission: "governance.destruction.execute" },
    });
    expect(g.reason).toContain("COMPLIANCE_OFFICER");
    expect(g.reason).toContain(tierRows.get("COMPLIANCE_OFFICER")!);
    expect(g.grantedByUserId).toBe(A().ownerUserId);
  });

  it("N-1: the floor migration is idempotent and never overrides a later revocation", async () => {
    const snapshot = () =>
      prisma.memberCapabilityGrant.findMany({
        where: { teamId: A().teamId },
        orderBy: { id: "asc" },
        select: { id: true, permission: true, revokedAtUtc: true, expiresAtUtc: true, updatedAt: true },
      });
    // An administrator revokes one floor grant after the release.
    const target = await prisma.memberCapabilityGrant.findFirstOrThrow({
      where: { teamMemberId: holders.get("SECURITY_OFFICER")!.memberId, permission: "trust.status.manage" },
    });
    await prisma.memberCapabilityGrant.update({ where: { id: target.id }, data: { revokedAtUtc: new Date(), revokedReason: "test" } });
    const before = await snapshot();
    await runMigration(SUSPENDED_MIGRATION);
    await runMigration(FLOOR_MIGRATION);
    expect(await snapshot()).toEqual(before);
    // Restore the holder for the coverage checks below.
    await prisma.memberCapabilityGrant.update({ where: { id: target.id }, data: { revokedAtUtc: null, revokedReason: null } });
  });

  it("N-2: a holder SUSPENDED at convergence is carried forward — inert while suspended, restored on reinstatement", async () => {
    suspendedHolder = await person(A().teamId, "VIEWER");
    suspendedRow = (await tierGrant(suspendedHolder.id, "COMPLIANCE_OFFICER")).id;
    await prisma.teamMember.update({ where: { id: suspendedHolder.memberId }, data: { status: "SUSPENDED" } });

    // The convergence retires it (the defect), then the forward migrations run.
    await runMigration();
    expect((await prisma.delegatedAdminGrant.findUniqueOrThrow({ where: { id: suspendedRow } })).state).toBe("RETIRED_NO_MEMBER");
    await runMigration(SUSPENDED_MIGRATION);
    expect((await prisma.delegatedAdminGrant.findUniqueOrThrow({ where: { id: suspendedRow } })).state).toBe("CONVERGED");
    await runMigration(FLOOR_MIGRATION);
    expect(await liveCapabilities(suspendedHolder.memberId)).toEqual(
      [...new Set([...EXPECTED.COMPLIANCE_OFFICER, ...FLOOR.COMPLIANCE_OFFICER])].sort(),
    );

    // The REVOKED grantee's row stays retired and carries nothing.
    expect((await prisma.delegatedAdminGrant.findUniqueOrThrow({ where: { id: orphanRow } })).state).toBe("RETIRED_NO_MEMBER");
    expect(await prisma.memberCapabilityGrant.count({ where: { teamMember: { userId: orphanUser } } })).toBe(0);

    const execute = GATES.find((g) => g.path === "/v1/lifecycle/destruction/requests/:id/execute")!;
    expect(isPermissionRefusal(await call(execute, suspendedHolder.token))).toBe(true); // inert while suspended
    await prisma.teamMember.update({ where: { id: suspendedHolder.memberId }, data: { status: "ACTIVE" } });
    expect(isPermissionRefusal(await call(execute, suspendedHolder.token))).toBe(false); // reinstated → restored

    // Idempotent: another run of either changes nothing.
    const before = await liveCapabilities(suspendedHolder.memberId);
    await runMigration(SUSPENDED_MIGRATION);
    await runMigration(FLOOR_MIGRATION);
    expect(await liveCapabilities(suspendedHolder.memberId)).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // 2. Coverage and no widening
  // -------------------------------------------------------------------------

  it("N-1: no workspace role but the OWNER holds any delegated-only permission", async () => {
    for (const role of ["ADMIN", "MEMBER", "VIEWER"] as const) {
      for (const p of DELEGATED_ONLY) expect(roleHasPermission(role, p), `${role} ${p}`).toBe(false);
    }
    for (const p of DELEGATED_ONLY) expect(roleHasPermission("OWNER", p), p).toBe(true);
    for (const scope of DELEGATED_ADMIN_SCOPE_KINDS) {
      for (const p of DELEGATED_ONLY) expect(listPermissionsForDelegatedAdminScope(scope), `${scope} ${p}`).not.toContain(p);
    }
  });

  it("N-1: a workspace ADMIN and a MEMBER are refused on every formerly tier-gated route", async () => {
    // The one exception is not new: an ADMIN placed and released legal holds
    // through the governance legal-hold routes before the tiers were retired.
    const ADMIN_HELD_BEFORE = new Set(["/v1/lifecycle/legal-holds", "/v1/lifecycle/legal-holds/:id/release"]);
    const member = await person(A().teamId, "MEMBER");
    const admitted: string[] = [];
    for (const [who, label] of [[plainAdmin, "ADMIN"], [member, "MEMBER"]] as const) {
      for (const gate of GATES) {
        if (label === "ADMIN" && ADMIN_HELD_BEFORE.has(gate.path)) continue;
        const res = await call(gate, who.token);
        if (!isPermissionRefusal(res)) admitted.push(`${label} ${gate.method} ${gate.path} → ${res.statusCode}`);
      }
    }
    expect(admitted, admitted.join("\n")).toEqual([]);
    // Positive control: the same ADMIN still reaches what the role always held.
    const holds = GATES.find((g) => g.path === "/v1/lifecycle/legal-holds")!;
    expect(isPermissionRefusal(await call(holds, plainAdmin.token))).toBe(false);
  }, 300_000);

  it("every tier holder is still admitted on every route their tier admitted", async () => {
    const lost: string[] = [];
    for (const gate of GATES) {
      for (const tier of gate.tiers) {
        const res = await call(gate, holders.get(tier)!.token);
        if (isPermissionRefusal(res)) lost.push(`${tier} ${gate.method} ${gate.path} → ${res.body.slice(0, 140)}`);
      }
    }
    expect(lost, `coverage lost:\n${lost.join("\n")}`).toEqual([]);
  }, 300_000);

  it("a member holding nothing — and a WORKSPACE_ADMIN holder — is refused on the whole former surface", async () => {
    const admitted: string[] = [];
    for (const who of [nobody, holders.get("WORKSPACE_ADMIN")!]) {
      for (const gate of GATES) {
        const res = await call(gate, who.token);
        if (!isPermissionRefusal(res)) admitted.push(`${gate.method} ${gate.path} → ${res.statusCode}`);
      }
    }
    expect(admitted).toEqual([]);
  }, 300_000);

  it("no tier is widened into a neighbouring domain", async () => {
    const may = (tier: Tier, permission: string) =>
      access
        .evaluateMemberAccess({ teamId: A().teamId, userId: holders.get(tier)!.id, permission: permission as never }, prisma)
        .then((d) => d.allowed);
    expect(await may("SECURITY_OFFICER", "identity.member.suspend")).toBe(false);
    expect(await may("SECURITY_OFFICER", "governance.retention.manage")).toBe(false);
    expect(await may("REVIEWER_LEAD", "governance.legal_hold.manage")).toBe(false);
    expect(await may("REVIEWER_LEAD", "review.assign")).toBe(false);
    expect(await may("DEPARTMENT_ADMIN", "governance.policy.manage")).toBe(false);
    expect(await may("COMPLIANCE_OFFICER", "billing.manage")).toBe(false);
    // Re-audit N-1 — the precise floor keeps each tier inside its own routes.
    expect(await may("ORG_ADMIN", "governance.destruction.execute")).toBe(false);
    expect(await may("SECURITY_OFFICER", "governance.destruction.execute")).toBe(false);
    expect(await may("REVIEWER_LEAD", "governance.exchange.decide")).toBe(false);
    expect(await may("COMPLIANCE_OFFICER", "trust.article.security.publish")).toBe(false);
    expect(await may("ORG_ADMIN", "governance.policy.author")).toBe(false);
    expect(await may("COMPLIANCE_OFFICER", "governance.destruction.execute")).toBe(true);
    // ...and each holds what it should.
    expect(await may("REVIEWER_LEAD", "governance.exchange.manage")).toBe(true);
    expect(await may("DEPARTMENT_ADMIN", "governance.department.manage")).toBe(true);
  });

  it("a carried grant ends with its membership", async () => {
    const holder = holders.get("COMPLIANCE_OFFICER")!;
    const gate = GATES.find((g) => g.path === "/v1/lifecycle/legal-holds")!;
    expect(isPermissionRefusal(await call(gate, holder.token))).toBe(false);
    await prisma.teamMember.update({ where: { id: holder.memberId }, data: { status: "SUSPENDED" } });
    expect(isPermissionRefusal(await call(gate, holder.token))).toBe(true);
    await prisma.teamMember.update({ where: { id: holder.memberId }, data: { status: "ACTIVE" } });
  });

  // -------------------------------------------------------------------------
  // 3. The managed writer
  // -------------------------------------------------------------------------

  it("the retired tier routes answer 410 and write nothing", async () => {
    const before = await prisma.delegatedAdminGrant.count();
    const owner = bearer(A().ownerToken);
    for (const [method, url] of [
      ["GET", "/v1/governance/delegated-admin"],
      ["POST", "/v1/governance/delegated-admin"],
      ["POST", `/v1/governance/delegated-admin/${tierRows.get("ORG_ADMIN")}/revoke`],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: owner, ...(method === "POST" ? { payload: { tier: "ORG_ADMIN" } } : {}) });
      expect(res.statusCode, url).toBe(410);
      expect((res.json() as { code: string }).code).toBe("DELEGATED_ADMIN_TIERS_RETIRED");
    }
    expect(await prisma.delegatedAdminGrant.count()).toBe(before);
    expect((await prisma.delegatedAdminGrant.findUniqueOrThrow({ where: { id: tierRows.get("ORG_ADMIN")! } })).state).toBe("CONVERGED");
  });

  it("grant → inspect → update → revoke a scope through Security Center, step-up bound and audited", async () => {
    const delegate = await person(A().teamId, "VIEWER");
    // A route the GOVERNANCE_ADMIN scope admits (legal holds) — policy
    // authoring is a delegated-only permission no scope carries (re-audit N-1).
    const policies = GATES.find((g) => g.path === "/v1/lifecycle/legal-holds")!;
    expect(isPermissionRefusal(await call(policies, delegate.token))).toBe(true);

    const ownerAuth = bearer(A().ownerToken);
    // No step-up, no grant.
    const bare = await h.app.inject({
      method: "POST",
      url: `/v1/identity/members/${delegate.memberId}/delegated-admin`,
      headers: ownerAuth,
      payload: { scopeKind: "GOVERNANCE_ADMIN", reason: "quarter close" },
    });
    expect(bare.statusCode).toBe(401);
    expect(bare.body).toContain("STEP_UP_REQUIRED");
    expect(await prisma.memberDelegatedAdminScope.count({ where: { teamMemberId: delegate.memberId } })).toBe(0);

    const grantHeader = await stepUp.approvedHeader({
      token: A().ownerToken,
      userId: A().ownerUserId,
      teamId: A().teamId,
      purpose: "DELEGATED_ADMIN_GRANT",
      resourceKind: "team_member",
      resourceId: delegate.memberId,
    });
    const granted = await h.app.inject({
      method: "POST",
      url: `/v1/identity/members/${delegate.memberId}/delegated-admin`,
      headers: { ...ownerAuth, ...grantHeader },
      payload: { scopeKind: "GOVERNANCE_ADMIN", reason: "quarter close" },
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const scopeId = (granted.json() as { scope: { id: string } }).scope.id;
    expect(isPermissionRefusal(await call(policies, delegate.token))).toBe(false);

    // Inspect: the member listing carries the live scope.
    const listed = await h.app.inject({ method: "GET", url: `/v1/identity/members?teamId=${A().teamId}`, headers: ownerAuth });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).toContain(scopeId);

    // Update — refused in the past, refused without step-up, then applied.
    const newExpiry = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const past = await h.app.inject({
      method: "PATCH",
      url: `/v1/identity/delegated-admin/${scopeId}`,
      headers: ownerAuth,
      payload: { expiresAtUtc: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.statusCode).toBe(400);
    const noStepUp = await h.app.inject({
      method: "PATCH",
      url: `/v1/identity/delegated-admin/${scopeId}`,
      headers: ownerAuth,
      payload: { expiresAtUtc: newExpiry },
    });
    expect(noStepUp.statusCode).toBe(401);
    expect(noStepUp.body).toContain("STEP_UP_REQUIRED");
    // The delegate cannot change their own terms.
    const byDelegate = await h.app.inject({
      method: "PATCH",
      url: `/v1/identity/delegated-admin/${scopeId}`,
      headers: bearer(delegate.token),
      payload: { expiresAtUtc: null },
    });
    expect([403, 404]).toContain(byDelegate.statusCode);

    const updateHeader = await stepUp.approvedHeader({
      token: A().ownerToken,
      userId: A().ownerUserId,
      teamId: A().teamId,
      purpose: "DELEGATED_ADMIN_GRANT",
      resourceKind: "delegated_admin_scope",
      resourceId: scopeId,
    });
    const updated = await h.app.inject({
      method: "PATCH",
      url: `/v1/identity/delegated-admin/${scopeId}`,
      headers: { ...ownerAuth, ...updateHeader },
      payload: { expiresAtUtc: newExpiry, reason: "extended for audit" },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const row = await prisma.memberDelegatedAdminScope.findUniqueOrThrow({ where: { id: scopeId } });
    expect(row.expiresAtUtc!.toISOString()).toBe(newExpiry);
    expect(row.reason).toBe("extended for audit");
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.delegated_admin.update", resourceId: scopeId },
    });
    const meta = audit.metadata as { previous: { expiresAtUtc: string | null; reason: string | null }; resulting: { expiresAtUtc: string | null; reason: string | null } };
    expect(meta.previous).toEqual({ expiresAtUtc: null, reason: "quarter close" });
    expect(meta.resulting).toEqual({ expiresAtUtc: newExpiry, reason: "extended for audit" });

    // Revoke — takes effect at once; a revoked scope cannot be updated.
    const revokeHeader = await stepUp.approvedHeader({
      token: A().ownerToken,
      userId: A().ownerUserId,
      teamId: A().teamId,
      purpose: "DELEGATED_ADMIN_REVOKE",
      resourceKind: "delegated_admin_scope",
      resourceId: scopeId,
    });
    const revoked = await h.app.inject({
      method: "DELETE",
      url: `/v1/identity/delegated-admin/${scopeId}`,
      headers: { ...ownerAuth, ...revokeHeader },
      payload: { reason: "done" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(isPermissionRefusal(await call(policies, delegate.token))).toBe(true);
    await expect(
      rbac.updateDelegatedAdminScope({ teamId: A().teamId, scopeId, actorUserId: A().ownerUserId, reason: "late" }, prisma),
    ).rejects.toMatchObject({ code: "delegated_scope_not_found" });
    expect(await prisma.adminAuditLog.count({ where: { action: "identity.delegated_admin.revoke", resourceId: scopeId } })).toBe(1);
  }, 300_000);

  it("a capability grant (carried or issued) is updated in place: step-up bound, audited, D54-checked, never after revocation", async () => {
    const holder = await person(A().teamId, "VIEWER");
    const grant = await rbac.grantCapability(
      { teamId: A().teamId, teamMemberId: holder.memberId, permission: "billing.manage", actorUserId: A().ownerUserId, reason: "renewal season" },
      prisma,
    );
    const ownerAuth = bearer(A().ownerToken);
    const newExpiry = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const noStepUp = await h.app.inject({
      method: "PATCH",
      url: `/v1/identity/capabilities/${grant.id}`,
      headers: ownerAuth,
      payload: { expiresAtUtc: newExpiry },
    });
    expect(noStepUp.statusCode).toBe(401);
    expect(noStepUp.body).toContain("STEP_UP_REQUIRED");
    const byHolder = await h.app.inject({
      method: "PATCH",
      url: `/v1/identity/capabilities/${grant.id}`,
      headers: bearer(holder.token),
      payload: { expiresAtUtc: null },
    });
    expect([403, 404]).toContain(byHolder.statusCode);

    const header = await stepUp.approvedHeader({
      token: A().ownerToken,
      userId: A().ownerUserId,
      teamId: A().teamId,
      purpose: "CAPABILITY_GRANT",
      resourceKind: "member_capability_grant",
      resourceId: grant.id,
    });
    const updated = await h.app.inject({
      method: "PATCH",
      url: `/v1/identity/capabilities/${grant.id}`,
      headers: { ...ownerAuth, ...header },
      payload: { expiresAtUtc: newExpiry, reason: "extended" },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const row = await prisma.memberCapabilityGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.expiresAtUtc!.toISOString()).toBe(newExpiry);
    expect(row.reason).toBe("extended");
    expect(row.permission).toBe("billing.manage");
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "identity.capability.update", resourceId: grant.id } });
    expect((audit.metadata as { previous: unknown }).previous).toEqual({ expiresAtUtc: null, reason: "renewal season" });

    // D54 — an ADMIN without billing.manage cannot extend it.
    const admin = await person(A().teamId, "ADMIN");
    await expect(
      rbac.updateCapability({ teamId: A().teamId, grantId: grant.id, actorUserId: admin.id, expiresAtUtc: null }, prisma),
    ).rejects.toMatchObject({ code: "grantor_lacks_permission" });

    await rbac.revokeCapability({ teamId: A().teamId, grantId: grant.id, actorUserId: A().ownerUserId }, prisma);
    await expect(
      rbac.updateCapability({ teamId: A().teamId, grantId: grant.id, actorUserId: A().ownerUserId, reason: "late" }, prisma),
    ).rejects.toMatchObject({ code: "capability_not_found" });
  }, 300_000);

  it("an expired scope admits nothing", async () => {
    const delegate = await person(A().teamId, "VIEWER");
    const scope = await rbac.grantDelegatedAdminScope(
      { teamId: A().teamId, teamMemberId: delegate.memberId, scopeKind: "GOVERNANCE_ADMIN", actorUserId: A().ownerUserId },
      prisma,
    );
    // A route the GOVERNANCE_ADMIN scope admits (legal holds) — policy
    // authoring is a delegated-only permission no scope carries (re-audit N-1).
    const policies = GATES.find((g) => g.path === "/v1/lifecycle/legal-holds")!;
    expect(isPermissionRefusal(await call(policies, delegate.token))).toBe(false);
    await prisma.memberDelegatedAdminScope.update({ where: { id: scope.id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
    expect(isPermissionRefusal(await call(policies, delegate.token))).toBe(true);
  });

  it("an access review REVOKED decision revokes the delegated scope it names", async () => {
    const delegate = await person(A().teamId, "VIEWER");
    const scope = await rbac.grantDelegatedAdminScope(
      { teamId: A().teamId, teamMemberId: delegate.memberId, scopeKind: "GOVERNANCE_ADMIN", actorUserId: A().ownerUserId },
      prisma,
    );
    const now = new Date();
    const campaign = await prisma.accessReviewCampaign.create({
      data: {
        teamId: A().teamId,
        kind: "DELEGATED_ADMIN",
        state: "OPEN",
        name: `Review ${tag()}`,
        scheduledStartUtc: now,
        scheduledEndUtc: new Date(now.getTime() + 86_400_000),
        createdByUserId: A().ownerUserId,
      },
      select: { id: true },
    });
    const item = await prisma.accessReviewItem.create({
      data: { campaignId: campaign.id, teamId: A().teamId, subjectUserId: delegate.id, decision: "PENDING", grantRef: `delegated_scope:${scope.id}` },
      select: { id: true },
    });
    const res = await accessReview.recordItemDecision({
      prisma,
      teamId: A().teamId,
      itemId: item.id,
      decision: "REVOKED",
      reviewerUserId: A().ownerUserId,
    });
    expect(res.ok).toBe(true);
    const after = await prisma.memberDelegatedAdminScope.findUniqueOrThrow({ where: { id: scope.id } });
    expect(after.revokedAtUtc).not.toBeNull();
    expect(after.revokedReason).toBe("access_review_revoked");
    // A route the GOVERNANCE_ADMIN scope admits (legal holds) — policy
    // authoring is a delegated-only permission no scope carries (re-audit N-1).
    const policies = GATES.find((g) => g.path === "/v1/lifecycle/legal-holds")!;
    expect(isPermissionRefusal(await call(policies, delegate.token))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Concurrency
  // -------------------------------------------------------------------------

  it("two simultaneous first grants of one scope: one wins, one is refused, one live row", async () => {
    const delegate = await person(A().teamId, "VIEWER");
    const grant = () =>
      rbac.grantDelegatedAdminScope(
        { teamId: A().teamId, teamMemberId: delegate.memberId, scopeKind: "REVIEW_ADMIN", actorUserId: A().ownerUserId },
        prisma,
      );
    const results = await Promise.allSettled([grant(), grant()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "delegated_scope_already_active" });
    expect(
      await prisma.memberDelegatedAdminScope.count({ where: { teamMemberId: delegate.memberId, scopeKind: "REVIEW_ADMIN", revokedAtUtc: null } }),
    ).toBe(1);
  });

  it("two simultaneous re-grants of a revoked scope: one wins, one is refused", async () => {
    const delegate = await person(A().teamId, "VIEWER");
    const first = await rbac.grantDelegatedAdminScope(
      { teamId: A().teamId, teamMemberId: delegate.memberId, scopeKind: "INTEGRATION_ADMIN", actorUserId: A().ownerUserId },
      prisma,
    );
    await rbac.revokeDelegatedAdminScope({ teamId: A().teamId, scopeId: first.id, actorUserId: A().ownerUserId }, prisma);
    const regrant = () =>
      rbac.grantDelegatedAdminScope(
        { teamId: A().teamId, teamMemberId: delegate.memberId, scopeKind: "INTEGRATION_ADMIN", actorUserId: A().ownerUserId },
        prisma,
      );
    const results = await Promise.allSettled([regrant(), regrant()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
      code: "delegated_scope_already_active",
    });
    expect(
      await prisma.adminAuditLog.count({ where: { action: "identity.delegated_admin.grant", resourceId: first.id } }),
    ).toBe(2);
  });
});

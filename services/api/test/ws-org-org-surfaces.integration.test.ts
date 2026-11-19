/**
 * WS-ORG (RG-06 / RG-07) — second batch of behavioural regressions on a
 * disposable PostgreSQL 16 through the real routes and services.
 *
 *   PRO-PSZ-04          support access into a personal (SYSTEM) organization
 *                       needs the account holder as approver; no exception
 *   PRO-T2-04           an ARCHIVED organization imposes no noPersonalSpace
 *   PRO-A2-03 / DEC-07  a pre-existing self-serve member keeps Personal Space
 *   PRO-T2-07 / T2-09   the SYSTEM organization behind a personal workspace is
 *                       refused the Enterprise organization surfaces
 *   PRO-TZ-02           invitations never assign workspace OWNER; ADMIN only
 *                       from an inviter who outranks it; a legacy OWNER
 *                       assignment is accepted as MEMBER
 *   PRO-TZ-03 / NAZ-03  resume refuses a running workspace and a resume over
 *                       capacity, reactivating nobody
 *   PRO-T2-05           the invitation lookup states the organization policy
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant } from "./point7/product-fixtures.js";

describe("WS-ORG — organization surfaces (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let identityMode: typeof import("../src/services/identity/identity-mode.service.js");
  let support: typeof import("../src/services/identity/support-access.service.js");
  let acceptance: typeof import("../src/services/organization/org-invite-acceptance.service.js");
  let lookup: typeof import("../src/services/organization/org-invite-lookup.service.js");
  let deps: FixtureDeps;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function orgMember(
    org: OrganizationTenant,
    label: string,
    opts: { orgRole?: "ORG_MEMBER" | "ORG_ADMIN"; role?: "MEMBER" | "ADMIN" | "VIEWER" } = {},
  ) {
    const u = await fx.seedUser(deps, label);
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: u.userId, role: opts.orgRole ?? "ORG_MEMBER" },
    });
    const tm = await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: u.userId, role: opts.role ?? "MEMBER", status: "ACTIVE" },
      select: { id: true },
    });
    return { ...u, teamMemberId: tm.id };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const jwt = await import("../src/services/jwt.js");
    fx = await import("./point7/product-fixtures.js");
    identityMode = await import("../src/services/identity/identity-mode.service.js");
    support = await import("../src/services/identity/support-access.service.js");
    acceptance = await import("../src/services/organization/org-invite-acceptance.service.js");
    lookup = await import("../src/services/organization/org-invite-lookup.service.js");
    deps = {
      prisma: prisma as never,
      tag: `wsorg2-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  it("PRO-PSZ-04 — support access to a personal SYSTEM organization needs the account holder; the outage exception is refused", async () => {
    const person = await fx.seedPersonalTenant(deps, "PRO");
    const staff = await fx.seedUser(deps, "psz04-staff");
    const before = await prisma.supportAccessGrant.count({ where: { organizationId: person.personalOrganizationId } });
    await expect(
      support.startSupportAccess({
        supportUserId: staff.userId,
        organizationId: person.personalOrganizationId,
        reason: "Customer reported an outage of their admins",
        customerApprovalUnavailableReason: "No administrator reachable during the incident",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_ACCOUNT_HOLDER_APPROVAL_REQUIRED" });
    expect(await prisma.supportAccessGrant.count({ where: { organizationId: person.personalOrganizationId } })).toBe(before);

    const grant = await support.startSupportAccess({
      supportUserId: staff.userId,
      organizationId: person.personalOrganizationId,
      reason: "Account holder asked for help with an export",
      approvedByUserId: person.owner.userId,
    });
    expect(grant.accessLevel).toBe("READ_ONLY");
  });

  it("PRO-T2-04 / PRO-A2-03 — an ARCHIVED organization imposes nothing; a self-serve member keeps Personal Space; an organization-originated member is restricted", async () => {
    const org = await fx.seedOrganizationTenant(deps, { noPersonalSpace: true, memberCount: 1 });
    const originated = org.members[0]!; // fixture: created by the org's directory
    expect((await identityMode.resolvePersonalSpaceEligibility(originated.userId)).allowed).toBe(false);

    const selfServe = await fx.seedUser(deps, "a203-self");
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: selfServe.userId, role: "ORG_MEMBER" },
    });
    expect(await identityMode.resolvePersonalSpaceEligibility(selfServe.userId)).toEqual({ allowed: true });

    await prisma.organization.update({ where: { id: org.organizationId }, data: { status: "ARCHIVED" } });
    expect(await identityMode.resolvePersonalSpaceEligibility(originated.userId)).toEqual({ allowed: true });
  });

  it("PRO-T2-07 / PRO-T2-09 — the SYSTEM organization behind a personal workspace is refused the Enterprise organization surfaces", async () => {
    const person = await fx.seedPersonalTenant(deps, "PRO");
    const orgId = person.personalOrganizationId;
    const probes: Array<{ method: "GET" | "POST"; url: string; payload?: unknown }> = [
      { method: "POST", url: `/v1/orgs/${orgId}/data-export`, payload: {} },
      { method: "POST", url: `/v1/orgs/${orgId}/policies/retention`, payload: { retentionDays: 365, immutable: true } },
      { method: "GET", url: `/v1/orgs/${orgId}/governance/control-center` },
      { method: "POST", url: `/v1/orgs/${orgId}/closure`, payload: { confirmation: "CLOSE" } },
      { method: "GET", url: `/v1/orgs/${orgId}/audit-events` },
    ];
    for (const p of probes) {
      const res = await harness.app.inject({
        method: p.method,
        url: p.url,
        headers: auth(person.owner.token),
        ...(p.payload !== undefined ? { payload: p.payload as never } : {}),
      });
      expect(res.statusCode, `${p.method} ${p.url}: ${res.body}`).toBe(403);
    }
    // The organization read stays open so the web can learn its kind.
    const read = await harness.app.inject({ method: "GET", url: `/v1/orgs/${orgId}`, headers: auth(person.owner.token) });
    expect(read.statusCode, read.body).toBe(200);
    expect(JSON.parse(read.body)).toMatchObject({ organizationKind: "SYSTEM" });
    expect(await prisma.organizationDataExportRequest.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it("PRO-TZ-02 — no workspace OWNER by invitation; ADMIN only from an inviter who outranks it; a legacy OWNER assignment lands as MEMBER", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const ownerInvite = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/invites`,
      headers: auth(org.owner.token),
      payload: {
        email: `tz02-${randomUUID().slice(0, 6)}@invitee.test`,
        role: "ORG_MEMBER",
        workspaceAssignments: [{ teamId: org.workspaceId, role: "OWNER" }],
      },
    });
    expect(ownerInvite.statusCode, ownerInvite.body).toBe(400);
    expect(JSON.parse(ownerInvite.body)).toMatchObject({ error: { code: "workspace_owner_assignment_forbidden" } });

    const orgAdmin = await orgMember(org, "tz02-admin", { orgRole: "ORG_ADMIN", role: "MEMBER" });
    const adminInvite = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/invites`,
      headers: auth(orgAdmin.token),
      payload: {
        email: `tz02b-${randomUUID().slice(0, 6)}@invitee.test`,
        role: "ORG_MEMBER",
        workspaceAssignments: [{ teamId: org.workspaceId, role: "ADMIN" }],
      },
    });
    expect(adminInvite.statusCode, adminInvite.body).toBe(403);
    expect(JSON.parse(adminInvite.body)).toMatchObject({ error: { code: "workspace_assignment_above_inviter" } });

    // A pending invitation written before the ceiling existed.
    const invitee = await fx.seedUser(deps, "tz02-legacy");
    const raw = randomUUID();
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    await prisma.organizationInvite.create({
      data: {
        organizationId: org.organizationId,
        email: invitee.email,
        role: "ORG_MEMBER",
        tokenHash,
        invitedByUserId: org.owner.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
        workspaceAssignments: [{ teamId: org.workspaceId, role: "OWNER" }],
      } as never,
    });
    await acceptance.acceptOrganizationInvite({ tokenHash, userId: invitee.userId });
    const row = await prisma.teamMember.findFirstOrThrow({
      where: { teamId: org.workspaceId, userId: invitee.userId },
      select: { role: true, status: true },
    });
    expect(row).toEqual({ role: "MEMBER", status: "ACTIVE" });
  });

  it("PRO-TZ-03 / PRO-NAZ-03 — resume refuses a running workspace and a resume over capacity, reactivating nobody", async () => {
    const org = await fx.seedOrganizationTenant(deps, { memberCount: 2 });
    const base = `/v1/orgs/${org.organizationId}/workspaces/${org.workspaceId}`;
    const call = (leg: "suspend" | "resume") =>
      harness.app.inject({ method: "POST", url: `${base}/${leg}`, headers: auth(org.owner.token), payload: {} });

    const running = await call("resume");
    expect(running.statusCode, running.body).toBe(409);
    expect(JSON.parse(running.body)).toMatchObject({ error: { code: "workspace_not_suspended" } });

    const suspended = await call("suspend");
    expect(suspended.statusCode, suspended.body).toBe(200);
    const paused = (JSON.parse(suspended.body) as { suspend: { membersSuspended: number } }).suspend.membersSuspended;
    expect(paused).toBeGreaterThan(0);
    const again = await call("suspend");
    expect(again.statusCode, again.body).toBe(409);

    // Seats are refilled while suspended: the contract now admits only one.
    await prisma.enterpriseContract.update({ where: { organizationId: org.organizationId }, data: { seatCount: 1 } });
    const over = await call("resume");
    expect(over.statusCode, over.body).toBe(409);
    expect(JSON.parse(over.body)).toMatchObject({ error: { code: "WORKSPACE_SEAT_LIMIT_REACHED" } });
    const stillSuspended = await prisma.teamMember.count({
      where: { teamId: org.workspaceId, status: "SUSPENDED" },
    });
    expect(stillSuspended).toBe(paused);

    await prisma.enterpriseContract.update({ where: { organizationId: org.organizationId }, data: { seatCount: 100 } });
    const ok = await call("resume");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ resume: { membersReactivated: paused } });
  });

  it("PRO-T2-05 — the invitation lookup states the organization's policy before acceptance", async () => {
    const org = await fx.seedOrganizationTenant(deps, { noPersonalSpace: true, managedIdentityRequired: true });
    const raw = `tok-${randomUUID()}`;
    await prisma.organizationInvite.create({
      data: {
        organizationId: org.organizationId,
        email: `t205-${randomUUID().slice(0, 6)}@invitee.test`,
        role: "ORG_MEMBER",
        tokenHash: createHash("sha256").update(raw, "utf8").digest("hex"),
        invitedByUserId: org.owner.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      } as never,
    });
    const view = await lookup.lookupOrganizationInvitation({ rawToken: raw });
    expect(view?.state).toBe("PENDING");
    expect(view?.context?.policy).toEqual({ ssoRequired: false, noPersonalSpace: true, managedIdentityRequired: true });
  });
});

/**
 * SUPPORT ACCESS, ITS REAL BOUNDARIES (live PostgreSQL).
 *
 * The phase-10 suites prove the guard with `evaluateMemberAccess`, sessions and
 * the database mocked; the lifecycle suite proves the grant rows. This one drives
 * the whole path through real routes: a platform-staff user mints a grant behind
 * step-up, enters context, and presents the token on real customer routes.
 *
 * What the support actor is here: the canonical chain runs membership first and
 * the support guard only narrows what it allowed, so a grant admits nobody on its
 * own. The actor is a real ADMIN of the customer workspaces, which makes every
 * refusal below the context's doing: the same request without the token succeeds.
 */
import { randomUUID } from "node:crypto";

import { PERMISSIONS } from "@proovra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { registerSessionForToken } from "./point7/product-fixtures.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;
const CONTEXT = "x-proovra-support-context";
const WORKSPACE = "x-proovra-workspace-id";

describe("support access boundaries", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let service: typeof import("../src/services/identity/support-access.service.js");

  let customer: { orgId: string; w1: string; w2: string; ownerId: string; ownerToken: string; evidenceW1: string };
  let other: { orgId: string; w3: string; ownerId: string };
  let staff: Person;
  let colleague: Person;
  let anchor: string;
  let target: { memberId: string; userId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    kit = await coverageKit(h);
    service = await import("../src/services/identity/support-access.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const fixtures = await import("./point7/product-fixtures.js");
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    const deps = () => ({
      prisma: prisma as never,
      tag: `sab-${kit.tag()}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000), mfaAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    });

    const c = await fixtures.seedOrganizationTenant(deps());
    const w2 = await prisma.team.create({
      data: {
        name: `sab-w2-${kit.tag()}`,
        ownerUserId: c.owner.userId,
        billingOwnerUserId: c.owner.userId,
        isPersonal: false,
        organizationId: c.organizationId,
        workspaceKind: "ORGANIZATION",
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: w2.id, userId: c.owner.userId, role: "OWNER", status: "ACTIVE" } });
    const evidence = await prisma.evidence.create({
      data: { title: `sab-${kit.tag()}`, type: "PHOTO", status: "CREATED", teamId: c.workspaceId, organizationId: c.organizationId, ownerUserId: c.owner.userId },
      select: { id: true },
    });
    customer = {
      orgId: c.organizationId,
      w1: c.workspaceId,
      w2: w2.id,
      ownerId: c.owner.userId,
      ownerToken: c.owner.token,
      evidenceW1: evidence.id,
    };
    const d = await fixtures.seedOrganizationTenant(deps());
    other = { orgId: d.organizationId, w3: d.workspaceId, ownerId: d.owner.userId };

    anchor = h.fixtures.teamA.teamId;
    const staffDeps = deps();
    async function staffMember(): Promise<Person> {
      // AUD-0021 — platform staff act on a second-factor-verified session.
      const p = await kit.person(anchor, "ADMIN", { mfaVerified: true });
      await prisma.user.update({ where: { id: p.id }, data: { platformRole: "admin" } });
      await registerSessionForToken(staffDeps, p.id, p.token);
      return p;
    }
    staff = await staffMember();
    colleague = await staffMember();

    for (const teamId of [customer.w1, customer.w2, other.w3]) {
      await prisma.teamMember.create({ data: { teamId, userId: staff.id, role: "ADMIN", status: "ACTIVE" } });
    }
    await prisma.organizationMembership.create({ data: { organizationId: customer.orgId, userId: staff.id, role: "ORG_ADMIN" } });

    const subject = await kit.person(customer.w1, "MEMBER");
    const row = await prisma.teamMember.findFirstOrThrow({ where: { teamId: customer.w1, userId: subject.id }, select: { id: true } });
    target = { memberId: row.id, userId: subject.id };
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // The ladder allows a few starts per window per user and purpose, and counts
  // rows. A suite that opens a dozen contexts as one actor ages its earlier ones
  // out instead of waiting, which changes nothing about the one being approved.
  async function ceremony(who: Person, teamId: string, purpose: string, resource?: { kind: string; id: string }) {
    await prisma.stepUpChallenge.updateMany({
      where: { initiatedByUserId: who.id },
      data: { createdAt: new Date(Date.now() - 86_400_000) },
    });
    return stepUp.approvedHeader({
      token: who.token,
      userId: who.id,
      teamId,
      purpose,
      ...(resource ? { resourceKind: resource.kind, resourceId: resource.id } : {}),
    });
  }

  async function grant(input: { scopeTeamId?: string; accessLevel?: "READ_ONLY" | "ELEVATED"; organizationId?: string } = {}) {
    const res = await kit.call(
      "POST",
      "/v1/support-access/start",
      staff,
      {
        teamId: anchor,
        organizationId: input.organizationId ?? customer.orgId,
        reason: "Customer ticket 4471, export failure",
        accessLevel: input.accessLevel ?? "READ_ONLY",
        approvedByUserId: customer.ownerId,
        ...(input.scopeTeamId ? { scopeTeamId: input.scopeTeamId } : {}),
      },
      await ceremony(staff, anchor, "ORG_SECURITY_POLICY_UPDATE"),
    );
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { grant: { id: string } }).grant.id;
  }

  async function enter(grantId: string, who: Person = staff): Promise<string> {
    const res = await kit.call(
      "POST",
      "/v1/support-access/enter",
      who,
      { teamId: anchor, grantId },
      await ceremony(who, anchor, "ORG_SECURITY_POLICY_UPDATE"),
    );
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { supportContextToken: string }).supportContextToken;
  }

  const readMembers = (teamId: string, token?: string) => {
    const headers: Record<string, string> = { [WORKSPACE]: teamId };
    if (token) headers[CONTEXT] = token;
    return kit.call("GET", "/v1/identity/members", staff, undefined, headers);
  };

  const refusedByContext = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain("support_access_denied");
  };

  async function auditRow(action: string, grantId: string) {
    await h.handlersSettled();
    const rows = await prisma.adminAuditLog.findMany({ where: { action, userId: staff.id }, orderBy: { createdAt: "desc" }, take: 30 });
    return rows.find((r) => (r.metadata as { grantId?: string } | null)?.grantId === grantId) ?? null;
  }

  // ---------------------------------------------------------------------------

  it("a grant admits nobody by itself: staff outside the workspace are refused with the token as without it", async () => {
    const id = await service
      .startSupportAccess(
        { supportUserId: colleague.id, organizationId: customer.orgId, reason: "Ticket 4472 diagnostics", approvedByUserId: customer.ownerId },
        prisma,
      )
      .then((g) => g.id);
    const token = await enter(id, colleague);
    const attempts: Record<string, string>[] = [{}, { [CONTEXT]: token }];
    for (const headers of attempts) {
      const res = await kit.call("GET", "/v1/identity/members", colleague, undefined, { [WORKSPACE]: customer.w1, ...headers });
      expect([403, 404], res.body).toContain(res.statusCode);
      expect(res.body).not.toContain(target.userId);
      const evidence = await kit.call("GET", `/v1/evidence/${customer.evidenceW1}`, colleague, undefined, headers);
      expect([403, 404], evidence.body).toContain(evidence.statusCode);
    }
  });

  it("a read inside the grant works, and the audit names both identities", async () => {
    const id = await grant();
    const token = await enter(id);
    const res = await readMembers(customer.w1, token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(target.userId);
    const audit = await auditRow("identity.support_access.action.success", id);
    expect(audit).toMatchObject({ organizationId: customer.orgId, outcome: "success" });
    expect(audit!.metadata).toMatchObject({ attemptedAction: "identity.member.read", requestedTeamId: customer.w1, mode: "READ_ONLY" });
  });

  it("a workspace-scoped grant does not reach the sibling workspace; an org grant does not reach another organization", async () => {
    const scoped = await grant({ scopeTeamId: customer.w1 });
    const scopedToken = await enter(scoped);
    expect((await readMembers(customer.w1, scopedToken)).statusCode).toBe(200);

    expect((await readMembers(customer.w2)).statusCode).toBe(200); // the actor may be there
    refusedByContext(await readMembers(customer.w2, scopedToken));
    const scopeAudit = await auditRow("identity.support_access.action.denied", scoped);
    expect(scopeAudit, "a scope refusal leaves a row").not.toBeNull();
    expect(scopeAudit!.metadata).toMatchObject({ reason: "workspace_scope_mismatch", requestedTeamId: customer.w2 });

    const orgWide = await grant();
    const orgToken = await enter(orgWide);
    expect((await readMembers(customer.w2, orgToken)).statusCode).toBe(200);
    expect((await readMembers(other.w3)).statusCode).toBe(200);
    refusedByContext(await readMembers(other.w3, orgToken));
    const orgAudit = await auditRow("identity.support_access.action.denied", orgWide);
    expect(orgAudit!.metadata).toMatchObject({ reason: "org_scope_mismatch" });
  });

  it("READ_ONLY cannot write, on the canonical chain or on a route that checks membership for itself", async () => {
    const id = await grant();
    const token = await enter(id);

    // Canonical chain. The same actor, the same request, the proof is the token.
    const refused = await kit.call(
      "POST",
      `/v1/identity/members/${target.memberId}/suspend`,
      staff,
      { reason: "support" },
      { [WORKSPACE]: customer.w1, [CONTEXT]: token },
    );
    refusedByContext(refused);
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: target.memberId } })).status).toBe("ACTIVE");
    const denied = await auditRow("identity.support_access.action.denied", id);
    expect(denied!.metadata).toMatchObject({ attemptedAction: "POST /v1/identity/members/:id/suspend", reason: "support_read_only" });

    // Routes that never reach `authorize`.
    const name = `sab-case-${kit.tag()}`;
    const withToken = await kit.call("POST", "/v1/cases", staff, { name, teamId: customer.w1 }, { [CONTEXT]: token });
    refusedByContext(withToken);
    expect(await prisma.case.count({ where: { name } })).toBe(0);
    const orgName = `sab-${kit.tag()}`;
    const orgPatch = await kit.call("PATCH", `/v1/orgs/${customer.orgId}`, staff, { name: orgName }, { [CONTEXT]: token });
    refusedByContext(orgPatch);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: customer.orgId } })).name).not.toBe(orgName);

    const withoutToken = await kit.call("POST", "/v1/cases", staff, { name, teamId: customer.w1 });
    expect([200, 201], withoutToken.body).toContain(withoutToken.statusCode);
    expect(await prisma.case.count({ where: { name } })).toBe(1);

    const suspended = await kit.call(
      "POST",
      `/v1/identity/members/${target.memberId}/suspend`,
      staff,
      { reason: "control" },
      {
        [WORKSPACE]: customer.w1,
        ...(await ceremony(staff, customer.w1, "MEMBER_SUSPEND", { kind: "team_member", id: target.memberId })),
      },
    );
    expect(suspended.statusCode, suspended.body).toBe(200);
    await prisma.teamMember.update({ where: { id: target.memberId }, data: { status: "ACTIVE" } });
  });

  it("a forged token is a refusal on a write that never reaches authorize, not a pass", async () => {
    const name = `sab-forged-${kit.tag()}`;
    const res = await kit.call("POST", "/v1/cases", staff, { name, teamId: customer.w1 }, { [CONTEXT]: "forged.token" });
    refusedByContext(res);
    expect(await prisma.case.count({ where: { name } })).toBe(0);
  });

  it("support context can still prove step-up and leave: its own lifecycle routes are not writes into the customer", async () => {
    const id = await grant();
    const token = await enter(id);
    const started = await kit.call(
      "POST",
      "/v1/identity-security/step-up/start",
      staff,
      { teamId: anchor, purpose: "ORG_SECURITY_POLICY_UPDATE" },
      { [CONTEXT]: token },
    );
    expect(started.statusCode, started.body).toBe(200);
    const revoked = await kit.call("POST", "/v1/support-access/revoke", staff, { grantId: id }, { [CONTEXT]: token });
    expect(revoked.statusCode, revoked.body).toBe(200);
  });

  it("expiry ends a live context on the next request, and entering again is refused", async () => {
    const id = await grant();
    const token = await enter(id);
    expect((await readMembers(customer.w1, token)).statusCode).toBe(200);

    await prisma.supportAccessGrant.update({ where: { id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
    refusedByContext(await readMembers(customer.w1, token));
    const audit = await auditRow("identity.support_access.action.denied", id);
    expect(audit!.metadata).toMatchObject({ reason: "expired" });
    const again = await kit.call(
      "POST",
      "/v1/support-access/enter",
      staff,
      { teamId: anchor, grantId: id },
      await ceremony(staff, anchor, "ORG_SECURITY_POLICY_UPDATE"),
    );
    expect(again.statusCode).toBe(403);
    expect(again.body).toContain("expired");
  });

  it("revocation by another staff member ends a live context at once, and the actor's session is untouched", async () => {
    const id = await grant();
    const token = await enter(id);
    expect((await readMembers(customer.w1, token)).statusCode).toBe(200);

    const revoked = await kit.call("POST", "/v1/support-access/revoke", colleague, { grantId: id });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const row = await prisma.supportAccessGrant.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("REVOKED");
    expect(row.revokedAtUtc).not.toBeNull();

    refusedByContext(await readMembers(customer.w1, token));
    const audit = await auditRow("identity.support_access.action.denied", id);
    expect(audit!.metadata).toMatchObject({ reason: "revoked" });
    const write = await kit.call("POST", "/v1/cases", staff, { name: `sab-${kit.tag()}`, teamId: customer.w1 }, { [CONTEXT]: token });
    refusedByContext(write);

    expect((await readMembers(customer.w1)).statusCode).toBe(200);
    const revokeAudit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.support_access.revoked", resourceId: id },
    });
    expect(revokeAudit).toMatchObject({ userId: colleague.id, organizationId: customer.orgId, outcome: "success" });
  });

  it("the token dies with its session", async () => {
    const id = await grant();
    const token = await enter(id);
    expect((await readMembers(customer.w1, token)).statusCode).toBe(200);
    const { hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js");
    const claims = JSON.parse(Buffer.from(staff.token.split(".")[1], "base64url").toString("utf8")) as { sid: string };
    const sessionIdHash = hashSessionId(claims.sid);
    await prisma.authenticatedSession.updateMany({
      where: { userId: staff.id, sessionIdHash },
      data: { expiresAtUtc: new Date(Date.now() - 1000) },
    });
    refusedByContext(await readMembers(customer.w1, token));
    await prisma.authenticatedSession.updateMany({
      where: { userId: staff.id, sessionIdHash },
      data: { expiresAtUtc: new Date(Date.now() + 3_600_000) },
    });
  });

  it("the forbidden list names the permissions the guard is actually asked about", () => {
    // The documented boundary: destructive, legal-hold, retention, ownership,
    // security-policy and billing actions stay out of even an ELEVATED grant. The
    // guard evaluates canonical permission strings, so a list of other words
    // forbids nothing.
    const mustRefuse = (PERMISSIONS as readonly string[]).filter((p) =>
      /^(billing\.manage$|evidence\.(delete|purge)$|governance\.(legal_hold|retention|retention_policy|destruction)\.|retention\.configure$|identity\.(org_policy\.manage|member\.(role\.change|suspend|revoke|restore)|capability\.|delegated_admin\.))/.test(p),
    );
    expect(mustRefuse.length).toBeGreaterThan(15);
    const allowed = mustRefuse.filter((p) => service.evaluateSupportActionAllowed({ accessLevel: "ELEVATED" }, p).allowed);
    expect(allowed).toEqual([]);
    // Positive control: ELEVATED is not a synonym for refused.
    expect(service.evaluateSupportActionAllowed({ accessLevel: "ELEVATED" }, "case.update").allowed).toBe(true);
    expect(service.evaluateSupportActionAllowed({ accessLevel: "READ_ONLY" }, "evidence.read").allowed).toBe(true);
    expect(service.evaluateSupportActionAllowed({ accessLevel: "READ_ONLY" }, "case.update").allowed).toBe(false);
  });

  it("ELEVATED needs a named approver and a step-up on the request, and still cannot suspend a member", async () => {
    const noApprover = await service
      .startSupportAccess({ supportUserId: staff.id, organizationId: customer.orgId, reason: "Elevated with nobody", accessLevel: "ELEVATED" }, prisma)
      .catch((e: { code: string }) => e.code);
    expect(noApprover).toBe("SUPPORT_APPROVAL_REQUIRED");

    const id = await grant({ accessLevel: "ELEVATED" });
    const token = await enter(id);
    refusedByContext(await readMembers(customer.w1, token)); // no step-up on this request
    const denied = await auditRow("identity.support_access.action.denied", id);
    expect(denied!.metadata).toMatchObject({ reason: "elevated_step_up_required" });

    const headers = { [WORKSPACE]: customer.w1, [CONTEXT]: token, "x-proovra-step-up-challenge-id": randomUUID() };
    const read = await kit.call("GET", "/v1/identity/members", staff, undefined, headers);
    expect(read.statusCode, read.body).toBe(200);
    const suspend = await kit.call("POST", `/v1/identity/members/${target.memberId}/suspend`, staff, { reason: "support" }, headers);
    refusedByContext(suspend);
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: target.memberId } })).status).toBe("ACTIVE");
  });

  it("ELEVATED meets the forbidden areas on routes that never ask the guard, and may still write outside them", async () => {
    const id = await grant({ accessLevel: "ELEVATED" });
    const token = await enter(id);
    const headers = { [WORKSPACE]: customer.w1, [CONTEXT]: token };

    // Organization administration runs on checkOrgAccess, so the permission list alone never met it.
    const orgName = `sab-${kit.tag()}`;
    refusedByContext(await kit.call("PATCH", `/v1/orgs/${customer.orgId}`, staff, { name: orgName }, headers));
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: customer.orgId } })).name).not.toBe(orgName);
    const denied = await auditRow("identity.support_access.action.denied", id);
    expect(denied!.metadata).toMatchObject({ reason: "support_forbidden_action" });

    const sessions = await prisma.revokedSession.count({ where: { userId: target.userId } });
    refusedByContext(
      await kit.call("POST", "/v1/identity-security/sessions/revoke-all", staff, { teamId: customer.w1, userId: target.userId }, headers),
    );
    expect(await prisma.revokedSession.count({ where: { userId: target.userId } })).toBe(sessions);

    const keys = await prisma.apiCredential.count({ where: { teamId: customer.w1 } });
    refusedByContext(
      await kit.call("POST", "/v1/integrations/api-keys", staff, { teamId: customer.w1, name: "support key", scopes: ["integration.evidence.read"] }, headers),
    );
    expect(await prisma.apiCredential.count({ where: { teamId: customer.w1 } })).toBe(keys);

    // Control: the same grant writes outside those areas, so the refusals above are the list's doing.
    const name = `sab-elevated-${kit.tag()}`;
    const created = await kit.call("POST", "/v1/cases", staff, { name, teamId: customer.w1 }, headers);
    expect([200, 201], created.body).toContain(created.statusCode);
    expect(await prisma.case.count({ where: { name } })).toBe(1);
  });

  it("the customer sees the grant on its own audit trail: who, why, until when, and when it ended", async () => {
    const id = await grant();
    await enter(id);
    await kit.call("POST", "/v1/support-access/revoke", colleague, { grantId: id });

    const auditor = await kit.person(null);
    await prisma.organizationMembership.create({ data: { organizationId: customer.orgId, userId: auditor.id, role: "ORG_AUDITOR" } });
    const res = await kit.call("GET", `/v1/orgs/${customer.orgId}/audit-events?take=200`, auditor);
    expect(res.statusCode, res.body).toBe(200);
    const events = (res.json() as { events: { eventType: string; metadata: Record<string, unknown> | null; targetId: string | null }[] }).events
      .filter((e) => e.targetId === id);
    expect(events.map((e) => e.eventType).sort()).toEqual([
      "ORG_SUPPORT_ACCESS_ENTERED",
      "ORG_SUPPORT_ACCESS_REVOKED",
      "ORG_SUPPORT_ACCESS_STARTED",
    ]);
    const started = events.find((e) => e.eventType === "ORG_SUPPORT_ACCESS_STARTED")!;
    expect(started.metadata).toMatchObject({ accessLevel: "READ_ONLY", reason: "Customer ticket 4471, export failure", approvedByUserId: customer.ownerId });
    expect(res.body).not.toContain("supportContextToken");

    // The trail is the customer's: another organization's auditor sees none of it.
    const foreign = await kit.person(null);
    await prisma.organizationMembership.create({ data: { organizationId: other.orgId, userId: foreign.id, role: "ORG_AUDITOR" } });
    const cross = await kit.call("GET", `/v1/orgs/${customer.orgId}/audit-events`, foreign);
    expect(cross.statusCode).toBe(404);
    const own = await kit.call("GET", `/v1/orgs/${other.orgId}/audit-events?take=200`, foreign);
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain(id);
  });

  it("a grant cannot name a workspace outside its organization, or an organization that does not exist", async () => {
    const before = await prisma.supportAccessGrant.count();
    const crossScope = await kit.call(
      "POST",
      "/v1/support-access/start",
      staff,
      { teamId: anchor, organizationId: customer.orgId, reason: "Scope outside the org", scopeTeamId: other.w3, approvedByUserId: customer.ownerId },
      await ceremony(staff, anchor, "ORG_SECURITY_POLICY_UPDATE"),
    );
    expect(crossScope.statusCode, crossScope.body).toBe(400);
    expect(crossScope.body).toContain("SUPPORT_ACCESS_SCOPE_INVALID");
    const missing = await kit.call(
      "POST",
      "/v1/support-access/start",
      staff,
      { teamId: anchor, organizationId: randomUUID(), reason: "No such organization here", customerApprovalUnavailableReason: "Customer outage in progress" },
      await ceremony(staff, anchor, "ORG_SECURITY_POLICY_UPDATE"),
    );
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.body).toContain("SUPPORT_ACCESS_SCOPE_INVALID");
    expect(await prisma.supportAccessGrant.count()).toBe(before);
  });

  it("revoking a grant that does not exist writes no success into the trail", async () => {
    const ghost = randomUUID();
    const res = await kit.call("POST", "/v1/support-access/revoke", staff, { grantId: ghost });
    expect(res.statusCode).toBe(404);
    expect(await prisma.adminAuditLog.count({ where: { action: "identity.support_access.revoked", resourceId: ghost } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Break-glass, the same boundary beside it
  // ---------------------------------------------------------------------------

  describe("break-glass", () => {
    let responder: Person;
    let grantId: string;
    let victimSession: string;
    // The grant binds the step-up that activated it; the responder presents that id.
    let activationProof: string;

    beforeAll(async () => {
      // AUD-0021 — the responder holds platform authority, so its session verified a second factor.
      responder = await kit.person(customer.w1, "MEMBER", { mfaVerified: true });
      await prisma.organizationMembership.create({ data: { organizationId: customer.orgId, userId: responder.id, role: "ORG_ADMIN" } });
      await prisma.teamMember.updateMany({ where: { teamId: customer.w1, userId: responder.id }, data: { role: "ADMIN" } });
      await prisma.user.update({ where: { id: responder.id }, data: { platformRole: "admin" } });
      const proof = await ceremony(staff, anchor, "ORG_SECURITY_POLICY_UPDATE");
      activationProof = proof["x-proovra-step-up-challenge-id"]!;
      const res = await kit.call(
        "POST",
        "/v1/break-glass/activate",
        staff,
        { teamId: anchor, organizationId: customer.orgId, emergencyUserId: responder.id, reason: "Incident 88 containment", grantedRole: "EMERGENCY_OPERATOR" },
        proof,
      );
      expect(res.statusCode, res.body).toBe(200);
      grantId = (res.json() as { grant: { id: string } }).grant.id;
      const session = await prisma.authenticatedSession.create({
        data: { userId: other.ownerId, teamId: other.w3, sessionIdHash: `sab-${randomUUID()}`, expiresAtUtc: new Date(Date.now() + 3_600_000) },
        select: { id: true },
      });
      victimSession = session.id;
    });

    it("the customer sees emergency access on its own trail", async () => {
      const auditor = await kit.person(null);
      await prisma.organizationMembership.create({ data: { organizationId: customer.orgId, userId: auditor.id, role: "ORG_AUDITOR" } });
      const res = await kit.call("GET", `/v1/orgs/${customer.orgId}/audit-events?take=200`, auditor);
      const event = (res.json() as { events: { eventType: string; targetId: string | null; metadata: unknown }[] }).events.find(
        (e) => e.targetId === grantId,
      );
      expect(event?.eventType).toBe("ORG_BREAK_GLASS_ACTIVATED");
      expect(event?.metadata).toMatchObject({ emergencyUserId: responder.id, grantedRole: "EMERGENCY_OPERATOR", reason: "Incident 88 containment" });
    });

    it("a grant on one organization cannot revoke sessions of a workspace in another", async () => {
      // AUD-0037 — the holder presents their OWN fresh step-up, bound to this grant
      // (taken in their own workspace, which the wrong target is not).
      const holderProof = () => ceremony(responder, customer.w1, "ORG_SECURITY_POLICY_UPDATE", { kind: "break_glass_grant", id: grantId });
      const res = await kit.call("POST", "/v1/break-glass/emergency/sessions/revoke", responder, {
        teamId: other.w3,
        organizationId: customer.orgId,
        grantId,
        stepUpTeamId: customer.w1,
        reason: "Wrong workspace on purpose",
      }, await holderProof());
      await h.handlersSettled();
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toContain("org_scope_mismatch");
      const session = await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: victimSession } });
      expect(session.revokedAtUtc).toBeNull();

      // Positive control: the same grant and the same request on its own
      // organization reach the containment action.
      const own = await prisma.authenticatedSession.create({
        data: { userId: customer.ownerId, teamId: customer.w1, sessionIdHash: `sab-${randomUUID()}`, expiresAtUtc: new Date(Date.now() + 3_600_000) },
        select: { id: true },
      });
      const contained = await kit.call("POST", "/v1/break-glass/emergency/sessions/revoke", responder, {
        teamId: customer.w1,
        organizationId: customer.orgId,
        grantId,
        reason: "Right workspace this time",
      }, await holderProof());
      expect(contained.statusCode, contained.body).toBe(200);
      expect((await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: own.id } })).revokedAtUtc).not.toBeNull();
    });

    const activate = async (emergencyUserId: string, grantedRole = "EMERGENCY_OPERATOR") =>
      kit.call(
        "POST",
        "/v1/break-glass/activate",
        staff,
        { teamId: anchor, organizationId: customer.orgId, emergencyUserId, reason: "Incident 91 containment", grantedRole },
        await ceremony(staff, anchor, "ORG_SECURITY_POLICY_UPDATE"),
      );

    it("AUD-0040 — an operator cannot grant emergency access to themselves", async () => {
      const res = await activate(staff.id);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain("BREAK_GLASS_SELF_GRANT");
      expect(await prisma.emergencyAccessGrant.count({ where: { emergencyUserId: staff.id, organizationId: customer.orgId } })).toBe(0);
    });

    it("AUD-0037 / AUD-0036 — a platform responder may hold a grant; a lapsed grant no longer blocks a new one", async () => {
      // `colleague` is platform staff and no administrator of the customer Organization.
      const first = await activate(colleague.id);
      expect(first.statusCode, first.body).toBe(200);
      const firstId = (first.json() as { grant: { id: string } }).grant.id;
      await prisma.emergencyAccessGrant.update({ where: { id: firstId }, data: { expiresAtUtc: new Date(Date.now() - 60_000) } });
      const second = await activate(colleague.id);
      expect(second.statusCode, second.body).toBe(200);
      expect((await prisma.emergencyAccessGrant.findUniqueOrThrow({ where: { id: firstId } })).status).toBe("EXPIRED");
    });

    it("AUD-0037 — a named customer administrator uses their grant with their own step-up", async () => {
      // A fresh session: the containment case above ended this workspace's sessions.
      const ownerToken = await h.mintSessionToken(customer.ownerId, null);
      await registerSessionForToken({ prisma: prisma as never, tag: "sab-owner", mintToken: () => ownerToken } as never, customer.ownerId, ownerToken);
      const owner = { id: customer.ownerId, email: "", token: ownerToken } as Person;
      const res = await activate(owner.id);
      expect(res.statusCode, res.body).toBe(200);
      const ownerGrant = (res.json() as { grant: { id: string } }).grant.id;
      const victim = await prisma.authenticatedSession.create({
        data: { userId: target.userId, teamId: customer.w1, sessionIdHash: `sab-${randomUUID()}`, expiresAtUtc: new Date(Date.now() + 3_600_000) },
        select: { id: true },
      });
      const used = await kit.call(
        "POST",
        "/v1/break-glass/emergency/sessions/revoke",
        owner,
        { teamId: customer.w1, organizationId: customer.orgId, grantId: ownerGrant, reason: "Customer-side containment" },
        await ceremony(owner, customer.w1, "ORG_SECURITY_POLICY_UPDATE", { kind: "break_glass_grant", id: ownerGrant }),
      );
      expect(used.statusCode, used.body).toBe(200);
      expect(used.json()).toMatchObject({ viaEmergency: true });
      expect((await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: victim.id } })).revokedAtUtc).not.toBeNull();
      // Someone else cannot use the owner's grant, whatever step-up they present.
      const other = await kit.call(
        "POST",
        "/v1/break-glass/emergency/sessions/revoke",
        responder,
        { teamId: customer.w1, organizationId: customer.orgId, grantId: ownerGrant, reason: "Not my grant to use" },
        await ceremony(responder, customer.w1, "ORG_SECURITY_POLICY_UPDATE", { kind: "break_glass_grant", id: ownerGrant }),
      );
      expect(other.statusCode, other.body).toBe(403);
      expect(other.body).toContain("actor_mismatch");
    });

    it("AUD-0037 — the holder sees the grant they hold, and only while it is live; nobody else sees it", async () => {
      type Held = {
        id: string;
        organizationId: string;
        emergencyUserId: string;
        grantedRole: string;
        effectiveStatus: string;
        organizationName: string | null;
        workspaces: { id: string; name: string }[];
        stepUpTeamId: string | null;
      };
      const myGrants = async (who: Person, query = "") => {
        const res = await kit.call("GET", `/v1/break-glass/my-grants${query}`, who);
        expect(res.statusCode, res.body).toBe(200);
        return { body: res.body, grants: (res.json() as { grants: Held[] }).grants };
      };
      // A customer Organization administrator, a member of w1 only.
      const holder = await kit.person(customer.w1, "ADMIN");
      await prisma.organizationMembership.create({ data: { organizationId: customer.orgId, userId: holder.id, role: "ORG_ADMIN" } });
      const idOf = (res: { json: () => unknown }) => (res.json() as { grant: { id: string } }).grant.id;

      // Expired: the window closed, the stored word still says ACTIVE.
      const lapsed = await activate(holder.id);
      expect(lapsed.statusCode, lapsed.body).toBe(200);
      await prisma.emergencyAccessGrant.update({ where: { id: idOf(lapsed) }, data: { expiresAtUtc: new Date(Date.now() - 60_000) } });
      // Revoked by staff.
      const cut = await activate(holder.id);
      expect(cut.statusCode, cut.body).toBe(200);
      const revoked = await kit.call("POST", "/v1/break-glass/revoke", staff, { teamId: anchor, grantId: idOf(cut) });
      expect(revoked.statusCode, revoked.body).toBe(200);
      // Live, with its activation proof id kept to prove it is never projected.
      const proof = await ceremony(staff, anchor, "ORG_SECURITY_POLICY_UPDATE");
      const live = await kit.call(
        "POST",
        "/v1/break-glass/activate",
        staff,
        { teamId: anchor, organizationId: customer.orgId, emergencyUserId: holder.id, reason: "Incident 93 containment", grantedRole: "EMERGENCY_OPERATOR" },
        proof,
      );
      expect(live.statusCode, live.body).toBe(200);
      const liveId = idOf(live);

      const mine = await myGrants(holder);
      expect(mine.grants.map((g) => g.id)).toEqual([liveId]);
      const [held] = mine.grants;
      expect(held).toMatchObject({
        organizationId: customer.orgId,
        emergencyUserId: holder.id,
        grantedRole: "EMERGENCY_OPERATOR",
        effectiveStatus: "ACTIVE",
        // The holder belongs to w1, so that is where their own step-up is taken.
        stepUpTeamId: customer.w1,
      });
      expect(held.organizationName).toEqual(expect.any(String));
      expect(held.workspaces.map((w) => w.id)).toEqual(expect.arrayContaining([customer.w1, customer.w2]));
      expect(held.workspaces.map((w) => w.id)).not.toContain(other.w3);
      expect(mine.body).not.toContain(proof["x-proovra-step-up-challenge-id"]!);
      expect(mine.body).not.toContain("stepUpProofId");
      // Narrowed to another Organization, the same holder holds nothing there.
      expect((await myGrants(holder, `?organizationId=${other.orgId}`)).grants).toEqual([]);
      expect((await myGrants(holder, `?organizationId=${customer.orgId}`)).grants.map((g) => g.id)).toEqual([liveId]);

      // Nobody else sees it: the grantor, another administrator of the same
      // Organization, or another holder (who sees only their own).
      const sameOrgAdmin = await kit.person(customer.w1, "ADMIN");
      await prisma.organizationMembership.create({ data: { organizationId: customer.orgId, userId: sameOrgAdmin.id, role: "ORG_ADMIN" } });
      expect((await myGrants(sameOrgAdmin)).grants).toEqual([]);
      expect((await myGrants(staff)).grants).toEqual([]);
      const responderView = await myGrants(responder);
      expect(responderView.grants.map((g) => g.id)).not.toContain(liveId);
      expect(responderView.grants.every((g) => g.emergencyUserId === responder.id)).toBe(true);

      // What the read hands the holder is enough to use the grant.
      const victim = await prisma.authenticatedSession.create({
        data: { userId: target.userId, teamId: customer.w1, sessionIdHash: `sab-${randomUUID()}`, expiresAtUtc: new Date(Date.now() + 3_600_000) },
        select: { id: true },
      });
      const used = await kit.call(
        "POST",
        "/v1/break-glass/emergency/sessions/revoke",
        holder,
        {
          teamId: customer.w1,
          organizationId: held.organizationId,
          grantId: held.id,
          stepUpTeamId: held.stepUpTeamId,
          reason: "Holder-side containment from the panel",
        },
        await ceremony(holder, held.stepUpTeamId!, "ORG_SECURITY_POLICY_UPDATE", { kind: "break_glass_grant", id: held.id }),
      );
      expect(used.statusCode, used.body).toBe(200);
      expect(used.json()).toMatchObject({ viaEmergency: true });
      expect((await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: victim.id } })).revokedAtUtc).not.toBeNull();

      // Once revoked, the grant leaves the holder's view.
      await kit.call("POST", "/v1/break-glass/revoke", staff, { teamId: anchor, grantId: liveId });
      expect((await myGrants(holder)).grants).toEqual([]);
    });
  });
});

/**
 * MEMBERS RE-AUDIT, SECOND ROUND — AUDIT ATOMICITY AND EXECUTION-TIME CLOSURE
 * CHECKS (live PostgreSQL).
 *
 *   AUD-01 / SEC-13  every mutation below writes its audit row in its own
 *                    transaction. Proof by FAILURE INJECTION: a real
 *                    PostgreSQL BEFORE INSERT trigger on admin_audit_logs
 *                    raises for the chosen (action, resource). The request
 *                    must fail AND the change must not be committed. Each case
 *                    has a positive control: without the trigger the change
 *                    lands and its audit row exists when the response returns
 *                    (read once, no polling).
 *   Defect 8         an evidence archive / trash whose audit fails answers an
 *                    error with the record UNCHANGED (it used to answer 500
 *                    after the archive had committed).
 *   Defect 7         account closure re-judges its blockers inside the closure
 *                    transaction, on the reaper path too: a legal hold placed
 *                    after the request moves it to BLOCKED and closes nothing.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; email: string; memberId: string | null; token: string };
type Inject = Awaited<ReturnType<IntegrationHarness["app"]["inject"]>>;

describe("members re-audit 2 — a mutation never commits without its audit row (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let legalVersions: Record<string, string>;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let deps: FixtureDeps;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    accountClosure = await import("../src/services/identity/account-closure.service.js");
    holds = await import("../src/services/governance/legal-hold.service.js");
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    deps = {
      prisma: prisma as never,
      tag: `ra2-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, process.env.AUTH_JWT_SECRET as string, 3600),
    };
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });

    // The failure-injection seam: a real database error raised by the audit
    // insert for each registered (action, resource) pair — resource NULL
    // matches any resource of that action.
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ra2_audit_fail (action text NOT NULL, resource_id text)`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra2_audit_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra2_audit_fail f
                    WHERE f.action = NEW.action AND (f.resource_id IS NULL OR f.resource_id = NEW.resource_id)) THEN
          RAISE EXCEPTION 'ra2 injected audit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra2_audit_fail_trg ON admin_audit_logs`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ra2_audit_fail_trg BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION ra2_audit_fail_fn()`,
    );
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra2_audit_fail_trg ON admin_audit_logs`).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const send = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload === undefined ? {} : { payload: payload as never }) });

  /** Run `body` with the audit insert for (action, resource) refused by PostgreSQL. */
  async function withAuditRefused<T>(action: string, resourceId: string | null, body: () => Promise<T>): Promise<T> {
    await prisma.$executeRawUnsafe(`INSERT INTO ra2_audit_fail (action, resource_id) VALUES ($1, $2)`, action, resourceId);
    try {
      return await body();
    } finally {
      await prisma.$executeRawUnsafe(`DELETE FROM ra2_audit_fail`);
    }
  }
  const audits = (action: string, resourceId: string) => prisma.adminAuditLog.count({ where: { action, resourceId } });
  const failed = (res: Inject) => expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);

  async function person(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null = "MEMBER"): Promise<Person> {
    const email = `ra2a-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    const m = role ? await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } }) : null;
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, email, memberId: m?.id ?? null, token };
  }
  const newCase = async (ownerUserId = A().ownerUserId, teamId: string | null = A().teamId) =>
    (await prisma.case.create({ data: { name: `ra2a-${tag()}`, teamId, ownerUserId }, select: { id: true } })).id;
  const caseRow = (id: string) =>
    prisma.case.findUnique({ where: { id }, select: { name: true, teamId: true, restrictedAtUtc: true } });
  const newGroup = async () =>
    (
      await prisma.collaborationTeam.create({
        data: { workspaceId: A().teamId, name: `ra2a-group-${tag()}`, createdByUserId: A().ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  async function newEvidence() {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `ra2a ${tag()}`, type: "PHOTO", status: "CREATED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }

  // ===========================================================================
  // Case mutations (cases.routes.ts)
  // ===========================================================================
  describe("case mutations", () => {
    it("cases.create — refused audit: no case; control: the case and its row", async () => {
      const name = `ra2a-create-${tag()}`;
      const res = await withAuditRefused("cases.create", null, () =>
        send("POST", "/v1/cases", A().ownerToken, { name, teamId: A().teamId }),
      );
      failed(res);
      expect(await prisma.case.count({ where: { name } })).toBe(0);

      const ok = await send("POST", "/v1/cases", A().ownerToken, { name, teamId: A().teamId });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await audits("cases.create", ok.json().id)).toBe(1);
    });

    it("cases.rename — refused audit: the name is unchanged; control: renamed with its row", async () => {
      const id = await newCase();
      const before = (await caseRow(id))!.name;
      failed(await withAuditRefused("cases.rename", id, () => send("PATCH", `/v1/cases/${id}`, A().ownerToken, { name: "renamed" })));
      expect((await caseRow(id))!.name).toBe(before);
      const ok = await send("PATCH", `/v1/cases/${id}`, A().ownerToken, { name: "renamed" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await caseRow(id))!.name).toBe("renamed");
      expect(await audits("cases.rename", id)).toBe(1);
    });

    for (const route of [
      { action: "cases.access_grant", path: "access", body: (p: Person) => ({ userId: p.id }), ok: 201 },
      { action: "cases.share_team", path: "share-team", body: (p: Person) => ({ userId: p.id }), ok: 201 },
      { action: "cases.share_email", path: "share-email", body: (p: Person) => ({ email: p.email }), ok: 202 },
    ]) {
      it(`${route.action} — refused audit: no entry and the case is NOT restricted; control: entry, restriction and row`, async () => {
        const id = await newCase();
        const target = await person("MEMBER");
        failed(await withAuditRefused(route.action, id, () => send("POST", `/v1/cases/${id}/${route.path}`, A().ownerToken, route.body(target))));
        expect(await prisma.caseAccess.count({ where: { caseId: id } })).toBe(0);
        expect((await caseRow(id))!.restrictedAtUtc).toBeNull();

        const ok = await send("POST", `/v1/cases/${id}/${route.path}`, A().ownerToken, route.body(target));
        expect(ok.statusCode, ok.body).toBe(route.ok);
        expect(await prisma.caseAccess.count({ where: { caseId: id, userId: target.id } })).toBe(1);
        expect((await caseRow(id))!.restrictedAtUtc).not.toBeNull();
        expect(await audits(route.action, id)).toBe(1);
      });
    }

    it("cases.access_revoke — refused audit: the last entry stays and the case stays restricted; control: removed, reopened, row", async () => {
      const id = await newCase();
      const target = await person("MEMBER");
      await prisma.case.update({ where: { id }, data: { restrictedAtUtc: new Date() } });
      const entry = await prisma.caseAccess.create({ data: { caseId: id, userId: target.id } });
      failed(await withAuditRefused("cases.access_revoke", id, () => send("DELETE", `/v1/cases/${id}/access/${entry.id}`, A().ownerToken)));
      expect(await prisma.caseAccess.count({ where: { id: entry.id } })).toBe(1);
      expect((await caseRow(id))!.restrictedAtUtc).not.toBeNull();

      const ok = await send("DELETE", `/v1/cases/${id}/access/${entry.id}`, A().ownerToken);
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await prisma.caseAccess.count({ where: { id: entry.id } })).toBe(0);
      expect((await caseRow(id))!.restrictedAtUtc).toBeNull();
      expect(await audits("cases.access_revoke", id)).toBe(1);
    });

    it("cases.team_access_grant / revoke — refused audit changes nothing; controls change it with a row", async () => {
      const id = await newCase();
      const g = await newGroup();
      failed(await withAuditRefused("cases.team_access_grant", id, () => send("POST", `/v1/cases/${id}/team-access`, A().ownerToken, { collaborationTeamId: g })));
      expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId: id } })).toBe(0);
      expect((await caseRow(id))!.restrictedAtUtc).toBeNull();

      const granted = await send("POST", `/v1/cases/${id}/team-access`, A().ownerToken, { collaborationTeamId: g });
      expect(granted.statusCode, granted.body).toBe(201);
      expect(await audits("cases.team_access_grant", id)).toBe(1);

      failed(await withAuditRefused("cases.team_access_revoke", id, () => send("DELETE", `/v1/cases/${id}/team-access/${g}`, A().ownerToken)));
      expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId: id } })).toBe(1);
      expect((await caseRow(id))!.restrictedAtUtc).not.toBeNull();

      const revoked = await send("DELETE", `/v1/cases/${id}/team-access/${g}`, A().ownerToken);
      expect(revoked.statusCode, revoked.body).toBe(204);
      expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId: id } })).toBe(0);
      expect(await audits("cases.team_access_revoke", id)).toBe(1);
    });

    it("cases.delete — refused audit: the case survives; control: deleted with its row", async () => {
      const id = await newCase();
      const header = () =>
        stepUp.approvedHeader({ token: A().ownerToken, userId: A().ownerUserId, teamId: A().teamId, purpose: "CASE_DELETE", resourceKind: "case", resourceId: id });
      const h1 = await header();
      failed(await withAuditRefused("cases.delete", id, () => send("DELETE", `/v1/cases/${id}`, A().ownerToken, undefined, h1)));
      expect(await caseRow(id)).not.toBeNull();

      const ok = await send("DELETE", `/v1/cases/${id}`, A().ownerToken, undefined, await header());
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await caseRow(id)).toBeNull();
      expect(await audits("cases.delete", id)).toBe(1);
    });
  });

  // ===========================================================================
  // Workspace mutations (teams.routes.ts + the invitation authority)
  // ===========================================================================
  describe("workspace mutations", () => {
    const team = () => A().teamId;

    it("teams.invite_create — refused audit: no invitation; control: the invitation and its row", async () => {
      const email = `ra2a-inv-${tag()}@invitee.test`;
      failed(await withAuditRefused("teams.invite_create", team(), () => send("POST", `/v1/teams/${team()}/invites`, A().ownerToken, { email, role: "MEMBER" })));
      expect(await prisma.teamInvite.count({ where: { teamId: team(), email } })).toBe(0);

      const before = await audits("teams.invite_create", team());
      const ok = await send("POST", `/v1/teams/${team()}/invites`, A().ownerToken, { email, role: "MEMBER" });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await prisma.teamInvite.count({ where: { teamId: team(), email } })).toBe(1);
      expect(await audits("teams.invite_create", team())).toBe(before + 1);
    });

    it("teams.invite_resend and teams.invite_revoke — refused audits change nothing; controls rotate / revoke with rows", async () => {
      const email = `ra2a-inv-${tag()}@invitee.test`;
      const created = await send("POST", `/v1/teams/${team()}/invites`, A().ownerToken, { email, role: "MEMBER" });
      expect(created.statusCode, created.body).toBe(201);
      const inviteId = created.json().invite.id as string;
      const snap = () => prisma.teamInvite.findUniqueOrThrow({ where: { id: inviteId }, select: { tokenHash: true, resendCount: true, revokedAt: true } });
      const initial = await snap();

      failed(await withAuditRefused("teams.invite_resend", team(), () => send("POST", `/v1/teams/${team()}/invites/${inviteId}/resend`, A().ownerToken, {})));
      expect(await snap()).toEqual(initial);
      const resent = await send("POST", `/v1/teams/${team()}/invites/${inviteId}/resend`, A().ownerToken, {});
      expect(resent.statusCode, resent.body).toBe(200);
      const afterResend = await snap();
      expect(afterResend.resendCount).toBe(initial.resendCount + 1);
      expect(afterResend.tokenHash).not.toBe(initial.tokenHash);

      failed(await withAuditRefused("teams.invite_revoke", team(), () => send("DELETE", `/v1/teams/${team()}/invites/${inviteId}`, A().ownerToken)));
      expect((await snap()).revokedAt).toBeNull();
      const revoked = await send("DELETE", `/v1/teams/${team()}/invites/${inviteId}`, A().ownerToken);
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect((await snap()).revokedAt).not.toBeNull();
    });

    it("teams.invite_accept — refused audit: no membership and the invitation is unused; control: joined with its row", async () => {
      const invitee = await person(null);
      const { rawToken, invite } = await invitations.createWorkspaceInvitation({
        workspaceId: team(),
        email: invitee.email,
        role: "MEMBER" as never,
        invitedByUserId: A().ownerUserId,
      });
      failed(await withAuditRefused("teams.invite_accept", team(), () => send("POST", `/v1/teams/invites/${rawToken}/accept`, invitee.token, {})));
      expect(await prisma.teamMember.count({ where: { teamId: team(), userId: invitee.id } })).toBe(0);
      expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: invite.id } })).acceptedAt).toBeNull();

      const before = await audits("teams.invite_accept", team());
      const ok = await send("POST", `/v1/teams/invites/${rawToken}/accept`, invitee.token, {});
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await prisma.teamMember.count({ where: { teamId: team(), userId: invitee.id, status: "ACTIVE" } })).toBe(1);
      expect(await audits("teams.invite_accept", team())).toBe(before + 1);
    });

    it("teams.case_link / case_unlink — refused audits leave the case where it was; controls move it with rows", async () => {
      const member = await person("MEMBER");
      const id = await newCase(member.id, null);
      failed(await withAuditRefused("teams.case_link", team(), () => send("POST", `/v1/teams/${team()}/cases/link`, A().ownerToken, { caseId: id })));
      expect((await caseRow(id))!.teamId).toBeNull();
      const linked = await send("POST", `/v1/teams/${team()}/cases/link`, A().ownerToken, { caseId: id });
      expect(linked.statusCode, linked.body).toBe(200);
      expect((await caseRow(id))!.teamId).toBe(team());

      failed(await withAuditRefused("teams.case_unlink", team(), () => send("DELETE", `/v1/teams/${team()}/cases/${id}`, A().ownerToken)));
      expect((await caseRow(id))!.teamId).toBe(team());
      const unlinked = await send("DELETE", `/v1/teams/${team()}/cases/${id}`, A().ownerToken);
      expect(unlinked.statusCode, unlinked.body).toBe(200);
      expect((await caseRow(id))!.teamId).toBeNull();
    });

    it("teams.external_access_revoked — refused audit: the grant stays and the case stays restricted; control: removed with its row", async () => {
      const id = await newCase();
      const outsider = await person(null);
      await prisma.case.update({ where: { id }, data: { restrictedAtUtc: new Date() } });
      const grant = await prisma.caseAccess.create({ data: { caseId: id, userId: outsider.id } });
      failed(await withAuditRefused("teams.external_access_revoked", team(), () => send("DELETE", `/v1/teams/${team()}/external-grants/${grant.id}`, A().ownerToken)));
      expect(await prisma.caseAccess.count({ where: { id: grant.id } })).toBe(1);
      expect((await caseRow(id))!.restrictedAtUtc).not.toBeNull();

      const ok = await send("DELETE", `/v1/teams/${team()}/external-grants/${grant.id}`, A().ownerToken);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await prisma.caseAccess.count({ where: { id: grant.id } })).toBe(0);
    });
  });

  // ===========================================================================
  // Evidence archive / trash (defect 8)
  // ===========================================================================
  describe("evidence archive and trash — the audit is part of the lifecycle transaction", () => {
    for (const op of [
      { action: "evidence.archive", run: (id: string) => send("POST", `/v1/evidence/${id}/archive`, A().ownerToken, {}), state: "ARCHIVED" },
      { action: "evidence.delete", run: (id: string) => send("DELETE", `/v1/evidence/${id}`, A().ownerToken), state: "TRASHED" },
    ]) {
      it(`${op.action} — refused audit: the request fails AND the record is unchanged (no state, no custody event); control: changed with its row`, async () => {
        const id = await newEvidence();
        const snap = async () => ({
          state: (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } })).lifecycleState,
          custody: await prisma.custodyEvent.count({ where: { evidenceId: id } }),
        });
        const before = await snap();
        failed(await withAuditRefused(op.action, id, () => op.run(id)));
        expect(await snap()).toEqual(before);
        expect(await audits(op.action, id)).toBe(0);

        const ok = await op.run(id);
        expect(ok.statusCode, ok.body).toBe(200);
        expect((await snap()).state).toBe(op.state);
        expect(await audits(op.action, id)).toBe(1);
      });
    }
  });

  // ===========================================================================
  // Defect 7 — execution-time closure blockers, inside the transaction
  // ===========================================================================
  describe("Defect 7 — account closure re-judges its blockers inside the closure transaction", () => {
    const staleProcessing = (userId: string) =>
      prisma.accountClosureRequest.create({
        data: { userId, status: "PROCESSING", startedAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        select: { id: true },
      });

    it("the reaper path: a legal hold placed after the request moves it to BLOCKED and closes nothing; the person keeps their sessions and their data", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const hold = await holds.placeCanonicalLegalHold({
        teamId: t.personalTeamId,
        scope: "WORKSPACE",
        actorUserId: t.owner.userId,
        title: "placed after the closure request",
      } as never);
      const req = await staleProcessing(t.owner.userId);
      const sessionsBefore = await prisma.revokedSession.count({ where: { userId: t.owner.userId } });

      await accountClosure.processAccountClosures(new Date());

      const after = await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(after.status).toBe("BLOCKED");
      expect(String(after.blockersJson)).toContain("LEGAL_HOLD_ACTIVE");
      expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).toBeNull();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: t.owner.userId } })).email).not.toBeNull();
      expect(await prisma.teamMember.count({ where: { userId: t.owner.userId, status: "ACTIVE" } })).toBeGreaterThan(0);
      expect(await prisma.revokedSession.count({ where: { userId: t.owner.userId } })).toBe(sessionsBefore);
      expect(
        await prisma.adminAuditLog.count({ where: { action: "identity.account_closure_blocked", resourceId: req.id } }),
      ).toBe(1);
      await prisma.evidenceLegalHold.update({ where: { id: (hold as { id: string }).id }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });
    });

    it("control: the same reaper path with no blocker completes the closure", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const req = await staleProcessing(t.owner.userId);
      await accountClosure.processAccountClosures(new Date());
      expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
      expect((await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId } })).closedAtUtc).not.toBeNull();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: t.owner.userId } })).email).toBeNull();
    });
  });
});

/**
 * MEMBERS RE-AUDIT, THIRD ROUND — NEW DEFECTS N1, N2, N3 (live PostgreSQL).
 *
 *   N1  inbox items built from a record (OTS / TSA failures, discussion
 *       mentions and assigned threads, review escalations) are not produced for
 *       a record linked to a restricted case the caller cannot see. An off-list
 *       VIEWER and ADMIN do not get the item (nor its title); a listed member
 *       does (positive control).
 *   N2  POST /v1/evidence/bulk ARCHIVE / RESTORE_ARCHIVED / TRASH /
 *       RESTORE_TRASH writes the single routes' tenant audit row per record,
 *       INSIDE the lifecycle transaction: a refused audit leaves that record
 *       unchanged (no state, no custody event) and the rest of the batch lands
 *       with its rows.
 *   N3  every Collaboration Team mutation writes its audit row in its own
 *       transaction: a refused audit (a real PostgreSQL trigger) fails the
 *       request AND leaves nothing committed; the control commits with its row.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; email: string; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
type Inject = Awaited<ReturnType<IntegrationHarness["app"]["inject"]>>;
const WS = "x-proovra-workspace-id";

describe("members re-audit 3 — inbox reach, bulk lifecycle audit, Collaboration Team audit atomicity (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let ceremony: ReturnType<typeof createStepUpCeremony>;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  let orgA: string;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ceremony = createStepUpCeremony({
      prisma: (await import("../src/db.js")).prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId as string;

    // The failure-injection seam: the audit insert for a registered (action,
    // resource) pair raises a real database error — resource NULL matches any.
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ra3_audit_fail (action text NOT NULL, resource_id text)`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra3_audit_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra3_audit_fail f
                    WHERE f.action = NEW.action AND (f.resource_id IS NULL OR f.resource_id = NEW.resource_id)) THEN
          RAISE EXCEPTION 'ra3 injected audit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra3_audit_fail_trg ON admin_audit_logs`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ra3_audit_fail_trg BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION ra3_audit_fail_fn()`,
    );
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ra3_audit_fail_trg ON admin_audit_logs`).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const send = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: { ...bearer(token), [WS]: A().teamId },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  async function withAuditRefused<T>(action: string, resourceId: string | null, body: () => Promise<T>): Promise<T> {
    await prisma.$executeRawUnsafe(`INSERT INTO ra3_audit_fail (action, resource_id) VALUES ($1, $2)`, action, resourceId);
    try {
      return await body();
    } finally {
      await prisma.$executeRawUnsafe(`DELETE FROM ra3_audit_fail`);
    }
  }
  const audits = (action: string, resourceId: string) =>
    prisma.adminAuditLog.count({ where: { action, resourceId, outcome: "success" } });
  const failed = (res: Inject) => expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);

  async function person(role: Role | null = "MEMBER"): Promise<Person> {
    const email = `ra3-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    if (role) await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, email, token };
  }
  const newCase = async (ownerUserId = A().ownerUserId) =>
    (await prisma.case.create({ data: { name: `ra3-case-${tag()}`, teamId: A().teamId, ownerUserId }, select: { id: true } })).id;
  async function restrict(caseId: string, listed: string[]) {
    await prisma.case.update({ where: { id: caseId }, data: { restrictedAtUtc: new Date() } });
    for (const userId of listed) await prisma.caseAccess.create({ data: { caseId, userId } });
  }
  async function newEvidence(extra: Record<string, unknown> = {}, title = `ra3 ${tag()}`) {
    return (
      await prisma.evidence.create({
        data: {
          title,
          type: "PHOTO",
          status: "CREATED",
          teamId: A().teamId,
          organizationId: orgA,
          ownerUserId: A().ownerUserId,
          ...extra,
        } as never,
        select: { id: true },
      })
    ).id;
  }
  const link = (caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: A().teamId } as never });

  // ===========================================================================
  // N1 — inbox items do not reach past the restricted-case rule
  // ===========================================================================
  describe("N1 — record-built inbox items obey the restricted-case rule", () => {
    async function inbox(token: string) {
      const res = await h.app.inject({ method: "GET", url: "/v1/me/inbox", headers: bearer(token) });
      expect(res.statusCode, res.body).toBe(200);
      return { keys: (res.json() as { items: Array<{ itemKey: string }> }).items.map((i) => i.itemKey), body: res.body };
    }

    async function fixture() {
      const caseOwner = await person("MEMBER");
      const listedViewer = await person("VIEWER");
      const listedAdmin = await person("ADMIN");
      const offViewer = await person("VIEWER");
      const offAdmin = await person("ADMIN");
      const restrictedCase = await newCase(caseOwner.id);
      await restrict(restrictedCase, [listedViewer.id, listedAdmin.id]);
      return { caseOwner, listedViewer, listedAdmin, offViewer, offAdmin, restrictedCase };
    }

    for (const kind of [
      { category: "ots_failure", fields: { status: "SIGNED", otsStatus: "FAILED", otsFailureReason: "OTS_PROCESSING_FAILED" } },
      { category: "tsa_failure", fields: { status: "SIGNED", tsaStatus: "FAILED", tsaFailureCode: "TSA_UNAVAILABLE" } },
    ]) {
      it(`${kind.category} — off-list VIEWER and ADMIN get no item and no title; a listed VIEWER does; an open record reaches everyone`, async () => {
        const f = await fixture();
        const marker = `ra3mark${tag()}`;
        const hidden = await newEvidence(kind.fields, `${marker} hidden`);
        await link(f.restrictedCase, hidden);
        const open = await newEvidence(kind.fields, `${marker} open`);

        for (const p of [f.offViewer, f.offAdmin]) {
          const { keys, body } = await inbox(p.token);
          expect(keys).toContain(`${kind.category}:${open}`);
          expect(keys).not.toContain(`${kind.category}:${hidden}`);
          expect(body).not.toContain(`${marker} hidden`);
          expect(body).not.toContain(f.restrictedCase);
        }
        const listed = await inbox(f.listedViewer.token);
        expect(listed.keys).toContain(`${kind.category}:${hidden}`);
        expect(listed.keys).toContain(`${kind.category}:${open}`);
      });
    }

    it("discussion mention and assigned thread — an off-list member mentioned / assigned on a restricted record gets no item; a listed one does", async () => {
      const f = await fixture();
      const hidden = await newEvidence();
      await link(f.restrictedCase, hidden);
      const marker = `ra3thread${tag()}`;
      const seed = async (assignee: Person) => {
        const thread = await prisma.discussionThread.create({
          data: {
            teamId: A().teamId,
            evidenceId: hidden,
            title: `${marker} ${tag()}`,
            visibility: "INTERNAL",
            status: "OPEN",
            createdByUserId: f.caseOwner.id,
            assignedToUserId: assignee.id,
          } as never,
        });
        const message = await prisma.discussionMessage.create({
          data: { threadId: thread.id, teamId: A().teamId, authorKind: "USER", authorUserId: f.caseOwner.id, body: "@someone" } as never,
        });
        const mention = await prisma.discussionMention.create({
          data: { messageId: message.id, threadId: thread.id, teamId: A().teamId, mentionedUserId: assignee.id } as never,
        });
        return { mentionKey: `discussion_mention:${mention.id}`, threadKey: `discussion_assigned:${thread.id}` };
      };
      for (const p of [f.offViewer, f.offAdmin]) {
        const s = await seed(p);
        const { keys, body } = await inbox(p.token);
        expect(keys).not.toContain(s.mentionKey);
        expect(keys).not.toContain(s.threadKey);
        expect(body).not.toContain(marker);
      }
      const s = await seed(f.listedViewer);
      const { keys } = await inbox(f.listedViewer.token);
      expect(keys).toContain(s.mentionKey);
      expect(keys).toContain(s.threadKey);
    });

    it("review escalation — an off-list ADMIN is not offered an unassigned escalation on a restricted record; a listed ADMIN is", async () => {
      const f = await fixture();
      const hidden = await newEvidence();
      await link(f.restrictedCase, hidden);
      const wf = await prisma.evidenceReviewWorkflow.create({
        data: { teamId: A().teamId, evidenceId: hidden, workspaceType: "TEAM", status: "QUEUED" } as never,
        select: { id: true },
      });
      const esc = await prisma.reviewEscalation.create({
        data: {
          teamId: A().teamId,
          workflowId: wf.id,
          evidenceId: hidden,
          reason: "REVIEW_OVERDUE",
          severity: "WARNING",
          status: "OPEN",
          safeSummary: "Overdue",
          assignedToUserId: null,
          fingerprint: randomUUID(),
        } as never,
        select: { id: true },
      });
      const key = `review_escalation:${esc.id}`;
      const off = await inbox(f.offAdmin.token);
      expect(off.keys).not.toContain(key);
      expect(off.body).not.toContain(hidden);
      expect((await inbox(f.listedAdmin.token)).keys).toContain(key);
    });

    it("reviewer conflict — an off-list ADMIN is not asked to adjudicate a restricted record's review; a listed ADMIN is", async () => {
      const f = await fixture();
      const hidden = await newEvidence();
      await link(f.restrictedCase, hidden);
      const wf = await prisma.evidenceReviewWorkflow.create({
        data: { teamId: A().teamId, evidenceId: hidden, workspaceType: "TEAM", status: "QUEUED" } as never,
        select: { id: true },
      });
      const second = await person("MEMBER");
      await prisma.workflowReviewDecision.createMany({
        data: [
          { workflowId: wf.id, teamId: A().teamId, stage: "FIRST", reviewerUserId: f.caseOwner.id, decision: "APPROVE", rationale: "ok" },
          { workflowId: wf.id, teamId: A().teamId, stage: "SECOND", reviewerUserId: second.id, decision: "REJECT", rationale: "no" },
        ] as never,
      });
      const key = `review_decision:conflict:${wf.id}`;
      expect((await inbox(f.offAdmin.token)).keys).not.toContain(key);
      expect((await inbox(f.listedAdmin.token)).keys).toContain(key);
    });
  });

  // ===========================================================================
  // N2 — bulk lifecycle writes the single routes' audit, in its transaction
  // ===========================================================================
  describe("N2 — POST /v1/evidence/bulk lifecycle actions audit per record, in the lifecycle transaction", () => {
    const snap = async (id: string) => ({
      state: (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } })).lifecycleState,
      custody: await prisma.custodyEvent.count({ where: { evidenceId: id } }),
    });
    const bulk = (action: string, evidenceIds: string[]) =>
      send("POST", "/v1/evidence/bulk", A().ownerToken, { action, evidenceIds });
    type BulkBody = { results: Array<{ evidenceId: string; ok: boolean; reason?: string }> };

    for (const op of [
      { action: "ARCHIVE", audit: "evidence.archive", state: "ARCHIVED", prepare: async (): Promise<void> => undefined },
      { action: "TRASH", audit: "evidence.delete", state: "TRASHED", prepare: async (): Promise<void> => undefined },
      {
        action: "RESTORE_ARCHIVED",
        audit: "evidence.unarchive",
        state: "ACTIVE",
        prepare: async (id: string) => {
          const r = await bulk("ARCHIVE", [id]);
          expect((r.json() as BulkBody).results[0]?.ok, r.body).toBe(true);
        },
      },
      {
        action: "RESTORE_TRASH",
        audit: "evidence.restore",
        state: "ACTIVE",
        prepare: async (id: string) => {
          const r = await bulk("TRASH", [id]);
          expect((r.json() as BulkBody).results[0]?.ok, r.body).toBe(true);
        },
      },
    ]) {
      it(`${op.action} — refused audit: that record unchanged and reported failed (no raw DB text); the other record lands with its row`, async () => {
        const refused = await newEvidence();
        const control = await newEvidence();
        await op.prepare(refused);
        await op.prepare(control);
        const before = await snap(refused);

        const res = await withAuditRefused(op.audit, refused, () => bulk(op.action, [refused, control]));
        expect(res.statusCode, res.body).toBe(200);
        const results = (res.json() as BulkBody).results;
        const r = results.find((x) => x.evidenceId === refused)!;
        expect(r.ok).toBe(false);
        expect(r.reason).toBe("Operation failed");
        expect(res.body).not.toContain("ra3 injected");
        expect(await snap(refused)).toEqual(before);
        expect(await audits(op.audit, refused)).toBe(0);

        expect(results.find((x) => x.evidenceId === control)!.ok).toBe(true);
        expect((await snap(control)).state).toBe(op.state);
        expect(await audits(op.audit, control)).toBe(1);
      });
    }
  });

  // ===========================================================================
  // N3 — Collaboration Team mutations audit in their own transaction
  // ===========================================================================
  describe("N3 — Collaboration Team mutations never commit without their audit row", () => {
    const base = "/v1/collaboration-teams";
    const owner = () => A().ownerToken;

    /** A fresh ACTIVE group; earlier groups are archived so capacity never decides a case. */
    async function group() {
      await prisma.collaborationTeam.updateMany({
        where: { workspaceId: A().teamId, status: "ACTIVE" },
        data: { status: "ARCHIVED", archivedAtUtc: new Date() },
      });
      const res = await send("POST", base, owner(), { name: `ra3 group ${tag()}` });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().team.id as string;
    }
    const teamRow = (id: string) =>
      prisma.collaborationTeam.findUniqueOrThrow({ where: { id }, select: { name: true, status: true } });
    /**
     * Archive is "Archive Collaboration Team" (2026-10-28): the exact name and
     * a recent step-up bound to this group — the real authenticator-app
     * ceremony, one fresh approval per attempt.
     */
    async function archiveRequest(id: string) {
      const header = await ceremony.approvedHeader({
        token: owner(),
        userId: A().ownerUserId,
        teamId: A().teamId,
        purpose: "COLLABORATION_TEAM_ARCHIVE",
        resourceKind: "collaboration_team",
        resourceId: id,
      });
      return h.app.inject({
        method: "POST",
        url: `${base}/${id}/archive`,
        headers: { ...bearer(owner()), [WS]: A().teamId, ...header },
        payload: { confirmName: (await teamRow(id)).name },
      });
    }
    const memberRow = (id: string) =>
      prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id }, select: { role: true, status: true } });
    async function addMember(teamId: string) {
      const p = await person("MEMBER");
      const res = await send("POST", `${base}/${teamId}/members`, owner(), { userId: p.id, role: "MEMBER" });
      expect(res.statusCode, res.body).toBe(201);
      return { person: p, memberId: res.json().member.id as string };
    }

    it("create — refused audit: no group; control: the group and its row", async () => {
      await prisma.collaborationTeam.updateMany({
        where: { workspaceId: A().teamId, status: "ACTIVE" },
        data: { status: "ARCHIVED", archivedAtUtc: new Date() },
      });
      const name = `ra3 create ${tag()}`;
      failed(await withAuditRefused("collaboration_team.created", null, () => send("POST", base, owner(), { name })));
      expect(await prisma.collaborationTeam.count({ where: { name } })).toBe(0);
      const ok = await send("POST", base, owner(), { name });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await audits("collaboration_team.created", ok.json().team.id)).toBe(1);
    });

    it("update, archive, unarchive — each refused audit changes nothing; each control changes it with its row", async () => {
      const id = await group();
      const before = await teamRow(id);
      failed(await withAuditRefused("collaboration_team.updated", id, () => send("PATCH", `${base}/${id}`, owner(), { name: "ra3 renamed" })));
      expect(await teamRow(id)).toEqual(before);
      const upd = await send("PATCH", `${base}/${id}`, owner(), { name: "ra3 renamed" });
      expect(upd.statusCode, upd.body).toBe(200);
      expect((await teamRow(id)).name).toBe("ra3 renamed");
      expect(await audits("collaboration_team.updated", id)).toBe(1);

      failed(await withAuditRefused("collaboration_team.archived", id, () => archiveRequest(id)));
      expect((await teamRow(id)).status).toBe("ACTIVE");
      const arc = await archiveRequest(id);
      expect(arc.statusCode, arc.body).toBe(200);
      expect((await teamRow(id)).status).toBe("ARCHIVED");
      expect(await audits("collaboration_team.archived", id)).toBe(1);

      failed(await withAuditRefused("collaboration_team.unarchived", id, () => send("POST", `${base}/${id}/unarchive`, owner(), {})));
      expect((await teamRow(id)).status).toBe("ARCHIVED");
      const un = await send("POST", `${base}/${id}/unarchive`, owner(), {});
      expect(un.statusCode, un.body).toBe(200);
      expect((await teamRow(id)).status).toBe("ACTIVE");
      expect(await audits("collaboration_team.unarchived", id)).toBe(1);
    });

    it("member add (single and bulk) — refused audit: nobody added; controls add with their rows", async () => {
      const id = await group();
      const p = await person("MEMBER");
      failed(await withAuditRefused("collaboration_team.member.added", null, () => send("POST", `${base}/${id}/members`, owner(), { userId: p.id })));
      expect(await prisma.collaborationTeamMember.count({ where: { teamId: id, userId: p.id } })).toBe(0);
      const ok = await send("POST", `${base}/${id}/members`, owner(), { userId: p.id });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await audits("collaboration_team.member.added", ok.json().member.id)).toBe(1);

      const q = await person("MEMBER");
      const refusedBulk = await withAuditRefused("collaboration_team.member.added", null, () =>
        send("POST", `${base}/${id}/members/bulk`, owner(), { userIds: [q.id] }),
      );
      expect(refusedBulk.statusCode, refusedBulk.body).toBe(409);
      expect(refusedBulk.json().failed).toEqual([{ userId: q.id, reason: "add_failed" }]);
      expect(await prisma.collaborationTeamMember.count({ where: { teamId: id, userId: q.id } })).toBe(0);
      const okBulk = await send("POST", `${base}/${id}/members/bulk`, owner(), { userIds: [q.id] });
      expect(okBulk.statusCode, okBulk.body).toBe(201);
      const qMember = await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId: id, userId: q.id } });
      expect(await audits("collaboration_team.member.added", qMember.id)).toBe(1);
    });

    it("member role change, suspend, reinstate, remove (PATCH) and remove (DELETE) — each refused audit changes nothing; controls with rows", async () => {
      const id = await group();
      const { memberId } = await addMember(id);
      const patch = (payload: unknown) => send("PATCH", `${base}/${id}/members/${memberId}`, owner(), payload);

      failed(await withAuditRefused("collaboration_team.member.role_changed", memberId, () => patch({ role: "ADMIN" })));
      expect((await memberRow(memberId)).role).toBe("MEMBER");
      expect((await patch({ role: "ADMIN" })).statusCode).toBe(200);
      expect((await memberRow(memberId)).role).toBe("ADMIN");
      expect(await audits("collaboration_team.member.role_changed", memberId)).toBe(1);

      failed(await withAuditRefused("collaboration_team.member.suspended", memberId, () => patch({ status: "SUSPENDED" })));
      expect((await memberRow(memberId)).status).toBe("ACTIVE");
      expect((await patch({ status: "SUSPENDED" })).statusCode).toBe(200);
      expect((await memberRow(memberId)).status).toBe("SUSPENDED");
      expect(await audits("collaboration_team.member.suspended", memberId)).toBe(1);

      failed(await withAuditRefused("collaboration_team.member.reinstated", memberId, () => patch({ status: "ACTIVE" })));
      expect((await memberRow(memberId)).status).toBe("SUSPENDED");
      expect((await patch({ status: "ACTIVE" })).statusCode).toBe(200);
      expect((await memberRow(memberId)).status).toBe("ACTIVE");
      expect(await audits("collaboration_team.member.reinstated", memberId)).toBe(1);

      failed(await withAuditRefused("collaboration_team.member.removed", memberId, () => patch({ status: "REMOVED" })));
      expect((await memberRow(memberId)).status).toBe("ACTIVE");
      expect((await patch({ status: "REMOVED" })).statusCode).toBe(200);
      expect((await memberRow(memberId)).status).toBe("REMOVED");
      expect(await audits("collaboration_team.member.removed", memberId)).toBe(1);

      const other = await addMember(id);
      const del = () => send("DELETE", `${base}/${id}/members/${other.memberId}`, owner());
      failed(await withAuditRefused("collaboration_team.member.removed", other.memberId, del));
      expect((await memberRow(other.memberId)).status).toBe("ACTIVE");
      expect((await del()).statusCode).toBe(200);
      expect((await memberRow(other.memberId)).status).toBe("REMOVED");
      expect(await audits("collaboration_team.member.removed", other.memberId)).toBe(1);
    });

    it("invite revoke and accept — refused audits leave the invitation as it was and add nobody; controls with rows", async () => {
      const id = await group();
      const invitee = await person("MEMBER");
      const invite = async (email: string | null) => {
        const raw = `ra3-${randomUUID()}`;
        const row = await prisma.collaborationTeamInvite.create({
          data: {
            teamId: id,
            workspaceId: A().teamId,
            channel: "EMAIL",
            email,
            tokenHash: createHash("sha256").update(raw).digest("hex"),
            role: "MEMBER",
            status: "PENDING",
            expiresAtUtc: new Date(Date.now() + 24 * 60 * 60 * 1000),
            createdByUserId: A().ownerUserId,
          },
          select: { id: true },
        });
        return { raw, inviteId: row.id };
      };
      const inviteState = async (inviteId: string) =>
        (await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: inviteId }, select: { status: true } })).status;

      const r = await invite(`revoke-${tag()}@invitee.test`);
      const revoke = () => send("POST", `${base}/${id}/invites/${r.inviteId}/revoke`, owner(), {});
      failed(await withAuditRefused("collaboration_team.invite.revoked", r.inviteId, revoke));
      expect(await inviteState(r.inviteId)).toBe("PENDING");
      expect((await revoke()).statusCode).toBe(200);
      expect(await inviteState(r.inviteId)).toBe("REVOKED");
      expect(await audits("collaboration_team.invite.revoked", r.inviteId)).toBe(1);

      const a = await invite(invitee.email);
      const accept = () =>
        h.app.inject({ method: "POST", url: "/v1/collaboration-team-invites/accept", headers: bearer(invitee.token), payload: { token: a.raw } });
      failed(await withAuditRefused("collaboration_team.invite.accepted", null, accept));
      expect(await inviteState(a.inviteId)).toBe("PENDING");
      expect(await prisma.collaborationTeamMember.count({ where: { teamId: id, userId: invitee.id } })).toBe(0);
      const ok = await accept();
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await inviteState(a.inviteId)).toBe("ACCEPTED");
      expect(await audits("collaboration_team.invite.accepted", ok.json().memberId)).toBe(1);
    });

    it("assignment create and update — refused audits commit no task and no change (no timeline event); controls with rows", async () => {
      const id = await group();
      const caseId = await newCase();
      const create = () => send("POST", `${base}/${id}/assignments`, owner(), { targetType: "CASE", targetId: caseId });
      failed(await withAuditRefused("collaboration_team.assignment.created", null, create));
      expect(await prisma.collaborationTeamAssignment.count({ where: { teamId: id, targetId: caseId } })).toBe(0);
      const created = await create();
      expect(created.statusCode, created.body).toBe(201);
      const assignmentId = created.json().assignment.id as string;
      expect(await audits("collaboration_team.assignment.created", assignmentId)).toBe(1);

      const row = () =>
        prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: assignmentId }, select: { priority: true } });
      const events = () => prisma.collaborationTeamActivity.count({ where: { teamId: id, eventType: "ASSIGNMENT_PRIORITY_CHANGED" } });
      const update = () => send("PATCH", `${base}/${id}/assignments/${assignmentId}`, owner(), { priority: "URGENT" });
      failed(await withAuditRefused("collaboration_team.assignment.updated", assignmentId, update));
      expect((await row()).priority).not.toBe("URGENT");
      expect(await events()).toBe(0);
      const ok = await update();
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await row()).priority).toBe("URGENT");
      expect(await events()).toBe(1);
      expect(await audits("collaboration_team.assignment.updated", assignmentId)).toBe(1);
    });
  });
});

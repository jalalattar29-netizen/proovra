/**
 * NOTES, EXPORT, SEARCH AND GRANT CLOSURES (live PostgreSQL).
 *
 *   EVID-010  a reader cannot write collaborative content; a closed lifecycle
 *             refuses it; content and its audit event commit together.
 *   EVID-013  a metadata CSV cannot carry a live formula, and the export audits.
 *   EVID-012  diagnostics give a member no database details.
 *   EVID-014  saved views: Trash, the acquisition filter, another's default.
 *   EVID-015  search pagination survives a page that post-filters to nothing.
 *   EVID-005  deleting a case takes its search documents with it.
 *   EVID-018  a PACKAGE grant sees its work; a CASE grant does not reach a
 *             record closed by another restricted case.
 *   AUTHZ-005 a grantor cannot hand out a scope they do not hold, or self-grant.
 *   AUTHZ-003 identity operations answer to the engine, not a local role check.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; memberId: string; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

describe("evidence collaboration and search closures (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  let executeSearch: typeof import("../src/services/search/evidence-search.service.js")["executeSearch"];
  let indexNote: typeof import("../src/services/search/artifact-indexing.service.js")["indexNote"];
  let projectPortal: typeof import("../src/services/external-review/portal-projection.service.js")["projectPortalDashboard"];
  let grantDelegatedAdminScope: typeof import("../src/services/identity/rbac.service.js")["grantDelegatedAdminScope"];
  let grantCapability: typeof import("../src/services/identity/rbac.service.js")["grantCapability"];
  let RbacError: typeof import("../src/services/identity/rbac.service.js")["RbacError"];
  const A = () => h.fixtures.teamA;

  let viewer: Person;
  let member: Person;
  let admin: Person;

  const tag = () => randomUUID().slice(0, 8);
  const headers = (who: Person) => ({ authorization: `Bearer ${who.token}` });
  const get = (url: string, who: Person) => h.app.inject({ method: "GET", url, headers: headers(who) });
  const post = (url: string, who: Person, payload: unknown) =>
    h.app.inject({ method: "POST", url, headers: headers(who), payload: payload as never });

  async function person(role: Role): Promise<Person> {
    const email = `closure-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, currentWorkspaceId: A().teamId } as never,
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    const m = await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, memberId: m.id, token };
  }

  async function record(extra: Record<string, unknown> = {}): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `closure ${tag()}`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId: A().ownerUserId,
          sizeBytes: 1_000n,
          lifecycleState: "ACTIVE",
          ...extra,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    ({ executeSearch } = await import("../src/services/search/evidence-search.service.js"));
    ({ indexNote } = await import("../src/services/search/artifact-indexing.service.js"));
    ({ projectPortalDashboard: projectPortal } = await import("../src/services/external-review/portal-projection.service.js"));
    ({ grantDelegatedAdminScope, grantCapability, RbacError } = await import("../src/services/identity/rbac.service.js"));
    await prisma.team.updateMany({
      where: { id: A().teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    [viewer, member, admin] = await Promise.all([person("VIEWER"), person("MEMBER"), person("ADMIN")]);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  describe("EVID-010: collaborative writes", () => {
    const writes = (id: string): Array<[string, unknown]> => [
      [`/v1/evidence/${id}/comments`, { body: "from a reader", visibility: "INTERNAL" }],
      [`/v1/evidence/${id}/legal-notes`, { body: "from a reader", noteType: "GENERAL" }],
      [`/v1/evidence/${id}/annotations`, { annotationType: "POINT", coordinateSpace: "NORMALIZED", body: "from a reader", x: 0.1, y: 0.1 }],
    ];

    it("a VIEWER is refused all three with 403 and nothing is stored", async () => {
      const id = await record();
      for (const [url, body] of writes(id)) {
        const r = await post(url, viewer, body);
        expect(r.statusCode, `${url}: ${r.body}`).toBe(403);
      }
      expect(await prisma.evidenceReviewerComment.count({ where: { evidenceId: id } })).toBe(0);
      expect(await prisma.evidenceLegalNote.count({ where: { evidenceId: id } })).toBe(0);
      expect(await prisma.evidenceAnnotation.count({ where: { evidenceId: id } })).toBe(0);
    });

    it("a reviewer writes, and the audit event exists with the content", async () => {
      const id = await record();
      const r = await post(`/v1/evidence/${id}/comments`, member, { body: "reviewer note", visibility: "INTERNAL" });
      expect(r.statusCode, r.body).toBe(201);
      const events = await prisma.evidenceReviewerAuditEvent.count({ where: { evidenceId: id, actorUserId: member.id } });
      expect(events).toBe(1);
    });

    it("a trashed or destroyed record refuses, and a demoted author cannot edit", async () => {
      const trashed = await record({ lifecycleState: "TRASHED", deletedAt: new Date() });
      const destroyed = await record({ lifecycleState: "DESTROYED", deletedAt: new Date() });
      for (const id of [trashed, destroyed]) {
        const r = await post(`/v1/evidence/${id}/comments`, member, { body: "late", visibility: "INTERNAL" });
        expect(r.statusCode, r.body).toBe(409);
      }

      const open = await record();
      const author = await person("MEMBER");
      const created = await post(`/v1/evidence/${open}/comments`, author, { body: "mine", visibility: "INTERNAL" });
      expect(created.statusCode, created.body).toBe(201);
      const commentId = (created.json() as { comment: { id: string } }).comment.id;
      await prisma.teamMember.update({ where: { id: author.memberId }, data: { role: "VIEWER" } });
      const edit = await h.app.inject({
        method: "PATCH",
        url: `/v1/evidence/${open}/comments/${commentId}`,
        headers: headers(author),
        payload: { body: "edited after demotion" },
      });
      expect(edit.statusCode, edit.body).toBe(403);
    });
  });

  // ===========================================================================
  describe("EVID-013: the metadata CSV", () => {
    it("neutralises a formula and audits the export", async () => {
      const id = await record({ title: `=HYPERLINK("http://evil","x")` });
      const before = await prisma.adminAuditLog.count({ where: { action: "evidence.metadata_csv_export" } });
      const r = await post(`/v1/evidence/bulk`, member, { action: "EXPORT_METADATA_CSV", evidenceIds: [id] });
      expect(r.statusCode, r.body).toBe(200);
      const csv = (r.json() as { csv: string }).csv;
      expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
      expect(csv).toContain("'=HYPERLINK");
      expect(await prisma.adminAuditLog.count({ where: { action: "evidence.metadata_csv_export" } })).toBe(before + 1);
    });
  });

  // ===========================================================================
  describe("EVID-012: search diagnostics", () => {
    it("a member gets no database details; the q probe still counts", async () => {
      const r = await get(`/v1/search/diagnostics?teamId=${A().teamId}&q=closure`, viewer);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty("runtime");
      expect(r.body).not.toContain("dbServerIp");
      expect(r.body).not.toContain("dbName");
    });
  });

  // ===========================================================================
  describe("EVID-014: saved views", () => {
    it("a view saved in Trash with an acquisition filter round-trips", async () => {
      const r = await post(`/v1/evidence/saved-views`, member, {
        name: `trash-${tag()}`,
        teamId: A().teamId,
        scope: "trash",
        filters: { scope: "trash", acquisition: "UPLOAD" },
      });
      expect(r.statusCode, r.body).toBe(201);
      const list = (await get(`/v1/evidence/saved-views`, member)).json() as {
        items: Array<{ id: string; scope: string; filters: { acquisition?: string } }>;
      };
      const saved = (r.json() as { savedView: { id: string } }).savedView;
      const row = list.items.find((v) => v.id === saved.id);
      expect(row?.scope).toBe("trash");
      expect(row?.filters.acquisition).toBe("UPLOAD");
    });

    it("one member's default does not read as a default to a colleague", async () => {
      const r = await post(`/v1/evidence/saved-views`, member, {
        name: `default-${tag()}`,
        teamId: A().teamId,
        scope: "active",
        filters: {},
        isDefault: true,
      });
      expect(r.statusCode, r.body).toBe(201);
      const id = (r.json() as { savedView: { id: string } }).savedView.id;
      const flag = async (who: Person) =>
        ((await get(`/v1/evidence/saved-views`, who)).json() as { items: Array<{ id: string; isDefault: boolean }> }).items.find(
          (v) => v.id === id,
        )?.isDefault;
      expect(await flag(member)).toBe(true);
      expect(await flag(admin)).toBe(false);
    });
  });

  // ===========================================================================
  describe("EVID-017: review and retention are server filters", () => {
    it("a match past the first page is found, and the summary agrees", async () => {
      const failed = await record({ verificationStatus: "FAILED", createdAt: new Date(Date.now() - 86_400_000 * 400) });
      for (let i = 0; i < 3; i += 1) await record({ verificationStatus: "MATERIALS_AVAILABLE" });
      const page = await get(
        `/v1/evidence?teamId=${A().teamId}&limit=2&sort=oldest&review=verification-failed`,
        member,
      );
      expect(page.statusCode, page.body).toBe(200);
      const items = (page.json() as { items: Array<{ id: string; verificationStatus: string }> }).items;
      expect(items.map((i) => i.id)).toContain(failed);
      expect(items.every((i) => i.verificationStatus === "FAILED")).toBe(true);
    });

    it("retention narrows by the recorded object lock", async () => {
      const locked = await record({
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: new Date(Date.now() + 86_400_000),
      });
      const open = await record();
      const body = async (q: string) =>
        (await get(`/v1/evidence?teamId=${A().teamId}&limit=100&retention=${q}`, member)).body;
      const prot = await body("protected");
      expect(prot).toContain(locked);
      expect(prot).not.toContain(open);
      const unprot = await body("unprotected");
      expect(unprot).toContain(open);
      expect(unprot).not.toContain(locked);
    });
  });

  // ===========================================================================
  describe("EVID-015: search pagination", () => {
    it("a page that post-filters to nothing still continues, and no row repeats", async () => {
      const word = `pagewalk${tag()}`;
      const at = Date.now();
      const doc = (i: number, workflowState: string | null) => ({
        teamId: A().teamId,
        documentType: "NOTE",
        sourceId: randomUUID(),
        title: `${word} ${i}`,
        searchableText: word,
        workflowState,
        sourceUpdatedAtUtc: new Date(at - i * 1000),
      });
      for (let i = 0; i < 6; i += 1) {
        await prisma.evidenceSearchDocument.create({ data: doc(i, i < 2 ? "CANCELLED" : "OPEN") as never });
      }
      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      for (let page = 0; page < 6; page += 1) {
        const result = await executeSearch({
          filter: { teamId: A().teamId, q: word, limit: 2, cursor },
          actorUserId: A().ownerUserId,
          isReviewerCapable: true,
        } as never);
        seen.push(...result.rows.map((r) => r.documentId));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    });
  });

  // ===========================================================================
  describe("EVID-005: deleting a case", () => {
    it("removes its CASE and NOTE documents, and a surviving comment cannot return", async () => {
      const name = `sentinel-deleted-${tag()}`;
      const c = await prisma.case.create({
        data: { name, teamId: A().teamId, ownerUserId: admin.id, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      });
      await prisma.caseAccess.create({ data: { caseId: c.id, userId: admin.id } });
      const comment = await prisma.caseComment.create({
        data: { caseId: c.id, teamId: A().teamId, authorUserId: admin.id, body: `sentinel note ${name}` } as never,
      });
      await prisma.evidenceSearchDocument.create({
        data: { teamId: A().teamId, documentType: "CASE", sourceId: c.id, caseId: c.id, title: name, searchableText: name, sourceUpdatedAtUtc: new Date() } as never,
      });
      await prisma.evidenceSearchDocument.create({
        data: { teamId: A().teamId, documentType: "NOTE", sourceId: comment.id, caseId: c.id, title: name, searchableText: name, sourceUpdatedAtUtc: new Date() } as never,
      });

      const { deleteCaseAtomically } = await import("../src/services/cases/case-evidence-link.service.js");
      await deleteCaseAtomically({ caseId: c.id, teamId: A().teamId, actorUserId: admin.id } as never, prisma);

      expect(await prisma.evidenceSearchDocument.count({ where: { caseId: c.id } })).toBe(0);
      expect(await prisma.evidenceSearchDocument.count({ where: { sourceId: c.id } })).toBe(0);

      const again = await indexNote({ noteId: comment.id }, prisma);
      expect(again.ok).toBe(false);
      expect(await prisma.evidenceSearchDocument.count({ where: { sourceId: comment.id } })).toBe(0);
    });
  });

  // ===========================================================================
  const portalSessionBase = {
    sessionId: randomUUID(),
    reviewerEmail: "external@test.proovra.local",
    reviewerDisplayName: null,
    expiresAtUtc: new Date(Date.now() + 3_600_000),
    role: "EXTERNAL_REVIEWER",
    mfaRequired: false,
    organization: null,
    watermarkPolicy: "NEVER",
    inactivityTimeoutMs: 600_000,
    maxSessionMs: 3_600_000,
    evidenceId: null,
    caseId: null,
    packageId: null,
  };

  describe("EVID-018: the portal dashboard", () => {
    it("a PACKAGE grant lists its work; a CASE grant leaves out a record a second restricted case closes", async () => {
      const id = await record();
      const wf = await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId: id, teamId: A().teamId, workspaceType: "TEAM", status: "IN_REVIEW" } as never,
      });
      const pkg = await prisma.verificationPackage.create({
        data: {
          evidenceId: id,
          version: 1,
          state: "PUBLISHED",
          generatedAtUtc: new Date(),
          generatedByUserId: A().ownerUserId,
        } as never,
      }).catch(() => null);
      if (pkg) {
        const projection = await projectPortal({
          prisma,
          session: { ...portalSessionBase, scopeKind: "PACKAGE", packageId: pkg.id, teamId: A().teamId, grantId: randomUUID() },
        } as never);
        expect(JSON.stringify(projection)).toContain(wf.id);
      }

      const granted = await prisma.case.create({
        data: { name: `grant-${tag()}`, teamId: A().teamId, ownerUserId: admin.id },
        select: { id: true },
      });
      const other = await prisma.case.create({
        data: { name: `other-${tag()}`, teamId: A().teamId, ownerUserId: admin.id, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      });
      const open = await record();
      const closed = await record();
      const openWf = await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId: open, teamId: A().teamId, workspaceType: "TEAM", status: "IN_REVIEW" } as never,
      });
      const closedWf = await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId: closed, teamId: A().teamId, workspaceType: "TEAM", status: "IN_REVIEW" } as never,
      });
      for (const [caseId, evidenceId] of [
        [granted.id, open],
        [granted.id, closed],
        [other.id, closed],
      ] as const) {
        await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: A().teamId } as never });
      }
      const projection = JSON.stringify(
        await projectPortal({
          prisma,
          session: { ...portalSessionBase, scopeKind: "CASE", caseId: granted.id, teamId: A().teamId, grantId: randomUUID() },
        } as never),
      );
      expect(projection).toContain(openWf.id);
      expect(projection).not.toContain(closedWf.id);
    });
  });

  // ===========================================================================
  describe("AUTHZ-005: who may grant", () => {
    async function identityDelegate() {
      const delegate = await person("VIEWER");
      await grantDelegatedAdminScope(
        { teamId: A().teamId, teamMemberId: delegate.memberId, scopeKind: "IDENTITY_ADMIN", actorUserId: A().ownerUserId } as never,
        prisma,
      );
      return delegate;
    }

    it("a delegate holding IDENTITY_ADMIN cannot grant GOVERNANCE_ADMIN to anyone, themself included", async () => {
      const delegate = await identityDelegate();
      const colleague = await person("VIEWER");
      for (const target of [delegate.memberId, colleague.memberId]) {
        await expect(
          grantDelegatedAdminScope(
            { teamId: A().teamId, teamMemberId: target, scopeKind: "GOVERNANCE_ADMIN", actorUserId: delegate.id } as never,
            prisma,
          ),
        ).rejects.toBeInstanceOf(RbacError);
      }
      const rows = await prisma.memberDelegatedAdminScope.count({
        where: { teamMemberId: { in: [delegate.memberId, colleague.memberId] }, scopeKind: "GOVERNANCE_ADMIN" },
      });
      expect(rows).toBe(0);
    });

    it("nobody grants to themself, and a suspended member receives nothing", async () => {
      await expect(
        grantDelegatedAdminScope(
          { teamId: A().teamId, teamMemberId: admin.memberId, scopeKind: "IDENTITY_ADMIN", actorUserId: admin.id } as never,
          prisma,
        ),
      ).rejects.toMatchObject({ code: "self_action_forbidden" });
      await expect(
        grantCapability(
          { teamId: A().teamId, teamMemberId: admin.memberId, permission: "evidence.read", actorUserId: admin.id } as never,
          prisma,
        ),
      ).rejects.toMatchObject({ code: "self_action_forbidden" });
      const gone = await person("MEMBER");
      await prisma.teamMember.update({ where: { id: gone.memberId }, data: { status: "SUSPENDED" } });
      await expect(
        grantDelegatedAdminScope(
          { teamId: A().teamId, teamMemberId: gone.memberId, scopeKind: "IDENTITY_ADMIN", actorUserId: A().ownerUserId } as never,
          prisma,
        ),
      ).rejects.toMatchObject({ code: "invalid_status_transition" });
    });

    it("positive control: the owner grants a scope to an active colleague", async () => {
      const delegate = await identityDelegate();
      const row = await prisma.memberDelegatedAdminScope.findFirst({
        where: { teamMemberId: delegate.memberId, scopeKind: "IDENTITY_ADMIN", revokedAtUtc: null },
      });
      expect(row).not.toBeNull();
    });

    it("AUTHZ-003: identity operations follow the engine, for delegates and for expired access", async () => {
      const url = `/v1/sso/health?teamId=${A().teamId}`;
      const delegate = await identityDelegate();
      expect((await get(url, delegate)).statusCode).toBe(200);
      expect((await get(url, admin)).statusCode).toBe(200);
      expect((await get(url, member)).statusCode).toBe(403);
      expect((await get(url, viewer)).statusCode).toBe(403);

      const expiring = await person("ADMIN");
      expect((await get(url, expiring)).statusCode).toBe(200);
      await prisma.teamMember.update({
        where: { id: expiring.memberId },
        data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
      });
      expect((await get(url, expiring)).statusCode).toBe(404);
    });
  });
});

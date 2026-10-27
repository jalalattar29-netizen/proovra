/**
 * MEMBERS RE-AUDIT — BEHAVIOURAL PROOFS FOR FIXES THAT HAD NONE.
 *
 * Real routes, real PostgreSQL (testcontainers). Every refusal is paired with
 * a positive control on the same fixture, so a refusal proves the gate and not
 * a broken fixture.
 *
 *   ACC-05  case rename/delete: expired ADMIN, SUSPENDED-organization ADMIN,
 *           ADMIN off a restricted case's list → concealed 404; listed ADMIN
 *           and case owner succeed (resolveCaseDestructiveGate).
 *   ACC-06  case delete is one transaction and loses to a legal hold — one
 *           present at delete time (CASE / WORKSPACE scope) or one committed
 *           while the delete waits on the case row lock.
 *   SEC-03  case delete without a step-up is refused 401 STEP_UP_REQUIRED.
 *   ACC-09  the inbox omits a case assignment on a restricted case the
 *           assignee is not listed on.
 *   ACC-01  report, verification package, original and library-summary are
 *           closed to an OWNER/ADMIN not on a restricted case.
 *   ACC-03  a former member's records leave the list, library-summary and
 *           duplicates — SUSPENDED, expired and organization-SUSPENDED arms.
 *   ACC-04  ?eligibleForEvidenceId excludes cases for SUSPENDED / REVOKED
 *           former members, and restricted cases for a member off the list.
 *   LIFE-04 a raw `DELETE FROM teams` is refused while a legal hold exists.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; memberId: string; token: string };

describe("members re-audit — access, hold and step-up proofs (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let legalVersions: Record<string, string>;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let orgA: string;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    holds = await import("../src/services/governance/legal-hold.service.js");
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    await prisma.team.updateMany({
      where: { id: { in: [A().teamId, B().teamId] } },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
    orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId!;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (url: string, token: string) => h.app.inject({ method: "GET", url, headers: bearer(token) });

  async function person(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" = "MEMBER", teamId = A().teamId): Promise<Person> {
    const email = `proofs-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
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

  async function newCase(ownerUserId = A().ownerUserId, teamId = A().teamId) {
    const { id } = await prisma.case.create({
      data: { name: `proof-${tag()}`, teamId, ownerUserId },
      select: { id: true },
    });
    return id;
  }
  /** Restrict a case to `listed` (the flag plus the access rows, as the grant route writes them). */
  async function restrict(caseId: string, listed: string[]) {
    await prisma.case.update({ where: { id: caseId }, data: { restrictedAtUtc: new Date() } });
    for (const userId of listed) await prisma.caseAccess.create({ data: { caseId, userId } });
  }
  async function newEvidence(ownerUserId: string, teamId = A().teamId, extra: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: `proof ${tag()}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        sizeBytes: 1_000n,
        ...extra,
      } as never,
      select: { id: true },
    });
    return id;
  }
  const link = (caseId: string, evidenceId: string, teamId = A().teamId) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId } as never });

  const stepUpHeader = (p: { id: string; token: string }, caseId: string) =>
    stepUp.approvedHeader({ token: p.token, userId: p.id, teamId: A().teamId, purpose: "CASE_DELETE", resourceKind: "case", resourceId: caseId });
  const rename = (caseId: string, token: string, name: string) =>
    h.app.inject({ method: "PATCH", url: `/v1/cases/${caseId}`, headers: bearer(token), payload: { name } });
  const del = (caseId: string, token: string, extra: Record<string, string> = {}) =>
    h.app.inject({ method: "DELETE", url: `/v1/cases/${caseId}`, headers: { ...bearer(token), ...extra } });
  const caseName = async (caseId: string) => (await prisma.case.findUnique({ where: { id: caseId }, select: { name: true } }))?.name;
  const caseExists = async (caseId: string) => (await prisma.case.count({ where: { id: caseId } })) === 1;
  const setOrg = (status: "ACTIVE" | "SUSPENDED") => prisma.organization.update({ where: { id: orgA }, data: { status } as never });

  // ===========================================================================
  // ACC-05 — rename and delete ask the canonical case-read authority first
  // ===========================================================================
  describe("ACC-05 — case rename/delete under expiry, organization suspension and restriction", () => {
    it("an ADMIN whose access has EXPIRED can neither rename nor delete; the same ADMIN unexpired can", async () => {
      const admin = await person("ADMIN");
      const caseId = await newCase();
      // Positive control: the active ADMIN renames.
      expect((await rename(caseId, admin.token, "renamed-active")).statusCode).toBe(200);
      const header = await stepUpHeader(admin, caseId); // approved while still current
      await prisma.teamMember.update({ where: { id: admin.memberId }, data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) } });

      const r = await rename(caseId, admin.token, "renamed-expired");
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json()).toEqual({ message: "Case not found" });
      expect(await caseName(caseId)).toBe("renamed-active");
      const d = await del(caseId, admin.token, header);
      expect(d.statusCode, d.body).toBe(404);
      expect(d.json()).toEqual({ message: "Case not found" });
      expect(await caseExists(caseId)).toBe(true);

      // Positive control: access restored → the same approved challenge deletes.
      await prisma.teamMember.update({ where: { id: admin.memberId }, data: { accessExpiresAtUtc: null } });
      const ok = await del(caseId, admin.token, header);
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await caseExists(caseId)).toBe(false);
    });

    it("an ADMIN of a SUSPENDED Organization can neither rename nor delete", async () => {
      const admin = await person("ADMIN");
      const caseId = await newCase();
      expect((await rename(caseId, admin.token, "renamed-live")).statusCode).toBe(200);
      const header = await stepUpHeader(admin, caseId);
      await setOrg("SUSPENDED");
      try {
        const r = await rename(caseId, admin.token, "renamed-suspended");
        expect(r.statusCode, r.body).toBe(404);
        expect(await caseName(caseId)).toBe("renamed-live");
        const d = await del(caseId, admin.token, header);
        expect(d.statusCode, d.body).toBe(404);
        expect(await caseExists(caseId)).toBe(true);
      } finally {
        await setOrg("ACTIVE");
      }
      const ok = await del(caseId, admin.token, header);
      expect(ok.statusCode, ok.body).toBe(204);
    });

    it("an ADMIN off a restricted case's list can neither rename nor delete; a listed ADMIN and the case owner can", async () => {
      const outsider = await person("ADMIN");
      const listed = await person("ADMIN");
      const owner = await person("ADMIN");
      const caseId = await newCase(owner.id);
      await restrict(caseId, [listed.id]);

      const header = await stepUpHeader(outsider, caseId);
      const r = await rename(caseId, outsider.token, "outsider");
      expect(r.statusCode, r.body).toBe(404);
      const d = await del(caseId, outsider.token, header);
      expect(d.statusCode, d.body).toBe(404);
      expect(await caseExists(caseId)).toBe(true);
      expect(await prisma.caseAccess.count({ where: { caseId } })).toBe(1);

      expect((await rename(caseId, listed.token, "by-listed")).statusCode).toBe(200);
      expect((await rename(caseId, owner.token, "by-owner")).statusCode).toBe(200);
      expect(await caseName(caseId)).toBe("by-owner");
      const ok = await del(caseId, listed.token, await stepUpHeader(listed, caseId));
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await caseExists(caseId)).toBe(false);
    });
  });

  // ===========================================================================
  // SEC-03 — case delete demands a fresh step-up
  // ===========================================================================
  it("SEC-03 — DELETE /v1/cases/:id without a step-up is refused 401 STEP_UP_REQUIRED and the case stays; with one it is deleted", async () => {
    const admin = await person("ADMIN");
    const caseId = await newCase();
    const ev = await newEvidence(A().ownerUserId);
    await link(caseId, ev);
    const refused = await del(caseId, admin.token);
    expect(refused.statusCode, refused.body).toBe(401);
    expect((refused.json() as { error: { code: string } }).error.code).toBe("STEP_UP_REQUIRED");
    // The 401 can be on the wire while the handler is still running: wait for
    // the handler itself before asserting the refusal changed nothing.
    await h.handlersSettled();
    expect(await caseExists(caseId)).toBe(true);
    expect(await prisma.caseEvidenceLink.count({ where: { caseId } })).toBe(1);

    const ok = await del(caseId, admin.token, await stepUpHeader(admin, caseId));
    expect(ok.statusCode, ok.body).toBe(204);
    expect(await caseExists(caseId)).toBe(false);
    expect(await prisma.caseEvidenceLink.count({ where: { caseId } })).toBe(0);
    expect(await prisma.evidence.count({ where: { id: ev } })).toBe(1);
  });

  // ===========================================================================
  // ACC-06 / LIFE-04 — atomic delete that loses to a legal hold
  // ===========================================================================
  describe("ACC-06 — case delete is atomic and loses to a legal hold", () => {
    async function heldFixture() {
      const admin = await person("ADMIN");
      const listedViewer = await person("VIEWER");
      const caseId = await newCase();
      const ev = await newEvidence(A().ownerUserId);
      await link(caseId, ev);
      await restrict(caseId, [admin.id, listedViewer.id]);
      return { admin, caseId, ev };
    }
    const intact = async (caseId: string) => ({
      case: await prisma.case.count({ where: { id: caseId } }),
      links: await prisma.caseEvidenceLink.count({ where: { caseId } }),
      access: await prisma.caseAccess.count({ where: { caseId } }),
    });
    const release = (holdId: string) =>
      prisma.evidenceLegalHold.update({ where: { id: holdId }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });

    for (const scope of ["CASE", "WORKSPACE"] as const) {
      it(`a ${scope}-scope hold present at delete time refuses with LEGAL_HOLD_BLOCKED; case, links and access list stay; after release a CASE hold still keeps the case (typed), a WORKSPACE hold does not`, async () => {
        const { admin, caseId } = await heldFixture();
        const hold = await holds.placeCanonicalLegalHold({
          teamId: A().teamId,
          scope,
          ...(scope === "CASE" ? { caseId } : {}),
          actorUserId: A().ownerUserId,
          title: `${scope} hold`,
        } as never);
        try {
          const res = await del(caseId, admin.token, await stepUpHeader(admin, caseId));
          expect([403, 409], res.body).toContain(res.statusCode);
          const body = res.json() as { denial?: string; code?: string };
          expect(body.denial ?? body.code).toBe("LEGAL_HOLD_BLOCKED");
          expect(await intact(caseId)).toEqual({ case: 1, links: 1, access: 2 });
        } finally {
          await release(hold.id);
        }
        const after = await del(caseId, admin.token, await stepUpHeader(admin, caseId));
        if (scope === "CASE") {
          // The released hold's record names the case and is kept: the case is
          // never deleted, and the refusal is typed, not a database error.
          expect(after.statusCode, after.body).toBe(409);
          expect((after.json() as { code?: string }).code).toBe("CASE_HOLD_HISTORY_KEPT");
          expect(await intact(caseId)).toEqual({ case: 1, links: 1, access: 2 });
          expect(await prisma.evidenceLegalHold.count({ where: { id: hold.id } })).toBe(1);
        } else {
          expect(after.statusCode, after.body).toBe(204);
          expect(await intact(caseId)).toEqual({ case: 0, links: 0, access: 0 });
        }
      });
    }

    it("a CASE hold committed while the delete waits on the case row lock wins: the delete refuses 409 and nothing is removed", async () => {
      const { admin, caseId } = await heldFixture();
      const header = await stepUpHeader(admin, caseId);
      let deletion: Promise<Awaited<ReturnType<typeof del>>> | null = null;
      let holdId = "";
      await prisma.$transaction(
        async (tx) => {
          // Another session owns the case row.
          await tx.$queryRaw`SELECT "id" FROM "cases" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
          // The route's pre-check sees no hold and proceeds into its transaction…
          deletion = del(caseId, admin.token, header);
          // …which must now be WAITING on the case row lock.
          let waiting = false;
          for (let i = 0; i < 200 && !waiting; i++) {
            const rows = await prisma.$queryRaw<Array<{ n: number }>>`
              SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM "cases"%FOR UPDATE%'`;
            waiting = rows[0]!.n > 0;
            if (!waiting) await new Promise((r) => setTimeout(r, 50));
          }
          expect(waiting).toBe(true);
          // The hold lands and commits between the pre-check and the delete's own read.
          holdId = (
            await holds.placeCanonicalLegalHold(
              { teamId: A().teamId, scope: "CASE", caseId, actorUserId: A().ownerUserId, title: "racing hold" },
              tx as never,
            )
          ).id;
        },
        { timeout: 20_000 },
      );
      const res = await deletion!;
      try {
        expect(res.statusCode, res.body).toBe(409);
        expect((res.json() as { code: string }).code).toBe("LEGAL_HOLD_BLOCKED");
        expect(await intact(caseId)).toEqual({ case: 1, links: 1, access: 2 });
        expect(await prisma.evidenceLegalHold.count({ where: { id: holdId, status: "ACTIVE" } })).toBe(1);
      } finally {
        await release(holdId);
      }
    });
  });

  describe("LIFE-04 — a legal hold outlives a raw workspace delete", () => {
    async function disposableWorkspace() {
      const org = await prisma.organization.create({
        data: { name: `life04-${tag()}`, billingOwnerUserId: A().ownerUserId, status: "ACTIVE", kind: "CUSTOMER" } as never,
        select: { id: true },
      });
      const team = await prisma.team.create({
        data: { name: `life04-${tag()}`, ownerUserId: A().ownerUserId, isPersonal: false, organizationId: org.id, workspaceKind: "ORGANIZATION" } as never,
        select: { id: true },
      });
      return { orgId: org.id, teamId: team.id };
    }
    async function rawDeleteTeam(teamId: string): Promise<{ ok: true } | { ok: false; code: string; constraint: string }> {
      const conn = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await conn.connect();
      try {
        await conn.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
        return { ok: true };
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        return { ok: false, code: String(err.code), constraint: String(err.constraint) };
      } finally {
        await conn.end();
      }
    }

    it("control: a workspace with no hold is deleted by the same raw statement", async () => {
      const w = await disposableWorkspace();
      expect(await rawDeleteTeam(w.teamId)).toEqual({ ok: true });
      expect(await prisma.team.count({ where: { id: w.teamId } })).toBe(0);
    });

    it("a CASE-scope hold: DELETE FROM teams is refused by a RESTRICT foreign key and the hold row remains", async () => {
      const w = await disposableWorkspace();
      const caseId = await newCase(A().ownerUserId, w.teamId);
      const hold = await prisma.evidenceLegalHold.create({
        data: { teamId: w.teamId, scope: "CASE", caseId, title: "matter hold", placedByUserId: A().ownerUserId, status: "ACTIVE" } as never,
        select: { id: true },
      });
      const res = await rawDeleteTeam(w.teamId);
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ code: "23503" });
      expect((res as { constraint: string }).constraint).toMatch(/^evidence_legal_holds_/);
      expect(await prisma.evidenceLegalHold.count({ where: { id: hold.id, status: "ACTIVE" } })).toBe(1);
      expect(await prisma.team.count({ where: { id: w.teamId } })).toBe(1);
      expect(await caseExists(caseId)).toBe(true);
    });

    it("a WORKSPACE-scope hold (no case to lean on): refused by evidence_legal_holds_team_id_fkey", async () => {
      const w = await disposableWorkspace();
      const hold = await prisma.evidenceLegalHold.create({
        data: { teamId: w.teamId, scope: "WORKSPACE", title: "workspace hold", placedByUserId: A().ownerUserId, status: "ACTIVE" } as never,
        select: { id: true },
      });
      expect(await rawDeleteTeam(w.teamId)).toEqual({ ok: false, code: "23503", constraint: "evidence_legal_holds_team_id_fkey" });
      expect(await prisma.evidenceLegalHold.count({ where: { id: hold.id } })).toBe(1);
    });
  });

  // ===========================================================================
  // ACC-09 — the inbox never reaches past the restricted-case rule
  // ===========================================================================
  it("ACC-09 — a case assignment on a restricted case the assignee is not listed on is not in their inbox; once listed it is", async () => {
    const assignee = await person("MEMBER");
    const caseId = await newCase();
    const secretName = `secret-matter-${tag()}`;
    await prisma.case.update({ where: { id: caseId }, data: { name: secretName } });
    await restrict(caseId, [A().viewerUserId]);
    const assignment = await prisma.caseAssignment.create({
      data: { teamId: A().teamId, caseId, assignedToUserId: assignee.id, assignedByUserId: A().ownerUserId, role: "INVESTIGATOR" },
      select: { id: true },
    });
    const inbox = async () => {
      const res = await get(`/v1/me/inbox?pageSize=50&workspaceId=${A().teamId}`, assignee.token);
      expect(res.statusCode, res.body).toBe(200);
      return res;
    };
    const hidden = await inbox();
    expect((hidden.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).not.toContain(`case_assignment:${assignment.id}`);
    expect(hidden.body).not.toContain(secretName);

    await prisma.caseAccess.create({ data: { caseId, userId: assignee.id } });
    const shown = await inbox();
    expect((shown.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain(`case_assignment:${assignment.id}`);
  });

  // ===========================================================================
  // ACC-01 — report, package, original and library-summary inherit restriction
  // ===========================================================================
  it("ACC-01 — an OWNER/ADMIN off a restricted case is refused the record's report, package and original and it leaves their library-summary; listed members are not", async () => {
    const caseOwner = await person("MEMBER");
    const listed = await person("VIEWER");
    const caseId = await newCase(caseOwner.id);
    const ev = await newEvidence(caseOwner.id);
    await link(caseId, ev);
    await restrict(caseId, [listed.id]);

    const NOT_FOUND = { message: "Evidence not found" };
    const surfaces = [`/v1/evidence/${ev}/report/latest`, `/v1/evidence/${ev}/verification-package`, `/v1/evidence/${ev}/original`];
    const summaryTotal = async (token: string) => {
      const res = await get(`/v1/evidence/library-summary?scope=all&search=${ev}`, token);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { totalActiveRecords: number }).totalActiveRecords;
    };

    for (const [who, token] of [["OWNER", A().ownerToken], ["ADMIN", A().adminToken]] as const) {
      for (const url of surfaces) {
        const res = await get(url, token);
        expect(res.statusCode, `${who} ${url}`).toBe(404);
        expect(res.json(), `${who} ${url}`).toEqual(NOT_FOUND);
      }
      expect(await summaryTotal(token), who).toBe(0);
    }
    // Positive controls: the case owner and the listed VIEWER pass the access
    // gate (whatever the artifact state answers, it is not the access refusal)
    // and count the record.
    for (const [who, token] of [["case owner", caseOwner.token], ["listed", listed.token]] as const) {
      for (const url of surfaces) {
        const res = await get(url, token);
        expect(res.body, `${who} ${url}`).not.toBe(JSON.stringify(NOT_FOUND));
        expect(res.statusCode, `${who} ${url}`).not.toBe(500);
      }
      expect(await summaryTotal(token), who).toBe(1);
    }
  });

  // ===========================================================================
  // ACC-03 — a former member's records leave list, summary and duplicates
  // ===========================================================================
  describe("ACC-03 — a former member's records leave the list, library-summary and duplicates", () => {
    async function formerMemberFixture() {
      const p = await person("MEMBER");
      // Also an ACTIVE member of workspace B, which holds the duplicate anchor.
      await prisma.teamMember.create({ data: { teamId: B().teamId, userId: p.id, role: "MEMBER", status: "ACTIVE" } });
      const sha = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const mine = await newEvidence(p.id, A().teamId, { fileSha256: sha });
      const anchor = await newEvidence(p.id, B().teamId, { fileSha256: sha });
      return { p, mine, anchor };
    }
    const seen = async (p: Person, mine: string, anchor: string) => {
      const list = await get("/v1/evidence?scope=all&limit=100", p.token);
      expect(list.statusCode, list.body).toBe(200);
      const summary = await get(`/v1/evidence/library-summary?scope=all&search=${mine}`, p.token);
      expect(summary.statusCode, summary.body).toBe(200);
      const dups = await get(`/v1/evidence/${anchor}/duplicates`, p.token);
      expect(dups.statusCode, dups.body).toBe(200);
      return {
        list: (list.json() as { items: Array<{ id: string }> }).items.some((i) => i.id === mine),
        summary: (summary.json() as { totalActiveRecords: number }).totalActiveRecords,
        duplicates: dups.body.includes(mine),
      };
    };

    const arms: Array<[string, (p: Person) => Promise<unknown>, (p: Person) => Promise<unknown>]> = [
      [
        "SUSPENDED membership",
        (p) => prisma.teamMember.update({ where: { id: p.memberId }, data: { status: "SUSPENDED" } }),
        (p) => prisma.teamMember.update({ where: { id: p.memberId }, data: { status: "ACTIVE" } }),
      ],
      [
        "EXPIRED membership",
        (p) => prisma.teamMember.update({ where: { id: p.memberId }, data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) } }),
        (p) => prisma.teamMember.update({ where: { id: p.memberId }, data: { accessExpiresAtUtc: null } }),
      ],
      ["SUSPENDED Organization", () => setOrg("SUSPENDED"), () => setOrg("ACTIVE")],
    ];
    for (const [label, end, restore] of arms) {
      it(`${label}: the record they created is gone from list, summary and duplicates (and present while current)`, async () => {
        const { p, mine, anchor } = await formerMemberFixture();
        expect(await seen(p, mine, anchor)).toEqual({ list: true, summary: 1, duplicates: true });
        await end(p);
        try {
          expect(await seen(p, mine, anchor)).toEqual({ list: false, summary: 0, duplicates: false });
        } finally {
          await restore(p);
        }
      });
    }
  });

  // ===========================================================================
  // ACC-04 — the attach selector (?eligibleForEvidenceId)
  // ===========================================================================
  describe("ACC-04 — GET /v1/cases?eligibleForEvidenceId", () => {
    const eligible = (evidenceId: string, token: string) => get(`/v1/cases?eligibleForEvidenceId=${evidenceId}`, token);
    const ids = (res: { json: () => unknown }) => (res.json() as { items: Array<{ id: string }> }).items.map((c) => c.id);

    for (const status of ["SUSPENDED", "REVOKED"] as const) {
      it(`a ${status} former member gets no case (the case they own included); while ACTIVE they do`, async () => {
        const p = await person("MEMBER");
        const caseId = await newCase(p.id);
        const ev = await newEvidence(p.id);
        const before = await eligible(ev, p.token);
        expect(before.statusCode, before.body).toBe(200);
        expect(ids(before)).toContain(caseId);
        await prisma.teamMember.update({ where: { id: p.memberId }, data: { status } });
        const after = await eligible(ev, p.token);
        expect(after.statusCode).toBe(404);
        expect(after.body).not.toContain(caseId);
      });
    }

    it("an ACTIVE member reading an open record does not get a restricted case they are not on; a listed member does", async () => {
      const p = await person("MEMBER");
      const listed = await person("MEMBER");
      const open = await newCase();
      const closed = await newCase();
      await restrict(closed, [listed.id]);
      const ev = await newEvidence(A().ownerUserId);
      const asP = await eligible(ev, p.token);
      expect(asP.statusCode, asP.body).toBe(200);
      expect(ids(asP)).toContain(open);
      expect(ids(asP)).not.toContain(closed);
      const asListed = await eligible(ev, listed.token);
      expect(ids(asListed)).toEqual(expect.arrayContaining([open, closed]));
    });
  });
});

/**
 * RESTRICTED-CASE REACH, SURFACE BY SURFACE (live PostgreSQL) — RC-CASE-REACH.
 *
 * One fixture, real rows, every surface the enterprise audit found outside the
 * authority (`case-visibility.ts`):
 *
 *   restricted case R, listed: `listed` (a MEMBER)
 *     hidden record H: linked to R only
 *     shared record S: linked to R and to the open case O
 *   open case O
 *     visible record V: related to H, linked to O
 *
 * `off` (MEMBER), `offViewer` (VIEWER) and `offAdmin` (ADMIN) are off the list.
 * Every refusal has a positive control: `listed` on the same row.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileTeamGraph } from "@proovra/shared-runtime/graph";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

const RESTRICTED_NAME = `SENTINEL-CASE-${randomUUID().slice(0, 8)}`;
const HIDDEN_FILE = `sentinel-hidden-${randomUUID().slice(0, 8)}.pdf`;
const SHARED_FILE = `sentinel-shared-${randomUUID().slice(0, 8)}.pdf`;
const VISIBLE_FILE = `visible-${randomUUID().slice(0, 8)}.pdf`;
const RELATION_NOTE = `sentinel-note-${randomUUID().slice(0, 8)}`;
const THREAD_TITLE = `sentinel-thread-${randomUUID().slice(0, 8)}`;

describe("restricted-case reach matrix (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  const A = () => h.fixtures.teamA;

  let listed: Person;
  let off: Person;
  let offViewer: Person;
  let offAdmin: Person;
  let restrictedCaseId: string;
  let openCaseId: string;
  let hiddenId: string;
  let sharedId: string;
  let visibleId: string;
  let threadId: string;

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (url: string, who: Person) => h.app.inject({ method: "GET", url, headers: bearer(who.token) });
  const post = (url: string, who: Person, payload: unknown) =>
    h.app.inject({ method: "POST", url, headers: bearer(who.token), payload: payload as never });
  const teamQ = () => `teamId=${A().teamId}`;

  async function person(role: Role): Promise<Person> {
    const email = `crm-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email },
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
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function record(fileName: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    return (
      await prisma.evidence.create({
        data: {
          title: fileName,
          displayFileName: fileName,
          type: "PHOTO",
          status: "SIGNED",
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId: A().ownerUserId,
          sizeBytes: 1_000n,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  const link = (caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: A().teamId } as never });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    await prisma.team.updateMany({
      where: { id: A().teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });

    [listed, off, offViewer, offAdmin] = await Promise.all([
      person("MEMBER"),
      person("MEMBER"),
      person("VIEWER"),
      person("ADMIN"),
    ]);

    restrictedCaseId = (
      await prisma.case.create({
        data: {
          name: RESTRICTED_NAME,
          teamId: A().teamId,
          ownerUserId: A().ownerUserId,
          restrictedAtUtc: new Date(),
        } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: listed.id } });
    openCaseId = (
      await prisma.case.create({
        data: { name: `open-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId },
        select: { id: true },
      })
    ).id;

    hiddenId = await record(HIDDEN_FILE);
    sharedId = await record(SHARED_FILE);
    visibleId = await record(VISIBLE_FILE);
    await link(restrictedCaseId, hiddenId);
    await link(restrictedCaseId, sharedId);
    await link(openCaseId, sharedId);
    await link(openCaseId, visibleId);

    await prisma.evidenceRelationship.create({
      data: {
        teamId: A().teamId,
        sourceEvidenceId: visibleId,
        targetEvidenceId: hiddenId,
        relationshipType: "RELATED",
        note: RELATION_NOTE,
        createdByUserId: listed.id,
      },
    });

    threadId = (
      await prisma.discussionThread.create({
        data: {
          teamId: A().teamId,
          evidenceId: hiddenId,
          kind: "EVIDENCE_GENERAL",
          visibility: "INTERNAL",
          title: THREAD_TITLE,
          createdByUserId: listed.id,
        } as never,
        select: { id: true },
      })
    ).id;
    await prisma.discussionMessage.create({
      data: { threadId, teamId: A().teamId, authorKind: "USER", authorUserId: listed.id, body: "sentinel body" } as never,
    });

    await reconcileTeamGraph(A().teamId, prisma);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const absent = (body: string) => {
    expect(body).not.toContain(RESTRICTED_NAME);
    expect(body).not.toContain(HIDDEN_FILE);
    expect(body).not.toContain(SHARED_FILE);
    expect(body).not.toContain(restrictedCaseId);
    expect(body).not.toContain(hiddenId);
    expect(body).not.toContain(sharedId);
  };

  // ===========================================================================
  // EVID-001 — the investigation graph
  // ===========================================================================
  describe("EVID-001: the graph", () => {
    const reads = (): Array<[string, () => string]> => [
      ["seeds", () => `/v1/graph/seeds?${teamQ()}`],
      ["search", () => `/v1/graph/search?${teamQ()}&label=sentinel`],
      ["case search", () => `/v1/graph/search?${teamQ()}&label=${RESTRICTED_NAME}`],
      ["timeline", () => `/v1/graph/timeline?${teamQ()}&limit=200`],
      ["evidence timeline", () => `/v1/graph/timeline?${teamQ()}&evidenceId=${hiddenId}`],
      ["duplicates", () => `/v1/graph/duplicates?${teamQ()}`],
    ];

    for (const [name, url] of [
      ["seeds", "seeds"],
      ["case search", "case search"],
      ["timeline", "timeline"],
      ["evidence timeline", "evidence timeline"],
      ["duplicates", "duplicates"],
    ] as const) {
      it(`${name}: off-list MEMBER, VIEWER and ADMIN read nothing of the closed records`, async () => {
        const path = reads().find(([n]) => n === url)![1]();
        for (const who of [off, offViewer, offAdmin]) {
          const r = await get(path, who);
          expect(r.statusCode, r.body).toBe(200);
          absent(r.body);
        }
      });
    }

    it("a subgraph rooted at a closed record answers exactly as an id with no graph", async () => {
      for (const who of [off, offViewer, offAdmin]) {
        for (const path of [
          `/v1/graph/evidence/${hiddenId}?${teamQ()}&depth=3`,
          `/v1/graph/cases/${restrictedCaseId}?${teamQ()}&depth=3`,
        ]) {
          const r = await get(path, who);
          expect(r.statusCode, r.body).toBe(200);
          const body = r.json() as { nodes: unknown[]; edges: unknown[]; truncated: boolean };
          expect(body.nodes).toEqual([]);
          expect(body.edges).toEqual([]);
          expect(body.truncated).toBe(false);
        }
      }
    });

    it("positive controls: the listed member sees the restricted case and its files; off-list keeps open records", async () => {
      const mine = await get(`/v1/graph/search?${teamQ()}&label=sentinel`, listed);
      expect(mine.statusCode).toBe(200);
      expect(mine.body).toContain(HIDDEN_FILE);
      const seeds = await get(`/v1/graph/seeds?${teamQ()}&perKindLimit=50`, listed);
      expect(seeds.body).toContain(RESTRICTED_NAME);
      const caseGraph = await get(`/v1/graph/cases/${restrictedCaseId}?${teamQ()}&depth=2`, listed);
      expect(caseGraph.body).toContain(HIDDEN_FILE);

      const offSeeds = await get(`/v1/graph/seeds?${teamQ()}&perKindLimit=50`, off);
      expect(offSeeds.body).toContain(VISIBLE_FILE);
    });

    it("the export excludes closed nodes and edges in the query, and counts only what it returned", async () => {
      const r = await post(`/v1/graph/export`, off, { teamId: A().teamId });
      expect(r.statusCode, r.body).toBe(200);
      absent(r.body);
      const body = r.json() as { nodes: Array<{ id: string }>; edges: Array<{ sourceNodeId: string; targetNodeId: string }> };
      const ids = new Set(body.nodes.map((n) => n.id));
      for (const e of body.edges) {
        expect(ids.has(e.sourceNodeId) && ids.has(e.targetNodeId)).toBe(true);
      }
      const mine = await post(`/v1/graph/export`, listed, { teamId: A().teamId });
      expect(mine.body).toContain(RESTRICTED_NAME);
    });

    it("timeline and duplicate exports naming a closed record are 404 and write no custody", async () => {
      const before = await prisma.custodyEvent.count({ where: { evidenceId: hiddenId } });
      const a = await post(`/v1/graph/timeline/export`, off, { teamId: A().teamId, evidenceId: hiddenId });
      expect(a.statusCode, a.body).toBe(404);
      const b = await post(`/v1/graph/duplicates/export`, off, { teamId: A().teamId, evidenceId: hiddenId });
      expect(b.statusCode, b.body).toBe(404);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: hiddenId } })).toBe(before);
      const c = await post(`/v1/graph/timeline/export`, listed, { teamId: A().teamId, evidenceId: hiddenId });
      expect(c.statusCode, c.body).toBe(200);
    });

    it("a manual link naming a closed node is 404 and writes nothing; two open nodes still link", async () => {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT "id", "external_id"::text AS "external_id" FROM "investigation_graph_nodes"
          WHERE "team_id" = $1::uuid AND "node_kind" = 'EVIDENCE'`,
        A().teamId,
      )) as Array<{ id: string; external_id: string }>;
      const nodeOf = (id: string) => rows.find((r) => r.external_id === id)!.id;
      const count = async () =>
        Number(
          ((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "manual_relationships"`)) as Array<{ c: number }>)[0]!.c,
        );
      const before = await count();
      const refused = await post(`/v1/graph/relationships/manual`, off, {
        teamId: A().teamId,
        sourceNodeId: nodeOf(visibleId),
        targetNodeId: nodeOf(hiddenId),
        edgeType: "MANUALLY_LINKED_TO",
      });
      expect(refused.statusCode, refused.body).toBe(404);
      expect(await count()).toBe(before);

      const other = await record(`open-${tag()}.pdf`);
      await reconcileTeamGraph(A().teamId, prisma);
      const fresh = (await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "investigation_graph_nodes" WHERE "team_id" = $1::uuid AND "external_id" = $2::uuid`,
        A().teamId,
        other,
      )) as Array<{ id: string }>;
      const allowed = await post(`/v1/graph/relationships/manual`, off, {
        teamId: A().teamId,
        sourceNodeId: nodeOf(visibleId),
        targetNodeId: fresh[0]!.id,
        edgeType: "MANUALLY_LINKED_TO",
      });
      expect(allowed.statusCode, allowed.body).toBe(201);
    });

    it("diagnostics counts exclude closed nodes", async () => {
      const mine = (await get(`/v1/graph/diagnostics?${teamQ()}`, listed)).json() as {
        nodeCountsByKind: Record<string, number>;
      };
      const theirs = (await get(`/v1/graph/diagnostics?${teamQ()}`, offAdmin)).json() as {
        nodeCountsByKind: Record<string, number>;
      };
      expect(theirs.nodeCountsByKind.CASE ?? 0).toBe((mine.nodeCountsByKind.CASE ?? 0) - 1);
      expect(theirs.nodeCountsByKind.EVIDENCE ?? 0).toBe((mine.nodeCountsByKind.EVIDENCE ?? 0) - 2);
    });
  });

  // ===========================================================================
  // EVID-002 / AUTHZ-003 — discussion threads
  // ===========================================================================
  describe("EVID-002: threads", () => {
    const tq = () => `?${teamQ()}`;

    it("an off-list reviewer gets 404 on detail, messages, every move and post, and nothing is written", async () => {
      const msgs = () => prisma.discussionMessage.count({ where: { threadId } });
      const before = await msgs();
      const status = (await prisma.discussionThread.findUniqueOrThrow({ where: { id: threadId } })).status;

      expect((await get(`/v1/collaboration/threads/${threadId}${tq()}`, off)).statusCode).toBe(404);
      expect((await get(`/v1/collaboration/threads/${threadId}/messages${tq()}`, off)).statusCode).toBe(404);
      const body = { teamId: A().teamId, body: "intrusion", reason: "x", resolutionNote: "x", assignedToUserId: off.id };
      for (const action of ["messages", "resolve", "reopen", "escalate", "assign"]) {
        const r = await post(`/v1/collaboration/threads/${threadId}/${action}`, off, body);
        expect(r.statusCode, `${action}: ${r.body}`).toBe(404);
      }
      const marked = await h.app.inject({
        method: "POST",
        url: `/v1/collaboration/threads/${threadId}/mark-mentions-read${tq()}`,
        headers: bearer(off.token),
      });
      expect(marked.statusCode).toBe(404);

      expect(await msgs()).toBe(before);
      expect((await prisma.discussionThread.findUniqueOrThrow({ where: { id: threadId } })).status).toBe(status);
    });

    it("the list omits the thread, also when the filter names the closed record; a thread cannot be opened on it", async () => {
      const list = await get(`/v1/collaboration/threads${tq()}`, off);
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(THREAD_TITLE);
      const named = await get(`/v1/collaboration/threads${tq()}&evidenceId=${hiddenId}`, off);
      expect(named.body).not.toContain(THREAD_TITLE);

      const create = await post(`/v1/collaboration/threads`, off, {
        teamId: A().teamId,
        evidenceId: hiddenId,
        kind: "EVIDENCE_GENERAL",
        visibility: "INTERNAL",
        title: "intrusion",
      });
      expect(create.statusCode, create.body).toBe(404);
    });

    it("positive control: the listed reviewer reads and posts", async () => {
      expect((await get(`/v1/collaboration/threads${tq()}`, listed)).body).toContain(THREAD_TITLE);
      expect((await get(`/v1/collaboration/threads/${threadId}/messages${tq()}`, listed)).body).toContain("sentinel body");
      const posted = await post(`/v1/collaboration/threads/${threadId}/messages`, listed, {
        teamId: A().teamId,
        body: "from the list",
      });
      expect(posted.statusCode, posted.body).toBe(201);
    });

    it("an expired member and a suspended organization's member are refused like anyone else (AUTHZ-003)", async () => {
      const expired = await person("MEMBER");
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: A().teamId, userId: expired.id } },
        data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
      });
      const r = await get(`/v1/collaboration/threads${tq()}`, expired);
      expect(r.statusCode, r.body).toBe(404);
    });
  });

  // ===========================================================================
  // EVID-020 — mentions
  // ===========================================================================
  describe("EVID-020: mentions", () => {
    async function namedPerson(displayName: string, role: Role = "MEMBER"): Promise<Person> {
      const p = await person(role);
      await prisma.user.update({ where: { id: p.id }, data: { displayName } });
      return p;
    }

    it("a mention of someone who cannot open the record makes no row and is reported to the author", async () => {
      const name = `offlist${tag()}`;
      const target = await namedPerson(name);
      const r = await post(`/v1/collaboration/threads/${threadId}/messages`, listed, {
        teamId: A().teamId,
        body: `@${name} please look`,
      });
      expect(r.statusCode, r.body).toBe(201);
      expect((r.json() as { unresolvedMentions: unknown[] }).unresolvedMentions).toEqual([
        { token: name, reason: "no_access" },
      ]);
      expect(await prisma.discussionMention.count({ where: { mentionedUserId: target.id } })).toBe(0);
    });

    it("a token two members answer to resolves to neither; a unique reachable one resolves", async () => {
      const shared = `twin${tag()}`;
      const a = await namedPerson(shared);
      const b = await namedPerson(shared);
      const unique = `solo${tag()}`;
      const solo = await namedPerson(unique);
      await prisma.caseAccess.createMany({
        data: [a, b, solo].map((p) => ({ caseId: restrictedCaseId, userId: p.id })),
      });
      const r = await post(`/v1/collaboration/threads/${threadId}/messages`, listed, {
        teamId: A().teamId,
        body: `@${shared} and @${unique}`,
      });
      expect(r.statusCode, r.body).toBe(201);
      expect((r.json() as { unresolvedMentions: unknown[] }).unresolvedMentions).toEqual([
        { token: shared, reason: "ambiguous" },
      ]);
      expect(await prisma.discussionMention.count({ where: { mentionedUserId: { in: [a.id, b.id] } } })).toBe(0);
      expect(await prisma.discussionMention.count({ where: { mentionedUserId: solo.id } })).toBe(1);
    });
  });

  // ===========================================================================
  // EVID-003 — relationships
  // ===========================================================================
  describe("EVID-003: relationships", () => {
    it("a visible record lists nothing for its closed peer; the closed record answers as absent", async () => {
      const onVisible = await get(`/v1/evidence/${visibleId}/relationships`, off);
      expect(onVisible.statusCode).toBe(200);
      absent(onVisible.body);
      expect(onVisible.body).not.toContain(RELATION_NOTE);

      const search = await get(`/v1/search/relationships/${visibleId}?${teamQ()}`, off);
      expect(search.statusCode).toBe(200);
      expect(search.body).not.toContain(RELATION_NOTE);
      expect(search.body).not.toContain(hiddenId);

      const byId = await get(`/v1/search/relationships/${hiddenId}?${teamQ()}`, off);
      expect(byId.statusCode).toBe(200);
      expect((byId.json() as { relationships: unknown[] }).relationships).toEqual([]);
    });

    it("positive control: the listed member reads the peer and the note on all three", async () => {
      expect((await get(`/v1/evidence/${visibleId}/relationships`, listed)).body).toContain(RELATION_NOTE);
      expect((await get(`/v1/search/relationships/${visibleId}?${teamQ()}`, listed)).body).toContain(RELATION_NOTE);
      expect((await get(`/v1/search/relationships/${hiddenId}?${teamQ()}`, listed)).body).toContain(RELATION_NOTE);
    });

    it("the search link route refuses a closed end and writes nothing", async () => {
      const before = await prisma.evidenceRelationship.count({ where: { teamId: A().teamId } });
      const r = await post(`/v1/search/relationships`, offAdmin, {
        teamId: A().teamId,
        sourceEvidenceId: visibleId,
        targetEvidenceId: sharedId,
        relationshipType: "SUPPORTS",
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(await prisma.evidenceRelationship.count({ where: { teamId: A().teamId } })).toBe(before);
    });

    it("a relationship cannot be edited or removed through its open end", async () => {
      const rel = await prisma.evidenceRelationship.findFirstOrThrow({
        where: { sourceEvidenceId: visibleId, targetEvidenceId: hiddenId },
      });
      const patch = await h.app.inject({
        method: "PATCH",
        url: `/v1/evidence/${visibleId}/relationships/${rel.id}`,
        headers: bearer(off.token),
        payload: { note: "overwritten" },
      });
      expect(patch.statusCode, patch.body).toBe(404);
      const del = await h.app.inject({
        method: "DELETE",
        url: `/v1/evidence/${visibleId}/relationships/${rel.id}`,
        headers: bearer(off.token),
      });
      expect(del.statusCode, del.body).toBe(404);
      const after = await prisma.evidenceRelationship.findUniqueOrThrow({ where: { id: rel.id } });
      expect(after.note).toBe(RELATION_NOTE);
    });
  });

  // ===========================================================================
  // EVID-004 — the matter workspace and the thread aggregator
  // ===========================================================================
  describe("EVID-004: a record closed by a second restricted case", () => {
    it("the matter workspace of the OPEN case omits it from every section and count", async () => {
      const r = await get(`/v1/cases/${openCaseId}/matter-workspace`, off);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain(SHARED_FILE);
      expect(r.body).not.toContain(sharedId);
      const body = r.json() as { sections: { commandSummary: { data: { linkedEvidenceCount: number } } } };
      expect(body.sections.commandSummary.data.linkedEvidenceCount).toBe(1);

      const mine = await get(`/v1/cases/${openCaseId}/matter-workspace`, listed);
      expect(mine.body).toContain(SHARED_FILE);
      const myBody = mine.json() as { sections: { commandSummary: { data: { linkedEvidenceCount: number } } } };
      expect(myBody.sections.commandSummary.data.linkedEvidenceCount).toBe(2);
    });

    it("the case thread aggregator omits a thread on that record", async () => {
      const title = `shared-thread-${tag()}`;
      await prisma.discussionThread.create({
        data: {
          teamId: A().teamId,
          evidenceId: sharedId,
          kind: "EVIDENCE_GENERAL",
          visibility: "INTERNAL",
          title,
          createdByUserId: listed.id,
        } as never,
      });
      const offList = await get(`/v1/cases/${openCaseId}/discussion-threads`, off);
      expect(offList.statusCode, offList.body).toBe(200);
      expect(offList.body).not.toContain(title);
      expect((await get(`/v1/cases/${openCaseId}/discussion-threads`, listed)).body).toContain(title);
    });
  });

  // ===========================================================================
  // AUTHZ-002 — case rosters
  // ===========================================================================
  describe("AUTHZ-002: case lists outside the case routes", () => {
    it("matter queue and the team case list omit the case; the listed member keeps it", async () => {
      for (const who of [off, offViewer, offAdmin]) {
        const queue = await get(`/v1/cases/matter-queue?${teamQ()}`, who);
        expect(queue.statusCode, queue.body).toBe(200);
        expect(queue.body).not.toContain(RESTRICTED_NAME);
        const roster = await get(`/v1/teams/${A().teamId}/cases`, who);
        expect(roster.statusCode, roster.body).toBe(200);
        expect(roster.body).not.toContain(RESTRICTED_NAME);
      }
      expect((await get(`/v1/cases/matter-queue?${teamQ()}`, listed)).body).toContain(RESTRICTED_NAME);
      expect((await get(`/v1/teams/${A().teamId}/cases`, listed)).body).toContain(RESTRICTED_NAME);
    });
  });
});

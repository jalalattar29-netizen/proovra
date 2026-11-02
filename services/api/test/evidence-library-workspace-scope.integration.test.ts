/**
 * EVID-009 — the library answers for the workspace on screen.
 *
 * One person, a Personal space and two Organizations, with real records in each.
 * With "Northwind Legal" in the header the list mixed in the other Organization
 * and Personal, and the cards labelled "Workspace total" counted all of them.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
  type OrganizationTenant,
  type SeededUser,
} from "./point7/product-fixtures.js";

const WORKSPACE_HEADER = "x-proovra-workspace-id";

describe("Evidence Library workspace scope (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let deps: FixtureDeps;
  const tag = `els-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  let person: SeededUser;
  let personalTeamId: string;
  let orgA: OrganizationTenant;
  let orgB: OrganizationTenant;
  const records = { personal: "", legacy: "", a: "", b: "", dupA: "", dupB: "" };

  const get = (url: string, token: string, headers: Record<string, string> = {}) =>
    harness.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });

  const inWorkspace = (workspaceId: string) => ({ [WORKSPACE_HEADER]: workspaceId });

  function mint(userId: string, email: string): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );
  }

  async function record(
    ownerUserId: string,
    teamId: string | null,
    organizationId: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.evidence.create({
      data: { ownerUserId, teamId, organizationId, type: "PHOTO", status: "SIGNED", ...extra } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function join(org: OrganizationTenant, userId: string) {
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId, role: "ORG_MEMBER" },
    });
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId, role: "MEMBER", status: "ACTIVE" },
    });
  }

  const listed = async (headers: Record<string, string>, query = "scope=active") => {
    const res = await get(`/v1/evidence?${query}&limit=50`, person.token, headers);
    expect(res.statusCode, res.body).toBe(200);
    return new Set((res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id));
  };

  const totalOf = async (headers: Record<string, string>) => {
    const res = await get("/v1/evidence/library-summary?scope=active", person.token, headers);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { totalActiveRecords: number }).totalActiveRecords;
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    deps = { prisma: prisma as never, tag, mintToken: mint };

    person = await seedUser(deps, "library");
    const personal = await bootstrapPersonalSpace(deps, person.userId);
    personalTeamId = personal.teamId;
    orgA = await seedOrganizationTenant(deps, {});
    orgB = await seedOrganizationTenant(deps, {});
    await join(orgA, person.userId);
    await join(orgB, person.userId);

    const hash = "a".repeat(64);
    records.personal = await record(person.userId, personalTeamId, personal.organizationId);
    records.legacy = await record(person.userId, null, null);
    records.a = await record(person.userId, orgA.workspaceId, orgA.organizationId);
    records.b = await record(person.userId, orgB.workspaceId, orgB.organizationId);
    records.dupA = await record(person.userId, orgA.workspaceId, orgA.organizationId, { fileSha256: hash });
    records.dupB = await record(person.userId, orgB.workspaceId, orgB.organizationId, { fileSha256: hash });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("the list differs by workspace and holds only that workspace's records", async () => {
    const a = await listed(inWorkspace(orgA.workspaceId));
    expect(a).toEqual(new Set([records.a, records.dupA]));

    const b = await listed(inWorkspace(orgB.workspaceId));
    expect(b).toEqual(new Set([records.b, records.dupB]));
  });

  it("Personal is the owner's space, including its legacy unbound records", async () => {
    const personal = await listed(inWorkspace(personalTeamId));
    expect(personal).toEqual(new Set([records.personal, records.legacy]));
  });

  it("the summary counts what the list shows, not everything the person can reach", async () => {
    expect(await totalOf(inWorkspace(orgA.workspaceId))).toBe(2);
    expect(await totalOf(inWorkspace(orgB.workspaceId))).toBe(2);
    expect(await totalOf(inWorkspace(personalTeamId))).toBe(2);
  });

  it("a client naming nothing keeps the aggregate it has always had", async () => {
    const all = await listed({});
    for (const id of Object.values(records)) expect(all.has(id)).toBe(true);
    expect(await totalOf({})).toBe(6);
  });

  it("an explicit teamId wins over the header, and both are held to membership", async () => {
    const pinned = await listed(inWorkspace(orgA.workspaceId), `scope=active&teamId=${orgB.workspaceId}`);
    expect(pinned).toEqual(new Set([records.b, records.dupB]));

    const outsider = await seedUser(deps, "outsider");
    const viaHeader = await get("/v1/evidence?scope=active", outsider.token, inWorkspace(orgA.workspaceId));
    expect(viaHeader.statusCode, viaHeader.body).toBe(404);
    const summary = await get(
      "/v1/evidence/library-summary?scope=active",
      outsider.token,
      inWorkspace(orgA.workspaceId),
    );
    expect(summary.statusCode, summary.body).toBe(404);
  });

  it("a Case read follows the Case, wherever the operator is", async () => {
    const kase = await prisma.case.create({
      data: { name: `case-${tag}`, teamId: orgB.workspaceId, ownerUserId: person.userId },
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({
      data: { teamId: orgB.workspaceId, caseId: kase.id, evidenceId: records.b } as never,
    });
    const items = await listed(inWorkspace(orgA.workspaceId), `scope=active&caseId=${kase.id}`);
    expect(items).toEqual(new Set([records.b]));
  });

  it("duplicates stay inside the record's own workspace", async () => {
    const res = await get(`/v1/evidence/${records.dupA}/duplicates`, person.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(records.dupB);

    const twin = await record(person.userId, orgA.workspaceId, orgA.organizationId, {
      fileSha256: "a".repeat(64),
    });
    const again = await get(`/v1/evidence/${records.dupA}/duplicates`, person.token);
    expect(JSON.stringify(again.json())).toContain(twin);
    expect(JSON.stringify(again.json())).not.toContain(records.dupB);
    await prisma.evidence.delete({ where: { id: twin } });
  });

  it("the case picker offers what that Case can take, and hides a Case from an outsider", async () => {
    const kase = await prisma.case.create({
      data: { name: `picker-${tag}`, teamId: orgA.workspaceId, ownerUserId: orgA.owner.userId },
      select: { id: true },
    });
    // A member may attach to a Case someone else created. They were refused the
    // list, and the list would have offered records this Case refuses.
    const res = await get(`/v1/cases/${kase.id}/available-evidence`, person.token);
    expect(res.statusCode, res.body).toBe(200);
    const ids = new Set((res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id));
    expect(ids.has(records.a)).toBe(true);
    expect(ids.has(records.b)).toBe(false);
    expect(ids.has(records.personal)).toBe(false);

    const outsider = await seedUser(deps, "outsider2");
    const hidden = await get(`/v1/cases/${kase.id}/available-evidence`, outsider.token);
    expect(hidden.statusCode, hidden.body).toBe(404);
  });
});

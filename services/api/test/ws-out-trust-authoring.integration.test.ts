/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies of many shapes. */
/**
 * WS-OUT / RG-20 — Trust Center authoring and governance isolation (live
 * PostgreSQL, real routes).
 *
 *   PRO-G2-04 / PRO-G2-13 / B7B-F06  seed writers are insert-if-absent; read
 *       paths never rewrite, republish or reset existing rows; every trust
 *       write answers one rule (capability -> entitlement -> step-up).
 *   PRO-G2-03  implementationReferences are repository-relative paths; the
 *       scanners never probe a stored absolute path / traversal.
 *   PRO-T1C-09 drift / security-claim reads are gated by the scan authority.
 *   PRO-G2-07  reconciliation runs are workspace-scoped for tenant callers.
 *
 * Every workspace here is created by this file.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Tenant = { teamId: string; orgId: string; owner: Person };

describe("WS-OUT RG-20 — trust authoring, seeds and governance reads (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let contracts: typeof import("../src/services/organization/enterprise-contract.service.js");

  const tag = () => randomUUID().slice(0, 8);
  const ws = (teamId: string) => ({ "x-proovra-workspace-id": teamId });
  const call = (method: string, url: string, who: Person | null, payload?: unknown, headers?: Record<string, string>) =>
    kit.call(method, url, who, payload, headers);

  async function tenant(plan: "FREE" | "PRO" | "ENTERPRISE", opts: { contract?: boolean } = {}): Promise<Tenant> {
    const owner = await kit.person(null);
    const org = await prisma.organization.create({
      data: { name: `wo-${tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "CUSTOMER" } as never,
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "ORG_OWNER" } as never,
    });
    const team = await prisma.team.create({
      data: {
        name: `wo-${tag()}`,
        ownerUserId: owner.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        billingPlan: plan,
        billingStatus: "ACTIVE",
      } as never,
      select: { id: true },
    });
    await prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, teamId: team.id } as never });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } as never });
    await prisma.user.update({ where: { id: owner.id }, data: { currentWorkspaceId: team.id } as never });
    if (opts.contract) {
      await contracts.upsertEnterpriseContract(prisma as never, {
        organizationId: org.id,
        status: "ACTIVE",
        activationState: "ACTIVATED",
        seatCount: 25,
      } as never);
    }
    return { teamId: team.id, orgId: org.id, owner };
  }

  const articleSnapshot = (teamId: string) =>
    prisma.trustCenterArticle.findMany({
      where: { teamId },
      select: { id: true, slug: true, state: true, title: true, version: true },
      orderBy: { id: "asc" },
    });
  const subprocessorSnapshot = (teamId: string) =>
    prisma.subprocessor.findMany({
      where: { teamId },
      select: { id: true, slug: true, state: true, contractRef: true, version: true },
      orderBy: { id: "asc" },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    kit = await coverageKit(h);
    contracts = await import("../src/services/organization/enterprise-contract.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("PRO-G2-04: the first GET of an empty workspace seeds once; a VIEWER's filtered GETs never rewrite, republish or reset", async () => {
    const t = await tenant("PRO");
    const viewer = await kit.person(t.teamId, "VIEWER");

    const first = await call("GET", "/v1/trust/articles", t.owner, undefined, ws(t.teamId));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().articles.length).toBeGreaterThan(0);
    const subs = await call("GET", "/v1/trust/subprocessors", t.owner, undefined, ws(t.teamId));
    expect(subs.statusCode, subs.body).toBe(200);
    expect(subs.json().subprocessors.length).toBeGreaterThan(0);

    // The owner's own state: one article drafted and retitled, one
    // subprocessor deprecated with a contract reference.
    const someArticle = await prisma.trustCenterArticle.findFirstOrThrow({ where: { teamId: t.teamId }, select: { id: true } });
    await prisma.trustCenterArticle.update({
      where: { id: someArticle.id },
      data: { state: "DRAFT", title: "Owner edit" },
    });
    const someSub = await prisma.subprocessor.findFirstOrThrow({ where: { teamId: t.teamId }, select: { id: true } });
    await prisma.subprocessor.update({
      where: { id: someSub.id },
      data: { state: "DEPRECATED", contractRef: "C-owner-1" },
    });
    const beforeArticles = await articleSnapshot(t.teamId);
    const beforeSubs = await subprocessorSnapshot(t.teamId);
    const beforeVersions = await prisma.trustCenterArticleVersion.count({ where: { teamId: t.teamId } });

    const filtered = await call("GET", "/v1/trust/articles?state=DEPRECATED", viewer, undefined, ws(t.teamId));
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().articles).toEqual([]);
    const filteredSubs = await call("GET", "/v1/trust/subprocessors?state=REMOVED", viewer, undefined, ws(t.teamId));
    expect(filteredSubs.statusCode, filteredSubs.body).toBe(200);
    expect(filteredSubs.json().subprocessors).toEqual([]);

    expect(await articleSnapshot(t.teamId)).toEqual(beforeArticles);
    expect(await subprocessorSnapshot(t.teamId)).toEqual(beforeSubs);
    expect(await prisma.trustCenterArticleVersion.count({ where: { teamId: t.teamId } })).toBe(beforeVersions);
  });

  it("PRO-G2-04 / G2-13: a VIEWER's draft re-seed is refused and changes nothing; the owner's draft re-seed only adds what is missing", async () => {
    const t = await tenant("PRO");
    const viewer = await kit.person(t.teamId, "VIEWER");
    expect((await call("GET", "/v1/trust/articles", t.owner, undefined, ws(t.teamId))).statusCode).toBe(200);
    const published = await prisma.trustCenterArticle.findFirstOrThrow({
      where: { teamId: t.teamId, state: "PUBLISHED" },
      select: { id: true },
    });
    await prisma.trustCenterArticle.update({ where: { id: published.id }, data: { title: "Owner wording" } });
    const before = await articleSnapshot(t.teamId);

    const byViewer = await call("POST", "/v1/trust/articles/seed", viewer, {}, ws(t.teamId));
    expect([403, 404]).toContain(byViewer.statusCode);
    expect(await articleSnapshot(t.teamId)).toEqual(before);

    // One canonical article goes missing; the owner's draft re-seed restores
    // exactly that one, and touches nothing that exists.
    const missing = before.find((a) => a.id !== published.id)!;
    await prisma.trustCenterArticleVersion.deleteMany({ where: { articleId: missing.id } });
    await prisma.trustCenterArticle.delete({ where: { id: missing.id } });
    const byOwner = await call("POST", "/v1/trust/articles/seed", t.owner, {}, ws(t.teamId));
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(byOwner.json()).toMatchObject({ created: 1, updated: 0, published: false });
    const after = await articleSnapshot(t.teamId);
    for (const row of before.filter((a) => a.id !== missing.id)) {
      expect(after.find((a) => a.id === row.id)).toEqual(row);
    }
    const restored = after.find((a) => a.slug === missing.slug)!;
    expect(restored.state).toBe("DRAFT");
  });

  it("PRO-G2-13: GET /v1/trust/status creates components once and never rewrites them on later reads", async () => {
    const t = await tenant("PRO");
    const viewer = await kit.person(t.teamId, "VIEWER");
    const first = await call("GET", "/v1/trust/status", viewer, undefined, ws(t.teamId));
    expect(first.statusCode, first.body).toBe(200);
    const rows = await prisma.statusComponent.findMany({
      where: { teamId: t.teamId },
      select: { id: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    expect(rows.length).toBeGreaterThan(0);
    const again = await call("GET", "/v1/trust/status", viewer, undefined, ws(t.teamId));
    expect(again.statusCode, again.body).toBe(200);
    expect(
      await prisma.statusComponent.findMany({
        where: { teamId: t.teamId },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(rows);
  });

  it("PRO-G2-03: the article writer refuses absolute and traversal references", async () => {
    const t = await tenant("ENTERPRISE", { contract: true });
    for (const bad of ["/etc/passwd", "../../.env", "services/../../etc/passwd", "C:\\Windows\\win.ini"]) {
      const res = await call(
        "POST",
        "/v1/trust/articles",
        t.owner,
        {
          kind: "TRUST_CENTER",
          section: "PLATFORM_TRUST",
          slug: `custom-${tag()}`,
          title: "Custom",
          summary: "Custom summary",
          body: "Custom body",
          implementationReferences: [bad],
        },
        ws(t.teamId),
      );
      expect(res.statusCode, `${bad}: ${res.body}`).toBe(400);
    }
    expect(await prisma.trustCenterArticle.count({ where: { teamId: t.teamId, slug: { startsWith: "custom-" } } })).toBe(0);
    const ok = await call(
      "POST",
      "/v1/trust/articles",
      t.owner,
      {
        kind: "TRUST_CENTER",
        section: "PLATFORM_TRUST",
        slug: `custom-${tag()}`,
        title: "Custom",
        summary: "Custom summary",
        body: "Custom body",
        implementationReferences: ["services/api/src/storage.ts"],
      },
      ws(t.teamId),
    );
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("PRO-G2-03 / T1C-09: a stored legacy absolute reference is never probed; only the scan authority reads the paths", async () => {
    const t = await tenant("PRO");
    const viewer = await kit.person(t.teamId, "VIEWER");
    expect((await call("GET", "/v1/trust/articles", t.owner, undefined, ws(t.teamId))).statusCode).toBe(200);
    // A path that certainly EXISTS on this host. Before the fix the drift
    // scan reported it as present (absent from missingReferences) and the
    // security-claim scan listed it as evidence: a file-existence oracle.
    const existing = process.cwd();
    const security = await prisma.trustCenterArticle.findFirstOrThrow({
      where: { teamId: t.teamId, kind: "SECURITY" },
      select: { id: true, section: true },
    });
    await prisma.trustCenterArticle.update({
      where: { id: security.id },
      data: { implementationReferences: [existing] as never },
    });
    const scan = await call("POST", "/v1/trust/drift/scan", t.owner, {}, ws(t.teamId));
    expect(scan.statusCode, scan.body).toBe(200);
    const stale = await call("GET", "/v1/trust/drift/stale", t.owner, undefined, ws(t.teamId));
    expect(stale.statusCode, stale.body).toBe(200);
    const row = stale.json().articles.find((a: any) => a.id === security.id);
    expect(row?.missingReferences).toEqual([existing]);

    const claims = await call("POST", "/v1/trust/security-claims/scan", t.owner, {}, ws(t.teamId));
    expect(claims.statusCode, claims.body).toBe(200);
    const list = await call("GET", "/v1/trust/security-claims", t.owner, undefined, ws(t.teamId));
    expect(list.statusCode, list.body).toBe(200);
    for (const check of list.json().checks) expect(check.evidencePaths).not.toContain(existing);

    const viewerStale = await call("GET", "/v1/trust/drift/stale", viewer, undefined, ws(t.teamId));
    expect([403, 404]).toContain(viewerStale.statusCode);
    expect(viewerStale.body).not.toContain(existing);
    const viewerClaims = await call("GET", "/v1/trust/security-claims", viewer, undefined, ws(t.teamId));
    expect([403, 404]).toContain(viewerClaims.statusCode);
  });

  it("PRO-LEAD-05: an org auditor without workspace membership sees hold counts, never hold titles, reasons or record ids", async () => {
    const t = await tenant("ENTERPRISE", { contract: true });
    const evidence = await prisma.evidence.create({
      data: {
        title: "held-record",
        displayFileName: "held.pdf",
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.teamId,
        organizationId: t.orgId,
        ownerUserId: t.owner.id,
        sizeBytes: 1_000n,
      } as never,
      select: { id: true },
    });
    await prisma.evidenceLegalHold.create({
      data: {
        teamId: t.teamId,
        scope: "EVIDENCE",
        evidenceId: evidence.id,
        organizationId: t.orgId,
        title: "HOLD-TITLE-SECRET",
        reason: "HOLD-REASON-SECRET",
        status: "ACTIVE",
        placedByUserId: t.owner.id,
      } as never,
    });
    const auditor = await kit.person(null);
    await prisma.organizationMembership.create({
      data: { organizationId: t.orgId, userId: auditor.id, role: "ORG_AUDITOR" } as never,
    });
    const url = `/v1/orgs/${t.orgId}/governance/control-center`;
    const byAuditor = await call("GET", url, auditor);
    expect(byAuditor.statusCode, byAuditor.body).toBe(200);
    expect(byAuditor.json().sections.legalHolds.data.activeCount).toBe(1);
    expect(byAuditor.body).not.toContain("HOLD-TITLE-SECRET");
    expect(byAuditor.body).not.toContain("HOLD-REASON-SECRET");
    expect(byAuditor.body).not.toContain(evidence.id);

    // The workspace owner (ORG_OWNER and ACTIVE workspace member) sees the sample.
    const byOwner = await call("GET", url, t.owner);
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(byOwner.body).toContain("HOLD-TITLE-SECRET");
  });

  it("PRO-G2-07: reconciliation runs listed to a workspace caller never include team-less platform runs", async () => {
    const t = await tenant("PRO");
    const platform = await prisma.governanceReconciliationRun.create({
      data: {
        lockKey: `platform-${tag()}`,
        kind: "RETENTION",
        trigger: "SCHEDULED",
        status: "FAILED",
        teamId: null,
        errorSummary: "PLATFORM-SECRET-ERROR",
      } as never,
      select: { id: true },
    });
    const own = await prisma.governanceReconciliationRun.create({
      data: {
        lockKey: `own-${tag()}`,
        kind: "RETENTION",
        trigger: "SCHEDULED",
        status: "SUCCEEDED",
        teamId: t.teamId,
      } as never,
      select: { id: true },
    });
    const res = await call("GET", `/v1/governance/reconciliation-runs?teamId=${t.teamId}`, t.owner, undefined, ws(t.teamId));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(platform.id);
    expect(res.body).not.toContain("PLATFORM-SECRET-ERROR");
    expect(res.body).toContain(own.id);
  });

  it("PRO-G2-07: another workspace's owner naming this workspace is refused, and this workspace's list never carries another workspace's run", async () => {
    const t = await tenant("PRO");
    const other = await tenant("PRO");
    const mine = await prisma.governanceReconciliationRun.create({
      data: { lockKey: `mine-${tag()}`, kind: "RETENTION", trigger: "SCHEDULED", status: "FAILED", teamId: t.teamId, errorSummary: "MINE-ERROR" } as never,
      select: { id: true },
    });
    const theirs = await prisma.governanceReconciliationRun.create({
      data: { lockKey: `theirs-${tag()}`, kind: "RETENTION", trigger: "SCHEDULED", status: "FAILED", teamId: other.teamId, errorSummary: "THEIRS-ERROR" } as never,
      select: { id: true },
    });
    const foreign = await call("GET", `/v1/governance/reconciliation-runs?teamId=${t.teamId}`, other.owner, undefined, ws(t.teamId));
    // Anti-enumeration: a non-member is told the workspace is not found.
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json()).toEqual({ error: { code: "not_found" } });
    expect(foreign.body).not.toContain(mine.id);
    expect(foreign.body).not.toContain("MINE-ERROR");
    const own = await call("GET", `/v1/governance/reconciliation-runs?teamId=${t.teamId}`, t.owner, undefined, ws(t.teamId));
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).toContain(mine.id);
    expect(own.body).not.toContain(theirs.id);
    expect(own.body).not.toContain("THEIRS-ERROR");
  });
});

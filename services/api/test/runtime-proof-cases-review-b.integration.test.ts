/**
 * BATCH K4 (part B) — runtime proof for the reviewer and saved-view
 * mutations the UI sweep could not drive to their success branch.
 *
 * Every action is proven three ways against a disposable PostgreSQL 16:
 *   1. the authorized SUCCESS branch, with the payload the product consumer
 *      sends, re-reading the exact row/column the action exists to change;
 *   2. the AUDIT record where the route writes one;
 *   3. an EXPECTED REFUSAL with its bounded status/code and no durable effect.
 *
 * Payloads come from the real consumers:
 *   - apps/web/app/(app)/settings/reviewer-criteria/page.tsx      (criteria create / draft save)
 *   - apps/web/components/reviewer-experience/ReviewerBulkOpsBar.tsx
 *   - apps/web/components/reviewer-experience/ReviewerConsole.tsx (reviewer-ops saved views)
 *   - apps/web/lib/reviewer-workspace/reviewer-api.ts              (writeCodingValue, bulkCode)
 *   - apps/web/app/(app)/search/page.tsx                           (search saved views)
 *   - apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx     (SIU saved views)
 * POST /v1/coding/schemas has no current web consumer; its contract is the
 * route's zod schema.
 *
 * Fire-and-forget sinks (`safeEmitSecurityEvent`) are read with `expect.poll` — a bounded wait for a write the product already
 * dispatched, never a retry of the action under test.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("K4-B — reviewer and saved views (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;

  const call = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);

  const auditRow = (action: string, resourceId: string) =>
    prisma.adminAuditLog.findFirst({
      where: { action, resourceId },
      orderBy: { createdAt: "desc" },
    });

  const pollSecurityEvent = (teamId: string, eventType: string, match: (d: Record<string, unknown>) => boolean) =>
    expect.poll(
      async () => {
        const rows = await prisma.securityEvent.findMany({
          where: { teamId, eventType },
          orderBy: { createdAt: "desc" },
          take: 20,
        });
        return rows.some((r) => match((r.details ?? {}) as Record<string, unknown>));
      },
      { timeout: 10_000, interval: 25 },
    );

  async function newEvidence(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    return (
      await prisma.evidence.create({
        data: {
          title: `k4b evidence ${tag()}`,
          type: "PHOTO",
          status: "SIGNED",
          mimeType: "image/jpeg",
          teamId,
          organizationId: team.organizationId,
          ownerUserId,
        },
        select: { id: true },
      })
    ).id;
  }

  async function newReviewWorkflow(teamId: string, ownerUserId: string) {
    const evidenceId = await newEvidence(teamId, ownerUserId);
    return (
      await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId, teamId, workspaceType: "TEAM" },
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    // Organization A is an Enterprise customer: reviewer operations are
    // included. Organization B stays on the FREE default.
    const { teamA } = h.fixtures;
    const orgA = (
      await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })
    ).organizationId;
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // Reviewer criteria
  // ===========================================================================
  describe("reviewer criteria", () => {
    /** CreateForm in settings/reviewer-criteria/page.tsx. */
    const createBody = (teamId: string, name: string) => ({
      teamId,
      name,
      title: "Claims photo review v1",
      criteria: [
        { key: "timestamp", title: "Timestamp visible", required: true, order: 0, reviewGuidance: "Check the overlay." },
        { key: "location", title: "Location plausible", required: false, order: 1 },
      ],
    });

    it("POST /v1/reviewer-criteria — ADMIN creates a DRAFT set + v1 with criteria; audited", async () => {
      const a = h.fixtures.teamA;
      const name = `Claims ${tag()}`;
      const res = await call({ method: "POST", url: "/v1/reviewer-criteria", token: a.adminToken, payload: createBody(a.teamId, name) });
      expect(res.statusCode, res.body).toBe(201);
      const setId = res.json().set.id as string;
      const row = await prisma.reviewerCriteriaSet.findUniqueOrThrow({
        where: { id: setId },
        include: { versions: { include: { criteria: { orderBy: { order: "asc" } } } } },
      });
      expect(row).toMatchObject({ workspaceId: a.teamId, name, status: "DRAFT", createdByUserId: a.adminUserId });
      expect(row.versions).toHaveLength(1);
      expect(row.versions[0]).toMatchObject({ version: 1, title: "Claims photo review v1", publishedAt: null });
      expect(row.versions[0]!.criteria.map((c) => [c.key, c.required, c.reviewGuidance])).toEqual([
        ["timestamp", true, "Check the overlay."],
        ["location", false, null],
      ]);
      expect(await auditRow("reviewer_criteria.created", setId)).toMatchObject({
        userId: a.adminUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "reviewer_criteria_set",
      });
    });

    it("POST /v1/reviewer-criteria — a MEMBER is refused 403, another tenant 404; no set written", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const name = `Refused ${tag()}`;
      const member = await call({ method: "POST", url: "/v1/reviewer-criteria", token: a.memberToken, payload: createBody(a.teamId, name) });
      expect(member.statusCode).toBe(403);
      expect(member.json().error.code).toBe("permission_denied");
      const foreign = await call({ method: "POST", url: "/v1/reviewer-criteria", token: b.ownerToken, payload: createBody(a.teamId, name) });
      expect(foreign.statusCode).toBe(404);
      expect(await prisma.reviewerCriteriaSet.count({ where: { name } })).toBe(0);
    });

    it("PATCH /v1/reviewer-criteria/:setId/draft — ADMIN saves the draft with the loaded token; criteria replaced, token advances; audited", async () => {
      const a = h.fixtures.teamA;
      const created = await call({ method: "POST", url: "/v1/reviewer-criteria", token: a.ownerToken, payload: createBody(a.teamId, `Draft ${tag()}`) });
      expect(created.statusCode, created.body).toBe(201);
      const setId = created.json().set.id as string;
      // DraftEditor loads the set, then sends the updatedAt it loaded.
      const loaded = await call({ method: "GET", url: `/v1/reviewer-criteria/${setId}?teamId=${a.teamId}`, token: a.adminToken });
      expect(loaded.statusCode, loaded.body).toBe(200);
      const expectedUpdatedAt = loaded.json().set.updatedAt as string;

      const res = await call({
        method: "PATCH",
        url: `/v1/reviewer-criteria/${setId}/draft`,
        token: a.adminToken,
        payload: {
          teamId: a.teamId,
          title: "Claims photo review v1 (edited)",
          expectedUpdatedAt,
          criteria: [
            { key: "timestamp", title: "Timestamp overlay visible", required: true, order: 0 },
            { key: "exif", title: "EXIF present", required: true, order: 1, reviewGuidance: "Open the technical appendix." },
            { key: "glare", title: "No glare", required: false, order: 2 },
          ],
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, version: 1 });
      const row = await prisma.reviewerCriteriaSet.findUniqueOrThrow({
        where: { id: setId },
        include: { versions: { include: { criteria: { orderBy: { order: "asc" } } } } },
      });
      expect(row.versions[0]!.title).toBe("Claims photo review v1 (edited)");
      expect(row.versions[0]!.criteria.map((c) => c.key)).toEqual(["timestamp", "exif", "glare"]);
      expect(row.updatedAt.getTime()).toBeGreaterThan(new Date(expectedUpdatedAt).getTime());
      expect(await auditRow("reviewer_criteria.draft_updated", setId)).toMatchObject({
        userId: a.adminUserId,
        workspaceId: a.teamId,
        outcome: "success",
      });

      // The same stale token now conflicts and changes nothing.
      const stale = await call({
        method: "PATCH",
        url: `/v1/reviewer-criteria/${setId}/draft`,
        token: a.ownerToken,
        payload: { teamId: a.teamId, expectedUpdatedAt, criteria: [{ key: "x", title: "X", required: false, order: 0 }] },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("draft_conflict");
      const member = await call({
        method: "PATCH",
        url: `/v1/reviewer-criteria/${setId}/draft`,
        token: a.memberToken,
        payload: { teamId: a.teamId, criteria: [{ key: "x", title: "X", required: false, order: 0 }] },
      });
      expect(member.statusCode).toBe(403);
      const foreign = await call({
        method: "PATCH",
        url: `/v1/reviewer-criteria/${setId}/draft`,
        token: h.fixtures.teamB.ownerToken,
        payload: { teamId: a.teamId, criteria: [{ key: "x", title: "X", required: false, order: 0 }] },
      });
      expect(foreign.statusCode).toBe(404);
      // Publish, then a draft save is refused as immutable.
      const pub = await call({ method: "POST", url: `/v1/reviewer-criteria/${setId}/publish`, token: a.adminToken, payload: { teamId: a.teamId } });
      expect(pub.statusCode, pub.body).toBe(200);
      const immutable = await call({
        method: "PATCH",
        url: `/v1/reviewer-criteria/${setId}/draft`,
        token: a.adminToken,
        payload: { teamId: a.teamId, criteria: [{ key: "x", title: "X", required: false, order: 0 }] },
      });
      expect(immutable.statusCode).toBe(409);
      expect(immutable.json().error.code).toBe("published_immutable");
      const after = await prisma.reviewerCriterion.findMany({
        where: { criteriaVersionId: row.versions[0]!.id },
        orderBy: { order: "asc" },
      });
      expect(after.map((c) => c.key)).toEqual(["timestamp", "exif", "glare"]);
    });
  });

  // ===========================================================================
  // Reviewer ops — bulk triage + saved views
  // ===========================================================================
  describe("reviewer ops", () => {
    it("POST /v1/reviewer-ops/reviews/bulk — ADMIN raises priority on two workflows; priority re-read; audited", async () => {
      const a = h.fixtures.teamA;
      const w1 = await newReviewWorkflow(a.teamId, a.ownerUserId);
      const w2 = await newReviewWorkflow(a.teamId, a.ownerUserId);
      const res = await call({
        method: "POST",
        url: "/v1/reviewer-ops/reviews/bulk",
        token: a.adminToken,
        payload: { teamId: a.teamId, workflowIds: [w1, w2], action: "PRIORITY_HIGH" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
      const rows = await prisma.evidenceReviewWorkflow.findMany({ where: { id: { in: [w1, w2] } } });
      expect(rows.map((r) => r.priority)).toEqual(["HIGH", "HIGH"]);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "reviewer.bulk_triage", workspaceId: a.teamId, userId: a.adminUserId },
        orderBy: { createdAt: "desc" },
      });
      expect(audit.outcome).toBe("success");
      expect(audit.metadata as Record<string, unknown>).toMatchObject({
        action: "PRIORITY_HIGH",
        total: 2,
        succeeded: 2,
        failed: 0,
      });
    });

    it("POST /v1/reviewer-ops/reviews/bulk — a MEMBER is refused review_bulk_required; another tenant's workflows are not found; nothing changes", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const w = await newReviewWorkflow(a.teamId, a.ownerUserId);
      const member = await call({
        method: "POST",
        url: "/v1/reviewer-ops/reviews/bulk",
        token: a.memberToken,
        payload: { teamId: a.teamId, workflowIds: [w], action: "PRIORITY_URGENT" },
      });
      expect(member.statusCode).toBe(403);
      expect(member.json().error).toMatchObject({ code: "REVIEW_PERMISSION_DENIED", reason: "review_bulk_required" });
      const intoForeign = await call({
        method: "POST",
        url: "/v1/reviewer-ops/reviews/bulk",
        token: b.ownerToken,
        payload: { teamId: a.teamId, workflowIds: [w], action: "PRIORITY_URGENT" },
      });
      expect(intoForeign.statusCode).toBe(404);
      expect(intoForeign.json()).toEqual({ error: { code: "not_found" } });
      const viaOwnTeam = await call({
        method: "POST",
        url: "/v1/reviewer-ops/reviews/bulk",
        token: b.ownerToken,
        payload: { teamId: b.teamId, workflowIds: [w], action: "PRIORITY_URGENT" },
      });
      expect(viaOwnTeam.statusCode).toBe(207);
      expect(viaOwnTeam.json().items).toEqual([
        expect.objectContaining({ workflowId: w, ok: false, errorCode: "REVIEW_WORKFLOW_NOT_FOUND" }),
      ]);
      expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w } })).priority).toBe("NORMAL");
    });

    it("POST + DELETE /v1/reviewer-ops/saved-views — a reviewer saves and deletes a view; row re-read; security events recorded; another tenant concealed", async () => {
      const a = h.fixtures.teamA;
      const name = `My queue ${tag()}`;
      // ReviewerConsole.tsx `create`.
      const created = await call({
        method: "POST",
        url: "/v1/reviewer-ops/saved-views",
        token: a.memberToken,
        payload: { teamId: a.teamId, name, visibility: "PRIVATE", filter: { teamId: a.teamId } },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().view.id as string;
      const row = await prisma.savedSearchView.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        teamId: a.teamId,
        createdByUserId: a.memberUserId,
        name,
        visibility: "PRIVATE",
        scope: "REVIEWER_OPS",
      });
      expect(row.queryJson).toEqual({ teamId: a.teamId });
      await pollSecurityEvent(a.teamId, "reviewer_saved_view_created", (d) => d.savedViewId === id).toBe(true);

      // Refusals before the delete: another reviewer cannot see a PRIVATE view,
      // another tenant is blocked at the actor gate.
      const other = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${id}?teamId=${a.teamId}`,
        token: a.adminToken,
      });
      expect(other.statusCode).toBe(404);
      const foreign = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${id}?teamId=${a.teamId}`,
        token: h.fixtures.teamB.ownerToken,
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(1);

      // ReviewerConsole.tsx `remove`.
      const deleted = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${id}?teamId=${a.teamId}`,
        token: a.memberToken,
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(0);
      await pollSecurityEvent(a.teamId, "reviewer_saved_view_deleted", (d) => d.savedViewId === id).toBe(true);
    });

    it("POST /v1/reviewer-ops/saved-views — a VIEWER, a mismatched filter and another tenant are refused; nothing written", async () => {
      const a = h.fixtures.teamA;
      const name = `Refused ${tag()}`;
      const viewer = await call({
        method: "POST",
        url: "/v1/reviewer-ops/saved-views",
        token: a.viewerToken,
        payload: { teamId: a.teamId, name, visibility: "PRIVATE", filter: { teamId: a.teamId } },
      });
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json().error.code).toBe("REVIEW_PERMISSION_DENIED");
      const mismatch = await call({
        method: "POST",
        url: "/v1/reviewer-ops/saved-views",
        token: a.memberToken,
        payload: { teamId: a.teamId, name, visibility: "PRIVATE", filter: { teamId: h.fixtures.teamB.teamId } },
      });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json()).toEqual({ error: { code: "teamId_mismatch" } });
      const foreign = await call({
        method: "POST",
        url: "/v1/reviewer-ops/saved-views",
        token: h.fixtures.teamB.ownerToken,
        payload: { teamId: a.teamId, name, visibility: "TEAM", filter: { teamId: a.teamId } },
      });
      expect(foreign.statusCode).toBe(404);
      expect(await prisma.savedSearchView.count({ where: { name } })).toBe(0);
    });

    it("DELETE /v1/reviewer-ops/saved-views/:id — a workspace VIEWER cannot delete a colleague's shared view", async () => {
      const a = h.fixtures.teamA;
      const created = await call({
        method: "POST",
        url: "/v1/reviewer-ops/saved-views",
        token: a.memberToken,
        payload: { teamId: a.teamId, name: `Shared ${tag()}`, visibility: "TEAM", filter: { teamId: a.teamId } },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().view.id as string;
      const viewer = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${id}?teamId=${a.teamId}`,
        token: a.viewerToken,
      });
      expect(viewer.statusCode).toBe(404);
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(1);
      // A workspace ADMIN may remove a shared view.
      const admin = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${id}?teamId=${a.teamId}`,
        token: a.adminToken,
      });
      expect(admin.statusCode).toBe(204);
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(0);
    });
  });

  // ===========================================================================
  // Reviewer workspace — coding schemas and coding values
  // ===========================================================================
  describe("reviewer workspace coding", () => {
    const schemaBody = (slug: string) => ({
      slug,
      label: "Claims photo coding",
      category: "INSURANCE_REVIEW",
      description: "Fields every claims photo review records.",
      fields: [
        { slug: "damage-summary", label: "Damage summary", fieldType: "TEXT", required: true, orderIndex: 0, helpText: "One sentence." },
        { slug: "estimate", label: "Estimate", fieldType: "NUMERIC", required: false, orderIndex: 1, options: { min: 0 } },
      ],
    });

    /**
     * A published schema, as the product produces one: the publish route is
     * retired (owner decision 2026-09-16), and installed schemas are published
     * by the service seed-defaults calls — the same function used here.
     */
    async function publishedSchema(slug: string) {
      const a = h.fixtures.teamA;
      const created = await call({ method: "POST", url: `/v1/coding/schemas?teamId=${a.teamId}`, token: a.ownerToken, payload: schemaBody(slug) });
      expect(created.statusCode, created.body).toBe(201);
      const schemaId = created.json().schemaId as string;
      const { publishSchema } = await import("../src/services/reviewer-workspace/coding-schema.service.js");
      expect(await publishSchema({ teamId: a.teamId, schemaId })).toMatchObject({ ok: true });
      const fields = await prisma.codingField.findMany({ where: { schemaId }, orderBy: { orderIndex: "asc" } });
      return { schemaId, fields };
    }

    async function bind(workflowId: string, schemaId: string) {
      const a = h.fixtures.teamA;
      const res = await call({
        method: "POST",
        url: `/v1/reviewer/work/${workflowId}/bind-schema?teamId=${a.teamId}`,
        token: a.adminToken,
        payload: { schemaId },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    it("POST /v1/coding/schemas — the workspace OWNER (REVIEW_ADMIN) creates a DRAFT schema with its fields; audited", async () => {
      const a = h.fixtures.teamA;
      const slug = `claims-${tag()}`;
      const res = await call({ method: "POST", url: `/v1/coding/schemas?teamId=${a.teamId}`, token: a.ownerToken, payload: schemaBody(slug) });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().version).toBe(1);
      const schemaId = res.json().schemaId as string;
      const row = await prisma.codingSchema.findUniqueOrThrow({
        where: { id: schemaId },
        include: { fields: { orderBy: { orderIndex: "asc" } } },
      });
      expect(row).toMatchObject({
        teamId: a.teamId,
        slug,
        label: "Claims photo coding",
        category: "INSURANCE_REVIEW",
        status: "DRAFT",
        version: 1,
        createdByUserId: a.ownerUserId,
      });
      expect(row.fields.map((f) => [f.slug, f.fieldType, f.required, f.teamId])).toEqual([
        ["damage-summary", "TEXT", true, a.teamId],
        ["estimate", "NUMERIC", false, a.teamId],
      ]);
      expect(await auditRow("reviewer.coding_schema.created", schemaId)).toMatchObject({
        userId: a.ownerUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "coding_schema",
      });
    });

    it("POST /v1/coding/schemas — an ADMIN (SUPERVISOR), a MEMBER, a FREE workspace and another tenant are refused; nothing written", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const slug = `refused-${tag()}`;
      for (const token of [a.adminToken, a.memberToken]) {
        const denied = await call({ method: "POST", url: `/v1/coding/schemas?teamId=${a.teamId}`, token, payload: schemaBody(slug) });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toEqual({ denial: "NOT_PERMITTED" });
      }
      const free = await call({ method: "POST", url: `/v1/coding/schemas?teamId=${b.teamId}`, token: b.ownerToken, payload: schemaBody(slug) });
      expect(free.statusCode).toBe(403);
      expect(free.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", entitlement: "REVIEWER_OPERATIONS" });
      const foreign = await call({ method: "POST", url: `/v1/coding/schemas?teamId=${a.teamId}`, token: b.ownerToken, payload: schemaBody(slug) });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json()).toEqual({ denial: "NOT_PERMITTED" });
      expect(await prisma.codingSchema.count({ where: { slug } })).toBe(0);
    });

    it("POST /v1/coding/schemas/:id/publish — retired: the owner gets 410 and the draft stays a draft", async () => {
      const a = h.fixtures.teamA;
      const created = await call({ method: "POST", url: `/v1/coding/schemas?teamId=${a.teamId}`, token: a.ownerToken, payload: schemaBody(`retired-${tag()}`) });
      expect(created.statusCode, created.body).toBe(201);
      const schemaId = created.json().schemaId as string;
      const res = await call({ method: "POST", url: `/v1/coding/schemas/${schemaId}/publish?teamId=${a.teamId}`, token: a.ownerToken });
      expect(res.statusCode, res.body).toBe(410);
      expect(res.json()).toMatchObject({
        error: { code: "CODING_SCHEMA_PUBLISH_RETIRED" },
        canonical: "/v1/coding/schemas/seed-defaults",
      });
      const row = await prisma.codingSchema.findUniqueOrThrow({ where: { id: schemaId } });
      expect(row).toMatchObject({ status: "DRAFT", publishedAt: null });
      expect(await auditRow("reviewer.coding_schema.published", schemaId)).toBeNull();
    });

    it("POST /v1/reviewer/work/:id/code — a reviewer records then updates a coded value on a bound workflow", async () => {
      const a = h.fixtures.teamA;
      const { schemaId, fields } = await publishedSchema(`code-${tag()}`);
      const workflowId = await newReviewWorkflow(a.teamId, a.ownerUserId);
      await bind(workflowId, schemaId);
      const summary = fields.find((f) => f.slug === "damage-summary")!;

      // reviewer-api.ts writeCodingValue.
      const first = await call({
        method: "POST",
        url: `/v1/reviewer/work/${workflowId}/code?teamId=${a.teamId}`,
        token: a.memberToken,
        payload: { fieldId: summary.id, value: { text: "Dent on the rear door." }, rationale: "Visible in frame 2." },
      });
      expect(first.statusCode, first.body).toBe(200);
      const codingValueId = first.json().codingValueId as string;
      let row = await prisma.codingValue.findUniqueOrThrow({ where: { id: codingValueId } });
      expect(row).toMatchObject({
        teamId: a.teamId,
        workflowId,
        fieldId: summary.id,
        authorUserId: a.memberUserId,
        rationale: "Visible in frame 2.",
      });
      expect(row.value).toEqual({ text: "Dent on the rear door." });

      const second = await call({
        method: "POST",
        url: `/v1/reviewer/work/${workflowId}/code?teamId=${a.teamId}`,
        token: a.adminToken,
        payload: { fieldId: summary.id, value: { text: "Dent and scratch on the rear door." } },
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().codingValueId).toBe(codingValueId);
      row = await prisma.codingValue.findUniqueOrThrow({ where: { id: codingValueId } });
      expect(row.value).toEqual({ text: "Dent and scratch on the rear door." });
      expect(row.authorUserId).toBe(a.adminUserId);
      // D52 — each write leaves one audit row (reviewer-workspace.routes.ts),
      // attributed to its own writer; the coded text is never copied into it.
      const audits = await prisma.adminAuditLog.findMany({
        where: { resourceId: codingValueId, action: "reviewer.code.write" },
        orderBy: { createdAt: "asc" },
      });
      expect(audits.map((r) => [r.userId, r.workspaceId, r.outcome, r.resourceType])).toEqual([
        [a.memberUserId, a.teamId, "success", "coding_value"],
        [a.adminUserId, a.teamId, "success", "coding_value"],
      ]);
      expect(JSON.stringify(audits)).not.toContain("rear door");
    });

    it("POST /v1/reviewer/work/:id/code — a VIEWER, an invalid value, an unbound field and another tenant are refused; value unchanged", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const { schemaId, fields } = await publishedSchema(`coderef-${tag()}`);
      const other = await publishedSchema(`coderef-other-${tag()}`);
      const workflowId = await newReviewWorkflow(a.teamId, a.ownerUserId);
      await bind(workflowId, schemaId);
      const estimate = fields.find((f) => f.slug === "estimate")!;
      const url = `/v1/reviewer/work/${workflowId}/code?teamId=${a.teamId}`;

      const viewer = await call({ method: "POST", url, token: a.viewerToken, payload: { fieldId: estimate.id, value: { number: 10 } } });
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json()).toEqual({ denial: "NOT_PERMITTED" });
      const invalid = await call({ method: "POST", url, token: a.memberToken, payload: { fieldId: estimate.id, value: { number: -5 } } });
      expect(invalid.statusCode).toBe(409);
      expect(invalid.json()).toEqual({ denial: "FIELD_VALIDATION_FAILED" });
      const unbound = await call({ method: "POST", url, token: a.memberToken, payload: { fieldId: other.fields[0]!.id, value: { text: "x" } } });
      expect(unbound.statusCode).toBe(409);
      expect(unbound.json()).toEqual({ denial: "SCHEMA_VERSION_MISMATCH" });
      const foreign = await call({
        method: "POST",
        url: `/v1/reviewer/work/${workflowId}/code?teamId=${a.teamId}`,
        token: b.ownerToken,
        payload: { fieldId: estimate.id, value: { number: 10 } },
      });
      expect(foreign.statusCode).toBe(403);
      const foreignOwnTeam = await call({
        method: "POST",
        url: `/v1/reviewer/work/${workflowId}/code?teamId=${b.teamId}`,
        token: b.ownerToken,
        payload: { fieldId: estimate.id, value: { number: 10 } },
      });
      expect(foreignOwnTeam.statusCode).toBe(409);
      expect(foreignOwnTeam.json()).toEqual({ denial: "WORKFLOW_NOT_FOUND" });
      expect(await prisma.codingValue.count({ where: { workflowId } })).toBe(0);
    });

    it("POST /v1/reviewer/bulk/code — ADMIN codes one field across two workflows; values re-read", async () => {
      const a = h.fixtures.teamA;
      const { schemaId, fields } = await publishedSchema(`bulk-${tag()}`);
      const w1 = await newReviewWorkflow(a.teamId, a.ownerUserId);
      const w2 = await newReviewWorkflow(a.teamId, a.ownerUserId);
      await bind(w1, schemaId);
      await bind(w2, schemaId);
      const unbound = await newReviewWorkflow(a.teamId, a.ownerUserId);

      // reviewer-api.ts bulkCode — the whole input object is the body.
      const res = await call({
        method: "POST",
        url: `/v1/reviewer/bulk/code?teamId=${a.teamId}`,
        token: a.adminToken,
        payload: { fieldSlug: "estimate", value: { number: 1200 }, workflowIds: [w1, w2, unbound], teamId: a.teamId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        total: 3,
        succeeded: 2,
        outcomes: [
          { workflowId: w1, ok: true },
          { workflowId: w2, ok: true },
          { workflowId: unbound, ok: false, denial: "SCHEMA_NOT_FOUND" },
        ],
      });
      const estimate = fields.find((f) => f.slug === "estimate")!;
      const values = await prisma.codingValue.findMany({ where: { fieldId: estimate.id }, orderBy: { workflowId: "asc" } });
      expect(values.map((v) => [v.workflowId, v.value, v.authorUserId]).sort()).toEqual(
        [
          [w1, { number: 1200 }, a.adminUserId],
          [w2, { number: 1200 }, a.adminUserId],
        ].sort(),
      );
      expect(await prisma.codingValue.count({ where: { workflowId: unbound } })).toBe(0);
    });

    it("POST /v1/reviewer/bulk/code — a MEMBER (no review.bulk) and another tenant are refused; nothing written", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const { schemaId } = await publishedSchema(`bulkref-${tag()}`);
      const w = await newReviewWorkflow(a.teamId, a.ownerUserId);
      await bind(w, schemaId);
      const body = { fieldSlug: "estimate", value: { number: 7 }, workflowIds: [w] };
      const member = await call({ method: "POST", url: `/v1/reviewer/bulk/code?teamId=${a.teamId}`, token: a.memberToken, payload: body });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({ denial: "NOT_PERMITTED" });
      const foreign = await call({ method: "POST", url: `/v1/reviewer/bulk/code?teamId=${a.teamId}`, token: b.ownerToken, payload: body });
      expect(foreign.statusCode).toBe(403);
      const ownTeam = await call({ method: "POST", url: `/v1/reviewer/bulk/code?teamId=${b.teamId}`, token: b.ownerToken, payload: body });
      expect(ownTeam.statusCode).toBe(200);
      expect(ownTeam.json().outcomes).toEqual([{ workflowId: w, ok: false, denial: "SCHEMA_NOT_FOUND" }]);
      expect(await prisma.codingValue.count({ where: { workflowId: w } })).toBe(0);
    });
  });

  // ===========================================================================
  // Search saved views
  // ===========================================================================
  describe("search saved views", () => {
    /** search/page.tsx `saveCurrentView` with the page's initial filter. */
    const viewBody = (teamId: string, name: string, visibility: "PRIVATE" | "TEAM" = "PRIVATE") => ({
      teamId,
      name,
      visibility,
      query: { teamId, sort: "UPDATED_DESC", limit: 25, q: "bumper" },
    });

    it("POST + DELETE /v1/search/saved-views — a member saves and deletes a private view; row re-read; both audited", async () => {
      const a = h.fixtures.teamA;
      const name = `Bumper ${tag()}`;
      const created = await call({ method: "POST", url: "/v1/search/saved-views", token: a.memberToken, payload: viewBody(a.teamId, name) });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().view.id as string;
      const row = await prisma.savedSearchView.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ teamId: a.teamId, createdByUserId: a.memberUserId, name, visibility: "PRIVATE" });
      expect(row.queryJson).toEqual({ teamId: a.teamId, sort: "UPDATED_DESC", limit: 25, q: "bumper" });
      expect(await auditRow("search.saved_view.create", id)).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "saved_search_view",
      });

      const other = await call({ method: "DELETE", url: `/v1/search/saved-views/${id}?teamId=${a.teamId}`, token: a.adminToken });
      expect(other.statusCode).toBe(404);
      const foreign = await call({ method: "DELETE", url: `/v1/search/saved-views/${id}?teamId=${a.teamId}`, token: h.fixtures.teamB.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      const crossTeam = await call({
        method: "DELETE",
        url: `/v1/search/saved-views/${id}?teamId=${h.fixtures.teamB.teamId}`,
        token: h.fixtures.teamB.ownerToken,
      });
      expect(crossTeam.statusCode).toBe(404);
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(1);

      const deleted = await call({ method: "DELETE", url: `/v1/search/saved-views/${id}?teamId=${a.teamId}`, token: a.memberToken });
      expect(deleted.statusCode, deleted.body).toBe(204);
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(0);
      expect(await auditRow("search.saved_view.delete", id)).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        outcome: "success",
      });
    });

    it("POST /v1/search/saved-views — a mismatched query scope and another tenant are refused; nothing written", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const name = `Refused ${tag()}`;
      const mismatch = await call({
        method: "POST",
        url: "/v1/search/saved-views",
        token: a.memberToken,
        payload: { ...viewBody(a.teamId, name), query: { teamId: b.teamId } },
      });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json()).toEqual({ error: { code: "validation_error", reason: "teamId_mismatch" } });
      const foreign = await call({ method: "POST", url: "/v1/search/saved-views", token: b.ownerToken, payload: viewBody(a.teamId, name) });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(await prisma.savedSearchView.count({ where: { name } })).toBe(0);
    });

    it("DELETE /v1/search/saved-views/:id — a workspace VIEWER cannot delete a colleague's shared view; an ADMIN can", async () => {
      const a = h.fixtures.teamA;
      const created = await call({ method: "POST", url: "/v1/search/saved-views", token: a.memberToken, payload: viewBody(a.teamId, `Shared ${tag()}`, "TEAM") });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().view.id as string;
      const viewer = await call({ method: "DELETE", url: `/v1/search/saved-views/${id}?teamId=${a.teamId}`, token: a.viewerToken });
      expect(viewer.statusCode).toBe(404);
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(1);
      const admin = await call({ method: "DELETE", url: `/v1/search/saved-views/${id}?teamId=${a.teamId}`, token: a.adminToken });
      expect(admin.statusCode).toBe(204);
      expect(await prisma.savedSearchView.count({ where: { id } })).toBe(0);
    });
  });

  // ===========================================================================
  // SIU saved views
  // ===========================================================================
  describe("SIU saved views", () => {
    /** SiuWorklistPanel.tsx `createView`. */
    const viewBody = (teamId: string, name: string) => ({
      teamId,
      name,
      filter: { investigationStatus: ["review"], requireMissingChecklistItems: true },
      sort: { key: "updatedAtUtc", direction: "desc" },
      visibility: "team",
    });

    async function createView(token: string, name: string) {
      const a = h.fixtures.teamA;
      const res = await call({ method: "POST", url: "/v1/siu/saved-views", token, payload: viewBody(a.teamId, name) });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().view.id as string;
    }

    it("POST /v1/siu/saved-views — a member creates a team view; row re-read", async () => {
      const a = h.fixtures.teamA;
      const name = `SIU review ${tag()}`;
      const id = await createView(a.memberToken, name);
      const row = await prisma.caseSiuSavedView.findUniqueOrThrow({ where: { id } });
      const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: a.teamId } })).organizationId;
      expect(row).toMatchObject({
        teamId: a.teamId,
        organizationId: orgA,
        name,
        visibility: "team",
        createdByUserId: a.memberUserId,
        updatedByUserId: a.memberUserId,
      });
      expect(row.filterJson).toEqual({ investigationStatus: ["review"], requireMissingChecklistItems: true });
      expect(row.sortJson).toEqual({ key: "updatedAtUtc", direction: "desc" });
      // D52 — the create leaves exactly one audit row (siu-saved-views.service.ts).
      const audits = await prisma.adminAuditLog.findMany({ where: { resourceId: id } });
      expect(audits.map((r) => [r.action, r.userId, r.workspaceId, r.outcome])).toEqual([
        ["siu.saved_view.create", a.memberUserId, a.teamId, "success"],
      ]);
    });

    it("POST /v1/siu/saved-views — another tenant is refused member_inactive; nothing written", async () => {
      const a = h.fixtures.teamA;
      const name = `SIU refused ${tag()}`;
      const foreign = await call({ method: "POST", url: "/v1/siu/saved-views", token: h.fixtures.teamB.ownerToken, payload: viewBody(a.teamId, name) });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json()).toEqual({ error: { code: "member_inactive" } });
      const badFilter = await call({
        method: "POST",
        url: "/v1/siu/saved-views",
        token: a.memberToken,
        payload: { ...viewBody(a.teamId, name), filter: { anything: true } },
      });
      expect(badFilter.statusCode).toBe(400);
      expect(await prisma.caseSiuSavedView.count({ where: { name } })).toBe(0);
    });

    it("PATCH /v1/siu/saved-views/:id — the creator renames the view; name + updatedBy re-read; refusals change nothing", async () => {
      const a = h.fixtures.teamA;
      const id = await createView(a.memberToken, `SIU rename ${tag()}`);
      const url = `/v1/siu/saved-views/${id}?teamId=${a.teamId}`;
      const foreign = await call({ method: "PATCH", url, token: h.fixtures.teamB.ownerToken, payload: { name: "Hijacked" } });
      expect(foreign.statusCode).toBe(403);
      const crossTeam = await call({
        method: "PATCH",
        url: `/v1/siu/saved-views/${id}?teamId=${h.fixtures.teamB.teamId}`,
        token: h.fixtures.teamB.ownerToken,
        payload: { name: "Hijacked" },
      });
      expect(crossTeam.statusCode).toBe(404);
      const viewer = await call({ method: "PATCH", url, token: a.viewerToken, payload: { name: "Hijacked" } });
      expect(viewer.statusCode).toBe(404);
      expect((await prisma.caseSiuSavedView.findUniqueOrThrow({ where: { id } })).name).not.toBe("Hijacked");

      // SiuWorklistPanel.tsx rename — body is `{ name }` only.
      const renamed = await call({ method: "PATCH", url, token: a.memberToken, payload: { name: "SIU — needs checklist" } });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json().view.name).toBe("SIU — needs checklist");
      const row = await prisma.caseSiuSavedView.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe("SIU — needs checklist");
      expect(row.updatedByUserId).toBe(a.memberUserId);
      expect(row.filterJson).toEqual({ investigationStatus: ["review"], requireMissingChecklistItems: true });
    });

    it("DELETE /v1/siu/saved-views/:id — the creator deletes the view; row gone; refusals change nothing", async () => {
      const a = h.fixtures.teamA;
      const id = await createView(a.memberToken, `SIU delete ${tag()}`);
      const url = `/v1/siu/saved-views/${id}?teamId=${a.teamId}`;
      const foreign = await call({ method: "DELETE", url, token: h.fixtures.teamB.ownerToken });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json()).toEqual({ error: { code: "member_inactive" } });
      const viewer = await call({ method: "DELETE", url, token: a.viewerToken });
      expect(viewer.statusCode).toBe(404);
      expect(await prisma.caseSiuSavedView.count({ where: { id } })).toBe(1);

      const deleted = await call({ method: "DELETE", url, token: a.memberToken });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });
      expect(await prisma.caseSiuSavedView.count({ where: { id } })).toBe(0);
    });

    it("a workspace ADMIN may manage a colleague's shared SIU view", async () => {
      const a = h.fixtures.teamA;
      const id = await createView(a.memberToken, `SIU admin ${tag()}`);
      const url = `/v1/siu/saved-views/${id}?teamId=${a.teamId}`;
      const renamed = await call({ method: "PATCH", url, token: a.adminToken, payload: { name: "Admin renamed" } });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((await prisma.caseSiuSavedView.findUniqueOrThrow({ where: { id } })).updatedByUserId).toBe(a.adminUserId);
      const deleted = await call({ method: "DELETE", url, token: a.adminToken });
      expect(deleted.statusCode).toBe(200);
      expect(await prisma.caseSiuSavedView.count({ where: { id } })).toBe(0);
    });
  });
});

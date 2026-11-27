/**
 * Review remediation 2026-11-27 — coding (BEHAVIOUR-SPEC §6; F-13, F-15,
 * F-18, F-20, F-26, F-27) against a disposable PostgreSQL 16.
 *
 *   * explicit clear through POST /code { fieldId, clear: true }
 *   * GET /coding: `writable` reasons, `otherSchemaValues`, anti-enumeration
 *   * GET /v1/coding/schemas/:id: read-time help-text correction
 *   * buildCodingSnapshot / codingCompletenessRefusal (service level)
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type SchemaSvc = typeof import("../src/services/reviewer-workspace/coding-schema.service.js");
type ValueSvc = typeof import("../src/services/reviewer-workspace/coding-value.service.js");

const LEGACY = "Bounded reviewer decision; recorded on closure.";
const CORRECTED = "Your assessment (recommendation). The review decision is recorded separately.";

describe("Review remediation — coding (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let schemaSvc: SchemaSvc;
  let valueSvc: ValueSvc;

  const call = (opts: { method: "GET" | "POST"; url: string; token: string; payload?: unknown }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);

  async function newWorkflow(status = "IN_REVIEW") {
    const a = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: a.teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: {
        title: `rem coding ${tag()}`,
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId: a.teamId,
        organizationId: team.organizationId,
        ownerUserId: a.ownerUserId,
      },
      select: { id: true },
    });
    return (
      await prisma.evidenceReviewWorkflow.create({
        data: { evidenceId: evidence.id, teamId: a.teamId, workspaceType: "TEAM", status: status as never },
        select: { id: true },
      })
    ).id;
  }

  async function publishedSchema(label = "Remediation schema") {
    const a = h.fixtures.teamA;
    const created = await schemaSvc.createSchema({
      teamId: a.teamId,
      authorUserId: a.ownerUserId,
      slug: `rem-${tag()}`,
      label,
      category: "GENERAL_EVIDENCE",
      fields: [
        { slug: "verdict", label: "Verdict", fieldType: "REVIEWER_VERDICT", required: true, orderIndex: 0, helpText: LEGACY },
        { slug: "notes", label: "Notes", fieldType: "TEXT", required: false, orderIndex: 1 },
      ],
    });
    if (!created.ok) throw new Error(`createSchema refused: ${created.denial}`);
    expect(await schemaSvc.publishSchema({ teamId: a.teamId, schemaId: created.schemaId })).toMatchObject({ ok: true });
    const fields = await prisma.codingField.findMany({ where: { schemaId: created.schemaId }, orderBy: { orderIndex: "asc" } });
    return { schemaId: created.schemaId, verdict: fields[0]!, notes: fields[1]! };
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

  const codeUrl = (workflowId: string) => `/v1/reviewer/work/${workflowId}/code?teamId=${h.fixtures.teamA.teamId}`;
  const codingUrl = (workflowId: string) => `/v1/reviewer/work/${workflowId}/coding?teamId=${h.fixtures.teamA.teamId}`;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    schemaSvc = await import("../src/services/reviewer-workspace/coding-schema.service.js");
    valueSvc = await import("../src/services/reviewer-workspace/coding-value.service.js");
    const { teamA } = h.fixtures;
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } }))
      .organizationId;
    await prisma.team.update({ where: { id: teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
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

  // ---------------------------------------------------------------------------
  describe("explicit clear (F-13)", () => {
    it("POST /code {fieldId, clear:true} removes the current value, appends a cleared history row, audits; idempotent", async () => {
      const a = h.fixtures.teamA;
      const { schemaId, notes } = await publishedSchema();
      const wf = await newWorkflow();
      await bind(wf, schemaId);
      const write = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text: "Dent" } } });
      expect(write.statusCode, write.body).toBe(200);
      const valueId = write.json().codingValueId as string;

      const cleared = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, clear: true } });
      expect(cleared.statusCode, cleared.body).toBe(200);
      // Review remediation A — every answer carries the field revision (history count).
      expect(cleared.json()).toEqual({ cleared: true, codingValueId: valueId, revision: 2 });
      expect(await prisma.codingValue.count({ where: { workflowId: wf } })).toBe(0);
      const history = await prisma.codingValueHistory.findMany({
        where: { workflowId: wf, fieldId: notes.id },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      });
      expect(history.map((r) => [r.authorUserId, r.value])).toEqual([
        [a.memberUserId, { text: "Dent" }],
        [a.memberUserId, { cleared: true }],
      ]);
      const audit = await prisma.adminAuditLog.findFirst({ where: { action: "reviewer.code.clear", resourceId: valueId } });
      expect(audit).toMatchObject({ userId: a.memberUserId, workspaceId: a.teamId, outcome: "success", resourceType: "coding_value" });

      const again = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, clear: true } });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ cleared: false, codingValueId: null, revision: 2 });
      expect(await prisma.codingValueHistory.count({ where: { workflowId: wf, fieldId: notes.id } })).toBe(2);

      const sheet = await call({ method: "GET", url: codingUrl(wf), token: a.memberToken });
      expect(sheet.json().values).toEqual([]);
    });

    it("a clear is refused like a write: VIEWER 403, closed workflow, field of another schema, another tenant; nothing changes", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const { schemaId, notes } = await publishedSchema();
      const other = await publishedSchema("Other schema");
      const wf = await newWorkflow();
      await bind(wf, schemaId);
      await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text: "Keep" } } });

      const viewer = await call({ method: "POST", url: codeUrl(wf), token: a.viewerToken, payload: { fieldId: notes.id, clear: true } });
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json()).toEqual({ denial: "NOT_PERMITTED" });
      const mismatch = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: other.notes.id, clear: true } });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toEqual({ denial: "SCHEMA_VERSION_MISMATCH" });
      const foreign = await call({ method: "POST", url: codeUrl(wf), token: b.ownerToken, payload: { fieldId: notes.id, clear: true } });
      expect(foreign.statusCode).toBe(403);

      await prisma.evidenceReviewWorkflow.update({ where: { id: wf }, data: { status: "CLOSED" as never } });
      const closed = await valueSvc.clearCodingValue({ teamId: a.teamId, workflowId: wf, fieldId: notes.id, actorUserId: a.memberUserId });
      expect(closed).toEqual({ ok: false, denial: "WORKFLOW_CLOSED" });
      expect(await prisma.codingValue.count({ where: { workflowId: wf } })).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe("GET /coding — writable, otherSchemaValues, anti-enumeration (F-15, F-26)", () => {
    it("states why coding is not writable: unbound → no_schema, bound → allowed, closed → workflow_closed", async () => {
      const a = h.fixtures.teamA;
      const wf = await newWorkflow();
      const unbound = await call({ method: "GET", url: codingUrl(wf), token: a.memberToken });
      expect(unbound.statusCode, unbound.body).toBe(200);
      expect(unbound.json().writable).toEqual({ allowed: false, reason: "no_schema" });
      expect(unbound.json().otherSchemaValues).toEqual([]);

      const { schemaId } = await publishedSchema();
      await bind(wf, schemaId);
      const open = await call({ method: "GET", url: codingUrl(wf), token: a.memberToken });
      expect(open.json().writable).toEqual({ allowed: true, reason: null });

      for (const status of ["CLOSED", "APPROVED_INTERNAL", "REJECTED_INSUFFICIENT"]) {
        await prisma.evidenceReviewWorkflow.update({ where: { id: wf }, data: { status: status as never } });
        const closed = await call({ method: "GET", url: codingUrl(wf), token: a.memberToken });
        expect(closed.statusCode, closed.body).toBe(200);
        expect(closed.json().writable, status).toEqual({ allowed: false, reason: "workflow_closed" });
      }
    });

    it("after a rebind only the bound schema's values are current; earlier ones are listed as otherSchemaValues", async () => {
      const a = h.fixtures.teamA;
      const first = await publishedSchema("First schema");
      const second = await publishedSchema("Second schema");
      const wf = await newWorkflow();
      await bind(wf, first.schemaId);
      await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: first.notes.id, value: { text: "Old" } } });
      await bind(wf, second.schemaId);

      let sheet = (await call({ method: "GET", url: codingUrl(wf), token: a.memberToken })).json();
      expect(sheet.values).toEqual([]);
      expect(sheet.otherSchemaValues).toHaveLength(1);
      expect(sheet.otherSchemaValues[0]).toMatchObject({
        fieldId: first.notes.id,
        value: { text: "Old" },
        schemaId: first.schemaId,
        schemaLabel: "First schema",
        schemaVersion: 1,
        fieldLabel: "Notes",
        fieldType: "TEXT",
      });
      // The old value is kept, never deleted.
      expect(await prisma.codingValue.count({ where: { workflowId: wf, fieldId: first.notes.id } })).toBe(1);

      await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: second.notes.id, value: { text: "New" } } });
      sheet = (await call({ method: "GET", url: codingUrl(wf), token: a.memberToken })).json();
      expect(sheet.values.map((v: { fieldId: string }) => v.fieldId)).toEqual([second.notes.id]);
      expect(sheet.otherSchemaValues.map((v: { fieldId: string }) => v.fieldId)).toEqual([first.notes.id]);
    });

    it("a caller without reach gets the empty projection, indistinguishable from an unbound workflow", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const { schemaId, notes } = await publishedSchema();
      const wf = await newWorkflow();
      await bind(wf, schemaId);
      await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text: "Secret" } } });
      // B acts in its own (Team-entitled) workspace naming A's workflow.
      const before = await prisma.team.findUniqueOrThrow({ where: { id: b.teamId }, select: { billingPlan: true, billingStatus: true } });
      await prisma.team.update({ where: { id: b.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
      try {
        const res = await call({ method: "GET", url: `/v1/reviewer/work/${wf}/coding?teamId=${b.teamId}`, token: b.ownerToken });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({
          values: [],
          otherSchemaValues: [],
          revisions: {},
          coverage: { totalRequired: 0, fulfilled: 0, unfulfilledFieldIds: [] },
          schemaBinding: null,
          history: [],
          writable: { allowed: false, reason: "no_schema" },
        });
        expect(res.body).not.toContain("Secret");
      } finally {
        await prisma.team.update({ where: { id: b.teamId }, data: { billingPlan: before.billingPlan, billingStatus: before.billingStatus } as never });
      }
    });
  });

  // ---------------------------------------------------------------------------
  it("GET /v1/coding/schemas/:id corrects the seeded verdict help text at read time; the stored row is untouched (F-20)", async () => {
    const a = h.fixtures.teamA;
    const { schemaId, verdict, notes } = await publishedSchema();
    const res = await call({ method: "GET", url: `/v1/coding/schemas/${schemaId}?teamId=${a.teamId}`, token: a.memberToken });
    expect(res.statusCode, res.body).toBe(200);
    const fields = res.json().schema.fields as Array<{ id: string; helpText: string | null }>;
    expect(fields.find((f) => f.id === verdict.id)!.helpText).toBe(CORRECTED);
    expect(fields.find((f) => f.id === notes.id)!.helpText).toBeNull();
    expect((await prisma.codingField.findUniqueOrThrow({ where: { id: verdict.id } })).helpText).toBe(LEGACY);
  });

  // ---------------------------------------------------------------------------
  describe("buildCodingSnapshot (F-20)", () => {
    it("null when unbound; otherwise every bound field with its value (null when uncoded), inside a transaction", async () => {
      const a = h.fixtures.teamA;
      const wf = await newWorkflow();
      expect(await valueSvc.buildCodingSnapshot(prisma, { teamId: a.teamId, workflowId: wf })).toBeNull();
      const { schemaId, verdict, notes } = await publishedSchema();
      await bind(wf, schemaId);
      await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: verdict.id, value: { verdict: "APPROVE" } } });
      const now = new Date("2026-11-27T12:00:00.000Z");
      const snap = await prisma.$transaction((tx) =>
        valueSvc.buildCodingSnapshot(tx, { teamId: a.teamId, workflowId: wf, now }),
      );
      expect(snap).toEqual({
        schemaId,
        schemaVersion: 1,
        capturedAtUtc: "2026-11-27T12:00:00.000Z",
        values: [
          { fieldId: verdict.id, slug: "verdict", label: "Verdict", fieldType: "REVIEWER_VERDICT", value: { verdict: "APPROVE" } },
          { fieldId: notes.id, slug: "notes", label: "Notes", fieldType: "TEXT", value: null },
        ],
      });
      // Another workspace never reads it.
      expect(await valueSvc.buildCodingSnapshot(prisma, { teamId: h.fixtures.teamB.teamId, workflowId: wf })).toBeNull();
    });

    it("a finalizing decision stores the snapshot on its own event; a reopen keeps it; the next final writes its own", async () => {
      const a = h.fixtures.teamA;
      const wf = await newWorkflow();
      await prisma.evidenceReviewWorkflow.update({ where: { id: wf }, data: { assignedToUserId: a.memberUserId } });
      const { schemaId, verdict } = await publishedSchema();
      await bind(wf, schemaId);
      const code = (v: string) =>
        call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: verdict.id, value: { verdict: v } } });
      expect((await code("APPROVE")).statusCode).toBe(200);
      const { recordReviewDecision } = await import("../src/services/reviewer-ops/review-decision.service.js");
      const decide = (decision: "APPROVE" | "REJECT") =>
        recordReviewDecision({
          workflowId: wf,
          teamId: a.teamId,
          actorUserId: a.memberUserId,
          decision,
          rationale: `final ${decision}`,
          actorIsAdjudicator: false,
        } as never);
      const first = await decide("APPROVE");
      expect(String(first.workflow.status)).toBe("APPROVED_INTERNAL");
      const finals = () =>
        prisma.evidenceReviewWorkflowEvent.findMany({
          where: { workflowId: wf, eventType: "DECISION_LOGGED" },
          orderBy: { createdAt: "asc" },
        });
      const snapOf = (e: { nextValue: unknown }) =>
        (e.nextValue as { codingSnapshot?: { schemaId: string; values: Array<{ slug: string; value: unknown }> } }).codingSnapshot;
      const [e1] = await finals();
      expect(snapOf(e1!)).toMatchObject({ schemaId, values: [{ slug: "verdict", value: { verdict: "APPROVE" } }, { slug: "notes", value: null }] });

      // Reopen (the canonical lifecycle) and resume: the first round's snapshot is untouched.
      const { recordLifecycleTransition } = await import("../src/services/review-operations/review-operations.service.js");
      const evidenceId = (await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf } })).evidenceId;
      await recordLifecycleTransition({ evidenceId, decision: "REOPEN", actorUserId: a.ownerUserId, note: "new material" } as never);
      await prisma.evidenceReviewWorkflow.update({ where: { id: wf }, data: { status: "IN_REVIEW" } });
      expect((await code("REJECT")).statusCode).toBe(200);
      const second = await decide("REJECT");
      expect(String(second.workflow.status)).toBe("REJECTED_INSUFFICIENT");
      const [after1, after2] = await finals();
      expect(after1!.id).toBe(e1!.id);
      expect(snapOf(after1!)).toEqual(snapOf(e1!));
      expect(snapOf(after2!)).toMatchObject({ values: [{ slug: "verdict", value: { verdict: "REJECT" } }, { slug: "notes", value: null }] });
    });
  });

  // ---------------------------------------------------------------------------
  describe("codingCompletenessRefusal (F-18)", () => {
    const since = new Date("2026-11-27T10:00:00.000Z");
    const after = new Date("2026-11-27T11:00:00.000Z");
    const before = new Date("2026-11-27T09:00:00.000Z");

    async function setPolicy(on: boolean, sinceAt: Date | null) {
      const teamId = h.fixtures.teamA.teamId;
      await prisma.workspaceGovernancePolicy.upsert({
        where: { teamId },
        create: { teamId, reviewRequiresCompleteCoding: on, reviewRequiresCompleteCodingSince: sinceAt },
        update: { reviewRequiresCompleteCoding: on, reviewRequiresCompleteCodingSince: sinceAt },
      });
    }

    it("applies only with the policy on, to APPROVE/REJECT, for rounds started at/after `since`", async () => {
      const a = h.fixtures.teamA;
      const { schemaId, verdict } = await publishedSchema();
      const wf = await newWorkflow();
      await bind(wf, schemaId);
      const ask = (decision: string, roundStartedAt: Date | null) =>
        valueSvc.codingCompletenessRefusal(prisma, { teamId: a.teamId, workflowId: wf, decision, roundStartedAt });
      try {
        await setPolicy(false, since);
        expect(await ask("APPROVE", after)).toBeNull();

        await setPolicy(true, since);
        const refusal = await prisma.$transaction((tx) =>
          valueSvc.codingCompletenessRefusal(tx, { teamId: a.teamId, workflowId: wf, decision: "APPROVE", roundStartedAt: after }),
        );
        expect(refusal).toEqual({ reason: "coding_incomplete", missingFieldIds: [verdict.id], missingLabels: ["Verdict"] });
        expect(await ask("REJECT", after)).toMatchObject({ reason: "coding_incomplete" });
        expect(await ask("APPROVE", since)).toMatchObject({ reason: "coding_incomplete" });
        expect(await ask("REQUEST_INFO", after)).toBeNull();
        expect(await ask("APPROVE", before)).toBeNull();
        expect(await ask("APPROVE", null)).toBeNull();

        await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: verdict.id, value: { verdict: "APPROVE" } } });
        expect(await ask("APPROVE", after)).toBeNull();
      } finally {
        await setPolicy(false, null);
      }
    });

    it("an unbound workflow is never refused", async () => {
      const a = h.fixtures.teamA;
      const wf = await newWorkflow();
      try {
        await setPolicy(true, since);
        expect(
          await valueSvc.codingCompletenessRefusal(prisma, { teamId: a.teamId, workflowId: wf, decision: "APPROVE", roundStartedAt: after }),
        ).toBeNull();
      } finally {
        await setPolicy(false, null);
      }
    });
  });
});

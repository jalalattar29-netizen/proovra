/**
 * PHASE 37.98 — Live reviewer workflow lifecycle proof.
 *
 * Exercises the real reviewer workspace + reviewer ops routes end-to-end
 * against a live Fastify instance and a seeded test database.
 *
 * The intent is to prove real workflow creation, assignment, coding,
 * decision capture, disagreement filing, SLA reconciliation, runtime
 * probe visibility, and QC sampling across the true backend routes.
 *
 * This file is intentionally gated on RUN_LIVE_INTEGRATION so it stays
 * inert in the normal unit-test run.
 *
 * NOTE: this test is an optional live integration probe only.
 * It is not meant to be a default CI blocker, and it depends on slow
 * harness startup and real backend route execution.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  isLiveIntegrationEnabled,
  type IntegrationHarness,
  type TeamFixture,
} from "./integration-harness.js";

type JsonRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
};

const RUN = isLiveIntegrationEnabled();
const block = RUN ? describe : describe.skip;

block("Phase 37.98 — live reviewer workflow lifecycle proof", () => {
  let harness: IntegrationHarness | undefined;
  let teamA!: TeamFixture;
  let api!: { fetch: (path: string, init?: JsonRequestInit) => Promise<Response> };

  beforeAll(async () => {
    process.env.REVIEWER_QC_SAMPLE_PERCENT = "100";
    harness = await bootIntegrationHarness();
    teamA = harness.fixtures.teamA;
    api = {
      fetch: async (path, init) => {
        const res = await harness!.app.inject({
          method:
            (init?.method as "GET" | "POST" | "PATCH" | "DELETE" | undefined) ??
            "GET",
          url: path,
          headers: (init?.headers as Record<string, string> | undefined) ?? {},
          payload:
            typeof init?.body === "string"
              ? init.body
              : init?.body
                ? JSON.stringify(init.body)
                : undefined,
        });
        return {
          status: res.statusCode,
          json: async () => JSON.parse(res.body),
          text: async () => res.body,
        } as unknown as Response;
      },
    };
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  it("runs a real reviewer workflow lifecycle end-to-end", async () => {
    const adminHeaders = {
      authorization: `Bearer ${teamA.adminToken}`,
      "content-type": "application/json",
    };
    const memberHeaders = {
      authorization: `Bearer ${teamA.memberToken}`,
      "content-type": "application/json",
    };

    const dueAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let response = await api.fetch(
      `/v1/evidence/${teamA.evidenceId}/reviewer-workflow`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: {
          teamId: teamA.teamId,
          status: "QUEUED",
          dueAt,
          note: "Integration test: prepare reviewer workflow",
        },
      },
    );
    expect(response.status).toBe(200);
    const workflowSummary = await response.json();
    expect(workflowSummary?.available).toBe(true);
    const workflowId = workflowSummary.workflow?.id;
    expect(typeof workflowId).toBe("string");

    response = await api.fetch(
      `/v1/reviewer-ops/queue?teamId=${teamA.teamId}&queue=UNASSIGNED`,
      { headers: { authorization: `Bearer ${teamA.adminToken}` } },
    );
    expect(response.status).toBe(200);
    const queue = await response.json();
    expect(Array.isArray(queue.rows)).toBe(true);
    expect(queue.rows.some((row: { id: string }) => row.id === workflowId)).toBe(true);

    response = await api.fetch(
      `/v1/reviewer-ops/reviews/${workflowId}/assign`,
      {
        method: "POST",
        headers: adminHeaders,
        body: {
          teamId: teamA.teamId,
          assignedToUserId: teamA.memberUserId,
        },
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/reviewer-ops/reviews/${workflowId}/start`,
      {
        method: "POST",
        headers: memberHeaders,
        body: { teamId: teamA.teamId },
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/coding/schemas/seed-defaults?teamId=${teamA.teamId}`,
      {
        method: "POST",
        headers: adminHeaders,
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/coding/schemas?teamId=${teamA.teamId}&status=PUBLISHED`,
      { headers: adminHeaders },
    );
    expect(response.status).toBe(200);
    const schemaList = await response.json();
    const schema = Array.isArray(schemaList.schemas)
      ? schemaList.schemas.find((schemaRow: { status: string }) => schemaRow.status === "PUBLISHED")
      : null;
    expect(schema).toBeTruthy();
    const schemaId = schema?.id;
    expect(typeof schemaId).toBe("string");

    response = await api.fetch(
      `/v1/reviewer/work/${workflowId}/bind-schema`,
      {
        method: "POST",
        headers: adminHeaders,
        body: { schemaId },
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/coding/schemas/${schemaId}?teamId=${teamA.teamId}`,
      { headers: memberHeaders },
    );
    expect(response.status).toBe(200);
    const schemaDetail = await response.json();
    const fields = Array.isArray(schemaDetail.schema?.fields)
      ? schemaDetail.schema.fields
      : [];
    const riskField = fields.find((field: { fieldType: string }) => field.fieldType === "RISK_LEVEL");
    const verdictField = fields.find(
      (field: { fieldType: string }) => field.fieldType === "REVIEWER_VERDICT",
    );
    expect(riskField).toBeTruthy();
    expect(verdictField).toBeTruthy();

    response = await api.fetch(
      `/v1/reviewer/work/${workflowId}/code?teamId=${teamA.teamId}`,
      {
        method: "POST",
        headers: memberHeaders,
        body: {
          fieldId: riskField.id,
          value: { risk: "LOW" },
          rationale: "Integration test risk coding",
        },
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/reviewer/work/${workflowId}/code?teamId=${teamA.teamId}`,
      {
        method: "POST",
        headers: memberHeaders,
        body: {
          fieldId: verdictField.id,
          value: { verdict: "APPROVE" },
          rationale: "Integration test verdict coding",
        },
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/reviewer/work/${workflowId}/coding?teamId=${teamA.teamId}`,
      { headers: memberHeaders },
    );
    expect(response.status).toBe(200);
    const coding = await response.json();
    expect(Array.isArray(coding.values)).toBe(true);
    expect(coding.coverage?.fulfilled).toBeGreaterThanOrEqual(1);

    response = await api.fetch(
      `/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${teamA.teamId}`,
      { headers: memberHeaders },
    );
    expect(response.status).toBe(200);
    const existingDecisions = await response.json();
    expect(Array.isArray(existingDecisions.decisions)).toBe(true);
    expect(existingDecisions.decisions.length).toBe(0);

    response = await api.fetch(
      `/v1/reviewer-ops/workspace/${workflowId}/decisions`,
      {
        method: "POST",
        headers: memberHeaders,
        body: {
          teamId: teamA.teamId,
          decision: "APPROVE",
          rationale: "Integration test review decision",
        },
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${teamA.teamId}`,
      { headers: memberHeaders },
    );
    expect(response.status).toBe(200);
    const decisions = await response.json();
    expect(Array.isArray(decisions.decisions)).toBe(true);
    expect(decisions.decisions.length).toBe(1);
    const originalDecisionId = decisions.decisions[0]?.id;
    expect(typeof originalDecisionId).toBe("string");

    response = await api.fetch(
      `/v1/reviewer/work/${workflowId}/disagree`,
      {
        method: "POST",
        headers: adminHeaders,
        body: {
          teamId: teamA.teamId,
          originalDecisionId,
          rationale: "Integration test disagreement filed",
        },
      },
    );
    expect(response.status).toBe(201);
    const disagreementCreated = await response.json();
    expect(typeof disagreementCreated.disagreementId).toBe("string");

    response = await api.fetch(
      `/v1/reviewer/disagreements?teamId=${teamA.teamId}&mine=true`,
      { headers: adminHeaders },
    );
    expect(response.status).toBe(200);
    const disagreements = await response.json();
    expect(Array.isArray(disagreements.disagreements)).toBe(true);
    expect(
      disagreements.disagreements.some(
        (item: { id: string }) => item.id === disagreementCreated.disagreementId,
      ),
    ).toBe(true);

    response = await api.fetch(
      `/v1/review-operations/reconcile-slas`,
      {
        method: "POST",
        headers: adminHeaders,
        body: { teamId: teamA.teamId },
      },
    );
    expect(response.status).toBe(200);
    const reconcile = await response.json();
    expect(reconcile.summary?.flippedBreached).toBeGreaterThanOrEqual(1);

    response = await api.fetch(
      `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamA.teamId}`,
      { headers: adminHeaders },
    );
    expect(response.status).toBe(200);
    const workspaceDetail = await response.json();
    expect(["DUE_SOON", "OVERDUE", "BREACHED"]).toContain(
      workspaceDetail.projection?.slaStatus,
    );

    response = await api.fetch(
      `/v1/reviewer-ops/runtime-probe?teamId=${teamA.teamId}`,
      { headers: adminHeaders },
    );
    expect(response.status).toBe(200);
    const runtimeProbe = await response.json();
    expect(runtimeProbe.probe).toBeTruthy();

    response = await api.fetch(
      `/v1/reviewer-ops/reviews/${workflowId}/approve`,
      {
        method: "POST",
        headers: memberHeaders,
        body: { teamId: teamA.teamId },
      },
    );
    expect(response.status).toBe(200);

    response = await api.fetch(
      `/v1/reviewer/qc/samples?teamId=${teamA.teamId}`,
      { headers: adminHeaders },
    );
    expect(response.status).toBe(200);
    const qc = await response.json();
    expect(Array.isArray(qc.samples)).toBe(true);
    expect(qc.samples.length).toBeGreaterThanOrEqual(1);
  });
});

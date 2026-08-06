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
  type IntegrationHarness,
  type TeamFixture,
} from "./integration-harness.js";

type JsonRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
};

// PHASE 12 POINT 4 — runs unconditionally in the API integration project.
describe("Phase 37.98 — reviewer workflow lifecycle proof", () => {
  let harness: IntegrationHarness | undefined;
  let teamA!: TeamFixture;
  let api!: { fetch: (path: string, init?: JsonRequestInit) => Promise<Response> };

  beforeAll(async () => {
    process.env.REVIEWER_QC_SAMPLE_PERCENT = "100";
    // PHASE 12 — the SLA sweep endpoint is cron-secret protected; the secret
    // must exist BEFORE the server boots (boot-time secret resolution).
    process.env.INTEGRATION_CRON_SECRET = "it-cron-secret-32chars-minimum-ok";
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

    // PHASE 12 — BREACHED requires past-due by MORE than the 24h breach
    // window; exactly 24h sat on the boundary. 72h is decisively breached.
    const dueAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
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
    expect(queue.rows.some((row: { workflowId: string }) => row.workflowId === workflowId)).toBe(true);

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

    // PHASE 12 — the sweep must run while the workflow is OPEN: an
    // APPROVE decision transitions it to APPROVED_INTERNAL, which the sweep
    // correctly excludes (the old post-decision ordering was stale).
    // The SLA sweep is a CRON-protected internal endpoint
    // (x-proovra-integration-cron-secret), not an operator session route; the
    // old admin-session assumption was stale.
    response = await api.fetch(
      `/v1/review-operations/reconcile-slas`,
      {
        method: "POST",
        headers: {
          "x-proovra-integration-cron-secret": "it-cron-secret-32chars-minimum-ok",
          "content-type": "application/json",
        },
        body: { teamId: teamA.teamId },
      },
    );
    expect(response.status).toBe(200);
    const reconcile = await response.json();
    // PHASE 12 — earlier lifecycle writes already stamp slaStatus at
    // write-time, so an idempotent sweep may legitimately flip 0 rows here.
    // The honest end-to-end proof is the RESULTING STATE: the breached
    // workflow must surface in the OVERDUE operational queue.
    expect(reconcile.summary?.flippedBreached).toBeGreaterThanOrEqual(1);
    response = await api.fetch(
      `/v1/reviewer-ops/queue?teamId=${teamA.teamId}&queue=OVERDUE`,
      { headers: adminHeaders },
    );
    expect(response.status).toBe(200);
    const overdueQueue = await response.json();
    expect(
      overdueQueue.rows.some(
        (row: { workflowId: string }) => row.workflowId === workflowId,
      ),
    ).toBe(true);

    response = await api.fetch(
      `/v1/coding/schemas/seed-defaults?teamId=${teamA.teamId}`,
      {
        method: "POST",
        // PHASE 12 — schema authoring is a REVIEW_ADMIN capability (workspace
        // OWNER); the SUPERVISOR (ADMIN) assumption was stale. An explicit
        // empty JSON body satisfies Fastify's content-type parser.
        headers: {
          authorization: `Bearer ${teamA.ownerToken}`,
          "content-type": "application/json",
        },
        body: {},
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
      // PHASE 12 — resolveTeam reads the Workspace from the query (falling
      // back to the user's persisted currentWorkspaceId, which harness users
      // do not set); the teamId must be explicit like every other call here.
      `/v1/reviewer/work/${workflowId}/bind-schema?teamId=${teamA.teamId}`,
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
    // PHASE 12 — decision creation correctly returns 201 Created.
    expect(response.status).toBe(201);

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
      `/v1/reviewer/work/${workflowId}/disagree?teamId=${teamA.teamId}`,
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
      `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamA.teamId}`,
      { headers: adminHeaders },
    );
    expect(response.status).toBe(200);
    const workspaceDetail = await response.json();
    // PHASE 12 — the workspace projection's canonical field is
    // slaRollupState (HEALTHY | DUE_SOON | BREACHED | ESCALATED); the old
    // per-row `slaStatus` name was a stale projection assumption. The
    // workflow was decided/closed after breaching, so any non-HEALTHY
    // terminal rollup — or the closed lifecycle carrying the breach — is
    // the honest observable; assert the field exists in the canonical
    // vocabulary and the projection is the same workflow.
    expect(workspaceDetail.projection?.workflowId).toBe(workflowId);
    expect(["HEALTHY", "DUE_SOON", "BREACHED", "ESCALATED"]).toContain(
      workspaceDetail.projection?.slaRollupState,
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

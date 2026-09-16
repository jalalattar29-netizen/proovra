/**
 * BATCH K3 — runtime proof, evidence capture cluster (part B).
 *
 * Evidence Requests (the whole authenticated workflow), the evidence record's
 * own mutations (trash, collaborative-content deletes, relationship delete,
 * legacy guest claim) and evidence saved views — each proven through the REAL
 * route against a disposable PostgreSQL: success with the product consumer's
 * payload and a durable re-read, the event/audit trail, and a bounded refusal
 * that leaves nothing behind.
 *
 * Feature flags are fixture-safe and read at call time: Evidence Requests and
 * intake links are switched on for this process, the intake HMAC secret is a
 * throwaway literal, and outbound email goes to the harness's RECORDING
 * transport.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("K3 runtime proof — evidence capture (part B)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let organizationA = "";

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  const PERMISSION_DENIED = { error: { code: "permission_denied", reason: "permission_not_granted" } };

  async function evidenceIn(teamId: string, ownerUserId: string, title: string, status: "CREATED" | "SIGNED" = "SIGNED") {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (await prisma.evidence.create({
      data: { title, type: "PHOTO", status, mimeType: "image/jpeg", teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    })).id;
  }

  beforeAll(async () => {
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "integration-only-intake-secret-k3-0123456789abcdef";

    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    const { teamA } = harness.fixtures;
    organizationA = (await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })).organizationId;
    // Organization A is an Enterprise customer (secure intake is included).
    await prisma.team.update({ where: { id: teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, {
      organizationId: organizationA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ===========================================================================
  // Evidence Requests
  // ===========================================================================
  describe("evidence requests", () => {
    const base = "/v1/evidence-requests";

    /** The payload the evidence page's "New evidence request" dialog builds. */
    function webCreatePayload(teamId: string, evidenceId: string, title: string) {
      return {
        teamId,
        evidenceId,
        requestType: "ADDITIONAL_EVIDENCE",
        title,
        instructions: "Please photograph the damaged panel in daylight.",
        priority: "NORMAL",
        dueAtUtc: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        recipientLabel: "Claimant",
        recipientEmail: "claimant@test.proovra.local",
        createIntakeLink: true,
        deliverables: [
          {
            title: "Primary evidence",
            description: "",
            required: true,
            acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
            minCount: 1,
            locationRequirement: "optional",
            captureAfterRequest: false,
            sortOrder: 0,
          },
        ],
      };
    }

    async function createRequest(title: string) {
      const { teamA } = harness.fixtures;
      const res = await call("POST", base, teamA.memberToken, webCreatePayload(teamA.teamId, teamA.evidenceId, title));
      expect(res.statusCode, res.body).toBe(201);
      return json(res).request as Json;
    }

    /** An external submission, as the public intake pipeline records it. */
    async function withResponse(requestId: string) {
      await prisma.evidenceRequest.update({ where: { id: requestId }, data: { status: "RESPONSE_RECEIVED" } });
      return (await prisma.evidenceRequestResponse.create({
        data: { evidenceRequestId: requestId, submittedByExternalLabel: "Claimant", status: "RECEIVED" },
        select: { id: true },
      })).id;
    }

    const eventsOf = (id: string) =>
      prisma.evidenceRequestEvent.findMany({ where: { evidenceRequestId: id }, orderBy: { createdAt: "asc" } });

    it("POST /v1/evidence-requests — a reviewer creates a DRAFT with its deliverables", async () => {
      const { teamA } = harness.fixtures;
      const request = await createRequest("Additional evidence needed");
      const row = await prisma.evidenceRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: { deliverables: true },
      });
      expect(row).toMatchObject({
        teamId: teamA.teamId,
        evidenceId: teamA.evidenceId,
        status: "DRAFT",
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        recipientEmail: "claimant@test.proovra.local",
        requestedByUserId: teamA.memberUserId,
      });
      expect(row.deliverables.map((d) => [d.title, d.status])).toEqual([["Primary evidence", "PENDING"]]);
      const events = await eventsOf(request.id);
      expect(events.map((e) => [e.eventType, e.actorUserId])).toEqual([["EVIDENCE_REQUEST_CREATED", teamA.memberUserId]]);
    });

    it("POST /v1/evidence-requests refuses a viewer (403) and a non-member (404) and writes no request", async () => {
      const { teamA, teamB } = harness.fixtures;
      const before = await prisma.evidenceRequest.count({ where: { teamId: teamA.teamId } });
      const viewer = await call("POST", base, teamA.viewerToken, webCreatePayload(teamA.teamId, teamA.evidenceId, "viewer"));
      expect(viewer.statusCode).toBe(403);
      expect(json(viewer)).toEqual(PERMISSION_DENIED);
      const foreign = await call("POST", base, teamB.ownerToken, webCreatePayload(teamA.teamId, teamA.evidenceId, "foreign"));
      expect(foreign.statusCode).toBe(404);
      // An API caller naming another tenant's user as reviewer.
      const crossTenant = await call("POST", base, teamA.memberToken, {
        ...webCreatePayload(teamA.teamId, teamA.evidenceId, "cross-tenant reviewer"),
        recipientMode: "INTERNAL_USER",
        assignedReviewerUserId: teamB.memberUserId,
      });
      expect(crossTenant.statusCode, crossTenant.body).toBe(400);
      expect(json(crossTenant).error.code).toBe("assignee_not_workspace_member");
      expect(await prisma.evidenceRequest.count({ where: { teamId: teamA.teamId } })).toBe(before);
    });

    it("PATCH /v1/evidence-requests/:id — edits a DRAFT and replaces its deliverables", async () => {
      const { teamA } = harness.fixtures;
      const request = await createRequest("Draft to edit");
      const res = await call("PATCH", `${base}/${request.id}`, teamA.memberToken, {
        title: "Two angles of the damaged panel",
        priority: "HIGH",
        assignedReviewerUserId: teamA.adminUserId,
        deliverables: [
          { title: "Wide shot", acceptedKinds: ["PHOTO"], required: true },
          { title: "Close-up", acceptedKinds: ["PHOTO"], required: false, sortOrder: 1 },
        ],
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.evidenceRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: { deliverables: { orderBy: { sortOrder: "asc" } } },
      });
      expect(row).toMatchObject({
        title: "Two angles of the damaged panel",
        priority: "HIGH",
        assignedReviewerUserId: teamA.adminUserId,
        status: "DRAFT",
      });
      expect(row.deliverables.map((d) => [d.title, d.required])).toEqual([
        ["Wide shot", true],
        ["Close-up", false],
      ]);
      const edited = (await eventsOf(request.id)).find((e) => e.eventType === "EVIDENCE_REQUEST_EDITED");
      expect(edited?.actorUserId).toBe(teamA.memberUserId);
      expect(edited?.payload).toMatchObject({ deliverableCount: 2 });
    });

    it("PATCH refuses a viewer (403), a non-member (404) and an assignee from another tenant (400), changing nothing", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Draft that must not move");
      const viewer = await call("PATCH", `${base}/${request.id}`, teamA.viewerToken, { title: "viewer" });
      expect(viewer.statusCode).toBe(403);
      expect(json(viewer)).toEqual(PERMISSION_DENIED);
      const foreign = await call("PATCH", `${base}/${request.id}`, teamB.ownerToken, { title: "foreign" });
      expect(foreign.statusCode).toBe(404);
      // A request in workspace A must never name a user of workspace B as its
      // reviewer: sending it would email B's user about A's request.
      const crossTenant = await call("PATCH", `${base}/${request.id}`, teamA.memberToken, {
        assignedReviewerUserId: teamB.memberUserId,
      });
      expect(crossTenant.statusCode, crossTenant.body).toBe(400);
      expect(json(crossTenant).error.code).toBe("assignee_not_workspace_member");
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row).toMatchObject({ title: "Draft that must not move", assignedReviewerUserId: null });
      expect((await eventsOf(request.id)).map((e) => e.eventType)).toEqual(["EVIDENCE_REQUEST_CREATED"]);
    });

    it("POST /v1/evidence-requests/:id/send — opens the intake link, notifies the recipient and marks SENT", async () => {
      const { teamA } = harness.fixtures;
      const request = await createRequest("Request to send");
      // The web panel sends no body.
      const res = await call("POST", `${base}/${request.id}/send`, teamA.memberToken);
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res);
      expect(body.rawToken).toEqual(expect.any(String));
      expect(body.request.status).toBe("SENT");

      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("SENT");
      expect(row.sentAtUtc).toBeInstanceOf(Date);
      expect(row.intakeLinkId).toEqual(expect.any(String));
      const link = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: row.intakeLinkId! } });
      expect(link).toMatchObject({ teamId: teamA.teamId, createdByUserId: teamA.memberUserId, recipientEmail: "claimant@test.proovra.local" });
      expect(link.tokenHash).not.toContain(body.rawToken);
      expect((await eventsOf(request.id)).map((e) => e.eventType)).toEqual([
        "EVIDENCE_REQUEST_CREATED",
        "EVIDENCE_REQUEST_OPEN",
        "EVIDENCE_REQUEST_LINK_CREATED",
        "EVIDENCE_REQUEST_SENT",
      ]);
      const delivery = await prisma.notificationDelivery.findFirstOrThrow({
        where: { evidenceRequestId: request.id, eventType: "EVIDENCE_REQUEST_SENT" },
      });
      expect(delivery.teamId).toBe(teamA.teamId);
    });

    it("POST .../send refuses a viewer (403) and a non-member (404) and leaves the DRAFT unsent", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request nobody else may send");
      const viewer = await call("POST", `${base}/${request.id}/send`, teamA.viewerToken);
      expect(viewer.statusCode).toBe(403);
      const foreign = await call("POST", `${base}/${request.id}/send`, teamB.ownerToken);
      expect(foreign.statusCode).toBe(404);
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row).toMatchObject({ status: "DRAFT", sentAtUtc: null, intakeLinkId: null });
    });

    it("POST /v1/evidence-requests/:id/assign — assigns a workspace member as reviewer", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request to assign");
      const viewer = await call("POST", `${base}/${request.id}/assign`, teamA.viewerToken, { assignedReviewerUserId: teamA.adminUserId });
      expect(viewer.statusCode).toBe(403);
      const foreignActor = await call("POST", `${base}/${request.id}/assign`, teamB.ownerToken, { assignedReviewerUserId: teamB.ownerUserId });
      expect(foreignActor.statusCode).toBe(404);
      const foreignAssignee = await call("POST", `${base}/${request.id}/assign`, teamA.memberToken, { assignedReviewerUserId: teamB.memberUserId });
      expect(foreignAssignee.statusCode).toBe(400);
      expect(json(foreignAssignee).error.code).toBe("assignee_not_workspace_member");
      expect((await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } })).assignedReviewerUserId).toBeNull();

      const res = await call("POST", `${base}/${request.id}/assign`, teamA.memberToken, { assignedReviewerUserId: teamA.adminUserId });
      expect(res.statusCode, res.body).toBe(200);
      expect((await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } })).assignedReviewerUserId).toBe(teamA.adminUserId);
      const assigned = (await eventsOf(request.id)).find((e) => e.eventType === "EVIDENCE_REQUEST_ASSIGNED");
      expect(assigned).toMatchObject({ actorUserId: teamA.memberUserId, payload: { assignedReviewerUserId: teamA.adminUserId } });
    });

    it("POST /v1/evidence-requests/:id/cancel — cancels with the reviewer's justification", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request to cancel");
      const foreign = await call("POST", `${base}/${request.id}/cancel`, teamB.ownerToken, { reviewerNote: "x" });
      expect(foreign.statusCode).toBe(404);
      const viewer = await call("POST", `${base}/${request.id}/cancel`, teamA.viewerToken, { reviewerNote: "x" });
      expect(viewer.statusCode).toBe(403);
      // The justification is mandatory for a cancellation, and bounded when absent.
      const missing = await call("POST", `${base}/${request.id}/cancel`, teamA.memberToken);
      expect(missing.statusCode).toBe(422);
      expect(json(missing).error.code).toBe("reviewer_note_required");
      expect((await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("DRAFT");

      const res = await call("POST", `${base}/${request.id}/cancel`, teamA.memberToken, {
        reviewerNote: "Duplicate of an earlier request.",
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("CANCELLED");
      expect(row.cancelledAtUtc).toBeInstanceOf(Date);
      const event = (await eventsOf(request.id)).find((e) => e.eventType === "EVIDENCE_REQUEST_CANCELLED");
      expect(event).toMatchObject({ actorUserId: teamA.memberUserId, payload: { reviewerNote: "Duplicate of an earlier request." } });
    });

    it("POST /v1/evidence-requests/:id/close — closes a sent request with the reviewer's justification", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request to close");
      expect((await call("POST", `${base}/${request.id}/send`, teamA.memberToken)).statusCode).toBe(200);
      const foreign = await call("POST", `${base}/${request.id}/close`, teamB.ownerToken, { reviewerNote: "x" });
      expect(foreign.statusCode).toBe(404);
      const viewer = await call("POST", `${base}/${request.id}/close`, teamA.viewerToken, { reviewerNote: "x" });
      expect(viewer.statusCode).toBe(403);
      expect((await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("SENT");

      const res = await call("POST", `${base}/${request.id}/close`, teamA.memberToken, {
        reviewerNote: "Resolved by phone.",
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("CLOSED");
      expect(row.closedAtUtc).toBeInstanceOf(Date);
      const event = (await eventsOf(request.id)).find((e) => e.eventType === "EVIDENCE_REQUEST_CLOSED");
      expect(event).toMatchObject({ actorUserId: teamA.memberUserId, payload: { reviewerNote: "Resolved by phone." } });
    });

    it("POST /v1/evidence-requests/:id/needs-more-info — flags a received response for more information", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request needing more");
      expect((await call("POST", `${base}/${request.id}/send`, teamA.memberToken)).statusCode).toBe(200);
      await withResponse(request.id);
      const foreign = await call("POST", `${base}/${request.id}/needs-more-info`, teamB.ownerToken, { reviewerNote: "x" });
      expect(foreign.statusCode).toBe(404);
      const viewer = await call("POST", `${base}/${request.id}/needs-more-info`, teamA.viewerToken, { reviewerNote: "x" });
      expect(viewer.statusCode).toBe(403);
      expect((await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("RESPONSE_RECEIVED");

      const res = await call("POST", `${base}/${request.id}/needs-more-info`, teamA.memberToken, {
        reviewerNote: "The photo is too dark to read the plate.",
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row).toMatchObject({
        status: "NEEDS_MORE_INFO",
        reviewerNote: "The photo is too dark to read the plate.",
        reviewerDecisionByUserId: teamA.memberUserId,
      });
      expect(row.reviewerDecisionAt).toBeInstanceOf(Date);
      expect((await eventsOf(request.id)).some((e) => e.eventType === "EVIDENCE_REQUEST_NEEDS_MORE_INFO")).toBe(true);
    });

    it("POST /v1/evidence-requests/:id/deliverables/:deliverableId/waive — waives a pending deliverable", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request with a waivable deliverable");
      const deliverableId = request.deliverables[0].id as string;
      const url = `${base}/${request.id}/deliverables/${deliverableId}/waive`;
      expect((await call("POST", url, teamB.ownerToken, { reason: "x" })).statusCode).toBe(404);
      expect((await call("POST", url, teamA.viewerToken, { reason: "x" })).statusCode).toBe(403);
      // A deliverable id from a different request is not this request's deliverable.
      const other = await createRequest("Other request");
      const mismatched = await call("POST", `${base}/${other.id}/deliverables/${deliverableId}/waive`, teamA.memberToken, { reason: "x" });
      expect(mismatched.statusCode).toBe(404);
      expect(json(mismatched).error.code).toBe("deliverable_not_found");
      expect((await prisma.evidenceRequestDeliverable.findUniqueOrThrow({ where: { id: deliverableId } })).status).toBe("PENDING");

      const res = await call("POST", url, teamA.memberToken, { reason: "Already on file from the police report." });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.evidenceRequestDeliverable.findUniqueOrThrow({ where: { id: deliverableId } });
      expect(row).toMatchObject({ status: "WAIVED", waivedReason: "Already on file from the police report." });
      const event = (await eventsOf(request.id)).find((e) => e.eventType === "EVIDENCE_REQUEST_DELIVERABLE_WAIVED");
      expect(event).toMatchObject({ actorUserId: teamA.memberUserId, payload: { deliverableId } });
    });

    it("POST /v1/evidence-requests/:id/responses/:responseId/review — records the reviewer's decision", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request to review");
      expect((await call("POST", `${base}/${request.id}/send`, teamA.memberToken)).statusCode).toBe(200);
      const responseId = await withResponse(request.id);
      const url = `${base}/${request.id}/responses/${responseId}/review`;
      expect((await call("POST", url, teamB.ownerToken, { status: "ACCEPTED" })).statusCode).toBe(404);
      expect((await call("POST", url, teamA.viewerToken, { status: "ACCEPTED" })).statusCode).toBe(403);
      expect((await prisma.evidenceRequestResponse.findUniqueOrThrow({ where: { id: responseId } })).status).toBe("RECEIVED");

      // The web panel's accept payload: no note for ACCEPTED.
      const res = await call("POST", url, teamA.memberToken, { status: "ACCEPTED", notifyContributor: false, notifyChannel: "SMS" });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.evidenceRequestResponse.findUniqueOrThrow({ where: { id: responseId } });
      expect(row).toMatchObject({ status: "ACCEPTED", reviewedByUserId: teamA.memberUserId });
      expect(row.reviewedAtUtc).toBeInstanceOf(Date);
      const event = (await eventsOf(request.id)).find((e) => e.eventType === "EVIDENCE_REQUEST_RESPONSE_ACCEPTED");
      expect(event).toMatchObject({ actorUserId: teamA.memberUserId, payload: { responseId } });
    });

    it("POST /v1/evidence-requests/:id/responses/:responseId/request-more — issues a fresh intake link", async () => {
      const { teamA, teamB } = harness.fixtures;
      const request = await createRequest("Request to follow up");
      expect((await call("POST", `${base}/${request.id}/send`, teamA.memberToken)).statusCode).toBe(200);
      const responseId = await withResponse(request.id);
      const url = `${base}/${request.id}/responses/${responseId}/request-more`;
      const linksBefore = await prisma.workflowIntakeLink.count({ where: { teamId: teamA.teamId } });
      expect((await call("POST", url, teamB.ownerToken, { reviewerNote: "x" })).statusCode).toBe(404);
      expect((await call("POST", url, teamA.viewerToken, { reviewerNote: "x" })).statusCode).toBe(403);
      expect(await prisma.workflowIntakeLink.count({ where: { teamId: teamA.teamId } })).toBe(linksBefore);

      // The web panel's payload when the operator shares the link manually.
      const res = await call("POST", url, teamA.memberToken, {
        reviewerNote: "Need the rear view too.",
        notifyContributor: false,
        notifyChannel: "SMS",
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res);
      expect(body).toMatchObject({ rawToken: expect.any(String), communicationMessageId: null });
      const link = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: body.newIntakeLinkId } });
      expect(link).toMatchObject({ teamId: teamA.teamId, maxUses: 1, createdByUserId: teamA.memberUserId });
      const row = await prisma.evidenceRequestResponse.findUniqueOrThrow({ where: { id: responseId } });
      expect(row).toMatchObject({ status: "NEEDS_MORE_INFO", reviewerNote: "Need the rear view too.", reviewedByUserId: teamA.memberUserId });
      const event = (await eventsOf(request.id)).find((e) => e.eventType === "EVIDENCE_REQUEST_NEEDS_MORE_INFO");
      expect(event?.payload).toMatchObject({ responseId, followUpIntakeLinkId: body.newIntakeLinkId });
    });
  });

  // ===========================================================================
  // Evidence record mutations
  // ===========================================================================
  describe("evidence record", () => {
    const reviewerEvents = (evidenceId: string, eventType: string) =>
      prisma.evidenceReviewerAuditEvent.findMany({ where: { evidenceId, eventType: eventType as never } });

    it("DELETE /v1/evidence/:id — an owner moves the record to trash (recoverable)", async () => {
      const { teamA, teamB } = harness.fixtures;
      const id = await evidenceIn(teamA.teamId, teamA.memberUserId, "Record to trash");
      // A reviewer lacks evidence.delete, and a stranger cannot see the record:
      // both answer the same concealed 404.
      for (const token of [teamA.memberToken, teamB.ownerToken]) {
        const refused = await call("DELETE", `/v1/evidence/${id}`, token);
        expect(refused.statusCode).toBe(404);
      }
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();

      const res = await call("DELETE", `/v1/evidence/${id}`, teamA.ownerToken);
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.evidence.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.destroyedAtUtc).toBeNull();
      await vi.waitFor(
        async () => {
          const audit = await prisma.adminAuditLog.findFirst({
            where: { action: "evidence.delete", resourceId: id, outcome: "success" },
          });
          expect(audit).toMatchObject({ userId: teamA.ownerUserId, workspaceId: teamA.teamId });
        },
        { timeout: 5_000, interval: 50 },
      );
    });

    it("DELETE /v1/evidence/:id/comments/:commentId — the author removes their comment", async () => {
      const { teamA, teamB } = harness.fixtures;
      const id = await evidenceIn(teamA.teamId, teamA.ownerUserId, "Commented record");
      const created = await call("POST", `/v1/evidence/${id}/comments`, teamA.adminToken, { body: "Check the timestamp.", visibility: "INTERNAL" });
      expect(created.statusCode, created.body).toBe(201);
      const commentId = json(created).comment.id as string;

      // A reviewer who neither wrote it nor manages the workspace may not.
      const member = await call("DELETE", `/v1/evidence/${id}/comments/${commentId}`, teamA.memberToken);
      expect(member.statusCode).toBe(403);
      const foreign = await call("DELETE", `/v1/evidence/${id}/comments/${commentId}`, teamB.ownerToken);
      expect(foreign.statusCode).toBe(404);
      expect((await prisma.evidenceReviewerComment.findUniqueOrThrow({ where: { id: commentId } })).deletedAt).toBeNull();

      const res = await call("DELETE", `/v1/evidence/${id}/comments/${commentId}`, teamA.adminToken);
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ deleted: true });
      expect((await prisma.evidenceReviewerComment.findUniqueOrThrow({ where: { id: commentId } })).deletedAt).toBeInstanceOf(Date);
      const events = await reviewerEvents(id, "COMMENT_DELETED");
      expect(events.map((e) => [e.actorUserId, (e.metadata as Json).commentId])).toEqual([[teamA.adminUserId, commentId]]);
    });

    it("DELETE /v1/evidence/:id/legal-notes/:noteId — a workspace owner removes a colleague's note", async () => {
      const { teamA, teamB } = harness.fixtures;
      const id = await evidenceIn(teamA.teamId, teamA.adminUserId, "Noted record");
      const created = await call("POST", `/v1/evidence/${id}/legal-notes`, teamA.memberToken, { body: "Privileged: counsel review.", noteType: "PRIVILEGED" });
      expect(created.statusCode, created.body).toBe(201);
      const noteId = json(created).legalNote.id as string;

      const viewer = await call("DELETE", `/v1/evidence/${id}/legal-notes/${noteId}`, teamA.viewerToken);
      expect(viewer.statusCode).toBe(403);
      const foreign = await call("DELETE", `/v1/evidence/${id}/legal-notes/${noteId}`, teamB.ownerToken);
      expect(foreign.statusCode).toBe(404);
      expect((await prisma.evidenceLegalNote.findUniqueOrThrow({ where: { id: noteId } })).deletedAt).toBeNull();

      const res = await call("DELETE", `/v1/evidence/${id}/legal-notes/${noteId}`, teamA.ownerToken);
      expect(res.statusCode, res.body).toBe(200);
      expect((await prisma.evidenceLegalNote.findUniqueOrThrow({ where: { id: noteId } })).deletedAt).toBeInstanceOf(Date);
      const events = await reviewerEvents(id, "LEGAL_NOTE_DELETED");
      expect(events.map((e) => [e.actorUserId, (e.metadata as Json).legalNoteId])).toEqual([[teamA.ownerUserId, noteId]]);
    });

    it("DELETE /v1/evidence/:id/annotations/:annotationId — the author removes their annotation", async () => {
      const { teamA, teamB } = harness.fixtures;
      const id = await evidenceIn(teamA.teamId, teamA.ownerUserId, "Annotated record");
      // The annotation panel's payload.
      const created = await call("POST", `/v1/evidence/${id}/annotations`, teamA.memberToken, {
        evidencePartId: null,
        annotationType: "TEXT",
        body: "Scratch visible here.",
        coordinateSpace: "NORMALIZED",
      });
      expect(created.statusCode, created.body).toBe(201);
      const annotationId = json(created).annotation.id as string;

      const viewer = await call("DELETE", `/v1/evidence/${id}/annotations/${annotationId}`, teamA.viewerToken);
      expect(viewer.statusCode).toBe(403);
      const foreign = await call("DELETE", `/v1/evidence/${id}/annotations/${annotationId}`, teamB.ownerToken);
      expect(foreign.statusCode).toBe(404);
      expect((await prisma.evidenceAnnotation.findUniqueOrThrow({ where: { id: annotationId } })).deletedAt).toBeNull();

      const res = await call("DELETE", `/v1/evidence/${id}/annotations/${annotationId}`, teamA.memberToken);
      expect(res.statusCode, res.body).toBe(200);
      expect((await prisma.evidenceAnnotation.findUniqueOrThrow({ where: { id: annotationId } })).deletedAt).toBeInstanceOf(Date);
      const events = await reviewerEvents(id, "ANNOTATION_DELETED");
      expect(events.map((e) => [e.actorUserId, (e.metadata as Json).annotationId])).toEqual([[teamA.memberUserId, annotationId]]);
    });

    it("DELETE /v1/evidence/:id/relationships/:relationshipId — a reviewer removes a link; a viewer and a stranger cannot", async () => {
      const { teamA, teamB } = harness.fixtures;
      const source = await evidenceIn(teamA.teamId, teamA.ownerUserId, "Relationship source");
      const target = await evidenceIn(teamA.teamId, teamA.ownerUserId, "Relationship target");
      const created = await call("POST", `/v1/evidence/${source}/relationships`, teamA.memberToken, {
        targetEvidenceId: target,
        relationshipType: "SAME_INCIDENT",
        note: null,
      });
      expect(created.statusCode, created.body).toBe(201);
      const relationshipId = json(created).relationshipId as string;

      // A VIEWER holds evidence.read only; removing a link is a write.
      const viewer = await call("DELETE", `/v1/evidence/${source}/relationships/${relationshipId}`, teamA.viewerToken);
      expect(viewer.statusCode, viewer.body).toBe(404);
      const foreign = await call("DELETE", `/v1/evidence/${source}/relationships/${relationshipId}`, teamB.ownerToken);
      expect(foreign.statusCode).toBe(404);
      expect(await prisma.evidenceRelationship.count({ where: { id: relationshipId } })).toBe(1);
      expect(await reviewerEvents(source, "RELATIONSHIP_DELETED")).toEqual([]);

      const res = await call("DELETE", `/v1/evidence/${source}/relationships/${relationshipId}`, teamA.memberToken);
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ deleted: true });
      expect(await prisma.evidenceRelationship.count({ where: { id: relationshipId } })).toBe(0);
      const events = await reviewerEvents(source, "RELATIONSHIP_DELETED");
      expect(events.map((e) => [e.actorUserId, (e.metadata as Json).relationshipId])).toEqual([[teamA.memberUserId, relationshipId]]);
    });

    it("POST /v1/evidence/claim — a legacy guest token transfers the guest's unsigned records", async () => {
      const { personal, teamA } = harness.fixtures;
      const { signJwt } = await import("../src/services/jwt.js");
      const secret = process.env.AUTH_JWT_SECRET!;
      // Historical persistence: a GUEST-provider user, its custody identity and
      // an unsigned record it still owns. Guest login no longer mints these.
      const guest = await prisma.user.create({
        data: { provider: "GUEST", providerUserId: `guest-${randomUUID()}` },
        select: { id: true },
      });
      await prisma.guestIdentity.create({ data: { userId: guest.id } });
      const unsigned = (await prisma.evidence.create({
        data: { title: "Guest capture", type: "PHOTO", status: "UPLOADED", ownerUserId: guest.id },
        select: { id: true },
      })).id;
      const signed = (await prisma.evidence.create({
        data: { title: "Guest signed capture", type: "PHOTO", status: "SIGNED", ownerUserId: guest.id },
        select: { id: true },
      })).id;
      const guestToken = signJwt({ sub: guest.id, provider: "GUEST", email: null }, secret, 3600);

      // A non-guest token is not a claim capability.
      const refused = await call("POST", "/v1/evidence/claim", personal.token, { guestToken: teamA.ownerToken });
      expect(refused.statusCode).toBe(400);
      expect(json(refused)).toEqual({ message: "invalid_guest_token" });
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id: unsigned } })).ownerUserId).toBe(guest.id);

      // The login/register pages send exactly `{ guestToken }`.
      const res = await call("POST", "/v1/evidence/claim", personal.token, { guestToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ claimed: 1 });
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id: unsigned } })).ownerUserId).toBe(personal.userId);
      // Signed records are never transferred.
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id: signed } })).ownerUserId).toBe(guest.id);
      const identity = await prisma.guestIdentity.findUniqueOrThrow({ where: { userId: guest.id } });
      expect(identity.claimedByUserId).toBe(personal.userId);
      expect(identity.claimedAt).toBeInstanceOf(Date);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: unsigned, eventType: "EVIDENCE_CLAIMED" } })).toBe(1);
      await vi.waitFor(
        async () => {
          const audit = await prisma.adminAuditLog.findFirst({ where: { action: "evidence.claimed", resourceId: unsigned } });
          expect(audit).toMatchObject({ userId: personal.userId, outcome: "success" });
        },
        { timeout: 5_000, interval: 50 },
      );
      // The guest rows stay in the disposable database: the custody chain the
      // claim appended is append-only by design.
    });
  });

  // ===========================================================================
  // Evidence saved views
  // ===========================================================================
  describe("evidence saved views", () => {
    const filters = {
      search: "",
      scope: "active",
      status: "all",
      type: "all",
      review: "all",
      exportReadiness: "all",
      caseAssignment: "all",
      retention: "all",
      sort: "newest",
      tsaStatus: "all",
      otsStatus: "all",
      publicVerifyState: "all",
      verificationStatus: "all",
    };
    /** The payload the evidence library's "Save view" action builds. */
    const webPayload = (name: string, teamId: string | null, isDefault = false) => ({
      name,
      description: null,
      isDefault,
      teamId,
      scope: filters.scope,
      sortKey: filters.sort,
      filters,
    });

    it("POST /v1/evidence/saved-views — a member saves a workspace view", async () => {
      const { teamA } = harness.fixtures;
      const res = await call("POST", "/v1/evidence/saved-views", teamA.memberToken, webPayload("Unassigned this week", teamA.teamId, true));
      expect(res.statusCode, res.body).toBe(201);
      const saved = json(res).savedView;
      const row = await prisma.evidenceSavedView.findUniqueOrThrow({ where: { id: saved.id } });
      expect(row).toMatchObject({
        ownerUserId: teamA.memberUserId,
        teamId: teamA.teamId,
        name: "Unassigned this week",
        scope: "active",
        sortKey: "newest",
        isDefault: true,
      });
      expect(row.filtersJson).toEqual(filters);
    });

    it("POST /v1/evidence/saved-views conceals a foreign workspace (404) and writes nothing", async () => {
      const { teamA, teamB } = harness.fixtures;
      const res = await call("POST", "/v1/evidence/saved-views", teamB.ownerToken, webPayload("Snooping", teamA.teamId));
      expect(res.statusCode).toBe(404);
      expect(await prisma.evidenceSavedView.count({ where: { ownerUserId: teamB.ownerUserId } })).toBe(0);
    });

    it("DELETE /v1/evidence/saved-views/:id — the owner deletes their view; a stranger is refused", async () => {
      const { teamA, teamB } = harness.fixtures;
      const created = await call("POST", "/v1/evidence/saved-views", teamA.memberToken, webPayload("Short-lived", teamA.teamId));
      const id = json(created).savedView.id as string;

      const foreign = await call("DELETE", `/v1/evidence/saved-views/${id}`, teamB.ownerToken);
      expect(foreign.statusCode).toBe(403);
      expect(await prisma.evidenceSavedView.count({ where: { id } })).toBe(1);

      const res = await call("DELETE", `/v1/evidence/saved-views/${id}`, teamA.memberToken);
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ deleted: true });
      expect(await prisma.evidenceSavedView.count({ where: { id } })).toBe(0);
    });
  });
});

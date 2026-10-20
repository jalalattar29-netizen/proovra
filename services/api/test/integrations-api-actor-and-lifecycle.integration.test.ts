/**
 * ET-INT-10 / ET-SEC-25 — the integrations API. Live PostgreSQL 16, the real
 * routes, a real issued API key.
 *
 * On a40ca76f:
 *   ET-INT-10 — the evidence-request / intake-link routes passed the API
 *     credential id as the acting User id; the User FK failed (P2003) and the
 *     raw Prisma message came back as a 400. They also skipped the secure-intake
 *     plan gate the user routes enforce.
 *   ET-SEC-25 — the API-key path checked key validity only, so a SUSPENDED
 *     organization kept ingesting through its keys.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const SCOPES = ["integration.evidence_request.create", "integration.intake_link.create"];

describe("integrations API actor, plan gate and organization lifecycle (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let keyA = "";
  let keyB = "";

  const post = (url: string, key: string, payload: unknown) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: payload as never,
    });
  const requestBody = (title: string) => ({
    requestType: "ADDITIONAL_EVIDENCE",
    title,
    instructions: "Please photograph the damaged panel in daylight.",
    priority: "NORMAL",
    dueAtUtc: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    recipientMode: "EXTERNAL_CONTRIBUTOR",
    recipientLabel: "Claimant",
    recipientEmail: "claimant@test.proovra.local",
    createIntakeLink: false,
    deliverables: [
      { title: "Primary", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 1, locationRequirement: "optional", captureAfterRequest: false, sortOrder: 0 },
    ],
  });

  beforeAll(async () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? "ab".repeat(32);
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    // AUD-36: the API intake-link mint is exercised for real.
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "remediation-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { teamA, teamB } = h.fixtures;
    // Workspace A includes secure intake; B stays on its default (FREE, no credits).
    await prisma.team.update({ where: { id: teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })).organizationId!;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgA, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
    const { createApiCredential } = await import("../src/services/integrations/api-keys.service.js");
    keyA = (await createApiCredential({ teamId: teamA.teamId, name: "int-10 A", scopes: SCOPES, actorUserId: teamA.ownerUserId })).rawKey;
    keyB = (await createApiCredential({ teamId: teamB.teamId, name: "int-10 B", scopes: SCOPES, actorUserId: teamB.ownerUserId })).rawKey;
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("ET-INT-10: an API-created evidence request is attributed to the credential's creator, not the credential id", async () => {
    const A = h.fixtures.teamA;
    const res = await post("/v1/integrations/api/evidence-requests", keyA, requestBody("api request"));
    expect(res.statusCode, res.body).toBe(201);
    const id = (JSON.parse(res.body) as { evidenceRequest: { id: string } }).evidenceRequest.id;
    const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id }, select: { requestedByUserId: true, teamId: true } });
    expect(row).toEqual({ requestedByUserId: A.ownerUserId, teamId: A.teamId });
  });

  it("ET-INT-10: the secure-intake plan gate applies to the API path (FREE, no credits → 409 INTAKE_NOT_INCLUDED, nothing written)", async () => {
    const B = h.fixtures.teamB;
    const before = await prisma.evidenceRequest.count({ where: { teamId: B.teamId } });
    const res = await post("/v1/integrations/api/evidence-requests", keyB, requestBody("free api request"));
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("INTAKE_NOT_INCLUDED");
    expect(await prisma.evidenceRequest.count({ where: { teamId: B.teamId } })).toBe(before);
  });

  it("ET-SEC-25: a SUSPENDED organization cannot act through its API key (403), and nothing is written", async () => {
    const A = h.fixtures.teamA;
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } })).organizationId!;
    const before = await prisma.evidenceRequest.count({ where: { teamId: A.teamId } });
    await prisma.organization.update({ where: { id: orgA }, data: { status: "SUSPENDED" } });
    try {
      const res = await post("/v1/integrations/api/evidence-requests", keyA, requestBody("suspended"));
      expect(res.statusCode, res.body).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("ORGANIZATION_NOT_ACTIVE");
    } finally {
      await prisma.organization.update({ where: { id: orgA }, data: { status: "ACTIVE" } });
    }
    expect(await prisma.evidenceRequest.count({ where: { teamId: A.teamId } })).toBe(before);
  });

  // AUD-09 (2026-10-20): the API path stored any assignedReviewerUserId; the
  // request (and the email sent for it) could name another tenant's user.
  it("AUD-09: an API-created request may only name an ACTIVE member of its workspace as reviewer", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const before = await prisma.evidenceRequest.count({ where: { teamId: A.teamId } });
    const foreign = await post("/v1/integrations/api/evidence-requests", keyA, { ...requestBody("foreign reviewer"), assignedReviewerUserId: B.ownerUserId });
    expect(foreign.statusCode, foreign.body).toBe(400);
    expect(JSON.parse(foreign.body).error.code).toBe("assignee_not_workspace_member");
    expect(await prisma.evidenceRequest.count({ where: { teamId: A.teamId } })).toBe(before);
    const own = await post("/v1/integrations/api/evidence-requests", keyA, { ...requestBody("own reviewer"), assignedReviewerUserId: A.ownerUserId });
    expect(own.statusCode, own.body).toBe(201);
  });

  // AUD-36 (2026-10-20): the API mint decided its policy as a hard-coded
  // ADMIN, and a link could live for any length of time.
  const linkBody = (days: number) => ({
    workflowTemplateSlug: "general-evidence-record",
    intakeMode: "EXTERNAL_REUSABLE",
    recipientLabel: "API",
    maxUses: 3,
    expiresAtUtc: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
  });

  it("AUD-36: an API intake link lives at most 90 days", async () => {
    const tooFar = await post("/v1/integrations/api/intake-links", keyA, linkBody(120));
    expect(tooFar.statusCode, tooFar.body).toBe(400);
    expect(JSON.parse(tooFar.body).error.code).toBe("expiry_too_far");
    const ok = await post("/v1/integrations/api/intake-links", keyA, linkBody(30));
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("AUD-36: a key created by a member who may not mint intake links cannot mint them through the API", async () => {
    const A = h.fixtures.teamA;
    const { createApiCredential } = await import("../src/services/integrations/api-keys.service.js");
    const viewerKey = (await createApiCredential({ teamId: A.teamId, name: "aud-36 viewer", scopes: SCOPES, actorUserId: A.viewerUserId })).rawKey;
    const before = await prisma.workflowIntakeLink.count({ where: { teamId: A.teamId } });
    const res = await post("/v1/integrations/api/intake-links", viewerKey, linkBody(7));
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.workflowIntakeLink.count({ where: { teamId: A.teamId } })).toBe(before);
  });

  it("ET-INT-10: neither integration route passes the credential id as a user", () => {
    const src = readFileSync(new URL("../src/routes/integrations-api.routes.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/actorUserId:\s*cred\.credentialId/);
    expect(src.match(/await integrationActorAndIntakeGate\(reply, cred\)/g)?.length).toBe(2);
  });
});

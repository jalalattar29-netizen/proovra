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
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const SCOPES = ["integration.evidence_request.create", "integration.intake_link.create"];

describe("integrations API actor, plan gate and organization lifecycle (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let keyA = "";
  let keyB = "";
  let keyRead = "";

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
    // A2-11 — an unprovisioned workspace mints no key (default 0); B's key is
    // issued under a written ceiling, as a product line would grant one.
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({ teamId: teamB.teamId, key: "INTEGRATION_API_KEYS_MAX", value: 3, kind: "LIMIT", source: "CUSTOM", grantedByUserId: teamB.ownerUserId });
    keyB = (await createApiCredential({ teamId: teamB.teamId, name: "int-10 B", scopes: SCOPES, actorUserId: teamB.ownerUserId })).rawKey;
    keyRead = (await createApiCredential({ teamId: teamA.teamId, name: "a2-07 read", scopes: [...SCOPES, "integration.evidence_request.read"], actorUserId: teamA.ownerUserId })).rawKey;
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

  // B3B-F-102 (Free audit 0ea0, residual pass 2026-11-17) — the API create
  // honours the same create idempotency as the web and native create.
  it("B3B-F-102: an Idempotency-Key retry answers the original link without a token; a changed body is 409; no key is unchanged", async () => {
    const keyed = (payload: unknown, key: string) =>
      h.app.inject({
        method: "POST",
        url: "/v1/integrations/api/intake-links",
        headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json", "idempotency-key": key },
        payload: payload as never,
      });
    const body = linkBody(7);
    const key = `b3b-f-102-${Date.now()}`;
    const first = await keyed(body, key);
    expect(first.statusCode, first.body).toBe(201);
    const firstJson = JSON.parse(first.body) as { intakeLink: { id: string }; rawToken: string | null };
    expect(firstJson.rawToken).toBeTruthy();

    const retry = await keyed(body, key);
    expect(retry.statusCode, retry.body).toBe(200);
    const retryJson = JSON.parse(retry.body) as { intakeLink: { id: string }; rawToken: unknown; replayed: boolean };
    expect(retryJson.intakeLink.id).toBe(firstJson.intakeLink.id);
    expect(retryJson.rawToken).toBeNull();
    expect(retryJson.replayed).toBe(true);
    expect(await prisma.workflowIntakeLink.count({ where: { id: firstJson.intakeLink.id } })).toBe(1);

    const changed = await keyed({ ...body, recipientLabel: "API changed" }, key);
    expect(changed.statusCode, changed.body).toBe(409);
    expect(JSON.parse(changed.body).error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const bad = await keyed(body, "not a valid key!");
    expect(bad.statusCode, bad.body).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe("IDEMPOTENCY_KEY_INVALID");

    const unkeyedA = await post("/v1/integrations/api/intake-links", keyA, body);
    const unkeyedB = await post("/v1/integrations/api/intake-links", keyA, body);
    expect([unkeyedA.statusCode, unkeyedB.statusCode]).toEqual([201, 201]);
    expect(JSON.parse(unkeyedA.body).intakeLink.id).not.toBe(JSON.parse(unkeyedB.body).intakeLink.id);
  });

  it("AUD-36: a key created by a member who may not mint intake links cannot mint them through the API", async () => {
    const A = h.fixtures.teamA;
    const { createApiCredential } = await import("../src/services/integrations/api-keys.service.js");
    const viewerKey = (await createApiCredential({ teamId: A.teamId, name: "aud-36 viewer", scopes: SCOPES, actorUserId: A.viewerUserId })).rawKey;
    const before = await prisma.workflowIntakeLink.count({ where: { teamId: A.teamId } });
    const res = await post("/v1/integrations/api/intake-links", viewerKey, linkBody(7));
    // B3A-F-002 (free-audit 0ea0): a key whose creator does not hold the key
    // permission is now refused at authentication (401 creator_lost_authority,
    // the key revoked) before the mint gate's 403. Either way: refused, nothing written.
    expect([401, 403], res.body).toContain(res.statusCode);
    expect(await prisma.workflowIntakeLink.count({ where: { teamId: A.teamId } })).toBe(before);
  });

  // Free-user audit 0ea0 follow-up (2026-11-16) — since B3A-F-002 the viewer
  // key above is refused at AUTHENTICATION, so the mint gate's policy branch
  // was no longer reached by any test (forward mutant P10-O survived). This
  // key's creator is the OWNER — it authenticates — and the workspace policy
  // switches external intake off: the creator may not mint this link, so the
  // API refuses with the policy code and writes nothing.
  it("AUD-36: an owner's key may not mint a link the workspace policy refuses", async () => {
    const A = h.fixtures.teamA;
    const existing = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId: A.teamId } });
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: A.teamId },
      create: { teamId: A.teamId, allowExternalIntake: false },
      update: { allowExternalIntake: false },
    });
    try {
      const before = await prisma.workflowIntakeLink.count({ where: { teamId: A.teamId } });
      const res = await post("/v1/integrations/api/intake-links", keyA, linkBody(7));
      expect(res.statusCode, res.body).toBe(403);
      expect(JSON.parse(res.body).error).toMatchObject({
        code: "INTAKE_LINK_BLOCKED_BY_POLICY",
        reason: "external_intake_disabled_by_policy",
      });
      expect(await prisma.workflowIntakeLink.count({ where: { teamId: A.teamId } })).toBe(before);
    } finally {
      if (existing) {
        await prisma.workspaceGovernancePolicy.update({
          where: { teamId: A.teamId },
          data: { allowExternalIntake: existing.allowExternalIntake },
        });
      } else {
        await prisma.workspaceGovernancePolicy.delete({ where: { teamId: A.teamId } });
      }
    }
    // The owner's key still mints once the policy allows it again.
    const ok = await post("/v1/integrations/api/intake-links", keyA, linkBody(7));
    expect(ok.statusCode, ok.body).toBe(201);
  });

  // PRO-045 (AUTHZ-09): a foreign or unknown case / record id reached the
  // central handler as a 500 with a critical alert, and a foreign id (500) told
  // apart from a malformed one (400).
  it("PRO-045: a foreign or unknown case or record id is a bounded 404, and nothing is written", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const own = await post("/v1/integrations/api/evidence-requests", keyA, { ...requestBody("own case"), caseId: A.caseId });
    expect(own.statusCode, own.body).toBe(201);

    const before = await prisma.evidenceRequest.count();
    const probes = [
      { caseId: B.caseId, code: "case_not_in_workspace" },
      { caseId: randomUUID(), code: "case_not_in_workspace" },
      { evidenceId: B.evidenceId, code: "evidence_not_in_workspace" },
      { evidenceId: randomUUID(), code: "evidence_not_in_workspace" },
    ];
    for (const { code, ...ref } of probes) {
      const res = await post("/v1/integrations/api/evidence-requests", keyA, { ...requestBody("probe"), ...ref });
      expect(res.statusCode, `${JSON.stringify(ref)}: ${res.body}`).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe(code);
    }
    // A foreign id and an unknown id answer identically, and no row was created.
    expect(await prisma.evidenceRequest.count()).toBe(before);
    expect(await prisma.evidenceRequest.count({ where: { teamId: B.teamId, title: "probe" } })).toBe(0);
  });

  // A2-07 (2026-11-14): the API projected the recipient address raw, on create
  // and on read. A key holds an integration scope, not the reveal authority.
  it("A2-07: an evidence request's recipient address reaches an API key masked, on create and on read", async () => {
    const created = await post("/v1/integrations/api/evidence-requests", keyRead, requestBody("masked contact"));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain("claimant@test.proovra.local");
    const id = (JSON.parse(created.body) as { evidenceRequest: { id: string } }).evidenceRequest.id;
    const read = await h.app.inject({
      method: "GET",
      url: `/v1/integrations/api/evidence-requests/${id}`,
      headers: { authorization: `Bearer ${keyRead}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.body).not.toContain("claimant@test.proovra.local");
    for (const body of [created.body, read.body]) {
      expect((JSON.parse(body) as { evidenceRequest: unknown }).evidenceRequest).toMatchObject({
        recipientEmail: null,
        recipientEmailMasked: expect.stringContaining("@"),
        hasRecipientEmail: true,
      });
    }
  });

  it("ET-INT-10: neither integration route passes the credential id as a user", () => {
    const src = readFileSync(new URL("../src/routes/integrations-api.routes.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/actorUserId:\s*cred\.credentialId/);
    expect(src.match(/await integrationActorAndIntakeGate\(reply, cred\)/g)?.length).toBe(2);
  });
});

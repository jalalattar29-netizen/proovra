/**
 * Closure phase 3, item G — retirement compatibility. For every route retired
 * (or kept with a sunset) as OBSOLETE in docs/architecture/caller-less-routes.md,
 * the canonical replacement a stale client is pointed at EXISTS AND WORKS, and
 * the retired route stays a typed tombstone that writes nothing:
 *
 *   EP-0934 PATCH /v1/redaction/policy         → POST /v1/redaction/policies
 *   EP-1066 POST  /v1/search/relationships     → POST /v1/evidence/:id/relationships
 *   EP-0219 POST  /v1/cases/:id/share-team     → POST /v1/cases/:id/access (kept, sunset)
 *
 * EP-0425 (→ /v1/external-review/invitations/bulk) and EP-0446 (→ /resend)
 * need the external-review entitlement and an issuing step-up; their canonical
 * positives are cov-external-reviewer.integration.test.ts (the bulk issue at
 * "a member without the tier…" + "POSITIVE: the invitation writes the grant…",
 * the resend at "delivery and reveal…").
 *
 * Real routes, real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("closure3 G — each retired route's canonical replacement works; the tombstone writes nothing (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const A = () => h.fixtures.teamA;

  const call = (method: "POST" | "PATCH", url: string, token: string, payload: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-proovra-workspace-id": A().teamId,
      },
      payload: JSON.stringify(payload),
    });

  async function makeEvidence(): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `cl3-g-${randomUUID()}`,
          type: "PHOTO",
          status: "REPORTED" as never,
          lifecycleState: "ACTIVE" as never,
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId: A().ownerUserId,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({
      prisma: prisma as never,
      teamId: A().teamId,
      key: "FEATURE_REDACTION",
      kind: "FEATURE",
      value: true,
      source: "CUSTOM",
      grantedByUserId: A().ownerUserId,
    } as never);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("EP-0934: PATCH /v1/redaction/policy answers 410 and writes nothing; POST /v1/redaction/policies creates the versioned policy", async () => {
    const before = await prisma.redactionPolicy.count({ where: { teamId: A().teamId } as never });
    const retired = await call("PATCH", "/v1/redaction/policy", A().ownerToken, { providers: { MANUAL: true } });
    expect(retired.statusCode, retired.body).toBe(410);
    expect(retired.json()).toMatchObject({ error: { code: "REDACTION_POLICY_PATCH_RETIRED" }, canonical: "/v1/redaction/policies" });
    expect(await prisma.redactionPolicy.count({ where: { teamId: A().teamId } as never })).toBe(before);

    const created = await call("POST", "/v1/redaction/policies", A().ownerToken, { name: `cl3-g ${randomUUID().slice(0, 6)}` });
    expect(created.statusCode, created.body).toBe(201);
    const policyId = created.json().policyId as string;
    expect(await prisma.redactionPolicy.findUnique({ where: { id: policyId }, select: { teamId: true } })).toEqual({ teamId: A().teamId });
  });

  it("EP-1066: POST /v1/search/relationships answers 410 and links nothing; POST /v1/evidence/:id/relationships links the records", async () => {
    const src = await makeEvidence();
    const tgt = await makeEvidence();
    const retired = await call("POST", "/v1/search/relationships", A().ownerToken, {
      teamId: A().teamId,
      sourceEvidenceId: src,
      targetEvidenceId: tgt,
      relationshipType: "RELATED",
    });
    expect(retired.statusCode, retired.body).toBe(410);
    expect(retired.json()).toMatchObject({
      error: { code: "SEARCH_RELATIONSHIP_CREATE_RETIRED" },
      canonical: "/v1/evidence/{evidenceId}/relationships",
    });
    expect(await prisma.evidenceRelationship.count({ where: { sourceEvidenceId: src } as never })).toBe(0);

    const created = await call("POST", `/v1/evidence/${src}/relationships`, A().ownerToken, {
      targetEvidenceId: tgt,
      relationshipType: "RELATED",
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(await prisma.evidenceRelationship.count({ where: { sourceEvidenceId: src, targetEvidenceId: tgt } as never })).toBe(1);
  });

  it("EP-0219 (kept, sunset): the canonical POST /v1/cases/:id/access grants an ACTIVE member (201)", async () => {
    // Granting case access answers to the current Cases entitlement (B3C-F-007);
    // the canonical route is proved on a plan that includes Cases.
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
    const c = await prisma.case.create({
      data: { name: `cl3-g-${randomUUID().slice(0, 6)}`, teamId: A().teamId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    const granted = await call("POST", `/v1/cases/${c.id}/access`, A().ownerToken, { userId: A().viewerUserId });
    expect(granted.statusCode, granted.body).toBe(201);
    expect(
      await prisma.caseAccess.count({ where: { caseId: c.id, userId: A().viewerUserId } as never }),
    ).toBe(1);
  });

  it("no tombstone points a stale client at another tombstone: the 2026-09-16 guest / contributor tombstones name the live issuing route /bulk, and /bulk is not retired", async () => {
    const id = randomUUID();
    for (const [method, url, payload] of [
      ["POST", `/v1/collaboration-teams/${id}/guests/invite`, { email: "guest@example.test" }],
      ["POST", `/v1/collaboration/threads/${id}/contributors`, { teamId: A().teamId, contributorLabel: "x" }],
    ] as const) {
      const r = await call(method, url, A().ownerToken, payload);
      expect(r.statusCode, `${url} ${r.body}`).toBe(410);
      expect((r.json() as { canonical?: string }).canonical, url).toBe("/v1/external-review/invitations/bulk");
    }
    // The canonical route is live: an empty body is a validation or authority
    // answer, never the retirement 410.
    const bulk = await call("POST", "/v1/external-review/invitations/bulk", A().ownerToken, {});
    expect(bulk.statusCode, bulk.body).not.toBe(410);
    expect(bulk.statusCode).toBeGreaterThanOrEqual(400);
  });
});

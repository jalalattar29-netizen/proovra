/**
 * ET-INT-11 — intake consent is a server fact. Live PostgreSQL 16, the real
 * public routes.
 *
 * On a40ca76f the acceptance time was taken from the body (backdatable),
 * termsAcknowledged:false was recorded as accepted, the disclosure hash was
 * never compared with the link's, and a re-post overwrote the record.
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("ET-INT-11 — intake consent (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function openSession() {
    const A = h.fixtures.teamA;
    const link = await h.app.inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: { teamId: A.teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_REUSABLE", recipientLabel: "consent", expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(link.statusCode, link.body).toBe(201);
    const t = encodeURIComponent((link.json() as { rawToken: string }).rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}`, remoteAddress: ip });
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const good = {
      acceptedAtUtc: new Date().toISOString(),
      policyVersion: opened.link.consentPolicyVersion || "v1",
      disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"),
      termsAcknowledged: true,
      identityDisclosed: true,
      ipHash: null,
      userAgent: null,
    };
    const post = (consent: Record<string, unknown>) =>
      h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${opened.session.id}/consent`, remoteAddress: ip, payload: { consent } });
    return { sid: opened.session.id, good, post };
  }
  const row = (sid: string) =>
    prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sid }, select: { consentAcceptedAtUtc: true, consentSnapshotJson: true } });

  it("termsAcknowledged:false is refused and nothing is recorded", async () => {
    const { sid, good, post } = await openSession();
    const r = await post({ ...good, termsAcknowledged: false });
    expect(r.statusCode, r.body).toBe(400);
    expect((await row(sid)).consentAcceptedAtUtc).toBeNull();
  });

  it("a disclosure hash that is not the link's disclosure is refused", async () => {
    const { sid, good, post } = await openSession();
    const r = await post({ ...good, disclosureTextHash: "f".repeat(64) });
    expect(r.statusCode, r.body).toBe(400);
    expect((await row(sid)).consentAcceptedAtUtc).toBeNull();
  });

  it("the acceptance time is the server's (a backdated claim is kept only as the client's report), and a re-post changes nothing", async () => {
    const { sid, good, post } = await openSession();
    const backdated = "2020-01-01T00:00:00.000Z";
    const before = Date.now();
    const r = await post({ ...good, acceptedAtUtc: backdated });
    expect(r.statusCode, r.body).toBe(200);
    const first = await row(sid);
    expect(first.consentAcceptedAtUtc!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((first.consentSnapshotJson as { clientReportedAcceptedAtUtc?: string }).clientReportedAcceptedAtUtc).toBe(backdated);

    const again = await post({ ...good, acceptedAtUtc: "2019-06-01T00:00:00.000Z", identityDisclosed: false });
    expect(again.statusCode, again.body).toBe(200);
    expect(await row(sid)).toEqual(first);
  });
});

/**
 * RUNTIME PROBE RT-INTAKE — audit-only. Disposable loopback PostgreSQL 16, real
 * Fastify inject, unauthenticated public intake routes exactly as the page
 * calls them. The intake HMAC secret is a throwaway value set in-process (the
 * pattern of evidence-commercial-denial-contract.integration.test.ts).
 *
 *   INT-03  an anonymous contributor who opens a session and adds one part —
 *           never submitting — consumes the link owner's record allowance.
 *   INT-01  POST /transition {to:"SUBMITTED"} consumes a one-time link without
 *           finalizing anything.
 *
 * Fixture step (declared): after the links are minted, the owner's credit
 * balance is set to 0 to model "the credit was spent on another record", so
 * the FREE cap alone governs admission.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../../../../../../../services/api/test/integration-harness.js";

const RESULTS = path.resolve(__dirname, "..", "..", "results");
const record = (name: string, data: unknown) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
};
const API = "../../../../../../../services/api";

describe("RT-INTAKE (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "et-audit-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import(`${API}/test/integration-harness.js`);
    h = await bootIntegrationHarness();
    ({ prisma } = await import(`${API}/src/db.js`));
  }, 300_000);
  afterAll(async () => { await h?.cleanup(); });

  async function openConsentPart(rawToken: string, withPart: boolean) {
    const t = encodeURIComponent(rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
    if (boot.statusCode !== 200) return { boot: boot.statusCode, bootBody: boot.body.slice(0, 200) };
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const consent = await h.app.inject({
      method: "POST", url: `/v1/external-intake/${t}/sessions/${opened.session.id}/consent`,
      payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"), termsAcknowledged: true, identityDisclosed: true, ipHash: null, userAgent: null } },
    });
    let part: number | null = null;
    if (withPart) {
      const body = Buffer.from(`et-${randomUUID()}`);
      const r = await h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${opened.session.id}/parts`, payload: { partIndex: 0, mimeType: "text/plain", originalFileName: "c.txt", checksumSha256Base64: createHash("sha256").update(body).digest("base64"), webkitRelativePath: null } });
      part = r.statusCode;
    }
    return { boot: boot.statusCode, sessionId: opened.session.id, consent: consent.statusCode, part };
  }

  it("INT-03 and INT-01", async () => {
    const P = h.fixtures.personal;
    const auth = { authorization: `Bearer ${P.token}` };
    const count = () => prisma.evidence.count({ where: { ownerUserId: P.userId, deletedAt: null, lifecycleState: { not: "DESTROYED" } } as never });
    // Owner reaches 2/3 with their own record.
    while ((await count()) < 2) await h.app.inject({ method: "POST", url: "/v1/evidence", headers: auth, payload: { type: "PHOTO", mimeType: "image/png" } });
    const { grantEvidenceCredits } = await import(`${API}/src/services/billing/evidence-credits.service.js`);
    await grantEvidenceCredits({ userId: P.userId, credits: 1, provider: "STRIPE" as never, providerRef: `et-probe-${randomUUID()}` });
    const mk = (maxUses?: number) => h.app.inject({ method: "POST", url: "/v1/workflow/intake-links", headers: auth, payload: { teamId: P.teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_REUSABLE", recipientLabel: "ET probe", expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(), ...(maxUses ? { maxUses } : {}) } });
    const reusable = await mk();
    const oneTime = await mk(1);
    // Declared fixture step: the credit is spent elsewhere.
    await prisma.entitlement.updateMany({ where: { userId: P.userId } as never, data: { credits: 0 } as never });
    const before = await count();

    // INT-03: anonymous open + consent + one part, never submitted.
    const anon = reusable.statusCode === 201 ? await openConsentPart(reusable.json().rawToken, true) : null;
    const afterAnon = await count();
    const anonRows = await prisma.evidence.findMany({ where: { ownerUserId: P.userId, deletedAt: null } as never, orderBy: { createdAt: "desc" }, take: 1, select: { status: true } });
    const ownerCreate = await h.app.inject({ method: "POST", url: "/v1/evidence", headers: auth, payload: { type: "PHOTO", mimeType: "image/png" } });

    // INT-01: one-time link, open + consent, then POST /transition SUBMITTED.
    let int01: Record<string, unknown> = { linkStatus: oneTime.statusCode, body: oneTime.body.slice(0, 200) };
    if (oneTime.statusCode === 201) {
      const tok = oneTime.json().rawToken as string;
      const s = await openConsentPart(tok, false);
      const tr = await h.app.inject({ method: "POST", url: `/v1/external-intake/${encodeURIComponent(tok)}/sessions/${s.sessionId}/transition`, payload: { to: "SUBMITTED" } });
      const link = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: oneTime.json().link?.id ?? oneTime.json().id }, select: { status: true, usedCount: true } as never }).catch(() => null);
      const session = await prisma.workflowIntakeSession.findUnique({ where: { id: s.sessionId! }, select: { status: true, evidenceId: true } as never }).catch(() => null);
      const reopen = await h.app.inject({ method: "GET", url: `/v1/external-intake/${encodeURIComponent(tok)}` });
      int01 = { open: s, transitionStatus: tr.statusCode, transitionBody: tr.body.slice(0, 200), linkAfter: link, sessionAfter: session, realContributorReopen: { status: reopen.statusCode, body: reopen.body.slice(0, 160) } };
    }
    const out = {
      probe: "RT-INTAKE",
      linkCreate: { reusable: reusable.statusCode, oneTime: oneTime.statusCode },
      int03: { ownerCountBeforeAnonymous: before, anonymousJourney: anon, ownerCountAfterAnonymous: afterAnon, anonymousRecordStatus: anonRows[0]?.status ?? null, ownerOwnCreateAfter: { status: ownerCreate.statusCode, code: ownerCreate.json()?.code ?? null } },
      int01,
    };
    record("rt-intake", out);
    expect(reusable.statusCode, reusable.body).toBe(201);
  });
});

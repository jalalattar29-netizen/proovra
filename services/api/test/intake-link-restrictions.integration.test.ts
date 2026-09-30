/**
 * ET-INT-06 — a link's ipAllowlistCidrs and maxBytesPerSession are enforced.
 * Live PostgreSQL 16, the real public routes; in-memory object store.
 *
 * On a40ca76f both were stored on the link and never read: a contributor on
 * any network could use an allowlisted link, and a submission of any size
 * finalized under a byte cap.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) => `http://127.0.0.1:59000/${p.bucket}/${p.key}?presigned=${randomUUID()}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return { sizeBytes: b.length, versionId: "v1", contentType: "text/plain", etag: null, metadata: null, objectLockMode: null, objectLockRetainUntilDate: null, objectLockLegalHoldStatus: null };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
  };
});

describe("ET-INT-06 — intake link restrictions (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const net = 1 + Math.floor(Math.random() * 250);
  const inside = `198.51.100.${net}`;
  const outside = `203.0.113.${net}`;

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    process.env.TSA_ENABLED = "false";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  const create = (extra: Record<string, unknown>) =>
    h.app.inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
      payload: { teamId: h.fixtures.teamA.teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_REUSABLE", recipientLabel: "restrict", expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(), ...extra },
    });
  async function mint(extra: Record<string, unknown>) {
    const r = await create(extra);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { rawToken: string; link: { id: string } };
  }

  it("an allowlisted link answers a client outside it with 403 and one inside it normally", async () => {
    const { rawToken } = await mint({ ipAllowlistCidrs: ["198.51.100.0/24"] });
    const t = encodeURIComponent(rawToken);
    const out = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}`, remoteAddress: outside });
    expect(out.statusCode, out.body).toBe(403);
    expect(out.json()).toMatchObject({ error: { code: "LINK_NOT_AVAILABLE_FROM_THIS_NETWORK" } });
    const ok = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}`, remoteAddress: inside });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("ET-INT-15: the first part records the capture environment, and the intake record's UPLOAD_AUTHORIZED claims no URL it never issued", async () => {
    const { rawToken } = await mint({});
    const t = encodeURIComponent(rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}`, remoteAddress: inside });
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const sid = opened.session.id;
    await h.app.inject({
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${sid}/consent`,
      remoteAddress: inside,
      payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"), termsAcknowledged: true, identityDisclosed: true, ipHash: null, userAgent: null } },
    });
    const part = await h.app.inject({
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${sid}/parts`,
      remoteAddress: inside,
      headers: { "user-agent": "Mozilla/5.0 (INT-15)" },
      payload: { partIndex: 0, mimeType: "text/plain", originalFileName: "a.txt", checksumSha256Base64: null, webkitRelativePath: null },
    });
    expect(part.statusCode, part.body).toBe(201);
    const evidenceId = (await prisma.evidencePart.findUniqueOrThrow({ where: { id: (part.json() as { part: { id: string } }).part.id }, select: { evidenceId: true } })).evidenceId;
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { captureEnvironment: true } });
    expect(ev.captureEnvironment).not.toBeNull();
    const authorized = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId, eventType: "UPLOAD_AUTHORIZED" }, select: { payload: true } });
    const meaning = (authorized.payload as { meaning?: string }).meaning ?? "";
    expect(meaning).toContain("No upload URL was issued for it");
    expect(meaning).not.toContain("A presigned upload URL was issued");
  });

  it("an allowlist entry the matcher cannot use is refused at creation", async () => {
    const r = await create({ ipAllowlistCidrs: ["not-an-ip"] });
    expect(r.statusCode, r.body).toBe(400);
  });

  it("a submission over maxBytesPerSession is refused 413 before finalizing, and the link use is not consumed", async () => {
    const { rawToken, link } = await mint({ maxBytesPerSession: 10 });
    const t = encodeURIComponent(rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}`, remoteAddress: inside });
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const sid = opened.session.id;
    await h.app.inject({
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${sid}/consent`,
      remoteAddress: inside,
      payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"), termsAcknowledged: true, identityDisclosed: true, ipHash: null, userAgent: null } },
    });
    const part = await h.app.inject({
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${sid}/parts`,
      remoteAddress: inside,
      payload: { partIndex: 0, mimeType: "text/plain", originalFileName: "big.txt", checksumSha256Base64: null, webkitRelativePath: null },
    });
    expect(part.statusCode, part.body).toBe(201);
    const row = await prisma.evidencePart.findUniqueOrThrow({ where: { id: (part.json() as { part: { id: string } }).part.id }, select: { storageBucket: true, storageKey: true, evidenceId: true } });
    objects.set(`${row.storageBucket}/${row.storageKey}`, Buffer.alloc(64, 1));

    const submit = await h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/submit`, remoteAddress: inside, payload: {} });
    expect(submit.statusCode, submit.body).toBe(413);
    expect(submit.json()).toMatchObject({ error: { code: "SUBMISSION_TOO_LARGE" } });
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidenceId }, select: { status: true } });
    expect(ev.status).not.toBe("SIGNED");
    expect((await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: link.id }, select: { usedCount: true } })).usedCount).toBe(0);
  });
});

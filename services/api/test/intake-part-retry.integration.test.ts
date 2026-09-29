/**
 * ET-INT-02 — a failed or interrupted part upload no longer blocks an intake
 * session forever. Live PostgreSQL 16, real public routes; the object store is
 * an in-memory double at the storage module boundary (the pattern of
 * intake-finalization-governance.integration.test.ts), so a "never uploaded"
 * part is simply an object that is absent.
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

describe("ET-INT-02 — intake part retry (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);
  afterAll(async () => { await h?.cleanup(); });

  it("a same-file retry reuses the reserved part; a different file is refused; a missing upload blocks submit recoverably", async () => {
    const A = h.fixtures.teamA;
    const link = await h.app.inject({
      method: "POST", url: "/v1/workflow/intake-links", headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: { teamId: A.teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_REUSABLE", recipientLabel: "retry", expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(link.statusCode, link.body).toBe(201);
    const t = encodeURIComponent((link.json() as { rawToken: string }).rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const sid = opened.session.id;
    await h.app.inject({
      method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/consent`,
      payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"), termsAcknowledged: true, identityDisclosed: true, ipHash: null, userAgent: null } },
    });
    const body = { partIndex: 0, mimeType: "text/plain", originalFileName: "statement.txt", checksumSha256Base64: createHash("sha256").update("x").digest("base64"), webkitRelativePath: null };
    const first = await h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/parts`, payload: body });
    expect(first.statusCode, first.body).toBe(201);
    // The PUT failed: the contributor retries the SAME file at the SAME index.
    const retry = await h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/parts`, payload: body });
    expect(retry.statusCode, retry.body).toBeLessThan(300);
    const a = first.json() as { part: { id: string }; upload: { putUrl: string } };
    const b = retry.json() as { part: { id: string }; upload: { putUrl: string } };
    expect(b.part.id).toBe(a.part.id);
    expect(b.upload.putUrl).not.toBe(a.upload.putUrl);
    // A DIFFERENT file on the taken index is still refused.
    const other = await h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/parts`, payload: { ...body, originalFileName: "other.txt" } });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: { code: "PART_INDEX_TAKEN" } });
    // Submit while the object was never written: a recoverable, truthful answer.
    const submit = await h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/submit`, payload: {} });
    expect(submit.statusCode, submit.body).toBe(409);
    expect(submit.json()).toMatchObject({ error: { code: "PART_NOT_UPLOADED" } });
    expect(submit.body).not.toContain("can't accept evidence");
  });
});

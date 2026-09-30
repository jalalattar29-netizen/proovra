/**
 * ET-INT-09 — the intake check-then-write races. Live PostgreSQL 16, the real
 * public routes; the object store is an in-memory double at the storage module
 * boundary (the pattern of intake-part-retry.integration.test.ts).
 *
 * On a40ca76f:
 *   - concurrent submits on a ONE_TIME link finalized one record EACH (the use
 *     check was a read in validateIntakeToken; the increment an unconditional
 *     write after completion);
 *   - two concurrent first-part uploads in one session each created an
 *     Evidence row, one of them orphaned;
 *   - maxFileCountPerSession was counted before the insert, outside any lock.
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

describe("ET-INT-09 — intake races (live PostgreSQL 16)", () => {
  // A fresh client address per run: the public intake routes rate-limit per IP
  // and the counters live in the shared test Redis.
  const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

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

  async function mintLink(extra: Record<string, unknown>) {
    const A = h.fixtures.teamA;
    const link = await h.app.inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: { teamId: A.teamId, workflowTemplateSlug: "general-evidence-record", recipientLabel: "race", expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(), ...extra },
    });
    expect(link.statusCode, link.body).toBe(201);
    return encodeURIComponent((link.json() as { rawToken: string }).rawToken);
  }
  async function openSession(t: string) {
    const boot = await h.app.inject({ remoteAddress: ip, method: "GET", url: `/v1/external-intake/${t}` });
    expect(boot.statusCode, boot.body).toBe(200);
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const sid = opened.session.id;
    const consent = await h.app.inject({
      remoteAddress: ip,
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${sid}/consent`,
      payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"), termsAcknowledged: true, identityDisclosed: true, ipHash: null, userAgent: null } },
    });
    expect(consent.statusCode, consent.body).toBeLessThan(300);
    return sid;
  }
  const partBody = (i: number) => ({ partIndex: i, mimeType: "text/plain", originalFileName: `f${i}.txt`, checksumSha256Base64: null, webkitRelativePath: null });
  const postPart = (t: string, sid: string, i: number) =>
    h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/parts`, payload: partBody(i) });
  async function upload(partId: string) {
    const p = await prisma.evidencePart.findUniqueOrThrow({ where: { id: partId }, select: { storageBucket: true, storageKey: true } });
    objects.set(`${p.storageBucket}/${p.storageKey}`, Buffer.from(`bytes-${randomUUID()}`));
  }

  it("concurrent submits on a ONE_TIME link finalize exactly ONE record", async () => {
    const t = await mintLink({ intakeMode: "EXTERNAL_ONE_TIME", maxUses: 1 });
    const s1 = await openSession(t);
    const s2 = await openSession(t);
    for (const sid of [s1, s2]) {
      const r = await postPart(t, sid, 0);
      expect(r.statusCode, r.body).toBe(201);
      await upload((r.json() as { part: { id: string } }).part.id);
    }
    const [a, b] = await Promise.all([
      h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${s1}/submit`, payload: {} }),
      h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${s2}/submit`, payload: {} }),
    ]);
    const ok = [a, b].filter((r) => r.statusCode === 200);
    expect(ok, `${a.statusCode} ${a.body} | ${b.statusCode} ${b.body}`).toHaveLength(1);
    const sessions = await prisma.workflowIntakeSession.findMany({ where: { id: { in: [s1, s2] } }, select: { evidenceId: true } });
    const signed = await prisma.evidence.count({
      where: { id: { in: sessions.map((s) => s.evidenceId!).filter(Boolean) }, status: { in: ["SIGNED", "REPORTED"] } },
    });
    expect(signed).toBe(1);
  }, 120_000);

  it("two concurrent first-part uploads in one session bind ONE record; the other reservation is released", async () => {
    const t = await mintLink({ intakeMode: "EXTERNAL_REUSABLE" });
    const sid = await openSession(t);
    const before = new Date();
    const [a, b] = await Promise.all([postPart(t, sid, 0), postPart(t, sid, 1)]);
    expect([a.statusCode, b.statusCode], `${a.body} | ${b.body}`).toEqual([201, 201]);
    const session = await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sid }, select: { evidenceId: true } });
    const parts = await prisma.evidencePart.findMany({
      where: { id: { in: [(a.json() as { part: { id: string } }).part.id, (b.json() as { part: { id: string } }).part.id] } },
      select: { evidenceId: true },
    });
    expect(new Set(parts.map((p) => p.evidenceId))).toEqual(new Set([session.evidenceId]));
    // Any record created for this session besides the bound one is released.
    const created = await prisma.evidence.findMany({
      where: { teamId: h.fixtures.teamA.teamId, createdAt: { gte: before }, acquisitionMode: "SECURE_INTAKE_LINK" } as never,
      select: { id: true, deletedAt: true },
    });
    for (const e of created) {
      if (e.id !== session.evidenceId) expect(e.deletedAt, `orphan ${e.id}`).toBeInstanceOf(Date);
    }
  }, 120_000);

  it("maxFileCountPerSession holds under concurrent uploads", async () => {
    const t = await mintLink({ intakeMode: "EXTERNAL_REUSABLE", maxFileCountPerSession: 2 });
    const sid = await openSession(t);
    const first = await postPart(t, sid, 0);
    expect(first.statusCode, first.body).toBe(201);
    // One slot left; two uploads race for it.
    const [a, b] = await Promise.all([postPart(t, sid, 1), postPart(t, sid, 2)]);
    expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([201, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json()).toMatchObject({ error: { code: "MAX_FILES_REACHED" } });
    const session = await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sid }, select: { evidenceId: true } });
    expect(await prisma.evidencePart.count({ where: { evidenceId: session.evidenceId! } })).toBe(2);
  }, 120_000);
});

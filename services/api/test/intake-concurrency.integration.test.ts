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
// PRO-050 — a one-shot pause in the next HEAD, to open a window during a submit.
const headPause = vi.hoisted(() => ({ ms: 0 }));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) => `http://127.0.0.1:59000/${p.bucket}/${p.key}?presigned=${randomUUID()}`,
    headObject: async (p: { bucket: string; key: string }) => {
      if (headPause.ms > 0) {
        const ms = headPause.ms;
        headPause.ms = 0;
        await new Promise((r) => setTimeout(r, ms));
      }
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
  let ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
  // PRO-050 cases open several sessions each; each takes a fresh address so the
  // per-IP limit (a real product bound) is not what they measure.
  const freshIp = () => {
    ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  };
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
  const partBody = (i: number) => ({ partIndex: i, mimeType: "text/plain", originalFileName: `f${i}.txt`, sizeBytes: 1, checksumSha256Base64: createHash("sha256").update("x").digest("base64"), webkitRelativePath: null });
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
    const r1 = await postPart(t, s1, 0);
    expect(r1.statusCode, r1.body).toBe(201);
    await upload((r1.json() as { part: { id: string } }).part.id);
    // AUD-36 (2026-10-20): the link's one use is held by s1's pending record,
    // so s2 cannot open a second record on it (it used to, and the two raced
    // at submit).
    const r2 = await postPart(t, s2, 0);
    expect(r2.statusCode, r2.body).toBe(409);
    expect((r2.json() as { error: { code: string } }).error.code).toBe("LINK_IN_USE");
    // The submit race that remains — the same session submitted twice at
    // once — still finalizes exactly one record (ET-INT-09 reservation).
    const [a, b] = await Promise.all([
      h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${s1}/submit`, payload: {} }),
      h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${s1}/submit`, payload: {} }),
    ]);
    const ok = [a, b].filter((r) => r.statusCode === 200);
    expect(ok.length, `${a.statusCode} ${a.body} | ${b.statusCode} ${b.body}`).toBeGreaterThanOrEqual(1);
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

  // ---------------------------------------------------------------------------
  // PRO-050 / EVIDENCE-05 — use accounting
  // ---------------------------------------------------------------------------
  const submit = (t: string, sid: string) =>
    h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/submit`, payload: {} });
  const linkRow = () =>
    prisma.workflowIntakeLink.findFirstOrThrow({
      where: { teamId: h.fixtures.teamA.teamId, recipientLabel: "race" },
      orderBy: { createdAt: "desc" },
      select: { id: true, usedCount: true, status: true },
    });
  async function staged(t: string) {
    const sid = await openSession(t);
    const part = await postPart(t, sid, 0);
    expect(part.statusCode, part.body).toBe(201);
    await upload((part.json() as { part: { id: string } }).part.id);
    return sid;
  }

  it("PRO-050 (a): one session submitted twice at once uses ONE use of a reusable link", async () => {
    freshIp();
    const t = await mintLink({ intakeMode: "EXTERNAL_REUSABLE", maxUses: 5 });
    const sid = await staged(t);
    const [a, b] = await Promise.all([submit(t, sid), submit(t, sid)]);
    expect([a.statusCode, b.statusCode].filter((c) => c === 200).length, `${a.body} | ${b.body}`).toBeGreaterThanOrEqual(1);
    expect((await linkRow()).usedCount).toBe(1);
  }, 120_000);

  it("PRO-050 (b): a revoke that lands while a submit is in flight seals nothing and uses nothing", async () => {
    freshIp();
    const t = await mintLink({ intakeMode: "EXTERNAL_REUSABLE", maxUses: 3, maxBytesPerSession: 10_000_000 });
    const sid = await staged(t);
    const link = await linkRow();
    // Pauses the byte-cap HEAD of the submit, before any use is reserved.
    headPause.ms = 1500;
    const inflight = submit(t, sid);
    await new Promise((r) => setTimeout(r, 300));
    const revoke = await h.app.inject({
      method: "POST",
      url: `/v1/workflow/intake-links/${link.id}/revoke`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
      payload: { reason: "revoked mid-submit" },
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const res = await inflight;
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json()).toMatchObject({ error: { code: "LINK_NO_LONGER_AVAILABLE" } });
    const session = await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sid }, select: { evidenceId: true } });
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: session.evidenceId! }, select: { status: true } });
    expect(["SIGNED", "REPORTED"]).not.toContain(ev.status);
    expect(await linkRow()).toMatchObject({ usedCount: 0, status: "REVOKED" });
  }, 120_000);

  it("PRO-050 (c): staged sessions untouched past the reservation window no longer lock a reusable link", async () => {
    freshIp();
    const t = await mintLink({ intakeMode: "EXTERNAL_REUSABLE", maxUses: 2 });
    const s1 = await staged(t);
    const s2 = await staged(t);
    // A third contributor is refused while both staged records are live.
    const s3 = await openSession(t);
    const refused = await postPart(t, s3, 0);
    expect(refused.statusCode, refused.body).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe("LINK_IN_USE");
    // Both staged records go quiet for longer than the 24 h reservation window.
    const ids = (await prisma.workflowIntakeSession.findMany({ where: { id: { in: [s1, s2] } }, select: { evidenceId: true } })).map(
      (s) => s.evidenceId!,
    );
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    await prisma.evidence.updateMany({ where: { id: { in: ids } }, data: { createdAt: old, updatedAt: old } as never });
    const admitted = await postPart(t, s3, 0);
    expect(admitted.statusCode, admitted.body).toBe(201);
    // The use itself is still counted once, at submit: the link is never over-used.
    await upload((admitted.json() as { part: { id: string } }).part.id);
    const done = await submit(t, s3);
    expect(done.statusCode, done.body).toBe(200);
    expect((await linkRow()).usedCount).toBe(1);
  }, 120_000);
});

/**
 * Team remediation stage F — public intake part identity and the per-submission
 * byte cap at presign (T-127, T-129; audit JRN-03, JRN-05).
 *
 * Live PostgreSQL 16 and the real public routes. The object store is the
 * in-memory double at the storage module boundary used by the other intake
 * suites (intake-part-retry, intake-finalization-governance): a "stored" part
 * is an object present in the map, written by the test exactly as the
 * presigned PUT would have written it.
 *
 * Every assertion here failed on the audited code (e4e908e88):
 *   - a 5000-byte declaration on a 200-byte link was presigned (201);
 *   - a same-name, same-type file with DIFFERENT content on an occupied index
 *     was re-issued the earlier file's reservation (201, same part id), also
 *     after that earlier file's bytes were stored.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { intakeConsentDisclosureText } from "@proovra/shared";

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

type PartReply = { part: { id: string }; upload: { putUrl: string } };

describe("T-127 / T-129 — intake presign byte cap and part identity (live PostgreSQL 16)", () => {
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

  async function openSession(over: Record<string, unknown> = {}) {
    const A = h.fixtures.teamA;
    const link = await h.app.inject({
      method: "POST", url: "/v1/workflow/intake-links", headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: { teamId: A.teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_REUSABLE", recipientLabel: "stage-f", expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(), ...over },
    });
    expect(link.statusCode, link.body).toBe(201);
    const t = encodeURIComponent((link.json() as { rawToken: string }).rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
    expect(boot.statusCode, boot.body).toBe(200);
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const sid = opened.session.id;
    const c = await h.app.inject({
      method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/consent`,
      payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(intakeConsentDisclosureText(opened.link.consentDisclosureText)).digest("hex"), termsAcknowledged: true, identityDisclosed: true, ipHash: null, userAgent: null } },
    });
    expect(c.statusCode, c.body).toBe(200);
    const part = (partIndex: number, content: string, name = "image.txt", sizeBytes = Buffer.byteLength(content)) =>
      h.app.inject({
        method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/parts`,
        payload: { partIndex, mimeType: "text/plain", originalFileName: name, sizeBytes, checksumSha256Base64: createHash("sha256").update(content).digest("base64"), webkitRelativePath: null },
      });
    const store = async (partId: string, content: string) => {
      const row = await prisma.evidencePart.findUniqueOrThrow({ where: { id: partId }, select: { storageBucket: true, storageKey: true } });
      objects.set(`${row.storageBucket}/${row.storageKey}`, Buffer.from(content));
    };
    return { t, sid, part, store };
  }

  it("T-127: a declaration over the per-submission byte cap is refused at presign (alone, and with what is already staged); a retry is not double-counted", async () => {
    const s = await openSession({ maxBytesPerSession: 200 });
    const alone = await s.part(0, "x", "huge.txt", 5000);
    expect(alone.statusCode, alone.body).toBe(413);
    expect(alone.json()).toMatchObject({ error: { code: "SUBMISSION_TOO_LARGE", maxBytes: 200 } });
    expect(typeof (alone.json() as { error: { message?: string } }).error.message).toBe("string");

    const first = await s.part(0, "a".repeat(150), "first.txt");
    expect(first.statusCode, first.body).toBe(201);
    // 150 staged + 100 declared > 200.
    const second = await s.part(1, "b".repeat(100), "second.txt");
    expect(second.statusCode, second.body).toBe(413);
    expect(second.json()).toMatchObject({ error: { code: "SUBMISSION_TOO_LARGE" } });
    // A retry of the SAME file on its own index is the same reservation, never counted twice.
    const retry = await s.part(0, "a".repeat(150), "first.txt");
    expect(retry.statusCode, retry.body).toBe(201);
    expect((retry.json() as PartReply).part.id).toBe((first.json() as PartReply).part.id);
    // What still fits is accepted.
    const fits = await s.part(1, "c".repeat(50), "third.txt");
    expect(fits.statusCode, fits.body).toBe(201);
  });

  it("T-129: same name and type with different content on an occupied index is refused (before and after its bytes are stored); separate files with identical names are both kept", async () => {
    const s = await openSession();
    const a = await s.part(0, "camera shot one", "image.txt");
    expect(a.statusCode, a.body).toBe(201);
    const aId = (a.json() as PartReply).part.id;

    // Different bytes, same name and type, same index: not the same file.
    const collide = await s.part(0, "camera shot TWO", "image.txt");
    expect(collide.statusCode, collide.body).toBe(409);
    expect(collide.json()).toMatchObject({ error: { code: "PART_INDEX_TAKEN" } });

    // Stored, then the different file again: still refused.
    await s.store(aId, "camera shot one");
    const afterUpload = await s.part(0, "camera shot TWO", "image.txt");
    expect(afterUpload.statusCode, afterUpload.body).toBe(409);

    // A row reserved before the content binding (no bound digest): the stored
    // object counts as uploaded, even for the same name and type.
    const before = await prisma.evidencePart.findUniqueOrThrow({ where: { id: aId }, select: { clientSignals: true } });
    const legacySignals = { ...(before.clientSignals as Record<string, unknown>) };
    delete legacySignals.boundSha256Base64;
    delete legacySignals.boundSizeBytes;
    await prisma.evidencePart.update({ where: { id: aId }, data: { clientSignals: legacySignals as never } });
    const legacyRetry = await s.part(0, "camera shot one", "image.txt");
    expect(legacyRetry.statusCode, legacyRetry.body).toBe(409);

    // The second "image.txt" goes on its own index and is its own part.
    const b = await s.part(1, "camera shot TWO", "image.txt");
    expect(b.statusCode, b.body).toBe(201);
    const bId = (b.json() as PartReply).part.id;
    expect(bId).not.toBe(aId);
    await s.store(bId, "camera shot TWO");

    const rows = await prisma.evidencePart.findMany({ where: { id: { in: [aId, bId] } }, select: { id: true, storageKey: true, originalFileName: true } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.storageKey)).size).toBe(2);
    expect(rows.every((r) => r.originalFileName === "image.txt")).toBe(true);

    const submit = await h.app.inject({ method: "POST", url: `/v1/external-intake/${s.t}/sessions/${s.sid}/submit`, payload: {} });
    expect(submit.statusCode, submit.body).toBe(200);
    const sealed = await prisma.evidencePart.findMany({ where: { id: { in: [aId, bId] } }, select: { sha256: true } });
    expect(new Set(sealed.map((r) => r.sha256)).size).toBe(2);
  });
});

/**
 * Independent forward audit closure — intake acquisition truth (F-01, F-04,
 * F-21). Live PostgreSQL 16 and the real public intake routes; the object store
 * is an in-memory double at the storage module boundary (the pattern of
 * intake-concurrency.integration.test.ts).
 *
 * F-01 — a submit that reaches an already-sealed record (a retry after the
 *        post-seal session transition failed, or two submits racing) must not
 *        change any capture fact the signed fingerprint commits to.
 * F-04 — an app (non-browser) fix and its provider mock flag are recorded with
 *        the seal and stated by the canonical location state.
 * F-21 — a sealed intake record always carries its link-used, consent and
 *        submitted custody events, even when the best-effort append at session
 *        creation failed.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MOCK_LOCATION_DETAIL } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const failCustodyOnce = vi.hoisted(() => new Set<string>());

vi.mock("../../src/storage.js", async (importOriginal) => {
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

// F-21 failure injection at the custody service boundary: the named event's
// FIRST append (the best-effort one at session creation) throws once.
vi.mock("../../src/services/custody-events.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { appendCustodyEvent: (i: { eventType: string }) => Promise<unknown> }>();
  return {
    ...actual,
    appendCustodyEvent: async (input: { eventType: string }) => {
      if (failCustodyOnce.delete(String(input.eventType))) throw new Error("injected custody append failure");
      return actual.appendCustodyEvent(input);
    },
  };
});

describe("F-01 / F-04 / F-21 — intake acquisition truth (live PostgreSQL 16)", () => {
  const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    process.env.TSA_ENABLED = "false";
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function mintLink(extra: Record<string, unknown> = {}) {
    const A = h.fixtures.teamA;
    const link = await h.app.inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: {
        teamId: A.teamId,
        workflowTemplateSlug: "general-evidence-record",
        recipientLabel: "afc",
        intakeMode: "EXTERNAL_REUSABLE",
        locationPolicy: "OPTIONAL",
        maxUses: 10,
        expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
        ...extra,
      },
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
  async function uploadOne(t: string, sid: string) {
    const r = await h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/parts`, payload: { partIndex: 0, mimeType: "text/plain", originalFileName: "f0.txt", checksumSha256Base64: null, webkitRelativePath: null } });
    expect(r.statusCode, r.body).toBe(201);
    const p = await prisma.evidencePart.findUniqueOrThrow({ where: { id: (r.json() as { part: { id: string } }).part.id }, select: { storageBucket: true, storageKey: true, evidenceId: true } });
    objects.set(`${p.storageBucket}/${p.storageKey}`, Buffer.from(`bytes-${randomUUID()}`));
    return p.evidenceId;
  }
  const submit = (t: string, sid: string, payload: unknown) =>
    h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/submit`, payload: payload as never });
  const fix = (lat: number, lng: number, extra: Record<string, unknown> = {}) => ({
    location: { consentState: "GRANTED", latitude: lat, longitude: lng, accuracyMeters: 12, capturedAtUtc: new Date().toISOString(), source: "BROWSER_GEOLOCATION", ...extra },
    deviceTime: { deviceTimeIso: new Date(Date.now() - 60_000).toISOString(), timezone: "Europe/Berlin", timezoneOffsetMinutes: -120 },
  });

  /** The row's capture facts and what the signed fingerprint commits to. */
  async function rowVsFingerprint(evidenceId: string) {
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, lat: true, lng: true, accuracyMeters: true, deviceTimeIso: true, locationSource: true, fingerprintCanonicalJson: true },
    });
    const fp = JSON.parse(String(row.fingerprintCanonicalJson)) as { deviceTimeIso: string | null; gps: { lat: number | null; lng: number | null; accuracyMeters: number | null } };
    return {
      status: row.status,
      row: { lat: row.lat == null ? null : Number(row.lat), lng: row.lng == null ? null : Number(row.lng), accuracyMeters: row.accuracyMeters == null ? null : Number(row.accuracyMeters), deviceTimeIso: row.deviceTimeIso },
      signed: { lat: fp.gps.lat, lng: fp.gps.lng, accuracyMeters: fp.gps.accuracyMeters, deviceTimeIso: fp.deviceTimeIso },
      locationSource: row.locationSource,
    };
  }

  it("F-01: a retried submit after sealing cannot change a fingerprint-bound capture fact", async () => {
    const t = await mintLink();
    const sid = await openSession(t);
    const evidenceId = await uploadOne(t, sid);
    const first = await submit(t, sid, fix(52.52, 13.405));
    expect(first.statusCode, first.body).toBe(200);
    const sealed = await rowVsFingerprint(evidenceId);
    expect(sealed.status).toBe("SIGNED");
    expect(sealed.row).toEqual(sealed.signed);
    expect(sealed.signed.lat).toBeCloseTo(52.52, 5);

    // The documented tolerated failure: the seal committed but the session's
    // SUBMITTED transition did not (external-intake-orchestration ET-INT-13).
    await prisma.workflowIntakeSession.update({ where: { id: sid }, data: { status: "UPLOAD_COMPLETED" } });
    const retry = await submit(t, sid, fix(40.7128, -74.006));
    expect(retry.statusCode, retry.body).toBeLessThan(500);

    const after = await rowVsFingerprint(evidenceId);
    expect(after.row).toEqual(after.signed);
    expect(after.row).toEqual(sealed.row);
  }, 120_000);

  it("F-01: two submits racing with different fixes leave the row equal to what was signed", async () => {
    const t = await mintLink();
    const sid = await openSession(t);
    const evidenceId = await uploadOne(t, sid);
    const [a, b] = await Promise.all([submit(t, sid, fix(48.8566, 2.3522)), submit(t, sid, fix(35.6762, 139.6503))]);
    expect([a.statusCode, b.statusCode].some((s) => s === 200), `${a.body} | ${b.body}`).toBe(true);
    const after = await rowVsFingerprint(evidenceId);
    expect(after.status).toBe("SIGNED");
    expect(after.row).toEqual(after.signed);
  }, 120_000);

  it("F-01: the database refuses a post-seal change to a fingerprint-bound capture column", async () => {
    const t = await mintLink();
    const sid = await openSession(t);
    const evidenceId = await uploadOne(t, sid);
    expect((await submit(t, sid, fix(51.5074, -0.1278))).statusCode).toBe(200);
    for (const data of [{ lat: 1 }, { lng: 1 }, { accuracyMeters: 1 }, { deviceTimeIso: "2020-01-01T00:00:00.000Z" }, { locationSource: "TAMPERED" }, { capturedAtUtc: new Date(0) }]) {
      await expect(prisma.evidence.update({ where: { id: evidenceId }, data: data as never }), JSON.stringify(data)).rejects.toThrow(/sealed|permanent/i);
    }
  }, 120_000);

  it("F-04: an app fix with a provider mock flag is accepted, sealed and stated as mocked", async () => {
    const t = await mintLink();
    const sid = await openSession(t);
    const evidenceId = await uploadOne(t, sid);
    const res = await submit(t, sid, fix(52.52, 13.405, { source: "DEVICE_GEOLOCATION", providerReportedMock: true }));
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { locationSource: true } });
    expect(row.locationSource).toBe("INTAKE_LINK_DEVICE_GEOLOCATION");
    const owner = await h.app.inject({ method: "GET", url: `/v1/evidence/${evidenceId}/review-workspace`, headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` } });
    expect(owner.statusCode, owner.body).toBe(200);
    const find = (o: unknown): Record<string, unknown> | null => {
      if (!o || typeof o !== "object") return null;
      const rec = o as Record<string, unknown>;
      if (rec.locationState && typeof rec.locationState === "object") return rec.locationState as Record<string, unknown>;
      for (const v of Object.values(rec)) {
        const hit = find(v);
        if (hit) return hit;
      }
      return null;
    };
    expect(find(owner.json())).toMatchObject({ state: "RECORDED", tone: "warning", detail: MOCK_LOCATION_DETAIL, providerReportedMock: true });
  }, 120_000);

  it("F-04: a browser fix records no mock flag", async () => {
    const t = await mintLink();
    const sid = await openSession(t);
    const evidenceId = await uploadOne(t, sid);
    expect((await submit(t, sid, fix(52.52, 13.405))).statusCode).toBe(200);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { locationSource: true } });
    expect(row.locationSource).toBe("INTAKE_LINK_GEOLOCATION");
  }, 120_000);

  it("F-21: a sealed intake record carries link-used, consent and submitted events even when the creation-time append failed", async () => {
    const t = await mintLink();
    const sid = await openSession(t);
    failCustodyOnce.add("EXTERNAL_INTAKE_LINK_USED");
    failCustodyOnce.add("EXTERNAL_INTAKE_CONSENT_ACCEPTED");
    const evidenceId = await uploadOne(t, sid);
    failCustodyOnce.clear();
    expect((await submit(t, sid, {})).statusCode).toBe(200);
    const events = await prisma.custodyEvent.findMany({ where: { evidenceId }, orderBy: { sequence: "asc" }, select: { eventType: true, sequence: true } });
    const types = events.map((e) => e.eventType);
    for (const required of ["EXTERNAL_INTAKE_LINK_USED", "EXTERNAL_INTAKE_CONSENT_ACCEPTED", "EXTERNAL_INTAKE_SUBMITTED"]) {
      expect(types.filter((x) => x === required), required).toHaveLength(1);
    }
    // Contiguous, gap-free chain.
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
  }, 120_000);
});

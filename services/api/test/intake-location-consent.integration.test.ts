/**
 * F-36 (2026-10-29) — intake location consent CONTROLS collection and
 * inclusion. Live PostgreSQL 16 and the real public intake routes; the object
 * store is an in-memory double at the storage module boundary (the pattern of
 * forward/afc-intake-sealed-truth.integration.test.ts).
 *
 *   - REQUIRED refuses a submit without a location (412 LOCATION_REQUIRED with
 *     an actionable message); the SAME session then submits with a fix.
 *   - DENIED / TIMEOUT / UNAVAILABLE are recorded as outcomes on the sealed
 *     record (TIMEOUT used to be refused as a malformed body).
 *   - GRANTED with coordinates 0 / 0 is a real fix and is persisted.
 *   - GRANTED with no usable coordinates is recorded as UNAVAILABLE, never
 *     as a consent the record cannot show.
 *   - A NONE link collects nothing whatever the client sends.
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
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `http://127.0.0.1:59000/${p.bucket}/${p.key}?presigned=${randomUUID()}`,
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

describe("F-36 — intake location consent controls collection (live PostgreSQL 16)", () => {
  // One address per session: the public routes are rate limited per IP.
  let ip = "";
  const freshIp = () => `198.51.${100 + Math.floor(Math.random() * 100)}.${1 + Math.floor(Math.random() * 250)}`;
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let intakeLocationOutcome: (typeof import("../src/services/external-intake-orchestration.service.js"))["intakeLocationOutcome"];

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    process.env.TSA_ENABLED = "false";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ intakeLocationOutcome } = await import("../src/services/external-intake-orchestration.service.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function mintLink(locationPolicy: "NONE" | "OPTIONAL" | "REQUIRED") {
    const A = h.fixtures.teamA;
    const link = await h.app.inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: {
        teamId: A.teamId,
        workflowTemplateSlug: "general-evidence-record",
        recipientLabel: "f36",
        intakeMode: "EXTERNAL_REUSABLE",
        locationPolicy,
        maxUses: 10,
        expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(link.statusCode, link.body).toBe(201);
    return encodeURIComponent((link.json() as { rawToken: string }).rawToken);
  }
  async function openSession(t: string) {
    ip = freshIp();
    const boot = await h.app.inject({ remoteAddress: ip, method: "GET", url: `/v1/external-intake/${t}` });
    expect(boot.statusCode, boot.body).toBe(200);
    const opened = boot.json() as {
      session: { id: string };
      link: { consentPolicyVersion: string | null; consentDisclosureText: string | null; locationPolicy?: string };
    };
    const sid = opened.session.id;
    const consent = await h.app.inject({
      remoteAddress: ip,
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${sid}/consent`,
      payload: {
        consent: {
          acceptedAtUtc: new Date().toISOString(),
          policyVersion: opened.link.consentPolicyVersion || "v1",
          disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"),
          termsAcknowledged: true,
          identityDisclosed: true,
          ipHash: null,
          userAgent: null,
        },
      },
    });
    expect(consent.statusCode, consent.body).toBeLessThan(300);
    return { sid, advertisedPolicy: opened.link.locationPolicy };
  }
  async function uploadOne(t: string, sid: string) {
    const r = await h.app.inject({
      remoteAddress: ip,
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${sid}/parts`,
      payload: { partIndex: 0, mimeType: "text/plain", originalFileName: "f0.txt", checksumSha256Base64: null, webkitRelativePath: null },
    });
    expect(r.statusCode, r.body).toBe(201);
    const p = await prisma.evidencePart.findUniqueOrThrow({
      where: { id: (r.json() as { part: { id: string } }).part.id },
      select: { storageBucket: true, storageKey: true, evidenceId: true },
    });
    objects.set(`${p.storageBucket}/${p.storageKey}`, Buffer.from(`bytes-${randomUUID()}`));
    return p.evidenceId;
  }
  const submit = (t: string, sid: string, payload: unknown) =>
    h.app.inject({ remoteAddress: ip, method: "POST", url: `/v1/external-intake/${t}/sessions/${sid}/submit`, payload: payload as never });
  const fix = (lat: number, lng: number) => ({
    location: { consentState: "GRANTED", latitude: lat, longitude: lng, accuracyMeters: 9, capturedAtUtc: new Date().toISOString(), source: "BROWSER_GEOLOCATION" },
  });
  async function sealed(evidenceId: string) {
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, lat: true, lng: true, locationSource: true },
    });
    const submitted = await prisma.custodyEvent.findFirst({
      where: { evidenceId, eventType: "EXTERNAL_INTAKE_SUBMITTED" },
      select: { payload: true },
    });
    const payload = (submitted?.payload ?? {}) as Record<string, unknown>;
    return {
      status: row.status,
      lat: row.lat == null ? null : Number(row.lat),
      lng: row.lng == null ? null : Number(row.lng),
      locationSource: row.locationSource,
      outcome: payload.locationConsentState ?? null,
      locationProvided: payload.locationProvided ?? null,
    };
  }

  it("REQUIRED: refuses a submit without a location with an actionable message, then accepts the retry with a fix", async () => {
    const t = await mintLink("REQUIRED");
    const { sid, advertisedPolicy } = await openSession(t);
    expect(advertisedPolicy).toBe("REQUIRED");
    const evidenceId = await uploadOne(t, sid);

    for (const body of [{}, { location: { consentState: "DENIED" } }, { location: { consentState: "TIMEOUT" } }]) {
      const refused = await submit(t, sid, body);
      expect(refused.statusCode, refused.body).toBe(412);
      const err = (refused.json() as { error: { code: string; message: string } }).error;
      expect(err.code).toBe("LOCATION_REQUIRED");
      expect(err.message).toMatch(/location/i);
      expect(err.message).toMatch(/try again/i);
    }
    expect((await sealed(evidenceId)).status).not.toBe("SIGNED");

    const ok = await submit(t, sid, fix(51.5, -0.12));
    expect(ok.statusCode, ok.body).toBe(200);
    const s = await sealed(evidenceId);
    expect(s.status).toBe("SIGNED");
    expect(s.lat).toBeCloseTo(51.5, 5);
    expect(s.outcome).toBe("GRANTED");
    expect(s.locationSource).toBe("INTAKE_LINK_GEOLOCATION");
  }, 120_000);

  it("OPTIONAL: DENIED / TIMEOUT / UNAVAILABLE / NOT_REQUESTED are recorded outcomes; no location is stored", async () => {
    for (const outcome of ["DENIED", "TIMEOUT", "UNAVAILABLE", "NOT_REQUESTED"]) {
      const t = await mintLink("OPTIONAL");
      const { sid } = await openSession(t);
      const evidenceId = await uploadOne(t, sid);
      const res = await submit(t, sid, { location: { consentState: outcome } });
      expect(res.statusCode, `${outcome}: ${res.body}`).toBe(200);
      const s = await sealed(evidenceId);
      expect(s.status).toBe("SIGNED");
      expect(s.outcome, outcome).toBe(outcome);
      expect(s.lat).toBeNull();
      expect(s.locationProvided).toBe(false);
    }
  }, 240_000);

  it("OPTIONAL: a 0 / 0 fix is a real location and is persisted (never dropped as falsy)", async () => {
    const t = await mintLink("OPTIONAL");
    const { sid } = await openSession(t);
    const evidenceId = await uploadOne(t, sid);
    const res = await submit(t, sid, fix(0, 0));
    expect(res.statusCode, res.body).toBe(200);
    const s = await sealed(evidenceId);
    expect(s.lat).toBe(0);
    expect(s.lng).toBe(0);
    expect(s.outcome).toBe("GRANTED");
    expect(s.locationProvided).toBe(true);
  }, 120_000);

  it("OPTIONAL: GRANTED without coordinates is recorded as UNAVAILABLE, not as a grant", async () => {
    const t = await mintLink("OPTIONAL");
    const { sid } = await openSession(t);
    const evidenceId = await uploadOne(t, sid);
    const res = await submit(t, sid, { location: { consentState: "GRANTED" } });
    expect(res.statusCode, res.body).toBe(200);
    const s = await sealed(evidenceId);
    expect(s.outcome).toBe("UNAVAILABLE");
    expect(s.lat).toBeNull();
  }, 120_000);

  it("NONE: nothing is collected whatever the client sends", async () => {
    const t = await mintLink("NONE");
    const { sid, advertisedPolicy } = await openSession(t);
    expect(advertisedPolicy ?? "NONE").toBe("NONE");
    const evidenceId = await uploadOne(t, sid);
    const res = await submit(t, sid, fix(52.52, 13.405));
    expect(res.statusCode, res.body).toBe(200);
    const s = await sealed(evidenceId);
    expect(s.lat).toBeNull();
    expect(s.locationSource).toBeNull();
    expect(s.outcome).toBeNull();
  }, 120_000);

  it("the outcome normaliser never guesses a grant", () => {
    expect(intakeLocationOutcome("GRANTED", true)).toBe("GRANTED");
    expect(intakeLocationOutcome("GRANTED", false)).toBe("UNAVAILABLE");
    expect(intakeLocationOutcome("TIMEOUT", false)).toBe("TIMEOUT");
    expect(intakeLocationOutcome("SOMETHING", true)).toBe("NOT_REQUESTED");
    expect(intakeLocationOutcome(undefined, true)).toBe("NOT_REQUESTED");
  });
});

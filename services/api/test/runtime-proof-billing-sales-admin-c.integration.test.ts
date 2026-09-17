/**
 * BATCH K7 (part C) — runtime proof for the public, unauthenticated lead
 * capture pair the UI mutation sweep could not drive to their SUCCESS branch.
 *
 *   POST /v1/contact-sales   contact-sales.routes.ts
 *   POST /v1/demo-requests   demo-requests.routes.ts
 *
 * The body and headers are exactly what the web proxy forwards upstream
 * (`apps/web/app/api/_marketing-leads.ts`: the schema-validated form values
 * from `lib/contact-sales-schema.ts` / `lib/request-demo-schema.ts`, plus
 * `intent`, `sourcePage`, `submittedAt`, `referrer`). Neither route writes an
 * audit row: they are anonymous marketing intake with no actor and no tenant,
 * and the persisted lead row (with its recorded client address) is the record.
 * Operator email goes to the local RECORDING transport.
 *
 * Disposable local PostgreSQL + Redis only — the harness refuses anything else.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("K7-C — public sales lead capture (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  const tag = `k7c-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const call = (opts: {
    url: string;
    payload: unknown;
    headers: Record<string, string>;
    remoteAddress: string;
  }) =>
    harness.app.inject({
      method: "POST",
      url: opts.url,
      remoteAddress: opts.remoteAddress,
      headers: { "content-type": "application/json", ...opts.headers },
      payload: opts.payload as never,
    });

  // Response bodies are asserted structurally below; a loose read type keeps each assertion one line.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });


  /** A per-test client address, so the per-IP limiter never couples tests or runs. */
  const freshIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`;

  /** The headers `_marketing-leads.ts` sends upstream. */
  const proxyHeaders = (ip: string, sourceHeader: string) => ({
    "user-agent": "proovra-web-proxy",
    "x-forwarded-for": ip,
    "x-forwarded-host": "www.proovra.com",
    "x-forwarded-proto": "https",
    origin: "https://www.proovra.com",
    "x-web-client": "proovra-web-proxy",
    [sourceHeader]: "website",
  });

  describe("POST /v1/contact-sales", () => {
    const contactPayload = (email: string) => ({
      // contactSalesSchema-validated form values, then the proxy's additions.
      fullName: "Sam Buyer",
      workEmail: email,
      organization: "Fixture Sales GmbH",
      jobTitle: "CTO",
      country: "DE",
      teamSize: "51-200",
      discussionTopic: "enterprise-pricing",
      stage: "procurement-review",
      deploymentTimeline: "1-3-months",
      estimatedUsers: "51-250",
      currentChallenge: "Our current evidence store cannot prove when a photograph was taken.",
      additionalDetails: "SSO required.",
      intent: "contact_sales",
      sourcePage: "contact-sales",
      submittedAt: new Date().toISOString(),
      referrer: "https://www.proovra.com/pricing",
    });

    it("an anonymous visitor's inquiry is persisted (201) with its recorded client and the operator email dispatched", async () => {
      const ip = freshIp();
      const email = `Sam-${tag}@Fixture-Sales.local`;
      const res = await call({
        url: "/v1/contact-sales",
        payload: contactPayload(email),
        headers: proxyHeaders(ip, "x-lead-source"),
        remoteAddress: ip,
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = json(res);
      expect(body).toMatchObject({ ok: true, data: { status: "NEW", isSpam: false, emailDispatched: true } });

      const row = await prisma.contactSalesRequest.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row).toMatchObject({
        workEmail: email.toLowerCase(),
        organization: "Fixture Sales GmbH",
        discussionTopic: "enterprise-pricing",
        stage: "procurement-review",
        sourcePage: "contact-sales",
        referrer: "https://www.proovra.com/pricing",
        status: "NEW",
        isSpam: false,
        ipAddress: ip,
        userAgent: "proovra-web-proxy",
      });
      expect(row.emailSentAt).not.toBeNull();
    });

    it("an invalid body is 400 and the sixth submission in a minute from one address is 429 — neither writes a row", async () => {
      const ip = freshIp();
      const email = `limit-${tag}-${randomUUID().slice(0, 6)}@fixture-sales.local`;
      const invalid = await call({
        url: "/v1/contact-sales",
        payload: { ...contactPayload(email), currentChallenge: "short" },
        headers: proxyHeaders(ip, "x-lead-source"),
        remoteAddress: ip,
      });
      expect(invalid.statusCode).toBe(400);
      expect(json(invalid).error.code).toBe("VALIDATION_ERROR");
      expect(await prisma.contactSalesRequest.count({ where: { workEmail: email } })).toBe(0);

      // The invalid request consumed one of the five; four more valid ones fill the window.
      for (let i = 0; i < 4; i += 1) {
        const ok = await call({
          url: "/v1/contact-sales",
          payload: contactPayload(email),
          headers: proxyHeaders(ip, "x-lead-source"),
          remoteAddress: ip,
        });
        expect(ok.statusCode, ok.body).toBe(201);
      }
      const limited = await call({
        url: "/v1/contact-sales",
        payload: contactPayload(email),
        headers: proxyHeaders(ip, "x-lead-source"),
        remoteAddress: ip,
      });
      expect(limited.statusCode).toBe(429);
      expect(json(limited)).toEqual({ error: { code: "RATE_LIMITED" } });
      expect(await prisma.contactSalesRequest.count({ where: { workEmail: email } })).toBe(4);
    });
  });

  describe("POST /v1/demo-requests", () => {
    const demoPayload = (email: string) => ({
      // requestDemoSchema-validated form values, then the proxy's additions.
      fullName: "Riley Evaluator",
      workEmail: email,
      organization: "Fixture Claims Ltd",
      jobTitle: "Director of Claims",
      country: "GB",
      teamSize: "201-1000",
      primaryInterest: "verification",
      organizationType: "insurance",
      useCase: "We need defensible photo evidence for property damage claims.",
      message: "Please include the verification package.",
      intent: "request_demo",
      sourcePage: "request-demo",
      submittedAt: new Date().toISOString(),
      referrer: "https://www.proovra.com/request-demo",
    });

    it("an anonymous visitor's demo request is persisted (201) with scoring, routing and follow-up state", async () => {
      const ip = freshIp();
      const email = `riley-${tag}@fixture-claims.local`;
      const res = await call({
        url: "/v1/demo-requests",
        payload: demoPayload(email),
        headers: proxyHeaders(ip, "x-demo-source"),
        remoteAddress: ip,
      });
      expect(res.statusCode, res.body).toBe(201);
      const created = await prisma.demoRequest.findFirstOrThrow({ where: { workEmail: email } });
      expect(created).toMatchObject({
        fullName: "Riley Evaluator",
        organization: "Fixture Claims Ltd",
        useCase: "We need defensible photo evidence for property damage claims.",
        referrer: "https://www.proovra.com/request-demo",
        status: "NEW",
        isSpam: false,
        ipAddress: ip,
      });
      expect(created.leadTrack).toEqual(expect.any(String));
      expect(created.routingTarget).toEqual(expect.any(String));
      expect(JSON.stringify(json(res))).toContain(created.id);
    });

    it("an invalid body is 400 and the sixth submission in a minute from one address is 429 — neither writes a row", async () => {
      const ip = freshIp();
      const email = `limit-${tag}-${randomUUID().slice(0, 6)}@fixture-claims.local`;
      const invalid = await call({
        url: "/v1/demo-requests",
        payload: { ...demoPayload(email), useCase: "too short" },
        headers: proxyHeaders(ip, "x-demo-source"),
        remoteAddress: ip,
      });
      expect(invalid.statusCode).toBe(400);
      expect(json(invalid).error.code).toBe("VALIDATION_ERROR");
      expect(await prisma.demoRequest.count({ where: { workEmail: email } })).toBe(0);

      for (let i = 0; i < 4; i += 1) {
        const ok = await call({
          url: "/v1/demo-requests",
          payload: demoPayload(email),
          headers: proxyHeaders(ip, "x-demo-source"),
          remoteAddress: ip,
        });
        expect(ok.statusCode, ok.body).toBe(201);
      }
      const limited = await call({
        url: "/v1/demo-requests",
        payload: demoPayload(email),
        headers: proxyHeaders(ip, "x-demo-source"),
        remoteAddress: ip,
      });
      expect(limited.statusCode).toBe(429);
      expect(json(limited)).toEqual({ error: { code: "RATE_LIMITED" } });
      expect(await prisma.demoRequest.count({ where: { workEmail: email } })).toBe(4);
    });
  });
});

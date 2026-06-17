/**
 * Phase 400-CLIENT-ERROR-HARDENING — behavioural pins.
 *
 * Sentry was reporting `FST_ERR_CTP_INVALID_JSON_BODY` from
 * POST /v1/auth/email/register as a high-priority production error.
 * Root cause: malformed-JSON requests (typically bot probes) fell
 * through `setErrorHandler` into the `request.failed.infrastructure`
 * branch which calls `captureException`.
 *
 * Acceptance: malformed JSON → 400 with the canonical wire shape
 * + warn-log + NO Sentry capture. Real validation errors after JSON
 * parsing must continue to work.
 *
 * The tests boot a minimal Fastify app that mounts our shared
 * detector + the same setErrorHandler shape used by services/api/
 * src/server.ts; this isolates the regression without dragging in
 * Postgres / Sentry / Prisma.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { readFastifyClientError } from "../src/observability/fastify-client-error.js";

describe("readFastifyClientError — pure detector", () => {
  it("classifies the JSON-body parse error as a 400 client error", () => {
    const err = Object.assign(new Error("Body cannot be empty when content-type is set to 'application/json'"), {
      name: "FastifyError",
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
      statusCode: 400,
    });
    const view = readFastifyClientError(err);
    expect(view).not.toBeNull();
    expect(view).toEqual({
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
      statusCode: 400,
      error: "Bad Request",
      message: "Invalid JSON body",
    });
  });

  it("classifies body-too-large as a 413 client error", () => {
    const err = Object.assign(new Error("request body is too large"), {
      name: "FastifyError",
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
      statusCode: 413,
    });
    const view = readFastifyClientError(err);
    expect(view?.statusCode).toBe(413);
    expect(view?.error).toBe("Payload Too Large");
  });

  it("ignores 5xx Fastify errors (server-side bugs stay reportable)", () => {
    const err = Object.assign(new Error("internal"), {
      name: "FastifyError",
      code: "FST_ERR_INTERNAL",
      statusCode: 500,
    });
    expect(readFastifyClientError(err)).toBeNull();
  });

  it("ignores unrelated errors (returns null so callers fall through)", () => {
    expect(readFastifyClientError(new Error("boom"))).toBeNull();
    expect(readFastifyClientError(null)).toBeNull();
    expect(readFastifyClientError(undefined)).toBeNull();
    expect(readFastifyClientError("string")).toBeNull();
    expect(readFastifyClientError({ statusCode: 400 })).toBeNull();
  });

  it("recognises objects with only an FST_ERR_ code (no name set)", () => {
    // Some Fastify wrappers strip `name`. The code prefix alone is
    // a sufficient signal.
    const err = { code: "FST_ERR_VALIDATION", statusCode: 400, message: "x" };
    const view = readFastifyClientError(err);
    expect(view?.statusCode).toBe(400);
    expect(view?.error).toBe("Bad Request");
  });
});

describe("setErrorHandler integration — malformed JSON", () => {
  let app: FastifyInstance;
  let warnLogs: Array<{ obj: unknown; msg?: string }>;
  let errorLogs: Array<{ obj: unknown; msg?: string }>;
  let capturedExceptions: Array<unknown>;

  beforeEach(async () => {
    warnLogs = [];
    errorLogs = [];
    capturedExceptions = [];

    app = Fastify({ logger: false });
    // Inject log hooks via per-request hook so the test can observe
    // what the handler logged without standing up pino.
    app.addHook("onRequest", (req, _reply, done) => {
      // Replace the per-request logger with a capturing adapter. The
      // handler below uses req.log.warn / req.log.error.
      (req as { log: unknown }).log = {
        warn: (obj: unknown, msg?: string) => warnLogs.push({ obj, msg }),
        error: (obj: unknown, msg?: string) => errorLogs.push({ obj, msg }),
        info: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        child: () => (req as { log: unknown }).log,
      };
      done();
    });

    // Mirror the setErrorHandler shape from services/api/src/server.ts
    // (just the FST_ERR_ branch + a generic 500 fallback). Routes
    // never call captureException directly in this test; the spy
    // ensures the handler didn't route through Sentry.
    app.setErrorHandler((err, req, reply) => {
      const fastifyClientError = readFastifyClientError(err);
      if (fastifyClientError) {
        req.log.warn(
          {
            errorCode: fastifyClientError.code,
            statusCode: fastifyClientError.statusCode,
          },
          "request.failed.client_error",
        );
        return reply.code(fastifyClientError.statusCode).send({
          error: fastifyClientError.error,
          message: fastifyClientError.message,
          statusCode: fastifyClientError.statusCode,
        });
      }
      // Anything else simulates the "infrastructure" branch which DOES
      // capture. The spy makes the assertion possible.
      capturedExceptions.push(err);
      req.log.error({ err }, "request.failed.infrastructure");
      return reply.code(500).send({ error: { code: "INTERNAL", message: "x" } });
    });

    // Route mirrors the real auth shape: a Zod-validated body. We
    // need the Zod parsing to happen INSIDE the route so a malformed
    // JSON body fails BEFORE the route is reached (Fastify rejects
    // at the content-type-parser layer).
    const RegisterBody = z.object({
      email: z.string().email(),
      password: z.string().min(8),
    });
    app.post("/v1/auth/email/register", async (req, reply) => {
      const parsed = RegisterBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Validation failed",
          statusCode: 400,
        });
      }
      return reply.code(200).send({ ok: true });
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("malformed JSON returns 400 with the canonical wire shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers: { "content-type": "application/json" },
      payload: "{not json,",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toEqual({
      error: "Bad Request",
      message: "Invalid JSON body",
      statusCode: 400,
    });
  });

  it("malformed JSON is warn-logged, NOT captured as a high-priority error", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers: { "content-type": "application/json" },
      payload: "{not json,",
    });
    expect(capturedExceptions).toHaveLength(0);
    expect(errorLogs).toHaveLength(0);
    expect(warnLogs.length).toBeGreaterThanOrEqual(1);
    const last = warnLogs[warnLogs.length - 1]!;
    expect(last.msg).toBe("request.failed.client_error");
    const ctx = last.obj as { errorCode: string; statusCode: number };
    expect(ctx.errorCode).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
    expect(ctx.statusCode).toBe(400);
  });

  it("warn-log context never contains the raw request body", async () => {
    const garbage = '{"password":"super-secret-from-typo'; // unterminated
    await app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers: { "content-type": "application/json" },
      payload: garbage,
    });
    const serialised = JSON.stringify(warnLogs);
    expect(serialised).not.toContain("super-secret-from-typo");
    expect(serialised).not.toContain(garbage);
  });

  it("valid JSON still reaches normal route validation (negative)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "not-an-email", password: "x" }),
    });
    // Real validation kicks in (route-level Zod) and returns 400 —
    // this proves the JSON-parse branch did NOT swallow valid bodies.
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Validation failed");
    expect(capturedExceptions).toHaveLength(0);
  });

  it("valid registration JSON reaches the route handler (positive)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        email: "a@b.com",
        password: "longenoughpw",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

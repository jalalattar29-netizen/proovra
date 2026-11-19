/**
 * F-08 (Free-user audit 4d9b, capacity; 2026-11-15) — overload is answered
 * fast, not queued without bound.
 *
 * Before this, nothing after the per-route limiters said "no": no request
 * timeout, no in-flight cap, no event-loop shedding, and a pool that waited
 * for ever. Overload therefore showed up as unbounded latency and memory
 * growth, and every client's own timeout then retried into it.
 *
 * Three bounds, each a setting with a default that ordinary traffic never
 * reaches (documented in services/api/.env.example):
 *
 *   API_MAX_IN_FLIGHT            open requests this process will hold (512; 0 = off)
 *   API_MAX_EVENT_LOOP_DELAY_MS  mean event-loop delay over the last 500 ms
 *                                window above which new work is refused
 *                                (1000 when NODE_ENV=production, else 0; 0 = off)
 *   API_OVERLOAD_RETRY_AFTER_SECONDS  what the refusal tells the client (2)
 *
 * The refusal is 503 + Retry-After with a nested `error.code` (SERVER_BUSY):
 * the web's 5xx bucket reads it as "temporarily unavailable — your evidence
 * data has not been changed", native and extension clients retry 5xx with
 * backoff. Nothing ran: the gate is the first request hook after CORS.
 *
 * Health and readiness probes are exempt (an orchestrator must still see the
 * process), and so are CORS preflights (answered by the CORS hook first).
 *
 * CANCELLATION NEVER LEAKS A SLOT. The count is released exactly once, on the
 * response's `close` (emitted after the response finished OR when the client
 * went away first). A handler still running after its client left keeps its
 * pooled connection until it returns; the pool wait itself is bounded by
 * DATABASE_POOL_CONNECTION_TIMEOUT_MS (db.ts).
 *
 * Long uploads are not affected: evidence bytes go from the client to object
 * storage on presigned URLs, never through this process (request bodies here
 * are capped at Fastify's 1 MiB default or smaller per route).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { markBoundedOutcome } from "../http/bounded-outcome.js";

export type OverloadGateSettings = {
  maxInFlight: number;
  maxEventLoopDelayMs: number;
  retryAfterSeconds: number;
  sampleIntervalMs: number;
  /**
   * PRO-S1-05 — how long a READ (GET/HEAD) may run before it is answered
   * 503 SERVER_BUSY + Retry-After, if it has not started its response. Each
   * pool acquisition waits up to its own bound, so a request making several
   * sequential reads under saturation could linger for N x that bound. Writes
   * are never cut (a later commit must not follow a "busy" answer), and a
   * response that has started streaming is never cut. 0 disables.
   */
  readDeadlineMs?: number;
};

export const DEFAULT_API_MAX_IN_FLIGHT = 512;
export const DEFAULT_API_MAX_EVENT_LOOP_DELAY_MS = 1_000;
export const DEFAULT_API_OVERLOAD_RETRY_AFTER_SECONDS = 2;
export const DEFAULT_API_READ_DEADLINE_MS = 45_000;
const SAMPLE_INTERVAL_MS = 500;

function setting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** A bad value stops the process (like DATABASE_POOL_MAX) rather than guessing. */
export function readOverloadGateSettings(env: NodeJS.ProcessEnv = process.env): OverloadGateSettings {
  return {
    maxInFlight: setting(env, "API_MAX_IN_FLIGHT", DEFAULT_API_MAX_IN_FLIGHT, 0, 100_000),
    // On by default in production only: a test or development process that
    // pauses for a module transform or a debugger must not start shedding.
    maxEventLoopDelayMs: setting(
      env,
      "API_MAX_EVENT_LOOP_DELAY_MS",
      env.NODE_ENV === "production" ? DEFAULT_API_MAX_EVENT_LOOP_DELAY_MS : 0,
      0,
      60_000,
    ),
    retryAfterSeconds: setting(env, "API_OVERLOAD_RETRY_AFTER_SECONDS", DEFAULT_API_OVERLOAD_RETRY_AFTER_SECONDS, 1, 300),
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    readDeadlineMs: setting(env, "API_READ_DEADLINE_MS", DEFAULT_API_READ_DEADLINE_MS, 0, 3_600_000),
  };
}

/**
 * Probes the orchestrator and the proxy use; never shed.
 *
 * B8-F-001 — and sign-out. An overloaded API must never refuse the request
 * that ENDS a session: the gate answered 503 SERVER_BUSY before the route could
 * revoke it, so a person who signed out on a shared device during load left a
 * live 30-day session behind. Logout is one bounded write.
 */
const EXEMPT_PATHS = new Set([
  "/healthz",
  "/readyz",
  "/health",
  "/metrics",
  "/v1/auth/logout",
]);

function isExempt(req: FastifyRequest): boolean {
  if (req.method === "OPTIONS") return true;
  const path = (req.raw.url ?? "").split("?")[0] ?? "";
  return EXEMPT_PATHS.has(path);
}

/**
 * Request timeouts handed to Fastify (F-08).
 *
 * `requestTimeout` bounds RECEIVING a request (headers + body) — a slow or
 * stalled sender gets 408 instead of holding a socket for ever. Fastify's own
 * default is 0 (no limit, which also disables Node's 300 s default). It does
 * not bound how long a handler may run or how long a response may stream, so
 * a long completion or an export download is not cut. The socket-idle
 * `connectionTimeout` stays at Fastify's 0: a completion that hashes a large
 * object sends nothing until it is done, and an idle bound would cut it.
 *
 *   API_REQUEST_TIMEOUT_MS  60000 (0 = no limit)
 *   API_KEEP_ALIVE_TIMEOUT_MS  Fastify's 72000 unless set (keep it above the
 *                              proxy's upstream idle timeout)
 */
export function readServerTimeouts(env: NodeJS.ProcessEnv = process.env): {
  requestTimeout: number;
  keepAliveTimeout: number;
} {
  return {
    requestTimeout: setting(env, "API_REQUEST_TIMEOUT_MS", 60_000, 0, 3_600_000),
    keepAliveTimeout: setting(env, "API_KEEP_ALIVE_TIMEOUT_MS", 72_000, 1_000, 3_600_000),
  };
}

/**
 * pg-pool refused to hand out a connection within
 * DATABASE_POOL_CONNECTION_TIMEOUT_MS. Matched on pg-pool's own message (and
 * any cause), because Prisma passes it through its driver-adapter error.
 */
export function isDatabasePoolTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const message = String((e as { message?: unknown }).message ?? "");
    if (/timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(message)) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * THE overload refusal (the gate, a pool-wait timeout, the auth middleware's
 * revocation read): 503 + Retry-After, nested `error.code` SERVER_BUSY,
 * declared a bounded OPERATIONAL_WARNING so the response hook logs a warning
 * and an operational signal rather than paging a crash per refused request.
 */
export function sendServerBusy(
  req: FastifyRequest,
  reply: FastifyReply,
  input: { retryAfterSeconds?: number; nothingRan?: boolean } = {},
): FastifyReply {
  markBoundedOutcome(req, { code: "SERVER_BUSY", reportability: "OPERATIONAL_WARNING", severity: "warning" });
  return reply
    .code(503)
    .header("Retry-After", String(input.retryAfterSeconds ?? DEFAULT_API_OVERLOAD_RETRY_AFTER_SECONDS))
    .send({
      error: {
        code: "SERVER_BUSY",
        message: input.nothingRan
          ? "The service is busy right now. Nothing was changed; try again in a moment."
          : "The service is busy right now; try again in a moment.",
        requestId: typeof req.id === "string" ? req.id : null,
      },
    });
}

export type OverloadGateHandle = {
  stats(): { inFlight: number; refused: number; eventLoopDelayMs: number; deadlineRefused: number };
};

export function installOverloadGate(
  app: FastifyInstance,
  settings: OverloadGateSettings = readOverloadGateSettings(),
  deps: { eventLoopDelayMs?: () => number } = {},
): OverloadGateHandle {
  let inFlight = 0;
  let refused = 0;
  let delayMs = 0;
  let refusedThisWindow = 0;
  let deadlineRefused = 0;

  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (settings.maxEventLoopDelayMs > 0 && !deps.eventLoopDelayMs) {
    const resolution = 10;
    histogram = monitorEventLoopDelay({ resolution });
    histogram.enable();
    timer = setInterval(() => {
      const h = histogram!;
      delayMs = Number.isFinite(h.mean) ? Math.max(0, h.mean / 1e6 - resolution) : 0;
      h.reset();
      if (refusedThisWindow > 0) {
        app.log.warn({ refused: refusedThisWindow, inFlight, eventLoopDelayMs: Math.round(delayMs) }, "api.overload.refused");
        refusedThisWindow = 0;
      }
    }, settings.sampleIntervalMs);
    timer.unref?.();
  }
  const currentDelay = deps.eventLoopDelayMs ?? (() => delayMs);

  const refuse = (req: FastifyRequest, reply: FastifyReply, reason: "in_flight" | "event_loop_delay") => {
    refused += 1;
    refusedThisWindow += 1;
    if (!timer) req.log.warn({ reason, inFlight }, "api.overload.refused");
    return sendServerBusy(req, reply, { retryAfterSeconds: settings.retryAfterSeconds, nothingRan: true });
  };

  app.addHook("onRequest", async (req, reply) => {
    if (isExempt(req)) return;
    if (settings.maxInFlight > 0 && inFlight >= settings.maxInFlight) return refuse(req, reply, "in_flight");
    if (settings.maxEventLoopDelayMs > 0 && currentDelay() > settings.maxEventLoopDelayMs) {
      return refuse(req, reply, "event_loop_delay");
    }
    inFlight += 1;
    let released = false;
    // PRO-S1-05 — a read that has not answered by its deadline is refused
    // busy (nothing it reads is changed by refusing it).
    const readDeadlineMs = settings.readDeadlineMs ?? 0;
    const deadline =
      readDeadlineMs > 0 && (req.method === "GET" || req.method === "HEAD")
        ? setTimeout(() => {
            if (reply.sent || reply.raw.headersSent) return;
            deadlineRefused += 1;
            req.log.warn({ deadlineMs: readDeadlineMs }, "api.overload.read_deadline");
            void sendServerBusy(req, reply, { retryAfterSeconds: settings.retryAfterSeconds });
          }, readDeadlineMs)
        : null;
    deadline?.unref?.();
    reply.raw.once("close", () => {
      if (deadline) clearTimeout(deadline);
      if (released) return;
      released = true;
      inFlight -= 1;
    });
  });

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    histogram?.disable();
  });

  return {
    stats: () => ({ inFlight, refused, eventLoopDelayMs: currentDelay(), deadlineRefused }),
  };
}

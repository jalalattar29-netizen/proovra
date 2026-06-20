import { NextResponse } from "next/server";
import { type ZodSchema, type ZodError } from "zod";

/**
 * Shared lifecycle for the two public marketing lead routes
 * (`/api/request-demo` and `/api/contact-sales`).
 *
 * Goals:
 *   - Validate payload server-side with zod (return 400, not 403, for bad input).
 *   - Reject obviously hostile origins (same-origin guard) without blocking
 *     production/staging/dev/preview hosts.
 *   - Silently absorb honeypot hits so bots don't get useful feedback.
 *   - In-memory IP rate-limit per route (5 per 5 min) returning 429.
 *   - Try to forward to the upstream API if `API_BASE_URL` /
 *     `NEXT_PUBLIC_API_BASE` is set. If upstream is unreachable, returns
 *     non-2xx, or is unconfigured, log the lead to stdout and return 200
 *     so the marketing form still confirms submission to the visitor.
 *     Leads are never silently lost — they always land in server logs.
 */

export type LeadIntent = "request_demo" | "contact_sales";

export type LeadRouteConfig<TInput> = {
  intent: LeadIntent;
  sourcePage: "request-demo" | "contact-sales";
  schema: ZodSchema<TInput>;
  honeypotField: keyof TInput & string;
  upstreamPath: string; // e.g. "/v1/demo-requests"
  upstreamHeaderSource: string; // e.g. "x-demo-source"
  successMessage: string;
  upstreamMessageFallback: string;
};

type RateLimitBucket = { count: number; resetAt: number };
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateBuckets = new Map<string, RateLimitBucket>();

const ALLOWED_HOST_SUFFIXES = [
  "proovra.com",
  "vercel.app",
  "localhost",
  "127.0.0.1",
];

function readApiBase(): string {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE ??
    process.env.API_BASE_URL ??
    "http://localhost:8081";
  return apiBase.replace(/\/+$/, "");
}

function jsonError(message: string, status: number, extras?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, error: { message, ...(extras ?? {}) } },
    { status }
  );
}

function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const cf = req.headers.get("cf-connecting-ip") ?? "";
  const ip = (fwd.split(",")[0] || cf || "unknown").trim();
  return ip || "unknown";
}

function hostFromHeader(rawHost: string | null | undefined): string | null {
  if (!rawHost) return null;
  try {
    const url = rawHost.startsWith("http")
      ? new URL(rawHost)
      : new URL(`https://${rawHost}`);
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`) || host.startsWith(`${suffix}:`) || host === suffix
  );
}

function isSameOrSafeOrigin(req: Request): boolean {
  const host = req.headers.get("host")?.toLowerCase() ?? "";
  if (host && isAllowedHost(host.replace(/:\d+$/, ""))) return true;

  const origin = hostFromHeader(req.headers.get("origin"));
  if (origin && isAllowedHost(origin.replace(/:\d+$/, ""))) return true;

  const referer = hostFromHeader(req.headers.get("referer"));
  if (referer && isAllowedHost(referer.replace(/:\d+$/, ""))) return true;

  // No host header at all → likely an internal/server-to-server probe. Allow.
  if (!host && !origin && !referer) return true;

  return false;
}

function rateLimitKey(intent: LeadIntent, ip: string): string {
  return `${intent}:${ip}`;
}

function checkRateLimit(intent: LeadIntent, ip: string): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  const now = Date.now();
  const key = rateLimitKey(intent, ip);
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { allowed: true };
}

const FIELD_ALIASES: Record<string, string> = {
  expectedDeploymentTimeline: "deploymentTimeline",
  additionalContext: "message",
};

function normalizeRawPayload(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = FIELD_ALIASES[rawKey] ?? rawKey;
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (trimmed === "") continue;
      if (out[key] === undefined) out[key] = trimmed;
      continue;
    }
    if (out[key] === undefined) out[key] = rawValue;
  }
  return out;
}

function formatZodIssues(err: ZodError): { field: string; message: string }[] {
  return err.issues.map((i) => ({
    field: i.path.map(String).join(".") || "(root)",
    message: i.message,
  }));
}

function logLead(args: {
  intent: LeadIntent;
  sourcePage: string;
  payload: unknown;
  ip: string;
  userAgent: string;
  referer: string;
  upstreamStatus: number | "skipped" | "error";
  upstreamMessage?: string;
}) {
  // Structured one-line JSON log so it's easy to grep / forward to a log
  // sink. Avoid logging the full free-text fields verbatim if they're long.
  try {
    const safe = JSON.stringify({
      tag: "marketing_lead",
      intent: args.intent,
      sourcePage: args.sourcePage,
      ip: args.ip,
      userAgent: args.userAgent.slice(0, 200),
      referer: args.referer.slice(0, 300),
      upstreamStatus: args.upstreamStatus,
      upstreamMessage: args.upstreamMessage?.slice(0, 200),
      payloadKeys: Object.keys(
        (args.payload as Record<string, unknown>) ?? {}
      ),
    });
    console.warn(safe);
  } catch {
    // Logging should never throw.
  }
}

export async function handleLeadSubmission<TInput extends Record<string, unknown>>(
  req: Request,
  config: LeadRouteConfig<TInput>
) {
  if (!isSameOrSafeOrigin(req)) {
    return jsonError("Origin not allowed.", 403);
  }

  const ip = getClientIp(req);
  const rate = checkRateLimit(config.intent, ip);
  if (!rate.allowed) {
    return new NextResponse(
      JSON.stringify({
        ok: false,
        error: { message: "Too many submissions. Please try again shortly." },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(rate.retryAfterSec ?? 60),
        },
      }
    );
  }

  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    return jsonError("Invalid request payload.", 400);
  }

  if (!raw || typeof raw !== "object") {
    return jsonError("Invalid request payload.", 400);
  }

  const normalized = normalizeRawPayload(raw as Record<string, unknown>);
  const parsed = config.schema.safeParse(normalized);
  if (!parsed.success) {
    return jsonError("Validation failed.", 400, {
      issues: formatZodIssues(parsed.error),
    });
  }

  const validated = parsed.data;

  // Honeypot: if the hidden field is filled, pretend success so bots don't
  // learn the heuristic. Never log payload content beyond keys.
  const honeyValue = (validated as Record<string, unknown>)[config.honeypotField];
  if (typeof honeyValue === "string" && honeyValue.trim().length > 0) {
    return NextResponse.json(
      { ok: true, message: config.successMessage },
      { status: 200 }
    );
  }

  const userAgent = req.headers.get("user-agent") ?? "";
  const referer = req.headers.get("referer") ?? "";
  const apiBase = readApiBase();
  const upstreamConfigured = Boolean(
    process.env.NEXT_PUBLIC_API_BASE || process.env.API_BASE_URL
  );

  // Canonical public origin we identify as to upstream. Cloudflare in front
  // of api.proovra.com fingerprints bot traffic from data-center egress IPs
  // (Vercel functions). Forwarding a canonical Origin + Referer + visitor IP
  // gives the WAF a stable signature it can allowlist instead of guessing.
  const webBase = (
    process.env.NEXT_PUBLIC_WEB_BASE ?? "https://www.proovra.com"
  ).replace(/\/+$/, "");
  const forwardingKey = process.env.CONTACT_SALES_FORWARDING_KEY?.trim() || "";

  const upstreamPayload = {
    ...validated,
    intent: config.intent,
    sourcePage: config.sourcePage,
    submittedAt: new Date().toISOString(),
    referrer:
      typeof (validated as Record<string, unknown>).referrer === "string" &&
      ((validated as Record<string, unknown>).referrer as string).trim()
        ? (validated as Record<string, unknown>).referrer
        : referer || null,
  };

  if (!upstreamConfigured) {
    // Local/dev or unconfigured prod: log + return success.
    logLead({
      intent: config.intent,
      sourcePage: config.sourcePage,
      payload: upstreamPayload,
      ip,
      userAgent,
      referer,
      upstreamStatus: "skipped",
      upstreamMessage: "upstream API base not configured",
    });
    return NextResponse.json(
      { ok: true, message: config.successMessage },
      { status: 200 }
    );
  }

  // Build outbound headers. Keep PII out of header values — only
  // visitor IP (already in `x-forwarded-for` semantics) and standard
  // forwarding hints.
  const outboundHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": userAgent || "proovra-web-proxy",
    "x-forwarded-for": ip,
    "x-forwarded-host": "www.proovra.com",
    "x-forwarded-proto": "https",
    "cf-connecting-ip": ip,
    origin: webBase,
    referer: `${webBase}/${config.sourcePage}`,
    "x-web-client": "proovra-web-proxy",
    [config.upstreamHeaderSource]: "website",
  };
  if (forwardingKey) {
    outboundHeaders["x-internal-key"] = forwardingKey;
  }

  try {
    const upstream = await fetch(`${apiBase}${config.upstreamPath}`, {
      method: "POST",
      headers: outboundHeaders,
      body: JSON.stringify(upstreamPayload),
      cache: "no-store",
    });

    const text = await upstream.text();
    let parsedUpstream: unknown = null;
    try {
      parsedUpstream = text ? JSON.parse(text) : null;
    } catch {
      parsedUpstream = null;
    }

    if (!upstream.ok) {
      // Upstream rejected. We have no fallback capture for this
      // intent — both /v1/demo-requests and /v1/contact-sales persist
      // server-side, so any non-2xx here means the lead was NOT
      // saved. Previously the handler returned 200 + degraded:true
      // and the visitor saw fake success. That masked total lead
      // loss for /v1/contact-sales when the route didn't exist.
      //
      // New behaviour: emit a high-signal alert log line ops can
      // page on, log the structured `marketing_lead` line (keys
      // only — no payload values), and return 502 so the form shows
      // a real error message and the visitor can retry.
      logLead({
        intent: config.intent,
        sourcePage: config.sourcePage,
        payload: upstreamPayload,
        ip,
        userAgent,
        referer,
        upstreamStatus: upstream.status,
        upstreamMessage:
          typeof parsedUpstream === "object" && parsedUpstream !== null
            ? JSON.stringify(parsedUpstream).slice(0, 200)
            : text.slice(0, 200),
      });
      try {
        // High-signal alert log line (always emitted on non-2xx).
        console.error(
          JSON.stringify({
            tag: "marketing_lead_alert",
            endpoint: config.upstreamPath,
            intent: config.intent,
            sourcePage: config.sourcePage,
            upstreamStatus: upstream.status,
            timestamp: new Date().toISOString(),
          })
        );

        // 403 diagnostic: when the upstream returns 403 we need enough
        // signal to distinguish Cloudflare WAF / Bot Fight Mode (cf-ray
        // present, "cloudflare" Server, "challenge" / "blocked" body)
        // from an API-layer rejection. Never log payload values — only
        // header KEYS we sent, response header values for CF triage, and
        // a body excerpt of the upstream's response (the block page, not
        // anything we sent).
        if (upstream.status === 403) {
          const respHeaders: Record<string, string> = {};
          ["server", "cf-ray", "cf-mitigated", "cf-cache-status",
            "content-type", "x-frame-options", "set-cookie"].forEach((k) => {
            const v = upstream.headers.get(k);
            if (v) respHeaders[k] = k === "set-cookie" ? "[present]" : v;
          });
          console.error(
            JSON.stringify({
              tag: "marketing_lead_403_diag",
              endpoint: config.upstreamPath,
              upstreamUrl: `${apiBase}${config.upstreamPath}`,
              intent: config.intent,
              sourcePage: config.sourcePage,
              requestHeaderKeys: Object.keys(outboundHeaders),
              responseHeaders: respHeaders,
              responseBodyExcerpt: text.slice(0, 500),
              timestamp: new Date().toISOString(),
            })
          );
        }
      } catch {
        // Logging must never throw.
      }
      return jsonError(
        "We couldn't deliver your submission to our team. Please try again in a moment.",
        502,
        { upstreamStatus: upstream.status }
      );
    }

    logLead({
      intent: config.intent,
      sourcePage: config.sourcePage,
      payload: upstreamPayload,
      ip,
      userAgent,
      referer,
      upstreamStatus: upstream.status,
    });

    return NextResponse.json(
      parsedUpstream && typeof parsedUpstream === "object"
        ? { ok: true, message: config.successMessage, ...parsedUpstream }
        : { ok: true, message: config.successMessage },
      { status: 200 }
    );
  } catch (err) {
    // Network / timeout / DNS issue with upstream. Same reasoning as
    // the non-2xx branch above: no fallback persistence on the web
    // layer, so we must NOT pretend success.
    logLead({
      intent: config.intent,
      sourcePage: config.sourcePage,
      payload: upstreamPayload,
      ip,
      userAgent,
      referer,
      upstreamStatus: "error",
      upstreamMessage: err instanceof Error ? err.message : String(err),
    });
    try {
      console.error(
        JSON.stringify({
          tag: "marketing_lead_alert",
          endpoint: config.upstreamPath,
          intent: config.intent,
          sourcePage: config.sourcePage,
          upstreamStatus: "network_error",
          timestamp: new Date().toISOString(),
        })
      );
    } catch {
      // ignore
    }
    return jsonError(
      "We couldn't reach our submission service. Please try again in a moment.",
      502,
      { upstreamStatus: "network_error" }
    );
  }
}

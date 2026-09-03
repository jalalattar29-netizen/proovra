/**
 * Phase A3 — Backend hardening, contract suite.
 *
 * Source-contract style (same as A0 / A1 / A2). Six contracts:
 *
 *   1. Shared bounded vocabularies are exported.
 *
 *   2. Metric counters are registered.
 *
 *   3. Analytics route uses the shared allowlist, rate-limits per
 *      IP and per visitor, validates payloads strictly, emits the
 *      SecurityEvent on rejection.
 *
 *   4. AI chat route applies per-user + per-IP rate limits BEFORE
 *      the cost guard, bounds upstream timeout, emits abuse
 *      signals — never lets AI become an operational dependency
 *      for capture / report / verify.
 *
 *   5. Webhook signature failures emit the structured
 *      `webhook_signature_failure` SecurityEvent via the wrapper.
 *
 *   6. Public verify route appends a debounced VERIFY_VIEWED
 *      custody event with a bounded payload that contains no IP,
 *      no user-agent, no fingerprinting.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_LIMITS,
  ANALYTICS_REJECTION_REASONS,
  AI_CHAT_ABUSE_REASONS,
  AI_CHAT_LIMITS,
  SECURITY_EVENT_TYPES,
  VERIFY_VIEWED_LIMITS,
  WEBHOOK_PROVIDERS,
  WEBHOOK_SIGNATURE_FAILURE_REASONS,
} from "@proovra/shared";

import { classifyEventClass } from "../src/services/analytics-event.service.js";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const ANALYTICS_ROUTES = readSource("../src/routes/analytics.routes.ts");
const EVENT_LABELS_SOURCE = readSource(
  "../src/services/analytics-event.service.ts",
);
const AI_ROUTES = readSource("../src/routes/ai.routes.ts");
const WEBHOOK_ROUTES = readSource("../src/routes/webhooks.routes.ts");
const WEBHOOK_AUDIT = readSource(
  "../src/services/security/webhook-signature-audit.service.ts",
);
const EVIDENCE_ROUTES = readSource("../src/routes/evidence.routes.ts");
const METRICS_SERVICE = readSource(
  "../../../packages/shared-runtime/src/ops/metrics.service.ts",
);

describe("Phase A3 — shared bounded vocabularies", () => {
  it("exports the analytics ingest allowlist", () => {
    // The list is asserted EXACTLY, not by `toContain`. It is the set of
    // claims an untrusted browser may make about itself, so it should be
    // impossible to widen without a test saying so out loud.
    expect(ANALYTICS_EVENT_NAMES).toEqual(["page_view"]);
  });

  it("names only events the persistence layer can classify", () => {
    // The previous allowlist held eight UPPER_SNAKE_CASE names that nothing
    // emitted and nothing understood: the classifiers key on lower_snake_case,
    // so those rows would have persisted as class "custom" and been invisible
    // to dashboards that filter on exact lowercase names. An allowlist entry
    // that cannot be classified is an entry that produces unreadable data.
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(name, `${name} must be lower_snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(
        classifyEventClass(name),
        `${name} must classify to a real event class, not the "custom" fallback`,
      ).not.toBe("custom");
      expect(EVENT_LABELS_SOURCE).toContain(`${name}:`);
    }
  });

  it("exports analytics rejection reason categories", () => {
    expect(ANALYTICS_REJECTION_REASONS).toContain("invalid_event_name");
    expect(ANALYTICS_REJECTION_REASONS).toContain("rate_limited_ip");
    expect(ANALYTICS_REJECTION_REASONS).toContain("rate_limited_visitor");
    expect(ANALYTICS_REJECTION_REASONS).toContain("metadata_too_deep");
    expect(ANALYTICS_REJECTION_REASONS).toContain("payload_too_large");
  });

  it("exports tight analytics limits", () => {
    expect(ANALYTICS_LIMITS.MAX_BODY_BYTES).toBeLessThanOrEqual(8 * 1024);
    expect(ANALYTICS_LIMITS.MAX_METADATA_KEYS).toBeLessThanOrEqual(16);
    expect(ANALYTICS_LIMITS.MAX_METADATA_DEPTH).toBeLessThanOrEqual(3);
    expect(ANALYTICS_LIMITS.RATE_LIMIT_IP_PER_MIN).toBeGreaterThan(0);
    expect(ANALYTICS_LIMITS.RATE_LIMIT_VISITOR_PER_MIN).toBeGreaterThan(0);
  });

  it("exports AI chat abuse vocabulary + tight limits", () => {
    expect(AI_CHAT_ABUSE_REASONS).toContain("rate_limited_user");
    expect(AI_CHAT_ABUSE_REASONS).toContain("rate_limited_ip");
    expect(AI_CHAT_ABUSE_REASONS).toContain("timeout");
    expect(AI_CHAT_ABUSE_REASONS).toContain("cost_guard_exceeded");
    // The per-minute user cap must be small — single-digit territory.
    expect(AI_CHAT_LIMITS.RATE_LIMIT_USER_PER_MIN).toBeLessThanOrEqual(10);
    expect(AI_CHAT_LIMITS.REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("exports webhook provider + failure reason vocabularies", () => {
    expect(WEBHOOK_PROVIDERS).toEqual(["stripe", "paypal", "twilio"]);
    expect(WEBHOOK_SIGNATURE_FAILURE_REASONS).toContain("missing_signature");
    expect(WEBHOOK_SIGNATURE_FAILURE_REASONS).toContain("invalid_signature");
    expect(WEBHOOK_SIGNATURE_FAILURE_REASONS).toContain("replay_detected");
    expect(WEBHOOK_SIGNATURE_FAILURE_REASONS).toContain(
      "timestamp_out_of_range",
    );
  });

  it("exports the VERIFY_VIEWED debounce window (≥ 1 hour)", () => {
    expect(VERIFY_VIEWED_LIMITS.DEBOUNCE_WINDOW_MS).toBeGreaterThanOrEqual(
      60 * 60 * 1000,
    );
  });

  it("registers the new SecurityEvent types", () => {
    expect(SECURITY_EVENT_TYPES as readonly string[]).toContain(
      "webhook_signature_failure",
    );
    expect(SECURITY_EVENT_TYPES as readonly string[]).toContain(
      "analytics_request_rejected",
    );
    expect(SECURITY_EVENT_TYPES as readonly string[]).toContain(
      "ai_chat_abuse_signal",
    );
  });

  it("registers the new metric counters", () => {
    const counters = [
      "analytics_rejected_total",
      "analytics_rate_limited_total",
      "analytics_invalid_payload_total",
      "ai_chat_rate_limited_total",
      "ai_chat_rejected_total",
      "ai_chat_timeout_total",
      "webhook_signature_failures_total",
      "webhook_replay_rejections_total",
      "public_verify_viewed_emitted_total",
      "public_verify_viewed_debounced_total",
    ];
    for (const c of counters) {
      expect(METRICS_SERVICE).toContain(`"${c}"`);
    }
  });
});

describe("Phase A3 — analytics endpoint hardening", () => {
  it("imports the shared allowlist + limits + rate limiter", () => {
    expect(ANALYTICS_ROUTES).toContain('from "@proovra/shared"');
    expect(ANALYTICS_ROUTES).toContain("ANALYTICS_EVENT_NAMES");
    expect(ANALYTICS_ROUTES).toContain("ANALYTICS_LIMITS");
    expect(ANALYTICS_ROUTES).toContain("enforceRateLimit");
    expect(ANALYTICS_ROUTES).toContain("safeEmitSecurityEvent");
  });

  it("declares the AnalyticsTrackSchema using z.enum(ANALYTICS_EVENT_NAMES)", () => {
    expect(ANALYTICS_ROUTES).toMatch(
      /eventType:\s*z\.enum\(ANALYTICS_EVENT_NAMES\)/,
    );
    expect(ANALYTICS_ROUTES).toMatch(
      /AnalyticsTrackSchema\s*=\s*z[\s\S]*\.strict\(\)/,
    );
  });

  it("enforces the bodyLimit + dual rate limits in the handler", () => {
    expect(ANALYTICS_ROUTES).toContain("bodyLimit: ANALYTICS_LIMITS.MAX_BODY_BYTES");
    expect(ANALYTICS_ROUTES).toContain("ratelimit:analytics:ip:");
    expect(ANALYTICS_ROUTES).toContain("ratelimit:analytics:visitor:");
  });

  it("emits the bounded rejection metric + SecurityEvent", () => {
    expect(ANALYTICS_ROUTES).toContain('"analytics_request_rejected"');
    expect(ANALYTICS_ROUTES).toContain("bumpAnalyticsMetric");
    expect(ANALYTICS_ROUTES).toContain("emitAnalyticsRejection");
  });

  it("does NOT log the raw payload on rejection or write failure", () => {
    // Bounded log: only `err.message` (sliced) and `code`. Never the
    // body or metadata.
    const trackBlock = ANALYTICS_ROUTES.slice(
      ANALYTICS_ROUTES.indexOf('"/v1/analytics/track"'),
      ANALYTICS_ROUTES.indexOf("app.get(") > 0
        ? ANALYTICS_ROUTES.indexOf("app.get(")
        : ANALYTICS_ROUTES.length,
    );
    expect(trackBlock).not.toMatch(/\.body[^,})]*\}\s*,\s*"analytics/);
    expect(trackBlock).toContain("message.slice(0, 200)");
  });
});

describe("Phase A3 — AI chat hardening", () => {
  it("imports the shared limits + rate limiter + security emitter", () => {
    expect(AI_ROUTES).toContain("AI_CHAT_LIMITS");
    expect(AI_ROUTES).toContain("enforceRateLimit");
    expect(AI_ROUTES).toContain("safeEmitSecurityEvent");
  });

  it("rate-limits per user BEFORE the cost guard runs", () => {
    const chatStart = AI_ROUTES.indexOf('"/v1/ai/chat"');
    expect(chatStart).toBeGreaterThan(0);
    /*
     * Bounded by the NEXT ROUTE, not by a byte count.
     *
     * This used to slice a fixed 5,000 characters and search inside it, so the
     * assertion measured how far apart two strings sat in the source file.
     * Adding a comment to the handler moved the second one past the window and
     * failed the test without changing a line of behaviour — while a genuine
     * reordering that kept both within 5,000 characters would have passed.
     *
     * The invariant is that the rate limit comes first WITHIN THIS HANDLER, so
     * the handler is what the slice should be.
     */
    const nextRoute = AI_ROUTES.indexOf('"/v1/ai/capture/analyze-session"', chatStart);
    expect(nextRoute).toBeGreaterThan(chatStart);
    const handlerSlice = AI_ROUTES.slice(chatStart, nextRoute);

    const userRateIdx = handlerSlice.indexOf("ratelimit:ai-chat:user:");
    const analyzeIdx = handlerSlice.indexOf("aiChatService.analyzeChat");
    expect(userRateIdx).toBeGreaterThan(0);
    expect(analyzeIdx).toBeGreaterThan(0);
    expect(userRateIdx).toBeLessThan(analyzeIdx);
  });

  it("rate-limits per IP as well", () => {
    expect(AI_ROUTES).toContain("ratelimit:ai-chat:ip:");
  });

  it("wraps the upstream analyzeChat call in a bounded timeout", () => {
    expect(AI_ROUTES).toContain("withAiTimeout");
    expect(AI_ROUTES).toContain("AI_REQUEST_TIMEOUT");
    expect(AI_ROUTES).toContain("AI_CHAT_LIMITS.REQUEST_TIMEOUT_MS");
  });

  it("translates a timeout into a typed 504 — never lets AI block other workflows", () => {
    expect(AI_ROUTES).toMatch(/reply\.code\(504\)[\s\S]*AI_CHAT_TIMEOUT/);
    expect(AI_ROUTES).toContain("Evidence workflows are unaffected");
  });

  it("emits ai_chat_abuse_signal on each abuse path", () => {
    expect(AI_ROUTES).toContain('"ai_chat_abuse_signal"');
    expect(AI_ROUTES).toContain('"rate_limited_user"');
    expect(AI_ROUTES).toContain('"rate_limited_ip"');
    expect(AI_ROUTES).toContain('"timeout"');
    expect(AI_ROUTES).toContain('"cost_guard_exceeded"');
  });

  it("does NOT log the prompt text", () => {
    // Prompt content (the `content` field on each message) must
    // never appear in a logger.info / logger.warn call. We assert
    // negatively against the conventional patterns.
    const chatStart = AI_ROUTES.indexOf('"/v1/ai/chat"');
    const handlerSlice = AI_ROUTES.slice(chatStart, chatStart + 8_000);
    expect(handlerSlice).not.toMatch(/log\.\w+\([\s\S]*messages\[0\]\.content/);
    expect(handlerSlice).not.toMatch(/log\.\w+\([\s\S]*body\.messages/);
  });
});

describe("Phase A3 — webhook signature audit", () => {
  it("exports a wrapper that emits webhook_signature_failure", () => {
    expect(WEBHOOK_AUDIT).toContain("auditWebhookSignatureVerification");
    expect(WEBHOOK_AUDIT).toContain('"webhook_signature_failure"');
    expect(WEBHOOK_AUDIT).toContain("safeEmitSecurityEvent");
  });

  it("classifies the bounded set of failure reasons", () => {
    for (const reason of WEBHOOK_SIGNATURE_FAILURE_REASONS) {
      expect(WEBHOOK_AUDIT).toContain(`"${reason}"`);
    }
  });

  it("never logs the secret, raw signature, or full payload", () => {
    const banned = [
      /STRIPE_WEBHOOK_SECRET/,
      /PAYPAL_WEBHOOK/,
      /rawBody/,
      /secret\s*:\s*secret/,
    ];
    for (const re of banned) {
      expect(WEBHOOK_AUDIT).not.toMatch(re);
    }
  });

  it("Stripe + PayPal webhook handlers use the audit wrapper", () => {
    expect(WEBHOOK_ROUTES).toContain("auditWebhookSignatureVerification");
    // Both handlers wire it up.
    expect(WEBHOOK_ROUTES).toMatch(/provider:\s*"stripe"/);
    expect(WEBHOOK_ROUTES).toMatch(/provider:\s*"paypal"/);
  });

  it("Stripe handler short-circuits with 400 on signature failure", () => {
    const stripeStart = WEBHOOK_ROUTES.indexOf('app.post("/stripe"');
    expect(stripeStart).toBeGreaterThan(0);
    const slice = WEBHOOK_ROUTES.slice(stripeStart, stripeStart + 2_500);
    expect(slice).toMatch(/sigCheck\.ok/);
    expect(slice).toMatch(/reply\.code\(400\)/);
  });
});

describe("Phase A3 — VERIFY_VIEWED debounced custody event", () => {
  it("appends VERIFY_VIEWED on the public verify success path", () => {
    expect(EVIDENCE_ROUTES).toContain(
      "CustodyEventType.VERIFY_VIEWED",
    );
    expect(EVIDENCE_ROUTES).toContain('"public_verify_page"');
  });

  it("debounces to ≤ 1 event per 24 hours", () => {
    // The bounded window literal lives in the handler so the
    // operator can audit it from a single grep.
    expect(EVIDENCE_ROUTES).toMatch(
      /debounceMs\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
    expect(EVIDENCE_ROUTES).toContain("shouldEmitVerifyViewed");
  });

  it("bumps the right metric per branch", () => {
    expect(EVIDENCE_ROUTES).toContain("public_verify_viewed_emitted_total");
    expect(EVIDENCE_ROUTES).toContain("public_verify_viewed_debounced_total");
  });

  it("payload carries the bounded fields ONLY — no IP, no user agent", () => {
    // Scope to the appendCustodyEvent call site in the verify
    // handler — not the unrelated event-label renderer earlier in
    // the file.
    const handlerStart = EVIDENCE_ROUTES.indexOf(
      'app.get("/public/verify/:id"',
    );
    expect(handlerStart).toBeGreaterThan(0);
    const handlerSlice = EVIDENCE_ROUTES.slice(handlerStart);
    const appendIdx = handlerSlice.indexOf(
      "CustodyEventType.VERIFY_VIEWED",
    );
    expect(appendIdx).toBeGreaterThan(0);
    const payloadSlice = handlerSlice.slice(appendIdx, appendIdx + 1_500);
    expect(payloadSlice).toContain('visibility: "public_verify"');
    expect(payloadSlice).toMatch(/viewerType:[\s\S]{0,80}"anonymous"/);
    expect(payloadSlice).toContain('source: "public_verify_page"');
    // No fingerprinting — the payload object literal must not
    // carry ip / user-agent fields.
    expect(payloadSlice).not.toMatch(/payload:\s*\{[\s\S]*?ipAddress:/);
    expect(payloadSlice).not.toMatch(/payload:\s*\{[\s\S]*?userAgent:/);
  });

  it("custody append never breaks the verify response", () => {
    // The append must live inside the existing fire-and-forget IIFE
    // and its own try/catch. We assert the `public_verify.custody_append_failed`
    // bounded log line is present.
    expect(EVIDENCE_ROUTES).toContain(
      "public_verify.custody_append_failed",
    );
  });
});

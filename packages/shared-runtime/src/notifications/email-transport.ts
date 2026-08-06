/**
 * PHASE 12 — POINT 5: the CANONICAL email transport authority.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Before this module the repository had THREE independent email transport
 * policy engines, each with its own answer to "did that send happen?":
 *
 *   1. `services/api/.../email.service.ts` — `resendSingleton`, reached through
 *      `sendCustomEmailViaResend`, returning a typed ok/error result;
 *   2. the same file's `getEmailService()` singleton, which constructed a
 *      SECOND provider SDK client and returned its raw promise, so its callers
 *      saw provider errors as resolved promises carrying an `error` field;
 *   3. `services/worker/src/mfa-recovery-digest.ts` — a raw `fetch` to
 *      `https://api.resend.com/emails` that threw on non-2xx.
 *
 * Three engines meant three retry classifications, three timeout behaviours
 * (two of them: none), and — the reason this matters for POINT 5 — no
 * idempotency key anywhere. A retry after an ambiguous outcome was a blind
 * resend, so every send path that retried could deliver twice.
 *
 * This module is now the only place that talks to the provider. It owns:
 *
 *   * provider authentication      — the key resolver and the Bearer header;
 *   * the idempotency key          — required, caller-derived, sent verbatim;
 *   * the timeout                  — bounded, explicit, abortable;
 *   * retry classification         — one table, five outcomes;
 *   * acknowledgement projection   — provider message id extraction;
 *   * bounded error handling       — no throw crosses this boundary;
 *   * PII-safe diagnostics         — recipients, subjects and bodies are never
 *                                    returned in, or attached to, an outcome.
 *
 * WHY RAW `fetch` AND NOT THE SDK
 * ---------------------------------------------------------------------------
 * `services/worker` must be able to use this. The provider SDK is an API-only
 * dependency, and adding it to a shared package to satisfy one worker sweep
 * would put an HTTP client in the dependency tree of every consumer. The send
 * endpoint is one POST; the SDK adds nothing this module needs and removes the
 * one thing it does need, which is control over the request headers (the SDK
 * had no idempotency-key surface at the pinned version).
 *
 * WHAT THIS MODULE IS NOT
 * ---------------------------------------------------------------------------
 * It is NOT the durable delivery-attempt authority. It has no database access
 * and no memory: it performs one attempt and reports one outcome. Deciding
 * whether an attempt may be made, recording that it was made, and deciding
 * what an ambiguous outcome means for the caller's state machine all belong to
 * the caller's durable authority — for the MFA recovery digest that is
 * `NotificationDelivery`, whose lifecycle is the subject of the POINT 5
 * notification crash-window proofs.
 */

// ===========================================================================
// Outcome
// ===========================================================================

/**
 * The five honest answers to "what happened to that message?".
 *
 * There is deliberately no boolean. `ambiguous` is a first-class outcome
 * because it is the true state after a timeout or a dropped connection, and
 * collapsing it into either `acknowledged` or `retryable` is exactly how a
 * system acquires a false delivered state or a duplicate send.
 */
export type EmailDeliveryOutcome =
  /** The provider accepted the message and named it. Durably known. */
  | {
      kind: "acknowledged";
      providerMessageId: string | null;
      httpStatus: number;
    }
  /** No API key is configured. Structural: retrying changes nothing. */
  | { kind: "not_configured" }
  /**
   * The provider refused, and refused in a way that says "not now".
   * Safe to retry — with the SAME idempotency key.
   */
  | { kind: "retryable"; errorCode: string; httpStatus: number | null }
  /**
   * The provider refused, and refused in a way that says "not ever" for this
   * message as written. Retrying the identical message cannot succeed.
   */
  | { kind: "permanent"; errorCode: string; httpStatus: number }
  /**
   * The request left this process and no answer came back — a timeout, a
   * dropped socket, an unparseable response. The message MAY have been
   * accepted.
   *
   * This is never a delivered state and never a "failed" state. The caller
   * must retry with the same idempotency key (the provider then collapses the
   * duplicate) or reconcile, and must represent the intervening state as
   * unknown rather than as either outcome.
   */
  | { kind: "ambiguous"; errorCode: string };

export type EmailDeliveryRequest = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Deterministically derived from the caller's DURABLE delivery intent —
   * never generated at call time, and never regenerated on retry.
   *
   * Required, not optional. An optional idempotency key is one that some
   * caller will omit, and the caller that omits it is the one whose retry
   * sends twice.
   */
  idempotencyKey: string;
  /** Bounded per-attempt timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Bounded, OPTIONAL attribution. Never sent on the wire to a real provider —
   * it exists so a local recording provider can say which durable intent and
   * which template a stored message belongs to, instead of a test having to
   * infer it from a subject line.
   */
  meta?: {
    deliveryIntentId?: string | null;
    templateKind?: string | null;
  };
};

/** One attempt may take this long before it becomes an ambiguous outcome. */
export const DEFAULT_TIMEOUT_MS = 15_000;

const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";

// ===========================================================================
// Provider selection
// ===========================================================================

/**
 * WHICH provider this process sends through.
 *
 * PHASE 12 — POINT 7 (final pass). Before this, there was one provider and the
 * only way to keep a test off the network was to leave the API key unset —
 * which turns every send into `not_configured` and removes the delivery state
 * machine from the run instead of exercising it. So local runs configured a
 * fake key, and the transport dutifully tried to reach `api.resend.com`. The
 * outbound guard blocked it, and eighteen browser-run attempts sat in the
 * ledger as evidence that the email boundary was never proven.
 *
 * Selection is EXPLICIT and environment-driven:
 *
 *   production → `resend`   (the default; nothing about deployed behaviour
 *                            changes unless an operator says otherwise)
 *   staging    → whatever the staging environment configures, deliberately
 *   test / integration / browser → `recording`, set by the test bootstrap
 *                            BEFORE any application module is imported
 *
 * There is no scenario-name matching, no URL sniffing and no NODE_ENV
 * inference here. The environment names the provider; this function only reads
 * the name.
 */
export type EmailTransportProvider = "resend" | "recording";

export function resolveEmailTransportProvider(): EmailTransportProvider {
  const raw = (process.env["EMAIL_TRANSPORT"] ?? "").trim().toLowerCase();
  if (raw === "recording") return "recording";
  if (raw === "resend") return "resend";
  // Unset means the historical behaviour, so no deployment changes by omission.
  return "resend";
}

/**
 * Resend rejects idempotency keys longer than this, and a rejected key is
 * silently no idempotency at all. Callers derive keys from UUIDs and short
 * prefixes, so this bound is a guard rather than a routine truncation.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

// ===========================================================================
// Authentication
// ===========================================================================

type ApiKeyResolver = () => string | undefined;

let apiKeyResolver: ApiKeyResolver | null = null;

/**
 * Register the host's API-key source.
 *
 * `services/api` reads `RESEND_API_KEY` through its secret manager, which
 * `services/worker` does not have. Rather than fork the transport for that
 * one difference, the host registers HOW to obtain the key and the transport
 * keeps ownership of what to do with it. A host that registers nothing falls
 * back to the process environment, which is what the worker wants.
 */
export function registerEmailApiKeyResolver(resolver: ApiKeyResolver): void {
  apiKeyResolver = resolver;
}

/** Test seam: drop a registered resolver so a suite starts from the default. */
export function resetEmailApiKeyResolver(): void {
  apiKeyResolver = null;
}

function resolveApiKey(): string | undefined {
  if (apiKeyResolver) {
    const fromHost = apiKeyResolver();
    if (fromHost && fromHost.trim()) return fromHost.trim();
    return undefined;
  }
  const raw = process.env["RESEND_API_KEY"];
  return raw && raw.trim() ? raw.trim() : undefined;
}

/**
 * The canonical `From` header.
 *
 * One resolution order for every sender in the system. The worker previously
 * used `RESEND_FROM` and the API used `EMAIL_FROM`; both are honoured so no
 * deployment loses its configured sender, but the ORDER is now fixed here
 * instead of being decided independently in two files.
 */
export function canonicalEmailFrom(): string {
  const explicit = process.env["EMAIL_FROM"] ?? process.env["RESEND_FROM"];
  if (explicit && explicit.trim()) return explicit.trim();
  const name = process.env["EMAIL_FROM_NAME"]?.trim() || "Proovra";
  return `${name} <no-reply@proovra.com>`;
}

// ===========================================================================
// Classification
// ===========================================================================

/**
 * HTTP status → outcome.
 *
 * The interesting rows are the ones that are NOT errors in the usual sense:
 *
 *   408 / 429  the provider is telling us to come back; retryable.
 *   5xx        the provider failed to process. Retryable rather than
 *              ambiguous: a 5xx is an ANSWER, and Resend answers 5xx before
 *              enqueueing. The idempotency key makes the retry safe either
 *              way, so the classification costs nothing if that is ever wrong.
 *   4xx other  the message as written is unacceptable — a malformed address,
 *              an unverified domain, a body over the size limit. Permanent.
 */
function classifyStatus(status: number): EmailDeliveryOutcome {
  if (status === 408 || status === 429) {
    return {
      kind: "retryable",
      errorCode: status === 429 ? "rate_limited" : "provider_request_timeout",
      httpStatus: status,
    };
  }
  if (status >= 500) {
    return {
      kind: "retryable",
      errorCode: `provider_${status}`,
      httpStatus: status,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "permanent",
      errorCode: "provider_unauthorized",
      httpStatus: status,
    };
  }
  return {
    kind: "permanent",
    errorCode: `provider_rejected_${status}`,
    httpStatus: status,
  };
}

/**
 * A thrown `fetch` is ALWAYS ambiguous.
 *
 * It is tempting to read `TypeError: fetch failed` as "never left the
 * machine", and for a DNS failure that is true. But the identical error is
 * produced by a connection reset after the request body was written and the
 * provider had already accepted it. Nothing in the exception distinguishes
 * the two, so the only truthful classification is "unknown" — which is
 * survivable precisely because every request carries an idempotency key.
 */
function classifyThrown(err: unknown): EmailDeliveryOutcome {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: unknown }).name)
      : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "ambiguous", errorCode: "provider_timeout" };
  }
  return { kind: "ambiguous", errorCode: "provider_transport_error" };
}

// ===========================================================================
// The one send path
// ===========================================================================

/**
 * Deliver one email. Never throws.
 *
 * The whole contract is the return value: callers branch on `kind` and record
 * the result in their own durable authority. Nothing about the recipient, the
 * subject or the body is echoed back, so an outcome can be logged verbatim.
 */
export async function deliverEmail(
  request: EmailDeliveryRequest,
): Promise<EmailDeliveryOutcome> {
  // The recording provider is a full implementation of this contract, not a
  // bypass: it acknowledges, it keeps the message, it collapses duplicates on
  // the idempotency key and it can be made to refuse. Callers cannot tell the
  // difference, which is the point — the delivery state machine below them
  // runs its real path either way.
  //
  // It is chosen BEFORE the API key is resolved, because the recorder must
  // never see one and a run that selects it has no business requiring one.
  if (resolveEmailTransportProvider() === "recording") {
    const { deliverEmailViaRecorder } = await import("./email-recording-provider.js");
    return deliverEmailViaRecorder(request);
  }

  const apiKey = resolveApiKey();
  if (!apiKey) return { kind: "not_configured" };

  const key = request.idempotencyKey.trim();
  if (!key) {
    // A caller with no durable intent to derive a key from has no business on
    // a retryable send path: it cannot be made safe, so it is refused rather
    // than silently sent without deduplication.
    return { kind: "permanent", errorCode: "missing_idempotency_key", httpStatus: 0 };
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH),
      },
      body: JSON.stringify({
        from: request.from,
        to: request.to,
        subject: request.subject,
        text: request.text,
        html: request.html,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return classifyThrown(err);
  }

  if (!response.ok) return classifyStatus(response.status);

  // A 2xx whose body cannot be read is NOT an acknowledgement we can name,
  // but it IS an acknowledgement: the provider committed before responding.
  // The message id is recorded when present and omitted when not, rather than
  // downgrading a successful send to ambiguous over a parse failure.
  let providerMessageId: string | null = null;
  try {
    const parsed = (await response.json()) as { id?: unknown; data?: { id?: unknown } };
    const id = parsed?.data?.id ?? parsed?.id;
    providerMessageId = typeof id === "string" && id ? id : null;
  } catch {
    providerMessageId = null;
  }

  return { kind: "acknowledged", providerMessageId, httpStatus: response.status };
}

// ===========================================================================
// Derived helpers used by callers' state machines
// ===========================================================================

/**
 * May a caller retry after this outcome?
 *
 * `ambiguous` is retryable — that is the entire point of requiring an
 * idempotency key. `permanent` and `acknowledged` are not.
 */
export function isRetryableOutcome(outcome: EmailDeliveryOutcome): boolean {
  return outcome.kind === "retryable" || outcome.kind === "ambiguous";
}

/** Did the provider durably accept the message? */
export function isAcknowledgedOutcome(outcome: EmailDeliveryOutcome): boolean {
  return outcome.kind === "acknowledged";
}

/**
 * A short, PII-free code for an outcome, suitable for a log line, a security
 * event or an operations projection.
 */
export function outcomeCode(outcome: EmailDeliveryOutcome): string {
  switch (outcome.kind) {
    case "acknowledged":
      return "acknowledged";
    case "not_configured":
      return "not_configured";
    default:
      return outcome.errorCode;
  }
}

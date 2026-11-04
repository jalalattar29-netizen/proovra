/**
 * Phase E3.2 — Secure webhook delivery boundary.
 *
 * This module is the bounded outbound execution surface for the
 * WEBHOOK_DELIVERY_INTERNAL_ONLY automation action. It enforces:
 *
 *   - HTTPS-only destinations.
 *   - SSRF protection: localhost / private / metadata / link-local
 *     hostnames + IPs are rejected at both creation time AND right
 *     before each send (DNS-rebinding defence).
 *   - HMAC-SHA256 signed payloads with a per-destination secret.
 *   - Bounded payload (32 KiB cap; built from safe IDs + metadata only;
 *     never raw evidence content / signed URLs / storage keys / tokens).
 *   - Bounded delivery time (5 s timeout, single sync attempt in E3.2;
 *     retry worker deferred as DEF-023).
 *   - Bounded outbound: at most one delivery row per (team, run,
 *     destination) via the DB unique index.
 *   - Per-team destination cap (10 destinations / team).
 *
 * Hard rules (also pinned by phase-e3-2-webhook-delivery.test.ts):
 *   - No `fetch` / `http` / `https` import that bypasses the bounded
 *     `deliverWebhookOnce()` helper.
 *   - No `eval` / `vm` / `new Function`.
 *   - Webhook secret NEVER returned by any API except the one-time
 *     reveal from `createDestinationSecret()` at creation/rotation.
 *   - URL validation is fail-closed: any unexpected hostname / IP /
 *     scheme returns a structured `{ ok: false, reason }` instead
 *     of letting the request proceed.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  checkOutboundUrlResolved,
  checkOutboundUrlStatic,
  sendOutboundRequest,
  systemResolver,
  type OutboundResolver,
  type OutboundUrlPolicy,
} from "@proovra/shared-runtime/outbound";

import { getSecret } from "../../config/runtime-secrets.js";

// ---------------------------------------------------------------------------
// Bounded constants
// ---------------------------------------------------------------------------

export const WEBHOOK_MAX_PAYLOAD_BYTES = 32 * 1024; // 32 KiB
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_DESTINATIONS_PER_TEAM = 10;
export const WEBHOOK_MAX_DELIVERIES_PER_MINUTE_PER_TEAM = 120;

// ---------------------------------------------------------------------------
// Phase E3.3 — Bounded retry schedule + auto-disable threshold
//
// The schedule is ABSOLUTE: attempt 1 is immediate, attempts 2/3/4 are
// scheduled `WEBHOOK_RETRY_BACKOFF_SECONDS[N-2]` seconds after the
// previous attempt. After attempt 4 fails, the delivery transitions to
// RETRY_EXHAUSTED — there are no further attempts.
//
// Total max wall-clock: 0 + 5 + 30 + 300 = 335 seconds (~5.5 minutes)
// between first attempt and exhaustion. Bounded by design.
//
// Auto-disable: 10 consecutive failures on a destination flips
// `enabled=false` automatically. Operators can re-enable via the
// existing endpoint (which resets the counter).
// ---------------------------------------------------------------------------
export const WEBHOOK_RETRY_BACKOFF_SECONDS = [5, 30, 300] as const;
export const WEBHOOK_MAX_TOTAL_ATTEMPTS = 4; // 1 initial + 3 retries
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 10;

/**
 * Classify a delivery-attempt failure reason as retryable or not.
 *
 *   - `timeout` / `fetch_error` / `non_2xx:5xx` → retryable
 *   - `non_2xx:4xx` / `ssrf_blocked:*` / `destination_disabled` /
 *     `destination_not_in_team` / `secret_decryption_failed` →
 *     non-retryable (terminal FAILED)
 *
 * The 4xx-as-non-retryable rule matches Stripe and most webhook
 * receivers — 4xx means "the request itself is bad", retrying will
 * not change the outcome.
 */
/**
 * PHASE 12 CORRECTIVE PASS §1 CONTINUATION (ARCH-005, 2026-08-07).
 *
 * THE THREE OUTCOMES A TRANSPORT CAN ACTUALLY REPORT.
 *
 * The previous classification had two buckets — retryable and not — and put
 * `timeout` and `fetch_error` in "retryable". That is a claim the transport
 * never made. A timeout means the request was WRITTEN and the answer never
 * came back; the receiver may well have processed it. Resending is not a
 * retry, it is a SECOND delivery, and for a webhook that fires a downstream
 * action it is a real duplicate side effect.
 *
 * So the buckets are now three, and the difference between the first two is
 * whether the transport can PROVE nothing was committed:
 *
 *   NO_COMMIT   the connection was never established — DNS failed, the port
 *               refused, the TLS handshake failed. Nothing was written, so a
 *               resend is genuinely a retry.
 *   AMBIGUOUS   the connection WAS established and then the answer was lost —
 *               a timeout, a reset, a socket hang-up. The receiver may or may
 *               not have committed. This is not a failure and it is not a
 *               success, and it must not be resent.
 *   PERMANENT   the receiver answered and refused (a non-retryable 4xx), or
 *               our own configuration is wrong.
 *
 * Defaulting is deliberately toward AMBIGUOUS for anything unrecognised: an
 * unknown transport failure is, by definition, an unknown outcome.
 */
export const TRANSPORT_OUTCOMES = ["NO_COMMIT", "AMBIGUOUS", "PERMANENT"] as const;
export type TransportOutcome = (typeof TRANSPORT_OUTCOMES)[number];

/** Reasons the transport emits when the connection was never established. */
export const NO_COMMIT_REASONS: ReadonlyArray<string> = [
  "connect_failed",
  "dns_failed",
  "tls_failed",
];

/** Reasons that mean "written, answer lost". */
export const AMBIGUOUS_REASONS: ReadonlyArray<string> = [
  "timeout",
  "connection_reset",
  "socket_hang_up",
  "transport_unknown",
];

/**
 * Statuses whose HTTP SEMANTICS alone guarantee the request was not processed.
 *
 * Only two qualify, and neither is a judgement call:
 *
 *   408 Request Timeout — RFC 9110: "the server did not receive a complete
 *                         request message within the time it was prepared to
 *                         wait". An incomplete request cannot have been acted
 *                         on.
 *   425 Too Early       — RFC 8470: the server is "unwilling to risk
 *                         processing a request that might be replayed". The
 *                         refusal is the whole point of the status.
 *
 * 5xx is NOT here, and neither is 429. A 500 can be raised after the handler
 * committed and before it answered. A 502/504 comes from a GATEWAY, which
 * knows nothing about whether the origin processed the request — that is the
 * definition of ambiguous. A 503 from a load balancer means the request never
 * arrived; a 503 from the application itself may mean it arrived and failed
 * midway, and the sender cannot tell those two apart from the status line.
 * 429 usually means refused-before-processing, but "usually" is not a
 * guarantee, and a receiver that rate-limits AFTER enqueuing the work would
 * make every retry a duplicate.
 */
const REFUSAL_BEFORE_COMMIT_STATUSES: ReadonlyArray<number> = [408, 425];

/**
 * What a specific destination's operator has DECLARED about its own behaviour.
 *
 * The default is deliberately empty: nothing is assumed on a customer's behalf.
 * A receiver that genuinely guarantees "429 means I did not accept it" can say
 * so, and only then does that status become resendable for that destination.
 *
 * This is a seam, not a stub — the classifier's whole contract is that the
 * ONLY way a 5xx or a 429 becomes NO_COMMIT is a declaration, so the parameter
 * has to exist for the rule to be expressible at all.
 */
export type ProviderRefusalContract = {
  /** Statuses this provider guarantees are refusals BEFORE any commit. */
  refusalBeforeCommitStatuses?: ReadonlyArray<number>;
};

export const NO_DECLARED_PROVIDER_CONTRACT: ProviderRefusalContract = Object.freeze(
  {},
);

/**
 * Classify what the transport actually told us.
 *
 * PHASE 12 CORRECTIVE PASS §1 (2026-08-07), CORRECTED AGAIN: the first version
 * of this function put every 5xx and 429 in NO_COMMIT, on the reasoning that
 * "the receiver ANSWERED, so it did not leave us guessing". That reasoning is
 * wrong. Answering 500 tells us the request ARRIVED; it tells us nothing about
 * whether the handler committed before it failed. Resending on a generic 5xx
 * is therefore the same duplicate-side-effect defect as resending on a
 * timeout, one step further along.
 *
 * The rule now: a status is NO_COMMIT only when HTTP itself guarantees it
 * (408, 425) or when the destination's operator has declared it. Everything
 * else the receiver says that is not a definite refusal is AMBIGUOUS.
 */
export function classifyTransportOutcome(
  reason: string,
  contract: ProviderRefusalContract = NO_DECLARED_PROVIDER_CONTRACT,
): TransportOutcome {
  if (NO_COMMIT_REASONS.includes(reason)) return "NO_COMMIT";
  if (AMBIGUOUS_REASONS.includes(reason)) return "AMBIGUOUS";

  if (reason.startsWith("non_2xx:")) {
    const code = Number.parseInt(reason.slice("non_2xx:".length), 10);
    if (!Number.isFinite(code)) return "AMBIGUOUS";

    if (
      REFUSAL_BEFORE_COMMIT_STATUSES.includes(code) ||
      (contract.refusalBeforeCommitStatuses ?? []).includes(code)
    ) {
      return "NO_COMMIT";
    }
    // Anything the origin or a gateway returns that is not a definite refusal
    // leaves the outcome unknown. 502 and 504 are named explicitly because a
    // gateway error is the clearest case of all: the thing that answered is
    // not the thing that would have committed.
    if (code >= 500 && code < 600) return "AMBIGUOUS";
    if (code === 429) return "AMBIGUOUS";
    // A definite 4xx refusal: the receiver understood the request and declined
    // it, and it will decline the same request again.
    return "PERMANENT";
  }

  // Configuration problems: our key, our URL, our destination state. The
  // request never left, and it will not succeed on a retry either.
  if (
    reason.startsWith("ssrf_blocked") ||
    reason === "destination_disabled" ||
    reason === "secret_decryption_failed" ||
    reason === "destination_not_in_team"
  ) {
    return "PERMANENT";
  }
  return "AMBIGUOUS";
}

/**
 * RETAINED, and deliberately narrowed to what it always should have meant:
 * "may this be sent again?". Only NO_COMMIT may. AMBIGUOUS goes to
 * reconciliation, not to the retry ladder — see
 * `automation-delivery-runtime.service.ts`.
 */
export function isRetryableFailure(
  reason: string,
  contract: ProviderRefusalContract = NO_DECLARED_PROVIDER_CONTRACT,
): boolean {
  return classifyTransportOutcome(reason, contract) === "NO_COMMIT";
}

/**
 * Compute the absolute next-attempt timestamp for a retry given the
 * 1-indexed attempt number that just failed. Returns `null` when the
 * attempt cap has been reached (caller should transition to
 * RETRY_EXHAUSTED instead of scheduling another retry).
 */
export function computeNextAttemptAt(
  attemptThatJustFailed: number,
  nowMs: number = Date.now(),
): Date | null {
  // Attempt 1 failed → schedule attempt 2 (backoff index 0 = 5 s)
  // Attempt 2 failed → schedule attempt 3 (backoff index 1 = 30 s)
  // Attempt 3 failed → schedule attempt 4 (backoff index 2 = 300 s)
  // Attempt 4 failed → no more retries.
  const backoffIndex = attemptThatJustFailed - 1;
  if (backoffIndex < 0 || backoffIndex >= WEBHOOK_RETRY_BACKOFF_SECONDS.length) {
    return null;
  }
  const seconds = WEBHOOK_RETRY_BACKOFF_SECONDS[backoffIndex]!;
  return new Date(nowMs + seconds * 1000);
}

/** HMAC signing algorithm. Pinned for receiver verification examples. */
export const WEBHOOK_SIGNATURE_ALGO = "sha256" as const;

/** Header names used in every outbound delivery. */
export const WEBHOOK_HEADERS = {
  EVENT: "X-Proovra-Event",
  DELIVERY: "X-Proovra-Delivery",
  TIMESTAMP: "X-Proovra-Timestamp",
  SIGNATURE: "X-Proovra-Signature",
  TEAM: "X-Proovra-Team",
} as const;

// ---------------------------------------------------------------------------
// Secret generation + storage helpers
//
// We generate 32 random bytes (256 bits) at creation, encode as base64,
// and store the value alongside a SHA-256 fingerprint. The fingerprint
// lets the UI display "secret ending in …xx" without leaking the
// secret itself, and lets future ops compare a rotated secret against
// the stored value cheaply.
//
// The encryption envelope used by the storage layer is the same JWT
// secret + AES-GCM pattern used elsewhere in the codebase for
// at-rest-encrypted operational data. The stored value is base64 of
// the encrypted bytes; decryption happens only at signing time.
// ---------------------------------------------------------------------------

const SECRET_BYTES = 32; // 256-bit secret

export type CreatedSecret = {
  /** Plaintext secret — returned exactly ONCE at creation/rotation. */
  plaintext: string;
  /** Storage envelope — what the DB stores in `encryptedSecret`. */
  storedEnvelope: string;
  /** Short stable fingerprint, safe to display + index. */
  fingerprint: string;
};

/**
 * Create a fresh webhook signing secret. The plaintext is returned to
 * the caller exactly once and MUST be surfaced to the operator in the
 * create / rotate API response — it is never recoverable from the DB
 * afterwards.
 */
export function createDestinationSecret(): CreatedSecret {
  const raw = randomBytes(SECRET_BYTES);
  const plaintext = raw.toString("base64url");
  return {
    plaintext,
    storedEnvelope: encryptSecretForStorage(plaintext),
    fingerprint: fingerprintSecret(plaintext),
  };
}

export function fingerprintSecret(plaintext: string): string {
  return `sha256:${createHash("sha256").update(plaintext).digest("hex").slice(0, 16)}`;
}

/**
 * Encrypt a plaintext secret for at-rest storage. The current
 * implementation uses a deterministic XOR-with-keystream envelope
 * derived from AUTH_JWT_SECRET — sufficient for E3.2's threat model
 * (DB compromise alone does not yield plaintext secrets unless the
 * env is also compromised) and consistent with the rest of the
 * codebase's at-rest pattern for non-PII operational data. A
 * stronger KMS-backed wrap can land in a follow-up phase if needed
 * without changing this function's signature.
 */
function encryptSecretForStorage(plaintext: string): string {
  const keyMaterial = resolveStorageKeyMaterial();
  const keystream = expandKeystream(keyMaterial, plaintext.length);
  const out = Buffer.alloc(plaintext.length);
  const pt = Buffer.from(plaintext, "utf8");
  for (let i = 0; i < pt.length; i++) {
    out[i] = pt[i]! ^ keystream[i]!;
  }
  return `e3.2:${out.toString("base64")}`;
}

/**
 * Decrypt a stored envelope back into plaintext, for use during HMAC
 * signing. Fails closed (returns null) if the envelope is malformed.
 */
export function decryptStoredSecret(envelope: string): string | null {
  if (!envelope.startsWith("e3.2:")) return null;
  try {
    const ct = Buffer.from(envelope.slice(5), "base64");
    const keyMaterial = resolveStorageKeyMaterial();
    const keystream = expandKeystream(keyMaterial, ct.length);
    const pt = Buffer.alloc(ct.length);
    for (let i = 0; i < ct.length; i++) {
      pt[i] = ct[i]! ^ keystream[i]!;
    }
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

function resolveStorageKeyMaterial(): Buffer {
  // Reuse the existing AUTH_JWT_SECRET key material. In production this
  // is set by R8.C startup validation; in dev / test the deterministic
  // fallback keeps existing behaviour stable.
  //
  // Phase P2.0 — AUTH_JWT_SECRET is in the migrated set; prefer the
  // AWS Secrets Manager cache, fall back to env, fall back to the
  // dev-only deterministic seed.
  const raw =
    getSecret("AUTH_JWT_SECRET") ?? "dev-jwt-secret-not-for-production";
  return createHash("sha256").update(`e3.2-webhook-secret-wrap|${raw}`).digest();
}

function expandKeystream(key: Buffer, length: number): Buffer {
  // PRF expansion via SHA-256 of (key || counter). Cheap; deterministic;
  // bounded — we never expand more than ~64 bytes in practice.
  const blocks: Buffer[] = [];
  let total = 0;
  let counter = 0;
  while (total < length) {
    const blk = createHash("sha256")
      .update(key)
      .update(Buffer.from([counter & 0xff, (counter >> 8) & 0xff]))
      .digest();
    blocks.push(blk);
    total += blk.length;
    counter += 1;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

// ---------------------------------------------------------------------------
// URL safety / SSRF protection
//
// Rejects every URL that:
//   - is not HTTPS
//   - has a scheme other than https:
//   - has username/password in URL
//   - resolves to localhost / private / link-local / metadata IPs
//   - has port other than 443 (default HTTPS port)
//
// Validation runs at create/update AND right before each send (DNS
// rebinding defence — an attacker who controls a DNS record cannot
// flip it to 169.254.169.254 between the create check and the send).
// ---------------------------------------------------------------------------

export type UrlValidationResult =
  | { ok: true; origin: string; hostname: string }
  | { ok: false; reason: UrlValidationReason };

export const URL_VALIDATION_REASONS = [
  "invalid_url",
  "non_https_scheme",
  "credentials_in_url",
  "non_default_port",
  "localhost",
  "private_ip",
  "link_local_ip",
  "metadata_service_ip",
  "loopback_ip",
  "ipv6_local",
  "dns_resolution_failed",
  // PRO-064 — the shared outbound policy's further refusals: an over-long URL,
  // and the reserved IPv6 forms (IPv4-compatible, Teredo, 6to4 to a refused
  // address, local-use NAT64) that can only be a way round the others.
  "url_too_long",
  "reserved_ip",
] as const;
export type UrlValidationReason = (typeof URL_VALIDATION_REASONS)[number];

/**
 * ARCH-005 (2026-08-07) — THE CONTROLLED LOCAL-TESTING MODE, AND ITS FENCE.
 *
 * Proving that a webhook is signed, verified, replay-refused, retried and
 * dead-lettered requires an actual HTTP receiver, and the only receiver a test
 * can stand up is a loopback one — which every rule above correctly refuses.
 *
 * So there is exactly one escape, and it is fenced three ways:
 *
 *   1. It requires `NODE_ENV === "test"`. Not "not production" — TEST. A
 *      staging or development process cannot enable it however its environment
 *      is configured, so there is no deployment in which a misplaced variable
 *      opens an SSRF hole.
 *   2. It requires the variable to be exactly "1".
 *   3. It widens the check to LOOPBACK ONLY. Private ranges, link-local
 *      addresses and the cloud metadata service stay refused even here,
 *      because a test never needs them and the day one does is the day this
 *      exemption has become a hole.
 *
 * The refusal itself is not weakened: `phase-12-arch-005-automation-runtime`
 * drives a metadata-service destination and a private-range destination WITH
 * the flag set and observes both refused before any network call.
 */
export function isLocalWebhookTestingEnabled(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK === "1"
  );
}

/**
 * PRO-064 / BILLING-05 — the address rules are the shared outbound policy
 * (`@proovra/shared-runtime/outbound`), which classifies by address BYTES. The
 * string-prefix classifier this replaced accepted the hex spelling WHATWG URL
 * normalises IPv4-mapped addresses to (`[::ffff:7f00:1]`), `[::]` and NAT64
 * (`64:ff9b::a9fe:a9fe`).
 */
const AUTOMATION_POLICY: OutboundUrlPolicy = {
  requireDefaultPort: true,
  localAllowance: "none",
};

function loopbackLiteralUnderTestFlag(input: string): boolean {
  if (!isLocalWebhookTestingEnabled()) return false;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }
  const raw = parsed.hostname.toLowerCase();
  const h = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return h === "127.0.0.1" || h === "::1";
}

/** The policy one URL is checked and SENT under. */
function policyFor(input: string): OutboundUrlPolicy {
  return loopbackLiteralUnderTestFlag(input)
    ? { ...AUTOMATION_POLICY, localAllowance: "loopback" }
    : AUTOMATION_POLICY;
}

/**
 * Validate the URL itself (scheme / port / credentials / literal address).
 * Does NOT perform DNS resolution — call `validateDestinationUrlWithDns()` for
 * a fully-checked URL.
 */
export function validateDestinationUrlStatic(input: string): UrlValidationResult {
  const allowLoopback = isLocalWebhookTestingEnabled();
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (allowLoopback) {
    const raw = parsed.hostname.toLowerCase();
    const h = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
    const isLoopback = h === "127.0.0.1" || h === "::1";
    if (isLoopback && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
      if (parsed.username || parsed.password) {
        return { ok: false, reason: "credentials_in_url" };
      }
      return { ok: true, origin: parsed.origin, hostname: h };
    }
    // Anything else falls through to the ordinary rules below — including
    // every private, link-local and metadata address.
  }
  const verdict = checkOutboundUrlStatic(input, AUTOMATION_POLICY);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, origin: verdict.origin, hostname: verdict.hostname };
}

/**
 * Full URL validation including DNS resolution: every address the name
 * resolves to must be allowed. The send itself (`deliverWebhookOnce`) checks
 * the address it actually connects to as well, so a DNS answer that changes
 * after this call cannot reach a refused address.
 */
export async function validateDestinationUrlWithDns(
  input: string,
  resolver: OutboundResolver = systemResolver,
): Promise<UrlValidationResult> {
  const staticResult = validateDestinationUrlStatic(input);
  if (!staticResult.ok) return staticResult;
  const verdict = await checkOutboundUrlResolved(input, policyFor(input), resolver);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return staticResult;
}

// ---------------------------------------------------------------------------
// HMAC signing
//
// The signature covers `timestamp + "." + deliveryId + "." + body`. The
// receiver verifies by computing the same HMAC with their copy of the
// secret and rejecting if signatures don't match in constant time.
// ---------------------------------------------------------------------------

export type SignedDelivery = {
  body: string;
  headers: Record<string, string>;
};

export type BuildSignedDeliveryInput = {
  eventType: string;
  deliveryId: string;
  teamId: string;
  payload: Readonly<Record<string, unknown>>;
  secretPlaintext: string;
  /** Optional fixed timestamp (for tests). Defaults to Date.now() ms. */
  nowMs?: number;
};

/**
 * Build the canonical signed delivery for a webhook. Throws if the
 * payload exceeds the bounded size cap — that's an explicit operator
 * error, not a runtime fallback.
 */
export function buildSignedDelivery(input: BuildSignedDeliveryInput): SignedDelivery {
  const body = JSON.stringify(input.payload);
  if (Buffer.byteLength(body, "utf8") > WEBHOOK_MAX_PAYLOAD_BYTES) {
    throw new Error(`webhook_payload_too_large:${Buffer.byteLength(body, "utf8")}`);
  }
  const timestamp = String(Math.floor((input.nowMs ?? Date.now()) / 1000));
  const signingInput = `${timestamp}.${input.deliveryId}.${body}`;
  const signature = createHmac(WEBHOOK_SIGNATURE_ALGO, input.secretPlaintext)
    .update(signingInput)
    .digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      [WEBHOOK_HEADERS.EVENT]: input.eventType,
      [WEBHOOK_HEADERS.DELIVERY]: input.deliveryId,
      [WEBHOOK_HEADERS.TIMESTAMP]: timestamp,
      [WEBHOOK_HEADERS.SIGNATURE]: `t=${timestamp},v1=${signature}`,
      [WEBHOOK_HEADERS.TEAM]: input.teamId,
    },
  };
}

/**
 * Constant-time verification helper. Receivers may use it to validate
 * incoming deliveries; the server itself never calls it (we only
 * sign). Exported for tests + documentation.
 */
export function verifyDeliverySignature(input: {
  body: string;
  deliveryId: string;
  timestamp: string;
  signatureHeader: string;
  secretPlaintext: string;
}): boolean {
  // Parse "t=<ts>,v1=<hex>".
  const m = input.signatureHeader.match(/t=([^,]+),v1=([0-9a-f]+)/);
  if (!m) return false;
  const headerTs = m[1]!;
  const headerSig = m[2]!;
  if (headerTs !== input.timestamp) return false;
  const expected = createHmac(WEBHOOK_SIGNATURE_ALGO, input.secretPlaintext)
    .update(`${input.timestamp}.${input.deliveryId}.${input.body}`)
    .digest("hex");
  if (expected.length !== headerSig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(headerSig, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bounded payload builder
//
// Constructs the safe outbound payload for an automation trigger. Only
// IDs + bounded metadata are included — never raw evidence content,
// never signed URLs, never storage keys, never tokens.
// ---------------------------------------------------------------------------

export type BuildPayloadInput = {
  eventType: string;
  deliveryId: string;
  teamId: string;
  automationRunId: string;
  ruleId: string;
  triggerType: string;
  actionType: string;
  targetType: string;
  targetId: string;
  occurredAt?: Date;
  /** Operator-safe small metadata to attach. Strings clipped, no nesting. */
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
};

export function buildSafeWebhookPayload(input: BuildPayloadInput): Record<string, unknown> {
  const ts = (input.occurredAt ?? new Date()).toISOString();
  const safeMeta: Record<string, string | number | boolean | null> = {};
  if (input.metadata) {
    for (const [k, v] of Object.entries(input.metadata).slice(0, 16)) {
      // Per-key length cap; per-value cap on strings.
      const key = String(k).slice(0, 60);
      if (typeof v === "string") {
        safeMeta[key] = v.slice(0, 200);
      } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
        safeMeta[key] = v;
      }
    }
  }
  return {
    eventType: input.eventType,
    deliveryId: input.deliveryId,
    teamId: input.teamId,
    automationRunId: input.automationRunId,
    ruleId: input.ruleId,
    triggerType: input.triggerType,
    actionType: input.actionType,
    targetType: input.targetType,
    targetId: input.targetId,
    occurredAt: ts,
    metadata: safeMeta,
  };
}

// ---------------------------------------------------------------------------
// Outbound HTTP delivery (single bounded attempt)
//
// E3.2 ships synchronous single-attempt delivery with a strict 5 s
// timeout. The DB model carries `attemptCount` + `nextAttemptAt` so a
// future bounded retry worker (DEF-023) can extend the surface without
// changing this signature.
// ---------------------------------------------------------------------------

export type DeliveryAttemptResult =
  | { ok: true; status: number }
  | { ok: false; status: number; reason: string };

export async function deliverWebhookOnce(input: {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Test seam for name resolution; production uses the system resolver. */
  resolver?: OutboundResolver;
}): Promise<DeliveryAttemptResult> {
  // PRO-064 — the send goes through the shared outbound transport. It refuses
  // the URL again (a row stored before a rule existed is not trusted), resolves
  // the name inside the connection and refuses any answer the policy refuses,
  // so the address checked is the address connected to. It never follows a
  // redirect (a 3xx comes back as `non_2xx:3xx`, a permanent refusal) and it
  // does not read the receiver's body back: only the status is kept.
  const result = await sendOutboundRequest({
    url: input.url,
    method: "POST",
    headers: input.headers,
    body: input.body,
    timeoutMs: input.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
    policy: policyFor(input.url),
    resolver: input.resolver,
    maxResponseBytes: 4 * 1024,
  });
  if (result.kind === "refused") {
    return { ok: false, status: 0, reason: `ssrf_blocked:${result.reason}` };
  }
  if (result.kind === "response") {
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, status: result.status };
    }
    return {
      ok: false,
      status: result.status,
      reason: `non_2xx:${result.status}`,
    };
  }
  /**
   * ARCH-005 (2026-08-07) — REPORT WHAT THE TRANSPORT KNOWS, NOT LESS.
   *
   * The one distinction that matters is whether the request was ever
   * WRITTEN. The transport says so directly: `requestWritten` is false until
   * the connection (and, for https, the TLS handshake) is up. A refused
   * connection, an unresolvable host or a failed handshake all mean nothing
   * left this process — those are safe to send again. A reset, a hang-up or a
   * timeout after the connection was up means bytes may have left and the
   * answer was lost, which must never be resent as though it were.
   */
  const code = result.code;
  if (!result.requestWritten) {
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { ok: false, status: 0, reason: "dns_failed" };
    }
    if (
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" ||
      code === "timeout"
    ) {
      return { ok: false, status: 0, reason: "connect_failed" };
    }
    // Anything else before the connection was up is a handshake failure
    // (certificate, protocol): nothing was written.
    return { ok: false, status: 0, reason: "tls_failed" };
  }
  if (code === "timeout") {
    return { ok: false, status: 0, reason: "timeout" };
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return { ok: false, status: 0, reason: "connection_reset" };
  }
  // Unrecognised. An unknown transport failure IS an unknown outcome, and
  // this default is the one place where guessing "retryable" would silently
  // reintroduce duplicate deliveries.
  return { ok: false, status: 0, reason: "transport_unknown" };
}

/**
 * PHASE 12 — POINT 5: the canonical email transport authority.
 *
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * Two things, and they are different in kind.
 *
 *   1. TOPOLOGY — that there is exactly ONE module in the repository which
 *      performs an email provider send. This is a source-level check and it is
 *      NOT offered as behavioural proof of anything; it exists because the
 *      defect it guards against is the ADDITION of a second transport, which
 *      no behavioural test can see.
 *
 *   2. BEHAVIOUR — that the one transport classifies outcomes correctly,
 *      refuses to send without an idempotency key, and returns nothing that
 *      could carry a recipient, a subject or a body into a log line.
 *
 * WHY IT MATTERS THAT THERE IS ONE
 * ---------------------------------------------------------------------------
 * Before this phase there were three, with three different answers to "did
 * that send happen?" — a typed result, a resolved SDK object carrying an
 * `error` field that callers ignored, and a thrown exception. None of them
 * sent an idempotency key, so every retry on every path was a blind resend.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AMBIGUOUS_ERROR_CODE,
  ATTEMPT_LEASE_MS,
  DEFAULT_TIMEOUT_MS,
  canonicalEmailFrom,
  deliverEmail,
  mintEmailIdempotencyKey,
  EMAIL_IDEMPOTENCY_KEY_PATTERN,
  resetEmailIdempotencySecretResolver,
  deriveDeliveryPhase,
  isAcknowledgedOutcome,
  isRecoverableDeliveryPhase,
  isRetryableOutcome,
  isTerminalDeliveryPhase,
  outcomeCode,
  readAttemptMarker,
  resetEmailApiKeyResolver,
} from "@proovra/shared-runtime";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function readSource(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const BASE = {
  from: "PROOVRA <no-reply@proovra.test>",
  to: "recipient@example.test",
  subject: "subject line",
  html: "<p>body</p>",
  text: "body",
  idempotencyKey: "proovra-delivery-11111111-1111-4111-8111-111111111111",
};

describe("POINT 5 — email transport topology", () => {
  // Every module in the two services that could plausibly reach a provider.
  const SOURCES: ReadonlyArray<[string, string]> = [
    ["api/email.service", "services/api/src/services/email.service.ts"],
    [
      "api/resend-provider",
      "services/api/src/services/notifications/resend-provider.ts",
    ],
    ["worker/mfa-recovery-digest", "services/worker/src/mfa-recovery-digest.ts"],
    [
      "shared-runtime/email-transport",
      "packages/shared-runtime/src/notifications/email-transport.ts",
    ],
  ];

  it("exactly one module names the provider send endpoint", () => {
    const naming = SOURCES.filter(([, path]) =>
      readSource(path).includes("api.resend.com"),
    ).map(([name]) => name);
    expect(naming).toEqual(["shared-runtime/email-transport"]);
  });

  it("no module constructs a provider SDK client", () => {
    for (const [name, path] of SOURCES) {
      expect(readSource(path), `${name} constructs a second client`).not.toMatch(
        /new Resend\(/,
      );
    }
  });

  it("the provider SDK is gone from the dependency graph entirely", () => {
    // Not just "unimported" — REMOVED. An unused dependency that still
    // resolves is an import away from being a fourth transport, and the whole
    // point of a single authority is that adding a second has to be a visible
    // act. `pnpm install --frozen-lockfile` in the certification run is what
    // proves the lockfile agrees.
    for (const [name, path] of SOURCES) {
      expect(readSource(path), `${name} still imports the SDK`).not.toMatch(
        /from "resend"/,
      );
    }
    for (const manifest of [
      "services/api/package.json",
      "services/worker/package.json",
      "packages/shared-runtime/package.json",
    ]) {
      const pkg = JSON.parse(readSource(manifest)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(
        Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }),
        `${manifest} still declares the provider SDK`,
      ).not.toContain("resend");
    }
  });

  it("a minted key is opaque and version-tagged", () => {
    resetEmailIdempotencySecretResolver();
    const key = mintEmailIdempotencyKey("delivery", "11111111-1111-4111-8111-111111111111");
    expect(key).toMatch(EMAIL_IDEMPOTENCY_KEY_PATTERN);
    expect(key).toContain("-v1-");
  });

  it("the transport requires an idempotency key at the type level", () => {
    const src = readSource(
      "packages/shared-runtime/src/notifications/email-transport.ts",
    );
    // Not `idempotencyKey?:`. An optional key is one some caller will omit,
    // and that caller is the one whose retry sends twice.
    expect(src).toMatch(/\n {2}idempotencyKey: string;/);
    expect(src).not.toMatch(/idempotencyKey\?:/);
  });
});

describe("POINT 5 — email transport behaviour", () => {
  let previousKey: string | undefined;
  let previousTransport: string | undefined;

  beforeEach(() => {
    resetEmailApiKeyResolver();
    previousKey = process.env["RESEND_API_KEY"];
    process.env["RESEND_API_KEY"] = "point5-unit-only-not-a-real-key";
    // This block is about the RESEND provider's wire behaviour — the status
    // classification, the header it sends, what it does with a torn
    // connection. Since PHASE 12 POINT 7 the transport chooses a provider, and
    // the local default is the recording one, so the provider under test has
    // to be named rather than assumed. `fetch` is stubbed throughout; nothing
    // here reaches a network.
    previousTransport = process.env["EMAIL_TRANSPORT"];
    process.env["EMAIL_TRANSPORT"] = "resend";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEmailApiKeyResolver();
    if (previousKey === undefined) delete process.env["RESEND_API_KEY"];
    else process.env["RESEND_API_KEY"] = previousKey;
    if (previousTransport === undefined) delete process.env["EMAIL_TRANSPORT"];
    else process.env["EMAIL_TRANSPORT"] = previousTransport;
  });

  function stubResponse(status: number, body: unknown = {}) {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      async (
        _url: string,
        init: { headers: Record<string, string>; body: string },
      ) => {
        seen.push({ headers: init.headers, body: init.body });
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
          text: async () => "",
        } as never;
      },
    );
    return seen;
  }

  it("a 2xx with an id is an acknowledgement, and the id is projected", async () => {
    stubResponse(200, { id: "resend_abc" });
    const outcome = await deliverEmail(BASE);
    expect(outcome).toEqual({
      kind: "acknowledged",
      providerMessageId: "resend_abc",
      httpStatus: 200,
    });
    expect(isAcknowledgedOutcome(outcome)).toBe(true);
    expect(isRetryableOutcome(outcome)).toBe(false);
    expect(outcomeCode(outcome)).toBe("acknowledged");
  });

  it("a 2xx whose body cannot be read is still an acknowledgement", async () => {
    // The provider committed before responding. Downgrading a successful send
    // to ambiguous over a parse failure would cause a pointless resend.
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 202,
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "",
    }));
    const outcome = await deliverEmail(BASE);
    expect(outcome).toEqual({
      kind: "acknowledged",
      providerMessageId: null,
      httpStatus: 202,
    });
  });

  it("the idempotency key is sent verbatim on the wire", async () => {
    const seen = stubResponse(200, { id: "x" });
    await deliverEmail(BASE);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["Idempotency-Key"]).toBe(BASE.idempotencyKey);
  });

  it("an empty idempotency key is refused rather than sent unprotected", async () => {
    const seen = stubResponse(200, { id: "x" });
    const outcome = await deliverEmail({ ...BASE, idempotencyKey: "   " });
    expect(outcome).toEqual({
      kind: "permanent",
      errorCode: "missing_idempotency_key",
      httpStatus: 0,
    });
    expect(seen, "nothing may reach the provider unprotected").toHaveLength(0);
  });

  it("no API key is a structural non-configuration, not a failure to retry", async () => {
    delete process.env["RESEND_API_KEY"];
    const seen = stubResponse(200);
    const outcome = await deliverEmail(BASE);
    expect(outcome).toEqual({ kind: "not_configured" });
    expect(seen).toHaveLength(0);
    expect(isRetryableOutcome(outcome)).toBe(false);
  });

  it.each([
    [429, "rate_limited"],
    [408, "provider_request_timeout"],
    [500, "provider_500"],
    [503, "provider_503"],
  ])("HTTP %i is retryable as %s", async (status, code) => {
    stubResponse(status);
    const outcome = await deliverEmail(BASE);
    expect(outcome).toMatchObject({ kind: "retryable", errorCode: code });
    expect(isRetryableOutcome(outcome)).toBe(true);
  });

  it.each([
    [401, "provider_unauthorized"],
    [403, "provider_unauthorized"],
    [422, "provider_rejected_422"],
    [400, "provider_rejected_400"],
  ])("HTTP %i is permanent as %s", async (status, code) => {
    stubResponse(status);
    const outcome = await deliverEmail(BASE);
    expect(outcome).toMatchObject({ kind: "permanent", errorCode: code });
    expect(isRetryableOutcome(outcome)).toBe(false);
  });

  it("a thrown fetch is ambiguous, never 'failed'", async () => {
    // The identical exception is produced by a DNS failure that never left the
    // machine and by a connection reset after the provider accepted. Nothing
    // distinguishes them, so the only truthful answer is "unknown".
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const outcome = await deliverEmail(BASE);
    expect(outcome).toEqual({
      kind: "ambiguous",
      errorCode: "provider_transport_error",
    });
    expect(isRetryableOutcome(outcome)).toBe(true);
  });

  it("a timeout is ambiguous and distinguishable", async () => {
    vi.stubGlobal("fetch", async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const outcome = await deliverEmail({ ...BASE, timeoutMs: 5 });
    expect(outcome).toEqual({
      kind: "ambiguous",
      errorCode: "provider_timeout",
    });
  });

  it("the timeout is bounded by default", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("no outcome can carry a recipient, subject or body", async () => {
    for (const status of [200, 429, 422]) {
      stubResponse(status, { id: "resend_abc" });
      const outcome = await deliverEmail(BASE);
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(BASE.to);
      expect(serialized).not.toContain(BASE.subject);
      expect(serialized).not.toContain(BASE.text);
      expect(outcomeCode(outcome)).not.toContain("@");
    }
    vi.stubGlobal("fetch", async () => {
      throw new Error("boom: recipient@example.test");
    });
    const thrown = await deliverEmail(BASE);
    expect(JSON.stringify(thrown)).not.toContain(BASE.to);
  });

  it("the From header resolves from one place, with a stable fallback", () => {
    const previous = process.env["EMAIL_FROM"];
    delete process.env["EMAIL_FROM"];
    delete process.env["RESEND_FROM"];
    expect(canonicalEmailFrom()).toContain("<no-reply@proovra.com>");
    process.env["EMAIL_FROM"] = "Explicit <ops@proovra.test>";
    expect(canonicalEmailFrom()).toBe("Explicit <ops@proovra.test>");
    if (previous === undefined) delete process.env["EMAIL_FROM"];
    else process.env["EMAIL_FROM"] = previous;
  });
});

describe("POINT 5 — durable delivery phase derivation", () => {
  const NOW = new Date("2026-08-04T12:00:00.000Z");
  const KEY = mintEmailIdempotencyKey("delivery", "11111111-1111-4111-8111-111111111111");
  const attempt = {
    attempt: { startedAtUtc: NOW.toISOString(), idempotencyKey: KEY },
  };

  it("the idempotency key is a pure function of the durable id", () => {
    expect(mintEmailIdempotencyKey("delivery", "abc")).toBe(mintEmailIdempotencyKey("delivery", "abc"));
    expect(mintEmailIdempotencyKey("delivery", "abc")).not.toBe(
      mintEmailIdempotencyKey("delivery", "abd"),
    );
  });

  it("a PENDING row with no attempt is a claim, and a claim is recoverable", () => {
    const phase = deriveDeliveryPhase({ status: "PENDING" }, NOW);
    expect(phase).toBe("claimed");
    expect(isRecoverableDeliveryPhase(phase)).toBe(true);
    expect(isTerminalDeliveryPhase(phase)).toBe(false);
  });

  it("a live lease is in flight and is NOT recoverable", () => {
    const phase = deriveDeliveryPhase(
      {
        status: "PENDING",
        metadata: attempt,
        nextAttemptAtUtc: new Date(NOW.getTime() + ATTEMPT_LEASE_MS),
      },
      NOW,
    );
    expect(phase).toBe("in_flight");
    expect(isRecoverableDeliveryPhase(phase)).toBe(false);
  });

  it("an expired lease is recoverable", () => {
    const phase = deriveDeliveryPhase(
      {
        status: "PENDING",
        metadata: attempt,
        nextAttemptAtUtc: new Date(NOW.getTime() - 1),
      },
      NOW,
    );
    expect(phase).toBe("expired");
    expect(isRecoverableDeliveryPhase(phase)).toBe(true);
  });

  it("an attempted row with NO lease is expired, not held forever", () => {
    expect(
      deriveDeliveryPhase(
        { status: "PENDING", metadata: attempt, nextAttemptAtUtc: null },
        NOW,
      ),
    ).toBe("expired");
  });

  it("ambiguous is distinguished from ordinary retryable by its code", () => {
    expect(
      deriveDeliveryPhase(
        { status: "RETRY_SCHEDULED", errorCode: AMBIGUOUS_ERROR_CODE },
        NOW,
      ),
    ).toBe("ambiguous");
    expect(
      deriveDeliveryPhase(
        { status: "RETRY_SCHEDULED", errorCode: "rate_limited" },
        NOW,
      ),
    ).toBe("retryable");
  });

  it.each([
    ["SENT", "acknowledged"],
    ["DELIVERED", "delivered"],
    ["FAILED", "failed"],
    ["SKIPPED", "skipped"],
    ["CANCELLED", "skipped"],
  ])("%s derives %s and is terminal", (status, expected) => {
    const phase = deriveDeliveryPhase({ status }, NOW);
    expect(phase).toBe(expected);
    expect(isTerminalDeliveryPhase(phase)).toBe(true);
    expect(isRecoverableDeliveryPhase(phase)).toBe(false);
  });

  it("an unknown status never derives a terminal or recoverable phase", () => {
    // A schema change must not be able to invent a false delivered state, nor
    // authorise a blind resend.
    const phase = deriveDeliveryPhase({ status: "SOMETHING_NEW" }, NOW);
    expect(phase).toBe("in_flight");
    expect(isTerminalDeliveryPhase(phase)).toBe(false);
    expect(isRecoverableDeliveryPhase(phase)).toBe(false);
  });

  it("a malformed attempt marker is ignored rather than trusted", () => {
    expect(readAttemptMarker(null)).toBeNull();
    expect(readAttemptMarker({ attempt: "not an object" })).toBeNull();
    expect(readAttemptMarker({ attempt: { startedAtUtc: 1 } })).toBeNull();
    expect(readAttemptMarker(attempt)).toEqual({
      startedAtUtc: NOW.toISOString(),
      idempotencyKey: KEY,
    });
  });
});

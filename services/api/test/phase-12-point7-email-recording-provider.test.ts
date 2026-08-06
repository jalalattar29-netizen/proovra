/**
 * PHASE 12 — POINT 7 (final pass): the LOCAL RECORDING email provider.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * The corrected browser run recorded eighteen BLOCKED attempts at
 * `api.resend.com`. Nothing left the machine — the outbound guard saw to that —
 * but a blocked attempt is containment, not a provider proof. Every journey
 * that depended on a message being accepted got `ambiguous` back from a refused
 * socket, and the email boundary was never exercised at all.
 *
 * The fix is a provider, not a bypass. This suite proves it behaves like one:
 * it acknowledges, it stores what it accepted, it collapses a duplicate on the
 * idempotency key the way a real provider does, and it can refuse in each of
 * the ways the canonical outcome type distinguishes.
 *
 * It also proves the two negatives that make the fix worth anything: the
 * recorder never constructs a real provider request, and the selection is made
 * by the ENVIRONMENT rather than by matching a scenario name or a URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deliverEmail,
  isAcknowledgedOutcome,
  isRetryableOutcome,
  recipientAliasFor,
  recordedEmails,
  resetRecordingEmailProvider,
  resolveEmailTransportProvider,
  scriptRecordingProviderFailure,
} from "@proovra/shared-runtime";

const BASE = {
  from: "Proovra <no-reply@test.proovra.local>",
  to: "recipient@test.proovra.local",
  subject: "You have been invited to a Proovra workspace",
  html: '<a href="http://127.0.0.1:3007/invite/abc123def456ghi789">Accept invitation</a>',
  text: "Accept invitation: http://127.0.0.1:3007/invite/abc123def456ghi789\n",
  idempotencyKey: "pv1_durable_intent_0001",
};

describe("POINT 7 — the recording provider is SELECTED, never inferred", () => {
  const previous = process.env["EMAIL_TRANSPORT"];
  afterEach(() => {
    if (previous === undefined) delete process.env["EMAIL_TRANSPORT"];
    else process.env["EMAIL_TRANSPORT"] = previous;
  });

  it("the local run selects the recorder, and it is the environment that says so", () => {
    // Set by the `--import` bootstrap before any application module loads.
    expect(process.env["EMAIL_TRANSPORT"]).toBe("recording");
    expect(resolveEmailTransportProvider()).toBe("recording");
  });

  it("an UNSET selection keeps the deployed provider — omission changes nothing", () => {
    delete process.env["EMAIL_TRANSPORT"];
    expect(resolveEmailTransportProvider()).toBe("resend");
  });

  it("an unrecognised value is not silently treated as the recorder", () => {
    process.env["EMAIL_TRANSPORT"] = "definitely-not-a-provider";
    expect(resolveEmailTransportProvider()).toBe("resend");
  });
});

describe("POINT 7 — the recorder behaves like a provider", () => {
  beforeEach(() => {
    resetRecordingEmailProvider();
    process.env["EMAIL_TRANSPORT"] = "recording";
  });
  afterEach(() => {
    resetRecordingEmailProvider();
    vi.unstubAllGlobals();
  });

  it("E01 — a send is ACKNOWLEDGED and the message is kept", async () => {
    const outcome = await deliverEmail(BASE);
    expect(outcome.kind).toBe("acknowledged");
    expect(isAcknowledgedOutcome(outcome)).toBe(true);

    const stored = recordedEmails();
    expect(stored.length).toBe(1);
    expect(stored[0].result).toBe("acknowledged");
    expect(stored[0].providerMessageId).toBeTruthy();
    expect(stored[0].attempt).toBe(1);
  });

  it("E02 — the actionable link survives, so a browser journey can open it", async () => {
    await deliverEmail(BASE);
    expect(recordedEmails()[0].actionableLink).toBe(
      "http://127.0.0.1:3007/invite/abc123def456ghi789",
    );
  });

  it("E03 — no real provider request is ever constructed", async () => {
    // If the recorder reached for `fetch`, this would catch it: the stub throws
    // rather than returning something plausible, so a silent fall-through to
    // the resend path cannot look like a success.
    const attempted: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      attempted.push(String(url));
      throw new Error("the recording provider must not use fetch");
    });
    const outcome = await deliverEmail(BASE);
    expect(outcome.kind).toBe("acknowledged");
    expect(attempted).toEqual([]);
  });

  it("E04 — the API key is never read, and a missing one is not a refusal", async () => {
    const saved = process.env["RESEND_API_KEY"];
    delete process.env["RESEND_API_KEY"];
    try {
      const outcome = await deliverEmail(BASE);
      // `not_configured` here would mean the run had silently stopped
      // exercising the delivery state machine — the exact failure mode that an
      // unset key produced before provider selection existed.
      expect(outcome.kind).toBe("acknowledged");
    } finally {
      if (saved !== undefined) process.env["RESEND_API_KEY"] = saved;
    }
  });

  it("E05 — a retry on the SAME key is attempt 2, not a second message", async () => {
    const first = await deliverEmail(BASE);
    const second = await deliverEmail(BASE);
    expect(first).toEqual(second);
    // One STORED message. A provider honouring an idempotency key collapses
    // the duplicate; so does this.
    expect(recordedEmails().length).toBe(1);
  });

  it("E06 — a DIFFERENT key is a different message", async () => {
    await deliverEmail(BASE);
    await deliverEmail({ ...BASE, idempotencyKey: "pv1_durable_intent_0002" });
    expect(recordedEmails().length).toBe(2);
    expect(new Set(recordedEmails().map((m) => m.idempotencyAlias)).size).toBe(2);
  });

  it("E07 — a scripted RETRYABLE refusal is retryable, and the retry succeeds", async () => {
    scriptRecordingProviderFailure({
      kind: "retryable",
      errorCode: "provider_rate_limited",
      httpStatus: 429,
    });
    const refused = await deliverEmail(BASE);
    expect(refused.kind).toBe("retryable");
    expect(isRetryableOutcome(refused)).toBe(true);

    const retried = await deliverEmail(BASE);
    expect(retried.kind).toBe("acknowledged");
    // The refusal is recorded too — a failed attempt is evidence, not silence.
    const stored = recordedEmails();
    expect(stored.map((m) => m.result)).toEqual(["retryable", "acknowledged"]);
    expect(stored[1].attempt).toBe(2);
  });

  it("E08 — a scripted PERMANENT refusal is not retryable", async () => {
    scriptRecordingProviderFailure({
      kind: "permanent",
      errorCode: "provider_rejected_recipient",
      httpStatus: 422,
    });
    const outcome = await deliverEmail(BASE);
    expect(outcome.kind).toBe("permanent");
    expect(isRetryableOutcome(outcome)).toBe(false);
    expect(isAcknowledgedOutcome(outcome)).toBe(false);
  });

  it("E09 — an AMBIGUOUS outcome stays ambiguous — never delivered, never failed", async () => {
    scriptRecordingProviderFailure({
      kind: "ambiguous",
      errorCode: "provider_timeout",
    });
    const outcome = await deliverEmail(BASE);
    expect(outcome.kind).toBe("ambiguous");
    expect(isAcknowledgedOutcome(outcome)).toBe(false);
    // Retryable, because that is what the idempotency key is FOR.
    expect(isRetryableOutcome(outcome)).toBe(true);
    expect(recordedEmails()[0].result).toBe("ambiguous");
    expect(recordedEmails()[0].providerMessageId).toBeNull();
  });

  it("E10 — a send with no idempotency key is refused, exactly as the real path refuses it", async () => {
    const outcome = await deliverEmail({ ...BASE, idempotencyKey: "   " });
    expect(outcome).toEqual({
      kind: "permanent",
      errorCode: "missing_idempotency_key",
      httpStatus: 0,
    });
    expect(recordedEmails()).toEqual([]);
  });

  it("E11 — the stored record carries no raw recipient and no raw key", async () => {
    await deliverEmail(BASE);
    const serialised = JSON.stringify(recordedEmails());
    expect(serialised).not.toContain(BASE.to);
    expect(serialised).not.toContain(BASE.idempotencyKey);
    // The alias is derivable by anyone who already knows the address, which is
    // how a test finds its own message without the file holding one.
    expect(recordedEmails()[0].recipientAlias).toBe(recipientAliasFor(BASE.to));
  });

  it("E12 — two recipients never share a mailbox alias", async () => {
    await deliverEmail(BASE);
    await deliverEmail({
      ...BASE,
      to: "someone-else@test.proovra.local",
      idempotencyKey: "pv1_durable_intent_0003",
    });
    const [a, b] = recordedEmails();
    expect(a.recipientAlias).not.toBe(b.recipientAlias);
  });
});

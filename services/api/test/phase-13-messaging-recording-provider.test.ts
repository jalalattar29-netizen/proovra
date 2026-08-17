/**
 * PHASE 13 — the LOCAL RECORDING messaging provider.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * Publishing and unpublishing evidence to public verify are gated by
 * `requireStepUpForSensitiveAction`, and that gate is satisfied only by an
 * APPROVED challenge whose one-time code arrives over SMS or WhatsApp. Twilio
 * Verify generates that code on Twilio's side and never returns it, the Point-7
 * harness aborts all non-loopback egress by design, and `setMessagingProviderForTests`
 * is in-process and therefore invisible to the separate API process a browser
 * drives. So the messaging boundary was not merely unproven — it was
 * unreachable, and every journey behind it was skipped.
 *
 * The fix is a provider, not a bypass. This suite proves it behaves like one:
 * it accepts, it stores what it accepted, it collapses a duplicate on the
 * idempotency key the contract carries, and it refuses a wrong code, an expired
 * verification and an unknown one.
 *
 * It also proves the two negatives without which the fix would be a liability:
 *
 *   * The recorder CANNOT BE SELECTED IN PRODUCTION — twice over, at the
 *     resolver and at the constructor. A recording provider that a deployment
 *     could select would silently swallow real security codes.
 *   * With the variable UNSET, resolution is byte-for-byte what it is today,
 *     so no deployed default moves by omission.
 *
 * And it proves the privacy property the email recorder established: the
 * recipient never appears in the clear in a recorded line.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RecordingMessagingProvider,
  RecordingProviderNotPermittedError,
  isProductionRuntime,
  readRecordedMessageFile,
  recipientAliasForPhone,
  recordedMessages,
  resetRecordingMessagingProvider,
} from "../src/services/communications/recording-provider.js";
import {
  buildProviderHealthSnapshot,
  getMessagingProvider,
  resolveMessagingTransport,
  setMessagingProviderForTests,
} from "../src/services/communications/provider-registry.js";

const PHONE = "+15005550006";
const OTHER_PHONE = "+15005550007";

/**
 * Env restoration is explicit rather than snapshot-and-restore-the-world,
 * because the Point-7 bootstrap sets several of these BEFORE any module loads
 * and a wholesale `process.env = {...}` would silently discard the bootstrap's
 * containment for the rest of the file.
 */
function withEnv(
  overrides: Record<string, string | undefined>,
  body: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ===========================================================================
// P01–P05 — the production refusal. The most important property in the file.
// ===========================================================================

describe("PHASE 13 — the recorder cannot be selected in production", () => {
  afterEach(() => setMessagingProviderForTests(null));

  it("P01 — the resolver THROWS when a production process asks for the recorder", () => {
    withEnv(
      { NODE_ENV: "production", MESSAGING_TRANSPORT: "recording" },
      () => {
        expect(isProductionRuntime()).toBe(true);
        expect(() => resolveMessagingTransport()).toThrow(
          RecordingProviderNotPermittedError,
        );
      },
    );
  });

  it("P02 — the registry propagates that refusal; it never quietly serves the recorder", () => {
    withEnv(
      {
        NODE_ENV: "production",
        COMMUNICATIONS_ENABLED: "true",
        MESSAGING_TRANSPORT: "recording",
      },
      () => {
        setMessagingProviderForTests(null);
        // Loud, not silent. The ONLY way to reach this is a deployment that
        // explicitly set the variable, and a boot failure beats an OTP that
        // never arrives and no one notices.
        expect(() => getMessagingProvider()).toThrow(
          RecordingProviderNotPermittedError,
        );
      },
    );
  });

  it("P03 — the CLASS refuses to construct in production, independently of the resolver", () => {
    withEnv({ NODE_ENV: "production" }, () => {
      // A future registry edit, or a direct `new` in some other module, still
      // cannot obtain an instance. Two gates, neither relying on the other.
      expect(() => new RecordingMessagingProvider()).toThrow(
        RecordingProviderNotPermittedError,
      );
    });
  });

  it("P04 — the refusal is read at the moment of use, not frozen at import", () => {
    // A process that becomes production-shaped after this module loaded must
    // not keep the recorder by luck of ordering.
    withEnv({ NODE_ENV: "test" }, () => {
      expect(() => new RecordingMessagingProvider()).not.toThrow();
    });
    withEnv({ NODE_ENV: "production" }, () => {
      expect(() => new RecordingMessagingProvider()).toThrow(
        RecordingProviderNotPermittedError,
      );
    });
  });

  it("P05 — the refusal names itself, so an operator sees WHY the boot failed", () => {
    withEnv(
      { NODE_ENV: "production", MESSAGING_TRANSPORT: "recording" },
      () => {
        let raised: unknown = null;
        try {
          resolveMessagingTransport();
        } catch (err) {
          raised = err;
        }
        expect(raised).toBeInstanceOf(RecordingProviderNotPermittedError);
        expect((raised as RecordingProviderNotPermittedError).code).toBe(
          "recording_messaging_provider_forbidden_in_production",
        );
        // The message explains the consequence, not just the rule.
        expect(String((raised as Error).message)).toContain("one-time codes");
      },
    );
  });
});

// ===========================================================================
// D01–D05 — omission changes nothing.
// ===========================================================================

describe("PHASE 13 — an UNSET selection resolves exactly as it does today", () => {
  afterEach(() => setMessagingProviderForTests(null));

  it("D01 — unset resolves to the deployed transport", () => {
    withEnv({ MESSAGING_TRANSPORT: undefined }, () => {
      expect(resolveMessagingTransport()).toBe("twilio");
    });
  });

  it("D02 — an unrecognised value is not silently treated as the recorder", () => {
    withEnv({ MESSAGING_TRANSPORT: "definitely-not-a-transport" }, () => {
      expect(resolveMessagingTransport()).toBe("twilio");
    });
  });

  it("D03 — unset + production is not a refusal; production is only refused for the recorder", () => {
    withEnv({ NODE_ENV: "production", MESSAGING_TRANSPORT: undefined }, () => {
      expect(resolveMessagingTransport()).toBe("twilio");
    });
  });

  it("D04 — unset + feature off is still the historical Noop('feature_disabled')", () => {
    withEnv(
      { COMMUNICATIONS_ENABLED: "false", MESSAGING_TRANSPORT: undefined },
      () => {
        setMessagingProviderForTests(null);
        const p = getMessagingProvider();
        expect(p.provider).toBe("NOOP");
        expect(p.isConfigured()).toBe(false);
        expect(p.unconfiguredReason()).toBe("feature_disabled");
      },
    );
  });

  it("D05 — unset + feature on + Twilio incomplete is still the historical Noop", () => {
    withEnv(
      {
        COMMUNICATIONS_ENABLED: "true",
        MESSAGING_TRANSPORT: undefined,
        TWILIO_ACCOUNT_SID: "",
      },
      () => {
        setMessagingProviderForTests(null);
        const p = getMessagingProvider();
        expect(p.provider).toBe("NOOP");
        expect(p.isConfigured()).toBe(false);
      },
    );
  });

  it("D06 — naming the recorder is SUFFICIENT, exactly as EMAIL_TRANSPORT=recording is", () => {
    // No second flag is consulted. `MESSAGING_TRANSPORT=recording` is the
    // stronger, more specific statement, and it is unreachable in production.
    withEnv(
      { COMMUNICATIONS_ENABLED: undefined, MESSAGING_TRANSPORT: "recording" },
      () => {
        setMessagingProviderForTests(null);
        const p = getMessagingProvider();
        expect(p.provider).toBe("INTERNAL");
        expect(p.isConfigured()).toBe(true);
        // Reported honestly on the operator surface — never dressed up as a
        // configured Twilio deployment.
        const snap = buildProviderHealthSnapshot();
        expect(snap.provider).toBe("INTERNAL");
        expect(snap.configured).toBe(true);
      },
    );
  });
});

// ===========================================================================
// M01–M06 — it behaves like a provider on the SEND path.
// ===========================================================================

describe("PHASE 13 — the recorder accepts, stores and collapses duplicates", () => {
  let provider: RecordingMessagingProvider;

  beforeEach(() => {
    resetRecordingMessagingProvider();
    provider = new RecordingMessagingProvider();
  });
  afterEach(() => resetRecordingMessagingProvider());

  it("M01 — a send is ACCEPTED and the message is kept", async () => {
    const result = await provider.sendSms({
      toE164: PHONE,
      body: "Your Proovra verification code",
      externalId: "cm_durable_row_0001",
    });
    expect(result.ok).toBe(true);
    const stored = recordedMessages();
    expect(stored.length).toBe(1);
    expect(stored[0]!.kind).toBe("message");
    expect(stored[0]!.result).toBe("accepted");
    expect(stored[0]!.providerMessageId).toBeTruthy();
    expect(stored[0]!.attempt).toBe(1);
  });

  it("M02 — a repeat on the SAME key is the same message, not a second one", async () => {
    const input = {
      toE164: PHONE,
      body: "Your Proovra verification code",
      externalId: "cm_durable_row_0001",
    };
    const first = await provider.sendSms(input);
    const second = await provider.sendSms(input);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && second.ok && first.providerMessageId).toBe(
      second.ok ? second.providerMessageId : null,
    );
    // Exactly ONE accepted message; the retry is recorded as a collapse so a
    // failed attempt stays evidence rather than silence.
    const accepted = recordedMessages().filter((m) => m.result === "accepted");
    expect(accepted.length).toBe(1);
    expect(recordedMessages()[1]!.result).toBe("duplicate_collapsed");
    expect(recordedMessages()[1]!.attempt).toBe(2);
  });

  it("M03 — a DIFFERENT key is a different message", async () => {
    await provider.sendSms({ toE164: PHONE, body: "a", externalId: "row_1" });
    await provider.sendSms({ toE164: PHONE, body: "b", externalId: "row_2" });
    const accepted = recordedMessages().filter((m) => m.result === "accepted");
    expect(accepted.length).toBe(2);
    expect(new Set(accepted.map((m) => m.idempotencyAlias)).size).toBe(2);
  });

  it("M04 — an empty destination is REJECTED, exactly as a real provider rejects it", async () => {
    const result = await provider.sendSms({ toE164: "   ", body: "x" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(
      "provider_rejected_recipient",
    );
    expect(recordedMessages()[0]!.result).toBe("rejected");
  });

  it("M05 — a WhatsApp TEMPLATE send records which template was accepted", async () => {
    await provider.sendWhatsApp({
      toE164: PHONE,
      body: "",
      externalId: "row_tmpl",
      template: { contentSid: "HXtemplate123", variables: { "1": "Proovra" } },
    });
    expect(recordedMessages()[0]!.body).toBe("template:HXtemplate123");
    expect(recordedMessages()[0]!.channel).toBe("WHATSAPP");
  });

  it("M06 — an inbound callback is never authenticated, because there is no shared secret", () => {
    // Identical to Noop, for the identical reason: answering `true` would hand
    // an attacker a valid-signature response in exchange for nothing.
    expect(provider.verifyWebhookSignature()).toBe(false);
    expect(provider.parseDeliveryWebhook().kind).toBe("ignored");
  });
});

// ===========================================================================
// V01–V08 — the VERIFY path: the code becomes observable, and nothing else
// about the challenge gets easier.
// ===========================================================================

describe("PHASE 13 — the recorder mints a readable code without loosening the check", () => {
  let provider: RecordingMessagingProvider;

  beforeEach(() => {
    resetRecordingMessagingProvider();
    provider = new RecordingMessagingProvider();
  });
  afterEach(() => resetRecordingMessagingProvider());

  it("V01 — a verification start records the ONE-TIME CODE, which is the whole point", async () => {
    const started = await provider.startVerification({
      toE164: PHONE,
      channel: "SMS",
    });
    expect(started.ok).toBe(true);
    const entry = recordedMessages().find(
      (m) => m.kind === "verification_start",
    );
    expect(entry).toBeDefined();
    // Six digits, because that is what a user retypes off their phone.
    expect(entry!.code).toMatch(/^\d{6}$/);
    expect(entry!.providerVerificationSid).toBe(
      started.ok ? started.providerVerificationSid : null,
    );
  });

  it("V02 — the recorded code APPROVES the verification", async () => {
    const started = await provider.startVerification({
      toE164: PHONE,
      channel: "SMS",
    });
    const code = recordedMessages().find((m) => m.kind === "verification_start")!
      .code!;
    const checked = await provider.checkVerification({
      toE164: PHONE,
      code,
      providerVerificationSid: started.ok
        ? started.providerVerificationSid
        : null,
    });
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.providerStatus).toBe("approved");
  });

  it("V03 — a WRONG code is denied; the recorder is where a code can be READ, not where any code works", async () => {
    await provider.startVerification({ toE164: PHONE, channel: "SMS" });
    const real = recordedMessages().find((m) => m.kind === "verification_start")!
      .code!;
    const wrong = real === "000000" ? "111111" : "000000";
    const checked = await provider.checkVerification({
      toE164: PHONE,
      code: wrong,
    });
    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.reason).toBe("not_approved");
  });

  it("V04 — an approved verification cannot be approved twice", async () => {
    await provider.startVerification({ toE164: PHONE, channel: "SMS" });
    const code = recordedMessages().find((m) => m.kind === "verification_start")!
      .code!;
    expect((await provider.checkVerification({ toE164: PHONE, code })).ok).toBe(
      true,
    );
    // One code must not satisfy two challenges.
    const second = await provider.checkVerification({ toE164: PHONE, code });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe("verification_not_found");
  });

  it("V05 — a code minted for one recipient does not approve another's verification", async () => {
    await provider.startVerification({ toE164: PHONE, channel: "SMS" });
    const mine = recordedMessages().find((m) => m.kind === "verification_start")!
      .code!;
    const theirs = await provider.startVerification({
      toE164: OTHER_PHONE,
      channel: "SMS",
    });
    const checked = await provider.checkVerification({
      toE164: OTHER_PHONE,
      code: mine,
      providerVerificationSid: theirs.ok ? theirs.providerVerificationSid : null,
    });
    // A 1-in-1,000,000 collision would make this flaky; assert on the binding
    // instead by checking the two verifications are distinct rows.
    const starts = recordedMessages().filter(
      (m) => m.kind === "verification_start",
    );
    expect(starts.length).toBe(2);
    expect(starts[0]!.providerVerificationSid).not.toBe(
      starts[1]!.providerVerificationSid,
    );
    expect(starts[0]!.recipientAlias).not.toBe(starts[1]!.recipientAlias);
    if (starts[0]!.code !== starts[1]!.code) {
      expect(checked.ok).toBe(false);
    }
  });

  it("V06 — an unknown verification sid is not found, never approved", async () => {
    const checked = await provider.checkVerification({
      toE164: PHONE,
      code: "123456",
      providerVerificationSid: "rec_ver_does_not_exist",
    });
    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.reason).toBe(
      "verification_not_found",
    );
  });

  it("V07 — a repeated start reuses the pending verification rather than invalidating the code in the user's hand", async () => {
    const a = await provider.startVerification({
      toE164: PHONE,
      channel: "SMS",
    });
    const b = await provider.startVerification({
      toE164: PHONE,
      channel: "SMS",
    });
    expect(a.ok && b.ok && a.providerVerificationSid).toBe(
      b.ok ? b.providerVerificationSid : null,
    );
    const starts = recordedMessages().filter(
      (m) => m.kind === "verification_start",
    );
    expect(starts.length).toBe(2);
    expect(starts[1]!.result).toBe("duplicate_collapsed");
    expect(starts[0]!.code).toBe(starts[1]!.code);
  });

  it("V08 — a denial carries no code and no oracle in its message", async () => {
    await provider.startVerification({ toE164: PHONE, channel: "SMS" });
    const real = recordedMessages().find((m) => m.kind === "verification_start")!
      .code!;
    const checked = await provider.checkVerification({
      toE164: PHONE,
      code: real === "000000" ? "111111" : "000000",
    });
    expect(checked.ok).toBe(false);
    const serialised = JSON.stringify(checked);
    expect(serialised).not.toContain(real);
    expect(serialised).not.toContain(PHONE);
    // The recorded denial keeps no submitted code either — a guess per failed
    // attempt on disk buys nothing a test needs.
    const denial = recordedMessages().find((m) => m.result === "denied");
    expect(denial!.code).toBeNull();
  });
});

// ===========================================================================
// R01–R04 — the recipient is never stored in the clear.
// ===========================================================================

describe("PHASE 13 — the recorded line holds an alias, never a phone number", () => {
  let provider: RecordingMessagingProvider;

  beforeEach(() => {
    resetRecordingMessagingProvider();
    provider = new RecordingMessagingProvider();
  });
  afterEach(() => resetRecordingMessagingProvider());

  it("R01 — no send record contains the raw number or the raw idempotency key", async () => {
    await provider.sendSms({
      toE164: PHONE,
      body: "Your Proovra code",
      externalId: "cm_durable_row_0001",
    });
    const serialised = JSON.stringify(recordedMessages());
    expect(serialised).not.toContain(PHONE);
    expect(serialised).not.toContain("cm_durable_row_0001");
  });

  it("R02 — no verification record contains the raw number", async () => {
    await provider.startVerification({ toE164: PHONE, channel: "SMS" });
    const serialised = JSON.stringify(recordedMessages());
    expect(serialised).not.toContain(PHONE);
    // Not even the national-significant part, which is the piece that
    // identifies a person once the country code is guessed.
    expect(serialised).not.toContain(PHONE.slice(2));
  });

  it("R03 — the alias is derivable by anyone who already knows the number", async () => {
    await provider.startVerification({ toE164: PHONE, channel: "SMS" });
    // This is how the harness finds its own message without the file holding a
    // number, and it is the same derivation the email recorder uses.
    expect(recordedMessages()[0]!.recipientAlias).toBe(
      recipientAliasForPhone(PHONE),
    );
    expect(recipientAliasForPhone(PHONE)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("R04 — two recipients never share an alias", async () => {
    await provider.startVerification({ toE164: PHONE, channel: "SMS" });
    await provider.startVerification({ toE164: OTHER_PHONE, channel: "SMS" });
    const [a, b] = recordedMessages();
    expect(a!.recipientAlias).not.toBe(b!.recipientAlias);
  });
});

// ===========================================================================
// F01–F03 — the cross-process seam.
// ===========================================================================

describe("PHASE 13 — the recorder file is how the browser and the API meet", () => {
  const tmpFile = `.p7tmp/phase13-messaging-${process.pid}.jsonl`;

  beforeEach(() => resetRecordingMessagingProvider());
  afterEach(() => resetRecordingMessagingProvider());

  it("F01 — with MESSAGING_RECORDER_FILE set, a start is readable from the file", async () => {
    process.env["MESSAGING_RECORDER_FILE"] = tmpFile;
    try {
      const provider = new RecordingMessagingProvider();
      await provider.startVerification({ toE164: PHONE, channel: "SMS" });
      const fromFile = readRecordedMessageFile(tmpFile).filter(
        (m) => m.recipientAlias === recipientAliasForPhone(PHONE),
      );
      expect(fromFile.length).toBeGreaterThan(0);
      expect(fromFile[fromFile.length - 1]!.code).toMatch(/^\d{6}$/);
      // One JSON object per line, so a reader can tail it.
      expect(fromFile[0]!.kind).toBe("verification_start");
    } finally {
      delete process.env["MESSAGING_RECORDER_FILE"];
    }
  });

  it("F02 — the file line carries the alias, not the number", async () => {
    process.env["MESSAGING_RECORDER_FILE"] = tmpFile;
    try {
      const provider = new RecordingMessagingProvider();
      await provider.startVerification({ toE164: OTHER_PHONE, channel: "SMS" });
      const serialised = JSON.stringify(readRecordedMessageFile(tmpFile));
      expect(serialised).not.toContain(OTHER_PHONE);
    } finally {
      delete process.env["MESSAGING_RECORDER_FILE"];
    }
  });

  it("F03 — with the variable UNSET nothing is written, and the provider still answers", async () => {
    delete process.env["MESSAGING_RECORDER_FILE"];
    const provider = new RecordingMessagingProvider();
    const started = await provider.startVerification({
      toE164: PHONE,
      channel: "SMS",
    });
    // Evidence, not a dependency: the answer does not depend on the filesystem.
    expect(started.ok).toBe(true);
    expect(readRecordedMessageFile()).toEqual([]);
    expect(recordedMessages().length).toBe(1);
  });
});

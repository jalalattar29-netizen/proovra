/**
 * PHASE 13 — the LOCAL RECORDING messaging provider.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Two shipped capabilities — publishing and unpublishing evidence to public
 * verify — are gated by `requireStepUpForSensitiveAction`, and that gate is NOT
 * the account step-up the workspace routes use. It is satisfied only by an
 * APPROVED `StepUpChallenge`, and a challenge is approved only by submitting a
 * one-time code that arrived over SMS or WhatsApp.
 *
 * Before this file the messaging boundary had exactly two implementations:
 * Twilio and Noop. Neither can carry a local browser journey.
 *
 *   * Twilio Verify GENERATES the code on Twilio's side and never returns it,
 *     so even a run that was allowed to reach the network could not read the
 *     code back. And the Point-7 harness aborts all non-loopback egress by
 *     design, so the attempt is refused at the socket. That is CONTAINMENT, not
 *     a provider proof: the send never lands anywhere, the challenge stays
 *     PENDING, and the journey is skipped rather than exercised.
 *   * Noop refuses every send with `provider_unconfigured`, which makes
 *     `startVerification` throw `feature_disabled` before a challenge row is
 *     ever created. Also a skip.
 *   * `setMessagingProviderForTests` cannot help either: it mutates a
 *     module-level variable IN THIS PROCESS, and a browser run drives a
 *     SEPARATE API process.
 *
 * This is the third implementation the boundary was missing, and it mirrors the
 * recording EMAIL provider (`packages/shared-runtime/src/notifications/
 * email-recording-provider.ts`) property for property: it is a real
 * implementation of the contract that ACKNOWLEDGES, STORES what it accepted,
 * and COLLAPSES a duplicate on the idempotency key the contract carries.
 *
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is not a step-up bypass. `requireStepUpForSensitiveAction` is untouched:
 * the route still demands a challenge that was STARTED by this user in this
 * session, APPROVED by a correct code, unexpired, purpose- and resource-bound,
 * and single-use. The ONLY thing that changes is that the code becomes locally
 * observable — through a provider that CANNOT EXIST IN PRODUCTION.
 *
 * It is not a stub that returns success. A stub that acknowledged without
 * storing would let a journey claim a message was delivered with nothing behind
 * it, which is the failure this pass exists to remove.
 *
 * WHY IT CANNOT EXIST IN PRODUCTION
 * ---------------------------------------------------------------------------
 * A recording provider that could be selected in a deployment would silently
 * swallow real security codes and write them to a file. That is the single
 * worst outcome available here, so it is refused twice, independently:
 *
 *   1. `resolveMessagingTransport()` (in `provider-registry.ts`) THROWS when
 *      `MESSAGING_TRANSPORT=recording` is seen under `NODE_ENV=production`.
 *   2. THIS CLASS refuses to construct under `NODE_ENV=production`, so a caller
 *      that reaches past the resolver — a future registry edit, a direct `new`
 *      in some other module — still cannot get an instance.
 *
 * Neither check is a startup-time constant: both read `NODE_ENV` at the moment
 * of use, so a process that becomes production-shaped cannot keep an instance
 * it obtained earlier by luck of ordering.
 *
 * WHAT IT WRITES, AND WHERE
 * ---------------------------------------------------------------------------
 * The recipient is NEVER stored in the clear. It is stored as a truncated
 * SHA-256 alias, derived exactly as the email recorder derives its recipient
 * alias, so the harness helper can be written the same way: a test that already
 * knows the number can find its own message, and the file itself holds no
 * phone number.
 *
 * The one-time CODE is stored, because that is the entire point — the browser
 * journey has to complete the challenge the way a user does. That is why the
 * file lives under the run's temp directory, is named by `MESSAGING_RECORDER_FILE`,
 * is owned by the harness, is never part of the application's data, and why the
 * provider cannot be selected in production at all.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CommunicationChannel } from "@proovra/shared";

import type {
  MessagingProvider,
  ParsedWebhook,
  ProviderSendInput,
  ProviderSendResult,
  ProviderVerifyCheckInput,
  ProviderVerifyCheckResult,
  ProviderVerifyStartInput,
  ProviderVerifyStartResult,
} from "./provider.js";

// ===========================================================================
// Production refusal
// ===========================================================================

/**
 * Raised when the recorder is asked for in a production-shaped process.
 *
 * A distinct class rather than a bare `Error` so the registry test can assert
 * WHICH refusal fired, and so a future caller cannot catch it by accident while
 * meaning to catch something else.
 */
export class RecordingProviderNotPermittedError extends Error {
  readonly code = "recording_messaging_provider_forbidden_in_production";
  constructor(where: string) {
    super(
      `The recording messaging provider cannot be used in production (${where}). ` +
        "It stores one-time codes locally; selecting it in a deployment would " +
        "swallow real security codes.",
    );
    this.name = "RecordingProviderNotPermittedError";
  }
}

/**
 * Read at the moment of use, never cached.
 *
 * `NODE_ENV` is the same predicate `config/index.ts` uses (`PROD()`), so there
 * is one notion of "production" in this service and not two.
 */
export function isProductionRuntime(): boolean {
  return (process.env["NODE_ENV"] ?? "").trim().toLowerCase() === "production";
}

// ===========================================================================
// Recorded shape
// ===========================================================================

export type RecordedMessageKind =
  | "message"
  | "verification_start"
  | "verification_check";

/**
 * One recorded interaction with the messaging boundary.
 *
 * Shaped so a browser test can find ITS interaction without the recorder having
 * to know anything about tenancy: it looks up by recipient alias, which the
 * test derives from the number it registered.
 */
export type RecordedMessage = {
  kind: RecordedMessageKind;
  channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">;
  /** `sha256(e164)`, truncated. The number itself is never written. */
  recipientAlias: string;
  /**
   * `sha256(idempotency key)`, truncated. For a send that is the caller's
   * `externalId`; for a verification it is the provider verification sid.
   * The raw value is not written for sends, because it is a durable row id.
   */
  idempotencyAlias: string;
  /** 1 for the first interaction on a key, 2 for the first retry, and so on. */
  attempt: number;
  result:
    | "accepted"
    | "duplicate_collapsed"
    | "rejected"
    | "pending"
    | "approved"
    | "denied";
  providerMessageId: string | null;
  providerVerificationSid: string | null;
  /**
   * The ONE-TIME CODE — present ONLY on `verification_start`.
   *
   * This is the "test mailbox" handle for the step-up journey: the spec reads
   * it back and submits it to `POST /v1/identity-security/step-up/:id/verify`
   * the way a user retypes it off their phone. That is the difference between
   * proving the publish gate and asserting that a row exists.
   *
   * A `verification_check` deliberately records `null` here. The submitted code
   * adds nothing a test needs and would put a guess on disk for every failed
   * attempt.
   */
  code: string | null;
  /** Message body — bounded. Empty for verifications; Verify has no body. */
  body: string;
  atUtc: string;
};

// ===========================================================================
// Aliasing
// ===========================================================================

function alias(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Recipient alias, computed the same way on BOTH sides of the process seam.
 *
 * Identical formula to `recipientAliasFor` in the email recorder (trim,
 * lowercase, sha256, first 16 hex chars) so `e2e/point7/_harness.ts` can carry
 * one aliasing idea rather than two. E.164 has no letters, so the lowercasing
 * is a no-op in practice and present only to keep the two derivations the same
 * function.
 */
export function recipientAliasForPhone(e164: string): string {
  return alias(e164.trim().toLowerCase());
}

// ===========================================================================
// State
// ===========================================================================

/** Matches `VERIFICATION_TTL_SECONDS` in verification.service.ts. */
const VERIFICATION_TTL_MS = 10 * 60 * 1000;

/**
 * Bound on provider-side check attempts.
 *
 * `verification.service.ts` already bounds checks at 5 per attempt row; this is
 * a second, independent bound so a caller that bypasses the service still
 * cannot brute-force a six-digit code out of the recorder.
 */
const MAX_PROVIDER_CHECK_ATTEMPTS = 10;

/** The denial vocabulary `checkVerification` is allowed to answer with. */
type VerifyCheckDenialReason = Extract<
  ProviderVerifyCheckResult,
  { ok: false }
>["reason"];

type PendingVerification = {
  sid: string;
  recipientAlias: string;
  channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">;
  code: string;
  expiresAtMs: number;
  checkAttempts: number;
  status: "pending" | "approved";
};

const RECORDED: RecordedMessage[] = [];
/** Attempt counter, keyed by idempotency alias — this is what a provider does. */
const ATTEMPTS = new Map<string, number>();
/** Accepted sends, keyed by idempotency alias, for duplicate collapse. */
const ACCEPTED = new Map<string, string>();
/** Live verifications, keyed by provider verification sid. */
const VERIFICATIONS = new Map<string, PendingVerification>();

/** Drop everything this process recorded. Suites call it between cases. */
export function resetRecordingMessagingProvider(): void {
  RECORDED.length = 0;
  ATTEMPTS.clear();
  ACCEPTED.clear();
  VERIFICATIONS.clear();
}

/** Everything this process has recorded, oldest first. */
export function recordedMessages(): ReadonlyArray<RecordedMessage> {
  return RECORDED.slice();
}

/**
 * The local durable file, when one is configured.
 *
 * A browser run drives the API in a DIFFERENT process, so an in-memory recorder
 * alone would be invisible to the test — the same seam the email recorder
 * crosses with `EMAIL_RECORDER_FILE`. `MESSAGING_RECORDER_FILE` is how the two
 * meet: append-only JSONL under the run's temp directory, owned by the harness,
 * never part of the application's data.
 */
function recorderFile(): string | null {
  const raw = process.env["MESSAGING_RECORDER_FILE"];
  return raw && raw.trim() ? raw.trim() : null;
}

function persist(entry: RecordedMessage): void {
  const file = recorderFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Evidence, not a dependency: an unwritable path must not change what the
    // provider answers, or a test would be observing the filesystem instead of
    // the boundary.
  }
}

function record(entry: RecordedMessage): void {
  RECORDED.push(entry);
  persist(entry);
}

/** Read back what any process wrote to the configured recorder file. */
export function readRecordedMessageFile(file?: string): RecordedMessage[] {
  const path = file ?? recorderFile();
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedMessage);
}

// ===========================================================================
// Code generation + comparison
// ===========================================================================

/**
 * Six digits from the CSPRNG.
 *
 * `randomInt` rather than `Math.random` even here: the recorder is a local
 * artefact, but a predictable code would make the step-up journey prove
 * something weaker than the journey it is standing in for.
 */
function mintCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Length-safe constant-time comparison. */
function codesMatch(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ===========================================================================
// The provider
// ===========================================================================

export class RecordingMessagingProvider implements MessagingProvider {
  /**
   * `INTERNAL`, not a new enum member.
   *
   * `CommunicationProvider` is a PostgreSQL enum (`prisma/schema.prisma`), and
   * persisted rows carry it. Minting a `RECORDING` value would mean a migration
   * on a production database purely to name something production can never
   * run — so the recorder reuses the existing `INTERNAL` value, which already
   * means "handled inside this deployment rather than by a vendor".
   */
  readonly provider = "INTERNAL" as const;

  constructor() {
    // Second, independent refusal. The resolver is the gate a normal caller
    // meets; this is the one a future direct `new` meets.
    if (isProductionRuntime()) {
      throw new RecordingProviderNotPermittedError("RecordingMessagingProvider constructor");
    }
  }

  /**
   * TRUE — and that is the whole point.
   *
   * `startVerification` in verification.service.ts throws `feature_disabled`
   * when the provider reads as unconfigured, which removes the challenge
   * lifecycle from the run rather than exercising it. A recorder that reported
   * itself unconfigured would be Noop with extra steps.
   */
  isConfigured(): boolean {
    return true;
  }

  unconfiguredReason(): string | null {
    return null;
  }

  async sendSms(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.send(input, "SMS");
  }

  async sendWhatsApp(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.send(input, "WHATSAPP");
  }

  /**
   * Accept, store, and collapse a duplicate.
   *
   * The idempotency key this contract carries is `externalId` — the caller's
   * durable `CommunicationMessage.id`, which `communication.service.ts` passes
   * on every send. A repeat on the SAME key is answered with the SAME provider
   * message id and is NOT stored as a second message, exactly as a provider
   * honouring an idempotency key behaves, which is what makes "a duplicate send
   * produces no duplicate effect" a real assertion rather than a hope.
   *
   * A send with no `externalId` is accepted (the contract makes it optional and
   * Twilio would accept it) but cannot be deduplicated, and its record says so
   * by carrying the alias of a per-send synthetic key.
   */
  private send(
    input: ProviderSendInput,
    channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">,
  ): ProviderSendResult {
    const recipient = (input.toE164 ?? "").trim();
    if (!recipient) {
      // The real providers reject an empty destination; so does this one. A
      // recorder that accepted it would hide a caller bug.
      record({
        kind: "message",
        channel,
        recipientAlias: recipientAliasForPhone(""),
        idempotencyAlias: alias(input.externalId ?? "no-recipient"),
        attempt: 1,
        result: "rejected",
        providerMessageId: null,
        providerVerificationSid: null,
        code: null,
        body: "",
        atUtc: new Date().toISOString(),
      });
      return {
        ok: false,
        provider: this.provider,
        channel,
        reason: "provider_rejected_recipient",
        errorCode: "missing_recipient",
        errorMessage: "No destination number supplied.",
      };
    }

    const key = (input.externalId ?? "").trim();
    const idempotencyAlias = key
      ? alias(key)
      : alias(`no-external-id:${randomBytes(16).toString("hex")}`);
    const attempt = (ATTEMPTS.get(idempotencyAlias) ?? 0) + 1;
    ATTEMPTS.set(idempotencyAlias, attempt);

    const already = ACCEPTED.get(idempotencyAlias);
    if (already) {
      record({
        kind: "message",
        channel,
        recipientAlias: recipientAliasForPhone(recipient),
        idempotencyAlias,
        attempt,
        result: "duplicate_collapsed",
        providerMessageId: already,
        providerVerificationSid: null,
        code: null,
        body: "",
        atUtc: new Date().toISOString(),
      });
      return {
        ok: true,
        providerMessageId: already,
        provider: this.provider,
        channel,
        status: "SENT",
        sentAtUtc: new Date(),
      };
    }

    const providerMessageId = `rec_msg_${idempotencyAlias}`;
    ACCEPTED.set(idempotencyAlias, providerMessageId);
    record({
      kind: "message",
      channel,
      recipientAlias: recipientAliasForPhone(recipient),
      idempotencyAlias,
      attempt,
      result: "accepted",
      providerMessageId,
      providerVerificationSid: null,
      // WhatsApp template sends carry no free-form body; record the ContentSid
      // instead so the record still says WHICH message was accepted.
      code: null,
      body: (input.template?.contentSid
        ? `template:${input.template.contentSid}`
        : (input.body ?? "")
      ).slice(0, 500),
      atUtc: new Date().toISOString(),
    });

    return {
      ok: true,
      providerMessageId,
      provider: this.provider,
      channel,
      // SENT, not QUEUED: the recorder HAS handed the message off — to the
      // recorder file, which is where a local run's "carrier" lives. Reporting
      // QUEUED would leave every local row waiting forever for a status webhook
      // that this provider cannot authenticate and therefore never sends.
      status: "SENT",
      sentAtUtc: new Date(),
    };
  }

  /**
   * Mint a code locally and record it.
   *
   * This is the capability Twilio Verify cannot provide: Verify generates the
   * code on its own side and the API never sees it, so nothing local can read
   * it back and no browser journey can complete the challenge.
   *
   * DUPLICATE COLLAPSE. An unexpired PENDING verification for the same
   * recipient is returned AGAIN — same sid, same code — rather than minting a
   * second one. That is Verify's own behaviour for a repeated start, and it is
   * what stops a re-render of the challenge screen from invalidating the code
   * the user is already reading off their phone.
   */
  async startVerification(
    input: ProviderVerifyStartInput,
  ): Promise<ProviderVerifyStartResult> {
    const recipient = (input.toE164 ?? "").trim();
    if (!recipient) {
      return {
        ok: false,
        provider: this.provider,
        reason: "provider_rejected_recipient",
        errorCode: "missing_recipient",
        errorMessage: "No destination number supplied.",
      };
    }
    const who = recipientAliasForPhone(recipient);
    const now = Date.now();

    const existing = [...VERIFICATIONS.values()].find(
      (v) =>
        v.recipientAlias === who &&
        v.status === "pending" &&
        v.expiresAtMs > now,
    );
    const verification: PendingVerification = existing ?? {
      sid: `rec_ver_${alias(`${who}:${now}:${randomBytes(16).toString("hex")}`)}`,
      recipientAlias: who,
      channel: input.channel,
      code: mintCode(),
      expiresAtMs: now + VERIFICATION_TTL_MS,
      checkAttempts: 0,
      status: "pending",
    };
    VERIFICATIONS.set(verification.sid, verification);

    const attempt = (ATTEMPTS.get(verification.sid) ?? 0) + 1;
    ATTEMPTS.set(verification.sid, attempt);

    record({
      kind: "verification_start",
      channel: input.channel,
      recipientAlias: who,
      idempotencyAlias: alias(verification.sid),
      attempt,
      result: existing ? "duplicate_collapsed" : "pending",
      providerMessageId: null,
      providerVerificationSid: verification.sid,
      code: verification.code,
      body: "",
      atUtc: new Date().toISOString(),
    });

    return {
      ok: true,
      provider: this.provider,
      providerVerificationSid: verification.sid,
      providerStatus: "pending",
    };
  }

  /**
   * Check a submitted code against the one this provider minted.
   *
   * Nothing here is looser than Verify. A wrong code is `not_approved`, an
   * elapsed TTL is `verification_expired`, an unknown sid is
   * `verification_not_found`, an already-approved verification cannot be
   * re-approved, and the comparison is constant time. The recorder is the place
   * the code can be READ, not a place where any code will do.
   */
  async checkVerification(
    input: ProviderVerifyCheckInput,
  ): Promise<ProviderVerifyCheckResult> {
    const recipient = (input.toE164 ?? "").trim();
    const who = recipientAliasForPhone(recipient);
    const now = Date.now();

    const verification = input.providerVerificationSid
      ? VERIFICATIONS.get(input.providerVerificationSid)
      : [...VERIFICATIONS.values()]
          .filter((v) => v.recipientAlias === who && v.status === "pending")
          .pop();

    if (!verification || verification.recipientAlias !== who) {
      return this.checkFailure(who, null, "verification_not_found");
    }
    if (verification.status !== "pending") {
      // An approved verification is spent. Re-approving it would let one code
      // satisfy two challenges.
      return this.checkFailure(who, verification.channel, "verification_not_found");
    }
    if (verification.expiresAtMs <= now) {
      return this.checkFailure(who, verification.channel, "verification_expired");
    }
    verification.checkAttempts += 1;
    if (verification.checkAttempts > MAX_PROVIDER_CHECK_ATTEMPTS) {
      return this.checkFailure(who, verification.channel, "not_approved");
    }
    if (!codesMatch(verification.code, (input.code ?? "").trim())) {
      return this.checkFailure(who, verification.channel, "not_approved");
    }

    verification.status = "approved";
    record({
      kind: "verification_check",
      channel: verification.channel,
      recipientAlias: who,
      idempotencyAlias: alias(verification.sid),
      attempt: verification.checkAttempts,
      result: "approved",
      providerMessageId: null,
      providerVerificationSid: verification.sid,
      code: null,
      body: "",
      atUtc: new Date().toISOString(),
    });
    return { ok: true, provider: this.provider, providerStatus: "approved" };
  }

  // Narrowed from the shared contract so the compiler, not a comment, keeps
  // this provider inside the denial vocabulary the caller already handles.


  private checkFailure(
    who: string,
    channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP"> | null,
    reason: VerifyCheckDenialReason,
  ): ProviderVerifyCheckResult {
    record({
      kind: "verification_check",
      // A not-found verification has no channel to report; SMS is the
      // contract's default channel and the field is descriptive, not decisive.
      channel: channel ?? "SMS",
      recipientAlias: who,
      idempotencyAlias: alias(`denied:${who}`),
      attempt: 0,
      result: "denied",
      providerMessageId: null,
      providerVerificationSid: null,
      code: null,
      body: "",
      atUtc: new Date().toISOString(),
    });
    return {
      ok: false,
      provider: this.provider,
      reason,
      errorCode: reason,
      // Deliberately generic and code-free: verification.service.ts already
      // refuses to be an oracle for code guessing, and this must not become
      // one behind its back.
      errorMessage: "Verification could not be approved.",
    };
  }

  /**
   * Always FALSE — the same answer Noop gives, for the same reason.
   *
   * The recorder holds no shared secret, so it cannot authenticate a callback.
   * Returning true would hand an attacker a "valid signature" response, which
   * would be a real weakening of the webhook boundary in exchange for nothing:
   * no local journey needs an inbound provider callback.
   */
  verifyWebhookSignature(): boolean {
    return false;
  }

  parseDeliveryWebhook(): ParsedWebhook {
    return { kind: "ignored", reason: "recording_provider" };
  }
}

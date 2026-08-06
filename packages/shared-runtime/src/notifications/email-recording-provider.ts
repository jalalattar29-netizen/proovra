/**
 * PHASE 12 — POINT 7 (final pass): the LOCAL RECORDING email provider.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The corrected Point-7 browser run recorded eighteen BLOCKED attempts to
 * `api.resend.com`. The outbound guard did its job — nothing left the machine —
 * but a blocked attempt at a real provider is containment, not proof. It means
 * the product's email boundary was never actually exercised: every journey that
 * depended on a message being accepted got an `ambiguous` outcome from a
 * refused socket, and any test that looked green around it was green for the
 * wrong reason.
 *
 * A recording provider is the substitute the runs were missing. It is a real
 * implementation of the transport contract that ACKNOWLEDGES a message and
 * keeps it, so the durable delivery state machine runs its true path, retries
 * collapse on the idempotency key the way a provider would collapse them, and
 * a browser test can open the link a recipient would have opened.
 *
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is not a stub that returns success. A stub returning `acknowledged`
 * without keeping the message would let a journey claim delivery with nothing
 * behind it, which is the failure this pass exists to remove. Every send is
 * stored, retrievable, and attributable, and a caller can make it refuse.
 *
 * WHAT IT MUST NEVER HOLD
 * ---------------------------------------------------------------------------
 * The API key. It never receives one and never reads one.
 *
 * It DOES hold the rendered message, including any actionable link, because
 * that is what a mailbox is and browser journeys have to open it. That is why
 * it writes only to a local, test-owned file under the run's temp directory,
 * and why the OUTBOUND LEDGER — a different artifact with different rules —
 * carries no link, recipient or payload of any kind.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EmailDeliveryOutcome, EmailDeliveryRequest } from "./email-transport.js";

/**
 * One recorded send attempt.
 *
 * Shaped so a browser test can find its message without the recorder having to
 * know anything about tenancy: it looks up by recipient alias, which the test
 * derives from the address it registered.
 */
export type RecordedEmail = {
  /** The caller's DURABLE delivery intent, when it supplied one. */
  deliveryIntentId: string | null;
  /** Which message this is — invite, verification, digest. */
  templateKind: string | null;
  /** `sha256(recipient)`, truncated. The raw address is never written. */
  recipientAlias: string;
  /** `sha256(idempotencyKey)`, truncated. The key itself is never written. */
  idempotencyAlias: string;
  /** 1 for the first send of a key, 2 for the first retry, and so on. */
  attempt: number;
  /** What the provider answered. Mirrors `EmailDeliveryOutcome.kind`. */
  result: "acknowledged" | "retryable" | "permanent" | "ambiguous";
  /** The provider-assigned id, when it acknowledged. */
  providerMessageId: string | null;
  /** Subject line — bounded. Needed to tell one template from another. */
  subject: string;
  /**
   * The FIRST actionable link in the rendered message, if any.
   *
   * This is the "test mailbox" handle. A browser journey opens this instead of
   * reading a token out of the database, which is the difference between
   * proving the invitation flow and proving that a row exists.
   */
  actionableLink: string | null;
  atUtc: string;
};

/** How a scripted failure is expressed. */
export type RecordingProviderFailure =
  | { kind: "retryable"; errorCode: string; httpStatus: number | null }
  | { kind: "permanent"; errorCode: string; httpStatus: number }
  | { kind: "ambiguous"; errorCode: string };

function alias(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Recipient alias, computed the same way on both sides of the seam. */
export function recipientAliasFor(recipient: string): string {
  return alias(recipient.trim().toLowerCase());
}

/**
 * Pull the first http(s) link out of a rendered message.
 *
 * Text part first: it is the one that is not wrapped in markup, so a naive
 * extraction gets it right. HTML is the fallback.
 */
function extractActionableLink(request: EmailDeliveryRequest): string | null {
  const fromText = /https?:\/\/[^\s<>"')]+/.exec(request.text ?? "");
  if (fromText) return fromText[0];
  const fromHref = /href=["'](https?:\/\/[^"']+)["']/i.exec(request.html ?? "");
  if (fromHref) return fromHref[1] ?? null;
  const fromHtml = /https?:\/\/[^\s<>"')]+/.exec(request.html ?? "");
  return fromHtml ? fromHtml[0] : null;
}

// ===========================================================================
// State
// ===========================================================================

const RECORDED: RecordedEmail[] = [];
/** attempt counter, keyed by idempotency alias — this is what a provider does. */
const ATTEMPTS = new Map<string, number>();
/** Acknowledged sends, keyed by idempotency alias, for duplicate collapse. */
const ACKNOWLEDGED = new Map<string, string>();
let scriptedFailure: RecordingProviderFailure | null = null;

/** Make the next send fail in a named way. Cleared by {@link resetRecordingEmailProvider}. */
export function scriptRecordingProviderFailure(f: RecordingProviderFailure | null): void {
  scriptedFailure = f;
}

export function resetRecordingEmailProvider(): void {
  RECORDED.length = 0;
  ATTEMPTS.clear();
  ACKNOWLEDGED.clear();
  scriptedFailure = null;
}

/** Everything this process has recorded, oldest first. */
export function recordedEmails(): ReadonlyArray<RecordedEmail> {
  return RECORDED.slice();
}

/**
 * The local durable file, when one is configured.
 *
 * A browser run drives the API in a DIFFERENT process, so an in-memory
 * recorder alone would be invisible to the test. `EMAIL_RECORDER_FILE` is how
 * the two meet: append-only JSONL under the run's temp directory, owned by the
 * harness, never part of the application's data.
 */
function recorderFile(): string | null {
  const raw = process.env["EMAIL_RECORDER_FILE"];
  return raw && raw.trim() ? raw.trim() : null;
}

function persist(entry: RecordedEmail): void {
  const file = recorderFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Evidence, not a dependency: an unwritable path must not change what the
    // provider answers, or the test would be observing the filesystem.
  }
}

/** Read back what any process wrote to the configured recorder file. */
export function readRecordedEmailFile(file?: string): RecordedEmail[] {
  const path = file ?? recorderFile();
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedEmail);
}

// ===========================================================================
// The provider
// ===========================================================================

/**
 * Deliver through the recorder.
 *
 * Behaviour that matters, and why:
 *
 *   * The attempt counter is keyed by IDEMPOTENCY KEY, so a retry is visibly a
 *     retry rather than a second message.
 *   * A key that has already been acknowledged is acknowledged AGAIN with the
 *     SAME provider message id and is not stored twice — which is exactly what
 *     a provider honouring an idempotency key does, and is what makes
 *     "duplicate send produces no duplicate effect" a real assertion.
 *   * A scripted failure is consumed once, so a suite can prove that a retry
 *     after a refusal succeeds.
 */
export async function deliverEmailViaRecorder(
  request: EmailDeliveryRequest & {
    meta?: { deliveryIntentId?: string | null; templateKind?: string | null };
  },
): Promise<EmailDeliveryOutcome> {
  const key = (request.idempotencyKey ?? "").trim();
  if (!key) {
    // Identical refusal to the real provider path: a send with no durable
    // intent behind it cannot be made retry-safe.
    return { kind: "permanent", errorCode: "missing_idempotency_key", httpStatus: 0 };
  }

  const idempotencyAlias = alias(key);
  const attempt = (ATTEMPTS.get(idempotencyAlias) ?? 0) + 1;
  ATTEMPTS.set(idempotencyAlias, attempt);

  const already = ACKNOWLEDGED.get(idempotencyAlias);
  if (already) {
    return { kind: "acknowledged", providerMessageId: already, httpStatus: 200 };
  }

  if (scriptedFailure) {
    const failure = scriptedFailure;
    scriptedFailure = null;
    const entry: RecordedEmail = {
      deliveryIntentId: request.meta?.deliveryIntentId ?? null,
      templateKind: request.meta?.templateKind ?? null,
      recipientAlias: recipientAliasFor(request.to ?? ""),
      idempotencyAlias,
      attempt,
      result: failure.kind,
      providerMessageId: null,
      subject: (request.subject ?? "").slice(0, 200),
      actionableLink: null,
      atUtc: new Date().toISOString(),
    };
    RECORDED.push(entry);
    persist(entry);
    return failure.kind === "permanent"
      ? { kind: "permanent", errorCode: failure.errorCode, httpStatus: failure.httpStatus }
      : failure.kind === "retryable"
        ? { kind: "retryable", errorCode: failure.errorCode, httpStatus: failure.httpStatus }
        : { kind: "ambiguous", errorCode: failure.errorCode };
  }

  const providerMessageId = `rec_${idempotencyAlias}`;
  ACKNOWLEDGED.set(idempotencyAlias, providerMessageId);

  const entry: RecordedEmail = {
    deliveryIntentId: request.meta?.deliveryIntentId ?? null,
    templateKind: request.meta?.templateKind ?? null,
    recipientAlias: recipientAliasFor(request.to ?? ""),
    idempotencyAlias,
    attempt,
    result: "acknowledged",
    providerMessageId,
    subject: (request.subject ?? "").slice(0, 200),
    actionableLink: extractActionableLink(request),
    atUtc: new Date().toISOString(),
  };
  RECORDED.push(entry);
  persist(entry);

  return { kind: "acknowledged", providerMessageId, httpStatus: 200 };
}

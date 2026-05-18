import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_PROVIDERS,
  COMMUNICATION_PURPOSES,
  COMMUNICATION_RETRY_MAX_ATTEMPTS,
  COMMUNICATION_STATUSES,
  VERIFICATION_ATTEMPT_STATUSES,
  appendStopFooter,
  classifyCommunicationProviderError,
  communicationRetryDelaySeconds,
  isCriticalCommunicationPurpose,
  isPhoneChannel,
  isRetryEligibleCommunicationPurpose,
  isTerminalCommunicationStatus,
  maskPhonePreview,
  normaliseToE164,
  parseInboundCommand,
  renderContributorClarificationSmsBody,
  renderEvidenceRequestSmsBody,
  renderIntakeLinkSmsBody,
  renderReviewEscalationSmsBody,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("communication channels cover SMS/WhatsApp/Email/System", () => {
  assert.deepEqual([...COMMUNICATION_CHANNELS].sort(), [
    "EMAIL",
    "SMS",
    "SYSTEM",
    "WHATSAPP",
  ]);
});

test("communication directions are exactly OUTBOUND/INBOUND", () => {
  assert.deepEqual([...COMMUNICATION_DIRECTIONS].sort(), [
    "INBOUND",
    "OUTBOUND",
  ]);
});

test("communication purposes cover the Phase 18 brief", () => {
  for (const p of [
    "OTP",
    "EVIDENCE_REQUEST",
    "INTAKE_LINK",
    "REVIEW_ESCALATION",
    "REVIEW_REMINDER",
    "CONTRIBUTOR_CLARIFICATION",
    "COLLABORATION_MENTION",
    "GOVERNANCE_ALERT",
    "SECURITY_ALERT",
  ]) {
    assert.ok(COMMUNICATION_PURPOSES.includes(p), p);
  }
});

test("communication statuses cover the lifecycle", () => {
  for (const s of [
    "QUEUED",
    "SENT",
    "DELIVERED",
    "FAILED",
    "UNDELIVERED",
    "RETRY_SCHEDULED",
    "CANCELLED",
    "RECEIVED",
  ]) {
    assert.ok(COMMUNICATION_STATUSES.includes(s), s);
  }
});

test("communication providers list Twilio + Noop + Resend + Internal", () => {
  assert.deepEqual([...COMMUNICATION_PROVIDERS].sort(), [
    "INTERNAL",
    "NOOP",
    "RESEND",
    "TWILIO",
  ]);
});

test("verification attempt statuses cover the OTP flow", () => {
  assert.deepEqual([...VERIFICATION_ATTEMPT_STATUSES].sort(), [
    "APPROVED",
    "CANCELLED",
    "DENIED",
    "EXPIRED",
    "FAILED",
    "STARTED",
  ]);
});

// -----------------------------------------------------------------------------
// Channel / purpose helpers
// -----------------------------------------------------------------------------

test("isPhoneChannel: SMS + WHATSAPP only", () => {
  assert.equal(isPhoneChannel("SMS"), true);
  assert.equal(isPhoneChannel("WHATSAPP"), true);
  assert.equal(isPhoneChannel("EMAIL"), false);
  assert.equal(isPhoneChannel("SYSTEM"), false);
});

test("isCriticalCommunicationPurpose: only OTP + SECURITY_ALERT", () => {
  assert.equal(isCriticalCommunicationPurpose("OTP"), true);
  assert.equal(isCriticalCommunicationPurpose("SECURITY_ALERT"), true);
  // Everything else MUST NOT bypass opt-out.
  for (const p of [
    "EVIDENCE_REQUEST",
    "INTAKE_LINK",
    "REVIEW_ESCALATION",
    "REVIEW_REMINDER",
    "CONTRIBUTOR_CLARIFICATION",
    "COLLABORATION_MENTION",
    "GOVERNANCE_ALERT",
    "PREFERENCE_UPDATE",
  ]) {
    assert.equal(isCriticalCommunicationPurpose(p), false, p);
  }
});

test("isRetryEligibleCommunicationPurpose: OTP is NEVER retried by the platform", () => {
  // Twilio Verify owns the OTP lifecycle; we must not generate a new
  // code on retry. The platform-level retry is bypassed for OTP.
  assert.equal(isRetryEligibleCommunicationPurpose("OTP"), false);
  // EVIDENCE_REQUEST is retry-eligible.
  assert.equal(
    isRetryEligibleCommunicationPurpose("EVIDENCE_REQUEST"),
    true,
  );
});

test("isTerminalCommunicationStatus: DELIVERED/FAILED/UNDELIVERED/CANCELLED/RECEIVED", () => {
  for (const s of [
    "DELIVERED",
    "FAILED",
    "UNDELIVERED",
    "CANCELLED",
    "RECEIVED",
  ]) {
    assert.equal(isTerminalCommunicationStatus(s), true, s);
  }
  assert.equal(isTerminalCommunicationStatus("QUEUED"), false);
  assert.equal(isTerminalCommunicationStatus("SENT"), false);
  assert.equal(isTerminalCommunicationStatus("RETRY_SCHEDULED"), false);
});

// -----------------------------------------------------------------------------
// Retry backoff + error classification
// -----------------------------------------------------------------------------

test("communicationRetryDelaySeconds: monotonic, bounded ladder", () => {
  assert.equal(communicationRetryDelaySeconds(1), 0);
  // Ladder: 60s, 5m, 30m, 2h
  assert.equal(communicationRetryDelaySeconds(2), 60);
  assert.equal(communicationRetryDelaySeconds(3), 300);
  assert.equal(communicationRetryDelaySeconds(4), 1800);
  assert.equal(communicationRetryDelaySeconds(5), 7200);
  assert.ok(communicationRetryDelaySeconds(99) >= 3600);
});

test("COMMUNICATION_RETRY_MAX_ATTEMPTS is a reasonable bound", () => {
  assert.equal(COMMUNICATION_RETRY_MAX_ATTEMPTS, 5);
});

test("classifyCommunicationProviderError flags transient codes", () => {
  for (const code of [
    "rate_limit",
    "503",
    "504",
    "timeout",
    "service_unavailable",
  ]) {
    assert.equal(
      classifyCommunicationProviderError(code, null),
      "transient",
      code,
    );
  }
});

test("classifyCommunicationProviderError defaults to permanent", () => {
  assert.equal(
    classifyCommunicationProviderError("21610", "Unsubscribed recipient"),
    "permanent",
  );
  assert.equal(classifyCommunicationProviderError(null, null), "permanent");
});

// -----------------------------------------------------------------------------
// E.164 normalisation
// -----------------------------------------------------------------------------

test("normaliseToE164 accepts already-E.164", () => {
  assert.equal(normaliseToE164("+14155551234"), "+14155551234");
});

test("normaliseToE164 strips whitespace, dashes, parentheses", () => {
  assert.equal(normaliseToE164("+1 (415) 555-1234"), "+14155551234");
  assert.equal(normaliseToE164("  +447700-900123  "), "+447700900123");
});

test("normaliseToE164 converts 00-prefix to +", () => {
  assert.equal(normaliseToE164("0044 7700 900 123"), "+447700900123");
});

test("normaliseToE164 rejects bare digits (no plus)", () => {
  assert.equal(normaliseToE164("14155551234"), null);
});

test("normaliseToE164 rejects letters or short digits", () => {
  assert.equal(normaliseToE164("+abc12345"), null);
  assert.equal(normaliseToE164("+12"), null);
  assert.equal(normaliseToE164(""), null);
  assert.equal(normaliseToE164(null), null);
  assert.equal(normaliseToE164(undefined), null);
});

// -----------------------------------------------------------------------------
// Phone masking
// -----------------------------------------------------------------------------

test("maskPhonePreview hides middle digits, preserves CC + last 4", () => {
  assert.equal(maskPhonePreview("+14155551234"), "+1 ••• ••• 1234");
  assert.equal(maskPhonePreview("+447700900123"), "+44 ••• ••• 0123");
});

test("maskPhonePreview never echoes the raw number", () => {
  const out = maskPhonePreview("+14155551234");
  assert.equal(out.includes("415"), false);
  assert.equal(out.includes("555"), false);
});

test("maskPhonePreview handles empty / short / malformed inputs safely", () => {
  assert.equal(maskPhonePreview(""), "");
  assert.equal(maskPhonePreview(null), "");
  assert.equal(maskPhonePreview(undefined), "");
});

// -----------------------------------------------------------------------------
// Message body templates — privacy contract
// -----------------------------------------------------------------------------

test("evidence request SMS body uses brief-mandated operational wording", () => {
  const body = renderEvidenceRequestSmsBody({
    workspaceName: "Acme Legal",
    intakeUrl: "https://example.com/intake/abc",
  });
  assert.match(body, /Acme Legal secure evidence request/);
  assert.match(body, /https:\/\/example\.com\/intake\/abc/);
  // Privacy contract — body must NOT include evidence titles,
  // instructions, reviewer notes, or legal-hold reasons.
  for (const forbidden of [
    "evidence title",
    "reviewer note",
    "legal hold",
    "redaction",
    "case file",
  ]) {
    assert.equal(body.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("intake link SMS body never reveals workflow internals", () => {
  const body = renderIntakeLinkSmsBody({
    workspaceName: "Acme",
    intakeUrl: "https://x.example.com/intake/zz",
  });
  assert.match(body, /Acme secure submission link/);
  assert.equal(body.toLowerCase().includes("workflow"), false);
  assert.equal(body.toLowerCase().includes("token"), false);
});

test("review escalation body is operational; never names the workflow", () => {
  const body = renderReviewEscalationSmsBody({ workspaceName: "Acme" });
  assert.match(body, /escalated/);
  assert.equal(body.toLowerCase().includes("workflow"), false);
});

test("contributor clarification body always carries the intake URL", () => {
  const body = renderContributorClarificationSmsBody({
    workspaceName: "Acme",
    intakeUrl: "https://x/intake/zz",
  });
  assert.match(body, /https:\/\//);
  assert.match(body, /more information/);
});

test("appendStopFooter is idempotent and bounded", () => {
  const original = "Acme: short body.";
  const once = appendStopFooter(original);
  assert.match(once, /Reply STOP/);
  // Second call must NOT double-append.
  const twice = appendStopFooter(once);
  assert.equal(twice, once);
});

test("appendStopFooter is a no-op when adding the footer would overflow", () => {
  // Build a body close to 280 chars so the footer cannot fit.
  const long = "X".repeat(279);
  const out = appendStopFooter(long);
  assert.equal(out, long, "must not append when overflow");
});

// -----------------------------------------------------------------------------
// Inbound STOP / START parsing
// -----------------------------------------------------------------------------

test("parseInboundCommand: STOP keywords map to STOP", () => {
  for (const word of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "CANCEL"]) {
    assert.equal(parseInboundCommand(word), "STOP", word);
  }
});

test("parseInboundCommand: START keywords map to START", () => {
  for (const word of ["START", "start", "YES", "UNSTOP"]) {
    assert.equal(parseInboundCommand(word), "START", word);
  }
});

test("parseInboundCommand: arbitrary text returns null", () => {
  assert.equal(parseInboundCommand("hi there"), null);
  assert.equal(parseInboundCommand(""), null);
  assert.equal(parseInboundCommand(null), null);
  assert.equal(parseInboundCommand(undefined), null);
});

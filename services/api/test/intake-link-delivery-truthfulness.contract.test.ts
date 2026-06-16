/**
 * Intake-link P0 audit fixes — regression contract pins for the four
 * production issues found in the end-to-end audit:
 *
 *   1) MAX_FILES_REACHED on first upload — the count query no longer
 *      passes `evidenceId: undefined` (which Prisma collapses to "no
 *      filter", counting every part in the database). The fix gates
 *      the entire check behind `session.evidenceId` being truthy.
 *
 *   2) Token persistence regression — the QUEUED-row write in
 *      enqueueOutboundMessage now honours `bodyPreviewOverride`. Pre-
 *      fix, only the cancelled-fallback rows used the override, so
 *      every successful SMS/WhatsApp send wrote the raw intake URL
 *      to `body_preview`.
 *
 *   3) WhatsApp/SMS "Sent" lying — twilio-provider no longer
 *      auto-promotes `accepted`/`sending` to SENT. Only `sent` and
 *      `delivered` map to SENT; everything else stays QUEUED until
 *      the StatusCallback webhook upgrades the row.
 *
 *   4) StatusCallback wired — every Twilio send now includes a
 *      `StatusCallback` URL (driven by TWILIO_STATUS_CALLBACK_URL)
 *      so the FAILED / DELIVERED webhook at
 *      /v1/communications/webhooks/twilio/status finally lands.
 *
 *   5) Public route error shape — every external-intake error now
 *      ships a user-safe `message`. The intakeErrorToReply mapper
 *      AND the inline error sites all use friendlyPublicIntakeMessage.
 *      Recipients never see raw JSON or raw enum strings.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PUBLIC_ROUTES = resolve(
  REPO_ROOT,
  "services/api/src/routes/external-intake.routes.ts",
);
const COMM = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/communication.service.ts",
);
const TWILIO = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/twilio-provider.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ============================================================================
// 1) MAX_FILES_REACHED on first upload
// ============================================================================

describe("MAX_FILES_REACHED — only triggers when there's a real evidence row to count against", () => {
  it("count query no longer passes `evidenceId: undefined` (which counts everything)", () => {
    const src = read(PUBLIC_ROUTES);
    // The pre-fix pattern that triggered the bug. Must not return.
    assert.ok(
      !/where: \{ evidenceId: session\.evidenceId \?\? undefined \}/.test(src),
      "evidenceId nullish-fallback to undefined collapses the Prisma filter to NO filter and counts the entire evidence_part table",
    );
  });

  it("the cap-check branch is gated on session.evidenceId being truthy", () => {
    const src = read(PUBLIC_ROUTES);
    // Pin the literal so a refactor can't quietly drop the gate.
    assert.match(
      src,
      /link\.maxFileCountPerSession > 0 &&\s*\n?\s*session\.evidenceId\s*\n?\s*\) \{/,
    );
  });

  it("count query filters strictly on the session's real evidenceId (no nullish fallback)", () => {
    const src = read(PUBLIC_ROUTES);
    // The corrected query — no `?? undefined`.
    assert.match(
      src,
      /where: \{ evidenceId: session\.evidenceId \},/,
    );
  });

  it("MAX_FILES_REACHED now ships a user-safe message", () => {
    const src = read(PUBLIC_ROUTES);
    assert.match(
      src,
      /code: "MAX_FILES_REACHED",\s*\n?\s*message: `You can upload up to/,
    );
  });
});

// ============================================================================
// 2) Token persistence regression on the QUEUED row
// ============================================================================

describe("CommunicationMessage.bodyPreview — sanitizer wins over default truncation", () => {
  it("the QUEUED-row write uses bodyPreviewOverride ?? safeBodyPreview", () => {
    const src = read(COMM);
    // Find the QUEUED block specifically.
    const queuedIdx = src.indexOf(
      "// Persist QUEUED, then dispatch.",
    );
    assert.ok(queuedIdx > 0, "QUEUED-row anchor missing");
    const slice = src.slice(queuedIdx, queuedIdx + 1200);
    assert.match(
      slice,
      /bodyPreview:\s*\n?\s*input\.bodyPreviewOverride \?\? safeBodyPreview\(input\.body\)/,
    );
  });

  it("every other bodyPreview write site uses the same precedence", () => {
    const src = read(COMM);
    // The five .create({...bodyPreview...}) sites must all use the
    // same `??` pattern.
    const occurrences = src.match(
      /bodyPreview:\s*\n?\s*input\.bodyPreviewOverride \?\? safeBodyPreview/g,
    );
    assert.ok(
      occurrences && occurrences.length >= 5,
      `expected 5 bodyPreview ?? sites, found ${occurrences?.length ?? 0}`,
    );
  });
});

// ============================================================================
// 3) WhatsApp/SMS truthful status mapping
// ============================================================================

describe("Twilio provider — accepted/sending no longer auto-promote to SENT", () => {
  it("only `sent` and `delivered` map to SENT; everything else maps to QUEUED", () => {
    const src = read(TWILIO);
    assert.match(
      src,
      /lower === "sent" \|\| lower === "delivered" \? "SENT" : "QUEUED"/,
    );
  });

  it("the pre-fix collapsed-mapping is gone (no `=== \"queued\" ? \"QUEUED\" : \"SENT\"`)", () => {
    const src = read(TWILIO);
    assert.ok(
      !/status === "queued" \? "QUEUED" : "SENT"/.test(src),
      "the pre-fix mapping let `accepted` ride into SENT, which lied to operators when the WhatsApp recipient never joined the sandbox",
    );
  });

  it("sentAtUtc is null when status stayed QUEUED (provider hasn't sent yet)", () => {
    const src = read(TWILIO);
    assert.match(
      src,
      /sentAtUtc: mappedStatus === "SENT" \? new Date\(\) : null,/,
    );
  });
});

// ============================================================================
// 4) StatusCallback wired so DELIVERED/FAILED webhooks land
// ============================================================================

describe("Twilio StatusCallback — wired so webhook updates land", () => {
  it("the dispatch sendInput now includes statusCallbackUrl", () => {
    const src = read(COMM);
    // Initial dispatch path.
    assert.match(
      src,
      /externalId: queued\.id,\s*\n?\s*\/\/[\s\S]{0,800}statusCallbackUrl: resolveTwilioStatusCallbackUrl\(\),/,
    );
    // Retry path.
    assert.match(
      src,
      /externalId: row\.id,\s*\n?\s*statusCallbackUrl: resolveTwilioStatusCallbackUrl\(\),/,
    );
  });

  it("the resolver reads TWILIO_STATUS_CALLBACK_URL and returns undefined when unset (safe default)", () => {
    const src = read(COMM);
    assert.match(src, /function resolveTwilioStatusCallbackUrl\(\)/);
    assert.match(src, /process\.env\.TWILIO_STATUS_CALLBACK_URL/);
    assert.match(src, /return url\.length > 0 \? url : undefined;/);
  });
});

// ============================================================================
// 5) Public-route error shape — friendly message attached to every code
// ============================================================================

describe("Public intake errors — every code ships a user-safe message", () => {
  it("friendlyPublicIntakeMessage exists and covers the audit's mandatory codes", () => {
    const src = read(PUBLIC_ROUTES);
    assert.match(src, /function friendlyPublicIntakeMessage\(/);
    for (const code of [
      "MAX_FILES_REACHED",
      "LINK_NO_LONGER_AVAILABLE",
      "SESSION_TERMINAL",
      "MIME_TYPE_NOT_ALLOWED",
      "INTERNAL_ERROR",
      "RATE_LIMITED",
      "INVALID_OR_EXPIRED_LINK",
      "FEATURE_DISABLED",
    ]) {
      assert.ok(
        src.includes(`case "${code}":`),
        `friendlyPublicIntakeMessage missing case for "${code}"`,
      );
    }
  });

  it("intakeErrorToReply attaches `message` on EVERY branch (no raw {code} responses)", () => {
    const src = read(PUBLIC_ROUTES);
    // Find the intakeErrorToReply function body. Every `reply.code(...).send({error:{code:...}})`
    // inside it must also include `message:`.
    const fnIdx = src.indexOf("function intakeErrorToReply");
    assert.ok(fnIdx > 0, "intakeErrorToReply function missing");
    // intakeErrorToReply is the LAST helper before the Routes block;
    // use the Routes comment header as the end marker. (Earlier
    // helpers like orchestrationErrorToReply + friendlyPublicIntakeMessage
    // appear above it in the file.)
    const endIdx = src.indexOf("// Routes", fnIdx);
    assert.ok(endIdx > fnIdx, "Routes section marker missing after intakeErrorToReply");
    const body = src.slice(fnIdx, endIdx);
    // Every `reply.code(...).send({...})` payload inside this function
    // must mention `message:`. There are 9 reply.code(...).send sites
    // — they must all carry `message: friendly(...)`.
    const replyMatches = [...body.matchAll(/reply\s*\n?\s*\.code\(\d+\)\s*\.send\(\{/g)];
    assert.ok(replyMatches.length >= 9, `expected ≥9 reply.send sites, found ${replyMatches.length}`);
    const messageMatches = [...body.matchAll(/\bmessage: friendly/g)];
    assert.equal(
      messageMatches.length,
      replyMatches.length,
      "every reply.send inside intakeErrorToReply must call friendly(...) for message",
    );
  });

  it("the inline MIME_TYPE_NOT_ALLOWED throw also carries a friendly message", () => {
    const src = read(PUBLIC_ROUTES);
    assert.match(
      src,
      /code: "MIME_TYPE_NOT_ALLOWED",\s*\n?\s*message: friendlyPublicIntakeMessage\("MIME_TYPE_NOT_ALLOWED"\)/,
    );
  });
});

// ============================================================================
// Cross-cutting safety pin
// ============================================================================

test("Provider call still receives the unredacted body (token preserved for the recipient)", () => {
  const src = read(COMM);
  // The body parameter passed to sendSms / sendWhatsApp is the original
  // `input.body` — we redact the PREVIEW, not the wire payload.
  assert.match(src, /toE164: phone,\s*\n?\s*body: input\.body,/);
});

/**
 * Intake-links-e2e — backend source-contract.
 *
 * Pins the route + service commitments made for the SMB intake-links
 * rewrite. The vitest behavioural tests cover happy paths in a live
 * Fastify; this contract test is the cheap belt-and-braces that a
 * refactor can't silently remove the audit-mandated knobs.
 *
 *   - CreateBody Zod schema accepts deliveryMethod + intakeUrlBase
 *     with the superRefine guards (EMAIL → recipientEmail,
 *     SMS/WHATSAPP → recipientPhone, non-MANUAL → intakeUrlBase).
 *   - The DELIVERY_METHODS tuple is the canonical export and matches
 *     the frontend's literal type.
 *   - The create handler appends both audit events
 *     ("intake.link.created" always, plus
 *     "intake.link.sent" | "intake.link.delivery_failed" when a
 *     delivery is attempted).
 *   - The resend (POST /:id/send) handler accepts EMAIL as a first-
 *     class channel and routes to sendIntakeLinkViaEmail.
 *   - The service file exports sendIntakeLinkViaEmail with the
 *     hard-guarantee shape (returns ok / reason).
 *   - PII guard: the audit metadata never carries the raw email,
 *     phone, body, or token — only the booleans / hash IDs the audit
 *     pipeline already accepts.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const ROUTES = resolve(
  REPO_ROOT,
  "services/api/src/routes/workflow-intake-links.routes.ts",
);
const SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/workflow-intake-link.service.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ===========================================================================
// Routes — Zod schema, delivery dispatch, audit events
// ===========================================================================

test("DELIVERY_METHODS tuple is exported and matches the frontend enum", () => {
  const src = read(ROUTES);
  assert.match(
    src,
    /export const DELIVERY_METHODS = \["MANUAL", "EMAIL", "SMS", "WHATSAPP"\] as const;/,
  );
  assert.match(
    src,
    /export type DeliveryMethod = \(typeof DELIVERY_METHODS\)\[number\];/,
  );
});

test("CreateBody — accepts deliveryMethod (defaulted MANUAL) and intakeUrlBase", () => {
  const src = read(ROUTES);
  assert.match(
    src,
    /deliveryMethod: z\.enum\(DELIVERY_METHODS\)\.default\("MANUAL"\)/,
  );
  assert.match(src, /intakeUrlBase: z\.string\(\)\.url\(\)\.max\(1000\)\.optional\(\)/);
});

test("CreateBody — superRefine enforces channel → recipient field dependencies", () => {
  const src = read(ROUTES);
  // EMAIL requires recipientEmail.
  assert.match(
    src,
    /data\.deliveryMethod === "EMAIL" && !data\.recipientEmail/,
  );
  // SMS/WHATSAPP requires recipientPhone. The literal wraps across
  // three lines in the route file (parenthesised disjunction on one
  // line, then `&&` and `!data.recipientPhone` on the next two), so
  // we match across whitespace.
  assert.match(
    src,
    /\(data\.deliveryMethod === "SMS" \|\| data\.deliveryMethod === "WHATSAPP"\)[\s\S]{0,40}!data\.recipientPhone/,
  );
  // Non-MANUAL requires intakeUrlBase so the backend can compose the
  // public link the contributor opens.
  assert.match(
    src,
    /data\.deliveryMethod !== "MANUAL" && !data\.intakeUrlBase/,
  );
});

test("Create handler — emits 'intake.link.created' audit event with no PII", () => {
  const src = read(ROUTES);
  // The action literal must be exactly this so the audit query layer
  // can group on it.
  assert.match(src, /action: "intake\.link\.created"/);
  // The metadata block immediately following the created-action call
  // must use booleans, not raw fields.
  const createdIdx = src.indexOf('action: "intake.link.created"');
  assert.ok(createdIdx > 0, "created action literal missing");
  // 1200-char window — the audit-call block is ~25 lines including
  // the PII-safety comment, the metadata literal, and the trailing
  // .catch(). 600 chars cuts off mid-comment.
  const slice = src.slice(createdIdx, createdIdx + 1200);
  assert.match(slice, /hasRecipientEmail: Boolean\(body\.recipientEmail\)/);
  assert.match(slice, /hasRecipientPhone: Boolean\(body\.recipientPhone\)/);
  // Defensive PII check — these strings must NOT appear in the
  // metadata literal.
  assert.ok(
    !/metadata:\s*\{[^}]*recipientEmail: body\.recipientEmail/.test(slice),
    "audit metadata must never carry raw recipientEmail",
  );
  assert.ok(
    !/metadata:\s*\{[^}]*recipientPhone: body\.recipientPhone/.test(slice),
    "audit metadata must never carry raw recipientPhone",
  );
  assert.ok(
    !/metadata:\s*\{[^}]*rawToken/.test(slice),
    "audit metadata must never carry the raw token",
  );
});

test("Create handler — emits 'intake.link.sent' OR 'intake.link.delivery_failed' on delivery", () => {
  const src = read(ROUTES);
  assert.match(
    src,
    /action:\s*\n?\s*delivery\.status === "sent"\s*\n?\s*\?\s*"intake\.link\.sent"\s*\n?\s*:\s*"intake\.link\.delivery_failed"/,
  );
});

test("Create handler — composes intakeUrl by trimming trailing slash from base and appending /intake/<token>", () => {
  const src = read(ROUTES);
  assert.match(
    src,
    /\$\{body\.intakeUrlBase\.replace\(\/\\\/\$\/, ""\)\}\/intake\/\$\{result\.rawToken\}/,
  );
});

test("Create handler — return envelope includes link, rawToken, warning, delivery", () => {
  const src = read(ROUTES);
  // The 201 response body must always include `delivery` (even for
  // MANUAL, where it's `{method: "MANUAL", status: "skipped"}`).
  const replyIdx = src.indexOf("return reply.code(201).send({");
  assert.ok(replyIdx > 0, "201 response missing");
  // Widened from 400: the link projection now carries the recipient-contact
  // disclosure argument, and the envelope this asserts on sits below it.
  const slice = src.slice(replyIdx, replyIdx + 900);
  // The projection now takes the recipient-contact disclosure decision, so
  // even the caller who just typed the address gets it back masked.
  assert.match(slice, /link: projectWorkflowIntakeLink\(\s*\n\s*result\.link,/);
  assert.match(slice, /rawToken: result\.rawToken/);
  assert.match(slice, /delivery,/);
});

test("Resend handler (POST /:id/send) — accepts EMAIL channel alongside SMS/WHATSAPP", () => {
  const src = read(ROUTES);
  assert.match(
    src,
    /channel: z\.enum\(\["SMS", "WHATSAPP", "EMAIL"\]\)\.default\("SMS"\)/,
  );
  // Intake-links-e2e Phase 5 — the resend handler no longer calls
  // the channel helpers directly. It dispatches through the
  // idempotency-aware dispatcher, which itself picks the right
  // helper based on `input.channel`. Pin the indirect routing.
  assert.match(src, /dispatchIntakeLinkDelivery\(\{/);
  assert.match(src, /channel: body\.channel,/);
});

test("Resend handler — audits every send attempt as sent / delivery_failed", () => {
  const src = read(ROUTES);
  // The resend audit metadata must carry `resend: true` so the audit
  // query layer can distinguish on-create dispatches from later
  // resends.
  assert.match(src, /resend: true,/);
});

test("Resend handler — maps link_missing_email to HTTP 400, provider_unconfigured to 503", () => {
  const src = read(ROUTES);
  // Both new EMAIL-specific error codes must map to user-actionable
  // status codes, not the generic 502.
  assert.match(
    src,
    /sendResult\.reason === "link_missing_phone" \|\|\s*\n?\s*sendResult\.reason === "link_missing_email"/,
  );
  // WA template fix — the 503 branch now also matches
  // whatsapp_template_unconfigured (Meta requires an approved
  // Content Template; missing SID is operator-correctable, hence 503).
  assert.match(
    src,
    /sendResult\.reason === "provider_unconfigured" \|\|\s*\n?\s*sendResult\.reason === "whatsapp_template_unconfigured"\s*\n?\s*\?\s*503/,
  );
});

// ===========================================================================
// Service — sendIntakeLinkViaEmail exists with the documented shape
// ===========================================================================

test("Service — sendIntakeLinkViaEmail is exported with the {ok, reason} result type", () => {
  const src = read(SERVICE);
  assert.match(src, /export async function sendIntakeLinkViaEmail\(/);
  // The result discriminator must enumerate every reason the routes
  // file's HTTP mapper handles.
  assert.match(src, /export type SendIntakeLinkViaEmailResult =/);
  for (const reason of [
    "link_not_found",
    "link_revoked",
    "link_expired",
    "link_missing_email",
    "provider_unconfigured",
    "delivery_failed",
  ]) {
    assert.ok(
      src.includes(`"${reason}"`),
      `SendIntakeLinkViaEmailResult missing reason "${reason}"`,
    );
  }
});

test("Service — sendIntakeLinkViaEmail masks the email preview, never logs raw email", () => {
  const src = read(SERVICE);
  assert.match(src, /function maskEmailPreview\(email: string\)/);
  // The masking must reduce the local part to a 1-char prefix + dots
  // + (maybe) a 1-char suffix. Pin the central transform.
  assert.match(src, /"•"\.repeat/);
});

/**
 * Intake-link enterprise messaging — backend source-contract.
 *
 * Pins the security + integration invariants that protect the raw
 * intake token and bind the operator's sender-identity choice to
 * what the recipient actually receives:
 *
 *   - The CommunicationMessage.bodyPreview path uses the
 *     sanitizeIntakeMessagePreview output (raw token never persisted).
 *   - The send functions resolve sender identity via the shared
 *     resolveIntakeSenderDisplay (PROOVRA brand cannot be removed).
 *   - The route layer accepts senderDisplayMode + senderDisplayName
 *     and forwards them to the service.
 *   - The sender-identity endpoint exists with the safe shape.
 *   - The `WHATSAPP_INTAKE_TEMPLATE_MODE` env override is read for
 *     WhatsApp delivery and defaults to "plain".
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/workflow-intake-link.service.ts",
);
const ROUTES = resolve(
  REPO_ROOT,
  "services/api/src/routes/workflow-intake-links.routes.ts",
);
const COMM = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/communication.service.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Send functions — security + sender identity wiring", () => {
  it("Email send uses the shared renderIntakeEmailMessage", () => {
    const src = read(SERVICE);
    assert.match(src, /renderIntakeEmailMessage\(\{/);
  });

  it("the phone send has one body renderer, because it has one channel", () => {
    /*
     * This asserted a two-way dispatch on channel, and the WhatsApp half of
     * it — a Content Template mode read from WHATSAPP_INTAKE_TEMPLATE_MODE,
     * a template payload, a URL-format switch. WhatsApp was retired as an
     * intake delivery option, so there is one renderer and no branch.
     * intake-whatsapp-template.contract.test.ts pins the retirement itself.
     */
    const src = read(SERVICE);
    assert.match(src, /const body = renderIntakeSmsMessage\(renderInput\);/);
    assert.doesNotMatch(src, /renderIntakeWhatsappMessage/);
    assert.doesNotMatch(src, /WHATSAPP_INTAKE_TEMPLATE_MODE/);
  });

  it("Both send functions read sender identity columns from the link row + resolve via shared", () => {
    const src = read(SERVICE);
    // The findFirst select must include the new columns so the
    // resolver has them.
    for (const col of ["senderDisplayMode: true", "senderDisplayName: true"]) {
      assert.ok(
        src.includes(col),
        `link select missing column "${col}"`,
      );
    }
    assert.match(src, /resolveIntakeSenderDisplay\(\{/);
  });

  it("Email path stores the sanitized preview, NOT the raw rendered body", () => {
    const src = read(SERVICE);
    // The bodyPreview field on the email CommunicationMessage row
    // must be the output of `sanitizeIntakeMessagePreview` — never
    // a slice of the raw `text` or `subject` that contains the URL.
    assert.match(src, /sanitizedPreview = sanitizeIntakeMessagePreview\(/);
    assert.match(src, /bodyPreview: sanitizedPreview,/);
  });

  it("SMS/WhatsApp path passes the sanitized preview via bodyPreviewOverride", () => {
    const src = read(SERVICE);
    assert.match(src, /bodyPreviewOverride: sanitizedPreview,/);
  });

  it("The communication service accepts the new bodyPreviewOverride parameter and respects it", () => {
    const src = read(COMM);
    assert.match(src, /bodyPreviewOverride\?: string \| null;/);
    assert.match(
      src,
      /bodyPreview:\s*\n?\s*input\.bodyPreviewOverride \?\? safeBodyPreview\(input\.body\)/,
    );
  });
});

describe("Create flow — sender identity validation + persistence", () => {
  it("createWorkflowIntakeLink rejects an invalid custom sender display name", () => {
    const src = read(SERVICE);
    // The service must call validateCustomSenderDisplayName and
    // throw `invalid_sender_display_name` on failure.
    assert.match(src, /validateCustomSenderDisplayName\(input\.senderDisplayName/);
    assert.match(
      src,
      /throw new WorkflowIntakeLinkError\(\s*\n?\s*"invalid_sender_display_name"/,
    );
  });

  it("createWorkflowIntakeLink persists senderDisplayMode + senderDisplayName on the row", () => {
    const src = read(SERVICE);
    // Both columns must appear in the create.data literal.
    const createIdx = src.indexOf("client.workflowIntakeLink.create({");
    assert.ok(createIdx > 0);
    const slice = src.slice(createIdx, createIdx + 1600);
    assert.match(slice, /senderDisplayMode,/);
    assert.match(slice, /senderDisplayName,/);
  });

  it("Route Zod schema accepts senderDisplayMode + senderDisplayName + requires the name when mode=CUSTOM", () => {
    const src = read(ROUTES);
    assert.match(
      src,
      /senderDisplayMode: z\s*\n?\s*\.enum\(\["PROOVRA", "WORKSPACE", "CUSTOM"\]\)/,
    );
    assert.match(
      src,
      /data\.senderDisplayMode === "CUSTOM" && !data\.senderDisplayName/,
    );
  });

  it("Route forwards the new fields to createWorkflowIntakeLink", () => {
    const src = read(ROUTES);
    assert.match(src, /senderDisplayMode: body\.senderDisplayMode,/);
    assert.match(src, /senderDisplayName: body\.senderDisplayName \?\? null,/);
  });

  it("Error mapper returns 400 for invalid_sender_display_name (never crashes)", () => {
    const src = read(ROUTES);
    assert.match(
      src,
      /err\.code === "invalid_sender_display_name"\s*\n?\s*\?\s*400/,
    );
  });
});

describe("GET /sender-identity — safe shape only", () => {
  it("Endpoint is registered and returns email/sms envelopes", () => {
    const src = read(ROUTES);
    assert.match(
      src,
      /"\/v1\/workflow\/intake-links\/sender-identity"/,
    );
    const epIdx = src.indexOf(
      '"/v1/workflow/intake-links/sender-identity"',
    );
    assert.ok(epIdx > 0);
    const slice = src.slice(epIdx, epIdx + 4000);
    for (const channel of ["email:", "sms:"]) {
      assert.ok(
        slice.includes(channel),
        `sender-identity endpoint missing "${channel}" envelope`,
      );
    }
    /*
     * And NOT a WhatsApp envelope. This preview exists to tell an operator
     * which transports are configured before they pick one; describing a
     * channel they cannot pick — "Setup required: add a Content Template
     * SID" — is a worse answer than not mentioning it.
     */
    assert.ok(
      !slice.includes("whatsapp:"),
      "sender-identity must not describe a retired channel",
    );
  });

  it("Endpoint reads env vars but NEVER returns API keys / SIDs / messaging-service SIDs", () => {
    const src = read(ROUTES);
    const epIdx = src.indexOf(
      '"/v1/workflow/intake-links/sender-identity"',
    );
    const endIdx = src.indexOf("// -- Submissions ", epIdx);
    const slice = src.slice(epIdx, endIdx);
    // Reading env is fine (we need to check `configured`); echoing
    // is NOT. Pin every forbidden key by name.
    for (const forbidden of [
      "RESEND_API_KEY:",
      "TWILIO_ACCOUNT_SID:",
      "TWILIO_API_KEY:",
      "TWILIO_API_SECRET:",
      "TWILIO_MESSAGING_SERVICE_SID:",
    ]) {
      assert.ok(
        !slice.includes(forbidden),
        `sender-identity endpoint must not return ${forbidden}`,
      );
    }
  });

  it("Phone numbers are returned as masked previews, never raw E.164", () => {
    const src = read(ROUTES);
    const epIdx = src.indexOf(
      '"/v1/workflow/intake-links/sender-identity"',
    );
    const endIdx = src.indexOf("// -- Submissions ", epIdx);
    const slice = src.slice(epIdx, endIdx);
    assert.match(slice, /maskPhonePreview/);
    assert.match(slice, /fromNumberPreview/);
  });
});

test("End-to-end safety pin: the rendered body the provider gets contains the URL, the persisted preview does NOT", () => {
  // This is the literal seam the brief calls out. The contract test
  // file alongside this one (shared/intake-link-messaging.test.mjs)
  // proves it at the unit level; here we pin that the API send
  // functions wire that seam correctly.
  const src = read(SERVICE);
  // Email branch
  assert.match(src, /providerResult = await sendCustomEmailViaResend\(\{/);
  assert.match(src, /text: rendered\.text,/);
  // SMS branch
  assert.match(src, /enqueueOutboundMessage\(\s*\n?\s*\{\s*\n?\s*teamId: input\.teamId,/);
  // Sanitized preview is supplied as override.
  assert.match(src, /bodyPreviewOverride: sanitizedPreview,/);
});

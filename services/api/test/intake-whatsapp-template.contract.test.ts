/**
 * Production WhatsApp template delivery — source-contract.
 *
 * After the providerMessageId fix landed, intake-link WhatsApp rows
 * picked up real Twilio SIDs but stayed QUEUED with no errorCode —
 * Meta rejects free-form Body sent outside the 24h customer window
 * (errorCode 63016, "template required"). This contract pins the
 * production fix:
 *
 *   1. New env: TWILIO_WHATSAPP_INTAKE_TEMPLATE_SID +
 *      TWILIO_WHATSAPP_TEMPLATE_LANGUAGE; config layer surfaces both.
 *   2. Twilio provider sends WhatsApp via ContentSid + ContentVariables
 *      + ContentLanguage when a template is supplied. SMS NEVER uses
 *      the template payload — body-only.
 *   3. sendIntakeLinkViaSms (WhatsApp branch) builds the template
 *      payload with {1..4} variables and refuses with
 *      `whatsapp_template_unconfigured` when the SID is missing.
 *   4. Variable 4 honours TWILIO_WHATSAPP_TEMPLATE_URL_FORMAT —
 *      defaults to "token" (template button URL pins the domain).
 *   5. Sender-identity endpoint surfaces template state so the
 *      operator UI can disable WhatsApp with a setup-required
 *      reason instead of silently letting the send fail.
 *   6. Dispatcher + send route map the new reason to HTTP 503 so
 *      the UI distinguishes "needs setup" from "transient error".
 *   7. providerMessageId still stores the real Twilio SID
 *      (Content API response shape is identical — `sid` field).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const TWILIO = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/twilio-provider.ts",
);
const PROVIDER = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/provider.ts",
);
const COMM_SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/communications/communication.service.ts",
);
const LINK_SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/workflow-intake-link.service.ts",
);
const DISPATCHER = resolve(
  REPO_ROOT,
  "services/api/src/services/intake-link-delivery-dispatcher.service.ts",
);
const ROUTES = resolve(
  REPO_ROOT,
  "services/api/src/routes/workflow-intake-links.routes.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — env + config", () => {
  it("TwilioProviderConfig declares whatsappIntakeTemplateSid + whatsappTemplateLanguage", () => {
    const src = read(TWILIO);
    assert.match(src, /whatsappIntakeTemplateSid:\s*string \| null;/);
    assert.match(src, /whatsappTemplateLanguage:\s*string;/);
  });

  it("readTwilioConfigFromEnv reads TWILIO_WHATSAPP_INTAKE_TEMPLATE_SID + TWILIO_WHATSAPP_TEMPLATE_LANGUAGE (default 'en')", () => {
    const src = read(TWILIO);
    assert.match(src, /process\.env\.TWILIO_WHATSAPP_INTAKE_TEMPLATE_SID/);
    assert.match(
      src,
      /process\.env\.TWILIO_WHATSAPP_TEMPLATE_LANGUAGE[\s\S]{0,80}\|\| "en"/,
    );
  });

  it("ProviderSendInput exposes an optional template payload (contentSid + variables + language)", () => {
    const src = read(PROVIDER);
    assert.match(src, /template\?: \{[\s\S]{0,400}contentSid: string;/);
    assert.match(src, /variables: Record<string, string>;/);
    assert.match(src, /language\?: string;/);
  });
});

describe("Pin 2 — Twilio provider uses Content API for WhatsApp", () => {
  it("WhatsApp + template ⇒ ContentSid + ContentVariables + ContentLanguage (no Body)", () => {
    const src = read(TWILIO);
    assert.match(
      src,
      /useTemplate =\s*\n?\s*channel === "WHATSAPP" && Boolean\(input\.template\?\.contentSid\)/,
    );
    assert.match(src, /params\.set\("ContentSid", input\.template\.contentSid\)/);
    assert.match(
      src,
      /params\.set\(\s*\n?\s*"ContentVariables",\s*\n?\s*JSON\.stringify\(input\.template\.variables\)/,
    );
    assert.match(src, /params\.set\("ContentLanguage", lang\)/);
  });

  it("SMS path is unchanged — Body is still set, template is ignored on SMS", () => {
    const src = read(TWILIO);
    // The `else` branch of the template gate sets Body; pin that the
    // gate's guard requires channel===WHATSAPP, so SMS always falls
    // through to params.set("Body", input.body).
    assert.match(
      src,
      /} else \{\s*\n?\s*params\.set\("Body", input\.body\);/,
    );
  });

  it("Twilio response parser still returns the real SID for ContentSid sends (so providerMessageId remains correct)", () => {
    const src = read(TWILIO);
    // Twilio's Content API response shape is identical to Messages.json
    // (sid + status). The success branch must still read body.sid.
    assert.match(src, /body\["sid"\]/);
    assert.match(src, /providerMessageId: sid/);
  });
});

describe("Pin 3 — intake link service builds + gates the template", () => {
  it("WhatsApp send refuses with whatsapp_template_unconfigured when SID is missing", () => {
    const src = read(LINK_SERVICE);
    assert.match(
      src,
      /if \(input\.channel === "WHATSAPP"\) \{\s*\n?\s*const templateSid = readIntakeWhatsappTemplateSid\(\);[\s\S]{0,300}reason: "whatsapp_template_unconfigured"/,
    );
  });

  it("WhatsApp send passes the template payload through enqueueOutboundMessage; SMS doesn't", () => {
    const src = read(LINK_SERVICE);
    // The `template` field on the enqueue input is only set for the
    // WhatsApp branch (a ternary on input.channel).
    assert.match(
      src,
      /const template =\s*\n?\s*input\.channel === "WHATSAPP"\s*\n?\s*\? buildIntakeWhatsappTemplatePayload\(/,
    );
    assert.match(src, /:\s*undefined;/);
    assert.match(src, /template,\s*\n?\s*\}/);
  });

  it("buildIntakeWhatsappTemplatePayload populates all 4 positional variables", () => {
    const src = read(LINK_SERVICE);
    const fnIdx = src.indexOf("export function buildIntakeWhatsappTemplatePayload");
    assert.ok(fnIdx > 0);
    const body = src.slice(fnIdx, fnIdx + 1500);
    // Every variable index 1..4 must be set in the variables object.
    for (const key of ['"1":', '"2":', '"3":', '"4":']) {
      assert.ok(
        body.includes(key),
        `WhatsApp template variables missing ${key}`,
      );
    }
  });

  it("the new failure reason is declared on SendIntakeLinkViaSmsResult", () => {
    const src = read(LINK_SERVICE);
    assert.match(src, /\| "whatsapp_template_unconfigured"/);
  });
});

describe("Pin 4 — variable 4 honours TWILIO_WHATSAPP_TEMPLATE_URL_FORMAT", () => {
  it("resolver defaults to 'token' (template URL pins the domain via {{4}} suffix)", () => {
    const src = read(LINK_SERVICE);
    assert.match(
      src,
      /function resolveIntakeWhatsappTemplateUrlFormat\(\):\s*IntakeWhatsappTemplateUrlFormat \{/,
    );
    assert.match(src, /process\.env\.TWILIO_WHATSAPP_TEMPLATE_URL_FORMAT/);
    assert.match(src, /raw === "url" \? "url" : "token"/);
  });

  it("var4 is rawToken when format is 'token', full URL when format is 'url'", () => {
    const src = read(LINK_SERVICE);
    assert.match(
      src,
      /const var4 = urlFormat === "url" \? input\.intakeUrl : input\.rawToken;/,
    );
  });
});

describe("Pin 5 — sender-identity endpoint surfaces template status", () => {
  it("WhatsApp.configured requires BOTH a from-number AND a template SID", () => {
    const src = read(ROUTES);
    assert.match(
      src,
      /const whatsappConfigured =\s*\n?\s*whatsappHasTwilio && whatsappTemplateConfigured;/,
    );
  });

  it("response carries an explicit `template` block with configured + sid + language", () => {
    const src = read(ROUTES);
    assert.match(
      src,
      /template: \{\s*\n?\s*configured: whatsappTemplateConfigured,\s*\n?\s*sid: whatsappTemplateConfigured \? whatsappTemplateSid : null,\s*\n?\s*language: whatsappTemplateLanguage,\s*\n?\s*\}/,
    );
  });

  it("unconfiguredReason distinguishes 'twilio_unconfigured' from 'intake_template_unconfigured'", () => {
    const src = read(ROUTES);
    assert.match(src, /"intake_template_unconfigured"/);
    assert.match(src, /"twilio_unconfigured"/);
  });
});

describe("Pin 6 — dispatcher + route map the new reason correctly", () => {
  it("dispatcher's union type allows whatsapp_template_unconfigured", () => {
    const src = read(DISPATCHER);
    assert.match(src, /\| "whatsapp_template_unconfigured"/);
  });

  it("send route maps provider_unconfigured + whatsapp_template_unconfigured to HTTP 503", () => {
    const src = read(ROUTES);
    assert.match(
      src,
      /sendResult\.reason === "provider_unconfigured" \|\|\s*\n?\s*sendResult\.reason === "whatsapp_template_unconfigured"\s*\n?\s*\? 503/,
    );
  });
});

describe("Pin 7 — enqueueOutboundMessage threads template through", () => {
  it("EnqueueOutboundMessageInput accepts the optional template field", () => {
    const src = read(COMM_SERVICE);
    assert.match(
      src,
      /template\?: \{\s*\n?\s*contentSid: string;\s*\n?\s*variables: Record<string, string>;\s*\n?\s*language\?: string;\s*\n?\s*\};/,
    );
  });

  it("sendInput passes input.template to the provider so the Twilio call receives it", () => {
    const src = read(COMM_SERVICE);
    assert.match(src, /template: input\.template,/);
  });
});

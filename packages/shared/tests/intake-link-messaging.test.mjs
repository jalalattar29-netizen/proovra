/**
 * Intake-link messaging — security, sender-identity, and template
 * content tests. Lives in the shared package so a refactor of the
 * renderers fails CI before the API or web ever rebuilds.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  INTAKE_BRAND_NAME,
  INTAKE_DO_NOT_FORWARD_LINE,
  INTAKE_FOOTER_LINE,
  INTAKE_NO_ACCOUNT_LINE,
  INTAKE_SENDER_DISPLAY_MODES,
  INTAKE_UNEXPECTED_LINE,
  SANITIZED_INTAKE_TOKEN_PLACEHOLDER,
  SANITIZED_TOKEN_ONLY_PLACEHOLDER,
  defaultIntakeSenderMode,
  intakeRequestTypeLabel,
  renderIntakeEmailMessage,
  renderIntakeSmsMessage,
  renderIntakeWhatsappMessage,
  resolveIntakeSenderDisplay,
  sanitizeIntakeMessagePreview,
  validateCustomSenderDisplayName,
} from "../dist/index.js";

const SAMPLE_URL =
  "https://app.proovra.com/intake/AbCdEf1234567890XyZqWeRtYuIoP";
const SAMPLE_TOKEN = "AbCdEf1234567890XyZqWeRtYuIoP";

const baseInput = {
  senderDisplay: "Acme Insurance via PROOVRA",
  requestTypeSlug: "insurance-claim",
  recipientLabel: "Claim 4821",
  intakeUrl: SAMPLE_URL,
  expiresAtUtc: "2026-06-20T16:00:00Z",
  channel: "EMAIL",
  locale: "en",
};

// ============================================================================
// Sanitizer
// ============================================================================

describe("sanitizeIntakeMessagePreview", () => {
  it("redacts the path portion of a full intake URL but preserves host", () => {
    const out = sanitizeIntakeMessagePreview(`Open ${SAMPLE_URL} now`);
    assert.ok(out.includes("https://app.proovra.com/intake/"));
    assert.ok(out.includes(SANITIZED_INTAKE_TOKEN_PLACEHOLDER));
    assert.ok(!out.includes(SAMPLE_TOKEN), `output leaked the raw token: ${out}`);
  });

  it("redacts a bare /intake/<token> path with no protocol", () => {
    const out = sanitizeIntakeMessagePreview(
      `path: /intake/${SAMPLE_TOKEN} more text`,
    );
    assert.ok(out.includes("/intake/[secure-link]"));
    assert.ok(!out.includes(SAMPLE_TOKEN));
  });

  it("redacts standalone token-looking strings outside any URL", () => {
    const out = sanitizeIntakeMessagePreview(
      `Inbound webhook payload token=${SAMPLE_TOKEN}`,
    );
    assert.ok(!out.includes(SAMPLE_TOKEN));
    assert.ok(out.includes(SANITIZED_TOKEN_ONLY_PLACEHOLDER));
  });

  it("redacts secret-shaped query parameters", () => {
    const out = sanitizeIntakeMessagePreview(
      `URL: https://example.com/cb?sig=ABCDEFGHIJKLMNOP&token=${SAMPLE_TOKEN}`,
    );
    assert.ok(!out.includes(SAMPLE_TOKEN));
    assert.ok(!out.includes("ABCDEFGHIJKLMNOP"));
    assert.ok(out.includes(`sig=${SANITIZED_TOKEN_ONLY_PLACEHOLDER}`));
    assert.ok(out.includes(`token=${SANITIZED_TOKEN_ONLY_PLACEHOLDER}`));
  });

  it("is idempotent — sanitizing twice produces the same string", () => {
    const once = sanitizeIntakeMessagePreview(`Open ${SAMPLE_URL}`);
    const twice = sanitizeIntakeMessagePreview(once);
    assert.equal(twice, once);
  });

  it("preserves short / non-token strings unchanged", () => {
    assert.equal(
      sanitizeIntakeMessagePreview("Channel: EMAIL — expiry 5 days"),
      "Channel: EMAIL — expiry 5 days",
    );
  });

  it("caps length at the preview limit", () => {
    const big = "x".repeat(1000);
    const out = sanitizeIntakeMessagePreview(big);
    assert.ok(out.length <= 400);
  });

  it("returns empty string on null / undefined", () => {
    assert.equal(sanitizeIntakeMessagePreview(null), "");
    assert.equal(sanitizeIntakeMessagePreview(undefined), "");
  });
});

// ============================================================================
// Sender identity
// ============================================================================

describe("sender identity", () => {
  it("INTAKE_SENDER_DISPLAY_MODES has exactly PROOVRA / WORKSPACE / CUSTOM", () => {
    assert.deepEqual(
      [...INTAKE_SENDER_DISPLAY_MODES],
      ["PROOVRA", "WORKSPACE", "CUSTOM"],
    );
  });

  it("PROOVRA mode renders as 'PROOVRA secure intake'", () => {
    const r = resolveIntakeSenderDisplay({ mode: "PROOVRA" });
    assert.equal(r.mode, "PROOVRA");
    assert.equal(r.display, "PROOVRA secure intake");
  });

  it("WORKSPACE mode appends 'via PROOVRA' to the workspace name", () => {
    const r = resolveIntakeSenderDisplay({
      mode: "WORKSPACE",
      workspaceName: "Acme Insurance",
    });
    assert.equal(r.display, "Acme Insurance via PROOVRA");
  });

  it("WORKSPACE mode with blank name falls back to PROOVRA mode (never strips the brand)", () => {
    const r = resolveIntakeSenderDisplay({
      mode: "WORKSPACE",
      workspaceName: "   ",
    });
    assert.equal(r.mode, "PROOVRA");
    assert.equal(r.display, "PROOVRA secure intake");
  });

  it("CUSTOM mode renders '<name> via PROOVRA' when valid", () => {
    const r = resolveIntakeSenderDisplay({
      mode: "CUSTOM",
      customName: "Smith & Partners Legal",
    });
    assert.equal(r.display, "Smith & Partners Legal via PROOVRA");
  });

  it("CUSTOM mode throws on invalid name (validation is mandatory)", () => {
    assert.throws(
      () =>
        resolveIntakeSenderDisplay({
          mode: "CUSTOM",
          customName: "click https://evil.example.com now",
        }),
      /Invalid custom sender display name/,
    );
  });

  it("PROOVRA brand always appears in resolved display, regardless of mode", () => {
    for (const mode of INTAKE_SENDER_DISPLAY_MODES) {
      const r = resolveIntakeSenderDisplay({
        mode,
        workspaceName: "Acme",
        customName: "Acme Insurance",
      });
      assert.ok(
        r.display.includes("PROOVRA"),
        `mode=${mode} display="${r.display}" missing PROOVRA brand`,
      );
    }
  });

  it("default mode is WORKSPACE when workspace has a name, else PROOVRA — never a personal user name", () => {
    assert.equal(
      defaultIntakeSenderMode({ workspaceName: "Acme" }),
      "WORKSPACE",
    );
    assert.equal(defaultIntakeSenderMode({ workspaceName: "" }), "PROOVRA");
    assert.equal(defaultIntakeSenderMode({ workspaceName: null }), "PROOVRA");
    // No mode in the catalog is "PERSONAL" — pin that the personal
    // user identity can never become the default.
    assert.ok(!INTAKE_SENDER_DISPLAY_MODES.includes("PERSONAL"));
  });
});

describe("validateCustomSenderDisplayName", () => {
  it("accepts a normal business name", () => {
    const r = validateCustomSenderDisplayName("Acme Insurance");
    assert.deepEqual(r, { ok: true, value: "Acme Insurance" });
  });

  it("trims surrounding whitespace", () => {
    const r = validateCustomSenderDisplayName("   Acme Insurance   ");
    assert.deepEqual(r, { ok: true, value: "Acme Insurance" });
  });

  it("rejects empty / whitespace-only", () => {
    assert.equal(validateCustomSenderDisplayName("").reason, "empty");
    assert.equal(validateCustomSenderDisplayName("   ").reason, "empty");
  });

  it("rejects names over 80 chars", () => {
    const r = validateCustomSenderDisplayName("A".repeat(81));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "too_long");
  });

  it("rejects names containing a URL", () => {
    assert.equal(
      validateCustomSenderDisplayName("Acme https://acme.io").reason,
      "contains_url",
    );
    assert.equal(
      validateCustomSenderDisplayName("Acme www.acme.io").reason,
      "contains_url",
    );
    assert.equal(
      validateCustomSenderDisplayName("Acme.com").reason,
      "contains_url",
    );
  });

  it("rejects names containing an email address", () => {
    assert.equal(
      validateCustomSenderDisplayName("info@acme.io").reason,
      "contains_email",
    );
  });

  it("rejects names containing a phone number", () => {
    assert.equal(
      validateCustomSenderDisplayName("Call us at +1 415 555 0199").reason,
      "contains_phone",
    );
  });

  it("rejects names with control or bidi-override characters", () => {
    const r = validateCustomSenderDisplayName("Acme‮Insurance");
    assert.equal(r.reason, "contains_control_chars");
  });

  it("rejects impersonation of authority entities", () => {
    for (const bad of [
      "Court of Justice",
      "Police Department",
      "Government Affairs",
      "Bank of America",
      "FBI Field Office",
    ]) {
      const r = validateCustomSenderDisplayName(bad);
      assert.equal(
        r.reason,
        "impersonation",
        `Expected "${bad}" to be rejected as impersonation`,
      );
    }
  });

  it("rejects the literal PROOVRA brand as a custom name", () => {
    const r = validateCustomSenderDisplayName("PROOVRA");
    assert.equal(r.reason, "reserved_brand");
    const r2 = validateCustomSenderDisplayName("proovra");
    assert.equal(r2.reason, "reserved_brand");
  });
});

// ============================================================================
// Email template
// ============================================================================

describe("renderIntakeEmailMessage", () => {
  const out = renderIntakeEmailMessage(baseInput);

  it("subject names the request type when slug is set", () => {
    assert.equal(out.subject, "Secure evidence request: Insurance claim evidence");
  });

  it("subject falls back to generic when slug is null", () => {
    const r = renderIntakeEmailMessage({ ...baseInput, requestTypeSlug: null });
    assert.equal(r.subject, "Secure evidence request via PROOVRA");
  });

  it("text body answers all 7 audit questions", () => {
    // 1) Who is this from? → senderDisplay line
    assert.ok(out.text.includes("Acme Insurance via PROOVRA is requesting"));
    // 2) What is being requested? → Request line
    assert.ok(out.text.includes("Request: Insurance claim evidence"));
    // 3) What should the recipient do? → "Use the secure upload link"
    assert.ok(out.text.includes("Use the secure upload link below"));
    // 4) Is an account required? → "No account is required."
    assert.ok(out.text.includes(INTAKE_NO_ACCOUNT_LINE));
    // 5) When does the link expire? → absolute UTC date
    assert.ok(out.text.includes("This link expires on"));
    assert.ok(out.text.includes("2026-06-20 16:00 UTC"));
    // 6) What if they weren't expecting it? → unexpected line
    assert.ok(out.text.includes(INTAKE_UNEXPECTED_LINE));
    // 7) Who is the platform? → PROOVRA header + footer
    assert.ok(out.text.startsWith("PROOVRA secure intake"));
    assert.ok(out.text.includes(INTAKE_FOOTER_LINE));
  });

  it("text body includes the do-not-forward line", () => {
    assert.ok(out.text.includes(INTAKE_DO_NOT_FORWARD_LINE));
  });

  it("text body embeds the recipient label as a Reference (NOT as the sender identity)", () => {
    assert.ok(out.text.includes("Reference: Claim 4821"));
    // The recipient label must never appear in the "from" line.
    assert.ok(!out.text.includes("Claim 4821 is requesting"));
  });

  it("text body contains the real intake URL (provider payload is real)", () => {
    assert.ok(out.text.includes(SAMPLE_URL));
  });

  it("html body contains the brand header, CTA, and trust footer", () => {
    assert.ok(out.html.includes("PROOVRA secure intake"));
    assert.ok(out.html.includes("Upload files securely"));
    assert.ok(out.html.includes(INTAKE_FOOTER_LINE));
    assert.ok(out.html.includes(`href="${SAMPLE_URL}"`));
  });

  it("forbidden trust claims are absent", () => {
    const haystack = `${out.text} ${out.html}`.toLowerCase();
    for (const forbidden of [
      "legally admissible",
      "proves authenticity",
      "court-approved",
      "tamper-proof",
      "guaranteed valid evidence",
    ]) {
      assert.ok(
        !haystack.includes(forbidden),
        `forbidden claim leaked: "${forbidden}"`,
      );
    }
  });

  it("per-request copy adapts to the slug", () => {
    const photos = renderIntakeEmailMessage({
      ...baseInput,
      requestTypeSlug: "photos-videos",
    });
    assert.ok(photos.text.includes("Photos and videos were requested"));
    assert.ok(photos.subject.includes("Photos and videos"));
  });
});

// ============================================================================
// SMS template
// ============================================================================

describe("renderIntakeSmsMessage", () => {
  const sms = renderIntakeSmsMessage({ ...baseInput, channel: "SMS" });

  it("starts with the PROOVRA brand", () => {
    assert.ok(
      sms.startsWith("PROOVRA"),
      `SMS must lead with PROOVRA brand: ${sms}`,
    );
  });

  it("includes sender display + real URL + expiry + STOP footer", () => {
    assert.ok(sms.includes("Acme Insurance via PROOVRA"));
    assert.ok(sms.includes(SAMPLE_URL));
    assert.ok(sms.includes("Expires"));
    assert.ok(sms.includes("Reply STOP"));
  });

  it("stays under the 280-char SMS cap", () => {
    assert.ok(
      sms.length <= 280,
      `SMS body length ${sms.length} exceeds 280-char cap: ${sms}`,
    );
  });

  it("does not contain forbidden trust claims", () => {
    const lower = sms.toLowerCase();
    for (const f of [
      "legally admissible",
      "tamper-proof",
      "court-approved",
    ]) {
      assert.ok(!lower.includes(f));
    }
  });
});

// ============================================================================
// WhatsApp template
// ============================================================================

describe("renderIntakeWhatsappMessage", () => {
  it("default (plain) mode mirrors the SMS body — safe for unapproved senders", () => {
    const plain = renderIntakeWhatsappMessage(baseInput);
    const sms = renderIntakeSmsMessage({ ...baseInput, channel: "SMS" });
    assert.equal(plain, sms);
  });

  it("rich mode emits a multi-line markdown body with brand header + footer", () => {
    const rich = renderIntakeWhatsappMessage(baseInput, "rich");
    assert.ok(rich.startsWith("*PROOVRA secure intake*"));
    assert.ok(rich.includes("Acme Insurance via PROOVRA is requesting"));
    assert.ok(rich.includes("Request: Insurance claim evidence"));
    assert.ok(rich.includes("Reference: Claim 4821"));
    assert.ok(rich.includes(SAMPLE_URL));
    assert.ok(rich.includes(INTAKE_NO_ACCOUNT_LINE));
    assert.ok(rich.includes(INTAKE_DO_NOT_FORWARD_LINE));
    assert.ok(rich.includes(INTAKE_UNEXPECTED_LINE));
    assert.ok(rich.includes(INTAKE_FOOTER_LINE));
  });

  it("approved_template mode also emits the rich body (the WABA template is just a wrapper)", () => {
    const a = renderIntakeWhatsappMessage(baseInput, "approved_template");
    assert.ok(a.startsWith("*PROOVRA secure intake*"));
  });

  it("rich body stays under the WhatsApp 1024-char cap", () => {
    const rich = renderIntakeWhatsappMessage(baseInput, "rich");
    assert.ok(rich.length <= 1024);
  });
});

// ============================================================================
// Per-type copy
// ============================================================================

describe("intakeRequestTypeLabel — per-slug variants", () => {
  it("returns a tailored sentence for each known slug", () => {
    assert.equal(
      intakeRequestTypeLabel("photos-videos"),
      "Photos and videos were requested.",
    );
    assert.equal(
      intakeRequestTypeLabel("documents"),
      "Documents were requested.",
    );
    assert.equal(
      intakeRequestTypeLabel("insurance-claim"),
      "Evidence for a claim was requested.",
    );
    assert.equal(
      intakeRequestTypeLabel("legal-matter"),
      "Documents for a legal matter were requested.",
    );
    assert.equal(
      intakeRequestTypeLabel("property-damage"),
      "Property damage evidence was requested.",
    );
    assert.equal(
      intakeRequestTypeLabel("journalism-field-capture"),
      "Files for a secure media submission were requested.",
    );
  });

  it("falls back to the generic line for an unknown slug", () => {
    assert.equal(
      intakeRequestTypeLabel("not-a-real-slug"),
      "Files were requested from you.",
    );
    assert.equal(
      intakeRequestTypeLabel(null),
      "Files were requested from you.",
    );
  });
});

// ============================================================================
// Regression — sanitized preview never carries the raw token
// ============================================================================

describe("end-to-end safety: rendered body → sanitize → preview", () => {
  it("EMAIL: rendered text contains the real URL, sanitized preview does NOT contain the token", () => {
    const rendered = renderIntakeEmailMessage(baseInput);
    assert.ok(rendered.text.includes(SAMPLE_TOKEN), "real text must contain token (provider payload)");
    const preview = sanitizeIntakeMessagePreview(rendered.text);
    assert.ok(!preview.includes(SAMPLE_TOKEN));
    assert.ok(preview.includes(SANITIZED_INTAKE_TOKEN_PLACEHOLDER));
  });

  it("SMS: rendered body contains the real URL, sanitized preview does NOT", () => {
    const rendered = renderIntakeSmsMessage({ ...baseInput, channel: "SMS" });
    assert.ok(rendered.includes(SAMPLE_TOKEN));
    const preview = sanitizeIntakeMessagePreview(rendered);
    assert.ok(!preview.includes(SAMPLE_TOKEN));
  });

  it("WhatsApp rich: rendered body contains the real URL, sanitized preview does NOT", () => {
    const rendered = renderIntakeWhatsappMessage(baseInput, "rich");
    assert.ok(rendered.includes(SAMPLE_TOKEN));
    const preview = sanitizeIntakeMessagePreview(rendered);
    assert.ok(!preview.includes(SAMPLE_TOKEN));
  });
});

// Tip: the `dist/` import path means we run against compiled output —
// `npx tsc` must succeed before this test runs. The package's other
// .test.mjs files follow the same pattern.
//
// All claim/PII guarantees here are NOT just about happy-path output —
// the sanitizer is the choke point for everything we persist. The
// audit metadata, log lines, Sentry contexts, and DB previews all
// MUST go through sanitizeIntakeMessagePreview before storage.

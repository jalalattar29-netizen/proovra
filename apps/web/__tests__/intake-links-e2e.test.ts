/**
 * Intake-links-e2e — frontend source-contract.
 *
 * Pins the user-visible commitments made by the Intake Links page so a
 * future refactor can't silently regress the SMB-truthful shape:
 *
 *   1) REQUEST_TYPES catalog — six built-in slugs (general-evidence-
 *      record, insurance-claim, legal-matter, incident-investigation,
 *      compliance-audit, journalism-field-capture). Each has a
 *      plain-language label so the user never sees raw template slugs.
 *
 *   2) DELIVERY_METHODS catalog — four methods exactly, MANUAL first
 *      (safe default), matching the backend Zod enum.
 *
 *   3) The create modal renders both selectors (data-attrs:
 *      `data-intake-link-request-type`, `data-intake-link-delivery-method`)
 *      and gates email/phone fields on the chosen method.
 *
 *   4) The submit button copy switches between "Create link" (MANUAL)
 *      and "Create & send" (anything else).
 *
 *   5) The reveal modal surfaces a delivery-result chip
 *      (`data-intake-link-delivery-result`) with all three states.
 *
 *   6) The top-of-page guidance card is present
 *      (`data-intake-links-guidance`).
 *
 *   7) The body sent to /v1/workflow/intake-links includes both
 *      `deliveryMethod` and `intakeUrlBase` so the backend can
 *      auto-dispatch on create.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/intake-links/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

test("REQUEST_TYPES catalog includes the six canonical built-in slugs", () => {
  const src = read(PAGE);
  for (const slug of [
    "general-evidence-record",
    "insurance-claim",
    "legal-matter",
    "incident-investigation",
    "compliance-audit",
    "journalism-field-capture",
  ]) {
    assert.ok(
      src.includes(`slug: "${slug}"`),
      `REQUEST_TYPES missing canonical slug "${slug}"`,
    );
  }
});

test("REQUEST_TYPES — each entry has a plain-language label, not the raw slug", () => {
  const src = read(PAGE);
  // Spot-check three of the labels — these are the user-facing chip
  // names the audit insisted on. If any of these changes, that's a
  // copy decision worth pinning.
  for (const label of [
    "General evidence request",
    "Insurance claim evidence",
    "Legal document collection",
  ]) {
    assert.ok(
      src.includes(label),
      `REQUEST_TYPES missing plain-language label "${label}"`,
    );
  }
});

test("DELIVERY_METHODS catalog — Email → SMS → WhatsApp → Manual (Manual demoted last)", () => {
  const src = read(PAGE);
  // Forensic P0 audit-fix: the catalog was reordered so primary
  // users see a real delivery channel by default. "Copy link only"
  // (renamed from "Copy link manually") is now LAST so the user
  // doesn't accidentally pick the no-delivery path when they
  // actually want a real channel.
  const idx = (literal: string) => src.indexOf(`value: "${literal}"`);
  const emailIdx = idx("EMAIL");
  const smsIdx = idx("SMS");
  const whatsappIdx = idx("WHATSAPP");
  const manualIdx = idx("MANUAL");
  assert.ok(manualIdx > 0, "MANUAL entry missing");
  assert.ok(emailIdx > 0, "EMAIL entry missing");
  assert.ok(smsIdx > 0, "SMS entry missing");
  assert.ok(whatsappIdx > 0, "WHATSAPP entry missing");
  assert.ok(
    emailIdx < smsIdx && smsIdx < whatsappIdx && whatsappIdx < manualIdx,
    "Order must be EMAIL → SMS → WHATSAPP → MANUAL",
  );
});

test("Create modal — request-type and delivery-method selectors carry stable data-attrs", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-link-request-type/);
  assert.match(src, /data-intake-link-delivery-method/);
  // Default state must use MANUAL so submit copy starts as "Create link".
  assert.match(src, /useState<DeliveryMethod>\(\s*\n?\s*"MANUAL"/);
});

test("Create modal — email field becomes required only when EMAIL is selected", () => {
  const src = read(PAGE);
  // The conditional render is keyed on deliveryMethod === "EMAIL".
  assert.match(src, /deliveryMethod === "EMAIL"/);
  // Inside the EMAIL branch we mark the input required with a visible
  // (required) chip in red.
  assert.match(src, /Recipient email[\s\S]{0,160}\(required\)/);
  // The submit gate must also enforce it.
  assert.match(
    src,
    /emailRequiredAndMissing =\s*\n?\s*deliveryMethod === "EMAIL" && !recipientEmail\.trim\(\)/,
  );
});

test("Create modal — phone field becomes required only when SMS or WHATSAPP is selected", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /deliveryMethod === "SMS" \|\| deliveryMethod === "WHATSAPP"/,
  );
  assert.match(
    src,
    /phoneRequiredAndMissing =\s*\n?\s*\(deliveryMethod === "SMS" \|\| deliveryMethod === "WHATSAPP"\) &&\s*\n?\s*!phoneCanonical/,
  );
});

test("Submit button — copy reflects the chosen delivery method", () => {
  const src = read(PAGE);
  // The ternary literal must be present so the user sees "Create &
  // send" only when a delivery method is selected. Audit pin: never
  // call a button "Send" when it isn't actually wired.
  assert.match(
    src,
    /deliveryMethod === "MANUAL"\s*\n?\s*\?\s*"Create link"\s*\n?\s*:\s*"Create & send"/,
  );
  assert.match(src, /data-intake-link-submit/);
});

test("Body sent to /v1/workflow/intake-links includes deliveryMethod + intakeUrlBase", () => {
  const src = read(PAGE);
  assert.match(src, /deliveryMethod,/);
  // intakeUrlBase composed from window.location and only sent for
  // non-MANUAL methods.
  assert.match(
    src,
    /intakeUrlBase: deliveryMethod === "MANUAL" \? undefined : intakeUrlBase,/,
  );
  assert.match(
    src,
    /\$\{window\.location\.protocol\}\/\/\$\{window\.location\.host\}/,
  );
});

test("Reveal modal — surfaces the delivery-result envelope (sent / failed / skipped)", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-link-delivery-result="sent"/);
  assert.match(src, /data-intake-link-delivery-result="failed"/);
  assert.match(src, /data-intake-link-delivery-result="skipped"/);
  // The failed chip MUST tell the user the link itself was created and
  // they can copy/retry — never leave them assuming the whole thing
  // blew up.
  assert.match(src, /The link itself is created/);
});

test("Reveal modal — friendlyDeliveryReason maps backend error codes to plain English", () => {
  const src = read(PAGE);
  assert.match(src, /function friendlyDeliveryReason\(reason: string\)/);
  for (const code of [
    "link_missing_email",
    "link_missing_phone",
    "link_revoked",
    "link_expired",
    "provider_unconfigured",
  ]) {
    assert.ok(
      src.includes(code),
      `friendlyDeliveryReason missing mapping for "${code}"`,
    );
  }
});

test("Guidance — redesign replaces the single oversized card with a HowItWorksStrip + CommonRequestsSection", () => {
  const src = read(PAGE);
  // The old large `data-intake-links-guidance` infoBox is gone; the
  // new strip carries its own attribute.
  assert.ok(
    !/data-intake-links-guidance="true"/.test(src),
    "old oversized guidance card data-attr must not be re-introduced",
  );
  assert.match(src, /data-intake-links-howitworks="true"/);
  assert.match(src, /function HowItWorksStrip\(/);
  // The three card titles must be the canonical Create / Share /
  // Track triplet.
  assert.match(src, /title: "Create",/);
  assert.match(src, /title: "Share",/);
  assert.match(src, /title: "Track",/);
});

test("Delivery method picker — Phase 8 microcopy clarifies single-channel send", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-link-single-channel-note="true"/);
  assert.match(
    src,
    /Only the selected channel will be used/,
  );
});

test("DeliveryMethod type matches the backend enum exactly", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /type DeliveryMethod = "MANUAL" \| "EMAIL" \| "SMS" \| "WHATSAPP"/,
  );
});

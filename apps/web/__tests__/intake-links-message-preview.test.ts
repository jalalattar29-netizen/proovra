/**
 * Intake-link enterprise messaging — frontend source-contract.
 *
 * Pins the preview studio + sender identity selector wiring in the
 * create modal:
 *
 *   - The page imports the SHARED renderers (not a local clone), so
 *     the preview equals what the recipient gets.
 *   - The Preview studio only renders for non-MANUAL delivery.
 *   - The Preview studio uses the [secure-link] placeholder for the
 *     URL — the real token is never composed on the client.
 *   - The Sender identity selector exposes all 3 modes with stable
 *     data-attrs, and validates the custom name client-side.
 *   - The submit body carries senderDisplayMode + senderDisplayName.
 *   - The sender-identity transport endpoint is fetched per-modal.
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

test("page imports the SHARED message renderers, not a local clone", () => {
  const src = read(PAGE);
  // Pin the literal import block so any future "let's re-implement
  // the renderer here" change fails CI loudly.
  assert.match(
    src,
    /import \{\s*\n?\s*renderIntakeEmailMessage,[\s\S]{0,200}from "@proovra\/shared";/,
  );
  assert.match(src, /renderIntakeSmsMessage,/);
  assert.match(src, /renderIntakeWhatsappMessage,/);
  assert.match(src, /resolveIntakeSenderDisplay,/);
  assert.match(src, /validateCustomSenderDisplayName,/);
});

test("PLACEHOLDER_INTAKE_URL keeps the raw token out of the browser preview", () => {
  const src = read(PAGE);
  // The constant must explicitly use the [secure-link] placeholder
  // so a future refactor can't accidentally inject a real token.
  assert.match(
    src,
    /const PLACEHOLDER_INTAKE_URL =\s*\n?\s*"https:\/\/app\.proovra\.com\/intake\/\[secure-link\]";/,
  );
});

test("Sender identity selector — renders three radios with stable data-attrs", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-link-sender-selector="true"/);
  for (const mode of ["PROOVRA", "WORKSPACE", "CUSTOM"]) {
    assert.ok(
      src.includes(`data-intake-link-sender-mode-radio="${mode}"`),
      `selector missing radio for "${mode}"`,
    );
  }
});

test("Sender identity selector — custom-name input + client-side validation error rendering", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-link-sender-custom-name="true"/);
  assert.match(src, /data-intake-link-sender-name-error="true"/);
  // The validator is called on submit and renders the reason via the
  // copy helper.
  assert.match(
    src,
    /v = validateCustomSenderDisplayName\(senderDisplayName\);[\s\S]{0,200}senderNameReasonCopy\(v\.reason\)/,
  );
});

test("Submit body carries senderDisplayMode + senderDisplayName (CUSTOM-only name)", () => {
  const src = read(PAGE);
  assert.match(src, /senderDisplayMode,/);
  assert.match(
    src,
    /senderDisplayName:\s*\n?\s*senderDisplayMode === "CUSTOM" \? senderDisplayName\.trim\(\) : null,/,
  );
});

test("Message Preview Studio — hidden for MANUAL, visible for EMAIL/SMS/WHATSAPP", () => {
  const src = read(PAGE);
  // Studio component is only rendered when deliveryMethod !== MANUAL.
  assert.match(
    src,
    /deliveryMethod !== "MANUAL" \? \(\s*\n?\s*<MessagePreviewStudio/,
  );
  // The "no message will be sent" note is shown ONLY for MANUAL.
  assert.match(src, /data-intake-link-preview-manual="true"/);
  assert.match(src, /Manual delivery — no message will be sent/);
});

test("Message Preview Studio — sender identity + transport row carry stable data-attrs", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-link-preview-studio="true"/);
  assert.match(src, /data-intake-link-preview-channel=\{channel\}/);
  assert.match(src, /data-intake-link-preview-sender-display="true"/);
  assert.match(src, /data-intake-link-preview-transport="true"/);
  assert.match(
    src,
    /data-intake-link-preview-transport-configured=\{\s*\n?\s*transport\?\.configured \? "true" : "false"\s*\n?\s*\}/,
  );
});

test("Message Preview Studio — uses PLACEHOLDER_INTAKE_URL (no raw token reaches the rendered body)", () => {
  const src = read(PAGE);
  // The renderInput passed to the shared renderer must point at the
  // placeholder, not at any token-shaped value.
  assert.match(
    src,
    /intakeUrl: PLACEHOLDER_INTAKE_URL,/,
  );
});

test("Sender-identity transport — fetched per-modal-mount from /v1/workflow/intake-links/sender-identity", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /\/v1\/workflow\/intake-links\/sender-identity\?teamId=\$\{encodeURIComponent\(team\.id\)\}/,
  );
});

test("senderNameReasonCopy covers every validator reason code (no raw enum leak)", () => {
  const src = read(PAGE);
  assert.match(src, /function senderNameReasonCopy\(/);
  for (const code of [
    "empty",
    "too_long",
    "contains_url",
    "contains_email",
    "contains_phone",
    "contains_control_chars",
    "impersonation",
    "reserved_brand",
  ]) {
    assert.ok(
      src.includes(`case "${code}":`),
      `senderNameReasonCopy missing case for "${code}"`,
    );
  }
});

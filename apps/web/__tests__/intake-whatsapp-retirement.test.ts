/**
 * WHATSAPP IS RETIRED FROM NEW EXTERNAL INTAKE — everywhere, not nearly.
 *
 * The retirement removed WhatsApp from `DELIVERY_METHODS`, from the create
 * wizard and from `POST /:id/send`. It did not remove it from the dialog that
 * appears IMMEDIATELY AFTER a link is created, which still offered "Send by
 * WhatsApp" — a button that could only fail, on the one surface an operator
 * sees at the exact moment they are deciding how to share the link. Nor from
 * the reviewer's "needs more information" path, which issues a FRESH intake
 * link and still accepted `notifyChannel: "WHATSAPP"`.
 *
 * A retirement that leaves the retired thing on a button is not a retirement,
 * so the contract is asserted rather than assumed.
 *
 * WHAT MUST STAY. Historical rows are read constantly and must keep rendering
 * as WhatsApp — the wire enum, the labels, the delivery-history copy and the
 * provider-error vocabulary are all deliberately untouched. So is the shared
 * Twilio transport that MFA and general communications depend on. This file
 * asserts that too, because "remove every mention" would break reading the
 * past to tidy up the present.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const DIALOG = read("apps/web/app/(app)/intake-links/_components/LinkCreatedDialog.tsx");
const WIZARD_STATE = read("apps/web/app/(app)/intake-links/_lib/wizardState.ts");
const PREVIEW = read("apps/web/app/(app)/intake-links/_components/wizard/MessagePreview.tsx");
const CATALOG = read("apps/web/lib/intake-links/catalog.ts");
const INTAKE_ROUTES = read("services/api/src/routes/workflow-intake-links.routes.ts");
const REQUEST_ROUTES = read("services/api/src/routes/evidence-requests.routes.ts");
const REQUEST_SERVICE = read("services/api/src/services/evidence-request.service.ts");
const VOCABULARY = read("apps/web/lib/intake-links/vocabulary.ts");

/** Source with comments stripped — the contract is the code, not the prose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ===========================================================================
// The surfaces that START a new intake conversation
// ===========================================================================

test("the post-create dialog offers no WhatsApp action", () => {
  const src = code(DIALOG);
  assert.doesNotMatch(src, /WHATSAPP/);
  assert.doesNotMatch(src, /Send by WhatsApp/i);
  assert.doesNotMatch(src, /data-intake-link-send="WHATSAPP"/);
});

test("the post-create dialog offers exactly Email, SMS and Copy link", () => {
  const src = code(DIALOG);
  // Copy link is always available — it is the only way to share a link the
  // operator means to hand over themselves.
  assert.match(src, /data-intake-link-copy/);
  // The two send channels the API accepts, each gated on the link actually
  // having that kind of recipient.
  assert.match(src, /data-intake-link-send="EMAIL"/);
  assert.match(src, /data-intake-link-send="SMS"/);
  assert.match(src, /const canSendEmail = link\.hasRecipientEmail === true/);
  assert.match(src, /const canSendSms = link\.hasRecipientPhone === true/);
  // The channel union matches what `POST /:id/send` accepts.
  assert.match(src, /type SendChannel = "EMAIL" \| "SMS"/);
});

test("the send endpoint accepts only the two channels the dialog offers", () => {
  assert.match(
    code(INTAKE_ROUTES),
    /channel: z\.enum\(\["SMS", "EMAIL"\]\)/,
    "the API must not accept a channel the product no longer offers",
  );
  assert.match(
    code(INTAKE_ROUTES),
    /DELIVERY_METHODS = \["MANUAL", "EMAIL", "SMS"\]/,
  );
});

test("a reviewer asking for more information cannot start a WhatsApp intake", () => {
  /*
   * This path was missed entirely. "Needs more information" ISSUES A FRESH
   * INTAKE LINK and sends it to the contributor, which makes it an intake
   * creation path — and it still took WHATSAPP after every other one stopped.
   */
  const routes = code(REQUEST_ROUTES);
  assert.doesNotMatch(routes, /notifyChannel: z\.enum\(\["SMS", "WHATSAPP"\]\)/);
  assert.equal(
    (routes.match(/notifyChannel: z\.enum\(\["SMS"\]\)\.optional\(\)/g) ?? []).length,
    2,
    "both the decision route and the request-more route must be SMS-only",
  );
  assert.doesNotMatch(code(REQUEST_SERVICE), /notifyChannel\?: "SMS" \| "WHATSAPP"/);
});

test("the wizard's channel union has no WhatsApp, and nothing falls back to it", () => {
  assert.match(
    code(CATALOG),
    /export type DeliveryChannelWire = "MANUAL" \| "EMAIL" \| "SMS"/,
  );
  // Dead `else → whatsapp` branches are how a retirement looks finished
  // without being it.
  assert.doesNotMatch(code(WIZARD_STATE), /whatsapp/i);
  assert.doesNotMatch(code(PREVIEW), /whatsapp/i);
  assert.match(code(PREVIEW), /export type PreviewChannel = "EMAIL" \| "SMS"/);
});

// ===========================================================================
// What a retirement must NOT break
// ===========================================================================

test("a historical WhatsApp delivery still reads as WhatsApp", () => {
  /*
   * Rows created before the retirement are read every day. Removing the label
   * would not undo those sends; it would only make them unreadable.
   */
  const vocab = code(VOCABULARY);
  assert.match(vocab, /"WHATSAPP"/);
  assert.match(vocab, /WHATSAPP: "WhatsApp"/);
  // The provider-error vocabulary explains historical WhatsApp failures.
  assert.match(vocab, /WhatsApp template required or not approved/);
});

test("the shared transport MFA and communications depend on is untouched", () => {
  const provider = read("services/api/src/services/communications/twilio-provider.ts");
  assert.match(provider, /async sendWhatsApp\(/);
  const comms = read("services/api/src/routes/communications.routes.ts");
  assert.match(comms, /channel: z\.enum\(\["SMS", "WHATSAPP"\]\)/);
});

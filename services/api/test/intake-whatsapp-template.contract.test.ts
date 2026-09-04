/**
 * WHATSAPP IS RETIRED AS AN INTAKE DELIVERY OPTION.
 *
 * This file used to pin the Twilio Content Template machinery that made
 * WhatsApp intake delivery work: an approved template SID, a template-mode
 * switch, a URL-format switch, four positional variables, and a
 * sender-identity block that told the operator which of those was missing.
 * All of it existed because Meta refuses a free-form business-initiated
 * message.
 *
 * The option is gone. The file stays, and now pins the opposite: that
 * WhatsApp cannot be chosen, cannot be sent, and left no dead selectable
 * value behind — while a delivery that ALREADY happened on WhatsApp is still
 * readable and still says WhatsApp.
 *
 * Those two halves are the whole decision. Retiring a product option is a
 * statement about what may be created next; it is not a licence to rewrite
 * what already happened, and a historical row relabelled "SMS" would be the
 * product lying about a message the operator watched go out.
 *
 * The supported channels are now exactly: Email, SMS, Copy link.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const ROUTES = read("services/api/src/routes/workflow-intake-links.routes.ts");
const LINK_SERVICE = read("services/api/src/services/workflow-intake-link.service.ts");
const DISPATCHER = read(
  "services/api/src/services/intake-link-delivery-dispatcher.service.ts",
);
const CATALOG = read("apps/web/lib/intake-links/catalog.ts");
const VOCABULARY = read("apps/web/lib/intake-links/vocabulary.ts");
const SCHEMA = read("services/api/prisma/schema.prisma");

// ===========================================================================
// The option is gone from everything that can create a delivery
// ===========================================================================
describe("WhatsApp cannot be chosen", () => {
  it("is not a delivery method a link can be created with", () => {
    expect(ROUTES).toContain(
      'export const DELIVERY_METHODS = ["MANUAL", "EMAIL", "SMS"] as const;',
    );
    // The zod enum is built from that tuple, so a create naming WhatsApp is
    // refused at the boundary in the caller's own words rather than failing
    // somewhere further in.
    expect(ROUTES).toContain("deliveryMethod: z.enum(DELIVERY_METHODS)");
  });

  it("is not a channel the resend route accepts", () => {
    expect(ROUTES).toContain('channel: z.enum(["SMS", "EMAIL"]).default("SMS")');
    expect(ROUTES).not.toContain('z.enum(["SMS", "WHATSAPP", "EMAIL"])');
  });

  it("is not a channel the dispatcher or the send service knows", () => {
    expect(DISPATCHER).toContain(
      'export type IntakeDeliveryChannel = "EMAIL" | "SMS";',
    );
    expect(LINK_SERVICE).toContain('channel: "SMS";');
  });

  it("left no template machinery behind", () => {
    /*
     * Removed rather than left unreachable. Dead transport code reads as a
     * supported option to whoever finds it next, and comes back to life the
     * first time somebody "re-enables" the channel without re-deciding
     * whether it should exist.
     */
    for (const symbol of [
      "buildIntakeWhatsappTemplatePayload",
      "readIntakeWhatsappTemplateSid",
      "resolveWhatsappTemplateMode",
      "resolveIntakeWhatsappTemplateUrlFormat",
      "whatsapp_template_unconfigured",
    ]) {
      expect(LINK_SERVICE, `${symbol} is still reachable`).not.toContain(symbol);
    }
    expect(DISPATCHER).not.toContain("whatsapp_template_unconfigured");
  });

  it("is not described by the sender-identity preview", () => {
    // Telling an operator "Setup required" about a channel they cannot pick
    // is a worse answer than not mentioning it.
    const handler = ROUTES.slice(
      ROUTES.indexOf('"/v1/workflow/intake-links/sender-identity"'),
      ROUTES.indexOf('"/v1/workflow/intake-links/:id/submissions"'),
    );
    expect(handler).not.toContain("whatsapp: {");
    expect(handler).not.toContain("whatsappConfigured");
  });

  it("is not an offered channel in the UI catalog", () => {
    expect(CATALOG).not.toContain('value: "WHATSAPP"');
    expect(CATALOG).not.toContain('icon: "whatsapp"');
    expect(CATALOG).not.toContain('transportKey: "whatsapp"');
    expect(CATALOG).toContain(
      'export type DeliveryChannelWire = "MANUAL" | "EMAIL" | "SMS";',
    );
  });

  it("leaves exactly Email, SMS and Copy link", () => {
    for (const v of ['value: "EMAIL"', 'value: "SMS"', 'value: "MANUAL"']) {
      expect(CATALOG).toContain(v);
    }
    expect(CATALOG).toContain('label: "Copy link"');
    // Copy link is MANUAL: a stored delivery method that records that nothing
    // was sent, with a local copy action on top. It is not a transport, which
    // is why it has no transport key.
    expect(CATALOG).toContain("transportKey: null");
  });
});

// ===========================================================================
// What already happened is still readable
// ===========================================================================
describe("historical WhatsApp deliveries stay readable", () => {
  it("keeps the persisted enum value", () => {
    /*
     * `CommunicationChannel` is shared: it is also the MFA and
     * verified-contact-factor channel, which this change has nothing to do
     * with. Dropping the value would break those AND orphan every row that
     * already holds it. An enum value is not the same thing as a product
     * option.
     */
    const channel = SCHEMA.slice(
      SCHEMA.indexOf("enum CommunicationChannel {"),
      SCHEMA.indexOf("}", SCHEMA.indexOf("enum CommunicationChannel {")),
    );
    expect(channel).toContain("WHATSAPP");
  });

  it("keeps the read vocabulary that names it", () => {
    // A row whose channel we refuse to name renders as "Copy link" — quietly
    // telling the operator that a message they watched go out was never sent.
    expect(VOCABULARY).toContain('"WHATSAPP",');
    expect(VOCABULARY).toContain('WHATSAPP: "WhatsApp"');
  });

  it("does not rewrite any historical channel", () => {
    // No migration, no backfill, no UPDATE. The record says what happened.
    expect(ROUTES).not.toMatch(/WHATSAPP[\s\S]{0,80}=>[\s\S]{0,20}"SMS"/);
    expect(LINK_SERVICE).not.toMatch(/WHATSAPP[\s\S]{0,80}=>[\s\S]{0,20}"SMS"/);
  });
});

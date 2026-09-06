/**
 * WHAT THE BROWSER IS TOLD THE RECIPIENT FIELDS MEAN.
 *
 * An operator signed into a second account reported seeing a name and a phone
 * number from the first offered into the recipient fields before they had
 * typed anything — in a private window too, which is what made it look like a
 * leak.
 *
 * It was not one. A full audit found no API that supplies suggestions, no
 * browser storage holding recipient data, no application cache surviving the
 * account switch and no element in the page producing the value. The
 * suggestion came from the browser's own saved identity, and the form invited
 * it: `autocomplete="tel"` and `autocomplete="email"` are the WHATWG tokens
 * for THE CURRENT USER'S OWN number and address, and the recipient of an
 * intake request is a third party. The label field carried no token at all,
 * leaving Chrome to guess the field's meaning from its id and its label text.
 *
 * These tests pin the deliberate semantics that replaced the accidental ones.
 * They are a contract about the MARKUP; whether a given browser build then
 * offers a suggestion is the browser's decision, and no test in this repo can
 * assert it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const web = (p: string) => readFileSync(resolve(HERE, "../../..", "apps/web", p), "utf8");

const STEPS = web("app/(app)/intake-links/_components/wizard/steps.tsx");
const WIZARD_STATE = web("app/(app)/intake-links/_lib/wizardState.ts");

/** The markup for one field, from its id to the end of the element. */
function field(fieldId: string): string {
  const at = STEPS.indexOf(`id={FIELD_IDS.${fieldId}}`);
  expect(at, `field ${fieldId} not found`).toBeGreaterThan(-1);
  const start = STEPS.lastIndexOf("<input", at);
  const end = STEPS.indexOf("/>", at);
  return STEPS.slice(start, end);
}

const RECIPIENT_FIELDS = ["recipientLabel", "recipientEmail", "recipientPhone"] as const;

describe("the recipient fields describe a third party", () => {
  it("each one is in its own autofill section", () => {
    // `section-*` groups these fields together and out of the page's primary
    // identity fields, so a browser fills them as a set rather than treating
    // them as the signed-in person's own details.
    expect(STEPS).toContain('name: "section-intake-recipient name"');
    expect(STEPS).toContain('email: "section-intake-recipient email"');
    expect(STEPS).toContain('tel: "section-intake-recipient tel"');
  });

  it("none of them carries a bare own-contact token any more", () => {
    for (const id of RECIPIENT_FIELDS) {
      const markup = field(id);
      expect(markup).not.toContain('autoComplete="email"');
      expect(markup).not.toContain('autoComplete="tel"');
      expect(markup).not.toContain('autoComplete="name"');
    }
  });

  it("every one has an explicit autocomplete — none is left to inference", () => {
    // A field with no token is a field whose meaning Chrome derives from its
    // id and its label text, which is how the label ended up being offered a
    // person's own name.
    for (const id of RECIPIENT_FIELDS) {
      expect(field(id)).toContain("autoComplete={RECIPIENT_AUTOFILL.");
    }
  });

  it("every one has a stable explicit name", () => {
    // The generated id is stable, but `name` is what a browser keys its own
    // heuristics and its saved form data on, and an input without one is
    // identified by position.
    expect(field("recipientLabel")).toContain('name="intakeRecipientLabel"');
    expect(field("recipientEmail")).toContain('name="intakeRecipientEmail"');
    expect(field("recipientPhone")).toContain('name="intakeRecipientPhone"');
  });

  it("the input types are unchanged, so the keyboards and validation are too", () => {
    expect(field("recipientEmail")).toContain('type="email"');
    expect(field("recipientPhone")).toContain('type="tel"');
    expect(field("recipientPhone")).toContain('inputMode="tel"');
  });
});

describe("Customer ID is business metadata, not contact", () => {
  it("is deliberately outside the recipient section", () => {
    const markup = field("customerId");
    expect(markup).not.toContain("RECIPIENT_AUTOFILL");
  });

  it("keeps autocomplete off, and is the only field here that does", () => {
    // There is no autofill vocabulary for "the organisation's own reference
    // for its own customer", and nothing a browser could helpfully offer.
    expect(field("customerId")).toContain('autoComplete="off"');
    const offCount = (STEPS.match(/autoComplete="off"/g) ?? []).length;
    expect(offCount).toBe(1);
  });

  it("has a stable name of its own", () => {
    expect(field("customerId")).toContain('name="intakeCustomerId"');
  });
});

describe("nothing about this changes what the product does", () => {
  it("the wizard still starts every recipient field empty", () => {
    // The audit's core finding: PROOVRA never prefills these. If that ever
    // changes, the browser is no longer the only explanation for a value
    // appearing in them.
    const initial = WIZARD_STATE.slice(
      WIZARD_STATE.indexOf("export function initialWizardState"),
      WIZARD_STATE.indexOf("export function validateStep"),
    );
    for (const key of ["recipientLabel", "customerId", "recipientEmail", "recipientPhone"]) {
      expect(initial).toMatch(new RegExp(`${key}:\\s*""`));
    }
  });

  it("no value is masked from the operator who is typing it", () => {
    // This is a change to what the BROWSER is told, not to what the person
    // sees. The fields stay ordinary text inputs.
    for (const id of [...RECIPIENT_FIELDS, "customerId"]) {
      expect(field(id)).not.toContain('type="password"');
      expect(field(id)).not.toContain("readOnly");
    }
  });

  it("no browser-specific hack was introduced", () => {
    // No decoy inputs, no off-screen honeypots, no vendor attributes. The
    // audit did not produce evidence that any of them is required, and each
    // is a thing that breaks silently on the next browser release.
    expect(STEPS).not.toContain("data-lpignore");
    expect(STEPS).not.toContain("data-form-type");
    expect(STEPS).not.toMatch(/autoComplete="(new-password|nope|chrome-off)"/);
    expect(STEPS).not.toMatch(/aria-hidden="true"[\s\S]{0,80}<input/);
  });
});

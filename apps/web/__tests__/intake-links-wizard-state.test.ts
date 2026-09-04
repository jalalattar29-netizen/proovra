/**
 * Intake links — the creation wizard's state machine.
 *
 * The wizard's promises are all decidable without React: which field each
 * channel requires, which bounds each limit has, what "dirty" means, what the
 * create call actually sends, and that a raw server code never reaches the
 * operator. Those are proven here; the DOM behaviour that depends on them is
 * proven in `__tests__/render/intake-links-wizard.render.test.tsx`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ACCEPTED_KIND_OPTIONS,
  DEFAULT_REQUEST_PURPOSE_SLUG,
  DELIVERY_CHANNELS,
  EXPIRY_HOURS_MAX,
  EXPIRY_HOURS_MIN,
  MAX_FILES_MAX,
  MAX_FILES_MIN,
  REQUEST_PURPOSES,
  channelCarriesOptOut,
  expiryFromHours,
  findRequestPurpose,
  maxUsesForMode,
  requiredRecipientField,
  type DeliveryChannelWire,
} from "../lib/intake-links/catalog";
import {
  WIZARD_STEPS,
  buildCreateBody,
  channelUnavailableReason,
  eligibleIntakeModes,
  firstInvalidField,
  friendlyCreateError,
  friendlyDeliveryReason,
  initialWizardState,
  isWizardDirty,
  senderNameReasonCopy,
  validateStep,
  type WizardState,
} from "../app/(app)/intake-links/_lib/wizardState";
import type {
  SenderTransportInfo,
  WorkflowTemplateRow,
} from "../app/(app)/intake-links/_lib/types";

const ALL_CONFIGURED: SenderTransportInfo = {
  email: { configured: true, fromName: "PROOVRA", fromAddressPreview: "no-reply@proovra.com" },
  sms: { configured: true, fromNumberPreview: "+1 ••• ••• 8084" },
  whatsapp: { configured: true, fromNumberPreview: "+1 ••• ••• 8084" },
};

const NONE_CONFIGURED: SenderTransportInfo = {
  email: { configured: false },
  sms: { configured: false },
  whatsapp: { configured: false },
};

const CTX = { transport: ALL_CONFIGURED, templates: [] as WorkflowTemplateRow[] };

function base(over: Partial<WizardState> = {}): WizardState {
  return {
    ...initialWizardState({ workspaceName: "Acme Legal" }),
    ...over,
  };
}

// ===========================================================================
// Catalogs
// ===========================================================================

test("the request catalog is plain language and hides no enum names", () => {
  assert.ok(REQUEST_PURPOSES.length >= 9);
  const slugs = REQUEST_PURPOSES.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length, "duplicate slug in the catalog");
  assert.ok(
    slugs.includes(DEFAULT_REQUEST_PURPOSE_SLUG),
    "the safe catch-all must stay in the catalog",
  );
  for (const p of REQUEST_PURPOSES) {
    assert.ok(p.label.length > 0 && p.description.length > 0);
    assert.ok(
      !/^[A-Z0-9_]+$/.test(p.label),
      `"${p.label}" looks like an internal enum, not a label`,
    );
    assert.ok(p.recommendedKinds.length > 0);
  }
});

test("the delivery catalog mirrors the backend enum exactly", () => {
  // The backend's DELIVERY_METHODS is the same three after WhatsApp's
  // retirement, which is the point of this assertion: a channel the UI offers
  // and the API refuses is a create that fails after the operator has filled
  // the form in.
  assert.deepEqual(
    DELIVERY_CHANNELS.map((c) => c.value).sort(),
    ["EMAIL", "MANUAL", "SMS"],
  );
});

test("the conditional-validation matrix is the one the API enforces", () => {
  // Three channels: Email, SMS, and Copy link. WhatsApp was retired as an
  // option, so it is not in the union this matrix is keyed by — and being
  // keyed by the union is what makes the matrix complete rather than a list
  // somebody has to remember to extend.
  const expected: Record<DeliveryChannelWire, "none" | "email" | "phone"> = {
    MANUAL: "none",
    EMAIL: "email",
    SMS: "phone",
  };
  for (const [channel, requires] of Object.entries(expected)) {
    assert.equal(
      requiredRecipientField(channel as DeliveryChannelWire),
      requires,
      `${channel} should require ${requires}`,
    );
  }
});

test("only SMS carries the carrier opt-out statement", () => {
  assert.equal(channelCarriesOptOut("SMS"), true);
  assert.equal(channelCarriesOptOut("EMAIL"), false);
  assert.equal(channelCarriesOptOut("MANUAL"), false);
});

test("WhatsApp is not an offered channel", () => {
  /*
   * Retired as a product option. The check is on the CATALOG rather than on
   * a rendered control, because the catalog is what every surface renders
   * from — a value left here would come back as an icon, a label and a
   * selectable radio in three places at once.
   *
   * The stored vocabulary deliberately still knows the word: a delivery
   * recorded before the retirement has to keep saying WhatsApp. That is
   * asserted in intake-links-vocabulary.test.ts.
   */
  assert.deepEqual(
    DELIVERY_CHANNELS.map((c) => c.value),
    ["SMS", "EMAIL", "MANUAL"],
  );
  assert.ok(
    !DELIVERY_CHANNELS.some((c) => /whatsapp/i.test(JSON.stringify(c))),
    "no WhatsApp label, icon or transport key may remain in the catalog",
  );
});

test("accepted file types keep backend values and gain human labels", () => {
  assert.deepEqual(
    ACCEPTED_KIND_OPTIONS.map((k) => k.value),
    ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
  );
  assert.deepEqual(
    ACCEPTED_KIND_OPTIONS.map((k) => k.label),
    ["Photos", "Videos", "Audio", "Documents"],
  );
});

test("only a reusable link raises maxUses above one", () => {
  assert.equal(maxUsesForMode("EXTERNAL_REUSABLE"), 1000);
  assert.equal(maxUsesForMode("EXTERNAL_ONE_TIME"), 1);
  assert.equal(maxUsesForMode("EXTERNAL_ANONYMOUS"), 1);
  assert.equal(maxUsesForMode("EXTERNAL_PSEUDONYMOUS"), 1);
});

// ===========================================================================
// Step order and initial state
// ===========================================================================

test("there are four steps in the mandated order", () => {
  assert.deepEqual([...WIZARD_STEPS], ["request", "delivery", "rules", "review"]);
});

test("a preselected purpose seeds the form and its recommended types", () => {
  const state = initialWizardState({
    initialSlug: "documents",
    workspaceName: "Acme Legal",
  });
  assert.equal(state.purposeSlug, "documents");
  assert.deepEqual(
    state.acceptedKinds,
    [...(findRequestPurpose("documents")?.recommendedKinds ?? [])],
  );
  assert.equal(state.senderMode, "WORKSPACE");
});

test("an unknown preselected slug falls back to the catch-all", () => {
  const state = initialWizardState({
    initialSlug: "not-a-real-template",
    workspaceName: "",
  });
  assert.equal(state.purposeSlug, DEFAULT_REQUEST_PURPOSE_SLUG);
  // No workspace name means the workspace sender option does not exist.
  assert.equal(state.senderMode, "PROOVRA");
});

// ===========================================================================
// Validation — request step
// ===========================================================================

test("a template that advertises no such mode disqualifies it", () => {
  const templates: WorkflowTemplateRow[] = [
    {
      id: "t1",
      slug: "documents",
      source: "SEED",
      version: 1,
      name: "Documents",
      description: "",
      planMode: "ANY",
      intakeModes: ["EXTERNAL_ONE_TIME"],
      archived: false,
    },
  ];
  assert.deepEqual(eligibleIntakeModes("documents", templates), [
    "EXTERNAL_ONE_TIME",
  ]);
  const errors = validateStep(
    "request",
    base({ purposeSlug: "documents", intakeMode: "EXTERNAL_ANONYMOUS" }),
    { ...CTX, templates },
  );
  assert.ok(errors.intakeMode);
  assert.ok(
    !/EXTERNAL_/.test(errors.intakeMode as string),
    "the error must not print the wire enum",
  );
});

test("an unresolved template offers every external mode, as the API would", () => {
  assert.deepEqual(eligibleIntakeModes("general-evidence-record", []), [
    "EXTERNAL_ONE_TIME",
    "EXTERNAL_REUSABLE",
    "EXTERNAL_ANONYMOUS",
    "EXTERNAL_PSEUDONYMOUS",
  ]);
});

// ===========================================================================
// Validation — delivery step
// ===========================================================================

test("each channel demands exactly the recipient field it needs", () => {
  const cases: Array<[DeliveryChannelWire, "recipientEmail" | "recipientPhone" | null]> = [
    ["EMAIL", "recipientEmail"],
    ["SMS", "recipientPhone"],
    ["MANUAL", null],
  ];
  for (const [channel, field] of cases) {
    const errors = validateStep("delivery", base({ channel }), CTX);
    if (field) {
      assert.ok(errors[field], `${channel} must demand ${field}`);
      const other =
        field === "recipientEmail" ? "recipientPhone" : "recipientEmail";
      assert.equal(
        errors[other],
        undefined,
        `${channel} must not demand ${other}`,
      );
    } else {
      assert.deepEqual(errors, {}, "copy-link needs no recipient");
    }
  }
});

test("a phone must be international even when the channel does not need one", () => {
  const errors = validateStep(
    "delivery",
    base({ channel: "MANUAL", recipientPhone: "415-555-0123" }),
    CTX,
  );
  assert.ok(errors.recipientPhone);
  assert.match(errors.recipientPhone as string, /international/i);
});

test("a well-formed international phone passes", () => {
  const errors = validateStep(
    "delivery",
    base({ channel: "SMS", recipientPhone: "+1 (415) 555-0123" }),
    CTX,
  );
  assert.equal(errors.recipientPhone, undefined);
});

test("email shape is checked, not just presence", () => {
  assert.ok(
    validateStep("delivery", base({ channel: "EMAIL", recipientEmail: "nope" }), CTX)
      .recipientEmail,
  );
  assert.equal(
    validateStep(
      "delivery",
      base({ channel: "EMAIL", recipientEmail: "a@b.co" }),
      CTX,
    ).recipientEmail,
    undefined,
  );
});

test("a channel the deployment cannot send on is refused with a real reason", () => {
  assert.equal(channelUnavailableReason("SMS", ALL_CONFIGURED), null);
  assert.ok(channelUnavailableReason("SMS", NONE_CONFIGURED));
  // Copy-link needs no provider, so it is never unavailable.
  assert.equal(channelUnavailableReason("MANUAL", NONE_CONFIGURED), null);
  // An envelope that has not resolved yet is NOT treated as "unavailable";
  // the server re-validates and the create error path covers it.
  assert.equal(channelUnavailableReason("SMS", null), null);
});

test("a custom sender name is validated client-side, in English", () => {
  const errors = validateStep(
    "delivery",
    base({ channel: "MANUAL", senderMode: "CUSTOM", senderName: "" }),
    CTX,
  );
  assert.equal(errors.senderName, "Enter a display name.");
  assert.match(senderNameReasonCopy("reserved_brand"), /PROOVRA is reserved/);
  assert.match(senderNameReasonCopy("impersonation"), /impersonate/);
  assert.equal(
    validateStep(
      "delivery",
      base({ channel: "MANUAL", senderMode: "CUSTOM", senderName: "Smith & Partners" }),
      CTX,
    ).senderName,
    undefined,
  );
});

// ===========================================================================
// Validation — collection rules
// ===========================================================================

test("expiry is bounded at both ends", () => {
  assert.ok(validateStep("rules", base({ expiresInHours: 0 }), CTX).expiresInHours);
  assert.ok(
    validateStep("rules", base({ expiresInHours: EXPIRY_HOURS_MAX + 1 }), CTX)
      .expiresInHours,
  );
  assert.equal(
    validateStep("rules", base({ expiresInHours: EXPIRY_HOURS_MIN }), CTX)
      .expiresInHours,
    undefined,
  );
});

test("max files is bounded, and blank means no cap", () => {
  assert.ok(validateStep("rules", base({ maxFiles: 0 }), CTX).maxFiles);
  assert.ok(validateStep("rules", base({ maxFiles: MAX_FILES_MAX + 1 }), CTX).maxFiles);
  assert.equal(
    validateStep("rules", base({ maxFiles: MAX_FILES_MIN }), CTX).maxFiles,
    undefined,
  );
  assert.equal(validateStep("rules", base({ maxFiles: "" }), CTX).maxFiles, undefined);
});

test("at least one accepted file type is required", () => {
  assert.ok(validateStep("rules", base({ acceptedKinds: [] }), CTX).acceptedKinds);
  assert.equal(
    validateStep("rules", base({ acceptedKinds: ["PHOTO"] }), CTX).acceptedKinds,
    undefined,
  );
});

test("the first invalid field of a step is identifiable, in field order", () => {
  const state = base({ channel: "EMAIL", senderMode: "CUSTOM", senderName: "" });
  const errors = validateStep("delivery", state, CTX);
  assert.equal(firstInvalidField("delivery", errors), "recipientEmail");
  assert.equal(firstInvalidField("review", errors), null);
});

// ===========================================================================
// Dirty check
// ===========================================================================

test("an untouched wizard is not dirty, and a typed value makes it dirty", () => {
  const initial = initialWizardState({ workspaceName: "Acme Legal" });
  assert.equal(isWizardDirty(initial, initial), false);
  assert.equal(
    isWizardDirty({ ...initial, recipientLabel: "Jane" }, initial),
    true,
  );
  assert.equal(isWizardDirty({ ...initial, channelTouched: true }, initial), true);
  assert.equal(isWizardDirty({ ...initial, kindsTouched: true }, initial), true);
});

test("a preselected purpose is not itself unsaved work", () => {
  const initial = initialWizardState({
    initialSlug: "insurance-claim",
    workspaceName: "Acme Legal",
  });
  assert.equal(isWizardDirty(initial, initial), false);
});

// ===========================================================================
// Request body
// ===========================================================================

test("the create body carries every field the API contract expects", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const body = buildCreateBody(
    base({
      purposeSlug: "insurance-claim",
      intakeMode: "EXTERNAL_REUSABLE",
      channel: "SMS",
      recipientLabel: "  Jane Smith — claim 4842  ",
      recipientPhone: "+1 (415) 555-0123",
      senderMode: "CUSTOM",
      senderName: "  Smith & Partners  ",
      locationPolicy: "REQUIRED",
      expiresInHours: 48,
      maxFiles: 12,
      acceptedKinds: ["DOCUMENT", "PHOTO"],
      consentText: "  Please confirm you own these files.  ",
    }),
    {
      teamId: "team-1",
      intakeUrlBase: "https://app.proovra.com",
      idempotencyKey: "create:abc",
      now,
    },
  );

  assert.equal(body.teamId, "team-1");
  assert.equal(body.workflowTemplateSlug, "insurance-claim");
  assert.equal(body.intakeMode, "EXTERNAL_REUSABLE");
  assert.equal(body.deliveryMethod, "SMS");
  assert.equal(body.intakeUrlBase, "https://app.proovra.com");
  assert.equal(body.recipientLabel, "Jane Smith — claim 4842");
  // Canonicalised for the provider, exactly as the old form did.
  assert.equal(body.recipientPhone, "+14155550123");
  assert.equal(body.maxUses, 1000);
  assert.equal(body.maxFileCountPerSession, 12);
  assert.deepEqual(body.allowedAcceptedKinds, ["PHOTO", "DOCUMENT"]);
  assert.equal(body.consentDisclosureText, "Please confirm you own these files.");
  assert.equal(body.idempotencyKey, "create:abc");
  assert.equal(body.senderDisplayMode, "CUSTOM");
  assert.equal(body.senderDisplayName, "Smith & Partners");
  assert.equal(body.locationPolicy, "REQUIRED");
  assert.equal(
    body.expiresAtUtc,
    expiryFromHours(48, now).toISOString(),
    "the absolute expiry must be derived from the chosen hours",
  );
});

test("copy-link sends no origin, because nothing is composed", () => {
  const body = buildCreateBody(base({ channel: "MANUAL" }), {
    teamId: "team-1",
    intakeUrlBase: "https://app.proovra.com",
    idempotencyKey: "create:abc",
  });
  assert.equal(body.intakeUrlBase, undefined);
  assert.equal(body.deliveryMethod, "MANUAL");
});

test("blank optional values are sent as null, not as empty strings", () => {
  const body = buildCreateBody(base({ channel: "MANUAL", maxFiles: "" }), {
    teamId: "team-1",
    intakeUrlBase: undefined,
    idempotencyKey: "k",
  });
  assert.equal(body.recipientLabel, null);
  assert.equal(body.recipientEmail, null);
  assert.equal(body.recipientPhone, null);
  assert.equal(body.consentDisclosureText, null);
  assert.equal(body.maxFileCountPerSession, null);
});

// ===========================================================================
// Server error copy
// ===========================================================================

test("no backend reason code reaches the operator verbatim", () => {
  for (const code of [
    "FEATURE_DISABLED",
    "INTAKE_NOT_INCLUDED",
    "intake_mode_not_supported_by_template",
    "template_not_found",
    "max_uses_invalid",
    "rate_limited",
    "intake_disabled_by_policy",
    "anonymous_intake_disabled_by_policy",
  ]) {
    const copy = friendlyCreateError(code, "raw server text");
    assert.notEqual(copy, code);
    assert.ok(!copy.includes("_"), `"${copy}" still reads like an enum`);
  }
});

test("an unmapped code falls back to the server message, never to silence", () => {
  assert.equal(friendlyCreateError("something_new", "Server said no."), "Server said no.");
  assert.equal(
    friendlyCreateError(undefined, undefined),
    "Couldn't create the intake link.",
  );
});

test("delivery failure reasons read as English and say 'disabled', not 'revoked'", () => {
  assert.match(friendlyDeliveryReason("link_missing_phone"), /no recipient phone/);
  assert.match(friendlyDeliveryReason("link_revoked"), /disabled/);
  assert.match(
    friendlyDeliveryReason("whatsapp_template_unconfigured"),
    /WhatsApp request template/,
  );
  assert.equal(friendlyDeliveryReason("brand_new_reason"), "brand_new_reason");
});
